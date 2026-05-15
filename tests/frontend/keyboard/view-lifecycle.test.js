// tests/frontend/keyboard/view-lifecycle.test.js
// Verifies the InstrumentView migration is COMPLETE at the orchestration
// level: the registry is the authoritative owner of the active view's
// lifecycle. setViewMode/_activateView must resolve a registered view,
// mount it, and unmount the previous one — with a safe legacy fallback
// when no view is registered.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  // Migration layer first (InstrumentView → registry → views → bootstrap),
  // then the orchestrator. Mixins are intentionally NOT loaded: the views
  // guard every `modal.*` delegation with typeof checks, so mount()/unmount()
  // are safe no-ops here and we can assert the lifecycle in isolation.
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  load('../../../public/js/features/keyboard/views/PianoView.js');
  load('../../../public/js/features/keyboard/views/FretboardView.js');
  load('../../../public/js/features/keyboard/views/DrumPadView.js');
  load('../../../public/js/features/keyboard/views/PianoSliderView.js');
  load('../../../public/js/features/keyboard/views/ListView.js');
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
  load('../../../public/js/features/KeyboardModal.js');
});

// The mixins (renderFretboard, generatePianoKeys, …) are not loaded in this
// harness — they own DOM rendering and are tested elsewhere/in-browser.
// Stub them as no-ops so we can assert the *lifecycle* (resolve / mount /
// unmount) in isolation. regeneratePianoKeys is a real class method that
// calls the generatePianoKeys mixin, so it must be stubbed too.
function makeModal() {
  const m = new (win.KeyboardModal)();
  for (const fn of ['regeneratePianoKeys', 'generatePianoKeys', 'renderFretboard',
                     'renderDrumPad', 'generatePianoSlider', 'renderKeyboardList']) {
    m[fn] = () => {};
  }
  return m;
}

describe('Registry is the authoritative view owner', () => {
  it('registers the 5 built-in views', () => {
    expect(win.instrumentViews.kinds().sort()).toEqual(
      ['drumpad', 'fretboard', 'keyboard-list', 'piano', 'piano-slider']);
  });

  it('_activateView resolves & mounts the registered view for a kind', () => {
    const m = makeModal();
    m._activateView('fretboard');
    expect(m._activeView).toBeInstanceOf(win.FretboardView);
    expect(m._activeView.mounted).toBe(true);
    expect(m._activeViewKind).toBe('fretboard');
    expect(m._activeView.ctx.modal).toBe(m);
  });

  it('switching kind unmounts the previous view and mounts the new one', () => {
    const m = makeModal();
    m._activateView('fretboard');
    const fretboard = m._activeView;
    m._activateView('piano');
    expect(fretboard.mounted).toBe(false);          // previous torn down
    expect(m._activeView).toBeInstanceOf(win.PianoView);
    expect(m._activeView.mounted).toBe(true);
    expect(m._activeViewKind).toBe('piano');
  });

  it('re-activating the SAME kind does not remount (no churn)', () => {
    const m = makeModal();
    m._activateView('piano');
    const first = m._activeView;
    m._activateView('piano');
    expect(m._activeView).toBe(first);              // same instance reused
    expect(first.mounted).toBe(true);
  });

  it('covers every registered kind end-to-end', () => {
    const m = makeModal();
    for (const kind of ['piano', 'fretboard', 'drumpad', 'piano-slider', 'keyboard-list']) {
      m._activateView(kind);
      expect(m._activeViewKind).toBe(kind);
      expect(m._activeView).toBeInstanceOf(win.instrumentViews.get(kind));
      expect(m._activeView.mounted).toBe(true);
    }
  });
});

describe('Safe legacy fallback (zero-regression guarantee)', () => {
  it('falls back without throwing when no view is registered for the kind', () => {
    const m = makeModal();
    let called = null;
    m.regeneratePianoKeys = () => { called = 'piano'; };
    m.renderFretboard = () => { called = 'fretboard'; };
    expect(() => m._activateView('totally-unknown-kind')).not.toThrow();
    expect(m._activeView).toBeNull();
    expect(m._activeViewKind).toBe('totally-unknown-kind');
    expect(called).toBe('piano'); // legacy switch default branch
  });

  it('legacy fallback routes each known mode to its render method', () => {
    const m = makeModal();
    const hits = [];
    m.renderFretboard      = () => hits.push('fretboard');
    m.renderDrumPad        = () => hits.push('drumpad');
    m.generatePianoSlider  = () => hits.push('piano-slider');
    m.renderKeyboardList   = () => hits.push('keyboard-list');
    m.regeneratePianoKeys  = () => hits.push('piano');
    m._legacyRenderForMode('fretboard');
    m._legacyRenderForMode('drumpad');
    m._legacyRenderForMode('piano-slider');
    m._legacyRenderForMode('keyboard-list');
    m._legacyRenderForMode('piano');
    expect(hits).toEqual(['fretboard', 'drumpad', 'piano-slider', 'keyboard-list', 'piano']);
  });

  it('mount() failure is caught and degrades to the legacy render', () => {
    const m = makeModal();
    let legacy = false;
    // 'broken' is an unknown mode → legacy switch hits the default branch
    // (regeneratePianoKeys).
    m.regeneratePianoKeys = () => { legacy = true; };
    const reg = win.instrumentViews;
    const Broken = class extends win.InstrumentView {
      static viewKind = 'broken';
      mount() { throw new Error('boom'); }
    };
    reg.register(Broken);
    expect(() => m._activateView('broken')).not.toThrow();
    expect(m._activeView).toBeNull();
    expect(m._activeViewKind).toBe('broken');
    expect(legacy).toBe(true);
  });
});
