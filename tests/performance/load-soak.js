#!/usr/bin/env node
/* eslint-disable no-console */
// tests/performance/load-soak.js
// Phase 5 — headless load / soak harness (no MIDI hardware, no browser).
//
// Run:  node tests/performance/load-soak.js
//       node --expose-gc tests/performance/load-soak.js      (cleaner heap signal)
//       LOAD_EVENTS=400000 SOAK_SECONDS=20 node tests/performance/load-soak.js
//
// Exits non-zero if any HARD budget is breached, so it is CI-usable.
//
// Budgets are RELATIVE regression gates (this is a dev box, not a Pi):
// the value is catching a regression / unbounded growth, not asserting
// absolute Pi numbers. Run on the Pi to capture device-true baselines.

import { performance, monitorEventLoopDelay } from 'perf_hooks';
import PlaybackScheduler from '../../src/midi/playback/PlaybackScheduler.js';
import { WsOutputQueue, DEFAULT_MAX_QUEUE_DEPTH } from '../../src/api/WsOutputQueue.js';

const LOAD_EVENTS = parseInt(process.env.LOAD_EVENTS || '200000', 10);
const SOAK_SECONDS = parseInt(process.env.SOAK_SECONDS || '5', 10);

const silentLogger = {
  _levelNum: 1,
  info() {},
  warn() {},
  debug() {},
  error() {},
  isDebugEnabled: () => false,
  isWarnEnabled: () => true,
  isInfoEnabled: () => true
};

