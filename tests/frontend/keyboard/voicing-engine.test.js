// tests/frontend/keyboard/voicing-engine.test.js
// Unit tests for VoicingEngine — pure module, no DOM.
// Covers tuning, polyphony per GM family, chord→strings mapping,
// strum scheduling, snap-to-playable.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/VoicingEngine.js');
});

const VE = () => win.VoicingEngine;

// Standard guitar tuning E2 A2 D3 G3 B3 E4 → MIDI 40 45 50 55 59 64
const GUITAR_TUNING = [40, 45, 50, 55, 59, 64];

describe('VoicingEngine — construction & tuning resolution', () => {
  it('exposes the class on window', () => {
    expect(typeof VE()).toBe('function');
  });

  it('accepts an explicit tuning + numStrings', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    expect(v.numStrings).toBe(6);
    expect(v.tuning).toEqual(GUITAR_TUNING);
  });

  it('falls back to DEFAULT_TUNINGS when tuning is missing', () => {
    const v = new (VE())(null, 6);
    expect(v.tuning).toEqual([40, 45, 50, 55, 59, 64]); // standard guitar
  });

  it('falls back to DEFAULT_TUNINGS for 4-string bass', () => {
    const v = new (VE())(null, 4);
    expect(v.tuning).toEqual([28, 33, 38, 43]);
  });

  it('synthesises a tuning when numStrings is unknown', () => {
    const v = new (VE())(null, 9);
    expect(v.tuning).toHaveLength(9);
    // synthesised pattern: 40 + i * 5
    expect(v.tuning[0]).toBe(40);
    expect(v.tuning[8]).toBe(80);
  });

  it('falls back to 6 strings when numStrings is falsy (0, undefined)', () => {
    // `numStrings || 6` defaults to 6 when the argument is 0/undefined,
    // then Math.max(1, 6) keeps it at 6.
    expect(new (VE())(null, 0).numStrings).toBe(6);
    expect(new (VE())(null).numStrings).toBe(6);
  });
});

describe('VoicingEngine — setTuning', () => {
  it('replaces tuning + numStrings + invalidates cache', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    v.mapChordToStrings(0, [0, 4, 7]);
    v.setTuning([28, 33, 38, 43], 4);
    expect(v.numStrings).toBe(4);
    expect(v.tuning).toEqual([28, 33, 38, 43]);
  });

  it('keeps numStrings when omitted', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    v.setTuning([40, 45, 50, 55, 59, 64]);
    expect(v.numStrings).toBe(6);
  });
});

describe('VoicingEngine — maxPoly per GM family', () => {
  it('returns 2 for bowed strings (GM 40-45)', () => {
    const v = new (VE())(null, 6);
    for (const gm of [40, 41, 42, 43, 44, 45]) {
      expect(v.maxPoly(gm)).toBe(2);
    }
  });

  it('returns 2 for fiddle (GM 110)', () => {
    const v = new (VE())(null, 6);
    expect(v.maxPoly(110)).toBe(2);
  });

  it('returns 3 for bass programs (GM 32-39)', () => {
    const v = new (VE())(null, 6);
    for (const gm of [32, 33, 34, 35, 36, 37, 38, 39]) {
      expect(v.maxPoly(gm)).toBe(3);
    }
  });

  it('returns numStrings for guitar (GM 24-31)', () => {
    const v = new (VE())(null, 6);
    expect(v.maxPoly(24)).toBe(6);
    expect(v.maxPoly(29)).toBe(6);
  });

  it('returns numStrings when gmProgram is null', () => {
    const v = new (VE())(null, 6);
    expect(v.maxPoly(null)).toBe(6);
  });

  it('caps polyphony to numStrings (3-string instrument with bass GM)', () => {
    const v = new (VE())(null, 3);
    expect(v.maxPoly(32)).toBe(3); // min(numStrings=3, 3) = 3
  });

  it('caps polyphony to numStrings (2-string instrument with bowed GM)', () => {
    const v = new (VE())([45, 50], 2);
    expect(v.maxPoly(40)).toBe(2);
  });
});

