// tests/frontend/keyboard/view-lifecycle.test.js
// Verifies the InstrumentView migration is COMPLETE at the orchestration
// level: the registry is the authoritative owner of the active view's
// lifecycle. setViewMode/_activateView must resolve a registered view,
// mount it, and unmount the previous one — with a safe legacy fallback
// when no view is registered.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
  load('../../../public/js/features/keyboard/KeyboardEvents.js'); // playNote/stopNote
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

  // Regression: close() must unmount the active view and clear
  // _activeView/_activeViewKind. Otherwise the view's document-level
  // listeners leak and a reopen hits the same-kind fast-path, reusing a
  // view bound to DOM that close() removed. (Mixins aren't applied in this
  // sandbox, so detachEvents is stubbed; the collections are set explicitly.)
  it('close() unmounts the active view and clears it so a reopen re-mounts', () => {
    const m = makeModal();
    m.detachEvents = () => {};
    m.activeNotes = new Set();
    m.mouseActiveNotes = new Set();
    m.activeFretPositions = new Set();
    m.isOpen = true;

    m._activateView('fretboard');
    const view = m._activeView;
    expect(view.mounted).toBe(true);

    m.close();
    expect(view.mounted).toBe(false);        // unmount() ran
    expect(m._activeView).toBeNull();
    expect(m._activeViewKind).toBeNull();

    // Reopen + same kind: must build a fresh view, not reuse the stale one.
    m._activateView('fretboard');
    expect(m._activeView).not.toBe(view);
    expect(m._activeView.mounted).toBe(true);
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

// ── KM-C4: playNote routes through the active view's willPlayNote /
//    afterPlayNote (replaces the removed _windOrigPlayNote hack) ─────────────
describe('playNote ↔ InstrumentView contract (KM-C4)', () => {
  // The harness can't apply mixins (new Function sandbox breaks the
  // `typeof KeyboardEventsMixin` guard), so call the real playNote with a
  // controlled context — same isolated pattern as keyboard-modal-pure.
  const play = (over, note) => {
    const out = [];
    const ctx = {
      velocity: 80,
      activeNotes: new Set(),
      updatePianoDisplay() {},
      selectedDevice: null,
      backend: null,
      _panelCallbacks: { onNoteOn: (n, v) => out.push([n, v]) },
      ...over
    };
    win.KeyboardEventsMixin.playNote.call(ctx, note);
    return { ctx, out };
  };

  it('willPlayNote transforms the velocity actually sent', () => {
    const { ctx, out } = play(
      { _activeView: { willPlayNote: (n, v) => ({ midi: n, velocity: v + 7 }) } }, 60);
    expect(out).toEqual([[60, 87]]);
    expect(ctx.activeNotes.has(60)).toBe(true);
  });

  it('willPlayNote can remap the midi note', () => {
    const { ctx, out } = play(
      { _activeView: { willPlayNote: (n, v) => ({ midi: n + 12, velocity: v }) } }, 60);
    expect(out).toEqual([[72, 80]]);
    expect(ctx.activeNotes.has(72)).toBe(true);
    expect(ctx.activeNotes.has(60)).toBe(false);
  });

  it('willPlayNote returning false cancels the note entirely', () => {
    const { ctx, out } = play({ _activeView: { willPlayNote: () => false } }, 60);
    expect(out).toEqual([]);
    expect(ctx.activeNotes.size).toBe(0);
  });

  it('afterPlayNote is invoked after the note-on', () => {
    const seen = [];
    play({ _activeView: { afterPlayNote: (n) => seen.push(n) } }, 64);
    expect(seen).toEqual([64]);
  });

  it('no active view → playNote behaves as before (identity)', () => {
    const { out } = play({ _activeView: null }, 60);
    expect(out).toEqual([[60, 80]]);
  });
});

describe('PianoSliderView — wind articulation + staccato (KM-C4)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('willPlayNote scales velocity by the current articulation factor', () => {
    const v = new (win.PianoSliderView)();
    v.ctx = { modal: { currentArticulation: 'accent' } };  // ×1.2
    expect(v.willPlayNote(60, 100).velocity).toBe(120);
    v.ctx.modal.currentArticulation = 'staccato';          // ×0.9
    expect(v.willPlayNote(60, 100).velocity).toBe(90);
    v.ctx.modal.currentArticulation = 'normal';            // ×1
    expect(v.willPlayNote(60, 100).velocity).toBe(100);
  });

  it('afterPlayNote auto-stops the note after ~120ms when staccato', () => {
    vi.useFakeTimers();
    const stopped = [];
    const modal = {
      currentArticulation: 'staccato',
      activeNotes: new Set([60]),
      stopNote: (n) => stopped.push(n),
      generatePianoSlider: undefined
    };
    const v = new (win.PianoSliderView)();
    v.mount({ modal });
    v.afterPlayNote(60);
    expect(stopped).toEqual([]);            // not yet
    vi.advanceTimersByTime(120);
    expect(stopped).toEqual([60]);          // auto note-off fired
    v.unmount();
  });

  it('afterPlayNote does nothing when articulation is not staccato', () => {
    vi.useFakeTimers();
    const stopped = [];
    const v = new (win.PianoSliderView)();
    v.mount({ modal: { currentArticulation: 'legato', activeNotes: new Set([60]),
                        stopNote: (n) => stopped.push(n) } });
    v.afterPlayNote(60);
    vi.advanceTimersByTime(500);
    expect(stopped).toEqual([]);
    v.unmount();
  });

  it('unmount() clears pending staccato timers (no leak)', () => {
    vi.useFakeTimers();
    const stopped = [];
    const v = new (win.PianoSliderView)();
    v.mount({ modal: { currentArticulation: 'staccato', activeNotes: new Set([60]),
                        stopNote: (n) => stopped.push(n) } });
    v.afterPlayNote(60);
    v.unmount();                            // cancels the timer
    vi.advanceTimersByTime(500);
    expect(stopped).toEqual([]);
  });
});
