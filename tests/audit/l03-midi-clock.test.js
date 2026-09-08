/**
 * @file tests/audit/l03-midi-clock.test.js
 * @description Lot L03 — `src/midi/playback/MidiClockGenerator.js`.
 *
 * 198 statements at **0.5 % coverage** in the 2026-08-22 baseline; never
 * executed by a test. This suite drives it against an **injected clock** — a
 * deterministic virtual `performance.now()` + `setTimeout` — so tick counts,
 * long-run drift and the reaction to an event-loop stall are measured, not
 * estimated, and the suite stays instantaneous.
 *
 * Covered: enable gate, start / stop / pause / continue, per-device targeting,
 * latency-compensation buckets, tempo change mid-run, 60 s drift under jitter,
 * catch-up behaviour after a stall, destroy(), and the absence of Song Position
 * Pointer (finding F-43).
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { performance } from 'perf_hooks';
import MidiClockGenerator from '../../src/midi/playback/MidiClockGenerator.js';

// ---------------------------------------------------------------------------
// Injected clock: virtual time + a virtual timer queue.
// `MidiClockGenerator` captures `performance` from `perf_hooks` at import and
// calls the global `setTimeout`, so patching the method on that same object and
// swapping the global gives full control without touching the module.
// ---------------------------------------------------------------------------
function installVirtualClock() {
  let now = 0;
  let seq = 0;
  const queue = new Map(); // id -> {time, fn, seq}
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = performance.now;

  globalThis.setTimeout = (fn, delay = 0) => {
    const id = { virtual: true, n: ++seq };
    queue.set(id, { time: now + Math.max(0, Number(delay) || 0), fn, seq });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!queue.delete(id)) realClearTimeout(id);
  };
  performance.now = () => now;

  /** Run every timer due at or before `target`, in time order. */
  function runDueUntil(target, lateness) {
    let guard = 0;
    for (;;) {
      if (++guard > 2_000_000) throw new Error('virtual clock: runaway timer loop');
      let best = null;
      for (const [id, t] of queue) {
        if (t.time > target) continue;
        if (!best || t.time < best.t.time || (t.time === best.t.time && t.seq < best.t.seq)) {
          best = { id, t: t };
        }
      }
      if (!best) break;
      queue.delete(best.id);
      // `lateness` models event-loop lag: the callback runs later than due.
      // `now` never moves backwards — that is what makes `stall()` behave like
      // a genuinely blocked event loop rather than a rewind.
      const at = Math.min(target, best.t.time + (lateness ? lateness(best.t.time) : 0));
      now = Math.max(now, at, best.t.time > target ? now : best.t.time);
      best.t.fn();
    }
    now = target;
  }

  return {
    get now() {
      return now;
    },
    pending: () => queue.size,
    advance: (ms, lateness = null) => runDueUntil(now + ms, lateness),
    /** Freeze the loop for `ms`: time passes, nothing runs, then everything catches up. */
    stall: (ms) => {
      now += ms;
    },
    flush: () => runDueUntil(now, null),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      performance.now = realNow;
    }
  };
}

const noop = () => {};
function makeClock({ devices = ['out-a'], compensations = {} } = {}) {
  const sent = [];
  const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    eventBus: { on: noop, off: noop, emit: noop },
    database: {
      getDeviceSettings: () => ({ midi_clock_enabled: 1 }),
      getInstrumentSettings: (dev, ch) =>
        ch === 0 && compensations[dev] != null ? { sync_delay: compensations[dev] } : null
    },
    deviceManager: {
      outputs: new Map(devices.map((d) => [d, {}])),
      sendMessage: (device, type) => sent.push({ device, type, at: performance.now() })
    }
  };
  const clock = new MidiClockGenerator(deps);
  return { clock, sent };
}

let vc;
beforeEach(() => {
  vc = installVirtualClock();
});
afterEach(() => {
  vc.restore();
});

const typesOf = (sent) => sent.map((s) => s.type);
const clocksOf = (sent) => sent.filter((s) => s.type === 'clock');

