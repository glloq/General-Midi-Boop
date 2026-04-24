// tests/midi-player-hand-injection.test.js
// Integration test for MidiPlayer._injectHandPositionCCEvents.
// Uses a fake database + stub deps to exercise the injection path
// without needing native SQLite bindings.

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

function makeDeps(handsConfig) {
  const logger = {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {}
  };
  const database = {
    getInstrumentCapabilities(_deviceId, _channel) {
      return handsConfig ? { hands_config: handsConfig } : null;
    }
  };
  const blobStore = { read: () => Buffer.alloc(0) };
  const wsServer = { broadcast: jest.fn() };
  const eventBus = { on: () => {}, emit: jest.fn() };
  return { logger, database, blobStore, wsServer, eventBus };
}

function primePlayer(player, notes) {
  // Bypass loadFile — stub the pieces `_injectHandPositionCCEvents` needs.
  player.events = notes.map(n => ({
    time: n.time,
    type: 'noteOn',
    channel: n.channel ?? 0,
    note: n.note,
    velocity: n.velocity ?? 80,
    track: n.track ?? 0
  }));
  player.channelRouting.set(0, { device: 'dev-1', targetChannel: 0 });
  player.loadedFileId = 42;
}

const pianoHands = {
  enabled: true,
  hands: [
    { id: 'left', cc_position_number: 23, hand_span_semitones: 14, polyphony: 5 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14, polyphony: 5 }
  ]
};

describe('MidiPlayer._injectHandPositionCCEvents', () => {
  test('injects CCs when the destination instrument has hands_config', () => {
    const deps = makeDeps(pianoHands);
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 0.5, note: 40 },  // left
      { time: 1.0, note: 72 }   // right
    ]);

    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBeGreaterThan(0);

    const ccs = player.events.filter(e => e.type === 'controller');
    expect(ccs.map(e => e.controller).sort()).toEqual([23, 24]);
    // CC values should match the lowest note per hand.
    expect(ccs.find(e => e.controller === 23).value).toBe(40);
    expect(ccs.find(e => e.controller === 24).value).toBe(72);
  });

  test('no CCs injected when instrument has no hands_config (regression)', () => {
    const deps = makeDeps(null);
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }, { time: 1.0, note: 72 }]);

    const before = player.events.length;
    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBe(0);
    expect(player.events.length).toBe(before);
    expect(player.events.some(e => e.type === 'controller')).toBe(false);
  });

  test('idempotent across re-runs (no accumulation)', () => {
    const deps = makeDeps(pianoHands);
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }, { time: 1.0, note: 72 }]);

    player._injectHandPositionCCEvents();
    const firstCount = player.events.filter(e => e.type === 'controller').length;

    player._injectHandPositionCCEvents();
    const secondCount = player.events.filter(e => e.type === 'controller').length;

    expect(secondCount).toBe(firstCount);
  });

  test('broadcasts feasibility warnings when present', () => {
    const handsWithNarrowRange = {
      enabled: true,
      hands: [
        { id: 'left', cc_position_number: 23, hand_span_semitones: 14, polyphony: 5, note_range_min: 50, note_range_max: 70 }
      ]
    };
    const deps = makeDeps(handsWithNarrowRange);
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }]); // below range_min → warning

    player._injectHandPositionCCEvents();

    expect(deps.wsServer.broadcast).toHaveBeenCalledWith(
      'playback_hand_position_warnings',
      expect.objectContaining({ warnings: expect.any(Array) })
    );
  });

  test('skips split routings (Phase 1 scope)', () => {
    const deps = makeDeps(pianoHands);
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }]);
    player.channelRouting.set(0, { split: true, segments: [] });

    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBe(0);
  });

  test('no-op when there are no routings', () => {
    const deps = makeDeps(pianoHands);
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }]);
    player.channelRouting.clear();

    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBe(0);
  });
});
