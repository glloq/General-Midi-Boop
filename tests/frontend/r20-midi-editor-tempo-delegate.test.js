// tests/frontend/r20-midi-editor-tempo-delegate.test.js
//
// Audit F-86 — "the MIDI editor's tempo control is dead and throws a
// TypeError". Not R20's finding, but a two-line one in R20's own perimeter, so
// it was taken while passing through.
//
// The tempo <input> called `this.modal.setTempo(...)`. That method moved to the
// `editActions` sub-component when the prototype mixins were rewritten and the
// delegate was never added, so **every keystroke raised an uncaught
// `TypeError`** and nothing was applied. The E2E harness recorded four of them
// per edit (08_E2E.md §3.5) — a control that looks alive and does nothing.
//
// This guard is deliberately about the *call site*: `MidiEditorEditActions`
// already has behavioural tests (midi-editor-tempo-silent.test.js), and
// `attachEvents()` cannot be exercised in isolation without standing up the
// whole editor. The browser proof is 02-canonical's "the MIDI editor's tempo
// control applies the tempo it displays", which is green again.
//
// NOTE — what this does NOT close: the header tempo still never reaches the
// SAVED file. `MidiEditorMidiWriter` rebuilds the tempo events from
// `modal.tempoEvents` (the tempo map) whenever it is non-empty, and the header
// input only writes `modal.tempo`. See docs/audit/2026-09-07/WAVE4_R20.md §5.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

describe('F-86 · the editor tempo input reaches the method that exists', () => {
  const events = read('public/js/features/midi-editor/MidiEditorEvents.js');

  it('never calls the delegate that was removed with the mixins', () => {
    expect(/this\.modal\.setTempo\s*\(/.test(events)).toBe(false);
  });

  it('routes both the typing and the committing handler through editActions', () => {
    const calls = events.match(/this\.modal\.editActions\?\.setTempo\(/g) || [];
    // One for `input` (silent, real-time feedback) and one for `change` (the
    // committing edit that logs and toasts once).
    expect(calls.length).toBe(2);
    expect(events).toContain('this.modal.editActions?.setTempo(newTempo, { silent: true })');
  });

  it('and the target really exists on the sub-component', () => {
    const actions = read('public/js/features/midi-editor/MidiEditorEditActions.js');
    new Function(`${actions}\nreturn window.MidiEditorEditActions;`)();
    expect(typeof window.MidiEditorEditActions.prototype.setTempo).toBe('function');
  });
});
