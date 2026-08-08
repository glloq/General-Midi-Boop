// tests/scoring-edge-cases-t6.test.js
// Low-severity correctness fixes from the adaptation/scoring audit (T6):
//   T6.1 primaryProgram tie-break, T6.2 overlapping hysteresis bands,
//   T6.5 exotic (unrecognized) drum channel scoring.

import { describe, test, expect } from '@jest/globals';
import ChannelAnalyzer from '../src/midi/routing/ChannelAnalyzer.js';
import HandAssigner from '../src/midi/adaptation/HandAssigner.js';
import DrumNoteMapper from '../src/midi/adaptation/DrumNoteMapper.js';

const noopLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

describe('T6.1 — getPrimaryProgram tie-break', () => {
  const ca = new ChannelAnalyzer(noopLogger);

  test('most frequent program wins', () => {
    expect(ca.getPrimaryProgram([48, 48, 48, 0])).toBe(48);
  });

  test('on a count tie, the LATER program in the stream wins (not the lowest number)', () => {
    // piano(0) then strings(48), one PC each → tie. The channel settled on 48.
    expect(ca.getPrimaryProgram([0, 48])).toBe(48);
    // Order matters: settled on 0 → 0 wins.
    expect(ca.getPrimaryProgram([48, 0])).toBe(0);
  });

  test('empty program list → null', () => {
    expect(ca.getPrimaryProgram([])).toBeNull();
  });
});

describe('T6.2 — overlapping hysteresis bands resolve to the nearest boundary', () => {
  function makeAssigner() {
    const a = new HandAssigner({
      hands: [{ id: 'low' }, { id: 'mid' }, { id: 'high' }]
    });
    // Force overlapping bands: splits 60 and 63 with band 3 overlap on [60,63).
    a.splitNotes = [60, 63];
    a.handIds = ['low', 'mid', 'high'];
    a.hysteresis = 3;
    return a;
  }

  test('a note inside two bands picks the nearest boundary (deterministic)', () => {
    const a = makeAssigner();
    // 62 ∈ band(60)=[57,63) and band(63)=[60,66). Nearest is 63 (dist 1 < 2).
    // The old first-match loop reported boundary 60.
    expect(a._handForPitchVerbose(62, null).boundary).toBe(63);
    // 61 is nearer to 60 (dist 1 < 2) → boundary 60.
    expect(a._handForPitchVerbose(61, null).boundary).toBe(60);
  });

  test('non-overlapping bands are unchanged', () => {
    const a = makeAssigner();
    a.splitNotes = [40, 80];
    a.hysteresis = 2;
    expect(a._handForPitchVerbose(41, null).boundary).toBe(40);
    expect(a._handForPitchVerbose(79, null).boundary).toBe(80);
  });
});

describe('T6.5 — drum mapping quality for content-free / exotic channels', () => {
  const mapper = new DrumNoteMapper(noopLogger);
  const emptyCats = {
    kicks: [], snares: [], hiHats: [], toms: [], crashes: [], rides: [],
    latin: [], shakers: [], woodsMetal: [], pitched: [], cuicas: [], triangles: []
  };

  test('a channel with no notes scores 0 (existing P3 guard)', () => {
    const midiNotes = { usedNotes: [], categories: { ...emptyCats } };
    expect(mapper.calculateMappingQuality({}, midiNotes, [], [], []).score).toBe(0);
  });

  // NOTE (audit T6.5): an "exotic non-empty" channel (notes present but none
  // recognized) is unreachable in production — classifyDrumNotes only records
  // notes in [35,81], which DRUM_CATEGORIES partitions completely, so a
  // non-empty channel always has recognized notes. The empty-channel guard
  // above is the only content-free case. Verify that invariant here:
  test('DRUM_CATEGORIES fully partitions [35,81] (no exotic-non-empty case)', () => {
    const covered = new Set();
    for (const arr of Object.values(mapper.DRUM_CATEGORIES)) for (const n of arr) covered.add(n);
    for (let n = 35; n <= 81; n++) expect(covered.has(n)).toBe(true);
  });

  test('a channel WITH recognized drums still scores normally (regression)', () => {
    const midiNotes = {
      usedNotes: [36, 38],
      categories: { ...emptyCats, kicks: [36], snares: [38] }
    };
    // Kick→kick, snare→snare exact maps → high essential score.
    const q = mapper.calculateMappingQuality({ 36: 36, 38: 38 }, midiNotes, [36, 38], [], []);
    expect(q.score).toBeGreaterThan(50);
  });
});
