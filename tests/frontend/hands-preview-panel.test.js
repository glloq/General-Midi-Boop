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

describe('HandsPreviewPanel — header buttons', () => {
  it('play/pause/reset buttons are present and clickable', () => {
    const panel = makePanel();
    expect(document.querySelector('.hpp-play')).not.toBeNull();
    expect(document.querySelector('.hpp-pause')).not.toBeNull();
    expect(document.querySelector('.hpp-reset')).not.toBeNull();
    expect(() => document.querySelector('.hpp-play').click()).not.toThrow();
    expect(() => document.querySelector('.hpp-pause').click()).not.toThrow();
    expect(() => document.querySelector('.hpp-reset').click()).not.toThrow();
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
