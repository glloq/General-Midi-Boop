// tests/audit/r4-instrument-delete-atomic.test.js
//
// Vague 1 — R4 · F-81 (P2) : `instrument_delete` n'était pas transactionnel.
//
// Le défaut : quatre suppressions (`instruments_latency`, `string_instruments`,
// `instrument_voices`, `midi_instrument_routings`) dans quatre `try/catch`
// séparés, hors transaction. Une panne au milieu laissait un instrument à
// moitié supprimé et le handler renvoyait quand même `{ success: true }`, les
// erreurs partant seulement dans un `logger.warn`. Deux des quatre `catch`
// avalaient l'erreur SANS même la journaliser.
//
// Le remède : `InstrumentRepository.deleteInstrumentCascade()` — une seule
// transaction SQLite pour les quatre tables (ADR-002 : les écritures composites
// appartiennent au Repository), et l'erreur remonte au client au lieu d'être
// masquée par un succès.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../../src/persistence/Database.js';
import InstrumentRepository from '../../src/repositories/InstrumentRepository.js';
import StringInstrumentRepository from '../../src/repositories/StringInstrumentRepository.js';
import RoutingRepository from '../../src/repositories/RoutingRepository.js';
import { instrumentDelete } from '../../src/api/commands/InstrumentSettingsCommands.js';