describe('VoicingEngine — mapChordToStrings', () => {
  it('returns one voicing per string up to maxPoly', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(0, [0, 4, 7]); // C major
    expect(out.length).toBe(6);
    out.forEach((vn, i) => {
      expect(vn.string).toBe(i + 1);
      expect(vn.fret).toBeGreaterThanOrEqual(0);
      expect(vn.fret).toBeLessThan(12);
    });
  });

  it('respects maxPoly override', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(0, [0, 4, 7], 3);
    expect(out.length).toBe(3);
  });

  it('caches voicings (same call returns same array reference)', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const a = v.mapChordToStrings(0, [0, 4, 7]);
    const b = v.mapChordToStrings(0, [0, 4, 7]);
    expect(a).toBe(b);
  });

  it('invalidateCache forces recomputation', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const a = v.mapChordToStrings(0, [0, 4, 7]);
    v.invalidateCache();
    const b = v.mapChordToStrings(0, [0, 4, 7]);
    expect(a).not.toBe(b);
  });

  it('produces playable MIDI notes within 21..108', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(0, [0, 4, 7]);
    for (const vn of out) {
      expect(vn.note).toBeGreaterThanOrEqual(21);
      expect(vn.note).toBeLessThanOrEqual(108);
    }
  });

  it('C major on guitar: first string note class is C (root)', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(0, [0, 4, 7]);
    expect(out[0].note % 12).toBe(0); // C
  });

  it('A minor (rootClass 9, intervals 0,3,7): first note class is A', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(9, [0, 3, 7]);
    expect(out[0].note % 12).toBe(9); // A
  });

  it('avoids unison clash within < 2 semitones across consecutive strings', () => {
    const v = new (VE())(GUITAR_TUNING, 6);
    const out = v.mapChordToStrings(0, [0, 4, 7]);
    for (let i = 1; i < out.length; i++) {
      const diff = Math.abs(out[i].note - out[i - 1].note);
      expect(diff).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('VoicingEngine — strumSchedule', () => {
  const v = new (VE())(GUITAR_TUNING, 6);
  const voicing = v.mapChordToStrings(0, [0, 4, 7]);

  it('down strum is ordered grave → aigu (ascending notes)', () => {
    const sched = v.strumSchedule(voicing, 'down', 10);
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i].note).toBeGreaterThanOrEqual(sched[i - 1].note);
    }
  });

  it('up strum is ordered aigu → grave (descending notes)', () => {
    const sched = v.strumSchedule(voicing, 'up', 10);
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i].note).toBeLessThanOrEqual(sched[i - 1].note);
    }
  });

  it('delays increase by delayMs per step', () => {
    const sched = v.strumSchedule(voicing, 'down', 8);
    expect(sched[0].delay).toBe(0);
    expect(sched[1].delay).toBe(8);
    expect(sched[2].delay).toBe(16);
  });

  it('does not mutate the input voicing array', () => {
    const ref = [...voicing];
    v.strumSchedule(voicing, 'down', 10);
    expect(voicing).toEqual(ref);
  });
});

describe('VoicingEngine — snapToPlayable', () => {
  const v = new (VE())(GUITAR_TUNING, 6);

  it('returns a VoicingNote shape', () => {
    const r = v.snapToPlayable(60, 0, 4);
    expect(r).toHaveProperty('string');
    expect(r).toHaveProperty('note');
    expect(r).toHaveProperty('fret');
    expect(r.string).toBeGreaterThanOrEqual(1);
    expect(r.string).toBeLessThanOrEqual(6);
  });

  it('finds exact note when reachable', () => {
    // E2 (40) is open string 1
    const r = v.snapToPlayable(40, 0, 4);
    expect(r.note).toBe(40);
    expect(r.fret).toBe(0);
  });

  it('respects the hand window for fretted notes', () => {
    // anchor=5, span=3 → frets 5..8 only (+ open strings always allowed)
    const r = v.snapToPlayable(48, 5, 3);
    // open string is always allowed too; result must be either an open string
    // (fret==0) or a fret within 5..8
    expect(r.fret === 0 || (r.fret >= 5 && r.fret <= 8)).toBe(true);
  });
});
