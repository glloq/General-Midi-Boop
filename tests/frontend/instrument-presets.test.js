// tests/frontend/instrument-presets.test.js
// Behaviour of the unified instrument-preset selector: shape compatibility
// with ISMListeners._wireNotePresetListener, family/program resolution,
// drum & SFX exclusions, the string-geometry helpers consumed by the
// geometry sub-section, and — crucially — that each harmonica preset's
// note range still resolves (via HarmonicaLayout, the production layout
// module) to exactly the advertised number of holes with the right tuning.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
const load = (rel) => readFileSync(resolve(root, rel), 'utf8');

beforeAll(() => {
  new Function(load('public/js/features/instrument-settings/InstrumentFamilies.js'))();
  new Function(load('public/js/features/GmInstrumentCapabilities.js'))();
  new Function(load('public/js/features/keyboard/HarmonicaLayout.js'))();
  new Function(load('public/js/features/instrument-settings/InstrumentPresets.js'))();
});

const SHAPE = [
  'id',
  'label',
  'note_selection_mode',
  'octave_mode',
  'note_range_min',
  'note_range_max',
  'polyphony'
];
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

describe('InstrumentPresets.getPresetsForProgram', () => {
  it('returns [] for drums (channel 9)', () => {
    expect(window.InstrumentPresets.getPresetsForProgram(0, 9)).toEqual([]);
  });

  it('returns [] when gmProgram is null', () => {
    expect(window.InstrumentPresets.getPresetsForProgram(null, 0)).toEqual([]);
  });

  it('returns [] for SFX programs 120-127 (no realistic preset)', () => {
    expect(window.InstrumentPresets.getPresetsForProgram(122, 0)).toEqual([]);
    expect(window.InstrumentPresets.getPresetsForProgram(127, 0)).toEqual([]);
  });

  it('electric guitar (GM 26) yields realistic guitar presets with geometry', () => {
    const presets = window.InstrumentPresets.getPresetsForProgram(26, 0);
    const ids = presets.map((p) => p.id);
    expect(ids).toContain('electric_guitar');
    const eg = presets.find((p) => p.id === 'electric_guitar');
    expect(eg.string_geometry.num_strings).toBe(6);
    expect(eg.note_range_min).toBeLessThan(eg.note_range_max);
    // no abstract "cap_*" buckets anymore
    expect(ids.some((id) => id.startsWith('cap_'))).toBe(false);
  });

  it('harmonica (GM 22) yields the 10 real harmonica presets, no generic ones', () => {
    const presets = window.InstrumentPresets.getPresetsForProgram(22, 0);
    const ids = presets.map((p) => p.id);
    expect(ids).toEqual([
      'harmo_diatonic_c',
      'harmo_diatonic_g',
      'harmo_diatonic_a',
      'harmo_diatonic_d',
      'harmo_diatonic_f',
      'harmo_diatonic_as',
      'harmo_diatonic_e',
      'harmo_diatonic_ds',
      'harmo_chromatic_c_12',
      'harmo_chromatic_c_16'
    ]);
    for (const p of presets) {
      expect(p.polyphony).toBe(1);
      expect(['diatonic', 'chromatic']).toContain(p.harmonica_config.type);
    }
  });

  it('flute (GM 73) is monophonic', () => {
    const presets = window.InstrumentPresets.getPresetsForProgram(73, 0);
    const flute = presets.find((p) => p.id === 'flute');
    expect(flute).toBeTruthy();
    expect(flute.polyphony).toBe(1);
  });

  it('every preset has the keys the listener consumes', () => {
    const presets = window.InstrumentPresets.getPresetsForProgram(0, 0);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      for (const k of SHAPE) expect(p).toHaveProperty(k);
      expect(p.note_selection_mode).toBe('range');
      expect(p.octave_mode).toBe('chromatic');
      expect(p.note_range_min).toBeLessThanOrEqual(p.note_range_max);
      expect(p.polyphony).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('InstrumentPresets — string geometry helpers', () => {
  it('filterStringPresetsByGmProgram flattens geometry + tuning for the dropdown', () => {
    const list = window.InstrumentPresets.filterStringPresetsByGmProgram(40);
    const violin = list.find((p) => p.id === 'violin');
    expect(violin).toMatchObject({
      num_strings: 4,
      num_frets: 0,
      default_mechanism: 'string_sliding_fingers',
      fretless: true
    });
    expect(violin.tuning).toEqual([55, 62, 69, 76]);
    expect(violin.scale_length_mm).toBeGreaterThan(0);
  });

  it('string presets expose a standard tuning whose length matches num_strings', () => {
    const all = window.InstrumentPresets.filterStringPresetsByFamily('plucked_strings').concat(
      window.InstrumentPresets.filterStringPresetsByFamily('bowed_strings')
    );
    for (const p of all) {
      if (p.tuning === null) continue; // harp/sitar/koto/shamisen: no neck UI
      expect(p.tuning.length, `${p.id} tuning/strings mismatch`).toBe(p.num_strings);
      for (const n of p.tuning) expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('a guitar GM program offers several common string choices (not just one)', () => {
    const ids = window.InstrumentPresets.filterStringPresetsByGmProgram(24).map((p) => p.id);
    expect(ids).toContain('acoustic_guitar_nylon');
    expect(ids).toContain('ukulele_soprano');
    expect(ids.length).toBeGreaterThan(1);
  });

  it('filterStringPresetsByFamily returns only string entries of that family', () => {
    const list = window.InstrumentPresets.filterStringPresetsByFamily('bowed_strings');
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(p.family_slug).toBe('bowed_strings');
      expect(Number.isFinite(p.num_strings)).toBe(true);
    }
  });

  it('non-string instruments expose no string geometry', () => {
    const flute = window.InstrumentPresets.getPresetById('flute');
    expect(flute.string_geometry).toBeUndefined();
  });
});

describe('InstrumentPresets — harmonica ranges resolve to the right layout', () => {
  const harmos = () => window.InstrumentPresets.getPresetsForProgram(22, 0);
  const layoutOf = (p) =>
    window.HarmonicaLayout.computeLayout(p.harmonica_config, {
      min: p.note_range_min,
      max: p.note_range_max,
      notes: null
    });

  it('every diatonic preset → exactly 10 holes, starting at its low note', () => {
    for (const p of harmos().filter((x) => x.harmonica_config.type === 'diatonic')) {
      const { blow, draw } = layoutOf(p);
      expect(blow.length).toBe(10);
      expect(draw.length).toBe(10);
      expect(blow[0]).toBe(p.note_range_min);
    }
  });

  it('diatonic C is strictly natural (no black keys)', () => {
    const c = harmos().find((p) => p.id === 'harmo_diatonic_c');
    const { blow, draw } = layoutOf(c);
    expect([...blow, ...draw].some((n) => BLACK_PC.has(n % 12))).toBe(false);
  });

  it('diatonic A reproduces the real accidentals (C#, F#, G#)', () => {
    const a = harmos().find((p) => p.id === 'harmo_diatonic_a');
    const { blow, draw } = layoutOf(a);
    const pcs = new Set([...blow, ...draw].map((n) => n % 12));
    expect(pcs.has(1)).toBe(true);
    expect(pcs.has(6)).toBe(true);
    expect(pcs.has(8)).toBe(true);
  });

  it('chromatic presets → 12 and 16 holes', () => {
    const p12 = harmos().find((p) => p.id === 'harmo_chromatic_c_12');
    const p16 = harmos().find((p) => p.id === 'harmo_chromatic_c_16');
    expect(layoutOf(p12).blow.length).toBe(12);
    expect(layoutOf(p16).blow.length).toBe(16);
  });
});