const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-r4r5');
mkdirSync(SANDBOX, { recursive: true });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('R4 — instrument_delete atomique (F-81)', () => {
  let tempDir;
  let database;
  let app;

  /** Instrument complet : réglages + voix + instrument à cordes + routage. */
  function seedInstrument(deviceId, channel = 0) {
    database.ensureDevice(deviceId, deviceId, 'output');
    database.updateInstrumentSettings(deviceId, channel, { custom_name: 'Piano', sync_delay: 12 });
    database.createInstrumentVoice(deviceId, channel, { gm_program: 42, label: 'Cello' });
    database.db
      .prepare(
        `INSERT INTO string_instruments (device_id, channel, instrument_name, num_strings)
         VALUES (?, ?, 'Guitare', 6)`
      )
      .run(deviceId, channel);
    database.db
      .prepare(
        `INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at)
         VALUES ('h1','a.mid','/','midi/aa/h1.mid',10,1,datetime('now'))`
      )
      .run();
    const fileId = database.db
      .prepare("SELECT id FROM midi_files WHERE content_hash='h1'")
      .get().id;
    database.insertRouting({
      midi_file_id: fileId,
      channel,
      target_channel: channel,
      device_id: deviceId,
      instrument_name: deviceId,
      auto_assigned: true,
      enabled: true,
      created_at: Date.now()
    });
  }

  const counts = (deviceId) => ({
    instruments_latency: database.db
      .prepare('SELECT COUNT(*) c FROM instruments_latency WHERE device_id = ?')
      .get(deviceId).c,
    instrument_voices: database.db
      .prepare('SELECT COUNT(*) c FROM instrument_voices WHERE device_id = ?')
      .get(deviceId).c,
    string_instruments: database.db
      .prepare('SELECT COUNT(*) c FROM string_instruments WHERE device_id = ?')
      .get(deviceId).c,
    midi_instrument_routings: database.db
      .prepare('SELECT COUNT(*) c FROM midi_instrument_routings WHERE device_id = ?')
      .get(deviceId).c
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'r4-del-'));
    database = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'gmboop.db') } }
    });
    app = {
      logger: silentLogger,
      database,
      instrumentRepository: new InstrumentRepository(database),
      stringInstrumentRepository: new StringInstrumentRepository(database),
      routingRepository: new RoutingRepository(database),
      eventBus: { emit: () => {} }
    };
  });

  afterEach(() => {
    try {
      database.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('R4-10 — chemin nominal : les quatre tables sont vidées et les compteurs sont rapportés', () => {
    seedInstrument('usb-piano-1');
    expect(counts('usb-piano-1')).toEqual({
      instruments_latency: 1,
      instrument_voices: 1,
      string_instruments: 1,
      midi_instrument_routings: 1
    });

    const res = app.instrumentRepository.deleteInstrumentCascade('usb-piano-1', 0);

    expect(res.skippedTables).toEqual([]);
    expect(res.deleted).toEqual({
      instruments_latency: 1,
      instrument_voices: 1,
      string_instruments: 1,
      midi_instrument_routings: 1
    });
    expect(counts('usb-piano-1')).toEqual({
      instruments_latency: 0,
      instrument_voices: 0,
      string_instruments: 0,
      midi_instrument_routings: 0
    });
  });

  test('R4-11 — panne au MILIEU : tout est annulé, rien n’est supprimé à moitié', () => {
    seedInstrument('usb-piano-1');
    const before = counts('usb-piano-1');

    // La 3ᵉ patte (instrument_voices) échoue. Avant R4, les pattes 1 et 2
    // étaient déjà committées et le handler renvoyait `success: true`.
    const boom = new Error('disk I/O error');
    const original = database.deleteInstrumentVoicesByInstrument.bind(database);
    database.deleteInstrumentVoicesByInstrument = () => {
      throw boom;
    };

    expect(() => app.instrumentRepository.deleteInstrumentCascade('usb-piano-1', 0)).toThrow(
      'disk I/O error'
    );

    database.deleteInstrumentVoicesByInstrument = original;
    // Rollback complet : l'instrument est INTACT, pas à moitié détruit.
    expect(counts('usb-piano-1')).toEqual(before);
  });

  test('R4-12 — le handler ne renvoie plus `success: true` sur un échec partiel', async () => {
    seedInstrument('usb-piano-1');
    const before = counts('usb-piano-1');
    database.deleteInstrumentVoicesByInstrument = () => {
      throw new Error('database is corrupt');
    };

    await expect(instrumentDelete(app, { deviceId: 'usb-piano-1', channel: 0 })).rejects.toThrow(
      'database is corrupt'
    );
    expect(counts('usb-piano-1')).toEqual(before);
  });

  test('R4-13 — handler nominal : succès, quatre tables vidées, invalidation émise', async () => {
    seedInstrument('usb-piano-1');
    const events = [];
    app.eventBus = { emit: (name, payload) => events.push([name, payload]) };

    const res = await instrumentDelete(app, { deviceId: 'usb-piano-1', channel: 0 });

    expect(res).toEqual({ success: true });
    expect(counts('usb-piano-1')).toEqual({
      instruments_latency: 0,
      instrument_voices: 0,
      string_instruments: 0,
      midi_instrument_routings: 0
    });
    expect(events).toContainEqual([
      'instrument_settings_changed',
      { deviceId: 'usb-piano-1', channel: 0 }
    ]);
  });

  test('R4-14 — une table optionnelle réellement absente reste tolérée, mais elle est RAPPORTÉE', () => {
    seedInstrument('usb-piano-1');
    database.db.exec('DROP TABLE string_instruments');

    const res = app.instrumentRepository.deleteInstrumentCascade('usb-piano-1', 0);

    expect(res.skippedTables).toEqual(['string_instruments']);
    // Les trois autres pattes ont bien été appliquées (la table absente ne peut
    // évidemment plus être comptée).
    const count = (t) =>
      database.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE device_id = ?`).get('usb-piano-1').c;
    expect(count('instruments_latency')).toBe(0);
    expect(count('instrument_voices')).toBe(0);
    expect(count('midi_instrument_routings')).toBe(0);
  });

  test('R4-15 — la suppression est scopée : sans canal, tout le device ; avec canal, ce canal seul', () => {
    seedInstrument('usb-piano-1', 0);
    database.updateInstrumentSettings('usb-piano-1', 1, { custom_name: 'Canal 2' });
    database.createInstrumentVoice('usb-piano-1', 1, { gm_program: 1, label: 'B' });

    app.instrumentRepository.deleteInstrumentCascade('usb-piano-1', 0);
    expect(counts('usb-piano-1').instruments_latency).toBe(1);
    expect(counts('usb-piano-1').instrument_voices).toBe(1);

    app.instrumentRepository.deleteInstrumentCascade('usb-piano-1');
    expect(counts('usb-piano-1').instruments_latency).toBe(0);
    expect(counts('usb-piano-1').instrument_voices).toBe(0);
  });

  test('R4-16 — `deleteRoutingsByDevice` ne masque plus l’erreur qu’il journalisait', () => {
    seedInstrument('usb-piano-1');
    database.db.exec('DROP TABLE midi_instrument_routings');
    // Auparavant : catch + logger.error, aucun throw → l'appelant croyait avoir
    // supprimé. Désormais l'erreur remonte (et la patte optionnelle est
    // reconnue comme "table absente" par le cascade, pas comme un succès).
    expect(() => database.deleteRoutingsByDevice('usb-piano-1')).toThrow(/no such table/i);
    const res = app.instrumentRepository.deleteInstrumentCascade('usb-piano-1');
    expect(res.skippedTables).toEqual(['midi_instrument_routings']);
  });
});
