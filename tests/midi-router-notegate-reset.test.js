// tests/midi-router-notegate-reset.test.js
// Regression guard for the audit HIGH finding: the live route-through note-gate
// (polyphony / min-interval state) must be reset on panic / all-notes-off,
// device disconnect, and route delete/disable. Otherwise a phantom voice from a
// lost note-off permanently gates a low-polyphony instrument or strands notes.

import { describe, test, expect, jest } from '@jest/globals';
import MidiRouter from '../src/midi/routing/MidiRouter.js';
import { DEVICE_MSG_TYPES } from '../src/core/constants.js';

function makeRouter() {
  const deviceManager = { sendMessage: jest.fn(() => true) };
  const handlers = {};
  const deps = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    eventBus: {
      on: (ev, h) => {
        handlers[ev] = h;
      },
      off: () => {},
      emit: jest.fn()
    },
    deviceRouteRepository: { findAll: () => [] },
    deviceManager,
    compensationService: null,
    // Monophonic destination so a single held note gates the next.
    capabilityResolver: { getTimingConstraints: () => ({ polyphony: 1 }) }
  };
  const router = new MidiRouter(deps);
  router.routes.set('r1', {
    id: 'r1',
    enabled: true,
    source: 'kbd',
    destination: 'robot',
    filter: null,
    channelMap: null
  });
  router.routesBySource.set('kbd', new Set(['r1']));
  // Give the route repo a delete stub for deleteRoute().
  router._routeRepo = { delete: () => {}, update: () => {}, findAll: () => [] };
  return { router, deviceManager, handlers };
}

const noteOnCount = (dm) =>
  dm.sendMessage.mock.calls.filter((c) => c[1] === DEVICE_MSG_TYPES.NOTE_ON).length;

const on = (router, note) =>
  router.routeMessage('kbd', DEVICE_MSG_TYPES.NOTE_ON, { channel: 0, note, velocity: 100 });

describe('MidiRouter note-gate reset', () => {
  test('a phantom held voice gates a new note until the gate is reset (panic)', () => {
    const { router, deviceManager } = makeRouter();
    on(router, 60); // admitted (sent)
    on(router, 64); // 60 still "held" (note-off lost) → gated on a mono instrument
    expect(noteOnCount(deviceManager)).toBe(1);

    router.resetNoteGate(); // panic / all-notes-off escape hatch
    on(router, 67); // gate cleared → admitted again
    expect(noteOnCount(deviceManager)).toBe(2);
  });

  test('device_disconnected clears the gate', () => {
    const { router, handlers } = makeRouter();
    on(router, 60);
    expect(router._noteGate._active.size).toBeGreaterThan(0);
    expect(typeof handlers['device_disconnected']).toBe('function');
    handlers['device_disconnected']({ deviceId: 'robot' });
    expect(router._noteGate._active.size).toBe(0);
  });

  test('deleteRoute clears the gate', () => {
    const { router } = makeRouter();
    on(router, 60);
    expect(router._noteGate._active.size).toBeGreaterThan(0);
    router.deleteRoute('r1');
    expect(router._noteGate._active.size).toBe(0);
  });

  test('disabling a route clears the gate; enabling does not', () => {
    const { router } = makeRouter();
    on(router, 60);
    router.enableRoute('r1', true); // enable is a no-op for the gate
    expect(router._noteGate._active.size).toBeGreaterThan(0);
    router.enableRoute('r1', false); // disable clears
    expect(router._noteGate._active.size).toBe(0);
  });
});
