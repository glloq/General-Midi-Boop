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

  it('unknown caps → fallback PianoView', () => {
    const r = registry().resolve({});
    expect(r.ViewClass).toBe(win.PianoView);
  });
});

describe('Built-in views — InstrumentDetector ↔ registry consistency', () => {
  // For each test case, the viewKind returned by InstrumentDetector
  // must equal the viewKind returned by the registry.
  const windDb = {
    isWindInstrument(p) { return p >= 56 && p <= 79; },
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
    { caps: { gm_program: 22 },               expected: 'harmonica' },
    { caps: { gm_program: 46 },               expected: 'harp' },
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

describe('Built-in views — toolbarGroups', () => {
  it('Piano includes notation + velocity + minimap + octave-bar + view-mode', () => {
    const g = new (win.PianoView)().toolbarGroups();
    expect(g.has('notation')).toBe(true);
    expect(g.has('velocity')).toBe(true);
    expect(g.has('minimap')).toBe(true);
    expect(g.has('octave-bar')).toBe(true);
    expect(g.has('view-mode')).toBe(true);
  });

  it('DrumPad excludes notation, list-view, modulation, pitch-bend', () => {
    const g = new (win.DrumPadView)().toolbarGroups();
    expect(g.has('notation')).toBe(false);
    expect(g.has('list-view')).toBe(false);
    expect(g.has('modulation')).toBe(false);
    expect(g.has('pitch-bend')).toBe(false);
    expect(g.has('velocity')).toBe(true);
    expect(g.has('view-mode')).toBe(true);
  });

  it('Fretboard exposes slide-mode + pitch-bend, excludes list-view', () => {
    const g = new (win.FretboardView)().toolbarGroups();
    expect(g.has('slide-mode')).toBe(true);
    expect(g.has('pitch-bend')).toBe(true);
    expect(g.has('list-view')).toBe(false);
  });

  it('PianoSlider exposes wind-panel + piano-slider', () => {
    const g = new (win.PianoSliderView)().toolbarGroups();
    expect(g.has('wind-panel')).toBe(true);
    expect(g.has('piano-slider')).toBe(true);
  });

  it('ListView exposes list-cc + list-pb', () => {
    const g = new (win.ListView)().toolbarGroups();
    expect(g.has('list-cc')).toBe(true);
    expect(g.has('list-pb')).toBe(true);
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
