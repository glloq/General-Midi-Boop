// tests/midi-player-voice-injection.test.js
// Integration test for MidiPlayer._injectVoiceProgramChangeEvents (Phase 8
// multi-voice). Uses a fake database + stub deps to exercise the injection
// path without needing native SQLite bindings — mirrors
// tests/midi-player-hand-injection.test.js.

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

function makeDeps({ capabilities, voices }) {
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  const database = {
    getInstrumentCapabilities: () => capabilities,
    listInstrumentVoices: () => voices || []
  };
  const blobStore = { read: () => Buffer.alloc(0) };
  const wsServer = { broadcast: jest.fn() };
  const eventBus = { on: () => {}, emit: jest.fn() };
  return { logger, database, blobStore, wsServer, eventBus };
}

function primePlayer(player, notes) {
  player.events = notes.map((n) => ({
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

// Primary bass program = 32; a "high" secondary voice = 40 that declares it
// covers notes 60..96 (voices_share_notes cleared → the injector engages).
const shareCleared = { gm_program: 32, voices_share_notes: 0 };
const highVoice = [
  {
    gm_program: 40,
    note_selection_mode: 'range',
    note_range_min: 60,
    note_range_max: 96,
    display_order: 0
  }
];

describe('MidiPlayer._injectVoiceProgramChangeEvents', () => {
  test('injects a PC on each voice transition, collapsing runs', () => {
    const deps = makeDeps({ capabilities: shareCleared, voices: highVoice });
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 0.0, note: 40 }, // low → primary (32); == startProgram, no PC
      { time: 1.0, note: 72 }, // high → 40  (transition → PC)
      { time: 2.0, note: 74 }, // high → 40  (same, no PC)
      { time: 3.0, note: 45 } // low  → 32  (transition → PC)
    ]);

    const count = player._injectVoiceProgramChangeEvents();
    expect(count).toBe(2);

    const pcs = player.events.filter((e) => e.type === 'programChange' && e._voiceInjected);
    expect(pcs.map((e) => ({ time: e.time, program: e.program }))).toEqual([
      { time: 1.0, program: 40 },
      { time: 3.0, program: 32 }
    ]);
    // Injected PCs route only to their destination (split-safe) and precede
    // the note they gate (programChange priority < noteOn at the same time).
    expect(pcs.every((e) => e._routeTo?.device === 'dev-1' && e.channel === 0)).toBe(true);
    const pcAt1 = player.events.findIndex((e) => e.type === 'programChange' && e.time === 1.0);
    const noteAt1 = player.events.findIndex((e) => e.type === 'noteOn' && e.time === 1.0);
    expect(pcAt1).toBeLessThan(noteAt1);
  });

  test('no-op when voices_share_notes is set (default share)', () => {
    const deps = makeDeps({
      capabilities: { gm_program: 32, voices_share_notes: 1 },
      voices: highVoice
    });
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 1.0, note: 72 }]);
    const before = player.events.length;
    expect(player._injectVoiceProgramChangeEvents()).toBe(0);
    expect(player.events.length).toBe(before);
    expect(player.events.some((e) => e.type === 'programChange')).toBe(false);
  });

  test('no-op when no secondary voice declares per-voice notes', () => {
    const deps = makeDeps({ capabilities: shareCleared, voices: [{ gm_program: 40 }] });
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 1.0, note: 72 }]);
    expect(player._injectVoiceProgramChangeEvents()).toBe(0);
    expect(player.events.some((e) => e.type === 'programChange')).toBe(false);
  });

  test('idempotent: re-running strips the previous injection (no doubling)', () => {
    const deps = makeDeps({ capabilities: shareCleared, voices: highVoice });
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 1.0, note: 72 },
      { time: 3.0, note: 45 }
    ]);
    player._injectVoiceProgramChangeEvents();
    const first = player.events.filter((e) => e._voiceInjected).length;
    player._injectVoiceProgramChangeEvents();
    const second = player.events.filter((e) => e._voiceInjected).length;
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test('discrete per-voice notes are honored', () => {
    const deps = makeDeps({
      capabilities: shareCleared,
      voices: [{ gm_program: 45, note_selection_mode: 'discrete', selected_notes: [60, 64] }]
    });
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 0.0, note: 60 }, // in discrete set → 45 (transition from primary)
      { time: 1.0, note: 61 } // not in set → primary 32 (transition)
    ]);
    const count = player._injectVoiceProgramChangeEvents();
    expect(count).toBe(2);
    const pcs = player.events.filter((e) => e._voiceInjected);
    expect(pcs.map((e) => e.program)).toEqual([45, 32]);
  });
});
