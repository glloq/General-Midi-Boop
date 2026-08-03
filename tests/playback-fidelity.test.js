// tests/playback-fidelity.test.js
// Covers the audit "Lot 1" playback-fidelity fixes:
//   - tempo map anchored at tick 0 / 120 BPM (P0-5)
//   - SysEx capture into the timeline incl. divided SysEx (P0-3)
//   - deterministic same-tick event ordering (P1)
//   - polyphony counting of overlapping same-pitch notes + dropped-noteOn
//     suppression + min_note_duration deferral (P1)
//   - typed sendMessageEx result semantics driving the disconnect policy (P0-6)

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';
import PlaybackScheduler from '../src/midi/playback/PlaybackScheduler.js';
import { SEND_STATUS, DEFAULT_MICROSECONDS_PER_BEAT } from '../src/core/constants.js';
import { writeMidi } from 'midi-file';

function makeLogger() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
    isDebugEnabled() {
      return false;
    },
    isWarnEnabled() {
      return true;
    },
    isInfoEnabled() {
      return true;
    }
  };
}

function makePlayer() {
  return new MidiPlayer({ logger: makeLogger(), database: null, blobStore: null });
}

describe('MidiPlayer._buildTempoMap — tick-0 / 120 BPM anchor (P0-5)', () => {
  test('a first setTempo at a non-zero tick does NOT back-fill tempo to tick 0', () => {
    const player = makePlayer();
    player.ppq = 480;
    player.tempo = 90; // simulate extractTempo having picked a non-120 first tempo
    // Single track: setTempo (60 BPM = 1_000_000 us) at tick 480.
    player.tracks = [
      {
        index: 0,
        events: [{ deltaTime: 480, type: 'setTempo', microsecondsPerBeat: 1000000 }]
      }
    ];
    const map = player._buildTempoMap();
    // Must begin with an explicit 120 BPM anchor at tick 0.
    expect(map[0]).toEqual({
      tick: 0,
      time: 0,
      microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT
    });
    // Ticks before the first setTempo convert at 120 BPM (0.5 s/beat),
    // NOT at the file's later 90/60 BPM.
    const secondsAt480 = player._ticksToSecondsWithTempoMap(480, map);
    expect(secondsAt480).toBeCloseTo(0.5, 6); // one beat at 120 BPM
  });

  test('a setTempo already at tick 0 overrides the default anchor', () => {
    const player = makePlayer();
    player.ppq = 480;
    player.tempo = 60;
    player.tracks = [
      { index: 0, events: [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 1000000 }] }
    ];
    const map = player._buildTempoMap();
    expect(map[0].tick).toBe(0);
    expect(map[0].microsecondsPerBeat).toBe(1000000); // 60 BPM at tick 0
    expect(player._ticksToSecondsWithTempoMap(480, map)).toBeCloseTo(1.0, 6);
  });
});