describe('L03/D06 — MidiClockGenerator: enable gate & transport', () => {
  test('disabled by default: startPlayback emits nothing at all', () => {
    const { clock, sent } = makeClock();
    clock.startPlayback(120);
    vc.advance(1000);
    expect(sent).toEqual([]);
    expect(vc.pending()).toBe(0);
  });

  test('start sends 0xFA Start once, then a steady stream of 0xF8 Clock', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    expect(typesOf(sent)).toEqual(['start']);
    vc.advance(500); // 0.5 s at 120 BPM = 1 beat = 24 ticks
    expect(typesOf(sent).filter((t) => t === 'start')).toHaveLength(1);
    expect(clocksOf(sent)).toHaveLength(24);
    clock.stopPlayback();
  });

  test('tick interval is 60000/(bpm*24) — 24 PPQ, MIDI 1.0', () => {
    for (const [bpm, perSecond] of [
      [60, 24],
      [120, 48],
      [180, 72]
    ]) {
      const { clock, sent } = makeClock();
      clock.setEnabled(true);
      clock.startPlayback(bpm);
      vc.advance(1000);
      expect([bpm, clocksOf(sent).length]).toEqual([bpm, perSecond]);
      clock.stopPlayback();
    }
  });

  test('stop sends 0xFC and silences the tick stream', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(200);
    const before = clocksOf(sent).length;
    clock.stopPlayback();
    expect(typesOf(sent).at(-1)).toBe('stop');
    vc.advance(2000);
    expect(clocksOf(sent)).toHaveLength(before);
    expect(vc.pending()).toBe(0); // no orphan timer left behind
  });

  test('pause sends 0xFC Stop, resume sends 0xFB Continue and ticks resume', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(500);
    clock.pausePlayback();
    expect(typesOf(sent).at(-1)).toBe('stop');
    const frozen = clocksOf(sent).length;
    vc.advance(1000);
    expect(clocksOf(sent)).toHaveLength(frozen); // nothing while paused
    clock.resumePlayback();
    expect(typesOf(sent).at(-1)).toBe('continue');
    vc.advance(500);
    expect(clocksOf(sent).length).toBe(frozen + 24);
    clock.stopPlayback();
  });

  test('resume without a preceding pause is a no-op (no spurious Continue)', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    clock.resumePlayback();
    expect(typesOf(sent).filter((t) => t === 'continue')).toHaveLength(0);
    clock.stopPlayback();
  });

  test('disabling mid-run stops the clock and sends Stop (no silent orphan timer)', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(200);
    clock.setEnabled(false);
    expect(typesOf(sent).at(-1)).toBe('stop');
    expect(vc.pending()).toBe(0);
  });

  test('re-starting while already running does not leak the previous timer', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(100);
    const first = clocksOf(sent).length;
    clock.startPlayback(120); // e.g. a seek
    vc.advance(1000);
    // Exactly ONE tick stream after the restart: ~48 ticks in 1 s, not ~96.
    const second = clocksOf(sent).length - first;
    expect(second).toBeGreaterThanOrEqual(47);
    expect(second).toBeLessThanOrEqual(49);
    clock.stopPlayback();
  });

  test('destroy() stops the clock and leaves no pending timer', () => {
    const { clock } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(100);
    clock.destroy();
    expect(vc.pending()).toBe(0);
  });
});

describe('L03/D06 — MidiClockGenerator: tempo', () => {
  test('a mid-run tempo change takes effect on the very next tick', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(1000);
    const at120 = clocksOf(sent).length;
    expect(at120).toBeGreaterThanOrEqual(47);
    expect(at120).toBeLessThanOrEqual(48);
    clock.setTempo(240); // twice as fast → 96 ticks/s
    vc.advance(1000);
    const at240 = clocksOf(sent).length - at120;
    expect(at240).toBeGreaterThanOrEqual(95);
    expect(at240).toBeLessThanOrEqual(97);
    expect(clock.getTempo()).toBe(240);
    clock.stopPlayback();
  });

  test('setTempo rejects a non-positive BPM instead of dividing by zero', () => {
    const { clock } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    clock.setTempo(0);
    clock.setTempo(-30);
    expect(clock.getTempo()).toBe(120);
    vc.advance(1000);
    clock.stopPlayback();
  });

  test('a tempo ramp over 10 s keeps the tick count within one tick of the ideal', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(90);
    let ideal = 0;
    for (const bpm of [90, 100, 110, 120, 130]) {
      clock.setTempo(bpm);
      vc.advance(2000);
      ideal += (2000 / 60000) * bpm * 24;
    }
    expect(Math.abs(clocksOf(sent).length - ideal)).toBeLessThanOrEqual(2);
    clock.stopPlayback();
  });
});

