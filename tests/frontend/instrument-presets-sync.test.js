// tests/frontend/instrument-presets-sync.test.js
// Guards parity of the unified instrument-preset catalogue between the
// canonical shared/instrument-presets.json and its inline frontend mirror
// (public/js/features/instrument-settings/InstrumentPresets.js), plus
// structural integrity (unique ids, valid GM programs / family slugs,
// coherent note ranges) so the two can never silently drift.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
const shared = JSON.parse(readFileSync(resolve(root, 'shared/instrument-presets.json'), 'utf8'));
const families = JSON.parse(readFileSync(resolve(root, 'shared/instrument-families.json'), 'utf8'));
const feSource = readFileSync(
  resolve(root, 'public/js/features/instrument-settings/InstrumentPresets.js'),
  'utf8'
);

const FAMILY_SLUGS = new Set(families.families.map((f) => f.slug));

beforeAll(() => {
  new Function(feSource)();
});

describe('InstrumentPresets — sync with shared JSON', () => {
  it('inline PRESETS deep-equals shared/instrument-presets.json presets', () => {
    expect(window.InstrumentPresets.PRESETS).toEqual(shared.presets);
  });

  it('mechanism ids/labels match the shared JSON (svg is FE-only)', () => {
    const fe = window.InstrumentPresets.MECHANISMS.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      v2: m.v2
    }));
    expect(fe).toEqual(shared.mechanisms);
  });
});

describe('InstrumentPresets — catalogue integrity', () => {
  it('every preset id is unique', () => {
    const ids = shared.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset has a valid family slug and GM programs 0-127', () => {
    for (const p of shared.presets) {
      expect(FAMILY_SLUGS.has(p.family_slug), `bad slug ${p.family_slug}`).toBe(true);
      expect(Array.isArray(p.gm_programs) && p.gm_programs.length > 0).toBe(true);
      for (const g of p.gm_programs) {
        expect(Number.isInteger(g) && g >= 0 && g <= 127).toBe(true);
      }
    }
  });

  it('note ranges are coherent and within MIDI 0-127', () => {
    for (const p of shared.presets) {
      expect(p.note_range_min).toBeGreaterThanOrEqual(0);
      expect(p.note_range_max).toBeLessThanOrEqual(127);
      expect(p.note_range_min).toBeLessThanOrEqual(p.note_range_max);
      expect(p.polyphony).toBeGreaterThanOrEqual(1);
    }
  });

  it('every non-SFX GM program (0-119) resolves to at least one preset', () => {
    const covered = new Set();
    for (const p of shared.presets) for (const g of p.gm_programs) covered.add(g);
    for (let g = 0; g <= 119; g++) {
      expect(covered.has(g), `GM program ${g} has no preset`).toBe(true);
    }
  });
});
