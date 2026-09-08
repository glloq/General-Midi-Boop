// tests/audit/r5-busy-timeout.test.js
//
// Vague 1 — R5 · F-130 (P1) / F-78 (P2) : `busy_timeout` n'était configuré
// NULLE PART. La valeur observée par l'audit était le défaut du pilote
// (5 000 ms) — et comme `better-sqlite3` est SYNCHRONE, cette attente n'est pas
// « une requête lente » : c'est un GEL COMPLET du processus, donc de
// l'ordonnanceur MIDI. Mesures d'audit : 5 015 ms de trou de boucle
// d'événements (L07 §X05) et un `/api/health` concurrent à 10 095 ms
// (L12 F-130, deux écritures contendues à la suite).
//
// Ces tests mesurent AVANT/APRÈS sur le même banc :
//   - « avant » = une connexion ouverte comme le faisait le projet (aucun
//     pragma busy_timeout → défaut 5 000 ms du pilote) ;
//   - « après » = `openDatabase()` / `DatabaseManager`, qui posent désormais
//     250 ms explicitement.
//
// Et ils vérifient le second volet du remède : `runWithBusyRetry` réessaie
// À TRAVERS UN `await`, donc la boucle d'événements tourne entre deux
// tentatives — le gel maximal reste celui d'UNE tentative.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import BetterSqlite3 from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  openDatabase,
  applyConnectionPragmas,
  DEFAULT_BUSY_TIMEOUT_MS
} from '../../src/persistence/DatabaseLifecycle.js';
import DatabaseManager from '../../src/persistence/Database.js';
import { runWithBusyRetry, isBusyError } from '../../src/persistence/busyRetry.js';
import { DatabaseBusyError } from '../../src/core/errors/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-r4r5');
mkdirSync(SANDBOX, { recursive: true });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Processus fils : prend un verrou EXCLUSIVE et le tient `holdMs` ms. */
const LOCKER_SRC = `
const Database = require('better-sqlite3');
const [dbPath, holdMs] = process.argv.slice(1);
if (!dbPath || dbPath[0] !== '/') { throw new Error('chemin de base non absolu: ' + dbPath); }
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('BEGIN EXCLUSIVE');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('r5-lock','1')").run();
process.stdout.write('LOCKED');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
try { db.exec('COMMIT'); } catch (e) {}
db.close();
`;

function spawnLocker(dbPath, holdMs) {
  const child = spawn('node', ['-e', LOCKER_SRC, '--', dbPath, String(holdMs)], {
    cwd: REPO_ROOT
  });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

/** Mesure le plus grand trou d'un timer 5 ms — l'ordre de grandeur MIDI. */
function startEventLoopProbe() {
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      return maxGap;
    }
  };
}

