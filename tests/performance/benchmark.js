#!/usr/bin/env node
// tests/performance/benchmark.js
// Run: node tests/performance/benchmark.js
// Establishes baseline performance metrics for critical paths.

import { performance } from 'perf_hooks';

// ── Helpers ──────────────────────────────────────────────────────────────

function bench(name, fn, iterations = 10000) {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(4);
  console.log(
    `  ${name}: ${avgMs}ms avg, ${opsPerSec.toLocaleString()} ops/sec (${iterations} iterations)`
  );
  return { name, avgMs: parseFloat(avgMs), opsPerSec, iterations };
}

async function benchAsync(name, fn, iterations = 1000) { // eslint-disable-line no-unused-vars
  // Warmup
  for (let i = 0; i < 10; i++) await fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(4);
  console.log(
    `  ${name}: ${avgMs}ms avg, ${opsPerSec.toLocaleString()} ops/sec (${iterations} iterations)`
  );
  return { name, avgMs: parseFloat(avgMs), opsPerSec, iterations };
}

// ── Benchmarks ───────────────────────────────────────────────────────────

console.log('\n=== Général Midi Boop Performance Benchmarks ===\n');
const results = [];

// 1. EventBus throughput
console.log('EventBus:');
const { default: EventBus } = await import('../../src/core/EventBus.js');
const bus = new EventBus();
let counter = 0; // eslint-disable-line no-unused-vars
bus.on('bench', () => {
  counter++;
});

results.push(bench('emit (1 listener)', () => bus.emit('bench', { value: 1 })));

for (let i = 0; i < 9; i++)
  bus.on('bench', () => {
    counter++;
  });
results.push(bench('emit (10 listeners)', () => bus.emit('bench', { value: 1 })));

// 2. ServiceContainer resolution
console.log('\nServiceContainer:');
const { default: ServiceContainer } = await import('../../src/core/ServiceContainer.js');
const container = new ServiceContainer();
container.register('logger', { info: () => {} });
container.register('config', { port: 8080 });

results.push(bench('resolve (instance)', () => container.resolve('logger')));

results.push(
  bench('resolve (factory)', () => {
    container.factory('lazy', () => ({ id: Math.random() }));
    container.resolve('lazy');
  })
);

// 3. Config get/set
console.log('\nConfig:');
const { default: Config } = await import('../../src/core/Config.js');
const config = new Config('/nonexistent.json');

results.push(bench('get (nested key)', () => config.get('server.port')));
results.push(bench('get (with default)', () => config.get('missing.key', 42)));

// 4. Logger formatting
console.log('\nLogger:');
const { default: Logger } = await import('../../src/core/Logger.js');
const logger = new Logger({ level: 'error' }); // Skip actual output

results.push(bench('format (text)', () => logger.format('info', 'test message', { key: 'value' })));
results.push(
  bench('formatJson', () => logger.formatJson('info', 'test message', { key: 'value' }))
);
results.push(bench('shouldLog (skip)', () => logger.shouldLog('debug')));

// 5. JSON validation
console.log('\nJsonValidator:');
const { default: JsonValidator } = await import('../../src/utils/JsonValidator.js');
const validMsg = { command: 'device_list', id: 'test-123', data: {} };
const invalidMsg = { data: {} };

results.push(bench('validateCommand (valid)', () => JsonValidator.validateCommand(validMsg)));
results.push(bench('validateCommand (invalid)', () => JsonValidator.validateCommand(invalidMsg)));

// 6. Error creation
console.log('\nError hierarchy:');
const { ApplicationError, ValidationError, NotFoundError } =
  await import('../../src/core/errors/index.js');

results.push(bench('new ApplicationError', () => new ApplicationError('test')));
results.push(bench('new ValidationError', () => new ValidationError('bad', 'field')));
results.push(bench('NotFoundError.toJSON()', () => new NotFoundError('User', 1).toJSON()));

// 7. buildDynamicUpdate
console.log('\nbuildDynamicUpdate:');
const { buildDynamicUpdate } = await import('../../src/persistence/dbHelpers.js');
const updates = { name: 'test', description: 'hello', enabled: true };
const allowed = ['name', 'description', 'enabled', 'status'];
const transforms = { enabled: (v) => (v ? 1 : 0) };

results.push(bench('build (3 fields)', () => buildDynamicUpdate('table', updates, allowed)));
results.push(
  bench('build (with transforms)', () =>
    buildDynamicUpdate('table', updates, allowed, { transforms })
  )
);

