// tests/frontend/hands-preview-panel.test.js
// E.6.6: HandsPreviewPanel orchestrates the per-channel preview UI.
// Tests verify the layout dispatch (semitones / frets / unknown),
// the engine wiring (chord events propagate to keyboard / fretboard,
// shift events translate to hand bands), and the public lifecycle
// (play / pause / reset / destroy / setOverrides).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Order matters — dependent modules first so window.* globals exist.
const sources = [
  'public/js/features/auto-assign/HandPositionFeasibility.js',
  'public/js/features/auto-assign/HandSimulationEngine.js',
  'public/js/features/auto-assign/KeyboardPreview.js',
  'public/js/features/auto-assign/HandsLookaheadStrip.js',
  'public/js/features/FretboardDiagram.js',
  'public/js/features/auto-assign/HandsPreviewPanel.js'
];

function installCanvasStub() {
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 8 });
      if (typeof prop === 'string' && /^(setTransform|fillRect|strokeRect|fillText|beginPath|moveTo|lineTo|closePath|fill|stroke|clearRect|save|restore|translate|scale|rotate|setLineDash|rect|clip|arc)$/.test(prop)) {
        return () => {};
      }
      return undefined;
    },
    set() { return true; }
  });
  HTMLCanvasElement.prototype.getContext = () => ctx;
}

beforeAll(() => {
  installCanvasStub();
  for (const rel of sources) {
    const src = readFileSync(resolve(__dirname, '../../', rel), 'utf8');
    new Function(src)();
  }
});

beforeEach(() => {
  document.body.innerHTML = '<div id="container"></div>';
});

const semitonesHands = {
  enabled: true, mode: 'semitones',
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};

const fretsHands = {
  enabled: true, mode: 'frets',
  hand_move_mm_per_sec: 250,
  hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80, hand_span_frets: 4, max_fingers: 4 }]
};

function makePanel(overrideOpts = {}) {
  const container = document.getElementById('container');
  return new window.HandsPreviewPanel(container, {
    channel: 0,
    notes: [{ tick: 0, note: 60 }, { tick: 480, note: 64 }],
    instrument: { hands_config: semitonesHands, note_range_min: 21, note_range_max: 108 },
    ticksPerBeat: 480, bpm: 120,
    ...overrideOpts
  });
}

describe('HandsPreviewPanel — layout dispatch', () => {
  it('semitones mode: renders both look-ahead and keyboard canvases', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-lookahead')).not.toBeNull();
    expect(document.querySelector('.hpp-keyboard')).not.toBeNull();
    expect(document.querySelector('.hpp-fretboard')).toBeNull();
    panel.destroy();
  });

  it('frets mode: renders the fretboard, no keyboard / lookahead', () => {
    const panel = makePanel({
      instrument: {
        hands_config: fretsHands,
        tuning: [40, 45, 50, 55, 59, 64], num_frets: 22
      }
    });
    expect(document.querySelector('.hpp-fretboard')).not.toBeNull();
    expect(document.querySelector('.hpp-keyboard')).toBeNull();
    expect(document.querySelector('.hpp-lookahead')).toBeNull();
    panel.destroy();
  });

  it('unknown mode: shows the no-hands-config message and no canvas', () => {
    const panel = makePanel({ instrument: {} }); // no hands_config
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.hpp-body').textContent).toMatch(/main|hand/i);
    panel.destroy();
  });
});

describe('HandsPreviewPanel — header (no panel-local transport)', () => {
  it('has NO play / pause / reset buttons — transport is driven externally', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-play')).toBeNull();
    expect(document.querySelector('.hpp-pause')).toBeNull();
    expect(document.querySelector('.hpp-reset')).toBeNull();
    panel.destroy();
  });

  it('still exposes the override-edit buttons (Save + Reset overrides)', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-save')).not.toBeNull();
    expect(document.querySelector('.hpp-reset-overrides')).not.toBeNull();
    panel.destroy();
  });

  it('shows a hint pointing the operator at the channel preview button', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-hint').textContent.length).toBeGreaterThan(0);
    panel.destroy();
  });
});

describe('HandsPreviewPanel — setCurrentTime drives the engine', () => {
  it('calls engine.advanceToSec on every setCurrentTime', () => {
    const panel = makePanel();
    const advance = vi.spyOn(panel.engine, 'advanceToSec');
    panel.setCurrentTime(1.5);
    expect(advance).toHaveBeenCalledWith(1.5);
    panel.destroy();
  });

  it('coerces non-finite inputs to 0', () => {
    const panel = makePanel();
    const advance = vi.spyOn(panel.engine, 'advanceToSec');
    panel.setCurrentTime(undefined);
    expect(advance).toHaveBeenCalledWith(0);
    panel.destroy();
  });
});

