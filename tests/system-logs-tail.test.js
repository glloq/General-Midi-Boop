// tests/system-logs-tail.test.js
// Audit A2 M3: system_logs bounded `data.lines` but then readFileSync'd the
// WHOLE log file and sliced the tail afterwards — so a large/un-rotated log
// could exceed Node's string limit and OOM the Pi. The handler now reads only
// the last LOG_TAIL_MAX_BYTES of the file. We drive the handler via `register`
// (the individual functions are not exported).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { register } from '../src/api/commands/SystemCommands.js';

function makeLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

function wire(logPath) {
  const handlers = {};
  const registry = { register: (name, fn) => (handlers[name] = fn) };
  register(registry, { config: { logging: { file: logPath } }, logger: makeLogger() });
  return handlers;
}

describe('system_logs — bounded tail (audit A2 M3)', () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmboop-logs-'));
    logPath = join(dir, 'gmboop.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('returns the last N lines of a small file', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    const handlers = wire(logPath);
    const res = await handlers['system_logs']({ lines: 10 });
    expect(res.logs).toEqual(lines.slice(-10));
    expect(res.truncated).toBe(true); // 50 > 10 returned
  });

  test('missing file yields an empty result, not a throw', async () => {
    const handlers = wire(join(dir, 'does-not-exist.log'));
    const res = await handlers['system_logs']({});
    expect(res.logs).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  test('a >2MB log is read from a bounded tail (no whole-file load)', async () => {
    // Write ~3 MB of lines — well past LOG_TAIL_MAX_BYTES (2 MB).
    const line = 'x'.repeat(200);
    const count = Math.ceil((3 * 1024 * 1024) / (line.length + 1));
    writeFileSync(logPath, Array.from({ length: count }, () => line).join('\n') + '\n', 'utf8');

    const handlers = wire(logPath);
    const res = await handlers['system_logs']({ lines: 100 });
    // Bounded: at most the requested line count, and flagged truncated because
    // we started mid-file.
    expect(res.logs.length).toBeLessThanOrEqual(100);
    expect(res.logs.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(true);
    // Each returned line is a complete line (no partial leading fragment left).
    for (const l of res.logs) expect(l).toBe(line);
  });

  test('caps requested lines at LOG_TAIL_MAX_LINES', async () => {
    writeFileSync(logPath, Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n', 'utf8');
    const handlers = wire(logPath);
    const res = await handlers['system_logs']({ lines: 999999 });
    expect(res.logs.length).toBe(20); // fewer lines than the cap → all returned
  });
});
