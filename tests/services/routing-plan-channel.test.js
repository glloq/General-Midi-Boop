// tests/services/routing-plan-channel.test.js
// Unit tests for the pure `planChannelRouting` function exported from
// FileRoutingSyncService (P1-4.1). No I/O, no DB.

import { describe, test, expect } from '@jest/globals';
import { planChannelRouting } from '../../src/midi/routing/FileRoutingSyncService.js';

const baseArgs = {
  fileId: 42,
  channel: 0,
  routingValue: 'dev-1',
  existingByChannel: new Map(),
  knownDevices: new Set(['dev-1', 'dev-2']),
  knownChannels: new Set([0, 1]),
  now: 1700000000000
};

describe('planChannelRouting — guards', () => {
  test('returns skip when channel is NaN', () => {
    const r = planChannelRouting({ ...baseArgs, channel: Number.NaN });
    expect(r.action).toBe('skip');
  });

  test('returns skip when routingValue is empty', () => {
    const r = planChannelRouting({ ...baseArgs, routingValue: '' });
    expect(r.action).toBe('skip');
  });

  test('returns skip-channel when channel not in knownChannels', () => {
    const r = planChannelRouting({ ...baseArgs, channel: 5 });
    expect(r.action).toBe('skip-channel');
    expect(r.channel).toBe(5);
  });

  test('skips channel-existence check when knownChannels is empty', () => {
    const r = planChannelRouting({ ...baseArgs, channel: 5, knownChannels: new Set() });
    expect(r.action).toBe('insert');
  });

  test('returns skip-device when deviceId not in knownDevices', () => {
    const r = planChannelRouting({ ...baseArgs, routingValue: 'unknown-dev' });
    expect(r.action).toBe('skip-device');
    expect(r.deviceId).toBe('unknown-dev');
  });

  test('always accepts virtual-instrument even if not in knownDevices', () => {
    const r = planChannelRouting({ ...baseArgs, routingValue: 'virtual-instrument', knownDevices: new Set(['dev-1']) });
    expect(r.action).toBe('insert');
    expect(r.routing.device_id).toBe('virtual-instrument');
  });

  test('skips device validation when knownDevices is empty', () => {
    const r = planChannelRouting({ ...baseArgs, routingValue: 'new-dev', knownDevices: new Set() });
    expect(r.action).toBe('insert');
    expect(r.routing.device_id).toBe('new-dev');
  });
});

describe('planChannelRouting — insert payloads', () => {
  test('builds a minimal insert for a new device on a channel without history', () => {
    const r = planChannelRouting({ ...baseArgs });
    expect(r.action).toBe('insert');
    expect(r.routing).toMatchObject({
      midi_file_id: 42,
      channel: 0,
      target_channel: 0,
      device_id: 'dev-1',
      instrument_name: null,
      compatibility_score: null,
      transposition_applied: 0,
      auto_assigned: false,
      assignment_reason: 'manual',
      note_remapping: null,
      enabled: true,
      created_at: 1700000000000
    });
  });

  test('parses deviceId::targetChannel syntax', () => {
    const r = planChannelRouting({ ...baseArgs, routingValue: 'dev-1::7' });
    expect(r.routing.device_id).toBe('dev-1');
    expect(r.routing.target_channel).toBe(7);
  });

  test('falls back to source channel when parsed targetChannel is NaN', () => {
    const r = planChannelRouting({
      ...baseArgs,
      channel: 3,
      routingValue: 'dev-1::foo',
      knownChannels: new Set([3])
    });
    expect(r.routing.target_channel).toBe(3);
  });

  test('preserves metadata when the same device is re-mapped', () => {
    const existing = new Map([
      [0, {
        device_id: 'dev-1',
        instrument_name: 'Piano',
        compatibility_score: 92,
        transposition_applied: -2,
        auto_assigned: true,
        assignment_reason: 'auto-score',
        note_remapping: null
      }]
    ]);
    const r = planChannelRouting({ ...baseArgs, existingByChannel: existing });
    expect(r.routing).toMatchObject({
      instrument_name: 'Piano',
      compatibility_score: 92,
      transposition_applied: -2,
      auto_assigned: true,
      assignment_reason: 'auto-score'
    });
  });

  test('resets metadata when a different device takes over', () => {
    const existing = new Map([
      [0, {
        device_id: 'old-dev',
        instrument_name: 'Piano',
        compatibility_score: 92,
        auto_assigned: true,
        assignment_reason: 'auto-score'
      }]
    ]);
    const r = planChannelRouting({ ...baseArgs, existingByChannel: existing });
    expect(r.routing.device_id).toBe('dev-1');
    expect(r.routing.instrument_name).toBeNull();
    expect(r.routing.compatibility_score).toBeNull();
    expect(r.routing.auto_assigned).toBe(false);
    expect(r.routing.assignment_reason).toBe('manual');
  });

  test('serialises note_remapping to JSON when same device and object present', () => {
    const mapping = { 60: 72 };
    const existing = new Map([
      [0, { device_id: 'dev-1', note_remapping: mapping }]
    ]);
    const r = planChannelRouting({ ...baseArgs, existingByChannel: existing });
    expect(r.routing.note_remapping).toBe(JSON.stringify(mapping));
  });

  test('uses the provided `now` for created_at', () => {
    const r = planChannelRouting({ ...baseArgs, now: 999 });
    expect(r.routing.created_at).toBe(999);
  });
});
