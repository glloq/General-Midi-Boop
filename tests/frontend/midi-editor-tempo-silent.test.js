// tests/frontend/midi-editor-tempo-silent.test.js
//
// Audit D N2: the tempo <input> fires setTempo() on every keystroke, which
// marked the file dirty AND raised a toast each time. setTempo now takes
// { silent } so the real-time input path applies the tempo (piano-roll/synth
// feedback) without the per-keystroke toast/log; the committing `change` path
// toasts once.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../../public/js/features/midi-editor/MidiEditorEditActions.js'),
  'utf8'
);
new Function(source)();
const MidiEditorEditActions = /** @type {any} */ (globalThis.window.MidiEditorEditActions);

function makeCtx() {
  const notifications = [];
  const modal = {
    tempo: 120,
    isDirty: false,
    log: vi.fn(),
    t: (k) => k,
    routingOps: { updateSaveButton: vi.fn() },
    pianoRollRenderer: null,
    synthesizer: { tempo: 120 },
    showNotification: (msg) => notifications.push(msg)
  };
  // setTempo only reads this.modal, so a bare context is enough.
  return { ctx: { modal }, modal, notifications };
}

describe('MidiEditorEditActions.setTempo silent mode (audit D N2)', () => {
  const setTempo = MidiEditorEditActions.prototype.setTempo;

  it('silent update applies the tempo but raises no toast', () => {
    const { ctx, modal, notifications } = makeCtx();
    setTempo.call(ctx, 150, { silent: true });
    expect(modal.tempo).toBe(150);
    expect(modal.isDirty).toBe(true);
    expect(modal.synthesizer.tempo).toBe(150);
    expect(notifications).toHaveLength(0);
  });

  it('non-silent (commit) update toasts exactly once', () => {
    const { ctx, modal, notifications } = makeCtx();
    setTempo.call(ctx, 160);
    expect(modal.tempo).toBe(160);
    expect(notifications).toHaveLength(1);
  });

  it('typing "150" (3 silent inputs) then committing yields a single toast', () => {
    const { ctx, notifications } = makeCtx();
    setTempo.call(ctx, 1, { silent: true }); // rejected (<20) — no-op, no toast
    setTempo.call(ctx, 15, { silent: true }); // rejected (<20)
    setTempo.call(ctx, 150, { silent: true }); // applied, silent
    expect(notifications).toHaveLength(0);
    setTempo.call(ctx, 150); // commit
    expect(notifications).toHaveLength(1);
  });

  it('still rejects out-of-range tempos', () => {
    const { ctx, modal } = makeCtx();
    setTempo.call(ctx, 5, { silent: true });
    expect(modal.tempo).toBe(120); // unchanged
    setTempo.call(ctx, 999);
    expect(modal.tempo).toBe(120);
  });
});
