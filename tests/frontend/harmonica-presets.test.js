// tests/frontend/harmonica-presets.test.js
// Harmonica-specific instrument presets: shape compatibility with
// ISMListeners._wireNotePresetListener, GM 22 delegation from
// InstrumentNotePresets, and — crucially — that each preset's note range
// resolves (via HarmonicaLayout, the production layout module) to exactly
// the advertised number of holes with the right tuning.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
const load = (rel) => readFileSync(resolve(root, rel), 'utf8');

beforeAll(() => {
  new Function(load('public/js/features/instrument-settings/InstrumentFamilies.js'))();
  new Function(load('public/js/features/GmInstrumentCapabilities.js'))();
  new Function(load('public/js/features/keyboard/HarmonicaLayout.js'))();
  new Function(load('public/js/features/instrument-settings/HarmonicaPresets.js'))();
  new Function(load('public/js/features/instrument-settings/InstrumentNotePresets.js'))();
});

const SHAPE = [
  'id', 'label', 'note_selection_mode', 'octave_mode',
  'note_range_min', 'note_range_max', 'polyphony', 'harmonica_config',
];
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

describe('HarmonicaPresets.getPresets', () => {
  it('lists the 8 common diatonic keys + 2 chromatic presets', () => {
    const presets = window.HarmonicaPresets.getPresets();
    expect(presets.length).toBe(10);
    const ids = presets.map((p) => p.id);
    expect(ids).toEqual([
      'harmo_diatonic_c', 'harmo_diatonic_g', 'harmo_diatonic_a',
      'harmo_diatonic_d', 'harmo_diatonic_f', 'harmo_diatonic_as',
      'harmo_diatonic_e', 'harmo_diatonic_ds',
      'harmo_chromatic_c_12', 'harmo_chromatic_c_16',
    ]);
  });

  it('every preset has exactly the keys the listener consumes', () => {
    for (const p of window.HarmonicaPresets.getPresets()) {
      expect(Object.keys(p).sort()).toEqual([...SHAPE].sort());
      expect(p.note_selection_mode).toBe('range');
      expect(p.octave_mode).toBe('chromatic');
      expect(p.polyphony).toBe(1); // harmonica is monophonic
      expect(p.note_range_min).toBeLessThanOrEqual(p.note_range_max);
      expect(['diatonic', 'chromatic']).toContain(p.harmonica_config.type);
    }
  });

  it('GM 22 delegates to harmonica presets (replaces generic ones)', () => {
    const ids = window.InstrumentNotePresets.getPresets(22, 0).map((p) => p.id);
    expect(ids).toContain('harmo_diatonic_c');
    expect(ids).not.toContain('cap_full'); // generic presets replaced
  });

  it('a non-harmonica instrument still gets the generic presets', () => {
    const ids = window.InstrumentNotePresets.getPresets(0, 0).map((p) => p.id);
    expect(ids).toContain('cap_full');
    expect(ids.some((id) => id.startsWith('harmo_'))).toBe(false);
  });
});

describe('HarmonicaPresets — ranges resolve to the right layout', () => {
  const layoutOf = (p) => window.HarmonicaLayout.computeLayout(
    p.harmonica_config,
    { min: p.note_range_min, max: p.note_range_max, notes: null });

  it('every diatonic preset → exactly 10 holes, starting at its low note', () => {
    for (const p of window.HarmonicaPresets.getPresets()
      .filter((x) => x.harmonica_config.type === 'diatonic')) {
      const { blow, draw } = layoutOf(p);
      expect(blow.length).toBe(10);
      expect(draw.length).toBe(10);
      expect(blow[0]).toBe(p.note_range_min);
    }
  });

  it('diatonic C is strictly natural (no black keys)', () => {
    const c = window.HarmonicaPresets.getPresets()
      .find((p) => p.id === 'harmo_diatonic_c');
    const { blow, draw } = layoutOf(c);
    expect([...blow, ...draw].some((n) => BLACK_PC.has(n % 12))).toBe(false);
  });

  it('diatonic A reproduces the real accidentals (C#, F#, G#)', () => {
    const a = window.HarmonicaPresets.getPresets()
      .find((p) => p.id === 'harmo_diatonic_a');
    const { blow, draw } = layoutOf(a);
    const pcs = new Set([...blow, ...draw].map((n) => n % 12));
    expect(pcs.has(1)).toBe(true); // C#
    expect(pcs.has(6)).toBe(true); // F#
    expect(pcs.has(8)).toBe(true); // G#
  });

  it('chromatic presets → 12 and 16 holes', () => {
    const p12 = window.HarmonicaPresets.getPresets()
      .find((p) => p.id === 'harmo_chromatic_c_12');
    const p16 = window.HarmonicaPresets.getPresets()
      .find((p) => p.id === 'harmo_chromatic_c_16');
    expect(layoutOf(p12).blow.length).toBe(12);
    expect(layoutOf(p16).blow.length).toBe(16);
  });
});
