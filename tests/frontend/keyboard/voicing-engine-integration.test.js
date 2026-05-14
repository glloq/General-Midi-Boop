// tests/frontend/keyboard/voicing-engine-integration.test.js
// Phase E (KM-E6): ensure KeyboardChords._mapChordToStrings now delegates
// to the pure VoicingEngine module when it's loaded, producing identical
// output to a direct engine call. Falls back to the inline implementation
// otherwise (verified by passing a window with no VoicingEngine).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadFresh(paths) {
  const w = {};
  for (const p of paths) {
    const src = readFileSync(resolve(__dirname, p), 'utf8');
    new Function('window', src)(w);
  }
  return w;
}

// Helper: extract the chords mixin from a freshly loaded module set and
// invoke _mapChordToStrings with a `this` whose prototype is the mixin
// (mimicking how Object.assign would attach the methods to the modal
// prototype in production).
function makeReceiver(win) {
  return Object.create(win.KeyboardChordsMixin);
}
function callMap(win, { rootClass, intervals, tuning, maxPoly }, receiver) {
  const self = receiver || makeReceiver(win);
  return win.KeyboardChordsMixin._mapChordToStrings.call(self, rootClass, intervals, tuning, maxPoly);
}

describe('KeyboardChords._mapChordToStrings — VoicingEngine delegation', () => {
  it('produces the same voicing as direct VoicingEngine.mapChordToStrings', () => {
    // Load engine + mixin in one window so the mixin sees VoicingEngine.
    const w = loadFresh([
      '../../../public/js/features/keyboard/VoicingEngine.js',
      '../../../public/js/features/keyboard/KeyboardChords.js'
    ]);

    const tuning = [40, 45, 50, 55, 59, 64]; // standard guitar
    const directEngine = new w.VoicingEngine(tuning, 6);
    const direct = directEngine.mapChordToStrings(0, [0, 4, 7]); // C major

    const viaMixin = callMap(w, { rootClass: 0, intervals: [0, 4, 7], tuning, maxPoly: 6 });

    expect(viaMixin.length).toBe(direct.length);
    for (let i = 0; i < direct.length; i++) {
      expect(viaMixin[i].string).toBe(direct[i].string);
      expect(viaMixin[i].note).toBe(direct[i].note);
      expect(viaMixin[i].fret).toBe(direct[i].fret);
    }
  });

  it('honours maxPoly cap', () => {
    const w = loadFresh([
      '../../../public/js/features/keyboard/VoicingEngine.js',
      '../../../public/js/features/keyboard/KeyboardChords.js'
    ]);
    const tuning = [40, 45, 50, 55, 59, 64];
    const result = callMap(w, { rootClass: 0, intervals: [0, 4, 7], tuning, maxPoly: 3 });
    expect(result.length).toBe(3);
  });

  it('falls back to inline implementation when VoicingEngine is missing', () => {
    const w = loadFresh([
      // skip VoicingEngine.js
      '../../../public/js/features/keyboard/KeyboardChords.js'
    ]);
    const tuning = [40, 45, 50, 55, 59, 64];
    const result = callMap(w, { rootClass: 0, intervals: [0, 4, 7], tuning, maxPoly: 6 });
    expect(result.length).toBe(6);
    // Sanity: first string note class == rootClass 0 (C)
    expect(result[0].note % 12).toBe(0);
  });

  it('caches the VoicingEngine per receiver + tuning', () => {
    const w = loadFresh([
      '../../../public/js/features/keyboard/VoicingEngine.js',
      '../../../public/js/features/keyboard/KeyboardChords.js'
    ]);
    const self = makeReceiver(w);
    const tuning = [40, 45, 50, 55, 59, 64];
    callMap(w, { rootClass: 0, intervals: [0, 4, 7], tuning, maxPoly: 6 }, self);
    const first = self._voicingEngine;
    callMap(w, { rootClass: 9, intervals: [0, 3, 7], tuning, maxPoly: 6 }, self);
    expect(self._voicingEngine).toBe(first); // same instance

    // Different tuning → fresh engine
    callMap(w, { rootClass: 0, intervals: [0, 4, 7], tuning: [28, 33, 38, 43], maxPoly: 4 }, self);
    expect(self._voicingEngine).not.toBe(first);
  });
});

describe('KeyboardModal._on / _offAll — tracked DOM listeners', () => {
  it('tracks and removes listeners through the helpers', () => {
    // Minimal DOM stub for the test.
    let calls = 0;
    const handler = () => calls++;
    const el = {
      _listeners: [],
      addEventListener(evt, h) { this._listeners.push({ evt, h }); },
      removeEventListener(evt, h) {
        this._listeners = this._listeners.filter(L => !(L.evt === evt && L.h === h));
      },
      dispatch(evt) { this._listeners.filter(L => L.evt === evt).forEach(L => L.h()); }
    };

    // Build a minimal "modal" with just the helpers attached.
    const w = loadFresh([
      '../../../public/js/features/KeyboardModal.js'
    ]);
    const proto = w.KeyboardModal && w.KeyboardModal.prototype;
    expect(typeof proto._on).toBe('function');
    expect(typeof proto._offAll).toBe('function');

    const instance = Object.create(proto);
    instance._on(el, 'click', handler);
    instance._on(el, 'click', handler); // duplicate intentional
    expect(el._listeners.length).toBe(2);

    el.dispatch('click');
    expect(calls).toBe(2);

    instance._offAll();
    expect(el._listeners.length).toBe(0);
    expect(instance._trackedListeners.length).toBe(0);

    // After cleanup, dispatch is a no-op.
    el.dispatch('click');
    expect(calls).toBe(2);
  });
});
