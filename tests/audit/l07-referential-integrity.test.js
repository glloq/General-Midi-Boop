// tests/audit/l07-referential-integrity.test.js
//
// Audit 2026-09-07 — lot L07 : intégrité référentielle.
// Les clés étrangères sont bien ACTIVÉES (`PRAGMA foreign_keys = ON`, vérifié
// en 2026-08). La question restée ouverte est : les cascades sont-elles
// COHÉRENTES, ou laisse-t-on des orphelins ?
//
// Ces tests dressent l'inventaire mécanique des colonnes de référence puis
// exercent les trois suppressions réelles : un device, un fichier référencé par
// une playlist, un instrument supprimé via le handler `instrument_delete`.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../../src/persistence/Database.js';

const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-l07');
mkdirSync(SANDBOX, { recursive: true });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('L07 — intégrité référentielle (SQLite réel, FK actives)', () => {
  let tempDir;
  let database;
  let db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'refint-'));
    database = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'gmboop.db') } }
    });
    db = database.db;
  });

  afterEach(() => {
    try {
      database.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const count = (table, where = '1=1') =>
    db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get().c;

  function seedInstrument(deviceId) {
    database.ensureDevice(deviceId, deviceId, 'output');
    db.prepare(
      "INSERT INTO instruments_latency (id, device_id, channel, name) VALUES (?, ?, 0, 'Inst')"
    ).run(`${deviceId}_0`, deviceId);
    db.prepare(
      'INSERT INTO instrument_voices (device_id, channel, gm_program) VALUES (?, 0, 42)'
    ).run(deviceId);
    db.prepare(
      'INSERT INTO instrument_light_state (id, device_id, channel, brightness) VALUES (?, ?, 0, 64)'
    ).run(`${deviceId}_0`, deviceId);
    db.prepare('INSERT INTO instrument_light_config (id, device_id, channel) VALUES (?, ?, 0)').run(
      `${deviceId}_0`,
      deviceId
    );
    db.prepare('INSERT INTO string_instruments (device_id, channel) VALUES (?, 0)').run(deviceId);
    db.prepare(
      "INSERT INTO routes (id, name, source_device, destination_device) VALUES ('r-' || ?, 'R', ?, ?)"
    ).run(deviceId, deviceId, deviceId);
  }

  function seedFile(hash) {
    db.prepare(
      "INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES (?, ?, '/', ?, 10, 1, datetime('now'))"
    ).run(hash, `${hash}.mid`, `midi/aa/${hash}.mid`);
    return db.prepare('SELECT id FROM midi_files WHERE content_hash = ?').get(hash).id;
  }

  test('RI-1 — inventaire : quatre colonnes de référence n’ont AUCUNE clé étrangère (F-79)', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    const sansFk = [];
    for (const t of tables) {
      const cols = db.pragma(`table_info(${t})`).map((c) => c.name);
      const fks = db.pragma(`foreign_key_list(${t})`);
      for (const col of ['device_id', 'midi_file_id', 'instrument_id', 'playlist_id', 'loop_id']) {
        if (!cols.includes(col)) continue;
        if (!fks.some((f) => f.from === col)) sansFk.push(`${t}.${col}`);
      }
    }
    // Constat mesuré, figé pour détecter toute aggravation ou correction.
    expect(sansFk.sort()).toEqual([
      'instrument_light_config.device_id',
      'instrument_light_state.device_id',
      'instrument_voices.device_id',
      'lighting_rules.instrument_id'
    ]);
  });

  test('RI-2 — suppression d’un device : cascades OK, mais voix et lumières restent orphelines', () => {
    seedInstrument('dev-x');
    expect(count('instruments_latency')).toBe(1);

    db.prepare("DELETE FROM devices WHERE id = 'dev-x'").run();

    // Ce que la FK nettoie correctement :
    expect(count('instruments_latency')).toBe(0);
    expect(count('string_instruments')).toBe(0);
    expect(count('routes')).toBe(0);
    // Ce qu'elle NE nettoie pas — orphelins durables :
    expect(count('instrument_voices')).toBe(1);
    expect(count('instrument_light_state')).toBe(1);
    expect(count('instrument_light_config')).toBe(1);
    // SQLite ne les signale pas : sans FK déclarée, il n'y a rien à vérifier.
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  test('RI-3 — les réglages orphelins RESSUSCITENT si le même device_id réapparaît', () => {
    seedInstrument('usb-piano-1');
    db.prepare("DELETE FROM devices WHERE id = 'usb-piano-1'").run();

    // Le même instrument est rebranché (même identifiant de port / même nom).
    database.ensureDevice('usb-piano-1', 'usb-piano-1', 'output');
    const voices = database.listInstrumentVoices('usb-piano-1', 0);
    const light = database.getInstrumentLightState('usb-piano-1', 0);

    // L'instrument « neuf » hérite silencieusement des réglages du précédent.
    expect(voices.length).toBe(1);
    expect(voices[0].gm_program).toBe(42);
    expect(light).not.toBeNull();
    expect(light.brightness).toBe(64);
  });

  test('RI-4 — suppression d’un fichier référencé par une playlist : cascade propre', () => {
    const fileId = seedFile('h-playlist');
    db.prepare("INSERT INTO playlists (name, created_at, updated_at) VALUES ('P', 0, 0)").run();
    const pid = db.prepare("SELECT id FROM playlists WHERE name='P'").get().id;
    db.prepare('INSERT INTO playlist_items (playlist_id, midi_id, position) VALUES (?, ?, 0)').run(
      pid,
      fileId
    );
    db.prepare(
      "INSERT INTO midi_instrument_routings (midi_file_id, channel, instrument_name) VALUES (?, 0, 'I')"
    ).run(fileId);

    db.prepare('DELETE FROM midi_files WHERE id = ?').run(fileId);

    expect(count('playlist_items')).toBe(0);
    expect(count('midi_instrument_routings')).toBe(0);
    expect(count('playlists')).toBe(1); // la playlist survit, vide
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  test('RI-5 — device supprimé sous un routage : ON DELETE SET NULL, le routage survit sans destination', () => {
    seedInstrument('dev-routed');
    const fileId = seedFile('h-routed');
    db.prepare(
      "INSERT INTO midi_instrument_routings (midi_file_id, channel, device_id, instrument_name) VALUES (?, 0, 'dev-routed', 'I')"
    ).run(fileId);

    db.prepare("DELETE FROM devices WHERE id = 'dev-routed'").run();

    // Choix délibéré du schéma (préservation hors ligne) : la ligne reste, sa
    // destination devient NULL. Le routage est donc « muet » sans le dire.
    expect(count('midi_instrument_routings')).toBe(1);
    expect(count('midi_instrument_routings', 'device_id IS NULL')).toBe(1);
  });

  test('RI-6 — aucune ligne `devices` n’est jamais supprimée par le code applicatif', async () => {
    // Les cascades ci-dessus reposent toutes sur DELETE FROM devices. Or aucun
    // handler ne fait ce DELETE : `instrument_delete` et
    // `virtual_instrument_delete` ne touchent que `instruments_latency` &
    // consorts. Les cascades du schéma sont donc, en pratique, DORMANTES.
    const { readFileSync, readdirSync } = await import('fs');
    const dir = join(process.cwd(), 'src');
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(dir);
    const hits = files.filter((f) => /DELETE\s+FROM\s+devices\b/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
