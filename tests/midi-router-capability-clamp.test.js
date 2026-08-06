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

  test('note-off releases the note-on pitch even if capabilities narrow mid-note', () => {
    // The core stuck-note fix: note-on 84 sounds (in range [60,84]); the range
    // then narrows to [60,72] while it is held; the note-off for 84 must release
    // 84 — NOT fold to 72 — or the mechanical instrument hangs forever.
    const deviceManager = { sendMessage: jest.fn(() => true) };
    let constraints = { noteRangeMin: 60, noteRangeMax: 84 };
    const router = new MidiRouter({
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      eventBus: { on: () => {}, emit: jest.fn() },
      deviceRouteRepository: { findAll: () => [] },
      deviceManager,
      capabilityResolver: { getTimingConstraints: () => constraints }
    });
    router.routes.set('r1', {
      id: 'r1',
      enabled: true,
      destination: 'robot',
      filter: null,
      channelMap: null
    });
    router.routesBySource.set('kbd', new Set(['r1']));

    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 84, velocity: 100 });
    expect(deviceManager.sendMessage.mock.calls[0][2].note).toBe(84); // in range → 84

    constraints = { noteRangeMin: 60, noteRangeMax: 72 }; // capabilities narrow

    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_OFF, { channel: 0, note: 84, velocity: 0 });
    expect(deviceManager.sendMessage.mock.calls[1][2].note).toBe(84); // releases 84, no hang
  });

  test('poly-aftertouch follows the note-on to its clamped pitch', () => {
    const { router, deviceManager } = makeRouter({ noteRangeMin: 60, noteRangeMax: 72 });
    router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note: 84, velocity: 100 });
    expect(deviceManager.sendMessage.mock.calls[0][2].note).toBe(72); // clamped
    router.routeMessage('kbd', DEVICE_MSG_TYPES.POLY_AFTERTOUCH, {
      channel: 0,
      note: 84,
      pressure: 50
    });
    // Aftertouch addressed to source note 84 is redirected to the sounding 72,
    // not passed through unclamped to the silent 84.
    expect(deviceManager.sendMessage.mock.calls[1][2].note).toBe(72);
  });
});

describe('MidiRouter — stable per-note compensation (audit axis6-6)', () => {
  test('a note-off reuses the compensation delay latched at its note-on', () => {
    const { router } = makeRouter();
    let comp = 30;
    router._getRelativeCompensation = () => comp;

    const onDelay = router._getStableCompensation('kbd', 'robot', DEVICE_MSG_TYPES.NOTE_ON, {
      channel: 0,
      note: 60,
      velocity: 100
    });
    expect(onDelay).toBe(30);

    // A settings recalibration lowers the relative delay mid-note.
    comp = 5;
    const offDelay = router._getStableCompensation('kbd', 'robot', DEVICE_MSG_TYPES.NOTE_OFF, {
      channel: 0,
      note: 60
    });
    // Must reuse 30 (the note-on's delay); otherwise the release could outrun a
    // still-pending note-on and strand the note.
    expect(offDelay).toBe(30);
  });

  test('non-note messages compute a fresh compensation each time', () => {
    const { router } = makeRouter();
    let comp = 12;
    router._getRelativeCompensation = () => comp;
    const cc = { channel: 0, controller: 7, value: 100 };
    expect(router._getStableCompensation('kbd', 'robot', 'cc', cc)).toBe(12);
    comp = 20;
    expect(router._getStableCompensation('kbd', 'robot', 'cc', cc)).toBe(20);
  });
});
