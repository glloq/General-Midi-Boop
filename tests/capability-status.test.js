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

// ---------------------------------------------------------------------------
// audioTranscription (§23/§44) — optional by construction.
//
// The rule this pins: a fresh install with no engine must report `disabled`,
// never `degraded`, because `degraded` propagates to `overall` and would make
// every stock Raspberry Pi look unhealthy for a feature nobody set up.

describe('Application.getCapabilityStatus — audioTranscription', () => {
  /** A transcription service double answering one snapshot. */
  function service(snapshot) {
    return { getCapabilitySnapshot: () => snapshot };
  }

  test('absent and never enabled is disabled, not failed', () => {
    const { capabilities, overall } = statusFor({ audioTranscriptionService: null });
    expect(capabilities.audioTranscription.status).toBe('disabled');
    expect(overall).toBe('ready');
  });

  test('a load error is reported as failed, with its reason', () => {
    const { capabilities } = statusFor({
      audioTranscriptionService: null,
      _capabilityErrors: { transcription: 'registry blew up' }
    });
    expect(capabilities.audioTranscription).toEqual({
      status: 'failed',
      detail: 'registry blew up'
    });
  });

  test('no engine installed does NOT degrade the overall health', () => {
    const { capabilities, overall } = statusFor({
      audioTranscriptionService: service({
        status: 'disabled',
        detail: 'No transcription engine is installed',
        ffmpeg: { available: false },
        backends: []
      })
    });
    expect(capabilities.audioTranscription.status).toBe('disabled');
    expect(overall).toBe('ready');
  });

  test('an engine installed but broken does degrade it', () => {
    const { capabilities, overall } = statusFor({
      audioTranscriptionService: service({
        status: 'degraded',
        detail: '1 transcription engine(s) installed but unusable',
        ffmpeg: { available: true },
        backends: [{ id: 'x', status: 'broken', available: false }]
      })
    });
    expect(capabilities.audioTranscription.status).toBe('degraded');
    expect(overall).toBe('degraded');
  });

  test('a ready engine reports ready', () => {
    const { capabilities, overall } = statusFor({
      audioTranscriptionService: service({
        status: 'ready',
        detail: null,
        ffmpeg: { available: true },
        backends: [{ id: 'x', status: 'available', available: true }]
      })
    });
    expect(capabilities.audioTranscription).toEqual({ status: 'ready' });
    expect(overall).toBe('ready');
  });

  test('a throwing snapshot is contained, never propagated', () => {
    const { capabilities, overall } = statusFor({
      audioTranscriptionService: {
        getCapabilitySnapshot: () => {
          throw new Error('boom');
        }
      }
    });
    expect(capabilities.audioTranscription).toEqual({ status: 'failed', detail: 'boom' });
    // A failed OPTIONAL capability degrades, it does not fail the server.
    expect(overall).toBe('degraded');
  });
});
