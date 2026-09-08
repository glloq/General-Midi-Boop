// tests/audit/l07-migrations.test.js
//
// Audit 2026-09-07 — lot L07, section §Y (migrations).
// L'audit du 2026-08-22 vérifiait l'idempotence et l'installation fraîche mais
// laissait explicitement « not tested » : l'interruption AU MILIEU du fichier N,
// la reprise, et l'application sur une base déjà peuplée.
//
// Le contrat annoncé dans CLAUDE.md est :
//   « each in its own transaction (a failure at file N keeps 1..N-1 committed
//     and retries from N) »
// Ces tests le PROUVENT en injectant une faute réelle — sans ajouter la moindre
// migration au dépôt : on pré-crée dans la base un objet qui fait échouer le
// 3e statement de `018_loop_arrangements.sql` (`CREATE INDEX ... ON
// loop_arrangement_tracks(arrangement_id)` sur une table sans cette colonne).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../../src/persistence/DatabaseLifecycle.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Toutes les bases de test vivent dans un bac à sable HORS du dépôt (jamais
// ./data/gmboop.db, jamais la racine du dépôt). `GMBOOP_TEST_TMP` permet à
// l'agent d'audit de les diriger vers son scratchpad.
const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-l07');
mkdirSync(SANDBOX, { recursive: true });

function collectingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: () => {}
  };
}

const migrationVersions = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);

