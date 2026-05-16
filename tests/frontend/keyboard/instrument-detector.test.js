// tests/frontend/keyboard/instrument-detector.test.js
// Unit tests for InstrumentDetector — pure module, no DOM.
// Covers all viewKind branches: piano / fretboard / drumpad / piano-slider.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
});

const D = () => win.InstrumentDetector;

// Minimal wind DB mock — only programs 56..79 are wind.
const windDb = {
  isWindInstrument(p) { return p >= 56 && p <= 79; },
  getPresetByProgram(p) { return { name: `wind-${p}`, range: [48, 84] }; }
};

describe('InstrumentDetector — defaults & fallback', () => {
  it('returns viewKind=piano for empty caps', () => {
    const r = D().detect({});
    expect(r.viewKind).toBe('piano');
    expect(r.isDrum).toBe(false);
    expect(r.canFretboard).toBe(false);
    expect(r.isWind).toBe(false);
  });

  it('returns viewKind=piano when only GM program is set (piano family)', () => {
    expect(D().detect({ capabilities: { gm_program: 0 } }).viewKind).toBe('piano');   // Grand Piano
    expect(D().detect({ capabilities: { gm_program: 7 } }).viewKind).toBe('piano');   // Clavinet
    expect(D().detect({ capabilities: { gm_program: 16 } }).viewKind).toBe('piano');  // Drawbar Organ
  });
});

describe('InstrumentDetector — drumpad detection', () => {
  it('detects channel 9 as drumpad regardless of program', () => {
    const r = D().detect({ capabilities: { gm_program: 0, channel: 9 } });
    expect(r.viewKind).toBe('drumpad');
    expect(r.isDrum).toBe(true);
  });

  it('detects instrument_type variations as drumpad', () => {
    for (const type of ['drum', 'drums', 'drumkit', 'drum_kit', 'percussion', 'percussive']) {
      const r = D().detect({ capabilities: { instrument_type: type, gm_program: 0 } });
      expect(r.viewKind).toBe('drumpad');
    }
  });

  it('detects case-insensitive drum types', () => {
    expect(D().detect({ capabilities: { instrument_type: 'DRUM' } }).viewKind).toBe('drumpad');
    expect(D().detect({ capabilities: { instrument_type: 'Drum_Kit' } }).viewKind).toBe('drumpad');
  });

  it('detects gm_program ≥ 128 as drumpad', () => {
    expect(D().detect({ capabilities: { gm_program: 128 } }).viewKind).toBe('drumpad');
    expect(D().detect({ capabilities: { gm_program: 200 } }).viewKind).toBe('drumpad');
  });

  it('falls back to device channel when capabilities omit it', () => {
    const r = D().detect({
      capabilities: { gm_program: 0 },
      selectedDevice: { channel: 9 }
    });
    expect(r.viewKind).toBe('drumpad');
  });
});

describe('InstrumentDetector — fretboard detection', () => {
  it('detects GM 24-45 (guitar/bass/orchestral strings) as fretboard', () => {
    // 46 (Harp) and 47 (Timpani) are excluded — dedicated harp / mallet views.
    for (const gm of [24, 25, 31, 32, 39, 40, 45]) {
      const r = D().detect({ capabilities: { gm_program: gm } });
      expect(r.viewKind).toBe('fretboard');
      expect(r.canFretboard).toBe(true);
    }
  });

  it('detects ethnic-strings GM (sitar/banjo/shamisen/koto/fiddle)', () => {
    for (const gm of [104, 105, 106, 107, 110]) {
      expect(D().detect({ capabilities: { gm_program: gm } }).viewKind).toBe('fretboard');
    }
  });

  it('detects explicit instrument_type=string as fretboard', () => {
    const r = D().detect({ capabilities: { instrument_type: 'string', gm_program: 0 } });
    expect(r.viewKind).toBe('fretboard');
  });

  it('forces fretboard when stringInstrumentConfig is set, regardless of GM', () => {
    const r = D().detect({
      capabilities: { gm_program: 0 },
      stringInstrumentConfig: { strings: 6, tuning: [40, 45, 50, 55, 59, 64] }
    });
    expect(r.viewKind).toBe('fretboard');
  });

  it('detects bowed strings (violin/viola/cello/contrabass/tremolo/pizzicato/fiddle)', () => {
    for (const gm of [40, 41, 42, 43, 44, 45, 110]) {
      const r = D().detect({ capabilities: { gm_program: gm } });
      expect(r.isBowed).toBe(true);
      expect(r.viewKind).toBe('fretboard');
    }
  });

  it('plucked strings are not bowed', () => {
    for (const gm of [24, 25, 32, 104, 105]) {
      expect(D().detect({ capabilities: { gm_program: gm } }).isBowed).toBe(false);
    }
  });

  it('does NOT classify as fretboard when channel 9 (drum wins)', () => {
    const r = D().detect({ capabilities: { gm_program: 24, channel: 9 } });
    expect(r.viewKind).toBe('drumpad');
  });
});

