// tests/frontend/instrument-note-presets.test.js
// Behaviour of the capability-derived note presets: shape compatibility with
// ISMListeners._wireNotePresetListener, family exclusions, and the
// monophonic → no "chords" preset rule.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
function load(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

beforeAll(() => {
  // Order matters only for window registration, not behaviour (lazy access).
  new Function(load('public/js/features/instrument-settings/InstrumentFamilies.js'))();
  new Function(load('public/js/features/GmInstrumentCapabilities.js'))();
  new Function(load('public/js/features/instrument-settings/InstrumentNotePresets.js'))();
});

const SHAPE = [
  'id', 'label', 'note_selection_mode', 'octave_mode',
  'note_range_min', 'note_range_max', 'polyphony',
];

describe('InstrumentNotePresets.getPresets', () => {
  it('returns [] for drums (channel 9)', () => {
    expect(window.InstrumentNotePresets.getPresets(0, 9)).toEqual([]);
  });

  it('returns [] for synths', () => {
    // GM 88 = Pad 1 (new age) → family "synths"
    expect(window.InstrumentNotePresets.getPresets(88, 0)).toEqual([]);
  });

  it('returns [] when gmProgram is null', () => {
    expect(window.InstrumentNotePresets.getPresets(null, 0)).toEqual([]);
  });

  it('piano (polyphonic) yields full/comfort/melody/chords', () => {
    const ids = window.InstrumentNotePresets.getPresets(0, 0).map((p) => p.id);
    expect(ids).toContain('cap_full');
    expect(ids).toContain('cap_comfort');
    expect(ids).toContain('cap_melody');
    expect(ids).toContain('cap_chords');
  });

  it('flute (monophonic) has no chords preset', () => {
    const ids = window.InstrumentNotePresets.getPresets(73, 0).map((p) => p.id);
    expect(ids).toContain('cap_full');
    expect(ids).not.toContain('cap_chords');
  });

  it('every preset has exactly the keys the listener consumes', () => {
    const presets = window.InstrumentNotePresets.getPresets(0, 0);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(Object.keys(p).sort()).toEqual([...SHAPE].sort());
      expect(p.note_selection_mode).toBe('range');
      expect(p.octave_mode).toBe('chromatic');
      expect(p.note_range_min).toBeLessThanOrEqual(p.note_range_max);
      expect(p.polyphony).toBeGreaterThanOrEqual(1);
    }
  });
});