describe('L07 §Y — migrations : panne au milieu du fichier N, reprise, rejeu', () => {
  let tempDir;
  let db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'mig-'));
    db = new BetterSqlite3(join(tempDir, 'mig.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* déjà fermée */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const applied = () =>
    db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all()
      .map((r) => r.version);
  const hasObject = (name) =>
    Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name));

  test('Y-1 — panne au milieu de la migration 18 : 1..17 committées, 18 ENTIÈREMENT annulée', () => {
    // Injection : table homonyme sans la colonne indexée par la migration 018.
    db.exec('CREATE TABLE loop_arrangement_tracks (id INTEGER PRIMARY KEY)');
    const logger = collectingLogger();

    expect(() => runMigrations(db, logger)).toThrow(/no such column: arrangement_id/);

    // 1..17 sont bien committées (chacune dans SA transaction).
    expect(applied()).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    // La table créée par la migration 017 a survécu.
    expect(hasObject('loops')).toBe(true);
    // Les statements 1 et 3 de la migration 018 (loop_arrangements,
    // loop_arrangement_blocks) ont été annulés : atomicité INTRA-fichier.
    expect(hasObject('loop_arrangements')).toBe(false);
    expect(hasObject('loop_arrangement_blocks')).toBe(false);
    // L'échec est bruyant, pas silencieux.
    expect(logger.lines.error.join('\n')).toMatch(/Migration 18 failed/);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  test('Y-2 — après correction, la reprise REPART à 18 et va jusqu’au bout', () => {
    db.exec('CREATE TABLE loop_arrangement_tracks (id INTEGER PRIMARY KEY)');
    expect(() => runMigrations(db, collectingLogger())).toThrow();
    expect(Math.max(...applied())).toBe(17);

    // L'opérateur retire l'obstacle et relance (redémarrage du service).
    db.exec('DROP TABLE loop_arrangement_tracks');
    expect(() => runMigrations(db, collectingLogger())).not.toThrow();

    const versions = migrationVersions();
    expect(applied()).toEqual(versions);
    expect(hasObject('loop_arrangements')).toBe(true);
    expect(hasObject('loop_arrangement_blocks')).toBe(true);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  test('Y-3 — rejeu intégral : idempotent (aucun objet créé, aucune version ajoutée)', () => {
    const logger = collectingLogger();
    runMigrations(db, logger);
    const snapshot = () => ({
      versions: applied(),
      tables: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c,
      indexes: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index'").get().c,
      triggers: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'").get().c
    });
    const first = snapshot();
    runMigrations(db, logger);
    runMigrations(db, logger);
    expect(snapshot()).toEqual(first);
    expect(first.versions).toEqual(migrationVersions());
  });

  test('Y-4 — migration appliquée sur une base NON VIDE : les données survivent', () => {
    // Base « à moitié à jour » : on s'arrête à 17 (via l'injection), on insère
    // des données métier, puis on termine la montée de version.
    db.exec('CREATE TABLE loop_arrangement_tracks (id INTEGER PRIMARY KEY)');
    expect(() => runMigrations(db, collectingLogger())).toThrow();

    db.prepare(
      "INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES ('h','a.mid','/','midi/aa/h.mid',10,1,datetime('now'))"
    ).run();
    db.prepare("INSERT INTO devices (id, name, type) VALUES ('d1','D','output')").run();
    db.prepare(
      "INSERT INTO instruments_latency (id, device_id, channel, name) VALUES ('d1_0','d1',0,'I')"
    ).run();

    db.exec('DROP TABLE loop_arrangement_tracks');
    runMigrations(db, collectingLogger());

    expect(db.prepare('SELECT COUNT(*) c FROM midi_files').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM instruments_latency').get().c).toBe(1);
    // Les colonnes ajoutées après 17 existent bien sur la ligne pré-existante.
    const inst = db.prepare("SELECT * FROM instruments_latency WHERE id='d1_0'").get();
    expect(inst).toHaveProperty('scale_root'); // migration 032
    expect(inst).toHaveProperty('pitch_bend_enabled'); // migration 034
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  test('Y-5 — base « legacy » pré-baseline RÉALISTE : réconciliée une fois, schéma complet', () => {
    // Fixture fidèle : l'ancienne chaîne produisait les MÊMES tables que le
    // baseline, avec un `schema_version` numéroté 1..40 et des descriptions
    // qui ne commencent pas par « Baseline schema ».
    db.exec(readFileSync(join(MIGRATIONS_DIR, '001_baseline.sql'), 'utf8'));
    db.prepare("UPDATE schema_version SET description = 'initial schema' WHERE version = 1").run();
    const ins = db.prepare(
      'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
    );
    for (let v = 2; v <= 40; v++) ins.run(v, `legacy migration ${v}`);

    const logger = collectingLogger();
    runMigrations(db, logger);

    expect(logger.lines.warn.join('\n')).toMatch(/pre-baseline schema_version/i);
    expect(
      db.prepare('SELECT description FROM schema_version WHERE version = 1').get().description
    ).toMatch(/^Baseline schema/);
    // Les migrations post-baseline ont bien été ré-appliquées.
    expect(applied()).toEqual(migrationVersions());
    expect(hasObject('loops')).toBe(true);
    expect(hasObject('instrument_light_state')).toBe(true);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

    // Deuxième passage : plus aucun avertissement, aucun changement.
    const logger2 = collectingLogger();
    runMigrations(db, logger2);
    expect(logger2.lines.warn.join('\n')).not.toMatch(/pre-baseline/i);
    expect(applied()).toEqual(migrationVersions());
  });

  test('Y-5b — DÉFAUT F-80 : la détection « legacy » ne regarde que la DESCRIPTION, jamais les tables', () => {
    // Une base dont la ligne version 1 porte une description quelconque — base
    // restaurée partiellement, éditée à la main, issue d'un fork — est prise
    // pour une base legacy. `reconcileLegacySchemaVersion` conserve alors la
    // version 1, donc `001_baseline.sql` est DÉFINITIVEMENT SAUTÉ, et la
    // première migration qui touche une table du baseline échoue au démarrage.
    db.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT (datetime('now')))"
    );
    db.prepare('INSERT INTO schema_version (version, description) VALUES (1, ?)').run(
      'schema initial (base restaurée à la main)'
    );

    const logger = collectingLogger();
    // Comportement CONSTATÉ (et non souhaitable) : plantage dur, pas de
    // message actionnable pour l'opérateur.
    expect(() => runMigrations(db, logger)).toThrow(/no such table/);

    // La preuve du mécanisme : le baseline a été considéré comme déjà appliqué
    // alors qu'AUCUNE de ses tables n'existe.
    expect(db.prepare('SELECT COUNT(*) c FROM schema_version WHERE version = 1').get().c).toBe(1);
    expect(hasObject('midi_files')).toBe(false);
    expect(hasObject('instruments_latency')).toBe(false);
    // Le seul signal est un log d'erreur — le service ne démarre pas.
    expect(logger.lines.error.join('\n')).toMatch(/failed/i);
  });

  test('Y-6 — ordre NUMÉRIQUE des fichiers et unicité des préfixes', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const versions = files.map((f) => parseInt(f, 10));
    expect(new Set(versions).size).toBe(versions.length); // aucun doublon
    expect(versions.every(Number.isFinite)).toBe(true);
    // Aucun trou dans la suite : 1..N sans manquant.
    const sorted = [...versions].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1));
  });

  test('Y-7 — il n’existe AUCUN mécanisme de migration descendante', () => {
    // Constat documentaire, vérifié mécaniquement : aucun fichier `*_down.sql`,
    // aucune fonction de rollback exportée. La reprise après mauvaise migration
    // passe obligatoirement par une restauration de sauvegarde.
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files.filter((f) => /down|rollback|revert/i.test(f))).toEqual([]);
  });
});