// ── Realtime scenarios (Phase F) ──────────────────────────────────────────
//
// These three measure end-to-end behaviour of the modules introduced
// by the realtime refactor:
//   bench-playback-jitter  : per-event emit jitter through the scheduler
//   bench-ws-flood         : output queue under a slow client
//   bench-snapshot-mutation: scheduler insulation during DB mutations

function pickPercentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[idx];
}

const assertions = [];
function assertPerf(name, actual, op, threshold) {
  const ok = op === '<' ? actual < threshold : actual > threshold;
  assertions.push({ name, actual, threshold, op, ok });
  const tag = ok ? 'OK' : 'FAIL';
  console.log(`  [${tag}] ${name}: ${typeof actual === 'number' ? actual.toFixed(3) : actual} ${op} ${threshold}`);
}

console.log('\nbench-playback-jitter:');
{
  const { default: PlaybackScheduler } = await import('../../src/midi/playback/PlaybackScheduler.js');
  const noop = () => {};
  const deps = {
    logger: {
      _levelNum: 2, info: noop, warn: noop, debug: noop, error: noop,
      isDebugEnabled: () => false, isInfoEnabled: () => true, isWarnEnabled: () => true
    },
    database: null,
    eventBus: { on: noop },
    wsServer: { broadcast: noop },
    deviceManager: { sendMessage: () => true }
  };
  const scheduler = new PlaybackScheduler(deps);
  const routing = { device: 'bench-dev', targetChannel: 0 };
  const getOutputForChannel = () => routing;
  const state = {
    playing: true, paused: false, position: 0, duration: 1000,
    events: [], currentEventIndex: 0, startTime: 0, playbackRate: 1,
    loop: false, channelRouting: new Map(), mutedChannels: new Set(), disconnectedPolicy: 'skip'
  };
  // Generate 10000 synthetic events spread 1 ms apart, all within
  // the EMIT_AHEAD window so the tickless fast path is exercised.
  const total = 10000;
  const samples = new Array(total);
  for (let i = 0; i < total; i++) {
    const event = { time: 0.001, type: 'controller', channel: 0, controller: 7, value: i & 127 };
    const t0 = performance.now();
    scheduler.scheduleEvent(event, 0, getOutputForChannel, state, {});
    samples[i] = performance.now() - t0;
  }
  samples.sort((a, b) => a - b);
  const p50 = pickPercentile(samples, 0.50);
  const p99 = pickPercentile(samples, 0.99);
  const p999 = pickPercentile(samples, 0.999);
  console.log(`  emit overhead p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms p999=${p999.toFixed(3)}ms (${total} events)`);
  assertPerf('playback-jitter p99 < 5ms', p99, '<', 5);
  assertPerf('playback-jitter p999 < 15ms', p999, '<', 15);
  results.push({ name: 'playback emit p99', avgMs: parseFloat(p99.toFixed(3)), opsPerSec: 0, iterations: total });
}

console.log('\nbench-ws-flood:');
{
  const { WsOutputQueue } = await import('../../src/api/WsOutputQueue.js');
  const fastClients = [];
  for (let i = 0; i < 4; i++) {
    fastClients.push({ readyState: 1, bufferedAmount: 0, sent: 0, send() { this.sent++; } });
  }
  // Slow client: bufferedAmount grows past the high watermark.
  const slowClient = {
    readyState: 1,
    bufferedAmount: 200 * 1024, // already above the 64 KB high-water mark
    sent: 0,
    send() { this.sent++; }
  };
  const clients = new Set([...fastClients, slowClient]);
  const logger = {
    isWarnEnabled: () => false, isDebugEnabled: () => false,
    warn: () => {}, debug: () => {}, info: () => {}, error: () => {}
  };
  // Manual flush so we can measure how the queue behaves under repeated bursts.
  const scheduled = [];
  const queue = new WsOutputQueue({
    clients, logger, scheduleFlush: (cb) => scheduled.push(cb)
  });

  const burstSize = 2000;
  const startBurst = performance.now();
  for (let i = 0; i < burstSize; i++) {
    queue.broadcast('playback_position', { position: i * 0.01, percentage: (i / burstSize) * 100 });
    queue.broadcast('monitor_event', { type: 'note_on', channel: 0, note: i & 127, velocity: 100 });
  }
  // Drain the (single) flush.
  while (scheduled.length) scheduled.shift()();
  const burstMs = performance.now() - startBurst;
  const stats = queue.getStats();
  console.log(`  burst of ${burstSize * 2} broadcasts took ${burstMs.toFixed(2)}ms`);
  console.log(`  stats: enqueued=${stats.enqueued} coalesced=${stats.coalesced} sent=${stats.sent} droppedByClient=${stats.droppedByClient}`);
  // Coalescing: 2000 playback_position + 2000 monitor_event collapse to 2 actual sends per client.
  const expectedSendsPerFastClient = 2;
  for (const c of fastClients) {
    if (c.sent !== expectedSendsPerFastClient) {
      console.log(`  [FAIL] fast client sent=${c.sent}, expected ${expectedSendsPerFastClient}`);
    }
  }
  assertPerf('ws-flood burst time < 50ms', burstMs, '<', 50);
  assertPerf('ws-flood droppedByClient > 0 (slow drop)', stats.droppedByClient, '>', 0);
  assertPerf('ws-flood coalesced count > 0', stats.coalesced, '>', 0);
  results.push({ name: 'ws-flood burst', avgMs: parseFloat(burstMs.toFixed(2)), opsPerSec: 0, iterations: burstSize * 2 });
}

