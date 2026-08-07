// tests/note-enforcement.test.js
// Stateless note clamping shared by the playback engine and the live router:
// fold into range, then snap to the playable set (explicit selected_notes, else
// the octave_mode/scale_root scale). Pure — no DB / MIDI stack.

import { describe, test, expect } from '@jest/globals';
import {
  foldIntoRange,
  snapToNearest,
  clampNote,
  selectPolyphonyVictim
} from '../src/midi/adaptation/NoteEnforcement.js';

describe('foldIntoRange', () => {
  test('folds too-high / too-low by octaves, preserving pitch class', () => {
    expect(foldIntoRange(84, 60, 72)).toBe(72); // C6 → C5
    expect(foldIntoRange(48, 60, 72)).toBe(60); // C3 → C4
  });
  test('leaves in-range notes untouched', () => {
    expect(foldIntoRange(65, 60, 72)).toBe(65);
  });
  test('clamps when the range is narrower than an octave', () => {
    const n = foldIntoRange(70, 60, 64);
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(64);
  });
  test('no declared range → unchanged', () => {
    expect(foldIntoRange(200, null, null)).toBe(200);
  });
});

describe('snapToNearest', () => {
  test('snaps to the nearest, ties break downward', () => {
    expect(snapToNearest(63, [60, 64, 67])).toBe(64);
    expect(snapToNearest(62, [60, 64])).toBe(60); // equidistant → down
  });
  test('empty list → unchanged', () => {
    expect(snapToNearest(62, [])).toBe(62);
  });
});

describe('clampNote', () => {
  test('fold then snap to explicit selected_notes', () => {
    expect(clampNote(85, { noteRangeMin: 60, noteRangeMax: 72, selectedNotes: [60, 64, 67] })).toBe(
      60
    ); // 85 → fold 61 → nearest of set → 60
  });
  test('fold then snap to the diatonic scale when no selected_notes', () => {
    expect(
      clampNote(61, { noteRangeMin: 60, noteRangeMax: 72, octaveMode: 'diatonic', scaleRoot: 0 })
    ).toBe(60);
  });
  test('explicit selected_notes take priority over octave_mode', () => {
    expect(
      clampNote(61, {
        noteRangeMin: 60,
        noteRangeMax: 72,
        octaveMode: 'diatonic',
        scaleRoot: 0,
        selectedNotes: [66]
      })
    ).toBe(66);
  });
  test('chromatic / no-range / empty constraints are no-ops', () => {
    expect(clampNote(61, { noteRangeMin: 60, noteRangeMax: 72, octaveMode: 'chromatic' })).toBe(61);
    expect(clampNote(61, { octaveMode: 'diatonic', scaleRoot: 0 })).toBe(61); // no range
    expect(clampNote(61, {})).toBe(61);
    expect(clampNote(61)).toBe(61);
  });
  test('selected_notes entirely outside the range do not escape it (P3-d)', () => {
    // Inconsistent config: the only declared playable note (84) sits above
    // max 72. The result must stay inside [60,72] instead of snapping out to 84.
    const n = clampNote(61, { noteRangeMin: 60, noteRangeMax: 72, selectedNotes: [84] });
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(72);
  });
  test('snaps only to in-range selected_notes, ignoring out-of-range entries (P3-d)', () => {
    // selected_notes = [66 (in range), 84 (out of range)]. 79 folds to 67 and
    // must snap to 66, never to the out-of-range 84.
    expect(clampNote(79, { noteRangeMin: 60, noteRangeMax: 72, selectedNotes: [66, 84] })).toBe(66);
  });
});

describe('selectPolyphonyVictim', () => {
  test('drops the median voice, keeping the outer pair (matches offline)', () => {
    expect(selectPolyphonyVictim([60, 72, 67])).toBe(67); // sorted 60,67,72 -> idx1
    expect(selectPolyphonyVictim([48, 60, 72, 84])).toBe(72); // sorted -> idx2
  });
  test('single element returns itself; empty returns null', () => {
    expect(selectPolyphonyVictim([64])).toBe(64);
    expect(selectPolyphonyVictim([])).toBeNull();
    expect(selectPolyphonyVictim(null)).toBeNull();
  });
});
