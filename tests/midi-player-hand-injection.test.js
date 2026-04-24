// tests/midi-player-hand-injection.test.js
// Integration test for MidiPlayer._injectHandPositionCCEvents.
// Uses a fake database + stub deps to exercise the injection path
// without needing native SQLite bindings.

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

function makeDeps(handsConfig, extraCapabilities) {
  const logger = {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {}
  };
  // Accept either a single config (applied to every lookup) or a map
  // keyed by `deviceId:channel` for split-routing scenarios.
  const lookup = (deviceId, channel) => {
    if (handsConfig && typeof handsConfig === 'object' && !Array.isArray(handsConfig) && handsConfig.__byKey) {
      const cfg = handsConfig.__byKey[`${deviceId}:${channel}`];
      return cfg ? { hands_config: cfg, ...(extraCapabilities || {}) } : null;
    }
    return handsConfig ? { hands_config: handsConfig, ...(extraCapabilities || {}) } : null;
  };
  const database = { getInstrumentCapabilities: lookup };
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
    { id: 'left', cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
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
    const handsCfg = {
      enabled: true,
      hands: [
        { id: 'left', cc_position_number: 23, hand_span_semitones: 14 }
      ]
    };
    // The playable range (used for out_of_range checks) now lives on
    // the instrument's capabilities, not on each hand.
    const deps = makeDeps(handsCfg, { note_range_min: 50, note_range_max: 70 });
    const player = new MidiPlayer(deps);
    primePlayer(player, [{ time: 0.5, note: 40 }]); // below range_min → warning

    player._injectHandPositionCCEvents();

    expect(deps.wsServer.broadcast).toHaveBeenCalledWith(
      'playback_hand_position_warnings',
      expect.objectContaining({ warnings: expect.any(Array) })
    );
  });

  test('split routings: each segment gets its own CC stream', () => {
    // Left segment (notes 0-59, device bass) and right segment (60-127, device treble)
    // with their own hand configs.
    const bassHands = {
      enabled: true,
      hands: [{ id: 'left', cc_position_number: 23, hand_span_semitones: 14 }]
    };
    const trebleHands = {
      enabled: true,
      hands: [{ id: 'right', cc_position_number: 24, hand_span_semitones: 14 }]
    };
    const deps = makeDeps({
      __byKey: {
        'dev-bass:0': bassHands,
        'dev-treble:0': trebleHands
      }
    });
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 0.5, note: 40 },  // bass segment
      { time: 1.0, note: 72 },  // treble segment
      { time: 1.5, note: 45 }   // bass segment
    ]);
    player.channelRouting.set(0, {
      split: true,
      segments: [
        { device: 'dev-bass',   targetChannel: 0, noteMin: 0,  noteMax: 59 },
        { device: 'dev-treble', targetChannel: 0, noteMin: 60, noteMax: 127 }
      ]
    });

    player._injectHandPositionCCEvents();

    const ccs = player.events.filter(e => e.type === 'controller');
    const bassCCs = ccs.filter(e => e._routeTo?.device === 'dev-bass');
    const trebleCCs = ccs.filter(e => e._routeTo?.device === 'dev-treble');

    expect(bassCCs.length).toBeGreaterThan(0);
    expect(trebleCCs.length).toBeGreaterThan(0);
    expect(bassCCs[0].controller).toBe(23);
    expect(bassCCs[0].value).toBe(40);
    expect(trebleCCs[0].controller).toBe(24);
    expect(trebleCCs[0].value).toBe(72);
    // Every injected CC must carry _routeTo so the scheduler bypasses
    // the split-broadcast path.
    for (const cc of ccs) {
      expect(cc._routeTo).toEqual(expect.objectContaining({ device: expect.any(String) }));
    }
  });

  test('split routing: segment without hands_config is skipped', () => {
    const trebleHands = {
      enabled: true,
      hands: [{ id: 'right', cc_position_number: 24, hand_span_semitones: 14 }]
    };
    const deps = makeDeps({
      __byKey: { 'dev-treble:0': trebleHands } // bass destination has no config
    });
    const player = new MidiPlayer(deps);
    primePlayer(player, [
      { time: 0.5, note: 40 },
      { time: 1.0, note: 72 }
    ]);
    player.channelRouting.set(0, {
      split: true,
      segments: [
        { device: 'dev-bass',   targetChannel: 0, noteMin: 0,  noteMax: 59 },
        { device: 'dev-treble', targetChannel: 0, noteMin: 60, noteMax: 127 }
      ]
    });

    player._injectHandPositionCCEvents();

    const ccs = player.events.filter(e => e.type === 'controller');
    expect(ccs.every(e => e._routeTo?.device === 'dev-treble')).toBe(true);
    expect(ccs.some(e => e._routeTo?.device === 'dev-bass')).toBe(false);
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

// -----------------------------------------------------------------------------
// Frets mode: reads persisted tablature_data, derives maxFret from the
// string_instrument, skips open strings, and emits CC22 with absolute fret.
// -----------------------------------------------------------------------------

function makeFretsDeps({ handsConfig, tablature, stringInstrument, extraCapabilities }) {
  const logger = {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {}
  };
  const database = {
    getInstrumentCapabilities: () => handsConfig
      ? { hands_config: handsConfig, ...(extraCapabilities || {}) }
      : null,
    getTablaturesByFile: () => (tablature ? [tablature] : []),
    stringInstrumentDB: {
      getStringInstrumentById: () => stringInstrument || null
    }
  };
  const blobStore = { read: () => Buffer.alloc(0) };
  const wsServer = { broadcast: jest.fn() };
  const eventBus = { on: () => {}, emit: jest.fn() };
  return { logger, database, blobStore, wsServer, eventBus };
}

function primeFretsPlayer(player, tabEvents) {
  // Note-on events mirror the tablature entries so the scheduler has
  // something to route. With ppq=480 and tempo=120, tick 960 == 1s.
  player.events = tabEvents.map(ev => ({
    time: ev.tick / (480 * 2), // ticksToSeconds at 120 BPM, ppq 480
    type: 'noteOn',
    channel: 0,
    note: ev.midiNote,
    velocity: 80,
    track: 0
  }));
  player.channelRouting.set(0, { device: 'gtr', targetChannel: 0 });
  player.loadedFileId = 101;
}

const guitarHands = {
  enabled: true,
  mode: 'frets',
  hand_move_frets_per_sec: 12,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_frets: 4 }]
};