console.log('\nbench-snapshot-mutation:');
{
  const { PlaybackSnapshot } = await import('../../src/midi/playback/PlaybackSnapshot.js');
  let mutations = 0;
  const comp = {
    delay: 10,
    getDelay() { return this.delay; }
  };
  const cap = {
    sc: false,
    tc: { minNoteInterval: null, minNoteDuration: null, polyphony: null },
    isStringCCAllowed() { return this.sc; },
    getTimingConstraints() { return this.tc; }
  };
  const snap = new PlaybackSnapshot({ capabilityResolver: cap, compensationService: comp });
  // Warm cache.
  snap.getCompensationMs('dev', 0);
  snap.getTimingConstraints('dev', 0);
  snap.isStringCCAllowed('dev', 0);

  const lookupSamples = new Array(10000);
  for (let i = 0; i < 10000; i++) {
    // Mutate underlying every 100 lookups — snapshot must NOT see it.
    if (i % 100 === 0) {
      comp.delay = 9999;
      cap.sc = !cap.sc;
      mutations++;
    }
    const t0 = performance.now();
    snap.getCompensationMs('dev', 0);
    snap.getTimingConstraints('dev', 0);
    snap.isStringCCAllowed('dev', 0);
    lookupSamples[i] = performance.now() - t0;
  }
  lookupSamples.sort((a, b) => a - b);
  const p99 = pickPercentile(lookupSamples, 0.99);
  const maxSample = lookupSamples[lookupSamples.length - 1];
  console.log(`  ${mutations} mutations during 10000 lookups`);
  console.log(`  snapshot lookup p99=${p99.toFixed(4)}ms max=${maxSample.toFixed(4)}ms`);
  // Snapshot value must be stable.
  if (snap.getCompensationMs('dev', 0) !== 10) {
    console.log('  [FAIL] snapshot leaked underlying mutation!');
    assertions.push({ name: 'snapshot-stability', actual: 'leaked', threshold: 'frozen', op: '==', ok: false });
  } else {
    assertions.push({ name: 'snapshot-stability', actual: 'frozen', threshold: 'frozen', op: '==', ok: true });
    console.log('  [OK]   snapshot value frozen at original (10ms) despite mutations');
  }
  assertPerf('snapshot lookup p99 < 0.1ms', p99, '<', 0.1);
  results.push({ name: 'snapshot lookup p99', avgMs: parseFloat(p99.toFixed(4)), opsPerSec: 0, iterations: 10000 });
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log('\n=== Summary ===\n');
console.log('| Benchmark | Avg (ms) | Ops/sec |');
console.log('|-----------|----------|---------|');
for (const r of results) {
  console.log(
    `| ${r.name.padEnd(35)} | ${r.avgMs.toFixed(4).padStart(8)} | ${r.opsPerSec.toLocaleString().padStart(11)} |`
  );
}
console.log(`\nTotal benchmarks: ${results.length}`);

if (assertions.length > 0) {
  const failures = assertions.filter((a) => !a.ok);
  console.log(`\nAssertions: ${assertions.length - failures.length}/${assertions.length} passed`);
  if (failures.length > 0) {
    console.log('FAILED ASSERTIONS:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.actual} ${f.op} ${f.threshold}`);
    }
    console.log('Done (with failures).');
    process.exitCode = 1;
  } else {
    console.log('Done.\n');
  }
} else {
  console.log('Done.\n');
}
