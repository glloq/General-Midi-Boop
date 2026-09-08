// tests/audit/l07-sqlite-concurrency.test.js
//
// Audit 2026-09-07 — lot L07, section §X (concurrence SQLite).
// L'audit du 2026-08-22 laissait §X05 « NOT TESTED ». Ces tests mesurent le
// comportement réel de la couche persistance sous contention :
//   - pragmas effectivement appliqués (WAL, foreign_keys, busy_timeout) ;
//   - N processus écrivains concurrents sur le MÊME fichier de base ;
//   - une écriture pendant qu'un autre processus tient un verrou plus long
//     que `busy_timeout` → erreur propre ou perte de données ?
//   - coût de cette attente sur la boucle d'événements (better-sqlite3 est
//     SYNCHRONE : le handler « busy » bloque tout le processus, donc aussi
//     l'ordonnanceur MIDI) ;
//   - sémantique des transactions imbriquées (savepoints) ;
//   - lecture longue pendant une écriture (WAL).
//
// Toutes les bases vivent dans un répertoire temporaire — jamais ./data.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import BetterSqlite3 from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../../src/persistence/DatabaseLifecycle.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Toutes les bases de test vivent dans un bac à sable HORS du dépôt : les
// processus fils sont lancés avec `cwd = REPO_ROOT` (pour résoudre
// `better-sqlite3`), donc un chemin relatif créerait un fichier de base À LA
// RACINE DU DÉPÔT. `GMBOOP_TEST_TMP` permet de rediriger vers un scratchpad.
const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-l07');
mkdirSync(SANDBOX, { recursive: true });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Script CommonJS exécuté dans un processus fils : N insertions en transaction. */
const WRITER_SRC = `
const Database = require('better-sqlite3');
const [dbPath, tag, n] = process.argv.slice(1);
if (!dbPath || dbPath[0] !== '/') { throw new Error('chemin de base non absolu: ' + dbPath); }
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const ins = db.prepare("INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES (?,?,?,?,?,?,datetime('now'))");
const tx = db.transaction((i) => {
  const h = (tag + '-' + String(i).padStart(6, '0')).padEnd(64, 'a');
  ins.run(h, tag + '-' + i + '.mid', '/', 'midi/xx/' + h + '.mid', 100, 1);
});
let ok = 0, busy = 0, other = 0, firstErr = null;
for (let i = 0; i < Number(n); i++) {
  try { tx(i); ok++; }
  catch (e) {
    if (String(e.code || '').startsWith('SQLITE_BUSY')) busy++; else other++;
    if (!firstErr) firstErr = (e.code || '') + ' ' + e.message;
  }
}
process.stdout.write(JSON.stringify({ tag, ok, busy, other, firstErr }));
db.close();
`;

/** Script fils : prend un verrou EXCLUSIVE et le tient `holdMs` millisecondes. */
const LOCKER_SRC = `
const Database = require('better-sqlite3');
const [dbPath, holdMs] = process.argv.slice(1);
if (!dbPath || dbPath[0] !== '/') { throw new Error('chemin de base non absolu: ' + dbPath); }
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('BEGIN EXCLUSIVE');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('l07-lock','1')").run();
process.stdout.write('LOCKED');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
try { db.exec('COMMIT'); } catch (e) {}
db.close();
`;

