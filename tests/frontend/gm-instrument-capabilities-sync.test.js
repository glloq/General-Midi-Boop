// tests/frontend/gm-instrument-capabilities-sync.test.js
// Guards parity of the per-GM-program capability table across its three
// sources: the canonical shared/gm-instrument-capabilities.json, the inline
// frontend mirror (public/js/features/GmInstrumentCapabilities.js), and the
// backend polyphony derived from the same JSON. Also cross-checks that
// instrument names match shared/gm-instrument-names.json and wind ranges
// match WindInstrumentDatabase, so none of these can silently drift.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import InstrumentTypeConfig from '../../src/midi/adaptation/InstrumentTypeConfig.js';

const root = resolve(__dirname, '../..');
const shared = JSON.parse(
  readFileSync(resolve(root, 'shared/gm-instrument-capabilities.json'), 'utf8')
);
const names = JSON.parse(readFileSync(resolve(root, 'shared/gm-instrument-names.json'), 'utf8'));
const feSource = readFileSync(
  resolve(root, 'public/js/features/GmInstrumentCapabilities.js'),
  'utf8'
);
const windSource = readFileSync(
  resolve(root, 'public/js/features/WindInstrumentDatabase.js'),
  'utf8'
);

// Extract wind range tuples (program → [rangeMin,rangeMax,comfortMin,comfortMax])
// straight from the WindInstrumentDatabase source literal.
function parseWindRanges(src) {
  const out = {};
  const re =
    /(\d+):\s*\{[^}]*?rangeMin:\s*(\d+),\s*rangeMax:\s*(\d+),\s*comfortMin:\s*(\d+),\s*comfortMax:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out[Number(m[1])] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  }
  return out;
}

beforeAll(() => {
  // Registers window.GmInstrumentCapabilities (jsdom global window)
  new Function(feSource)();
});

describe('GM instrument capabilities — sync & integrity', () => {
  it('frontend CAPABILITIES deep-equals the shared JSON', () => {
    const fe = window.GmInstrumentCapabilities.CAPABILITIES;
    const feNorm = {};
    for (const k of Object.keys(fe)) feNorm[k] = fe[k];
    expect(feNorm).toEqual(shared);
  });

  it('every GM program 0-127 is present', () => {
    for (let p = 0; p <= 127; p++) {
      expect(shared[String(p)], `missing program ${p}`).toBeTruthy();
    }
    expect(Object.keys(shared)).toHaveLength(128);
  });

  it('name equals shared/gm-instrument-names.json[program]', () => {
    for (let p = 0; p <= 127; p++) {
      expect(shared[String(p)].name).toBe(names[p]);
    }
  });

  it('polyphony equals the backend getGmDefaultPolyphony for all 0-127', () => {
    for (let p = 0; p <= 127; p++) {
      expect(shared[String(p)].polyphony).toBe(InstrumentTypeConfig.getGmDefaultPolyphony(p));
    }
  });

  it('monophonic === (polyphony === 1) and ranges are coherent', () => {
    for (let p = 0; p <= 127; p++) {
      const c = shared[String(p)];
      expect(c.monophonic).toBe(c.polyphony === 1);
      expect(c.rangeMin).toBeLessThanOrEqual(c.comfortMin);
      expect(c.comfortMin).toBeLessThanOrEqual(c.comfortMax);
      expect(c.comfortMax).toBeLessThanOrEqual(c.rangeMax);
      expect(c.rangeMin).toBeGreaterThanOrEqual(0);
      expect(c.rangeMax).toBeLessThanOrEqual(127);
    }
  });

  it('wind ranges (56-79, 111) match WindInstrumentDatabase', () => {
    const wind = parseWindRanges(windSource);
    for (const pStr of Object.keys(wind)) {
      const p = Number(pStr);
      if (!((p >= 56 && p <= 79) || p === 111)) continue;
      const c = shared[String(p)];
      expect(
        [c.rangeMin, c.rangeMax, c.comfortMin, c.comfortMax],
        `wind program ${p} drifted`
      ).toEqual(wind[p]);
    }
  });

  it('get() returns the entry or null for out-of-range input', () => {
    expect(window.GmInstrumentCapabilities.get(0).name).toBe('Acoustic Grand Piano');
    expect(window.GmInstrumentCapabilities.get(56).monophonic).toBe(true);
    expect(window.GmInstrumentCapabilities.get(200)).toBeNull();
    expect(window.GmInstrumentCapabilities.get(NaN)).toBeNull();
  });
});
