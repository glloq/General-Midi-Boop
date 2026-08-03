// tests/frontend/keyboard/harmonica-config.test.js
// Harmonica configuration: diatonic key transpose, chromatic solo tuning,
// the slide button (+1 semitone), range-driven hole count, blow/draw row
// labels, and KeyboardModal.getHarmonicaConfig() normalization. The
// unmodified harmonica-view.test.js remains the backward-compat canary.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  load('../../../public/js/features/keyboard/views/PianoView.js');
  load('../../../public/js/features/keyboard/views/FretboardView.js');
  load('../../../public/js/features/keyboard/views/DrumPadView.js');
  load('../../../public/js/features/keyboard/views/PianoSliderView.js');
  load('../../../public/js/features/keyboard/views/ListView.js');
  load('../../../public/js/features/keyboard/HarmonicaLayout.js');
  load('../../../public/js/features/keyboard/views/HarmonicaView.js');
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
  load('../../../public/js/features/KeyboardModal.js');
});

const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

function mountWith(cfg, range, extra = {}) {
  document.body.innerHTML = '<div id="keyboard-canvas-container"></div>';
  const played = [],
    stopped = [];
  const modal = {
    playNote: (n) => played.push(n),
    stopNote: (n) => stopped.push(n),
    getNoteLabel: (n) => `N${n}`,
    getHarmonicaConfig: () => cfg,
    getInstrumentNoteRange: () => range,
    ...extra
  };
  const view = new win.HarmonicaView();
  view.mount({ modal, i18n: extra.i18n });
  const root = document.getElementById('harmonica-container');
  const notes = (kind) =>
    [...root.querySelectorAll(`.harmonica-${kind}`)].map((c) => parseInt(c.dataset.note, 10));
  return { view, root, played, stopped, notes };
}

describe('Harmonica — diatonic key transpose', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('default diatonic C over the configured range is the classic layout', () => {
    const { notes } = mountWith({ type: 'diatonic', key: 'C' }, { min: 60, max: 96 });
    expect(notes('blow')[0]).toBe(60);
    expect(notes('draw')[0]).toBe(62);
    expect(notes('blow').at(-1)).toBe(96);
    expect(notes('blow').length).toBe(10);
  });

  it('key D shifts every hole up 2 semitones; count still clamps to range', () => {
    const c = mountWith({ type: 'diatonic', key: 'C' }, { min: 60, max: 96 });
    const d = mountWith({ type: 'diatonic', key: 'D' }, { min: 60, max: 96 });
    expect(d.notes('blow')[0]).toBe(c.notes('blow')[0] + 2);
    expect(d.notes('draw')[0]).toBe(c.notes('draw')[0] + 2);
    // 98 (hole-10 blow shifted) would exceed 96 → fewer holes than C.
    expect(d.notes('blow').length).toBeLessThan(c.notes('blow').length);
    expect(Math.max(...d.notes('blow'), ...d.notes('draw'))).toBeLessThanOrEqual(96);
  });

  // Regression: a non-C-aligned range minimum (e.g. comfortMin 53, or an
  // auto-centred startNote) used to transpose the whole Richter pattern by
  // a non-octave amount → spurious sharps. A C harmonica must stay natural.
  const BLACK_PC = new Set([1, 3, 6, 8, 10]);
  it('diatonic C stays strictly natural for a non-C-aligned range', () => {
    for (const range of [
      { min: 53, max: 96 },
      { min: 50, max: 89 },
      { min: 48, max: 84 }
    ]) {
      const { notes } = mountWith({ type: 'diatonic', key: 'C' }, range);
      const all = [...notes('blow'), ...notes('draw')];
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((n) => BLACK_PC.has(n % 12))).toBe(false);
    }
  });

  it('diatonic A faithfully reproduces the real instrument accidentals', () => {
    const { notes } = mountWith({ type: 'diatonic', key: 'A' }, { min: 53, max: 96 });
    const pcs = new Set([...notes('blow'), ...notes('draw')].map((n) => n % 12));
    // A-major harp really sounds C#, F#, G#.
    expect(pcs.has(1)).toBe(true); // C#
    expect(pcs.has(6)).toBe(true); // F#
    expect(pcs.has(8)).toBe(true); // G#
  });
});

describe('Harmonica — virtual-piano restriction', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const make = (caps) => {
    const m = new win.KeyboardModal();
    m.selectedDeviceCapabilities = caps;
    return m;
  };

  it('diatonic C harmonica: no black key is playable', () => {
    const m = make({
      gm_program: 22,
      note_range_min: 53,
      note_range_max: 96,
      harmonica_config: { type: 'diatonic', key: 'C' }
    });
    const set = m.getHarmonicaPlayableNotes();
    expect(set).toBeInstanceOf(Set);
    expect([...set].some((n) => [1, 3, 6, 8, 10].includes(n % 12))).toBe(false);
    expect(set.has(60)).toBe(true); // C is in the layout
    expect(set.has(61)).toBe(false); // C# is not
  });

  it('chromatic harmonica imposes no restriction (slide reaches all)', () => {
    const m = make({
      gm_program: 22,
      note_range_min: 60,
      note_range_max: 96,
      harmonica_config: { type: 'chromatic', key: 'C' }
    });
    expect(m.getHarmonicaPlayableNotes()).toBeNull();
  });

  it('a non-harmonica instrument is never restricted', () => {
    const m = make({ gm_program: 0, note_range_min: 21, note_range_max: 108 });
    expect(m.getHarmonicaPlayableNotes()).toBeNull();
  });
});

