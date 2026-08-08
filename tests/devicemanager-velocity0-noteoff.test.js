// tests/devicemanager-velocity0-noteoff.test.js
// Audit A1 Serial#2: DeviceManager.handleMidiMessage is the common inbound
// entry for serial and USB (easymidi) input, both of which deliver a
// velocity-0 Note On verbatim. It must normalize that to a Note Off (as
// handleRawMidi already does for BLE/network) so the router's stuck-note
// latches and the rate-limiter treat it as a release — otherwise a note can
// hang. handleMidiMessage uses no construction-only state, so we drive it via
// prototype-call with a minimal context (no native easymidi needed).

import { describe, test, expect, jest } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

function makeCtx() {
  return {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    eventBus: { emit: jest.fn() },
    midiRouter: { routeMessage: jest.fn() },
    wsServer: null,
    database: null
  };
}

const call = (ctx, device, type, msg) =>
  DeviceManager.prototype.handleMidiMessage.call(ctx, device, type, msg);

describe('DeviceManager.handleMidiMessage — velocity-0 Note On normalization', () => {
  test('noteon with velocity 0 is routed as noteoff', () => {
    const ctx = makeCtx();
    call(ctx, 'ttyS0', 'noteon', { channel: 0, note: 60, velocity: 0 });
    expect(ctx.midiRouter.routeMessage).toHaveBeenCalledWith('ttyS0', 'noteoff', {
      channel: 0,
      note: 60,
      velocity: 0
    });
    // The EventBus + would-be WS broadcast also see the normalized type.
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      'midi_message',
      expect.objectContaining({ type: 'noteoff', device: 'ttyS0' })
    );
  });

  test('noteon with a real velocity stays noteon', () => {
    const ctx = makeCtx();
    call(ctx, 'ttyS0', 'noteon', { channel: 0, note: 60, velocity: 100 });
    expect(ctx.midiRouter.routeMessage).toHaveBeenCalledWith('ttyS0', 'noteon', {
      channel: 0,
      note: 60,
      velocity: 100
    });
  });

  test('an explicit noteoff is passed through unchanged', () => {
    const ctx = makeCtx();
    call(ctx, 'ttyS0', 'noteoff', { channel: 0, note: 60, velocity: 0 });
    expect(ctx.midiRouter.routeMessage).toHaveBeenCalledWith('ttyS0', 'noteoff', {
      channel: 0,
      note: 60,
      velocity: 0
    });
  });
});