describe('L03/D06 — MidiClockGenerator: long-run drift (injected clock)', () => {
  test('60 s at 120 BPM emits exactly 2880 ticks, last tick within 1 ms of ideal', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    const interval = 60000 / (120 * 24);
    vc.advance(60_000 + interval / 2);
    const ticks = clocksOf(sent);
    expect(ticks).toHaveLength(2880);
    // Every tick sits on the ideal grid — the drift is measured tick by tick,
    // not just at the end, so a slow leak cannot hide behind a final match.
    const worst = Math.max(...ticks.map((t, k) => Math.abs(t.at - (k + 1) * interval)));
    expect(worst).toBeLessThan(1e-6);
  });

  test('drift correction absorbs per-tick lateness: 60 s with 0–3 ms jitter stays exact', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    // Deterministic pseudo-jitter: every timer fires 0..3 ms late.
    const interval = 60000 / (120 * 24);
    let n = 0;
    vc.advance(60_000 + interval / 2, () => (n++ % 7) * 0.5);
    const ticks = clocksOf(sent);
    // A naive `setInterval`-style scheduler accumulates the lateness: ~1.5 ms
    // average × 2880 ticks ≈ 4.3 s lost (≈ 200 missing ticks). The
    // drift-correcting schedule must lose none, and no single tick may be more
    // than one jitter period off the ideal grid.
    expect(ticks).toHaveLength(2880);
    const worst = Math.max(...ticks.map((t, k) => Math.abs(t.at - (k + 1) * interval)));
    expect(worst).toBeLessThanOrEqual(3.001); // one jitter period, never more
  });

  test('at 240 BPM over 5 minutes the tick count is still exact', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(240);
    vc.advance(300_000);
    expect(clocksOf(sent)).toHaveLength((300_000 / 60000) * 240 * 24);
  });

  // Documented behaviour (finding F-44): after an event-loop stall the
  // generator does NOT drop the missed ticks — it replays them all back to
  // back at delay 0 until the tick counter catches up with wall time.
  test('F-44 — after a 5 s stall every missed tick is replayed in one burst', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(1000);
    const before = clocksOf(sent).length;
    vc.stall(5000); // event loop blocked for 5 s
    vc.flush();
    const burst = clocksOf(sent).length - before;
    // 5 s at 120 BPM = 240 ticks; every one of them is emitted, and they all
    // land on the SAME instant — a 240-message burst down every output port.
    expect(burst).toBeGreaterThanOrEqual(239);
    expect(burst).toBeLessThanOrEqual(242);
    const at = clocksOf(sent)
      .slice(-burst)
      .map((t) => t.at);
    expect(new Set(at).size).toBe(1);
    clock.stopPlayback();
  });
});

