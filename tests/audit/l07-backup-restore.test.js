// tests/audit/l07-backup-restore.test.js
//
// Audit 2026-09-07 — lot L07, section §Z (sauvegardes).
// L'audit du 2026-08-22 validait l'aller-retour sauvegarde → restauration mais
// laissait « not tested » : la sauvegarde PENDANT une écriture, la restauration
// d'une sauvegarde corrompue ou tronquée, la rotation, le disque plein et
// l'arrêt en cours de sauvegarde. `BackupScheduler` est à 16,5 % de couverture.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import BetterSqlite3 from 'better-sqlite3';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  truncateSync,
  statSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  utimesSync
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../../src/persistence/Database.js';
import BackupScheduler from '../../src/persistence/BackupScheduler.js';
import BlobStore from '../../src/files/BlobStore.js';

const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-l07');
mkdirSync(SANDBOX, { recursive: true });

function collectingLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(String(m)),
    warn: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
    debug: () => {}
  };
}

describe('L07 §Z — sauvegardes, restauration, rétention, GC', () => {
  let tempDir;
  let backupDir;
  let logger;
  let database;
  let blobStore;
  let scheduler;

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'backup-'));
    backupDir = join(tempDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    logger = collectingLogger();
    database = new DatabaseManager({
      logger,
      config: { database: { path: join(tempDir, 'gmboop.db') } }
    });
    blobStore = new BlobStore({ baseDir: tempDir, logger });
    scheduler = new BackupScheduler({ logger, database, blobStore }, { backupDir, maxBackups: 3 });
  });

  afterEach(() => {
    try {
      scheduler.stop();
      database.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seed = (n, prefix) => {
    const ins = database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    database.db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`${prefix}${i}`, 'v'.repeat(120));
    })();
  };
  const rowCount = () => database.db.prepare('SELECT COUNT(*) c FROM settings').get().c;

  test('Z-1 — sauvegarde PENDANT des écritures continues : instantané cohérent, aucune écriture refusée', async () => {
    seed(40000, 'seed');
    let written = 0;
    const backupPath = join(backupDir, 'hot.db');
    const ins = database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

    const pending = database.backup(backupPath);
    const timer = setInterval(() => {
      try {
        ins.run(`hot${written}`, 'x');
        written++;
      } catch {
        /* ignoré : compté par `written` */
      }
    }, 0);
    await pending;
    clearInterval(timer);

    // Des écritures ont bien eu lieu pendant la copie.
    expect(written).toBeGreaterThan(0);

    const snap = new BetterSqlite3(backupPath, { readonly: true });
    expect(snap.pragma('integrity_check', { simple: true })).toBe('ok');
    // better-sqlite3 redémarre la copie à chaque écriture : la sauvegarde est un
    // instantané COHÉRENT et à jour, jamais un mélange.
    expect(snap.prepare('SELECT COUNT(*) c FROM settings').get().c).toBe(rowCount());
    snap.close();
  }, 60000);

  test('Z-2 — restauration d’une sauvegarde TRONQUÉE : refusée, base vivante intacte', async () => {
    seed(500, 'seed');
    const good = join(backupDir, 'good.db');
    await database.backup(good);
    const before = rowCount();

    const truncated = join(backupDir, 'truncated.db');
    copyFileSync(good, truncated);
    truncateSync(truncated, Math.floor(statSync(truncated).size / 2));

    expect(() => database.restoreFromBackup(truncated)).toThrow(/not a valid SQLite database/i);
    // La base live n'a pas été touchée et reste utilisable.
    expect(rowCount()).toBe(before);
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  test('Z-3 — restauration d’une sauvegarde CORROMPUE (en-tête valide, corps abîmé) : refusée par integrity_check', async () => {
    seed(500, 'seed');
    const good = join(backupDir, 'good.db');
    await database.backup(good);
    const before = rowCount();

    const corrupt = join(backupDir, 'corrupt.db');
    copyFileSync(good, corrupt);
    const fd = openSync(corrupt, 'r+');
    writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 8192);
    closeSync(fd);

    // La sniffe d'en-tête seule aurait laissé passer ce fichier : c'est
    // `PRAGMA integrity_check` qui l'arrête.
    expect(() => database.restoreFromBackup(corrupt)).toThrow(/integrity check/i);
    expect(rowCount()).toBe(before);
  });

  test('Z-4 — restauration d’un fichier qui n’est pas une base : refusée', () => {
    const notdb = join(backupDir, 'notadb.db');
    writeFileSync(notdb, 'ceci n est pas une base SQLite');
    expect(() => database.restoreFromBackup(notdb)).toThrow(/not a valid SQLite database/i);
    expect(() => database.restoreFromBackup(join(backupDir, 'absent.db'))).toThrow(/not found/i);
  });

  test('Z-5 — restauration NOMINALE : la donnée revient et la connexion est réutilisable sans redémarrage', async () => {
    database.db.prepare("INSERT INTO settings (key, value) VALUES ('canari','present')").run();
    const good = join(backupDir, 'good.db');
    await database.backup(good);
    database.db.prepare("DELETE FROM settings WHERE key='canari'").run();
    expect(database.db.prepare("SELECT COUNT(*) c FROM settings WHERE key='canari'").get().c).toBe(
      0
    );

    database.restoreFromBackup(good);

    expect(database.db.prepare("SELECT value v FROM settings WHERE key='canari'").get().v).toBe(
      'present'
    );
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
    // Les sous-modules ont bien été reconstruits sur la nouvelle connexion.
    expect(() => database.midiDB.listBlobsForManifest()).not.toThrow();
    // Aucun résidu du swap.
    expect(existsSync(`${join(tempDir, 'gmboop.db')}.prerestore`)).toBe(false);
    expect(existsSync(`${join(tempDir, 'gmboop.db')}.restore-tmp`)).toBe(false);
  });

  test('Z-6 — « disque plein » : échec PROPRE, aucun fichier partiel au nom canonique', async () => {
    seed(200, 'seed');
    const target = join(backupDir, 'full.db');
    // Rend l'écriture du fichier temporaire impossible (un répertoire occupe
    // déjà le chemin `<cible>.tmp`) — équivalent fonctionnel d'un ENOSPC.
    mkdirSync(`${target}.tmp`, { recursive: true });

    let caught = null;
    try {
      await database.backup(target);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.code || caught.message)).toMatch(/CANTOPEN|EISDIR|unable to open/i);
    // Le point clé : rien de partiel ne prend le nom canonique, sans quoi la
    // rétention garderait une sauvegarde inexploitable et purgerait les bonnes.
    expect(existsSync(target)).toBe(false);
    expect(logger.lines.join('\n')).toMatch(/Backup failed/);
  });

  test('Z-7 — fermeture de la base PENDANT une sauvegarde : erreur signalée, aucun .tmp résiduel', async () => {
    seed(20000, 'seed');
    const target = join(backupDir, 'shutdown.db');
    const pending = database.backup(target);
    database.close();
    let caught = null;
    try {
      await pending;
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/not open/i);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  }, 30000);

  test('Z-8 — rétention : garde les N plus récentes et purge les manifests associés', async () => {
    seed(50, 'seed');
    for (let i = 0; i < 6; i++) {
      const p = join(backupDir, `gmboop-2026-09-0${i}.db`);
      await database.backup(p);
      writeFileSync(join(backupDir, `gmboop-2026-09-0${i}.manifest.json`), '{}');
      const t = new Date(2026, 8, 1 + i);
      utimesSync(p, t, t);
    }
    scheduler._pruneOldBackups();
    const kept = readdirSync(backupDir)
      .filter((f) => f.startsWith('gmboop-') && f.endsWith('.db'))
      .sort();
    expect(kept).toEqual(['gmboop-2026-09-03.db', 'gmboop-2026-09-04.db', 'gmboop-2026-09-05.db']);
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.manifest.json')).length).toBe(3);
  }, 30000);

  test('Z-9 — plancher de GC : zéro blob référencé ⇒ AUCUNE suppression (garde anti-effacement massif)', () => {
    mkdirSync(join(tempDir, 'midi', 'ab'), { recursive: true });
    writeFileSync(join(tempDir, 'midi', 'ab', 'orphan.mid'), 'x');
    scheduler._gcOrphanBlobs();
    expect(existsSync(join(tempDir, 'midi', 'ab', 'orphan.mid'))).toBe(true);
    expect(logger.lines.join('\n')).toMatch(/Blob GC skipped: 0 referenced blobs/);
  });

  test('Z-10 — GC : avec au moins un blob référencé, l’orphelin est bien réclamé', () => {
    const kept = blobStore.write(Buffer.from('contenu conserve'));
    database.db
      .prepare(
        "INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES (?, 'k.mid', '/', ?, 16, 1, datetime('now'))"
      )
      .run(kept.hash, kept.relativePath);
    const orphan = blobStore.write(Buffer.from('contenu orphelin'));

    scheduler._gcOrphanBlobs();

    expect(existsSync(kept.absolutePath)).toBe(true);
    expect(existsSync(orphan.absolutePath)).toBe(false);
  });

  test('Z-11 — le manifeste signale les blobs manquants (aide à la restauration)', () => {
    const b = blobStore.write(Buffer.from('des octets'));
    database.db
      .prepare(
        "INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES (?, 'm.mid', '/', ?, 10, 1, datetime('now'))"
      )
      .run(b.hash, b.relativePath);
    rmSync(b.absolutePath);

    const manifestPath = join(backupDir, 'manifest.json');
    scheduler._writeManifest(manifestPath, join(backupDir, 'inexistant.db'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.blobCount).toBe(1);
    expect(manifest.missingCount).toBe(1);
    expect(manifest.missingBlobs[0].blobPath).toBe(b.relativePath);
  });
});