describe('HandsPreviewPanel — engine wiring (semitones)', () => {
  it('chord event paints active notes on the keyboard', () => {
    const panel = makePanel();
    const setActive = vi.spyOn(panel.keyboard, 'setActiveNotes');
    panel.engine.dispatchEvent(new CustomEvent('chord', {
      detail: { tick: 0, notes: [{ note: 60 }, { note: 64 }], unplayable: [] }
    }));
    expect(setActive).toHaveBeenCalledWith([60, 64]);
    panel.destroy();
  });

  it('chord event with unplayable notes paints them on the keyboard', () => {
    const panel = makePanel();
    const setUnplayable = vi.spyOn(panel.keyboard, 'setUnplayableNotes');
    panel.engine.dispatchEvent(new CustomEvent('chord', {
      detail: { tick: 0, notes: [{ note: 60 }], unplayable: [{ note: 100, handId: 'right' }] }
    }));
    expect(setUnplayable).toHaveBeenCalled();
    const arg = setUnplayable.mock.calls[0][0];
    expect(arg).toEqual([{ note: 100, hand: 'right' }]);
    panel.destroy();
  });

  it('shift event populates the hand band on the keyboard', () => {
    const panel = makePanel();
    const setBands = vi.spyOn(panel.keyboard, 'setHandBands');
    panel.engine.dispatchEvent(new CustomEvent('shift', {
      detail: { handId: 'left', toAnchor: 60 }
    }));
    expect(setBands).toHaveBeenCalled();
    const bands = setBands.mock.calls[0][0];
    expect(bands).toEqual([
      { id: 'left', low: 60, high: 60 + 14, color: expect.any(String) }
    ]);
    panel.destroy();
  });

  it('tick event drives the look-ahead currentTime + onSeek callback', () => {
    const onSeek = vi.fn();
    const panel = makePanel({ onSeek });
    const setTime = vi.spyOn(panel.lookahead, 'setCurrentTime');
    panel.engine.dispatchEvent(new CustomEvent('tick', {
      detail: { currentTick: 240, currentSec: 0.5, totalTicks: 1920 }
    }));
    expect(setTime).toHaveBeenCalledWith(0.5);
    expect(onSeek).toHaveBeenCalledWith(240, 1920);
    panel.destroy();
  });
});

describe('HandsPreviewPanel — engine wiring (frets)', () => {
  it('chord event paints active fret positions on the fretboard', () => {
    const panel = makePanel({
      instrument: {
        hands_config: fretsHands,
        tuning: [40, 45, 50, 55, 59, 64], num_frets: 22
      },
      notes: [{ tick: 0, note: 50, fret: 5, string: 3 }]
    });
    const setPositions = vi.spyOn(panel.fretboard, 'setActivePositions');
    panel.engine.dispatchEvent(new CustomEvent('chord', {
      detail: { tick: 0, notes: [{ note: 50, fret: 5, string: 3, velocity: 100 }], unplayable: [] }
    }));
    expect(setPositions).toHaveBeenCalledWith([{ string: 3, fret: 5, velocity: 100 }]);
    panel.destroy();
  });

  it('shift event sets the hand window on the fretboard', () => {
    const panel = makePanel({
      instrument: {
        hands_config: fretsHands,
        tuning: [40, 45, 50, 55, 59, 64], num_frets: 22
      }
    });
    const setHand = vi.spyOn(panel.fretboard, 'setHandWindow');
    panel.engine.dispatchEvent(new CustomEvent('shift', {
      detail: { handId: 'fretting', toAnchor: 5 }
    }));
    expect(setHand).toHaveBeenCalledWith({
      anchorFret: 5, spanFrets: 4, level: 'ok'
    });
    panel.destroy();
  });
});

