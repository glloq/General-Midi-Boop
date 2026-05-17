// tests/frontend/chord-library.test.js
// Unit tests for the chord-theory helper used by the Notes & Capacités
// chord picker: chord definitions and buildChordNotes() pitch-class fill.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/ChordLibrary.js'),
  'utf8'
);

beforeAll(() => {
  new Function(source)(); // registers window.ChordLibrary
});

describe('ChordLibrary', () => {
  it('exposes the triads + 7ths set with exact intervals', () => {
    const byId = Object.fromEntries(
      window.ChordLibrary.CHORDS.map((c) => [c.id, c.intervals])
    );
    expect(byId).toEqual({
      major: [0, 4, 7],
      minor: [0, 3, 7],
      dim: [0, 3, 6],
      aug: [0, 4, 8],
      sus4: [0, 5, 7],
      dom7: [0, 4, 7, 10],
      maj7: [0, 4, 7, 11],
      min7: [0, 3, 7, 10],
    });
    expect(window.ChordLibrary.ROOTS.map((r) => r.pc)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
  });

  it('builds C major across one octave', () => {
    // C4=60, E4=64, G4=67, C5=72
    expect(window.ChordLibrary.buildChordNotes(0, 'major', 60, 72)).toEqual([
      60, 64, 67, 72,
    ]);
  });

  it('builds A minor 7 across a range (all A,C,E,G)', () => {
    const notes = window.ChordLibrary.buildChordNotes(9, 'min7', 45, 69);
    // pitch classes for A min7 = A(9) C(0) E(4) G(7)
    for (const n of notes) expect([9, 0, 4, 7]).toContain(n % 12);
    // sorted, unique, within range
    const sorted = [...notes].sort((a, b) => a - b);
    expect(notes).toEqual(sorted);
    expect(new Set(notes).size).toBe(notes.length);
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...notes)).toBeLessThanOrEqual(69);
  });

  it('returns [] on invalid input', () => {
    expect(window.ChordLibrary.buildChordNotes(12, 'major', 0, 127)).toEqual([]);
    expect(window.ChordLibrary.buildChordNotes(-1, 'major', 0, 127)).toEqual([]);
    expect(window.ChordLibrary.buildChordNotes(0, 'nope', 0, 127)).toEqual([]);
    expect(window.ChordLibrary.buildChordNotes(0, 'major', 80, 60)).toEqual([]);
  });

  it('clamps the range to 0-127', () => {
    const notes = window.ChordLibrary.buildChordNotes(0, 'major', -10, 200);
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...notes)).toBeLessThanOrEqual(127);
  });

  it('rootLabel falls back to US names without the piano global', () => {
    expect(window.ChordLibrary.rootLabel(0)).toBe('C');
    expect(window.ChordLibrary.rootLabel(9)).toBe('A');
  });
});
