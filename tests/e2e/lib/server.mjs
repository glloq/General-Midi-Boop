/**
 * @file tests/e2e/lib/server.mjs
 * @description Boots and tears down a disposable GeneralMidiBoop server for E2E runs.
 *
 * Everything the server writes goes into a per-run workspace directory
 * (database, log, uploaded MIDI files, backups), so a run never touches the
 * developer's `./data` or `./logs`, and every run starts from a **clean
 * database** unless `keepDb` is set.
 *
 * `GMBOOP_API_TOKEN` is set explicitly on purpose: without it,
 * `ApiTokenManager` generates a token and **writes it into the repository's
 * `.env`**, which an E2E run must never do.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Default port. Deliberately not 8080 so a dev server can keep running. */
export const DEFAULT_PORT = Number(process.env.E2E_PORT || 8108);

/**
 * A disposable application server.
 */
export class AppServer {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.port]        - HTTP/WS port (default {@link DEFAULT_PORT}).
   * @param {string} [opts.workspace]   - Directory for db/logs/uploads.
   * @param {boolean} [opts.keepDb]     - Reuse an existing database instead of wiping it.
   * @param {number} [opts.readyTimeoutMs] - How long to wait for /api/health.
   * @param {Object} [opts.env]         - Extra environment variables.
   */
  constructor(opts = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.workspace =
      opts.workspace ?? path.join(REPO_ROOT, 'tests', 'e2e', 'artifacts', 'workspace');
    this.keepDb = !!opts.keepDb;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 45000;
    this.extraEnv = opts.env ?? {};
    this.proc = null;
    this.logPath = path.join(this.workspace, 'app.log');
    this.stdoutPath = path.join(this.workspace, 'server.out');
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.wsUrl = `ws://127.0.0.1:${this.port}/`;
    /** @type {string[]} lines written to stdout/stderr by the server process. */
    this.output = [];
  }

  /** Wipe (unless keepDb) and (re)create the workspace directory. */
  prepareWorkspace() {
    if (!this.keepDb && existsSync(this.workspace)) {
      rmSync(this.workspace, { recursive: true, force: true });
    }
    mkdirSync(this.workspace, { recursive: true });
    mkdirSync(path.join(this.workspace, 'uploads'), { recursive: true });
  }

  /**
   * Spawn `node server.js` and resolve once `/api/health` answers 200.
   * @returns {Promise<void>}
   */
  async start() {
    this.prepareWorkspace();

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      // Explicit token → ApiTokenManager does NOT write into the repo's .env.
      GMBOOP_API_TOKEN: process.env.E2E_API_TOKEN || 'e2e-harness-token',
      GMBOOP_SERVER_PORT: String(this.port),
      GMBOOP_SERVER_WS_PORT: String(this.port),
      GMBOOP_DATABASE_PATH: path.join(this.workspace, 'gmboop.db'),
      GMBOOP_LOG_FILE: this.logPath,
      GMBOOP_LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'info',
      GMBOOP_BLE_ENABLED: 'false',
      GMBOOP_SERIAL_ENABLED: 'false',
      // Keep RTP-MIDI off the standard 5004 so parallel runs don't collide.
      GMBOOP_RTP_MIDI_PORT: String(this.port + 900),
      ...this.extraEnv
    };

    this.proc = spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const collect = (chunk) => {
      const text = chunk.toString();
      this.output.push(text);
      if (process.env.E2E_SERVER_STDOUT === '1') process.stdout.write(text);
    };
    this.proc.stdout.on('data', collect);
    this.proc.stderr.on('data', collect);

    let exited = null;
    this.proc.on('exit', (code, signal) => {
      exited = { code, signal };
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `server.js exited before becoming ready (code=${exited.code} signal=${exited.signal})\n` +
            this.output.join('')
        );
      }
      if (await this.ping()) return;
      await sleep(200);
    }
    await this.stop();
    throw new Error(
      `server did not answer ${this.baseUrl}/api/health within ${this.readyTimeoutMs}ms`
    );
  }

  /** @returns {Promise<boolean>} true when /api/health answers 200. */
  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<Object|null>} parsed /api/health body. */
  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      return await res.json();
    } catch {
      return null;
    }
  }

  /** @returns {string} the server-side log file content (may be empty). */
  readLog() {
    try {
      return readFileSync(this.logPath, 'utf8');
    } catch {
      return this.output.join('');
    }
  }

  /**
   * SIGTERM then SIGKILL. Always safe to call, even if never started.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) {
      this.proc = null;
      return;
    }
    const proc = this.proc;
    this.proc = null;
    const done = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    const killer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 8000);
    await done;
    clearTimeout(killer);
  }
}

/** @param {number} ms @returns {Promise<void>} */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
