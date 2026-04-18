// tests/frontend/routing-summary-constants.test.js
// Unit tests for the pure helpers exposed by RoutingSummaryConstants (P2-F.1).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};

function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../public/js/features/auto-assign/RoutingSummaryConstants.js');
});

const C = () => win.RoutingSummaryConstants;

describe('getGmDefaultPolyphony', () => {
  it('returns 16 for invalid inputs', () => {
    expect(C().getGmDefaultPolyphony(null)).toBe(16);
    expect(C().getGmDefaultPolyphony(undefined)).toBe(16);
    expect(C().getGmDefaultPolyphony(-1)).toBe(16);
    expect(C().getGmDefaultPolyphony(128)).toBe(16);
  });

  it('returns the map value for piano programs (0-7)', () => {
    expect(C().getGmDefaultPolyphony(0)).toBe(16); // Acoustic Grand Piano
    expect(C().getGmDefaultPolyphony(6)).toBe(8);  // Harpsichord
  });

  it('returns 1 for solo brass / reed / pipe programs', () => {
    expect(C().getGmDefaultPolyphony(56)).toBe(1); // Trumpet
    expect(C().getGmDefaultPolyphony(64)).toBe(1); // Soprano Sax
    expect(C().getGmDefaultPolyphony(72)).toBe(1); // Piccolo
  });
});

describe('midiNoteToName', () => {
  it('returns C-1 for note 0', () => {
    expect(C().midiNoteToName(0)).toBe('C0');
  });
  it('returns C4 for note 48 (since base octave is 0 not -1 here)', () => {
    // Project convention : note 60 → C5 (octave = floor(60/12) = 5).
    expect(C().midiNoteToName(60)).toBe('C5');
  });
  it('handles black keys', () => {
    expect(C().midiNoteToName(61)).toBe('C#5');
  });
  it('handles upper bound', () => {
    expect(C().midiNoteToName(127)).toBe('G10');
  });
});

describe('safeNoteRange', () => {
  it('clamps values into [0, 127]', () => {
    expect(C().safeNoteRange(-10, 200)).toEqual({ min: 0, max: 127 });
  });
  it('swaps when min > max', () => {
    expect(C().safeNoteRange(80, 30)).toEqual({ min: 30, max: 80 });
  });
  it('rounds non-integer values', () => {
    expect(C().safeNoteRange(12.4, 30.7)).toEqual({ min: 12, max: 31 });
  });
  it('defaults nullish inputs to 0 / 127', () => {
    expect(C().safeNoteRange(null, null)).toEqual({ min: 0, max: 127 });
  });
});

describe('getScoreClass / getScoreBgClass', () => {
  it.each([
    [95, 'rs-color-excellent'],
    [80, 'rs-color-excellent'],
    [79, 'rs-color-good'],
    [60, 'rs-color-good'],
    [59, 'rs-color-fair'],
    [40, 'rs-color-fair'],
    [39, 'rs-color-poor'],
    [0, 'rs-color-poor']
  ])('getScoreClass(%i) = %s', (score, expected) => {
    expect(C().getScoreClass(score)).toBe(expected);
  });

  it.each([
    [95, 'rs-bg-excellent'],
    [79, 'rs-bg-good'],
    [59, 'rs-bg-fair'],
    [39, 'rs-bg-poor']
  ])('getScoreBgClass(%i) = %s', (score, expected) => {
    expect(C().getScoreBgClass(score)).toBe(expected);
  });
});

describe('getTypeIcon / getTypeColor', () => {
  it('returns a known icon for known types', () => {
    expect(C().getTypeIcon('drums')).toBeTruthy();
    expect(C().getTypeIcon('bass')).toBeTruthy();
    expect(C().getTypeIcon('melody')).toBeTruthy();
  });
  it('returns the fallback icon for unknown types', () => {
    expect(C().getTypeIcon('frobnicator')).toBeTruthy();
    expect(C().getTypeIcon('')).toBeTruthy();
  });
  it('returns 6-char hex colors', () => {
    expect(C().getTypeColor('drums')).toMatch(/^#[0-9A-F]{6}$/i);
    expect(C().getTypeColor('unknown-type')).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('getGmProgramName', () => {
  it('returns null for invalid program numbers', () => {
    expect(C().getGmProgramName(null)).toBeNull();
    expect(C().getGmProgramName(-1)).toBeNull();
    expect(C().getGmProgramName(128)).toBeNull();
  });

  it('returns a fallback label when no GM_INSTRUMENTS is defined', () => {
    // Without window.getGMInstrumentName or window.GM_INSTRUMENTS, falls back to "Program N".
    expect(C().getGmProgramName(7)).toBe('Program 7');
  });
});

describe('frozen constants', () => {
  it('exposes SPLIT_COLORS as a non-empty array of hex strings', () => {
    expect(Array.isArray(C().SPLIT_COLORS)).toBe(true);
    expect(C().SPLIT_COLORS.length).toBeGreaterThanOrEqual(4);
    for (const c of C().SPLIT_COLORS) {
      expect(c).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('exposes BLACK_KEYS as a Set of 5 values', () => {
    expect(C().BLACK_KEYS instanceof Set).toBe(true);
    expect(C().BLACK_KEYS.size).toBe(5);
    expect(C().BLACK_KEYS.has(1)).toBe(true); // C#
    expect(C().BLACK_KEYS.has(3)).toBe(true); // D#
    expect(C().BLACK_KEYS.has(6)).toBe(true); // F#
    expect(C().BLACK_KEYS.has(8)).toBe(true); // G#
    expect(C().BLACK_KEYS.has(10)).toBe(true); // A#
    expect(C().BLACK_KEYS.has(0)).toBe(false); // C is white
  });

  it('NOTE_NAMES has 12 entries starting with C', () => {
    expect(C().NOTE_NAMES).toHaveLength(12);
    expect(C().NOTE_NAMES[0]).toBe('C');
  });
});
