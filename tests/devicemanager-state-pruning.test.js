// tests/devicemanager-state-pruning.test.js
// On a hot-plug `update`, DeviceManager reconciles its per-device recognition
// state (announce dedupe, identity probes, descriptor transfers, cached
// descriptor revisions) against the still-open ports, so a disconnected device
// is forgotten (freeing state + cancelling timers) and can re-announce on
// reconnect. Invoked via prototype.call with plain stubs (no MIDI stack).

import { describe, test, expect, jest } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

const P = DeviceManager.prototype;

describe('_pruneDisconnectedDeviceState', () => {
  test('drops state for closed ports, keeps still-open ones, cancels pending timers', () => {
    const goneProbeTimer = setTimeout(() => {}, 10_000);
    const goneFetchTimer = setTimeout(() => {}, 10_000);
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    const ctx = {
      inputs: new Map([['live', {}]]),
      outputs: new Map(),
      _announcedDevices: new Set(['live', 'gone']),
      _identityProbes: new Map([
        ['live', { debounceTimer: null, replyTimer: null }],
        ['gone', { debounceTimer: goneProbeTimer, replyTimer: null }]
      ]),
      _descriptorFetches: new Map([['gone', { timer: goneFetchTimer }]]),
      _descriptorRevisions: new Map([
        ['live', 7],
        ['gone', 3]
      ]),
      _pruneDisconnectedDeviceState: P._pruneDisconnectedDeviceState
    };

    ctx._pruneDisconnectedDeviceState();

    // Still-open device retained across every map.
    expect(ctx._announcedDevices.has('live')).toBe(true);
    expect(ctx._identityProbes.has('live')).toBe(true);
    expect(ctx._descriptorRevisions.get('live')).toBe(7);

    // Disconnected device purged from every map.
    expect(ctx._announcedDevices.has('gone')).toBe(false);
    expect(ctx._identityProbes.has('gone')).toBe(false);
    expect(ctx._descriptorFetches.has('gone')).toBe(false);
    expect(ctx._descriptorRevisions.has('gone')).toBe(false);

    // Pending timers for the pruned device were cancelled.
    expect(clearSpy).toHaveBeenCalledWith(goneProbeTimer);
    expect(clearSpy).toHaveBeenCalledWith(goneFetchTimer);
    clearSpy.mockRestore();
  });

  test('a device still open on EITHER input or output is retained', () => {
    const ctx = {
      inputs: new Map(),
      outputs: new Map([['out-only', {}]]),
      _announcedDevices: new Set(['out-only']),
      _identityProbes: new Map(),
      _descriptorFetches: new Map(),
      _descriptorRevisions: new Map([['out-only', 1]]),
      _pruneDisconnectedDeviceState: P._pruneDisconnectedDeviceState
    };

    ctx._pruneDisconnectedDeviceState();

    expect(ctx._announcedDevices.has('out-only')).toBe(true);
    expect(ctx._descriptorRevisions.get('out-only')).toBe(1);
  });
});
