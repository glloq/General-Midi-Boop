// tests/repositories/routing-integration.test.js
// Integration tests for RoutingRepository against a real SQLite DB
// (better-sqlite3 + migrations applied). Covers the 3 scenarios required
// by P0-2.6 : no-split (standard), split (multi-segment), overwrite.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Database from '../../src/persistence/Database.js';
import FileRepository from '../../src/repositories/FileRepository.js';
import RoutingRepository from '../../src/repositories/RoutingRepository.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('P0-2.6 — RoutingRepository integration (real SQLite)', () => {
  let tempDir;
  let database;
  let fileRepo;
  let routingRepo;
  let fileId;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'maestro-routing-test-'));
    database = new Database({
      logger: silentLogger(),
      config: { database: { path: join(tempDir, 'test.db') } }
    });
    fileRepo = new FileRepository(database);
    routingRepo = new RoutingRepository(database);
  });

  afterAll(() => {
    try { database.close?.(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh file per test to isolate routing state
    fileId = fileRepo.save({
      filename: `test-${Date.now()}-${Math.random()}.mid`,
      data: Buffer.from([0x4d, 0x54, 0x68, 0x64]),
      size: 4,
      tracks: 1,
      duration: 1,
      tempo: 120,
      ppq: 480,
      uploaded_at: new Date().toISOString(),
      folder: '/',
      is_original: 1,
      channel_count: 2
    });
  });

  test('no-split — single routing per channel can be read back', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 0,
      target_channel: 0,
      device_id: 'out-1',
      instrument_name: 'Piano',
      compatibility_score: 95,
      enabled: true,
      created_at: Date.now()
    });

    const routings = routingRepo.findByFileId(fileId);
    expect(routings).toHaveLength(1);
    expect(routings[0].channel).toBe(0);
    expect(routings[0].device_id).toBe('out-1');
    expect(routings[0].split_mode).toBeNull();
    expect(routings[0].enabled).toBe(true);
  });

  test('overwrite — saving the same channel twice replaces (no duplicates)', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 3,
      target_channel: 3,
      device_id: 'out-old',
      instrument_name: 'Old',
      enabled: true,
      created_at: Date.now()
    });
    routingRepo.save({
      midi_file_id: fileId,
      channel: 3,
      target_channel: 3,
      device_id: 'out-new',
      instrument_name: 'New',
      enabled: true,
      created_at: Date.now()
    });

    const routings = routingRepo.findByFileId(fileId);
    const ch3 = routings.filter(r => r.channel === 3);
    expect(ch3).toHaveLength(1);
    expect(ch3[0].device_id).toBe('out-new');
    expect(ch3[0].instrument_name).toBe('New');
  });

  test('split — saveSplit inserts multiple segments atomically for one channel', () => {
    // Note : the legacy UNIQUE(midi_file_id, track_id) constraint from
    // migration 006 is still present (not dropped by 020 nor 032). For splits
    // to coexist, segments must carry distinct target_channel (track_id)
    // values. This matches the real-world multi-instrument-device scenario
    // where each split segment targets a different channel on its device.
    const segments = [
      {
        device_id: 'bass-synth',
        target_channel: 10,
        split_note_min: 0,
        split_note_max: 59,
        split_mode: 'range',
        overlap_strategy: 'first',
        enabled: true,
        created_at: Date.now()
      },
      {
        device_id: 'lead-synth',
        target_channel: 11,
        split_note_min: 60,
        split_note_max: 127,
        split_mode: 'range',
        overlap_strategy: 'first',
        enabled: true,
        created_at: Date.now()
      }
    ];

    routingRepo.saveSplit(fileId, 1, segments);

    const routings = routingRepo.findByFileId(fileId);
    const ch1 = routings.filter(r => r.channel === 1);
    expect(ch1).toHaveLength(2);
    const devices = ch1.map(r => r.device_id).sort();
    expect(devices).toEqual(['bass-synth', 'lead-synth']);
    expect(ch1.every(r => r.split_mode === 'range')).toBe(true);
  });

  test('split replaces non-split — saveSplit on a channel with a prior routing removes it', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 2,
      target_channel: 2,
      device_id: 'single-device',
      enabled: true,
      created_at: Date.now()
    });

    routingRepo.saveSplit(fileId, 2, [
      {
        device_id: 'split-a',
        target_channel: 12,
        split_note_min: 0,
        split_note_max: 63,
        split_mode: 'range',
        overlap_strategy: 'first',
        enabled: true,
        created_at: Date.now()
      },
      {
        device_id: 'split-b',
        target_channel: 13,
        split_note_min: 64,
        split_note_max: 127,
        split_mode: 'range',
        overlap_strategy: 'first',
        enabled: true,
        created_at: Date.now()
      }
    ]);

    const routings = routingRepo.findByFileId(fileId);
    const ch2 = routings.filter(r => r.channel === 2);
    expect(ch2).toHaveLength(2);
    expect(ch2.some(r => r.device_id === 'single-device')).toBe(false);
    expect(ch2.every(r => r.split_mode === 'range')).toBe(true);
  });

  test('split rollback — atomic failure leaves channel clean (transaction)', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 4,
      target_channel: 4,
      device_id: 'original',
      enabled: true,
      created_at: Date.now()
    });

    const badSegments = [
      {
        device_id: 'ok-device',
        target_channel: 4,
        split_note_min: 0,
        split_note_max: 63,
        split_mode: 'range',
        enabled: true,
        created_at: Date.now()
      },
      // Invalid : split_note_min > split_note_max triggers throw in insertRouting
      {
        device_id: 'bad-device',
        target_channel: 4,
        split_note_min: 100,
        split_note_max: 50,
        split_mode: 'range',
        enabled: true,
        created_at: Date.now()
      }
    ];

    expect(() => routingRepo.saveSplit(fileId, 4, badSegments)).toThrow();

    // After rollback the original routing is preserved (or DELETE was also rolled back).
    const routings = routingRepo.findByFileId(fileId);
    const ch4 = routings.filter(r => r.channel === 4);
    // The transaction must leave channel 4 in its pre-call state: one non-split routing.
    expect(ch4).toHaveLength(1);
    expect(ch4[0].device_id).toBe('original');
  });

  test('deleteByFileId removes all routings for the file', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 0,
      target_channel: 0,
      device_id: 'a',
      enabled: true,
      created_at: Date.now()
    });
    routingRepo.save({
      midi_file_id: fileId,
      channel: 1,
      target_channel: 1,
      device_id: 'b',
      enabled: true,
      created_at: Date.now()
    });

    expect(routingRepo.findByFileId(fileId)).toHaveLength(2);
    routingRepo.deleteByFileId(fileId);
    expect(routingRepo.findByFileId(fileId)).toHaveLength(0);
  });

  test('deleteByDevice removes routings for a device across files', () => {
    routingRepo.save({
      midi_file_id: fileId,
      channel: 5,
      target_channel: 5,
      device_id: 'device-x',
      enabled: true,
      created_at: Date.now()
    });
    routingRepo.save({
      midi_file_id: fileId,
      channel: 6,
      target_channel: 6,
      device_id: 'device-y',
      enabled: true,
      created_at: Date.now()
    });

    routingRepo.deleteByDevice('device-x');
    const remaining = routingRepo.findByFileId(fileId).map(r => r.device_id);
    expect(remaining).not.toContain('device-x');
    expect(remaining).toContain('device-y');
  });
});
