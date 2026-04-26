// tests/frontend/hand-position-editor-modal.test.js
// PR7 — focused smoke tests for HandPositionEditorModal's data layer.
// We bypass the full DOM lifecycle (BaseModal, canvas widgets) and
// drive the history / mutation paths directly: open / undo / redo /
// reset / save. The audio + drawing paths are covered by the widget
// tests.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// HandPositionEditorModal extends BaseModal. We provide a minimal
// stub so the script can be loaded inside a Function() wrapper without
// requiring the real CSS / DOM setup.
beforeAll(() => {
  globalThis.window = globalThis.window || {};

  // Minimal BaseModal stub. The methods we need from the real one are
  // `open` (ignored), `close` (just flips isOpen), and `$()` (DOM
  // query against an inline dialog we create).
  class StubBaseModal {
    constructor() {
      this.isOpen = false;
      this.dialog = null;
    }
    open() {
      this.dialog = document.createElement('div');
      this.dialog.innerHTML = this.renderBody() + this.renderFooter();
      this.isOpen = true;
      this.onOpen && this.onOpen();
    }
    close() {
      this.onClose && this.onClose();
      this.dialog = null;
      this.isOpen = false;
    }
    $(sel) { return this.dialog ? this.dialog.querySelector(sel) : null; }
    $$(sel) { return this.dialog ? this.dialog.querySelectorAll(sel) : []; }
    t(k) { return k; }
    escape(s) { return s; }
    renderBody() { return ''; }
    renderFooter() { return ''; }
    onOpen() {}
    onClose() {}
  }
  window.BaseModal = StubBaseModal;

  // The modal calls `_wireEngine` which instantiates HandSimulationEngine
  // and FretboardHandPreview / FretboardTimelineRenderer. We stub them
  // with no-op classes so the unit can construct without canvas APIs.
  class NoopWidget {
    constructor() {}
    setHandTrajectory() {}
    setActivePositions() {}
    setUnplayablePositions() {}
    setLevel() {}
    setCurrentTime() {}
    setTicksPerSec() {}
    setTimeline() {}
    setTrajectory() {}
    setPlayhead() {}
    setPxPerSec() {}
    setScrollSec() {}
    setViewport() {}
    setShowFingerRange() {}
    draw() {}
    destroy() {}
    get pxPerSec() { return 80; }
    get scrollSec() { return 0; }
    _viewportSec() { return 5; }
  }
  window.VerticalFretboardPreview = NoopWidget;
  window.FretboardTimelineRenderer = NoopWidget;
  window.HandEditorMinimap = NoopWidget;

  // Lightweight engine stub — emits no events but exposes the few
  // methods the modal calls.
  class NoopEngine {
    constructor(opts) { this.opts = opts; this._tick = 0; }
    addEventListener() {}
    removeEventListener() {}
    advanceToSec() {}
    currentSec() { return 0; }
    currentTick() { return this._tick; }
    getHandTrajectories() { return new Map(); }
    dispose() {}
    get _timeline() { return []; }
  }
  window.HandSimulationEngine = NoopEngine;

  const src = readFileSync(
    resolve(__dirname, '../../public/js/features/auto-assign/HandPositionEditorModal.js'),
    'utf8'
  );
  new Function(src)();
});

function makeModal(overrides = null) {
  return new window.HandPositionEditorModal({
    fileId: 42,
    channel: 0,
    deviceId: 'guitar-1',
    midiData: { tracks: [] },
    instrument: { tuning: [40, 45, 50, 55, 59, 64], num_frets: 22,
                  hands_config: { enabled: true, mode: 'frets',
                                  hands: [{ id: 'fretting', hand_span_frets: 4 }] } },
    initialOverrides: overrides,
    apiClient: null
  });
}