describe('MidiPlayer SysEx capture (P0-3)', () => {
  test('a complete SysEx frame is captured with leading F0 and trailing F7', () => {
    const player = makePlayer();
    player.ppq = 480;
    player.tempo = 120;
    // GM System On: F0 7E 7F 09 01 F7
    player.tracks = [
      {
        index: 0,
        events: [{ deltaTime: 0, type: 'sysEx', data: [0x7e, 0x7f, 0x09, 0x01, 0xf7] }]
      }
    ];
    player.buildEventList();
    const sysex = player.events.find((e) => e.type === 'sysEx');
    expect(sysex).toBeTruthy();
    expect(sysex.bytes).toEqual([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
  });

  test('divided SysEx (F0 packet + F7 continuation) is reassembled into one frame', () => {
    const player = makePlayer();
    player.ppq = 480;
    player.tempo = 120;
    player.tracks = [
      {
        index: 0,
        events: [
          { deltaTime: 0, type: 'sysEx', data: [0x43, 0x10] }, // no terminating F7 → divided
          { deltaTime: 5, type: 'endSysEx', data: [0x4c, 0xf7] }
        ]
      }
    ];
    player.buildEventList();
    const frames = player.events.filter((e) => e.type === 'sysEx');
    expect(frames).toHaveLength(1);
    expect(frames[0].bytes).toEqual([0xf0, 0x43, 0x10, 0x4c, 0xf7]);
  });
});

describe('MidiPlayer deterministic same-tick ordering (P1)', () => {
  test('programChange and controller precede noteOn at the same tick', () => {
    const player = makePlayer();
    player.ppq = 480;
    player.tempo = 120;
    // Two tracks so the note is authored BEFORE the program/bank in track order;
    // deterministic priority must still put state first.
    player.tracks = [
      {
        index: 0,
        events: [{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 }]
      },
      {
        index: 1,
        events: [
          { deltaTime: 0, type: 'controller', channel: 0, controllerType: 0, value: 1 },
          { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 5 }
        ]
      }
    ];
    player.buildEventList();
    const atZero = player.events.filter((e) => e.time === 0).map((e) => e.type);
    expect(atZero.indexOf('controller')).toBeLessThan(atZero.indexOf('noteOn'));
    expect(atZero.indexOf('programChange')).toBeLessThan(atZero.indexOf('noteOn'));
  });
});

function makeSchedulerDeps(overrides = {}) {
  return {
    logger: makeLogger(),
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    deviceManager: {
      sendMessage: jest.fn(() => true),
      sendMessageEx: jest.fn(() => ({ status: SEND_STATUS.SENT }))
    },
    ...overrides
  };
}

describe('PlaybackScheduler note gating (P1)', () => {
  test('polyphony counts two overlapping same-pitch notes as two voices', () => {
    const scheduler = new PlaybackScheduler(makeSchedulerDeps());
    scheduler._getTimingConstraints = () => ({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: 1
    });
    // First noteOn on note 60 allowed.
    expect(scheduler._shouldGateNote('dev', 0, 60, 'noteOn')).toBe(false);
    // Second overlapping noteOn on the SAME pitch must be gated (2 > polyphony 1),
    // whereas a Set-based tracker would have wrongly allowed it.
    expect(scheduler._shouldGateNote('dev', 0, 60, 'noteOn')).toBe(true);
  });

  test('a noteOff for a dropped noteOn is suppressed so it cannot cut a live note', () => {
    const scheduler = new PlaybackScheduler(makeSchedulerDeps());
    scheduler._getTimingConstraints = () => ({
      minNoteInterval: null,
      minNoteDuration: null,
      polyphony: 1
    });
    scheduler._shouldGateNote('dev', 0, 60, 'noteOn'); // voice 1 (live)
    scheduler._shouldGateNote('dev', 0, 60, 'noteOn'); // gated (dropped)
    // The first noteOff must be swallowed (belongs to the dropped noteOn)...
    expect(scheduler._shouldGateNote('dev', 0, 60, 'noteOff')).toBe(true);
    // ...and the next noteOff releases the still-live first voice.
    expect(scheduler._shouldGateNote('dev', 0, 60, 'noteOff')).toBe(false);
  });
});

describe('PlaybackScheduler disconnect policy uses typed status (P0-6)', () => {
  function runDispatch(status) {
    const dm = {
      sendMessage: jest.fn(() => false),
      sendMessageEx: jest.fn(() => ({ status }))
    };
    const scheduler = new PlaybackScheduler(makeSchedulerDeps({ deviceManager: dm }));
    const routing = { device: 'dev-x', targetChannel: 0 };
    const state = {
      playing: true,
      mutedChannels: new Set(),
      disconnectedPolicy: 'skip',
      channelRouting: new Map()
    };
    const getOutput = () => routing;
    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 60, velocity: 100 },
      state,
      getOutput,
      {}
    );
    return scheduler;
  }

  test('RATE_LIMITED does not mark the device as failed/unreachable', () => {
    const scheduler = runDispatch(SEND_STATUS.RATE_LIMITED);
    expect(scheduler._failedDevices.has('dev-x')).toBe(false);
  });

  test('DISCONNECTED marks the device as failed', () => {
    const scheduler = runDispatch(SEND_STATUS.DISCONNECTED);
    expect(scheduler._failedDevices.has('dev-x')).toBe(true);
  });
});

describe('MidiPlayer.loadFile rejects unplayable timings (P0-4)', () => {
  function playerWithFile(midiObject) {
    const bytes = Buffer.from(writeMidi(midiObject));
    const player = new MidiPlayer({
      logger: makeLogger(),
      database: { getFile: () => ({ filename: 'x.mid', blob_path: 'x' }) },
      blobStore: { read: () => bytes }
    });
    return player;
  }

  test('SMF format 2 is rejected', async () => {
    const player = playerWithFile({
      header: { format: 2, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
        ]
      ]
    });
    await expect(player.loadFile('f1')).rejects.toThrow(/format 2/i);
  });

  test('a format-1 PPQ file still loads and keeps its events', async () => {
    const player = playerWithFile({
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
        ]
      ]
    });
    const info = await player.loadFile('f2');
    expect(info.events).toBeGreaterThanOrEqual(2);
  });
});
