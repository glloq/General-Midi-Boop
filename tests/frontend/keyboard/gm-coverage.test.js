// tests/frontend/keyboard/gm-coverage.test.js
// Coverage matrix: every General-MIDI program (0-127), every GM drum kit,
// and the theremin custom type MUST resolve to a registered, non-null
// View class, AND the two mirrored detection paths (InstrumentDetector
// and the registry rules) MUST agree. This guards the "interface adaptée
// pour TOUS les types d'instruments GM" requirement and prevents the two
// detection paths from silently diverging.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  for (const v of [
    'PianoView',
    'FretboardView',
    'DrumPadView',
    'PianoSliderView',
    'ListView',
    'HarmonicaView',
    'HarpView',
    'AccordionView',
    'MalletView',
    'MusicBoxView',
    'KalimbaView',
    'BagpipeView',
    'SteelDrumView',
    'ThereminView',
    'PercussionPadView'
  ]) {
    load(`../../../public/js/features/keyboard/views/${v}.js`);
  }
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
});

// Mirrors the real WindInstrumentDatabase.isWindInstrument after Shanai
// (GM 111) was added alongside the contiguous 56-79 wind range.
const windDb = {
  isWindInstrument(p) {
    return (p >= 56 && p <= 79) || p === 111;
  },
  getPresetByProgram(p) {
    return { name: `wind-${p}` };
  }
};

const registry = () => win.instrumentViews;
const detect = (caps) => win.InstrumentDetector.detect({ capabilities: caps, windDb }).viewKind;

describe('GM coverage — every program resolves to a registered view', () => {
  for (let gm = 0; gm <= 127; gm++) {
    it(`GM ${gm}: registered ViewClass + detector/registry agree`, () => {
      const reg = registry().resolve({ gm_program: gm });
      expect(typeof reg.ViewClass).toBe('function');
      expect(reg.viewKind).toBe(detect({ gm_program: gm }));
    });
  }

  it('no GM program is left on the implicit fallback by accident', () => {
    // Sanity: the fallback IS piano, but it must come from a real
    // registered class, never undefined.
    for (let gm = 0; gm <= 127; gm++) {
      expect(registry().resolve({ gm_program: gm }).ViewClass).toBeTruthy();
    }
  });
});

describe('GM coverage — instrument-specific routing (user spec)', () => {
  it('Celesta (8) → piano keyboard; Timpani (47) → piano keyboard', () => {
    expect(detect({ gm_program: 8 })).toBe('piano');
    expect(detect({ gm_program: 47 })).toBe('piano');
    expect(registry().resolve({ gm_program: 8 }).ViewClass).toBe(win.PianoView);
    expect(registry().resolve({ gm_program: 47 }).ViewClass).toBe(win.PianoView);
  });

  it('Music Box (10) → its own dedicated MusicBoxView', () => {
    expect(detect({ gm_program: 10 })).toBe('music-box');
    expect(registry().resolve({ gm_program: 10 }).ViewClass).toBe(win.MusicBoxView);
  });

  it('Glockenspiel (9) + Vibraphone (11) stay mallet', () => {
    expect(detect({ gm_program: 9 })).toBe('mallet');
    expect(detect({ gm_program: 11 })).toBe('mallet');
  });

  it('Shanai (111) → piano-slider (wind), not piano', () => {
    expect(detect({ gm_program: 111 })).toBe('piano-slider');
    const reg = registry().resolve({ gm_program: 111 });
    expect(reg.ViewClass).toBe(win.PianoSliderView);
    expect(reg.options.wind).toBe(true);
  });

  it('genuine piano-fallback families are untouched (regression guard)', () => {
    for (const gm of [0, 4, 7, 16, 20, 48, 55, 80, 95, 103]) {
      expect(detect({ gm_program: gm })).toBe('piano');
    }
  });
});

describe('GM coverage — non-melodic & custom types', () => {
  it('channel 9 (any program) → drumpad', () => {
    for (const gm of [0, 24, 56, 114]) {
      const r = registry().resolve({ gm_program: gm, channel: 9 });
      expect(r.ViewClass).toBe(win.DrumPadView);
      expect(detect({ gm_program: gm, channel: 9 })).toBe('drumpad');
    }
  });

  it('GM drum-kit programs (>= 128) → drumpad', () => {
    for (const gm of [128, 136, 184]) {
      expect(registry().resolve({ gm_program: gm }).ViewClass).toBe(win.DrumPadView);
      expect(detect({ gm_program: gm })).toBe('drumpad');
    }
  });

  it('instrument_type "theremin" → theremin', () => {
    expect(registry().resolve({ instrument_type: 'theremin' }).ViewClass).toBe(win.ThereminView);
    expect(
      win.InstrumentDetector.detect({
        capabilities: { instrument_type: 'theremin' },
        windDb
      }).viewKind
    ).toBe('theremin');
  });
});

describe('GM coverage — KeyboardModal self-owned dispatch completeness', () => {
  // Regression guard: a new dedicated view was registered + detected but
  // _selectInstrumentOption forgot to dispatch its viewKind, so it fell
  // back to piano (the Music Box bug). Assert every self-owned kind is
  // both registered AND present in that dispatch list.
  const SELF_OWNED = [
    'harmonica',
    'accordion',
    'mallet',
    'music-box',
    'kalimba',
    'bagpipe',
    'steel-drum',
    'perc-pad',
    'theremin'
  ];

  it('every self-owned view kind is dispatched by _selectInstrumentOption', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../public/js/features/KeyboardModal.js'),
      'utf8'
    );
    // Tolerate Prettier's multi-line array formatting: allow whitespace/newlines
    // between `(` and `[` (and around `]`). The list contents, not the source
    // layout, are what this guard checks.
    const m = src.match(/else if \(\s*\[([^\]]*?)\]\s*\.includes\(info\.viewKind\)\s*\)/);
    expect(m).not.toBeNull();
    const dispatched = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    for (const k of SELF_OWNED) expect(dispatched).toContain(k);
  });

  it('every self-owned kind resolves to a registered ViewClass', () => {
    for (const k of SELF_OWNED) {
      expect(typeof registry().get(k)).toBe('function');
    }
  });
});
