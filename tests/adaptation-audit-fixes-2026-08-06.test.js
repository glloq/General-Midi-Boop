// tests/adaptation-audit-fixes-2026-08-06.test.js
// Regression guards for the correctness bugs fixed after the
// 2026-08-06 adaptation & auto-routing audit
// (docs/audit/AUDIT_ADAPTATION_ROUTAGE_2026-08-06.md):
//   P1-1  event removal now redistributes deltaTime (no timeline drift)
//   P1-2  CC remap/suppress works on the parser's 'controller'/'controllerType'
//   P1-3  poly-aftertouch is transposed ('noteAftertouch')
//   P1-4  density is non-zero (tempo/duration derived when absent)
//   P1-5  tempo is derived from setTempo, not hardcoded to 120 BPM

import { describe, test, expect } from '@jest/globals';
import MidiTransposer from '../src/midi/adaptation/MidiTransposer.js';
import ChannelAnalyzer from '../src/midi/routing/ChannelAnalyzer.js';

const mockLogger = { info() {}, warn() {}, error() {}, debug() {} };

const header = { format: 0, numTracks: 1, ticksPerBeat: 480 };
const absTimes = (events) => {
  let abs = 0;
  return events.map((e) => {
    abs += e.deltaTime || 0;
    return { type: e.type, note: e.noteNumber ?? e.note, abs };
  });
};

describe('P1-2 · CC remapping targets the parser shape (type:controller / controllerType)', () => {
  const t = new MidiTransposer(mockLogger);

  test('a controller event is remapped and counted', () => {
    const midiData = {
      header,
      tracks: [
        {
          events: [{ type: 'controller', channel: 0, controllerType: 11, value: 64, deltaTime: 0 }]
        }
      ]
    };
    const res = t.transposeChannels(midiData, { 0: { ccMapping: { 11: 7 } } });
    const ev = res.midiData.tracks[0].events[0];
    expect(ev.controllerType).toBe(7);
    expect(res.stats.ccsRemapped).toBe(1);
  });

  test('ccMapping value -1 suppresses the CC and carries its deltaTime forward (P1-1)', () => {
    const midiData = {
      header,
      tracks: [
        {
          events: [
            { type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100, deltaTime: 0 },
            { type: 'controller', channel: 0, controllerType: 64, value: 127, deltaTime: 10 },
            { type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0, deltaTime: 20 }
          ]
        }
      ]
    };
    const res = t.transposeChannels(midiData, { 0: { ccMapping: { 64: -1 } } });
    const evs = res.midiData.tracks[0].events;
    expect(evs.find((e) => e.type === 'controller')).toBeUndefined();
    const off = evs.find((e) => e.type === 'noteOff');
    // 20 (its own) + 10 (carried from the removed CC) = 30 → note-off keeps its absolute tick.
    expect(off.deltaTime).toBe(30);
  });
});

describe('P1-3 · Poly-aftertouch is transposed with its note', () => {
  const t = new MidiTransposer(mockLogger);

  test('noteAftertouch pitch follows a +12 transpose', () => {
    const midiData = {
      header,
      tracks: [
        {
          events: [{ type: 'noteAftertouch', channel: 0, noteNumber: 60, amount: 80, deltaTime: 0 }]
        }
      ]
    };
    const res = t.transposeChannels(midiData, { 0: { semitones: 12 } });
    expect(res.midiData.tracks[0].events[0].noteNumber).toBe(72);
  });
});

describe('P1-1 · Suppressing out-of-range notes preserves the rest of the timeline', () => {
  const t = new MidiTransposer(mockLogger);

  test('a suppressed note does not shift later notes earlier', () => {
    const midiData = {
      header,
      tracks: [
        {
          events: [
            { type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100, deltaTime: 0 },
            { type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0, deltaTime: 480 },
            { type: 'noteOn', channel: 0, noteNumber: 20, velocity: 100, deltaTime: 0 }, // < min → suppressed
            { type: 'noteOff', channel: 0, noteNumber: 20, velocity: 0, deltaTime: 480 }, // suppressed
            { type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100, deltaTime: 0 },
            { type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0, deltaTime: 480 }
          ]
        }
      ]
    };
    const res = t.transposeChannels(midiData, {
      0: { suppressOutOfRange: true, noteRangeMin: 48, noteRangeMax: 84 }
    });
    const evs = res.midiData.tracks[0].events;
    // Note 20 (on+off) removed; note 64 must keep its original absolute ticks (960 / 1440).
    expect(absTimes(evs)).toEqual([
      { type: 'noteOn', note: 60, abs: 0 },
      { type: 'noteOff', note: 60, abs: 480 },
      { type: 'noteOn', note: 64, abs: 960 },
      { type: 'noteOff', note: 64, abs: 1440 }
    ]);
  });
});

describe('P1-4 / P1-5 · tempo & duration are derived when the converter omits them', () => {
  const a = new ChannelAnalyzer(mockLogger);

  const fourQuarterNotes = {
    header,
    tracks: [
      {
        events: [
          { type: 'setTempo', microsecondsPerBeat: 1000000, deltaTime: 0, meta: true }, // 60 BPM
          { type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100, deltaTime: 0 },
          { type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0, deltaTime: 480 },
          { type: 'noteOn', channel: 0, noteNumber: 62, velocity: 100, deltaTime: 0 },
          { type: 'noteOff', channel: 0, noteNumber: 62, velocity: 0, deltaTime: 480 },
          { type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100, deltaTime: 0 },
          { type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0, deltaTime: 480 },
          { type: 'noteOn', channel: 0, noteNumber: 65, velocity: 100, deltaTime: 0 },
          { type: 'noteOff', channel: 0, noteNumber: 65, velocity: 0, deltaTime: 480 }
        ]
      }
    ]
  };

  test('_deriveTiming reads setTempo (60 BPM) and total duration (4 beats = 4 s)', () => {
    const derived = a._deriveTiming(fourQuarterNotes);
    expect(derived.tempo).toBe(60);
    expect(derived.duration).toBeCloseTo(4, 5);
  });

  test('density is non-zero (4 notes over 4 s = 1 note/s), not the always-0 bug', () => {
    const analysis = a.analyzeChannel(fourQuarterNotes, 0);
    expect(analysis.density).toBeCloseTo(1, 5);
  });

  test('an explicit top-level tempo/duration is respected (idempotent)', () => {
    const withTiming = { ...fourQuarterNotes, tempo: 120, duration: 2 };
    const derived = a._withDerivedTiming(withTiming);
    expect(derived).toBe(withTiming); // no clone when already present
  });
});
