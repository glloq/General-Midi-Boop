// tests/tablature-converter.test.js
// Regression tests: the tablature editor must not silently drop notes.
// Every playable note is emitted; every unplayable one is either clamped
// (and flagged `unplayable`) or counted in `lastConversionStats.dropped`.

import { describe, test, expect } from '@jest/globals';
import TablatureConverter from '../src/midi/adaptation/TablatureConverter.js';

// Standard 6-string guitar (E2 A2 D3 G3 B3 E4), 24 frets.
const guitarConfig = {
  tuning: [40, 45, 50, 55, 59, 64],
  num_strings: 6,
  num_frets: 24,
  is_fretless: false,
  capo_fret: 0,
  tab_algorithm: 'min_movement'
};

const note = (t, n, g = 240, v = 80, c = 0) => ({ t, n, g, v, c });

describe('TablatureConverter — no silent drops', () => {
  for (const algo of ['min_movement', 'lowest_fret', 'highest_fret', 'zone']) {
    test(`${algo}: note below lowest string is clamped, not dropped`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // MIDI 20 is far below E2 (40) — not playable anywhere.
      const out = conv.convertMidiToTablature([note(0, 20)], algo);
      expect(out).toHaveLength(1);
      expect(out[0].unplayable).toBe(true);
      expect(out[0].midiNote).toBe(20);
    });

    test(`${algo}: note above max fret is clamped, not dropped`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // MIDI 100 > E4 + 24 frets (88) — out of range on every string.
      const out = conv.convertMidiToTablature([note(0, 100)], algo);
      expect(out).toHaveLength(1);
      expect(out[0].unplayable).toBe(true);
      expect(out[0].midiNote).toBe(100);
    });

    test(`${algo}: normal notes are not flagged unplayable`, () => {
      const conv = new TablatureConverter(guitarConfig);
      const out = conv.convertMidiToTablature([note(0, 64), note(480, 67)], algo);
      expect(out).toHaveLength(2);
      expect(out[0].unplayable).toBeUndefined();
      expect(out[1].unplayable).toBeUndefined();
    });

    test(`${algo}: 6-note chord on 6-string guitar emits 6 events`, () => {
      const conv = new TablatureConverter(guitarConfig);
      // E minor open chord voicing — all playable simultaneously.
      const chord = [40, 47, 52, 55, 59, 64].map(n => note(0, n));
      const out = conv.convertMidiToTablature(chord, algo);
      // Every note emitted; all on distinct strings
      expect(out).toHaveLength(6);
      const strings = new Set(out.map(e => e.string));
      expect(strings.size).toBe(6);
    });
  }
});

describe('TablatureConverter — stats surface dropped notes', () => {
  test('7-note chord on 6-string guitar drops exactly one', () => {
    const conv = new TablatureConverter(guitarConfig);
    // 7 simultaneous notes — each playable alone, but only 6 strings.
    const chord = [40, 45, 50, 55, 59, 64, 67].map(n => note(0, n));
    const out = conv.convertMidiToTablature(chord);
    expect(conv.lastConversionStats.dropped).toBe(1);
    // Total accounted for: emitted + dropped == input
    expect(out.length + conv.lastConversionStats.dropped).toBe(chord.length);
  });

  test('lastConversionStats is reset per call', () => {
    const conv = new TablatureConverter(guitarConfig);
    // First run: forces a drop
    conv.convertMidiToTablature([40, 45, 50, 55, 59, 64, 67].map(n => note(0, n)));
    expect(conv.lastConversionStats.dropped).toBe(1);
    // Second run with no conflict: stats reset
    conv.convertMidiToTablature([note(0, 64)]);
    expect(conv.lastConversionStats.dropped).toBe(0);
  });
});

describe('TablatureConverter — mixed sequences preserve count', () => {
  test('mixing in-range and out-of-range notes yields input length', () => {
    const conv = new TablatureConverter(guitarConfig);
    const notes = [
      note(0, 20),   // out of range (below) — clamped
      note(240, 64), // playable
      note(480, 100) // out of range (above) — clamped
    ];
    const out = conv.convertMidiToTablature(notes);
    expect(out).toHaveLength(3);
    expect(out.filter(e => e.unplayable).length).toBe(2);
  });
});

describe('TablatureConverter — dedupes simultaneous duplicate pitches', () => {
  test('doubled 4-note chord (8 events) collapses to 4 tab events', () => {
    const conv = new TablatureConverter(guitarConfig);
    // MIDI files often layer the same notes across multiple tracks on the
    // same channel; without dedup the converter would spread the doubles
    // onto extra strings and invent notes the composer never wrote.
    const chord = [52, 55, 59, 64];
    const doubled = [...chord, ...chord].map(n => note(0, n));
    const out = conv.convertMidiToTablature(doubled);
    expect(out).toHaveLength(4);
    const uniquePitches = new Set(out.map(e => e.midiNote));
    expect(uniquePitches.size).toBe(4);
  });

  test('duplicate pitch on different channels is kept separate', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([
      note(0, 64, 240, 80, 0),
      note(0, 64, 240, 80, 1)
    ]);
    expect(out).toHaveLength(2);
  });

  test('duplicate pitch at different ticks is kept separate', () => {
    const conv = new TablatureConverter(guitarConfig);
    const out = conv.convertMidiToTablature([
      note(0, 64),
      note(240, 64)
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('TablatureConverter — _getClampedPosition', () => {
  test('picks lowest string for sub-range note', () => {
    const conv = new TablatureConverter(guitarConfig);
    const clamp = conv._getClampedPosition(20, new Set());
    expect(clamp).not.toBeNull();
    expect(clamp.string).toBe(1); // Low E string
    expect(clamp.fret).toBe(0);   // Clamped to open
    expect(clamp.unplayable).toBe(true);
  });

  test('picks highest string for above-range note', () => {
    const conv = new TablatureConverter(guitarConfig);
    const clamp = conv._getClampedPosition(100, new Set());
    expect(clamp).not.toBeNull();
    expect(clamp.string).toBe(6); // High E string
    expect(clamp.fret).toBe(24);  // Clamped to max fret
    expect(clamp.unplayable).toBe(true);
  });

  test('returns null when every string is occupied', () => {
    const conv = new TablatureConverter(guitarConfig);
    const occupied = new Set([1, 2, 3, 4, 5, 6]);
    expect(conv._getClampedPosition(20, occupied)).toBeNull();
  });
});