describe('HandsPreviewPanel — edit mode (E.6.8)', () => {
  it('toggleDisabledNote adds an entry on first call, removes on second', () => {
    const panel = makePanel();
    expect(panel.overrides).toBeFalsy();
    panel.toggleDisabledNote(60);
    expect(panel.overrides.disabled_notes).toHaveLength(1);
    expect(panel.overrides.disabled_notes[0]).toMatchObject({ tick: 0, note: 60 });
    panel.toggleDisabledNote(60);
    expect(panel.overrides.disabled_notes).toHaveLength(0);
    panel.destroy();
  });

  it('toggleDisabledNote ignores non-finite midi numbers', () => {
    const panel = makePanel();
    panel.toggleDisabledNote(NaN);
    panel.toggleDisabledNote(undefined);
    expect(panel.overrides).toBeFalsy();
    panel.destroy();
  });

  it('keyboard click triggers toggleDisabledNote (semitones layout)', () => {
    const panel = makePanel();
    panel.keyboard.onKeyClick(64);
    expect(panel.overrides.disabled_notes.find(n => n.note === 64)).toBeDefined();
    panel.destroy();
  });

  it('host can short-circuit the keyboard click by returning false', () => {
    const handled = vi.fn(() => false);
    const panel = makePanel({ onKeyClick: handled });
    panel.keyboard.onKeyClick(60);
    expect(handled).toHaveBeenCalledWith(60);
    expect(panel.overrides).toBeFalsy();
    panel.destroy();
  });

  it('pinHandAnchor records / replaces an entry at the current tick', () => {
    const panel = makePanel();
    panel.pinHandAnchor('left', 60);
    expect(panel.overrides.hand_anchors).toHaveLength(1);
    expect(panel.overrides.hand_anchors[0]).toEqual({ tick: 0, handId: 'left', anchor: 60 });
    panel.pinHandAnchor('left', 64); // replace, not append
    expect(panel.overrides.hand_anchors).toHaveLength(1);
    expect(panel.overrides.hand_anchors[0].anchor).toBe(64);
    panel.destroy();
  });

  it('save button is disabled when there is no edit, enabled after a toggle', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-save').disabled).toBe(true);
    panel.toggleDisabledNote(60);
    expect(document.querySelector('.hpp-save').disabled).toBe(false);
    panel.destroy();
  });

  it('resetOverrides clears the in-memory overrides + disables save', () => {
    const panel = makePanel();
    panel.toggleDisabledNote(60);
    panel.resetOverrides();
    expect(panel.overrides).toBeNull();
    expect(document.querySelector('.hpp-save').disabled).toBe(true);
    panel.destroy();
  });

  it('saveOverrides invokes routing_save_hand_overrides via apiClient', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ success: true, updated: 1 });
    const panel = makePanel({
      saveCtx: {
        apiClient: { sendCommand },
        fileId: 42,
        deviceId: 'piano-1'
      }
    });
    panel.toggleDisabledNote(60);
    const r = await panel.saveOverrides();
    expect(r.updated).toBe(1);
    expect(sendCommand).toHaveBeenCalledWith('routing_save_hand_overrides', expect.objectContaining({
      fileId: 42,
      channel: 0,
      deviceId: 'piano-1',
      overrides: expect.objectContaining({
        disabled_notes: [expect.objectContaining({ note: 60 })]
      })
    }));
    panel.destroy();
  });

  it('saveOverrides throws when no apiClient is wired', async () => {
    const panel = makePanel();
    await expect(panel.saveOverrides()).rejects.toThrow(/apiClient/);
    panel.destroy();
  });

  it('save button click triggers a save and clears the dirty flag', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ success: true, updated: 1 });
    const panel = makePanel({
      saveCtx: { apiClient: { sendCommand }, fileId: 1, deviceId: 'p' }
    });
    panel.toggleDisabledNote(60);
    document.querySelector('.hpp-save').click();
    // Wait a microtask for the async save() to resolve.
    await new Promise(r => setTimeout(r, 0));
    expect(sendCommand).toHaveBeenCalled();
    panel.destroy();
  });
});

describe('HandsPreviewPanel — lifecycle', () => {
  it('reset() clears active notes / bands and rewinds the engine', () => {
    const panel = makePanel();
    const clearActive = vi.spyOn(panel.keyboard, 'setActiveNotes');
    const clearBands = vi.spyOn(panel.keyboard, 'setHandBands');
    panel.reset();
    expect(clearActive).toHaveBeenCalledWith([]);
    expect(clearBands).toHaveBeenCalledWith([]);
    panel.destroy();
  });

  it('destroy() empties the container and disposes children', () => {
    const panel = makePanel();
    panel.destroy();
    expect(document.querySelector('canvas')).toBeNull();
    expect(panel.engine).toBeNull();
    expect(panel.keyboard).toBeNull();
    expect(panel.lookahead).toBeNull();
  });

  it('setOverrides() rebuilds the engine without throwing', () => {
    const panel = makePanel();
    expect(() => panel.setOverrides({ hand_anchors: [], disabled_notes: [] })).not.toThrow();
    panel.destroy();
  });
});
