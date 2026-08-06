// tests/services/file-routing-sync.test.js
// Unit tests for FileRoutingSyncService.syncFile / bulkSync (P1-4.1).

import { jest, describe, test, expect } from '@jest/globals';
import FileRoutingSyncService from '../../src/midi/routing/FileRoutingSyncService.js';

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeDeps({
  existingRoutings = [],
  knownDevices = ['dev-1', 'dev-2'],
  fileChannels = [{ channel: 0 }, { channel: 1 }]
} = {}) {
  const routingRepo = {
    findByFileId: jest.fn().mockReturnValue(existingRoutings),
    deleteByFileId: jest.fn(),
    deleteNonSplitByFileId: jest.fn(),
    save: jest.fn((r) => r)
  };
  const fileRepo = {
    getChannels: jest.fn().mockReturnValue(fileChannels)
  };
  const deviceManager = {
    getDeviceList: jest.fn().mockReturnValue(knownDevices.map((id) => ({ id })))
  };
  return {
    routingRepo,
    fileRepo,
    deviceManager,
    svc: new FileRoutingSyncService({
      routingRepository: routingRepo,
      fileRepository: fileRepo,
      deviceManager,
      logger: silentLogger()
    })
  };
}

describe('syncFile', () => {
  test('deletes only non-split routings then saves valid channel → device mappings', () => {
    const { svc, routingRepo } = makeDeps();
    const result = svc.syncFile(42, { 0: 'dev-1', 1: 'dev-2' });
    expect(routingRepo.deleteNonSplitByFileId).toHaveBeenCalledWith(42);
    expect(routingRepo.deleteByFileId).not.toHaveBeenCalled();
    expect(routingRepo.save).toHaveBeenCalledTimes(2);
    expect(result.synced).toBe(2);
    expect(result.invalidDevices).toEqual([]);
    expect(result.invalidChannels).toEqual([]);
  });

  test('preserves auto-assign split routings and does not overwrite a split channel', () => {
    const { svc, routingRepo } = makeDeps({
      existingRoutings: [
        { channel: 0, device_id: 'dev-1', split_mode: 'range', instrument_name: 'SplitSeg' },
        { channel: 1, device_id: 'dev-2', split_mode: null }
      ]
    });
    // Editor sends both channels (channelRouting always covers all of them).
    const result = svc.syncFile(42, { 0: 'dev-2', 1: 'dev-1' });
    // Split channel 0 is left untouched (no plain row inserted over it).
    expect(routingRepo.deleteNonSplitByFileId).toHaveBeenCalledWith(42);
    expect(routingRepo.deleteByFileId).not.toHaveBeenCalled();
    expect(routingRepo.save).toHaveBeenCalledTimes(1);
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 1, device_id: 'dev-1' })
    );
    expect(result.synced).toBe(1);
    expect(result.splitPreserved).toBe(1);
  });

  test('reports invalid devices and skips them', () => {
    const { svc } = makeDeps();
    const result = svc.syncFile(42, { 0: 'dev-1', 1: 'unknown-dev' });
    expect(result.synced).toBe(1);
    expect(result.invalidDevices).toEqual(['unknown-dev']);
  });

  test('persists an offline-device routing DISABLED instead of dropping it (P2-3)', () => {
    const { svc, routingRepo } = makeDeps({ knownDevices: ['dev-1'] });
    // dev-2 is offline; channel 1 points at it. It must survive as disabled.
    const result = svc.syncFile(42, { 0: 'dev-1', 1: 'dev-2' });
    expect(result.synced).toBe(1); // only the online device counts as synced
    expect(result.invalidDevices).toEqual(['dev-2']);
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 1, device_id: 'dev-2', enabled: false })
    );
  });

  test('reports invalid channels and skips them', () => {
    const { svc } = makeDeps({ fileChannels: [{ channel: 0 }] });
    const result = svc.syncFile(42, { 0: 'dev-1', 5: 'dev-2' });
    expect(result.synced).toBe(1);
    expect(result.invalidChannels).toEqual([5]);
  });

  test('always accepts virtual-instrument', () => {
    const { svc, routingRepo } = makeDeps({ knownDevices: ['dev-1'] });
    const result = svc.syncFile(42, { 0: 'virtual-instrument' });
    expect(result.synced).toBe(1);
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: 'virtual-instrument' })
    );
  });

  test('parses deviceId::targetChannel syntax', () => {
    const { svc, routingRepo } = makeDeps();
    svc.syncFile(42, { 0: 'dev-1::7' });
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: 'dev-1',
        target_channel: 7
      })
    );
  });

  test('preserves auto-assign metadata when the device does not change', () => {
    const { svc, routingRepo } = makeDeps({
      existingRoutings: [
        {
          channel: 0,
          device_id: 'dev-1',
          instrument_name: 'Piano',
          compatibility_score: 92,
          auto_assigned: true,
          assignment_reason: 'auto-score',
          split_mode: null
        }
      ]
    });
    svc.syncFile(42, { 0: 'dev-1' });
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument_name: 'Piano',
        compatibility_score: 92,
        auto_assigned: true,
        assignment_reason: 'auto-score'
      })
    );
  });

  test('carries hand-position overrides forward when the device is unchanged', () => {
    const overrides = { hand_anchors: [{ tick: 480, handId: 'fretting', anchor: 5 }], version: 1 };
    const { svc, routingRepo } = makeDeps({
      existingRoutings: [
        {
          channel: 0,
          device_id: 'dev-1',
          split_mode: null,
          hand_position_overrides: overrides,
          hand_position_feasibility: { level: 'ok' }
        }
      ]
    });
    svc.syncFile(42, { 0: 'dev-1' });
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: 'dev-1',
        hand_position_overrides: overrides
      })
    );
  });

  test('clears hand-position overrides when the device changes', () => {
    const { svc, routingRepo } = makeDeps({
      existingRoutings: [
        {
          channel: 0,
          device_id: 'dev-1',
          split_mode: null,
          hand_position_overrides: { hand_anchors: [], version: 1 }
        }
      ]
    });
    svc.syncFile(42, { 0: 'dev-2' });
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: 'dev-2',
        hand_position_overrides: null
      })
    );
  });

  test('a split channel is preserved, not re-saved as a plain routing', () => {
    const { svc, routingRepo } = makeDeps({
      existingRoutings: [
        { channel: 0, device_id: 'dev-1', split_mode: 'range', instrument_name: 'SplitSeg' }
      ]
    });
    const result = svc.syncFile(42, { 0: 'dev-1' });
    expect(routingRepo.save).not.toHaveBeenCalled();
    expect(result.synced).toBe(0);
    expect(result.splitPreserved).toBe(1);
  });

  test('swallows save errors and increments nothing for that channel', () => {
    const { svc, routingRepo } = makeDeps();
    routingRepo.save = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('dup');
      })
      .mockReturnValueOnce(null);
    const result = svc.syncFile(42, { 0: 'dev-1', 1: 'dev-2' });
    expect(result.synced).toBe(1);
  });
});

