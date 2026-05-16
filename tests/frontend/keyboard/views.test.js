// tests/frontend/keyboard/views.test.js
// Integration test for the 5 built-in views + registry bootstrap.
// Verifies that every viewKind returned by InstrumentDetector resolves
// to a registered View class via instrumentViews.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  // Bootstrap order mirrors index.html
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  load('../../../public/js/features/keyboard/views/PianoView.js');
  load('../../../public/js/features/keyboard/views/FretboardView.js');
  load('../../../public/js/features/keyboard/views/DrumPadView.js');
  load('../../../public/js/features/keyboard/views/PianoSliderView.js');
  load('../../../public/js/features/keyboard/views/ListView.js');
  load('../../../public/js/features/keyboard/views/HarmonicaView.js');
  load('../../../public/js/features/keyboard/views/HarpView.js');
  load('../../../public/js/features/keyboard/views/AccordionView.js');
  load('../../../public/js/features/keyboard/views/MalletView.js');
  load('../../../public/js/features/keyboard/views/MusicBoxView.js');
  load('../../../public/js/features/keyboard/views/KalimbaView.js');
  load('../../../public/js/features/keyboard/views/BagpipeView.js');
  load('../../../public/js/features/keyboard/views/SteelDrumView.js');
  load('../../../public/js/features/keyboard/views/ThereminView.js');
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
});

const registry = () => win.instrumentViews;

describe('Built-in views — registration', () => {
  it('all 5 view classes are exposed on window', () => {
    expect(typeof win.PianoView).toBe('function');
    expect(typeof win.FretboardView).toBe('function');
    expect(typeof win.DrumPadView).toBe('function');
    expect(typeof win.PianoSliderView).toBe('function');
    expect(typeof win.ListView).toBe('function');
  });

  it('registry contains all 5 viewKinds', () => {
    expect(registry().kinds()).toContain('piano');
    expect(registry().kinds()).toContain('fretboard');
    expect(registry().kinds()).toContain('drumpad');
    expect(registry().kinds()).toContain('piano-slider');
    expect(registry().kinds()).toContain('keyboard-list');
  });

  it('viewKind static matches registry key', () => {
    expect(win.PianoView.viewKind).toBe('piano');
    expect(win.FretboardView.viewKind).toBe('fretboard');
    expect(win.DrumPadView.viewKind).toBe('drumpad');
    expect(win.PianoSliderView.viewKind).toBe('piano-slider');
    expect(win.ListView.viewKind).toBe('keyboard-list');
  });

  it('every view has a non-empty emoji + labelKey', () => {
    for (const V of [win.PianoView, win.FretboardView, win.DrumPadView, win.PianoSliderView, win.ListView]) {
      expect(typeof V.emoji).toBe('string');
      expect(V.emoji.length).toBeGreaterThan(0);
      expect(typeof V.labelKey).toBe('string');
      expect(V.labelKey.length).toBeGreaterThan(0);
    }
  });
});

