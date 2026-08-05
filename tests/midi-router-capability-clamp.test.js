// tests/midi-router-capability-clamp.test.js
// The live route-through must clamp routed notes to the destination
// instrument's physical capabilities (range fold + discrete/scale snap), so a
// source keyboard can't send a mechanical instrument pitches it can't produce
// (audit P2-3: MidiRouter enforced no capabilities). Non-note messages, the GM
// drum channel, and the no-resolver case are pass-throughs.

import { describe, test, expect, jest } from '@jest/globals';
import MidiRouter from '../src/midi/routing/MidiRouter.js';
import { DEVICE_MSG_TYPES } from '../src/core/constants.js';

function makeRouter(constraints) {
  const deviceManager = { sendMessage: jest.fn(() => true) };
  const deps = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    eventBus: { on: () => {}, emit: jest.fn() },
    deviceRouteRepository: { findAll: () => [] },
    deviceManager,
    compensationService: null,
    capabilityResolver:
      constraints === undefined ? undefined : { getTimingConstraints: () => constraints }
  };
  const router = new MidiRouter(deps);
  // Inject a single enabled route kbd → robot, no filter / channel map.
  router.routes.set('r1', {
    id: 'r1',
    enabled: true,
    destination: 'robot',
    filter: null,
    channelMap: null
  });
  router.routesBySource.set('kbd', new Set(['r1']));
  return { router, deviceManager };
}

function routedNote(deviceManager) {
  const call = deviceManager.sendMessage.mock.calls[0];
  return call ? call[2].note : undefined;
}

describe('MidiRouter — live capability clamp', () => {
  test('folds an out-of-range routed note into the instrument window', () => {
    const { router, deviceManager } = makeRouter({ noteRangeMin: 60, noteRangeMax: 72 });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 84, velocity: 100 });
    expect(routedNote(deviceManager)).toBe(72);
  });

  test('snaps to the discrete playable set', () => {
    const { router, deviceManager } = makeRouter({ selectedNotes: [60, 64, 67] });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 63, velocity: 100 });
    expect(routedNote(deviceManager)).toBe(64);
  });

  test('snaps to the diatonic scale (octave_mode) with no selected_notes', () => {
    const { router, deviceManager } = makeRouter({
      noteRangeMin: 60,
      noteRangeMax: 72,
      octaveMode: 'diatonic',
      scaleRoot: 0
    });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 61, velocity: 100 });
    expect(routedNote(deviceManager)).toBe(60);
  });

  test('noteoff is clamped the same way as noteon', () => {
    const { router, deviceManager } = makeRouter({ noteRangeMin: 60, noteRangeMax: 72 });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_OFF, { channel: 0, note: 84, velocity: 0 });
    expect(routedNote(deviceManager)).toBe(72);
  });

  test('non-note messages pass through untouched', () => {
    const { router, deviceManager } = makeRouter({ noteRangeMin: 60, noteRangeMax: 72 });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.CONTROL_CHANGE, {
      channel: 0,
      controller: 7,
      value: 100
    });
    expect(deviceManager.sendMessage).toHaveBeenCalledWith(
      'robot',
      DEVICE_MSG_TYPES.CONTROL_CHANGE,
      { channel: 0, controller: 7, value: 100 }
    );
  });

  test('GM drum channel (9) is never clamped', () => {
    const { router, deviceManager } = makeRouter({ noteRangeMin: 60, noteRangeMax: 72 });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 9, note: 84, velocity: 100 });
    expect(routedNote(deviceManager)).toBe(84);
  });

  test('no CapabilityResolver wired → pass-through (no clamp, no crash)', () => {
    const { router, deviceManager } = makeRouter(undefined);
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 84, velocity: 100 });
    expect(routedNote(deviceManager)).toBe(84);
  });
});