describe('bulkSync', () => {
  test('syncs multiple files and aggregates counts', () => {
    const { svc, routingRepo } = makeDeps();
    const result = svc.bulkSync({
      10: { channels: { 0: 'dev-1', 1: 'dev-2' } },
      20: { channels: { 0: 'dev-1' } }
    });
    expect(result.synced).toBe(3);
    expect(result.files).toBe(2);
    expect(routingRepo.deleteNonSplitByFileId).toHaveBeenCalledWith(10);
    expect(routingRepo.deleteNonSplitByFileId).toHaveBeenCalledWith(20);
  });

  test('skips files with empty channels', () => {
    const { svc, routingRepo } = makeDeps();
    const result = svc.bulkSync({
      10: { channels: {} },
      20: { channels: { 0: 'dev-1' } }
    });
    expect(result.files).toBe(1);
    expect(routingRepo.deleteNonSplitByFileId).not.toHaveBeenCalledWith(10);
  });

  test('accumulates invalid devices across all files', () => {
    const { svc } = makeDeps();
    const result = svc.bulkSync({
      10: { channels: { 0: 'unknown-a' } },
      20: { channels: { 0: 'unknown-b' } }
    });
    expect(result.synced).toBe(0);
    expect(result.files).toBe(0);
    expect(result.invalidDevices.sort()).toEqual(['unknown-a', 'unknown-b']);
  });

  test('uses config.lastModified as created_at when provided', () => {
    const { svc, routingRepo } = makeDeps();
    svc.bulkSync({ 10: { channels: { 0: 'dev-1' }, lastModified: 1700000000000 } });
    expect(routingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ created_at: 1700000000000 })
    );
  });
});