const results = [];
function record(name, value, unit, budget, ok) {
  results.push({ name, value, unit, budget, ok });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}: ${value}${unit}` + (budget ? `  (budget ${budget})` : ''));
}

function makeSchedulerDeps() {
  return {
    logger: silentLogger,
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: () => {} },
    deviceManager: { sendMessage: () => true }
  };
}

function makeState() {
  return {
    playing: true,
    paused: false,
    position: 0,
    duration: 1e9,
    events: [],
    currentEventIndex: 0,
    startTime: 0,
    playbackRate: 1,
    loop: false,
    channelRouting: new Map(),
    mutedChannels: new Set(),
    disconnectedPolicy: 'skip'
  };
}

// A representative dense polyphonic stream: alternating noteon/noteoff/CC
// across 16 channels — exercises the per-event dispatch + allocation path.
function buildEvents(n) {
  const evs = new Array(n);
  for (let i = 0; i < n; i++) {
    const ch = i & 15;
    const m = i % 3;
    if (m === 0)
      evs[i] = { time: 0, type: 'noteon', channel: ch, note: 60 + (i % 24), velocity: 96 };
    else if (m === 1)
      evs[i] = { time: 0, type: 'noteoff', channel: ch, note: 60 + (i % 24), velocity: 0 };
    else evs[i] = { time: 0, type: 'controller', channel: ch, controller: 7, value: i & 127 };
  }
  return evs;
}

// ── Scenario A: large-MIDI scheduler hot path ───────────────────────────
async function scenarioLargeMidi() {
  console.log(`\nScenario A — scheduler hot path, ${LOAD_EVENTS.toLocaleString()} events`);
  const scheduler = new PlaybackScheduler(makeSchedulerDeps());
  const state = makeState();
  const routing = { device: 'dev-A', targetChannel: 0 };
  const getOut = () => routing;
  const events = buildEvents(LOAD_EVENTS);

  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  // Process in 512-event chunks via setImmediate to mimic the 10 ms tick
  // batching and expose realistic event-loop pressure.
  const CHUNK = 512;
  for (let base = 0; base < events.length; base += CHUNK) {
    const end = Math.min(base + CHUNK, events.length);
    for (let i = base; i < end; i++) {
      // time within EMIT_AHEAD of position ⇒ synchronous dispatch path.
      scheduler.scheduleEvent(events[i], 0, getOut, state, {});
    }
    await new Promise((r) => setImmediate(r));
  }

  const elapsedMs = performance.now() - t0;
  eld.disable();
  try {
    scheduler.destroy();
  } catch {
    /* ignore */
  }

  const eps = Math.round((LOAD_EVENTS / elapsedMs) * 1000);
  const nsPerEvent = Math.round((elapsedMs * 1e6) / LOAD_EVENTS);
  const p99ms = +(eld.percentile(99) / 1e6).toFixed(2);
  const heapDeltaMB = +((process.memoryUsage().heapUsed - heap0) / 1048576).toFixed(1);

  record('A.throughput', eps.toLocaleString(), ' ev/s', '≥ 150,000', eps >= 150000);
  record('A.per_event', nsPerEvent, ' ns', '', true);
  record('A.eventloop_p99', p99ms, ' ms', '< 50', p99ms < 50);
  record('A.heap_delta', heapDeltaMB, ' MB', 'informational', true);
}

// ── Scenario B: WsOutputQueue flood / coalescing / bounding ─────────────
function scenarioWsFlood() {
  console.log('\nScenario B — WsOutputQueue flood (coalesce + depth bound)');
  let pendingFlush = null;
  const q = new WsOutputQueue({
    clients: new Set(), // no real sockets — stats still count
    logger: silentLogger,
    scheduleFlush: (cb) => {
      pendingFlush = cb;
    }
  });

  const ROUNDS = 2000;
  const COALESCABLE_PER_ROUND = 50; // playback_position spam
  const DISCRETE_PER_ROUND = 50; // non-coalescable bursts
  let maxDepth = 0;

  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < COALESCABLE_PER_ROUND; i++) {
      q.broadcast('playback_position', { position: r + i });
    }
    for (let i = 0; i < DISCRETE_PER_ROUND; i++) {
      q.broadcast('load_soak_discrete', { seq: r * DISCRETE_PER_ROUND + i });
    }
    maxDepth = Math.max(maxDepth, q._queue.length);
    if (pendingFlush) {
      const f = pendingFlush;
      pendingFlush = null;
      f();
    }
  }
  q.close();

  const s = q._stats;
  const coalescedBroadcasts = ROUNDS * COALESCABLE_PER_ROUND;
  const coalesceRatio = +(s.coalesced / coalescedBroadcasts).toFixed(3);

  record(
    'B.max_queue_depth',
    maxDepth,
    '',
    `≤ ${DEFAULT_MAX_QUEUE_DEPTH}`,
    maxDepth <= DEFAULT_MAX_QUEUE_DEPTH
  );
  record('B.coalesce_ratio', coalesceRatio, '', '≥ 0.90', coalesceRatio >= 0.9);
  record('B.flushes', s.flushes, '', 'informational', true);
  record('B.dropped_by_depth', s.droppedByDepth, '', 'informational', true);
}

// ── Scenario C: soak — heap-growth slope over time ──────────────────────
async function scenarioSoak() {
  console.log(`\nScenario C — soak ${SOAK_SECONDS}s (heap-growth slope)`);
  const scheduler = new PlaybackScheduler(makeSchedulerDeps());
  const state = makeState();
  const routing = { device: 'dev-C', targetChannel: 0 };
  const getOut = () => routing;
  const batch = buildEvents(20000);

  const samples = []; // {t, heapMB}
  const tStart = performance.now();
  const deadline = tStart + SOAK_SECONDS * 1000;

  while (performance.now() < deadline) {
    for (let i = 0; i < batch.length; i++) scheduler.scheduleEvent(batch[i], 0, getOut, state, {});
    if (global.gc) global.gc();
    samples.push({
      t: (performance.now() - tStart) / 1000,
      heapMB: process.memoryUsage().heapUsed / 1048576
    });
    await new Promise((r) => setImmediate(r));
  }
  try {
    scheduler.destroy();
  } catch {
    /* ignore */
  }

  // Least-squares slope of heapMB over seconds.
  const n = samples.length;
  const sx = samples.reduce((a, s) => a + s.t, 0);
  const sy = samples.reduce((a, s) => a + s.heapMB, 0);
  const sxx = samples.reduce((a, s) => a + s.t * s.t, 0);
  const sxy = samples.reduce((a, s) => a + s.t * s.heapMB, 0);
  const slope = n > 2 ? +((n * sxy - sx * sy) / (n * sxx - sx * sx)).toFixed(2) : 0;
  const gcNote = global.gc ? '' : ' (no --expose-gc: GC-noisy)';

  // Generous hard bound (regression gate, not a leak microscope).
  record('C.heap_slope', slope, ` MB/s${gcNote}`, '< 8', slope < 8);
  record('C.samples', n, '', 'informational', true);
}

(async () => {
  console.log('General Midi Boop — load / soak harness');
  console.log(`node ${process.version}  expose-gc=${Boolean(global.gc)}`);
  await scenarioLargeMidi();
  scenarioWsFlood();
  await scenarioSoak();

  const failed = results.filter((r) => r.ok === false);
  console.log(
    `\n${failed.length ? '✗ FAIL' : '✓ PASS'} — ` +
      `${results.length - failed.length}/${results.length} budgets met`
  );
  if (failed.length) {
    for (const f of failed)
      console.log(`   breached: ${f.name} = ${f.value}${f.unit} (budget ${f.budget})`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('load-soak harness error:', e);
  process.exit(2);
});