describe('Harmonica — chromatic solo tuning', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('emits 4-hole groups with C-E-G-C / D-F-A-B offsets', () => {
    const { notes, root } = mountWith({ type: 'chromatic', key: 'C' }, { min: 60, max: 96 });
    const blow = notes('blow'),
      draw = notes('draw');
    expect(blow.slice(0, 4)).toEqual([60, 64, 67, 72]);
    expect(draw.slice(0, 4)).toEqual([62, 65, 69, 71]);
    expect(blow.slice(4, 8)).toEqual([72, 76, 79, 84]); // group 2 (+12)
    expect(blow.length).toBe(12); // 3 groups fit in C4..C7
    expect(
      root.querySelector('.harmonica-chromatic') || root.classList.contains('harmonica-chromatic')
    ).toBeTruthy();
  });

  it('tiny range falls back to a single hole; never crashes', () => {
    const a = mountWith({ type: 'chromatic', key: 'C' }, { min: 60, max: 63 });
    expect(a.notes('blow')).toEqual([60]);
    expect(a.notes('draw')).toEqual([62]);
    const b = mountWith({ type: 'chromatic', key: 'C' }, { min: 60, max: 60 });
    expect(b.notes('blow').length).toBe(1);
    expect(b.notes('draw').length).toBe(1);
  });

  it('large range emits many groups', () => {
    const { notes } = mountWith({ type: 'chromatic', key: 'C' }, { min: 36, max: 96 });
    expect(notes('blow').length).toBeGreaterThanOrEqual(16);
    expect(notes('blow').length % 4).toBe(0);
  });
});

describe('Harmonica — count-driven discrete note selection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // 1 hole = 1 blow + 1 draw, so N discrete notes → round(N/2) holes.
  const consecutive = (lo, n) => Array.from({ length: n }, (_, i) => lo + i);

  it('diatonic: 20 selected notes → 10 holes per row', () => {
    const notesArr = consecutive(60, 20);
    const { notes } = mountWith(
      { type: 'diatonic', key: 'C' },
      { min: 60, max: 79, notes: notesArr }
    );
    expect(notes('blow').length).toBe(10);
    expect(notes('draw').length).toBe(10);
    expect(notes('blow')[0]).toBe(60); // base = lowest selected note
    expect(notes('draw')[0]).toBe(62); // Richter draw offset +2
    expect(notes('blow').at(-1)).toBe(96);
  });

  it('chromatic: 20 selected notes → 10 holes, solo-tuned groups', () => {
    const notesArr = consecutive(60, 20);
    const { notes } = mountWith(
      { type: 'chromatic', key: 'C' },
      { min: 60, max: 79, notes: notesArr }
    );
    expect(notes('blow').length).toBe(10);
    expect(notes('blow').slice(0, 4)).toEqual([60, 64, 67, 72]);
    expect(notes('draw').slice(0, 4)).toEqual([62, 65, 69, 71]);
    expect(notes('blow')[4]).toBe(72); // next group (+12)
  });

  it('diatonic: 40 notes → 20 holes, pattern extended by octave', () => {
    const notesArr = consecutive(36, 40);
    const { notes } = mountWith(
      { type: 'diatonic', key: 'C' },
      { min: 36, max: 75, notes: notesArr }
    );
    const blow = notes('blow');
    expect(blow.length).toBe(20);
    // Beyond the 10-hole reference it tiles by octave (+12, period 3).
    expect(blow[10]).toBe(blow[7] + 12);
    expect(blow.every((n, i) => i === 0 || n > blow[i - 1])).toBe(true);
  });

  it('odd count rounds (21 notes → 11 holes)', () => {
    const notesArr = consecutive(60, 21);
    const { notes } = mountWith(
      { type: 'diatonic', key: 'C' },
      { min: 60, max: 80, notes: notesArr }
    );
    expect(notes('blow').length).toBe(11);
  });

  it('a min/max range without a discrete list keeps the legacy clamp', () => {
    const { notes } = mountWith({ type: 'diatonic', key: 'C' }, { min: 60, max: 96 });
    expect(notes('blow').length).toBe(10); // unchanged reference behaviour
    expect(notes('blow').at(-1)).toBe(96);
  });
});