describe('Built-in views — resolution from raw caps', () => {
  it('plain GM 0 → PianoView', () => {
    const r = registry().resolve({ gm_program: 0 });
    expect(r.viewKind).toBe('piano');
    expect(r.ViewClass).toBe(win.PianoView);
  });

  it('channel 9 → DrumPadView', () => {
    const r = registry().resolve({ channel: 9, gm_program: 0 });
    expect(r.ViewClass).toBe(win.DrumPadView);
  });

  it('drum-type alias → DrumPadView', () => {
    const r = registry().resolve({ instrument_type: 'drum_kit' });
    expect(r.ViewClass).toBe(win.DrumPadView);
  });

  it('GM guitar (24-31) → FretboardView', () => {
    const r = registry().resolve({ gm_program: 24 });
    expect(r.ViewClass).toBe(win.FretboardView);
  });

  it('GM bowed string (40-45) → FretboardView', () => {
    const r = registry().resolve({ gm_program: 40 });
    expect(r.ViewClass).toBe(win.FretboardView);
  });

  it('GM brass (56-79) → PianoSliderView with wind option', () => {
    const r = registry().resolve({ gm_program: 65 });
    expect(r.ViewClass).toBe(win.PianoSliderView);
    expect(r.options.wind).toBe(true);
  });

  it('GM 111 (Shanai) → PianoSliderView with wind option', () => {
    const r = registry().resolve({ gm_program: 111 });
    expect(r.ViewClass).toBe(win.PianoSliderView);
    expect(r.options.wind).toBe(true);
  });

  it('GM 8 (Celesta) → PianoView; GM 10 (Music Box) → MusicBoxView', () => {
    expect(registry().resolve({ gm_program: 8 }).ViewClass).toBe(win.PianoView);
    expect(registry().resolve({ gm_program: 10 }).ViewClass).toBe(win.MusicBoxView);
  });

  it('GM 47 (Timpani) → PianoView (not fretboard/mallet)', () => {
    expect(registry().resolve({ gm_program: 47 }).ViewClass).toBe(win.PianoView);
  });

  it('unknown caps → fallback PianoView', () => {
    const r = registry().resolve({});
    expect(r.ViewClass).toBe(win.PianoView);
  });
});

describe('Built-in views — InstrumentDetector ↔ registry consistency', () => {
  // For each test case, the viewKind returned by InstrumentDetector
  // must equal the viewKind returned by the registry.
  const windDb = {
    isWindInstrument(p) { return (p >= 56 && p <= 79) || p === 111; },
    getPresetByProgram(p) { return { name: `wind-${p}` }; }
  };
  const cases = [
    { caps: { gm_program: 0 },                expected: 'piano' },
    { caps: { gm_program: 7 },                expected: 'piano' },
    { caps: { channel: 9 },                   expected: 'drumpad' },
    { caps: { instrument_type: 'percussion' },expected: 'drumpad' },
    { caps: { gm_program: 24 },               expected: 'fretboard' },
    { caps: { gm_program: 40 },               expected: 'fretboard' },
    { caps: { gm_program: 104 },              expected: 'fretboard' },
    { caps: { gm_program: 56 },               expected: 'piano-slider', wind: true },
    { caps: { gm_program: 79 },               expected: 'piano-slider', wind: true },
    { caps: { gm_program: 111 },              expected: 'piano-slider', wind: true },
    { caps: { gm_program: 8 },                expected: 'piano' },
    { caps: { gm_program: 10 },               expected: 'music-box' },
    { caps: { gm_program: 47 },               expected: 'piano' },
    { caps: { gm_program: 12 },               expected: 'mallet' },
    { caps: { gm_program: 22 },               expected: 'harmonica' },
    { caps: { gm_program: 46 },               expected: 'harp' },
    { caps: { gm_program: 21 },               expected: 'accordion' },
    { caps: { gm_program: 23 },               expected: 'accordion' },
    { caps: { gm_program: 12 },               expected: 'mallet' },
    { caps: { gm_program: 15 },               expected: 'mallet' },
    { caps: { gm_program: 108 },              expected: 'kalimba' },
    { caps: { gm_program: 109 },              expected: 'bagpipe' },
    { caps: { gm_program: 114 },              expected: 'steel-drum' },
    { caps: { instrument_type: 'theremin' },  expected: 'theremin' },
  ];

  for (const { caps, expected, wind } of cases) {
    const label = JSON.stringify(caps);
    it(`detector + registry agree for ${label}`, () => {
      const det = win.InstrumentDetector.detect({
        capabilities: caps,
        windDb: wind ? windDb : null
      });
      const reg = registry().resolve(caps);
      // Note: registry doesn't know about windDb; piano-slider rule is
      // GM 56-79. So when wind:true the registry still says piano-slider.
      expect(det.viewKind).toBe(expected);
      expect(reg.viewKind).toBe(expected);
    });
  }
});