describe('InstrumentDetector — mallet / perc-pad detection', () => {
  it('detects glockenspiel (9) + vibraphone (11) as mallet', () => {
    for (const gm of [9, 11]) {
      const r = D().detect({ capabilities: { gm_program: gm } });
      expect(r.viewKind).toBe('mallet');
      expect(r.canFretboard).toBe(false);
    }
  });

  it('GM 47 (Timpani) stays on the piano keyboard (user spec), not mallet/fretboard', () => {
    const r = D().detect({ capabilities: { gm_program: 47 } });
    expect(r.viewKind).toBe('piano');
    expect(r.canFretboard).toBe(false);   // 47 excluded from the 24-45 range
  });

  it('keeps marimba…dulcimer (12-15) as mallet', () => {
    for (const gm of [12, 13, 14, 15]) {
      expect(D().detect({ capabilities: { gm_program: gm } }).viewKind).toBe('mallet');
    }
  });

  it('detects struck/one-shot percussion + SFX (112-127) as perc-pad', () => {
    for (const gm of [112, 113, 115, 116, 117, 118, 119, 120, 123, 126, 127]) {
      expect(D().detect({ capabilities: { gm_program: gm } }).viewKind).toBe('perc-pad');
    }
  });

  it('GM 114 (Steel Drums) keeps its dedicated steel-drum view', () => {
    expect(D().detect({ capabilities: { gm_program: 114 } }).viewKind).toBe('steel-drum');
  });

  it('GM 8 (Celesta) stays on the piano keyboard (user spec)', () => {
    const r = D().detect({ capabilities: { gm_program: 8 } });
    expect(r.viewKind).toBe('piano');
  });

  it('GM 10 (Music Box) has its own dedicated view', () => {
    const r = D().detect({ capabilities: { gm_program: 10 } });
    expect(r.viewKind).toBe('music-box');
    expect(r.isMusicBox).toBe(true);
  });

  it('GM 16 (Drawbar Organ) stays piano', () => {
    expect(D().detect({ capabilities: { gm_program: 16 } }).viewKind).toBe('piano');
  });

  it('channel 9 still wins over perc-pad / mallet', () => {
    expect(D().detect({ capabilities: { gm_program: 112, channel: 9 } }).viewKind).toBe('drumpad');
    expect(D().detect({ capabilities: { gm_program: 47, channel: 9 } }).viewKind).toBe('drumpad');
  });
});

describe('InstrumentDetector — wind / piano-slider detection', () => {
  it('detects brass/reeds/pipe (GM 56-79) as piano-slider when windDb is available', () => {
    for (const gm of [56, 57, 64, 65, 72, 79]) {
      const r = D().detect({ capabilities: { gm_program: gm }, windDb });
      expect(r.viewKind).toBe('piano-slider');
      expect(r.isWind).toBe(true);
      expect(r.windPreset).not.toBe(null);
      expect(r.windPreset.name).toBe(`wind-${gm}`);
    }
  });

  it('detects Shanai (GM 111) as piano-slider when windDb knows it', () => {
    const windDb111 = {
      isWindInstrument(p) { return (p >= 56 && p <= 79) || p === 111; },
      getPresetByProgram(p) { return { name: `wind-${p}` }; }
    };
    const r = D().detect({ capabilities: { gm_program: 111 }, windDb: windDb111 });
    expect(r.viewKind).toBe('piano-slider');
    expect(r.isWind).toBe(true);
    expect(r.windPreset).not.toBe(null);
    expect(r.windPreset.name).toBe('wind-111');
  });

  it('Shanai (GM 111) falls back to piano when windDb does not know it', () => {
    const r = D().detect({ capabilities: { gm_program: 111 }, windDb });
    expect(r.viewKind).toBe('piano');
    expect(r.isWind).toBe(false);
  });

  it('returns piano (not piano-slider) when windDb is missing', () => {
    const r = D().detect({ capabilities: { gm_program: 65 } });
    // window.WindInstrumentDatabase is undefined in this test runner
    expect(r.viewKind).toBe('piano');
    expect(r.isWind).toBe(false);
  });

  it('does NOT classify wind when channel is 9 (drum wins)', () => {
    const r = D().detect({ capabilities: { gm_program: 65, channel: 9 }, windDb });
    expect(r.viewKind).toBe('drumpad');
    expect(r.isWind).toBe(false);
  });

  it('does NOT classify wind when string instrument config is set (fretboard wins)', () => {
    const r = D().detect({
      capabilities: { gm_program: 65 },
      stringInstrumentConfig: { strings: 6 },
      windDb
    });
    expect(r.viewKind).toBe('fretboard');
    expect(r.isWind).toBe(false);
  });
});

describe('InstrumentDetector — output shape', () => {
  it('always returns the legacy fields used by callers', () => {
    const r = D().detect({ capabilities: { gm_program: 65, instrument_type: 'wind', instrument_subtype: 'sax' }, windDb });
    expect(r).toHaveProperty('viewKind');
    expect(r).toHaveProperty('options');
    expect(r).toHaveProperty('canFretboard');
    expect(r).toHaveProperty('isBowed');
    expect(r).toHaveProperty('isDrum');
    expect(r).toHaveProperty('isWind');
    expect(r).toHaveProperty('windPreset');
    expect(r).toHaveProperty('instrumentType');
    expect(r).toHaveProperty('instrumentSubtype');
    expect(r).toHaveProperty('gmProgram');
  });

  it('options.windPreset / options.isBowed mirror top-level fields', () => {
    const r = D().detect({ capabilities: { gm_program: 40 } });
    expect(r.options.isBowed).toBe(r.isBowed);
    expect(r.options.windPreset).toBe(r.windPreset);
  });
});
