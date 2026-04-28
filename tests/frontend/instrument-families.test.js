// tests/frontend/instrument-families.test.js
// Validates the 11-family taxonomy and the icon resolver fallback logic.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sourcePath = resolve(__dirname, '../../public/js/features/instrument-settings/InstrumentFamilies.js');
const source = readFileSync(sourcePath, 'utf8');

// Execute the IIFE once in jsdom context; it registers window.InstrumentFamilies
beforeAll(() => {
  new Function(source)();
});

const GM_DRUM_KIT_OFFSET = 128;

describe('InstrumentFamilies taxonomy', () => {
  it('defines 11 families', () => {
    const families = window.InstrumentFamilies.getAllFamilies();
    expect(families).toHaveLength(11);
  });

  it('every GM program 0-127 maps to exactly one family', () => {
    const families = window.InstrumentFamilies.getAllFamilies();
    const counts = new Array(128).fill(0);
    for (const fam of families) {
      if (fam.isDrumKits) continue;
      for (const p of fam.programs) counts[p]++;
    }
    for (let p = 0; p < 128; p++) {
      expect(counts[p]).toBe(1);
    }
  });

  it('accordion (21) is now in reeds (not in organs)', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(21, 0);
    expect(fam.slug).toBe('reeds');
  });

  it('harmonica (22) and tango accordion (23) are in reeds', () => {
    expect(window.InstrumentFamilies.getFamilyForProgram(22, 0).slug).toBe('reeds');
    expect(window.InstrumentFamilies.getFamilyForProgram(23, 0).slug).toBe('reeds');
  });

  it('kalimba (108) is in chromatic_percussion', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(108, 0);
    expect(fam.slug).toBe('chromatic_percussion');
  });

  it('orchestral harp (46) is in plucked_strings', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(46, 0);
    expect(fam.slug).toBe('plucked_strings');
  });

  it('timpani (47) is in chromatic_percussion', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(47, 0);
    expect(fam.slug).toBe('chromatic_percussion');
  });

  it('fiddle (110) is in bowed_strings', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(110, 0);
    expect(fam.slug).toBe('bowed_strings');
  });

  it('ethnic plucked (sitar 104, banjo 105, shamisen 106, koto 107) in plucked_strings', () => {
    for (const p of [104, 105, 106, 107]) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('plucked_strings');
    }
  });

  it('bagpipe (109) and shanai (111) are in reeds', () => {
    expect(window.InstrumentFamilies.getFamilyForProgram(109, 0).slug).toBe('reeds');
    expect(window.InstrumentFamilies.getFamilyForProgram(111, 0).slug).toBe('reeds');
  });

  it('keyboard programs (0-7) are in keyboards', () => {
    for (let p = 0; p <= 7; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('keyboards');
    }
  });

  it('organs (16-20) are in organs, but not 21-23', () => {
    for (let p = 16; p <= 20; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('organs');
    }
    for (let p = 21; p <= 23; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).not.toBe('organs');
    }
  });

  it('guitars (24-31) and basses (32-39) are in plucked_strings', () => {
    for (let p = 24; p <= 39; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('plucked_strings');
    }
  });

  it('bowed orchestral strings (40-45) are in bowed_strings', () => {
    for (let p = 40; p <= 45; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('bowed_strings');
    }
  });

  it('brass (56-63) is in brass', () => {
    for (let p = 56; p <= 63; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('brass');
    }
  });

  it('reeds (64-71) are in reeds', () => {
    for (let p = 64; p <= 71; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('reeds');
    }
  });

  it('winds/pipes (72-79) are in winds', () => {
    for (let p = 72; p <= 79; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('winds');
    }
  });

  it('synths (80-103) and sound effects (120-127) are merged into synths', () => {
    for (let p = 80; p <= 103; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('synths');
    }
    for (let p = 120; p <= 127; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('synths');
    }
  });

  it('various percussion (112-119) merged into chromatic_percussion', () => {
    for (let p = 112; p <= 119; p++) {
      expect(window.InstrumentFamilies.getFamilyForProgram(p, 0).slug).toBe('chromatic_percussion');
    }
  });

  it('null program on channel 9 maps to drum_kits', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(null, 9);
    expect(fam.slug).toBe('drum_kits');
    expect(fam.isDrumKits).toBe(true);
    expect(fam.forceChannel).toBe(9);
  });

  it('encoded drum kit value (128+p) maps to drum_kits', () => {
    const fam = window.InstrumentFamilies.getFamilyForProgram(128 + 56, 0);
    expect(fam.slug).toBe('drum_kits');
  });

  it('null program on non-drum channel returns null', () => {
    expect(window.InstrumentFamilies.getFamilyForProgram(null, 0)).toBeNull();
    expect(window.InstrumentFamilies.getFamilyForProgram(undefined, 5)).toBeNull();
  });

  it('isDrumFamily returns true only for drum_kits', () => {
    expect(window.InstrumentFamilies.isDrumFamily('drum_kits')).toBe(true);
    expect(window.InstrumentFamilies.isDrumFamily('keyboards')).toBe(false);
    expect(window.InstrumentFamilies.isDrumFamily('unknown')).toBe(false);
  });

  it('getFamilyBySlug returns null for unknown slug', () => {
    expect(window.InstrumentFamilies.getFamilyBySlug('bogus')).toBeNull();
    expect(window.InstrumentFamilies.getFamilyBySlug('brass').slug).toBe('brass');
  });
});

describe('InstrumentFamilies.resolveInstrumentIcon', () => {
  it('returns emoji fallback and null slug for a program without an SVG', () => {
    // GM 1 (Bright Acoustic Piano) has no SVG in the current library
    const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: 1, channel: 0 });
    expect(icon.slug).toBeNull();
    expect(icon.svgUrl).toBeNull();
    expect(icon.emoji).toBe('🎹'); // keyboards family emoji
    expect(icon.family.slug).toBe('keyboards');
  });

  it('returns a svgUrl for a program that has an SVG', () => {
    // GM 40 violin has a dedicated SVG
    const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: 40, channel: 0 });
    expect(icon.slug).toBe('violin');
    expect(icon.svgUrl).toBe('/assets/instruments/violin.svg');
    expect(icon.emoji).toBe('🎻');
    expect(icon.family.slug).toBe('bowed_strings');
  });

  it('handles drum kits: encoded value (128+program) maps to drum_kit_<p>', () => {
    const encoded = GM_DRUM_KIT_OFFSET + 32; // Jazz Kit
    const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: encoded, channel: 9 });
    expect(icon.family.slug).toBe('drum_kits');
    expect(icon.slug).toBe('drum_kit_32');
    expect(icon.svgUrl).toBe('/assets/instruments/drum_kit_32.svg');
    expect(icon.emoji).toBe('🥁');
  });

  it('handles drum kits on channel 9 even with raw program', () => {
    const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: 0, channel: 9 });
    expect(icon.family.slug).toBe('drum_kits');
    // raw program 0 on channel 9 → normalized kit 0 → slug drum_kit_0
    expect(icon.slug).toBe('drum_kit_0');
  });

  it('returns emoji-only fallback for null program on non-drum channel', () => {
    const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: null, channel: 0 });
    expect(icon.slug).toBeNull();
    expect(icon.svgUrl).toBeNull();
    expect(icon.emoji).toBe('🎵');
    expect(icon.family).toBeNull();
  });

  it('familyIconUrl builds the expected path', () => {
    expect(window.InstrumentFamilies.familyIconUrl('brass'))
      .toBe('/assets/instruments/family_brass.svg');
  });
});
