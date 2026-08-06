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
import DrumNoteMapper from '../src/midi/adaptation/DrumNoteMapper.js';
import ScoringConfig from '../src/midi/adaptation/ScoringConfig.js';
import InstrumentMatcher from '../src/midi/adaptation/InstrumentMatcher.js';
import TablatureConverter from '../src/midi/adaptation/TablatureConverter.js';

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

describe('P1-9 · Default drumFallback substitutes nice-to-have percussion (no silent drop)', () => {
  const mapper = new DrumNoteMapper(mockLogger);
  const drumNote = (n, v = 80) => ({
    type: 'noteOn',
    channel: 9,
    note: n,
    noteNumber: n,
    velocity: v,
    time: 0
  });

  test('whistle/woodblock/cuica/triangle map to available pads under the production defaults', () => {
    const midiNotes = mapper.classifyDrumNotes([
      drumNote(71), // Short Whistle → 72
      drumNote(76), // Hi Wood Block → 77
      drumNote(78), // Mute Cuica    → 79
      drumNote(80) // Mute Triangle  → 81
    ]);
    // Instrument has ONLY the substitution targets, and we pass the REAL default
    // drumFallback (the production path). Before the fix these categories were
    // -1 ("ignore") and every hit was dropped as "category ignored".
    const result = mapper.generateMapping(midiNotes, [72, 77, 79, 81], {
      categoryDepthLimits: ScoringConfig.routing.drumFallback
    });
    expect(result.mapping[71]).toBe(72);
    expect(result.mapping[76]).toBe(77);
    expect(result.mapping[78]).toBe(79);
    expect(result.mapping[80]).toBe(81);
    const omitted = new Set((result.omissions || []).map((o) => o.note));
    expect(omitted.has(71)).toBe(false);
    expect(omitted.has(80)).toBe(false);
  });
});

describe('P2-5 · Matcher drum predicate matches AutoAssigner (no unassignable kit)', () => {
  const m = new InstrumentMatcher(mockLogger);

  test('a drums-typed range-mode kit with no GM program is recognised as drums', () => {
    expect(
      m.isDrumsInstrument({
        instrument_type: 'drums',
        note_selection_mode: 'range',
        gm_program: null
      })
    ).toBe(true);
    expect(m.isDrumsInstrument({ channel: 9 })).toBe(true);
    expect(m.isDrumsInstrument({ note_selection_mode: 'discrete' })).toBe(true);
    expect(m.isDrumsInstrument({ gm_program: 115 })).toBe(true);
  });

  test('a normal melodic instrument is not treated as drums', () => {
    expect(
      m.isDrumsInstrument({
        instrument_type: 'piano',
        note_selection_mode: 'range',
        gm_program: 0,
        channel: 0
      })
    ).toBe(false);
  });
});

describe('P2-6 · Type score uses the heuristic type for a channel with no Program Change', () => {
  const m = new InstrumentMatcher(mockLogger);
  // category 'unknown' (no Program Change) but a heuristic type is still known.
  const chBass = { category: 'unknown', categorySubtype: null, type: 'bass' };

  test('a bass channel vs a percussive instrument is a real mismatch, not neutral', () => {
    const res = m.scoreInstrumentType(chBass, {
      category: 'unknown',
      subtype: null,
      type: 'percussive'
    });
    expect(res.info).not.toBe('Instrument type not determined');
    expect(res.score).toBe(0);
  });

  test('a bass channel vs a melodic instrument scores via the legacy type match', () => {
    const res = m.scoreInstrumentType(chBass, {
      category: 'unknown',
      subtype: null,
      type: 'melody'
    });
    expect(res.info).toMatch(/Legacy type match/);
  });
});

describe('P2-7 · Hand-feasibility reads num_fingers, not only max_fingers / 5-per-hand', () => {
  const m = new InstrumentMatcher(mockLogger);

  test('frets: a 2-finger fret_sliding_fingers effector (no max_fingers) is infeasible for a 6-note chord', () => {
    const instrument = {
      hands_config: { enabled: true, mode: 'frets', hands: [{ id: 'fretting', num_fingers: 2 }] }
    };
    const analysis = { polyphony: { max: 6 }, noteRange: { min: 40, max: 52 } };
    const res = m._scoreHandPositionFeasibility(analysis, instrument);
    expect(res.summary.maxFingers).toBe(2);
    expect(res.level).toBe('infeasible');
  });

  test('semitones: a 2-hand × 3-finger robot is bounded at 6 fingers, not 10', () => {
    const instrument = {
      hands_config: {
        enabled: true,
        mode: 'semitones',
        hands: [
          { id: 'left', num_fingers: 3, hand_span_semitones: 14 },
          { id: 'right', num_fingers: 3, hand_span_semitones: 14 }
        ]
      }
    };
    const analysis = { polyphony: { max: 8 }, noteRange: { min: 48, max: 72 } };
    const res = m._scoreHandPositionFeasibility(analysis, instrument);
    expect(res.summary.totalFingers).toBe(6);
    expect(res.level).toBe('infeasible'); // 8 > 6
  });
});

describe('P2-11 · Split routes poly-aftertouch to its note segment, not every segment', () => {
  const t = new MidiTransposer(mockLogger);

  test('noteAftertouch on note 40 goes only to the segment that owns 40', () => {
    const midiData = {
      header,
      tracks: [
        {
          events: [
            { type: 'noteOn', channel: 0, noteNumber: 40, velocity: 100, deltaTime: 0 },
            { type: 'noteAftertouch', channel: 0, noteNumber: 40, amount: 90, deltaTime: 10 },
            { type: 'noteOff', channel: 0, noteNumber: 40, velocity: 0, deltaTime: 20 }
          ]
        }
      ]
    };
    const segments = [
      { noteMin: 36, noteMax: 59, targetChannel: 0 },
      { noteMin: 60, noteMax: 84, targetChannel: 2 }
    ];
    const res = t.splitChannelInFile(midiData, 0, segments);
    const at = res.midiData.tracks[0].events.filter((e) => e.type === 'noteAftertouch');
    expect(at).toHaveLength(1); // not duplicated onto every segment channel
    expect(at[0].channel).toBe(0); // follows note 40 into the low segment
  });
});

describe('P2-9 · Tablature keeps a long drone string reserved beyond 7680 ticks', () => {
  const guitarConfig = {
    tuning: [40, 45, 50, 55, 59, 64],
    num_strings: 6,
    num_frets: 24,
    is_fretless: false,
    tab_algorithm: 'lowest_fret'
  };
  const tabNote = (t, n, g = 240, v = 80, c = 0) => ({ t, n, g, v, c });

  test('a D3 played while a ~40-beat D3 drone still sounds is not put on the drone string', () => {
    const conv = new TablatureConverter(guitarConfig);
    const notes = [
      tabNote(0, 50, 20000), // D3 drone, ~40 beats — takes the open 3rd string
      tabNote(300, 45, 240), // filler that ends >7680 ticks before the test note
      tabNote(8000, 50, 240) // D3 again while the drone is still sounding
    ];
    const out = conv.convertMidiToTablature(notes, 'lowest_fret');
    const d3s = out.filter((e) => e.midiNote === 50);
    expect(d3s).toHaveLength(2);
    // Before the fix the drone was pruned at 7680 ticks and the 2nd D3 landed
    // on the same physical string — two pitches on one string.
    expect(d3s[0].string).not.toBe(d3s[1].string);
  });
});