describe('Harmonica — slide button (chromatic only)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('diatonic has no slide button', () => {
    const { root } = mountWith({ type: 'diatonic', key: 'C' }, { min: 60, max: 96 });
    expect(root.querySelector('.harmonica-slide')).toBeNull();
  });

  it('click toggles the slide; it is NOT dropped by a global pointerup', () => {
    const { root, played, stopped } = mountWith(
      { type: 'chromatic', key: 'C' },
      { min: 60, max: 96 }
    );
    const slide = root.querySelector('.harmonica-slide');
    expect(slide).not.toBeNull();
    expect(slide.getAttribute('aria-pressed')).toBe('false');

    const hole = root.querySelector('.harmonica-blow'); // base 60
    fire(hole, 'pointerdown');
    expect(played).toEqual([60]);

    fire(slide, 'click'); // engage (toggle on)
    expect(stopped).toEqual([60]); // old pitch released
    expect(played).toEqual([60, 61]); // +1 semitone replayed
    expect(slide.classList.contains('engaged')).toBe(true);
    expect(slide.getAttribute('aria-pressed')).toBe('true');

    // A global pointerup releases the held hole but the slide stays latched.
    document.dispatchEvent(new Event('pointerup'));
    expect(stopped).toEqual([60, 61]); // held note released at +1
    expect(slide.classList.contains('engaged')).toBe(true); // still on
    expect(root.querySelectorAll('.harmonica-hole.active').length).toBe(0);

    fire(slide, 'click'); // click again → release
    expect(slide.classList.contains('engaged')).toBe(false);
    expect(slide.getAttribute('aria-pressed')).toBe('false');
  });

  it('pressing a hole while engaged plays the shifted pitch', () => {
    const { root, played } = mountWith({ type: 'chromatic', key: 'C' }, { min: 60, max: 96 });
    const slide = root.querySelector('.harmonica-slide');
    fire(slide, 'click');
    const hole = root.querySelector('.harmonica-blow'); // base 60
    fire(hole, 'pointerdown');
    expect(played).toEqual([61]);
  });

  it('toggling the slide rewrites the displayed note labels', () => {
    const { root } = mountWith({ type: 'chromatic', key: 'C' }, { min: 60, max: 96 });
    const hole = root.querySelector('.harmonica-blow'); // base 60
    const noteEl = hole.querySelector('.harmonica-hole-note');
    expect(noteEl.textContent).toBe('N60');
    const slide = root.querySelector('.harmonica-slide');
    fire(slide, 'click');
    expect(noteEl.textContent).toBe('N61'); // shifted +1
    fire(slide, 'click');
    expect(noteEl.textContent).toBe('N60'); // restored
  });
});

describe('Harmonica — row labels', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders Souffler/Aspirer fallbacks without i18n', () => {
    const { root } = mountWith({ type: 'diatonic', key: 'C' }, { min: 60, max: 96 });
    expect(root.querySelector('.harmonica-row-label-blow').textContent).toContain('Souffler');
    expect(root.querySelector('.harmonica-row-label-draw').textContent).toContain('Aspirer');
  });

  it('uses ctx.i18n.t when provided', () => {
    const t = (k) =>
      ({
        'keyboard.harmonicaBlow': 'Blow',
        'keyboard.harmonicaDraw': 'Draw'
      })[k] || k;
    const { root } = mountWith(
      { type: 'diatonic', key: 'C' },
      { min: 60, max: 96 },
      { i18n: { t } }
    );
    expect(root.querySelector('.harmonica-row-label-blow').textContent).toBe('Blow');
    expect(root.querySelector('.harmonica-row-label-draw').textContent).toBe('Draw');
  });
});

describe('KeyboardModal.getHarmonicaConfig', () => {
  it('defaults to diatonic C for null / garbage configs', () => {
    const m = new win.KeyboardModal();
    m.selectedDeviceCapabilities = null;
    expect(m.getHarmonicaConfig()).toEqual({ type: 'diatonic', key: 'C' });
    m.selectedDeviceCapabilities = { harmonica_config: { type: 'x', key: 'H' } };
    expect(m.getHarmonicaConfig()).toEqual({ type: 'diatonic', key: 'C' });
  });

  it('honours valid values', () => {
    const m = new win.KeyboardModal();
    m.selectedDeviceCapabilities = { harmonica_config: { type: 'chromatic', key: 'F#' } };
    expect(m.getHarmonicaConfig()).toEqual({ type: 'chromatic', key: 'F#' });
  });
});

describe('Harmonica — chromatic still routes to the harmonica view', () => {
  it('GM22 + chromatic config is NOT diverted to keyboard-list', () => {
    // harmonica_config.type is independent of caps.keyboard_type — the
    // detector only sees gm_program here.
    const d = win.InstrumentDetector.detect({
      capabilities: { gm_program: 22, harmonica_config: { type: 'chromatic' } }
    });
    expect(d.viewKind).toBe('harmonica');
  });
});
