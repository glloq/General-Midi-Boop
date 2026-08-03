// tests/frontend/instrument-scale-root.test.js
// computePlayableNotes must key the diatonic/pentatonic scale off `root`
// (pitch class 0..11) instead of always assuming C — the fix for an instrument
// tuned to a non-C tonic materializing the wrong notes.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let computePlayableNotes;
beforeAll(() => {
  // The modal class `extends BaseModal` and mixes in ISMSections/… at load via
  // Object.assign. Stub all of them so the file evaluates without the full
  // modal stack — we only exercise the static, DOM-free computePlayableNotes.
  const src = readFileSync(
    resolve(__dirname, '../../public/js/features/InstrumentSettingsModal.js'),
    'utf8'
  );
  const out = {};
  new Function(
    'BaseModal',
    'ISMSections',
    'ISMNavigation',
    'ISMSave',
    'ISMListeners',
    'window',
    'out',
    src + '\nout.ISM = InstrumentSettingsModal;'
  )(class {}, {}, {}, {}, {}, globalThis.window || globalThis, out);
  computePlayableNotes = out.ISM.computePlayableNotes.bind(out.ISM);
});

describe('computePlayableNotes — scale root', () => {
  it('chromatic returns every note regardless of root', () => {
    expect(computePlayableNotes(60, 63, 'chromatic', 7)).toEqual([60, 61, 62, 63]);
  });

  it('diatonic in C (root 0) is the C-major subset', () => {
    // C major over one octave: C D E F G A B
    expect(computePlayableNotes(60, 72, 'diatonic', 0)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('diatonic in G (root 7) shifts the scale up a fifth', () => {
    // G major over one octave: G A B C D E F# → includes F#(66), excludes F(65)
    const notes = computePlayableNotes(60, 72, 'diatonic', 7);
    expect(notes).toContain(66); // F#
    expect(notes).not.toContain(65); // F natural
    expect(notes).toContain(67); // G (tonic)
  });

  it('pentatonic in D (root 2) picks the D major pentatonic degrees', () => {
    // D major pentatonic pitch classes: D E F# A B → within 62..73 that's
    // 62(D) 64(E) 66(F#) 69(A) 71(B); 73 is pc 1 (C#), not in scale.
    expect(computePlayableNotes(62, 73, 'pentatonic', 2)).toEqual([62, 64, 66, 69, 71]);
  });

  it('defaults root to 0 (C) when omitted — backward compatible', () => {
    expect(computePlayableNotes(60, 72, 'diatonic')).toEqual(
      computePlayableNotes(60, 72, 'diatonic', 0)
    );
  });
});
