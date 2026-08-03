// tests/frontend/keyboard/keyboard-modal-pure.test.js
// Unit tests for the pure, DOM-free helpers on KeyboardModal:
//   - getNoteLabel / getNoteNameFromNumber   (notation formatting)
//   - _getStringPresetForGmProgram           (GM → fretboard geometry)
//   - _resolveKeyToNote                       (PC keyboard AZERTY/QWERTY)
//
// These methods were previously uncovered (audit 2026-05-15). The modal
// constructor only touches window.api / window.eventBus lazily, so it
// instantiates cleanly under jsdom without the DOM-heavy mixins.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  // KeyboardEvents.js exposes window.KeyboardEventsMixin (carries
  // _resolveKeyToNote). Load it first, then the main class.
  load('../../../public/js/features/keyboard/KeyboardEvents.js');
  load('../../../public/js/features/KeyboardModal.js');
});

const makeModal = () => new win.KeyboardModal();

describe('KeyboardModal.getNoteLabel — notation formats', () => {
  it('english (default): middle C is C4, MIDI 54 is F#3', () => {
    const m = makeModal();
    m.noteLabelFormat = 'english';
    expect(m.getNoteLabel(60)).toBe('C4');
    expect(m.getNoteLabel(54)).toBe('F#3');
  });

  it('solfege: middle C is Do4, MIDI 54 is Fa#3', () => {
    const m = makeModal();
    m.noteLabelFormat = 'solfege';
    expect(m.getNoteLabel(60)).toBe('Do4');
    expect(m.getNoteLabel(54)).toBe('Fa#3');
  });

  it('midi: returns the raw number as a string', () => {
    const m = makeModal();
    m.noteLabelFormat = 'midi';
    expect(m.getNoteLabel(60)).toBe('60');
    expect(m.getNoteLabel(0)).toBe('0');
    expect(m.getNoteLabel(127)).toBe('127');
  });

  it('extreme MIDI range stays consistent (0=C-1, 21=A0, 108=C8, 127=G9)', () => {
    const m = makeModal();
    m.noteLabelFormat = 'english';
    expect(m.getNoteLabel(0)).toBe('C-1');
    expect(m.getNoteLabel(21)).toBe('A0');
    expect(m.getNoteLabel(108)).toBe('C8');
    expect(m.getNoteLabel(127)).toBe('G9');
  });

  it('getNoteNameFromNumber is always english regardless of format', () => {
    const m = makeModal();
    m.noteLabelFormat = 'solfege';
    expect(m.getNoteNameFromNumber(60)).toBe('C4');
    expect(m.getNoteNameFromNumber(54)).toBe('F#3');
  });
});