describe('L03/D06 — MidiClockGenerator: device targeting & compensation', () => {
  test('only clock-enabled devices receive the tick', () => {
    const { clock, sent } = makeClock({ devices: ['a', 'b', 'c'] });
    clock.setEnabled(true);
    clock.setDeviceClockEnabled('b', false);
    clock.startPlayback(120);
    vc.advance(100);
    const targets = new Set(sent.map((s) => s.device));
    expect([...targets].sort()).toEqual(['a', 'c']);
    clock.stopPlayback();
  });

  test('the slowest device ticks first; faster ones are delayed by the difference', () => {
    const { clock, sent } = makeClock({
      devices: ['slow', 'fast'],
      compensations: { slow: 30, fast: 5 }
    });
    clock.setEnabled(true);
    clock.startPlayback(120);
    // Start message: 'slow' (max compensation) immediately, 'fast' 25 ms later.
    const starts = sent.filter((s) => s.type === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].device).toBe('slow');
    vc.advance(25);
    const afterDelay = sent.filter((s) => s.type === 'start');
    expect(afterDelay.map((s) => s.device)).toEqual(['slow', 'fast']);
    expect(afterDelay[1].at - afterDelay[0].at).toBeCloseTo(25, 5);
    clock.stopPlayback();
  });

  test('stopping cancels the in-flight tick buckets but still delivers Stop', () => {
    const { clock, sent } = makeClock({
      devices: ['slow', 'fast'],
      compensations: { slow: 40, fast: 0 }
    });
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(30); // a delayed compensation bucket is pending
    expect(vc.pending()).toBeGreaterThan(0);
    clock.stopPlayback();
    // The only timer left is the compensated delivery of the Stop itself…
    vc.advance(100);
    expect(vc.pending()).toBe(0);
    // …and both devices did receive it.
    expect(
      sent
        .filter((s2) => s2.type === 'stop')
        .map((s2) => s2.device)
        .sort()
    ).toEqual(['fast', 'slow']);
    // No tick escaped after the stop.
    const lastStopAt = sent.filter((s2) => s2.type === 'stop')[0].at;
    expect(clocksOf(sent).every((c) => c.at <= lastStopAt)).toBe(true);
  });

  test('no clock-enabled device: nothing is scheduled and nothing throws', () => {
    const { clock, sent } = makeClock({ devices: ['a'] });
    clock.setEnabled(true);
    clock.setDeviceClockEnabled('a', false);
    clock.startPlayback(120);
    vc.advance(1000);
    expect(sent).toEqual([]);
    clock.stopPlayback();
  });

  test('a device that throws on send does not break the tick stream', () => {
    const { clock, sent } = makeClock({ devices: ['ok', 'bad'] });
    clock.setEnabled(true);
    clock.deviceManager.sendMessage = (device, type) => {
      if (device === 'bad') throw new Error('disconnected');
      sent.push({ device, type, at: performance.now() });
    };
    clock.startPlayback(120);
    vc.advance(1000);
    expect(clocksOf(sent).length).toBeGreaterThanOrEqual(47);
    expect(clocksOf(sent).every((c) => c.device === 'ok')).toBe(true);
    clock.stopPlayback();
  });
});

// ---------------------------------------------------------------------------
// F-43 — Song Position Pointer is entirely absent.
// ---------------------------------------------------------------------------
describe('L03/F-43 — Song Position Pointer', () => {
  test('the generator has no SPP API and never emits 0xF2', () => {
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(1000);
    clock.pausePlayback();
    clock.resumePlayback();
    vc.advance(500);
    clock.setTempo(140);
    vc.advance(500);
    clock.stopPlayback();

    // The complete vocabulary the master clock can ever put on the wire.
    expect(new Set(typesOf(sent))).toEqual(new Set(['start', 'clock', 'stop', 'continue']));
    // No entry point exists to locate a slave either.
    for (const name of ['sendSongPosition', 'setSongPosition', 'locate', 'seek']) {
      expect([name, typeof clock[name]]).toEqual([name, 'undefined']);
    }
  });

  test('a seek therefore re-sends Start (= "from bar 1"), never Stop+SPP+Continue', () => {
    // MidiPlayer.seek() on an actively-playing file calls stopPlayback() then
    // start() → startPlayback(), which is exactly this sequence. MIDI 1.0 says
    // 0xFA Start means "play from the beginning": a slave follows the operator
    // back to bar 1 instead of to the seek target. The spec-correct sequence is
    // Stop (0xFC) → Song Position Pointer (0xF2) → Continue (0xFB).
    const { clock, sent } = makeClock();
    clock.setEnabled(true);
    clock.startPlayback(120);
    vc.advance(30_000); // playing at 00:30
    clock.stopPlayback(); // seek()
    clock.startPlayback(120); // start() after the seek
    vc.advance(100);
    const transport = typesOf(sent).filter((t) => t !== 'clock');
    expect(transport).toEqual(['start', 'stop', 'start']);
    expect(transport).not.toContain('position');
  });
});
