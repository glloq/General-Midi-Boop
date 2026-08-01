// tests/capability-status.test.js
// Covers Application.getCapabilityStatus() (audit P2 — per-capability
// health). Invoked via the prototype against a hand-built `this` so the
// test does not need the full Application boot (config/logging/I/O).

import { describe, test, expect } from '@jest/globals';
import Application from '../src/core/Application.js';

const getCapabilityStatus = Application.prototype.getCapabilityStatus;

function statusFor(overrides) {
  const self = {
    _capabilityErrors: {},
    database: {},
    midiPlayer: {},
    deviceManager: {},
    bluetoothManager: null,
    networkManager: null,
    serialMidiManager: null,
    lightingManager: null,
    ...overrides
  };
  return getCapabilityStatus.call(self);
}

describe('Application.getCapabilityStatus (P2)', () => {
  test('a present RTP-MIDI network manager is reported as degraded', () => {
    const { capabilities } = statusFor({ networkManager: {} });
    expect(capabilities.network.status).toBe('degraded');
    expect(capabilities.network.detail).toMatch(/AppleMIDI/i);
  });

  test('an absent optional transport is disabled; a load error is failed', () => {
    const { capabilities } = statusFor({
      serialMidiManager: null,
      _capabilityErrors: { ble: 'noble missing' }
    });
    expect(capabilities.serial.status).toBe('disabled');
    expect(capabilities.ble.status).toBe('failed');
    expect(capabilities.ble.detail).toBe('noble missing');
  });

  test('overall is degraded when only optional capabilities are degraded/failed', () => {
    const { overall } = statusFor({ networkManager: {} });
    expect(overall).toBe('degraded');
  });

  test('overall is failed when a core capability is down', () => {
    const { overall } = statusFor({ midiPlayer: null });
    expect(overall).toBe('failed');
  });

  test('overall is ready when every capability is ready and no optional degraded', () => {
    const { overall } = statusFor({
      bluetoothManager: {},
      serialMidiManager: {},
      lightingManager: {},
      networkManager: null // network is the only degraded-by-default one; keep it disabled
    });
    expect(overall).toBe('ready');
  });
});