describe('HandPositionEditorModal — history layer', () => {
  it('starts with a single snapshot and disables undo/redo', () => {
    const m = makeModal();
    expect(m._history.length).toBe(1);
    expect(m._historyIndex).toBe(0);
  });

  it('deep-clones the caller initialOverrides so mutations stay scoped', () => {
    const callerOverrides = { hand_anchors: [], disabled_notes: [], version: 1 };
    const m = makeModal(callerOverrides);
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    expect(callerOverrides.hand_anchors).toEqual([]);
  });

  it('pushHistory snapshots the current overrides', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    expect(m._history.length).toBe(1);
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    m._pushHistory();
    expect(m._history.length).toBe(2);
    expect(m._historyIndex).toBe(1);
    expect(m.isDirty).toBe(true);
  });

  it('undo reverts to the previous snapshot', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    m._pushHistory();
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m._undo();
    expect(m.overrides.hand_anchors).toEqual([]);
    expect(m._historyIndex).toBe(0);
  });

  it('redo replays the next snapshot', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    m._pushHistory();
    m._undo();
    m._redo();
    expect(m.overrides.hand_anchors).toEqual([
      { tick: 0, handId: 'fretting', anchor: 5 }
    ]);
    expect(m._historyIndex).toBe(1);
  });

  it('save records _savedIndex so subsequent undo re-dirties', async () => {
    const sendCommand = vi.fn(async () => ({ success: true, updated: 1 }));
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m.apiClient = { sendCommand };
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m._setStatus = () => {};
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    m._pushHistory();
    expect(m.isDirty).toBe(true);
    await m._save();
    expect(sendCommand).toHaveBeenCalledWith('routing_save_hand_overrides', expect.objectContaining({
      fileId: 42, channel: 0, deviceId: 'guitar-1'
    }));
    expect(m.isDirty).toBe(false);
    m._undo();
    expect(m.isDirty).toBe(true);
  });

  it('pinNoteAssignment pushes a note_assignments entry', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m._pinNoteAssignment(480, 64, 5, 5);
    expect(m.overrides.note_assignments).toEqual([
      { tick: 480, note: 64, string: 5, fret: 5 }
    ]);
    m._pinNoteAssignment(480, 64, 4, 9);
    expect(m.overrides.note_assignments).toEqual([
      { tick: 480, note: 64, string: 4, fret: 9 }
    ]);
  });

  it('clearNoteAssignment removes a single (tick, note) pin', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [],
                          note_assignments: [
                            { tick: 0, note: 60, string: 1, fret: 0 },
                            { tick: 480, note: 64, string: 5, fret: 5 }
                          ], version: 1 });
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m._clearNoteAssignment(480, 64);
    expect(m.overrides.note_assignments).toEqual([
      { tick: 0, note: 60, string: 1, fret: 0 }
    ]);
  });

  it('resetOverrides wipes all three arrays', () => {
    const m = makeModal({
      hand_anchors:      [{ tick: 0, handId: 'fretting', anchor: 5 }],
      disabled_notes:    [{ tick: 0, note: 60 }],
      note_assignments:  [{ tick: 0, note: 60, string: 1, fret: 0 }],
      version: 1
    });
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m._resetOverrides();
    expect(m.overrides.hand_anchors).toEqual([]);
    expect(m.overrides.disabled_notes).toEqual([]);
    expect(m.overrides.note_assignments).toEqual([]);
  });
});