describe('KeyboardModal._getStringPresetForGmProgram', () => {
  it('returns null for null/undefined and non-string GM programs', () => {
    const m = makeModal();
    expect(m._getStringPresetForGmProgram(null)).toBeNull();
    expect(m._getStringPresetForGmProgram(undefined)).toBeNull();
    expect(m._getStringPresetForGmProgram(0)).toBeNull(); // grand piano
    expect(m._getStringPresetForGmProgram(56)).toBeNull(); // trumpet (wind)
  });

  it('acoustic guitars (24 nylon / 25 steel) — 6 strings, EADGBE', () => {
    const m = makeModal();
    expect(m._getStringPresetForGmProgram(24)).toEqual({
      num_strings: 6,
      num_frets: 19,
      tuning: [40, 45, 50, 55, 59, 64],
      is_fretless: false
    });
    expect(m._getStringPresetForGmProgram(25).num_frets).toBe(20);
  });

  it('electric guitars (26-31) — 6 strings, 22 frets', () => {
    const m = makeModal();
    for (const gm of [26, 27, 28, 29, 30, 31]) {
      const p = m._getStringPresetForGmProgram(gm);
      expect(p.num_strings).toBe(6);
      expect(p.num_frets).toBe(22);
      expect(p.is_fretless).toBe(false);
    }
  });

  it('basses: 32 acoustic fretted, 35 fretless, 33-39 fretted', () => {
    const m = makeModal();
    expect(m._getStringPresetForGmProgram(32)).toEqual({
      num_strings: 4,
      num_frets: 20,
      tuning: [28, 33, 38, 43],
      is_fretless: false
    });
    // 35 must be evaluated before the 33-39 range → fretless
    expect(m._getStringPresetForGmProgram(35)).toEqual({
      num_strings: 4,
      num_frets: 0,
      tuning: [28, 33, 38, 43],
      is_fretless: true
    });
    for (const gm of [33, 34, 36, 37, 38, 39]) {
      const p = m._getStringPresetForGmProgram(gm);
      expect(p.num_strings).toBe(4);
      expect(p.num_frets).toBe(22);
      expect(p.is_fretless).toBe(false);
    }
  });

  it('bowed strings are fretless with idiomatic tunings', () => {
    const m = makeModal();
    expect(m._getStringPresetForGmProgram(40).tuning).toEqual([55, 62, 69, 76]); // violin
    expect(m._getStringPresetForGmProgram(110).tuning).toEqual([55, 62, 69, 76]); // fiddle
    expect(m._getStringPresetForGmProgram(41).tuning).toEqual([48, 55, 62, 69]); // viola
    expect(m._getStringPresetForGmProgram(42).tuning).toEqual([36, 43, 50, 57]); // cello
    expect(m._getStringPresetForGmProgram(43).tuning).toEqual([28, 33, 38, 43]); // contrabass
    for (const gm of [40, 41, 42, 43, 44, 45, 110]) {
      expect(m._getStringPresetForGmProgram(gm).is_fretless).toBe(true);
    }
  });

  it('ethnic plucked & harp presets', () => {
    const m = makeModal();
    // Harp: 47-string concert harp, C-major diatonic C1 (24) → G7 (103).
    const harp = m._getStringPresetForGmProgram(46);
    expect(harp.num_strings).toBe(47);
    expect(harp.num_frets).toBe(0);
    expect(harp.is_fretless).toBe(true);
    expect(harp.tuning.length).toBe(47);
    expect(harp.tuning[0]).toBe(24); // C1
    expect(harp.tuning[46]).toBe(103); // G7
    // Diatonic C-major: no accidentals.
    const scale = new Set([0, 2, 4, 5, 7, 9, 11]);
    for (const n of harp.tuning) expect(scale.has(n % 12)).toBe(true);
    expect(m._getStringPresetForGmProgram(104).num_strings).toBe(7); // sitar
    expect(m._getStringPresetForGmProgram(105).num_strings).toBe(5); // banjo
    expect(m._getStringPresetForGmProgram(106).num_strings).toBe(3); // shamisen
    expect(m._getStringPresetForGmProgram(107).num_strings).toBe(13); // koto
  });
});

describe('KeyboardModal._resolveKeyToNote — PC keyboard mapping', () => {
  // Minimal `this` context: the method only reads keyboardLayout +
  // visibleWhiteNotes + visibleBlackNotes.
  const resolve_ = (win) => win.KeyboardEventsMixin._resolveKeyToNote;
  const ctx = (layout) => ({
    keyboardLayout: layout,
    // One octave starting at middle C (C4=60 .. B4=71)
    visibleWhiteNotes: [60, 62, 64, 65, 67, 69, 71],
    visibleBlackNotes: [61, 63, 66, 68, 70]
  });

  it('AZERTY: white-key row maps in order from the first visible white note', () => {
    const r = resolve_(win);
    const c = ctx('azerty');
    expect(r.call(c, 'KeyA')).toBe(60); // Q (azerty) → first white
    expect(r.call(c, 'KeyS')).toBe(62);
    expect(r.call(c, 'KeyD')).toBe(64);
    expect(r.call(c, 'KeyF')).toBe(65);
  });

  it('AZERTY: black keys resolve one semitone above the matching white', () => {
    const r = resolve_(win);
    const c = ctx('azerty');
    expect(r.call(c, 'KeyW')).toBe(61); // Z → C#4 (above white idx 0 = 60)
    expect(r.call(c, 'KeyE')).toBe(63); // E → D#4
  });

  it('QWERTY: white row starts at KeyS, no KeyA mapping', () => {
    const r = resolve_(win);
    const c = ctx('qwerty');
    expect(r.call(c, 'KeyS')).toBe(60);
    expect(r.call(c, 'KeyD')).toBe(62);
    expect(r.call(c, 'KeyA')).toBeNull(); // unmapped in QWERTY
  });

  it('returns null for unmapped codes and out-of-range indices', () => {
    const r = resolve_(win);
    const c = ctx('azerty');
    expect(r.call(c, 'Digit1')).toBeNull();
    // Backslash → white index 11, but only 7 white notes are visible
    expect(r.call(c, 'Backslash')).toBeNull();
  });

  it('returns null when the implied black note is not currently visible', () => {
    const r = resolve_(win);
    const c = { keyboardLayout: 'azerty', visibleWhiteNotes: [60, 62], visibleBlackNotes: [] };
    expect(r.call(c, 'KeyW')).toBeNull(); // C#4 would be 61 but none visible
  });
});
