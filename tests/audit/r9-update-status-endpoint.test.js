/**
 * @file tests/audit/r9-update-status-endpoint.test.js
 * @description Wave 2 — R9 / F-122 (and L10 F-115): `GET /api/update-status`.
 *
 * The endpoint is public **by design** — the dashboard polls it while the
 * server is restarting under it, which is exactly when a token round-trip is
 * not available. The audit's objection was never "make it private": it was
 * that public had also come to mean *unbounded* and *permanent*.
 *
 *   - unbounded: `readFileSync(update.log)` loaded the whole file to keep 30
 *     lines. `npm install` output on a Pi runs to megabytes and an anonymous
 *     client could ask for it in a loop (F-115);
 *   - permanent: nothing ever deletes `logs/update-status`, so the endpoint
 *     kept serving the last update's transcript — absolute paths, git log,
 *     `git status --short`, LAN IP — forever (F-122).
 *
 * The logic now lives in `src/system/UpdateStatus.js` and is tested here
 * against real files in a temp directory, with an injected clock.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import HttpServer from '../../src/api/HttpServer.js';
import {
  readUpdateStatus,
  parseUpdateStep,
  isActiveStep,
  isTerminalStep,
  readBoundedTail,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
  ACTIVE_WINDOW_MS,
  TERMINAL_GRACE_MS,
  STATUS_MAX_BYTES
} from '../../src/system/UpdateStatus.js';

let dir;
let statusFile;
let logFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmboop-r9-status-'));
  statusFile = join(dir, 'update-status');
  logFile = join(dir, 'update.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write the status file and back-date it by `ageMs`. */
function setStatus(raw, ageMs = 0) {
  writeFileSync(statusFile, raw);
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(statusFile, when, when);
}

describe('R9 / F-122 — the endpoint is closed when no update is running', () => {
  test('a box that has never updated answers nothing at all', () => {
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: null, logTail: null });
  });

  test('a finished update is still readable for a short grace period', () => {
    // The SPA has to see how the update ended before it reloads.
    setStatus('done', 60 * 1000);
    writeFileSync(logFile, 'line one\nline two\n');
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: 'done', logTail: null });
  });

  test('past the grace period it goes quiet instead of replaying forever', () => {
    setStatus('done', TERMINAL_GRACE_MS + 60 * 1000);
    writeFileSync(logFile, 'still on disk\n');
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: null, logTail: null });
  });

  test('a step that stopped advancing long ago is a dead update, not a live one', () => {
    setStatus('installing', ACTIVE_WINDOW_MS + 60 * 1000);
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: null, logTail: null });
  });

  test('an oversized status file is not ours and is ignored', () => {
    writeFileSync(statusFile, 'x'.repeat(STATUS_MAX_BYTES + 1));
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: null, logTail: null });
  });
});

describe('R9 / F-115 — the log tail is bounded, and only served while running', () => {
  test('a 5 MB update.log yields at most the last 30 lines and 64 KB', () => {
    // The old code did readFileSync() on this file, on every request, with no
    // authentication in front of it.
    const filler = 'x'.repeat(4096);
    const lines = [];
    for (let i = 0; i < 1300; i++) lines.push(`${i} ${filler}`);
    lines.push('LAST LINE');
    writeFileSync(logFile, lines.join('\n'));
    setStatus('installing');

    const { status, logTail } = readUpdateStatus({ statusFile, logFile });
    expect(status).toBe('installing');
    expect(Buffer.byteLength(logTail, 'utf8')).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(logTail.split('\n').length).toBeLessThanOrEqual(TAIL_MAX_LINES);
    expect(logTail).toContain('LAST LINE');
    expect(logTail).not.toContain('\n0 '); // the head of the file is never read
  });

  test('a partial first line from slicing mid-file is dropped', () => {
    writeFileSync(logFile, 'A'.repeat(TAIL_MAX_BYTES) + '\nsecond\nthird\n');
    const tail = readBoundedTail(logFile);
    expect(tail).not.toContain('AAA');
    expect(tail.trim().split('\n')).toEqual(['second', 'third']);
  });

  test('once the update is over the transcript is no longer public', () => {
    // Paths, git log, `git status --short`, LAN IP: readable via the
    // authenticated `system_logs` command, not from an open endpoint.
    writeFileSync(logFile, 'ℹ Project directory: /home/pi/General-Midi-Boop\n');
    setStatus('done');
    expect(readUpdateStatus({ statusFile, logFile }).logTail).toBeNull();
    setStatus('failed: npm install failed (rolled back to 1a2b3c4)');
    expect(readUpdateStatus({ statusFile, logFile }).logTail).toBeNull();
  });

  test('an unreadable log does not take the status down with it', () => {
    setStatus('pulling');
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({
      status: 'pulling',
      logTail: null
    });
  });
});