describe('MidiPlayer._injectHandPositionCCEvents — frets mode', () => {
  test('injects CC22 with absolute fret for a fretted sequence', () => {
    const tabEvents = [
      { tick: 0,    string: 5, fret: 3, midiNote: 43 },
      { tick: 480,  string: 5, fret: 5, midiNote: 45 },
      { tick: 1920, string: 3, fret: 12, midiNote: 62 } // forces shift
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22, frets_per_string: [22, 22, 22, 22, 22, 22] }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBeGreaterThan(0);

    const ccs = player.events.filter(e => e.type === 'controller' && e._handInjected);
    expect(ccs.every(e => e.controller === 22)).toBe(true);
    // First CC anchors the initial window at fret 3.
    expect(ccs[0].value).toBe(3);
    // A subsequent shift to fret 12 lands above span 4.
    expect(ccs.some(e => e.value === 12)).toBe(true);
    // Every injected CC carries _routeTo for the split-broadcast bypass.
    for (const cc of ccs) {
      expect(cc._routeTo).toEqual(expect.objectContaining({ device: 'gtr' }));
    }
  });

  test('open strings (fret=0) do not force shifts', () => {
    const tabEvents = [
      { tick: 0,    string: 5, fret: 5, midiNote: 45 },
      { tick: 480,  string: 0, fret: 0, midiNote: 64 }, // open high E
      { tick: 960,  string: 5, fret: 7, midiNote: 47 }
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22 }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const ccs = player.events.filter(e => e.type === 'controller' && e._handInjected);
    // Only one CC: the initial anchor. The open string must not move the hand
    // and the return to fret 7 stays inside [5..9].
    expect(ccs).toHaveLength(1);
    expect(ccs[0].value).toBe(5);
  });

  test('initial CC is scheduled before the first fretted note', () => {
    const tabEvents = [
      { tick: 960, string: 5, fret: 5, midiNote: 45 }
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22 }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const ccs = player.events.filter(e => e.type === 'controller' && e._handInjected);
    expect(ccs).toHaveLength(1);
    // Note is at 1.0s; CC must fire strictly before.
    expect(ccs[0].time).toBeLessThan(1.0);
    expect(ccs[0].time).toBeGreaterThan(0.99);
  });

  test('frets mode with no tablature is a no-op', () => {
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: null,
      stringInstrument: { num_frets: 22 }
    });
    const player = new MidiPlayer(deps);
    // Even though we have noteOn events, no tablature = no fret positions = skip.
    primeFretsPlayer(player, [{ tick: 0, string: 5, fret: 3, midiNote: 43 }]);

    const injected = player._injectHandPositionCCEvents();
    expect(injected).toBe(0);
    expect(player.events.some(e => e.type === 'controller' && e._handInjected)).toBe(false);
  });

  test('maxFret comes from frets_per_string when present', () => {
    // Uneven fretboard: string 6 caps at 12, others at 22. Playing fret 20
    // should still be accepted (it's within max=22), but a fret beyond
    // max=22 should raise an out_of_range warning.
    const tabEvents = [
      { tick: 0,   string: 0, fret: 25, midiNote: 100 } // 25 > maxFret 22
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22, frets_per_string: [22, 22, 22, 22, 22, 12] }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);
    player._injectHandPositionCCEvents();

    expect(deps.wsServer.broadcast).toHaveBeenCalledWith(
      'playback_hand_position_warnings',
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: 'out_of_range' })
        ])
      })
    );
  });

  test('idempotent across re-runs in frets mode', () => {
    const tabEvents = [
      { tick: 0,   string: 5, fret: 3, midiNote: 43 },
      { tick: 480, string: 5, fret: 5, midiNote: 45 }
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22 }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const first = player.events.filter(e => e._handInjected).length;
    player._injectHandPositionCCEvents();
    const second = player.events.filter(e => e._handInjected).length;
    expect(second).toBe(first);
  });

  test('physical model: a 0→4 jump near the nut forces a shift on a 80mm hand', () => {
    // 80 mm hand on 650 mm scale ≈ 2.2 frets at fret 0. A 4-fret jump
    // exceeds that → 2 CCs.
    const tabEvents = [
      { tick: 0,    string: 0, fret: 0, midiNote: 60 }, // open: filtered upstream
      { tick: 240,  string: 0, fret: 1, midiNote: 61 },
      { tick: 960,  string: 0, fret: 4, midiNote: 64 }
    ];
    const handsCfgPhys = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    const deps = makeFretsDeps({
      handsConfig: handsCfgPhys,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22, scale_length_mm: 650 }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const ccs = player.events.filter(e => e._handInjected);
    expect(ccs.length).toBeGreaterThanOrEqual(2);
  });

  test('physical model: same 0→4 jump high on the neck (fret 12→16) does not shift', () => {
    // ~4.4 frets reach at fret 12, so 12→15 fits in the same window.
    const tabEvents = [
      { tick: 0,    string: 0, fret: 12, midiNote: 76 },
      { tick: 960,  string: 0, fret: 15, midiNote: 79 }
    ];
    const handsCfgPhys = {
      enabled: true,
      mode: 'frets',
      hand_move_mm_per_sec: 250,
      hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
    };
    const deps = makeFretsDeps({
      handsConfig: handsCfgPhys,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22, scale_length_mm: 650 }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const ccs = player.events.filter(e => e._handInjected);
    expect(ccs).toHaveLength(1);
    expect(ccs[0].value).toBe(12);
  });

  test('falls back to fret-count model when scale_length_mm is null', () => {
    // No scale length → 4-fret constant window, regardless of position.
    const tabEvents = [
      { tick: 0,    string: 0, fret: 12, midiNote: 76 },
      { tick: 960,  string: 0, fret: 15, midiNote: 79 } // within 4 frets → no shift
    ];
    const deps = makeFretsDeps({
      handsConfig: guitarHands,
      tablature: { channel: 0, string_instrument_id: 7, tablature_data: tabEvents },
      stringInstrument: { num_frets: 22, scale_length_mm: null }
    });
    const player = new MidiPlayer(deps);
    primeFretsPlayer(player, tabEvents);

    player._injectHandPositionCCEvents();
    const ccs = player.events.filter(e => e._handInjected);
    expect(ccs).toHaveLength(1);
  });
});