describe('R5 — busy_timeout explicite (F-130 / F-78)', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'r5-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function freshDb(name, options) {
    const dbPath = join(tempDir, `${name}.db`);
    return { db: openDatabase(dbPath, silentLogger, options), dbPath };
  }

  test('R5-1 — la connexion applicative pose busy_timeout=250 (plus le défaut implicite 5000)', () => {
    const { db } = freshDb('pragmas');
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(250);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(250);
    // Les autres pragmas du contrat n'ont pas bougé.
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  test('R5-2 — la valeur est un réglage (config.database.busyTimeoutMs), pas une constante cachée', () => {
    const { db } = freshDb('tuned', { busyTimeoutMs: 800 });
    expect(db.pragma('busy_timeout', { simple: true })).toBe(800);
    db.close();

    // Même contrat sur la connexion du serveur (DatabaseManager).
    const managed = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'managed.db'), busyTimeoutMs: 120 } }
    });
    expect(managed.db.pragma('busy_timeout', { simple: true })).toBe(120);
    expect(managed.busyTimeoutMs).toBe(120);
    managed.close();

    // …et 250 par défaut quand le réglage est absent (config.json d'origine).
    const plain = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'plain.db') } }
    });
    expect(plain.db.pragma('busy_timeout', { simple: true })).toBe(250);
    plain.close();
  });

  test('R5-3 — AVANT/APRÈS : le gel de la boucle d’événements passe de ~5 000 ms à ~250 ms', async () => {
    // Un seul et même banc : verrou externe tenu 6,5 s (> le défaut 5 s du
    // pilote, comme dans la reproduction d'audit), une écriture contendue, et
    // une sonde de boucle d'événements à 5 ms — l'ordre de grandeur MIDI.
    const measure = async (dbFactory, name) => {
      const dbPath = join(tempDir, `${name}.db`);
      openDatabase(dbPath, silentLogger).close(); // crée le schéma
      const locker = await spawnLocker(dbPath, 6500);
      const probe = startEventLoopProbe();
      await new Promise((r) => setTimeout(r, 60));

      const db = dbFactory(dbPath);
      const t0 = Date.now();
      let busy = false;
      try {
        db.prepare("INSERT INTO settings (key, value) VALUES ('r5','1')").run();
      } catch (e) {
        busy = isBusyError(e);
      }
      const blockedMs = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 120));
      const maxGap = probe.stop();
      db.close();
      locker.kill('SIGKILL');
      return { blockedMs, maxGap, busy };
    };

    // AVANT — exactement ce que faisait le code : aucun busy_timeout posé,
    // donc le défaut du pilote (5 000 ms).
    const before = await measure((p) => {
      const db = new BetterSqlite3(p);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      return db;
    }, 'freeze-before');

    // APRÈS — la connexion du projet.
    const after = await measure((p) => openDatabase(p, silentLogger), 'freeze-after');

    // Les deux abandonnent sur SQLITE_BUSY — ce qui change, c'est la DURÉE
    // pendant laquelle le processus entier est resté figé avant d'abandonner.
    expect(before.busy).toBe(true);
    expect(after.busy).toBe(true);
    // Le défaut implicite gèle le processus ~5 s : c'est la panne de spectacle.
    expect(before.maxGap).toBeGreaterThanOrEqual(4000);
    expect(before.blockedMs).toBeGreaterThanOrEqual(4000);
    // Le contrat explicite le ramène à un accroc.
    expect(after.maxGap).toBeLessThan(1200);
    expect(after.blockedMs).toBeLessThan(1200);
    // Et l'amélioration est d'un ordre de grandeur, pas marginale.
    expect(before.maxGap / Math.max(after.maxGap, 1)).toBeGreaterThan(4);

    // eslint-disable-next-line no-console
    console.log(
      `[R5-3] gel boucle d'événements — avant: ${before.maxGap} ms · après: ${after.maxGap} ms`
    );
  }, 60000);

  test('R5-4 — le timeout court ne perd pas l’écriture : `runWithBusyRetry` réessaie ENTRE deux tours de boucle', async () => {
    const { db, dbPath } = freshDb('retry-wins');
    const locker = await spawnLocker(dbPath, 900);
    const probe = startEventLoopProbe();
    await new Promise((r) => setTimeout(r, 30));

    const write = db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('r5-retry','1')").run();
    });
    // Tolérance totale ≈ 6 × 250 ms + backoff > la durée du verrou, alors que
    // le gel d'UNE tentative reste 250 ms.
    await runWithBusyRetry(write, { attempts: 8, backoffMs: 20, operation: 'r5-retry' });
    const maxGap = probe.stop();

    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='r5-retry'").get().c).toBe(1);
    // Le point qui compte : aucun gel long, alors que le verrou a duré 900 ms.
    expect(maxGap).toBeLessThan(700);
    db.close();
    locker.kill('SIGKILL');

    // eslint-disable-next-line no-console
    console.log(`[R5-4] verrou 900 ms absorbé — plus grand trou de boucle: ${maxGap} ms`);
  }, 40000);

  test('R5-5 — verrou plus long que toutes les tentatives : erreur NOMMÉE (503), rien d’écrit à moitié', async () => {
    const { db, dbPath } = freshDb('retry-exhausted');
    db.prepare("INSERT INTO settings (key, value) VALUES ('avant','1')").run();
    const locker = await spawnLocker(dbPath, 4000);

    const write = db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('pendant','1')").run();
    });
    let caught = null;
    try {
      await runWithBusyRetry(write, { attempts: 3, backoffMs: 10, operation: 'apply' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatabaseBusyError);
    // Le client apprend l'échec au lieu de recevoir « Internal server error ».
    expect(caught.code).toBe('ERR_DATABASE_BUSY');
    expect(caught.statusCode).toBe(503);
    expect(caught.operation).toBe('apply');
    // Rien n'a été écrit à moitié.
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='pendant'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='avant'").get().c).toBe(1);
    db.close();
    locker.kill('SIGKILL');
  }, 40000);

  test('R5-6 — `runWithBusyRetry` ne masque pas les autres erreurs SQLite', async () => {
    const { db } = freshDb('other-errors');
    const boom = () => {
      throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT' });
    };
    await expect(runWithBusyRetry(boom, { attempts: 3, backoffMs: 1 })).rejects.toThrow(
      'UNIQUE constraint failed'
    );
    expect(isBusyError({ code: 'SQLITE_CONSTRAINT' })).toBe(false);
    expect(isBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(isBusyError(new Error('database is locked'))).toBe(true);
    db.close();
  });

  test('R5-7 — `applyConnectionPragmas` retombe sur 250 pour toute valeur non exploitable', () => {
    const db = new BetterSqlite3(':memory:');
    for (const bad of [undefined, null, NaN, -5, 'abc', {}]) {
      expect(applyConnectionPragmas(db, { busyTimeoutMs: bad })).toBe(250);
    }
    expect(applyConnectionPragmas(db, { busyTimeoutMs: 0 })).toBe(0);
    db.close();
  });
});
