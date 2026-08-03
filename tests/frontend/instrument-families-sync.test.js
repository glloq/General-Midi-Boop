// tests/frontend/instrument-families-sync.test.js
// Guards the backend↔frontend parity of the instrument-family taxonomy.
// The canonical data lives in `shared/instrument-families.json`; the
// frontend mirrors it inline (for sync page-load) and the backend reads
// the JSON directly. This test asserts they describe the exact same
// taxonomy so consumers on either side can't silently drift.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sourcePath = resolve(
  __dirname,
  '../../public/js/features/instrument-settings/InstrumentFamilies.js'
);
const jsonPath = resolve(__dirname, '../../shared/instrument-families.json');
const source = readFileSync(sourcePath, 'utf8');
const shared = JSON.parse(readFileSync(jsonPath, 'utf8'));

beforeAll(() => {
  // Load the frontend IIFE once; registers window.InstrumentFamilies
  new Function(source)();
});

describe('InstrumentFamilies shared JSON ↔ frontend parity', () => {
  it('frontend FAMILIES matches shared.families in order, slug, emoji, programs', () => {
    const fe = window.InstrumentFamilies.getAllFamilies();
    expect(fe).toHaveLength(shared.families.length);
    for (let i = 0; i < fe.length; i++) {
      const a = fe[i];
      const b = shared.families[i];
      expect(a.slug).toBe(b.slug);
      expect(a.labelKey).toBe(b.labelKey);
      expect(a.emoji).toBe(b.emoji);
      expect(!!a.isDrumKits).toBe(!!b.isDrumKits);
      if (a.isDrumKits) {
        expect(a.programs).toBe('drumKits');
        expect(b.programs).toBe('drumKits');
        expect(a.forceChannel).toBe(b.forceChannel);
      } else {
        expect(a.programs).toEqual(b.programs);
      }
    }
  });

  it('frontend PROGRAM_TO_SLUG matches shared.programToSlug', () => {
    // Extract the frontend PROGRAM_TO_SLUG from the source: the IIFE does
    // not expose it directly; we re-parse the literal and compare.
    const m = source.match(/const\s+PROGRAM_TO_SLUG\s*=\s*{([\s\S]*?)};/);
    expect(m).toBeTruthy();
    const pairs = [...m[1].matchAll(/(\d+)\s*:\s*'([a-z_0-9]+)'/g)];
    const feMap = Object.fromEntries(pairs.map(([, p, s]) => [String(p), s]));
    expect(feMap).toEqual(shared.programToSlug);
  });

  it('frontend GM_DRUM_KITS_LIST matches shared.gmDrumKits', () => {
    // Parse the literal from the source (same trick as above).
    const m = source.match(/const\s+GM_DRUM_KITS_LIST\s*=\s*\[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const kits = [...m[1].matchAll(/{\s*program:\s*(\d+)[^}]*name:\s*'([^']+)'/g)].map(
      ([, p, n]) => ({ program: Number(p), name: n })
    );
    expect(kits).toEqual(shared.gmDrumKits);
  });

  it('integrity: every GM program 0-127 is covered by exactly one family in the JSON', () => {
    const counts = new Array(128).fill(0);
    for (const fam of shared.families) {
      if (fam.isDrumKits) continue;
      for (const p of fam.programs) counts[p]++;
    }
    for (let p = 0; p < 128; p++) {
      expect(counts[p]).toBe(1);
    }
  });

  it('integrity: every slug in programToSlug references an existing SVG file', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.resolve(__dirname, '../../public/assets/instruments');
    const files = new Set(
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.svg'))
        .map((f) => f.replace(/\.svg$/, ''))
    );
    for (const slug of Object.values(shared.programToSlug)) {
      expect(files.has(slug)).toBe(true);
    }
  });
});