describe('L07 §X — concurrence SQLite réelle', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'conc-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function freshDb(name) {
    const dbPath = join(tempDir, `${name}.db`);
    const db = openDatabase(dbPath, silentLogger);
    return { db, dbPath };
  }

  test('X-1 — pragmas effectifs sur la connexion applicative', () => {
    const { db } = freshDb('pragmas');
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // R5 (F-130/F-78) : `busy_timeout` est désormais posé EXPLICITEMENT par
    // `applyConnectionPragmas`. Ce n'est plus le défaut implicite 5 000 ms du
    // pilote — parce que better-sqlite3 est synchrone et que cette attente est
    // littéralement le gel maximal du processus (donc de l'ordonnanceur MIDI).
    expect(db.pragma('busy_timeout', { simple: true })).toBe(250);
    db.close();
  });

  test('X-2 — 4 processus × 150 écritures : aucune perte, aucun SQLITE_BUSY', async () => {
    const { db, dbPath } = freshDb('multiproc');
    db.close();

    const N_PROC = 4;
    const N_ROWS = 150;
    // Lancés en PARALLÈLE (spawn, pas spawnSync) : c'est la contention qui
    // nous intéresse, pas le débit.
    const reports = await Promise.all(
      Array.from(
        { length: N_PROC },
        (_, i) =>
          new Promise((resolve, reject) => {
            const c = spawn('node', ['-e', WRITER_SRC, '--', dbPath, `w${i}`, String(N_ROWS)], {
              cwd: REPO_ROOT
            });
            let out = '';
            let err = '';
            c.stdout.on('data', (d) => (out += d));
            c.stderr.on('data', (d) => (err += d));
            c.on('close', () => {
              try {
                resolve(JSON.parse(out));
              } catch (e) {
                reject(new Error(`fils ${i} : ${err || out}`));
              }
            });
          })
      )
    );
    const totalOk = reports.reduce((n, r) => n + r.ok, 0);
    const totalBusy = reports.reduce((n, r) => n + r.busy, 0);
    const totalOther = reports.reduce((n, r) => n + r.other, 0);

    const check = new BetterSqlite3(dbPath, { readonly: true });
    const rows = check.prepare('SELECT COUNT(*) c FROM midi_files').get().c;
    const integrity = check.pragma('integrity_check', { simple: true });
    check.close();

    expect(totalOther).toBe(0);
    expect(totalBusy).toBe(0);
    expect(totalOk).toBe(N_PROC * N_ROWS);
    // La preuve qui compte : rien n'a été perdu en route.
    expect(rows).toBe(N_PROC * N_ROWS);
    expect(integrity).toBe('ok');
  }, 60000);

  test('X-3 — verrou concurrent plus court que busy_timeout : l’écriture passe', async () => {
    const { db, dbPath } = freshDb('lock-short');
    db.close();

    // 150 ms < busy_timeout (250 ms depuis R5) : l'écriture doit ATTENDRE puis
    // réussir, exactement comme avant — seul le seuil a changé.
    const child = spawn('node', ['-e', LOCKER_SRC, '--', dbPath, '150'], { cwd: REPO_ROOT });
    await new Promise((res) => child.stdout.once('data', res));

    const app = openDatabase(dbPath, silentLogger);
    const t0 = Date.now();
    expect(() =>
      app.prepare("INSERT INTO settings (key, value) VALUES ('l07-app','1')").run()
    ).not.toThrow();
    const waited = Date.now() - t0;
    app.close();
    child.kill('SIGKILL');

    // L'écriture a bien ATTENDU la libération du verrou (elle n'a pas échoué).
    expect(waited).toBeGreaterThanOrEqual(60);
  }, 30000);

  test('X-4 — verrou plus long que busy_timeout : échec PROPRE (SQLITE_BUSY) en ~250 ms, zéro donnée perdue silencieusement', async () => {
    const { db, dbPath } = freshDb('lock-long');
    db.prepare("INSERT INTO settings (key, value) VALUES ('avant','1')").run();
    db.close();

    const child = spawn('node', ['-e', LOCKER_SRC, '--', dbPath, '8000'], { cwd: REPO_ROOT });
    await new Promise((res) => child.stdout.once('data', res));

    const app = openDatabase(dbPath, silentLogger);
    let caught = null;
    const t0 = Date.now();
    try {
      app.prepare("INSERT INTO settings (key, value) VALUES ('pendant','1')").run();
    } catch (e) {
      caught = e;
    }
    const waited = Date.now() - t0;

    expect(caught).not.toBeNull();
    expect(caught.code).toBe('SQLITE_BUSY');
    // ~busy_timeout : l'appel abandonne au bout de ~250 ms (R5), plus des 5 s
    // mesurées par l'audit. L'échec reste propre et explicite.
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(1500);
    // L'échec est explicite : rien n'a été écrit à moitié.
    expect(app.prepare("SELECT COUNT(*) c FROM settings WHERE key='pendant'").get().c).toBe(0);
    expect(app.prepare("SELECT COUNT(*) c FROM settings WHERE key='avant'").get().c).toBe(1);
    app.close();
    child.kill('SIGKILL');
  }, 40000);

  test('X-5 — une écriture contendue gèle la boucle d’événements ~busy_timeout — ramené de ~5 000 ms à ~250 ms (R5)', async () => {
    const { db, dbPath } = freshDb('eventloop');
    db.close();

    const child = spawn('node', ['-e', LOCKER_SRC, '--', dbPath, '7000'], { cwd: REPO_ROOT });
    await new Promise((res) => child.stdout.once('data', res));

    // Un « ordonnanceur » à 5 ms : on mesure le plus grand trou observé.
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    await new Promise((r) => setTimeout(r, 60));

    const app = openDatabase(dbPath, silentLogger);
    try {
      app.prepare("INSERT INTO settings (key, value) VALUES ('x','1')").run();
    } catch {
      /* SQLITE_BUSY attendu */
    }
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(timer);
    app.close();
    child.kill('SIGKILL');

    // better-sqlite3 est synchrone : l'attente « busy » bloque TOUT le
    // processus. Sur un Pi, cela suspend l'ordonnanceur MIDI d'autant — c'est
    // pour cela que le remède est un timeout COURT (le gel n'est pas supprimé,
    // il est ramené de ~5 000 ms à ~250 ms) doublé d'un réessai asynchrone
    // (`runWithBusyRetry`, testé dans r5-busy-timeout.test.js).
    expect(maxGap).toBeGreaterThanOrEqual(150);
    expect(maxGap).toBeLessThan(1500);
  }, 40000);

  test('X-6 — transactions imbriquées : savepoints corrects, rollback complet', () => {
    const { db } = freshDb('nested');
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

    // (a) échec de la transaction interne rattrapé par l'externe : seule
    //     l'interne est annulée.
    const inner = db.transaction(() => {
      put.run('n-inner', '1');
      throw new Error('boom interne');
    });
    const outer = db.transaction(() => {
      put.run('n-outer', '1');
      try {
        inner();
      } catch {
        /* rattrapé */
      }
      put.run('n-after', '1');
    });
    outer();
    const keys = db
      .prepare("SELECT key FROM settings WHERE key LIKE 'n-%' ORDER BY key")
      .all()
      .map((r) => r.key);
    expect(keys).toEqual(['n-after', 'n-outer']);

    // (b) échec de la transaction EXTERNE : tout est annulé, interne comprise.
    db.prepare("DELETE FROM settings WHERE key LIKE 'n-%'").run();
    const inner2 = db.transaction(() => put.run('n-i2', '1'));
    const outer2 = db.transaction(() => {
      inner2();
      put.run('n-o2', '1');
      throw new Error('boom externe');
    });
    expect(() => outer2()).toThrow('boom externe');
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'n-%'").get().c).toBe(0);

    // (c) un BEGIN EXPLICITE dans une transaction gérée échoue — c'est
    //     exactement ce que fait `runSingleMigration` (db.exec('BEGIN ...')),
    //     donc les migrations ne doivent jamais être appelées depuis une
    //     transaction ouverte.
    expect(() =>
      db.transaction(() => {
        db.exec('BEGIN TRANSACTION');
      })()
    ).toThrow(/within a transaction/i);
    db.close();
  });

  test('X-7 — WAL : une lecture longue ne bloque pas l’écrivain et voit un instantané stable', () => {
    const { db, dbPath } = freshDb('wal-readers');
    const seed = db.transaction(() => {
      const p = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (let i = 0; i < 200; i++) p.run(`s${i}`, 'v');
    });
    seed();

    // Lecteur : ouvre une transaction de lecture (deferred) et la garde.
    const reader = new BetterSqlite3(dbPath, { readonly: true });
    reader.pragma('journal_mode');
    reader.exec('BEGIN');
    const before = reader.prepare('SELECT COUNT(*) c FROM settings').get().c;

    // Écrivain : insère 100 lignes PENDANT que la lecture est ouverte.
    const t0 = Date.now();
    const more = db.transaction(() => {
      const p = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (let i = 0; i < 100; i++) p.run(`w${i}`, 'v');
    });
    expect(() => more()).not.toThrow();
    const writeMs = Date.now() - t0;

    // Le lecteur reste sur son instantané (isolation WAL), l'écrivain n'a pas
    // attendu.
    const during = reader.prepare('SELECT COUNT(*) c FROM settings').get().c;
    expect(during).toBe(before);
    expect(writeMs).toBeLessThan(2000);

    reader.exec('COMMIT');
    expect(reader.prepare('SELECT COUNT(*) c FROM settings').get().c).toBe(before + 100);
    reader.close();
    db.close();
  });
});
