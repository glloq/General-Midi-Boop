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

async function benchAsync(name, fn, iterations = 1000) {
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

console.log('\n=== Ma-est-tro Performance Benchmarks ===\n');
const results = [];

// 1. EventBus throughput
console.log('EventBus:');
const { default: EventBus } = await import('../../src/core/EventBus.js');
const bus = new EventBus();
let counter = 0;
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

container.factory('lazy', () => ({ id: Math.random() }));
results.push(
  bench('resolve (factory, first call)', () => {
    container.factory('lazy', () => ({ id: Math.random() }));
    container.resolve('lazy');
  })
);

results.push(bench('inject (2 deps)', () => container.inject('logger', 'config')));

// 3. Config get/set
console.log('\nConfig:');
const { default: Config } = await import('../../src/config/Config.js');
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
const { buildDynamicUpdate } = await import('../../src/storage/dbHelpers.js');
const updates = { name: 'test', description: 'hello', enabled: true };
const allowed = ['name', 'description', 'enabled', 'status'];
const transforms = { enabled: (v) => (v ? 1 : 0) };

results.push(bench('build (3 fields)', () => buildDynamicUpdate('table', updates, allowed)));
results.push(
  bench('build (with transforms)', () =>
    buildDynamicUpdate('table', updates, allowed, { transforms })
  )
);

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
console.log('Done.\n');