describe('Built-in views — toolbarGroups removed', () => {
  it('no view (nor the base class) declares toolbarGroups anymore', () => {
    const classes = [
      win.PianoView, win.FretboardView, win.DrumPadView,
      win.PianoSliderView, win.ListView, win.HarmonicaView,
      win.HarpView, win.AccordionView, win.MalletView,
      win.KalimbaView, win.BagpipeView, win.SteelDrumView,
      win.ThereminView, win.InstrumentView
    ];
    for (const C of classes) {
      if (typeof C !== 'function') continue;
      expect(typeof new C().toolbarGroups).toBe('undefined');
    }
  });
});

describe('Built-in views — SVG icon identity (emoji fallback)', () => {
  // NB: win.* are only populated by beforeAll, so resolve the class
  // lists lazily inside each test (not at describe-collection time).
  const specific = () => [
    win.HarmonicaView, win.HarpView, win.AccordionView, win.MalletView,
    win.MusicBoxView, win.KalimbaView, win.BagpipeView, win.SteelDrumView,
    win.PianoSliderView, win.FretboardView, win.DrumPadView, win.PianoView
  ];

  it('every view keeps a non-empty emoji fallback + labelKey', () => {
    for (const V of [...specific(), win.ListView, win.ThereminView]) {
      expect(typeof V.emoji).toBe('string');
      expect(V.emoji.length).toBeGreaterThan(0);
      expect(typeof V.labelKey).toBe('string');
      expect(V.labelKey.length).toBeGreaterThan(0);
    }
  });

  it('views with a drawn instrument point iconUrl at an /assets SVG', () => {
    for (const V of specific()) {
      expect(typeof V.iconUrl).toBe('string');
      expect(V.iconUrl).toMatch(/^\/assets\/instruments\/.+\.svg$/);
    }
  });

  it('iconless views (list/theremin) expose iconUrl=null → emoji only', () => {
    expect(win.ListView.iconUrl).toBe(null);
    expect(win.ThereminView.iconUrl).toBe(null);
  });

  it('emoji fallbacks are distinct across the specific instrument views', () => {
    const specificEmojis = [
      win.HarmonicaView, win.HarpView, win.AccordionView, win.MalletView,
      win.MusicBoxView, win.KalimbaView, win.BagpipeView,
      win.SteelDrumView, win.ThereminView
    ].map(V => V.emoji);
    expect(new Set(specificEmojis).size).toBe(specificEmojis.length);
  });
});

describe('Built-in views — willPlayNote default vs PianoSlider', () => {
  it('Piano default: pass-through', () => {
    const v = new (win.PianoView)();
    v.mount({ modal: null });
    expect(v.willPlayNote(60, 80, {})).toEqual({ midi: 60, velocity: 80, opts: {} });
    v.unmount();
  });

  it('PianoSlider applies wind articulation factor', () => {
    const v = new (win.PianoSliderView)();
    // staccato → 0.9 factor
    v.mount({ modal: { currentArticulation: 'staccato' } });
    const r = v.willPlayNote(60, 100, { x: 1 });
    expect(r.midi).toBe(60);
    expect(r.velocity).toBe(90); // round(100 * 0.9)
    v.unmount();
  });

  it('PianoSlider accent boosts velocity (×1.2 clamped to 127)', () => {
    const v = new (win.PianoSliderView)();
    v.mount({ modal: { currentArticulation: 'accent' } });
    expect(v.willPlayNote(60, 100, {}).velocity).toBe(120);
    expect(v.willPlayNote(60, 127, {}).velocity).toBe(127); // clamp
    v.unmount();
  });

  it('PianoSlider falls back to normal factor when articulation is unknown', () => {
    const v = new (win.PianoSliderView)();
    v.mount({ modal: { currentArticulation: 'something_made_up' } });
    expect(v.willPlayNote(60, 80, {}).velocity).toBe(80);
    v.unmount();
  });
});
