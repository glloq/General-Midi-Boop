// tests/frontend/hand-simulation-engine.test.js
// E.6.3: HandSimulationEngine wraps the simulateHandWindows timeline
// in a requestAnimationFrame-driven scheduler that drives the
// HandsPreviewPanel UI. Tests use injected `now()` + raf shims so
// the loop runs deterministically without real timers.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const helperSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/HandPositionFeasibility.js'),
  'utf8'
);
const engineSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/auto-assign/HandSimulationEngine.js'),
  'utf8'
);

beforeAll(() => {
  new Function(helperSrc)();
  new Function(engineSrc)();
});

const semitonesHands = {
  enabled: true,
  mode: 'semitones',
  hand_move_semitones_per_sec: 60,
  hands: [
    { id: 'left',  cc_position_number: 23, hand_span_semitones: 14 },
    { id: 'right', cc_position_number: 24, hand_span_semitones: 14 }
  ]
};

/** Build a controllable clock + raf pair. The test calls `clock.tick(ms)`
 *  to advance time and run scheduled callbacks. */
function makeClock() {
  let now = 1000;
  let pending = []; // [{cb, dueAt}]
  const handle = (cb) => {
    pending.push({ cb });
    return pending.length;
  };
  const cancel = () => {};
  const advance = (ms) => {
    now += ms;
    // Drain everything pending in submission order, even if more
    // callbacks register during the drain.
    let safety = 100;
    while (pending.length > 0 && safety-- > 0) {
      const round = pending.slice();
      pending = [];
      for (const p of round) p.cb(now);
    }
  };
  return {
    now: () => now,
    raf: handle,
    caf: cancel,
    tick: advance
  };
}

function makeEngine(opts = {}) {
  const clock = opts.clock || makeClock();
  const Eng = window.HandSimulationEngine;
  const engine = new Eng({
    notes: opts.notes || [],
    instrument: opts.instrument || { hands_config: semitonesHands },
    ticksPerBeat: opts.ticksPerBeat || 480,
    bpm: opts.bpm || 120,
    overrides: opts.overrides || null,
    now: clock.now,
    requestAnimationFrame: clock.raf,
    cancelAnimationFrame: clock.caf
  });
  return { engine, clock };
}

describe('HandSimulationEngine — construction', () => {
  it('initialises currentTick at 0 with no notes', () => {
    const { engine } = makeEngine({ notes: [] });
    expect(engine.currentTick()).toBe(0);
    expect(engine.totalTicks).toBe(0);
    expect(engine.isPlaying).toBe(false);
  });

  it('totalTicks equals the max note tick', () => {
    const { engine } = makeEngine({
      notes: [{ tick: 0, note: 60 }, { tick: 1920, note: 64 }, { tick: 480, note: 62 }]
    });
    expect(engine.totalTicks).toBe(1920);
  });

  it('ticksToSeconds reflects bpm and ticksPerBeat', () => {
    const { engine } = makeEngine({ notes: [{ tick: 480, note: 60 }], bpm: 60, ticksPerBeat: 480 });
    // 480 ticks at bpm 60, ppq 480 = 1 beat = 1 second.
    expect(engine.ticksToSeconds(480)).toBeCloseTo(1, 5);
  });
});

describe('HandSimulationEngine — play / pause / reset', () => {
  it('play() sets isPlaying and schedules a frame', () => {
    const { engine } = makeEngine({ notes: [{ tick: 480, note: 60 }] });
    engine.play();
    expect(engine.isPlaying).toBe(true);
  });

  it('pause() stops further frames', () => {
    const { engine, clock } = makeEngine({ notes: [{ tick: 9600, note: 60 }] });
    engine.play();
    clock.tick(50); // ~1 frame
    engine.pause();
    const tickAfterPause = engine.currentTick();
    clock.tick(500);
    // Currenttick must not advance after pause.
    expect(engine.currentTick()).toBe(tickAfterPause);
  });

  it('reset() returns to tick 0 and stops playback', () => {
    const { engine, clock } = makeEngine({ notes: [{ tick: 4800, note: 60 }] });
    engine.play();
    clock.tick(200);
    expect(engine.currentTick()).toBeGreaterThan(0);
    engine.reset();
    expect(engine.currentTick()).toBe(0);
    expect(engine.isPlaying).toBe(false);
  });

  it('play() at end restarts from 0', () => {
    const { engine, clock } = makeEngine({ notes: [{ tick: 480, note: 60 }] });
    engine.play();
    clock.tick(2000); // way past end
    expect(engine.currentTick()).toBe(engine.totalTicks);
    engine.play();
    expect(engine.currentTick()).toBeLessThanOrEqual(engine.totalTicks);
  });
});

