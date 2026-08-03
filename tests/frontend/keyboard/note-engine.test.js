// tests/frontend/keyboard/note-engine.test.js
// Unit tests for NoteEngine — pure module, no DOM.
// Covers scales, range, ratio mapping, snapping, naming.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/NoteEngine.js');
});

const NE = () => win.NoteEngine;

describe('NoteEngine — defaults', () => {
  it('exposes the class on window', () => {
    expect(typeof NE()).toBe('function');
  });

  it('initialises with chromatic root=0 and range C2..C6', () => {
    const e = new (NE())();
    expect(e.root).toBe(0);
    expect(e.type).toBe('chromatic');
    expect(e.minNote).toBe(36);
    expect(e.maxNote).toBe(84);
  });

  it('SCALE_TYPES lists the supported scales', () => {
    const types = NE().SCALE_TYPES;
    expect(types).toContain('chromatic');
    expect(types).toContain('major');
    expect(types).toContain('minor');
    expect(types).toContain('pentatonic');
    expect(types).toContain('blues');
  });
});

describe('NoteEngine — setScale', () => {
  it('normalises root modulo 12', () => {
    const e = new (NE())();
    e.setScale(14, 'major');
    expect(e.root).toBe(2);
  });

  it('normalises negative roots', () => {
    const e = new (NE())();
    e.setScale(-1, 'major');
    expect(e.root).toBe(11);
  });

  it('falls back to chromatic on unknown type', () => {
    const e = new (NE())();
    e.setScale(0, 'lydian-mode-that-does-not-exist');
    expect(e.type).toBe('chromatic');
  });

  it('invalidates the scale cache when scale changes', () => {
    const e = new (NE())();
    const before = e.getScaleNotes();
    e.setScale(0, 'major');
    const after = e.getScaleNotes();
    expect(after).not.toBe(before);
  });
});

describe('NoteEngine — setRange', () => {
  it('clamps to MIDI 0..127', () => {
    const e = new (NE())();
    e.setRange(-50, 200);
    expect(e.minNote).toBe(0);
    expect(e.maxNote).toBe(127);
  });

  it('rounds floats to integer', () => {
    const e = new (NE())();
    e.setRange(36.7, 84.3);
    expect(e.minNote).toBe(37);
    expect(e.maxNote).toBe(84);
  });
});

describe('NoteEngine — getScaleNotes', () => {
  it('chromatic returns every semitone in range', () => {
    const e = new (NE())();
    e.setRange(60, 71);
    e.setScale(0, 'chromatic');
    expect(e.getScaleNotes()).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
  });

  it('C major returns the 7 diatonic degrees per octave', () => {
    const e = new (NE())();
    e.setRange(60, 72); // C4..C5
    e.setScale(0, 'major');
    expect(e.getScaleNotes()).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('A minor returns A B C D E F G', () => {
    const e = new (NE())();
    e.setRange(57, 69); // A3..A4
    e.setScale(9, 'minor');
    expect(e.getScaleNotes()).toEqual([57, 59, 60, 62, 64, 65, 67, 69]);
  });

  it('pentatonic returns 5 notes per octave', () => {
    const e = new (NE())();
    e.setRange(60, 72); // C4..C5
    e.setScale(0, 'pentatonic');
    expect(e.getScaleNotes()).toEqual([60, 62, 64, 67, 69, 72]);
  });

  it('blues returns 6 notes per octave', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    e.setScale(0, 'blues');
    expect(e.getScaleNotes()).toEqual([60, 63, 65, 66, 67, 70, 72]);
  });
});

describe('NoteEngine — noteFromRatio', () => {
  it('returns minNote at ratio 0', () => {
    const e = new (NE())();
    e.setRange(36, 84);
    expect(e.noteFromRatio(0)).toBe(36);
  });

  it('returns maxNote at ratio 1 (chromatic full octave)', () => {
    const e = new (NE())();
    e.setRange(36, 84);
    expect(e.noteFromRatio(1)).toBe(84);
  });

  it('clamps out-of-range ratios', () => {
    const e = new (NE())();
    e.setRange(60, 71);
    expect(e.noteFromRatio(-0.5)).toBe(60);
    expect(e.noteFromRatio(1.5)).toBe(71);
  });

  it('snaps to scale degrees', () => {
    const e = new (NE())();
    e.setRange(60, 71);
    e.setScale(0, 'major');
    // 7 + 1 = 8 notes : indices 0..7 → C, D, E, F, G, A, B, C
    expect(e.noteFromRatio(0)).toBe(60); // C4
    expect(e.noteFromRatio(0.5)).toBe(65); // F4 (idx 3 of 0..7)
  });
});

describe('NoteEngine — noteFromRatioContinuous', () => {
  it('interpolates linearly between scale degrees', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    e.setScale(0, 'major');
    // halfway between C4(60) and D4(62) = 61.0
    const notes = e.getScaleNotes(); // [60, 62, 64, 65, 67, 69, 71, 72]
    // ratio that targets fIdx=0.5 → 1 / (notes.length-1) * 0.5 = 0.5/7
    const ratio = 0.5 / (notes.length - 1);
    expect(e.noteFromRatioContinuous(ratio)).toBeCloseTo(61, 5);
  });

  it('returns endpoints at 0 and 1', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    expect(e.noteFromRatioContinuous(0)).toBe(60);
    expect(e.noteFromRatioContinuous(1)).toBe(72);
  });
});

describe('NoteEngine — snapToScale', () => {
  it('returns the input if already in scale', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    e.setScale(0, 'major');
    expect(e.snapToScale(64)).toBe(64); // E4 is in C major
  });

  it('snaps chromatic note to nearest scale degree', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    e.setScale(0, 'major');
    expect(e.snapToScale(61)).toBe(60); // C# → C4 (or D, depends on tie)
    expect(e.snapToScale(66)).toBe(65); // F# → F4 (or G, depends on tie)
  });
});

describe('NoteEngine — noteName', () => {
  it('english labels with octave', () => {
    const e = new (NE())();
    expect(e.noteName(60, 'english')).toBe('C4');
    expect(e.noteName(69, 'english')).toBe('A4');
    expect(e.noteName(21, 'english')).toBe('A0');
  });

  it('solfege labels (FR)', () => {
    const e = new (NE())();
    expect(e.noteName(60, 'solfege')).toBe('Do4');
    expect(e.noteName(69, 'solfege')).toBe('La4');
    expect(e.noteName(67, 'solfege')).toBe('Sol4');
  });

  it('midi labels just stringify the number', () => {
    const e = new (NE())();
    expect(e.noteName(60, 'midi')).toBe('60');
    expect(e.noteName(0, 'midi')).toBe('0');
  });
});

describe('NoteEngine — noteClass', () => {
  it('returns 0..11 from MIDI note', () => {
    const e = new (NE())();
    expect(e.noteClass(60)).toBe(0); // C
    expect(e.noteClass(61)).toBe(1); // C#
    expect(e.noteClass(71)).toBe(11); // B
    expect(e.noteClass(72)).toBe(0); // C again
  });
});

describe('NoteEngine — cache behaviour', () => {
  it('returns the same array reference until invalidation', () => {
    const e = new (NE())();
    e.setRange(60, 72);
    e.setScale(0, 'major');
    const a = e.getScaleNotes();
    const b = e.getScaleNotes();
    expect(a).toBe(b);
  });

  it('rebuilds after setRange', () => {
    const e = new (NE())();
    const a = e.getScaleNotes();
    e.setRange(60, 72);
    const b = e.getScaleNotes();
    expect(a).not.toBe(b);
  });
});