describe('HandPositionEditorModal — close + audio offset + note drag', () => {
  it('close() prompts to discard when there are unsaved changes', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    m.overrides.hand_anchors.push({ tick: 0, handId: 'fretting', anchor: 5 });
    m._pushHistory();
    expect(m.isDirty).toBe(true);
    // Simulate opening so isOpen is true and `super.close()` runs.
    m.open();
    let prompted = 0, accepted = false;
    const realConfirm = window.confirm;
    window.confirm = () => { prompted++; return accepted; };
    m.close();
    expect(prompted).toBe(1);
    expect(m.isOpen).toBe(true); // declined → still open
    accepted = true;
    m.close();
    expect(prompted).toBe(2);
    expect(m.isOpen).toBe(false); // accepted → closed
    window.confirm = realConfirm;
  });

  it('close() does NOT prompt when overrides are clean', () => {
    const m = makeModal({ hand_anchors: [], disabled_notes: [], version: 1 });
    m.open();
    let prompted = 0;
    const realConfirm = window.confirm;
    window.confirm = () => { prompted++; return true; };
    m.close();
    expect(prompted).toBe(0);
    expect(m.isOpen).toBe(false);
    window.confirm = realConfirm;
  });

  it('_onAudioProgress re-bases progress against _playStartSec', () => {
    const m = makeModal();
    let advanced = null;
    m.engine = { advanceToSec: (s) => { advanced = s; } };
    m._maybeFollowPlayhead = () => {};
    m._playStartSec = 12; // simulate previously seeked + played
    m._onAudioProgress(12 + 3); // synth reports 3s into its own frame
    expect(advanced).toBeCloseTo(15, 5);
  });

  it('_onTimelineNoteDrag picks the candidate closest to the cursor fret', () => {
    // Stub the feasibility helper for this test only — full coverage
    // lives in hand-position-feasibility-note-assignments.test.js.
    const realF = window.HandPositionFeasibility;
    window.HandPositionFeasibility = {
      findStringCandidates: () => [
        { string: 6, fret: 0 },
        { string: 5, fret: 5 },
        { string: 4, fret: 9 },
        { string: 3, fret: 14 },
        { string: 2, fret: 19 }
      ]
    };
    const m = makeModal();
    m._scheduleEngineRebuild = () => {};
    m._refreshHistoryButtons = () => {};
    let pinned = null;
    m._pinNoteAssignment = (tick, note, string, fret) => {
      pinned = { tick, note, string, fret };
    };
    const hit = { tick: 480, note: 64, string: 6, fret: 0 };
    m._onTimelineNoteDrag(hit, { fretY: 8.6 }); // closest = fret 9
    expect(pinned).toEqual({ tick: 480, note: 64, string: 4, fret: 9 });
    window.HandPositionFeasibility = realF;
  });
});

describe('HandPositionEditorModal — problem navigation', () => {
  it('builds a sorted problem list from chord + shift events', () => {
    const m = makeModal();
    m._refreshProblemUI = () => {};
    // Default ticksPerSec = ticksPerBeat (480) × bpm/60 (120/60 = 2) = 960
    m._buildProblemList([
      { type: 'chord', tick: 960,  unplayable: [{ note: 60, reason: 'outside_window' }] },
      { type: 'shift', tick: 480,  motion: { feasible: false, requiredSec: 1, availableSec: 0.2 } },
      { type: 'chord', tick: 0,    unplayable: [] }, // no problem → skipped
      { type: 'chord', tick: 1920, unplayable: [{ note: 64, reason: 'too_many_fingers' }] }
    ]);
    expect(m._problems.map(p => p.kind)).toEqual(['speed', 'chord', 'chord']);
    expect(m._problems.map(p => p.sec.toFixed(1))).toEqual(['0.5', '1.0', '2.0']);
  });

  it('next-problem jumps forward; wraps to the first when past the end', () => {
    const m = makeModal();
    let seekedTo = null;
    m._refreshProblemUI = () => {};
    m._seekToSec = (s) => { seekedTo = s; };
    m.engine = { currentSec: () => 1.5 };
    m.timeline = null;
    m._problems = [
      { sec: 0.5, kind: 'speed' },
      { sec: 1.0, kind: 'chord' },
      { sec: 2.0, kind: 'chord' }
    ];
    m._jumpToProblem(+1);
    expect(seekedTo).toBeCloseTo(2.0, 5);
    // Past the last problem → wrap to the first.
    seekedTo = null;
    m.engine = { currentSec: () => 5.0 };
    m._jumpToProblem(+1);
    expect(seekedTo).toBeCloseTo(0.5, 5);
  });

  it('prev-problem jumps backward; wraps to the last when before the start', () => {
    const m = makeModal();
    let seekedTo = null;
    m._refreshProblemUI = () => {};
    m._seekToSec = (s) => { seekedTo = s; };
    m.engine = { currentSec: () => 1.5 };
    m.timeline = null;
    m._problems = [
      { sec: 0.5, kind: 'speed' },
      { sec: 1.0, kind: 'chord' },
      { sec: 2.0, kind: 'chord' }
    ];
    m._jumpToProblem(-1);
    expect(seekedTo).toBeCloseTo(1.0, 5);
    // Before the first problem → wrap to the last.
    seekedTo = null;
    m.engine = { currentSec: () => 0 };
    m._jumpToProblem(-1);
    expect(seekedTo).toBeCloseTo(2.0, 5);
  });
});