describe('R9 — the status vocabulary shared by update.sh, the SPA and the server', () => {
  test('the startup marker carries a date and a pid; the step is still found', () => {
    expect(parseUpdateStep('2026-09-08 03:14:15 script_started pid=42 non_interactive=1')).toBe(
      'script_started'
    );
  });

  test('a rollback keeps its reason readable by the dashboard', () => {
    const raw = 'failed: database migration failed (rolled back to 1a2b3c4)';
    setStatus(raw);
    expect(parseUpdateStep(raw)).toBe('failed');
    expect(isTerminalStep(parseUpdateStep(raw))).toBe(true);
    // Served verbatim: the SPA strips the `failed:` prefix and shows the rest.
    expect(readUpdateStatus({ statusFile, logFile }).status).toBe(raw);
  });

  test('the new steps update.sh writes are recognised as in-flight', () => {
    for (const step of ['migrating', 'rolling_back', 'pulling', 'installing', 'verifying']) {
      expect(isActiveStep(step)).toBe(true);
      expect(isTerminalStep(step)).toBe(false);
    }
  });

  test('empty or unknown content never passes for a running update', () => {
    expect(parseUpdateStep('')).toBeNull();
    expect(parseUpdateStep(null)).toBeNull();
    expect(isActiveStep(parseUpdateStep('wat'))).toBe(false);
    setStatus('wat');
    expect(readUpdateStatus({ statusFile, logFile })).toEqual({ status: null, logTail: null });
  });

  test('an active step is served with its transcript while it is fresh', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(logFile, '>> 4. Updating Dependencies\n');
    setStatus('rolling_back', 5000);
    const out = readUpdateStatus({ statusFile, logFile });
    expect(out.status).toBe('rolling_back');
    expect(out.logTail).toContain('Updating Dependencies');
  });
});

describe('R9 / F-122 — the route itself', () => {
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  let server;

  afterAll(async () => {
    if (server) await new Promise((r) => server.server.close(r));
  });

  test('stays public, answers JSON, and exposes nothing else', async () => {
    const savedToken = process.env.GMBOOP_API_TOKEN;
    process.env.GMBOOP_API_TOKEN = 'r9-endpoint-token-0123456789abcd';
    server = new HttpServer({
      logger: noopLogger,
      config: { server: { port: 0, host: '127.0.0.1' } },
      getCapabilityStatus: () => ({ overall: 'ok', capabilities: {} }),
      deviceManager: { getDeviceList: () => [] },
      midiRouter: { getRouteList: () => [] },
      database: { getFiles: () => [], getFileInfo: () => null },
      wsServer: { getStats: () => ({ clients: 0 }) }
    });
    await server.start();
    const { port } = server.server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/update-status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Exactly two fields: the dashboard needs the step, nothing more.
    expect(Object.keys(body).sort()).toEqual(['logTail', 'status']);
    if (body.status === null) expect(body.logTail).toBeNull();

    if (savedToken === undefined) delete process.env.GMBOOP_API_TOKEN;
    else process.env.GMBOOP_API_TOKEN = savedToken;
  }, 20000);
});