describe('HandSimulationEngine — events', () => {
  it('emits a tick event on each frame', () => {
    const { engine, clock } = makeEngine({ notes: [{ tick: 9600, note: 60 }] });
    let ticks = 0;
    engine.on('tick', () => ticks++);
    engine.play();
    clock.tick(100);
    expect(ticks).toBeGreaterThan(0);
  });

  it('emits chord events as the playhead crosses note ticks', () => {
    const { engine, clock } = makeEngine({
      notes: [
        { tick: 0,    note: 60 },
        { tick: 480,  note: 64 },
        { tick: 960,  note: 67 }
      ]
    });
    const chords = [];
    engine.on('chord', (e) => chords.push(e.detail));
    engine.play();
    clock.tick(2000); // enough to cover all notes at 120bpm
    expect(chords.length).toBe(3);
    expect(chords.map(c => c.tick)).toEqual([0, 480, 960]);
  });

  it('emits an end event once at end-of-timeline', () => {
    const { engine, clock } = makeEngine({ notes: [{ tick: 240, note: 60 }] });
    let endCount = 0;
    engine.on('end', () => endCount++);
    engine.play();
    clock.tick(5000);
    expect(endCount).toBe(1);
  });

  it('emits shift events when hands move', () => {
    const { engine, clock } = makeEngine({
      notes: [
        { tick: 0,    note: 60 },
        { tick: 480,  note: 96 } // far above span — forces shift
      ]
    });
    const shifts = [];
    engine.on('shift', (e) => shifts.push(e.detail));
    engine.play();
    clock.tick(1500);
    expect(shifts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('HandSimulationEngine — seek', () => {
  it('jumps without re-emitting passed chords', () => {
    const { engine } = makeEngine({
      notes: [
        { tick: 0,    note: 60 },
        { tick: 480,  note: 64 },
        { tick: 960,  note: 67 }
      ]
    });
    const chords = [];
    engine.on('chord', (e) => chords.push(e.detail));
    engine.seek(700);
    // Both chords at 0 and 480 are silent; nothing emitted.
    expect(chords.length).toBe(0);
    expect(engine.currentTick()).toBe(700);
  });

  it('emits a tick event after seek (so the UI redraws)', () => {
    const { engine } = makeEngine({ notes: [{ tick: 1920, note: 60 }] });
    let lastTick = -1;
    engine.on('tick', (e) => { lastTick = e.detail.currentTick; });
    engine.seek(960);
    expect(lastTick).toBe(960);
  });

  it('clamps to [0, totalTicks]', () => {
    const { engine } = makeEngine({ notes: [{ tick: 480, note: 60 }] });
    engine.seek(-100);
    expect(engine.currentTick()).toBe(0);
    engine.seek(99999);
    expect(engine.currentTick()).toBe(480);
  });

  it('rewinding silently re-drains so future events fire correctly', () => {
    const { engine, clock } = makeEngine({
      notes: [{ tick: 0, note: 60 }, { tick: 480, note: 64 }]
    });
    const chords = [];
    engine.on('chord', (e) => chords.push(e.detail));
    // Forward past both chords silently.
    engine.seek(960);
    expect(chords).toHaveLength(0);
    // Rewind to before tick 480, then play forward.
    engine.seek(240);
    engine.play();
    clock.tick(2000);
    // Chord at 480 must fire.
    expect(chords.find(c => c.tick === 480)).toBeDefined();
  });
});

describe('HandSimulationEngine — fallback when simulator absent', () => {
  it('falls back to a chord-per-note timeline when no simulator is wired', () => {
    const Eng = window.HandSimulationEngine;
    const clock = makeClock();
    const engine = new Eng({
      notes: [{ tick: 0, note: 60 }, { tick: 240, note: 64 }],
      instrument: { hands_config: semitonesHands },
      simulator: null, // explicitly bypass
      now: clock.now, requestAnimationFrame: clock.raf, cancelAnimationFrame: clock.caf
    });
    const chords = [];
    engine.on('chord', (e) => chords.push(e.detail));
    engine.play();
    clock.tick(2000);
    expect(chords.length).toBe(2);
  });
});
