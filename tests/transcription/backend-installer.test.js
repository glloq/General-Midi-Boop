/**
 * @file tests/transcription/backend-installer.test.js
 * @description Installing an engine (§34). Nothing is downloaded and no
 * environment is built: the backend's own install step is a double, so what
 * is tested is the part that must hold for EVERY engine — consent before
 * anything is fetched, one install at a time, room on disk, rollback on
 * failure, and a verified status afterwards.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BackendInstaller, statfsNearest } from '../../src/transcription/BackendInstaller.js';
import { TranscriptionBackendRegistry } from '../../src/transcription/TranscriptionBackendRegistry.js';
import TranscriptionBackend from '../../src/transcription/TranscriptionBackend.js';
import { BACKEND_STATUS } from '../../src/transcription/TranscriptionCapabilities.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A backend whose install/uninstall are scripted. */
class FakeBackend extends TranscriptionBackend {
  constructor(options = {}) {
    super({ logger: silentLogger });
    this.options = options;
    this.installCalls = [];
    this.uninstallCalls = [];
    this.status = options.initialStatus || BACKEND_STATUS.INSTALLABLE;
  }

  getMetadata() {
    return {
      id: this.options.id || 'fake-engine',
      name: this.options.name || 'Fake Engine',
      licensing: this.options.licensing || {
        codeLicense: 'MIT',
        modelLicense: 'MIT',
        commercialUse: true,
        requiresConsent: false
      }
    };
  }

  async checkAvailability() {
    return { status: this.status, detail: this.options.detail ?? null, version: '1.0.0' };
  }

  async transcribe() {
    return { tracks: [] };
  }

  supportsInstall() {
    return this.options.supportsInstall !== false;
  }

  get estimatedInstallBytes() {
    return this.options.estimatedInstallBytes ?? 0;
  }

  get installRoot() {
    return this.options.installRoot ?? null;
  }

  async install(context) {
    this.installCalls.push(context);
    context.onProgress?.({ stage: 'creating_environment', progress: null });
    if (this.options.installError) throw this.options.installError;
    context.onProgress?.({ stage: 'downloading', progress: null });
    this.status = this.options.statusAfterInstall || BACKEND_STATUS.AVAILABLE;
    return { status: this.status };
  }

  async uninstall(context) {
    this.uninstallCalls.push(context);
    if (this.options.uninstallError) throw this.options.uninstallError;
    this.status = BACKEND_STATUS.INSTALLABLE;
  }
}

/** Registry + installer + the events they emitted. */
function makeStack(backendOptions = {}) {
  const events = [];
  const deps = {
    logger: silentLogger,
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    config: { transcription: { availabilityCacheMs: 0 } }
  };
  const registry = new TranscriptionBackendRegistry(deps);
  const backend = new FakeBackend(backendOptions);
  registry.register(backend);
  deps.transcriptionBackendRegistry = registry;

  const broadcasts = [];
  return {
    installer: new BackendInstaller(deps),
    registry,
    backend,
    events,
    broadcasts,
    // `wsServer` registers after this service, so it appears on the facade
    // only when asked for — never captured at construction.
    attachWs: () => {
      deps.wsServer = { broadcast: (name, payload) => broadcasts.push({ name, payload }) };
    }
  };
}

let installer;
let registry;
let backend;
let events;

beforeEach(() => {
  ({ installer, registry, backend, events } = makeStack());
});

describe('preconditions', () => {
  test('refuses an unknown engine by name', async () => {
    const error = await installer.install('nope').catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('BACKEND_NOT_INSTALLED');
    expect(error.message).toMatch(/Unknown transcription engine/);
  });

  test('refuses an engine that has no automated installer, and says where to look', async () => {
    const stack = makeStack({ supportsInstall: false });
    const error = await stack.installer.install('fake-engine').catch((e) => e);
    expect(error.message).toMatch(/cannot be installed automatically/);
    expect(error.message).toMatch(/AUDIO_TRANSCRIPTION\.md/);
    expect(stack.backend.installCalls).toHaveLength(0);
  });
});

describe('licence consent (§8/§9)', () => {
  const restricted = {
    licensing: {
      codeLicense: 'Apache-2.0',
      modelLicense: 'CC-BY-NC-4.0',
      commercialUse: false,
      requiresConsent: true,
      licenseUrl: 'https://example.invalid/licence',
      notice: 'Non-commercial weights'
    }
  };

  test('refuses to install a restricted engine without consent — nothing is fetched', async () => {
    const stack = makeStack(restricted);
    const error = await stack.installer.install('fake-engine').catch((e) => e);

    expect(error.reason).toBe('BACKEND_NOT_INSTALLED');
    expect(error.details.requiresConsent).toBe(true);
    // The refusal carries what must be accepted, so the UI can show it.
    expect(error.details.licensing).toMatchObject({
      modelLicense: 'CC-BY-NC-4.0',
      commercialUse: false,
      licenseUrl: 'https://example.invalid/licence'
    });
    expect(stack.backend.installCalls).toHaveLength(0);
  });

  test('installs once consent is given', async () => {
    const stack = makeStack(restricted);
    await expect(
      stack.installer.install('fake-engine', { acceptLicense: true })
    ).resolves.toMatchObject({ status: BACKEND_STATUS.AVAILABLE });
    expect(stack.backend.installCalls).toHaveLength(1);
  });

  test('refuses a consent that names a licence the engine no longer has', async () => {
    const stack = makeStack(restricted);
    const error = await stack.installer
      .install('fake-engine', { acceptLicense: true, acceptedModelLicense: 'MIT' })
      .catch((e) => e);

    expect(error.message).toMatch(/licence shown has changed/);
    expect(error.details).toMatchObject({ accepted: 'MIT', current: 'CC-BY-NC-4.0' });
    expect(stack.backend.installCalls).toHaveLength(0);
  });

  test('accepts a consent that names the current licence', async () => {
    const stack = makeStack(restricted);
    await expect(
      stack.installer.install('fake-engine', {
        acceptLicense: true,
        acceptedModelLicense: 'CC-BY-NC-4.0'
      })
    ).resolves.toBeDefined();
  });

  test('a permissive engine needs no consent', async () => {
    await expect(installer.install('fake-engine')).resolves.toMatchObject({
      status: BACKEND_STATUS.AVAILABLE
    });
  });
});

describe('disk space (§34)', () => {
  test('refuses to start when the disk cannot hold the result', async () => {
    const stack = makeStack({
      estimatedInstallBytes: Number.MAX_SAFE_INTEGER / 4,
      installRoot: path.join(os.tmpdir(), 'gmboop-install-target')
    });
    const error = await stack.installer.install('fake-engine').catch((e) => e);
    expect(error.reason).toBe('DISK_FULL');
    expect(error.message).toMatch(/Not enough free space/);
    expect(stack.backend.installCalls).toHaveLength(0);
  });

  test('proceeds when the engine declares no size', async () => {
    await expect(installer.install('fake-engine')).resolves.toBeDefined();
  });

  test('statfsNearest walks up to an existing ancestor', async () => {
    const deep = path.join(os.tmpdir(), 'gmboop-does-not-exist', 'nor', 'this');
    const stats = await statfsNearest(deep);
    expect(stats.bsize).toBeGreaterThan(0);
  });
});

describe('verification and rollback', () => {
  test('re-probes for real instead of trusting the installer', async () => {
    await installer.install('fake-engine');
    const [entry] = registry.list();
    expect(entry.status).toBe(BACKEND_STATUS.AVAILABLE);
    expect(entry.available).toBe(true);
  });

  test('an install that "succeeds" but does not start is a failure, and is rolled back', async () => {
    const stack = makeStack({ statusAfterInstall: BACKEND_STATUS.BROKEN, detail: 'import error' });
    const error = await stack.installer.install('fake-engine').catch((e) => e);

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.message).toMatch(/import error/);
    // Rollback ran, so a retry starts from a clean tree.
    expect(stack.backend.uninstallCalls).toHaveLength(1);
    expect(stack.backend.uninstallCalls[0]).toEqual({ rollback: true });
  });

  test('a failing install is rolled back and reported', async () => {
    const stack = makeStack({ installError: new Error('pip exploded') });
    const error = await stack.installer.install('fake-engine').catch((e) => e);

    expect(error.message).toBe('pip exploded');
    expect(stack.backend.uninstallCalls).toHaveLength(1);
    expect(stack.installer.busy).toBe(false);
  });

  test('a rollback that itself fails does not mask the original error', async () => {
    const stack = makeStack({
      installError: new Error('pip exploded'),
      uninstallError: new Error('permission denied')
    });
    const error = await stack.installer.install('fake-engine').catch((e) => e);
    expect(error.message).toBe('pip exploded');
  });
});

describe('concurrency', () => {
  test('refuses a second install while one is running', async () => {
    let release;
    const stack = makeStack();
    stack.backend.install = () =>
      new Promise((resolve) => {
        release = () => {
          stack.backend.status = BACKEND_STATUS.AVAILABLE;
          resolve({});
        };
      });

    const first = stack.installer.install('fake-engine');
    await Promise.resolve();
    expect(stack.installer.busy).toBe(true);

    const error = await stack.installer.install('fake-engine').catch((e) => e);
    expect(error.message).toMatch(/already being installed/);

    release();
    await first;
    expect(stack.installer.busy).toBe(false);
  });

  test('exposes what is running, for a UI that reconnects mid-install', async () => {
    let release;
    const stack = makeStack();
    stack.backend.install = (context) =>
      new Promise((resolve) => {
        context.onProgress?.({ stage: 'downloading', progress: null });
        release = () => {
          stack.backend.status = BACKEND_STATUS.AVAILABLE;
          resolve({});
        };
      });

    const pending = stack.installer.install('fake-engine');
    await Promise.resolve();
    expect(stack.installer.getCurrent()).toMatchObject({
      backendId: 'fake-engine',
      operation: 'install',
      stage: 'downloading'
    });

    release();
    await pending;
    expect(stack.installer.getCurrent()).toBeNull();
  });

  test('cancel reaches the backend through its signal', async () => {
    const stack = makeStack();
    let seenAbort = false;
    stack.backend.install = (context) =>
      new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => {
          seenAbort = true;
          reject(new Error('aborted'));
        });
      });

    const pending = stack.installer.install('fake-engine');
    await Promise.resolve();
    expect(stack.installer.cancel()).toBe(true);
    await pending.catch(() => {});
    expect(seenAbort).toBe(true);
    expect(stack.installer.cancel()).toBe(false);
  });
});

describe('uninstall', () => {
  test('removes the engine and re-probes', async () => {
    await installer.install('fake-engine');
    const descriptor = await installer.uninstall('fake-engine');
    expect(backend.uninstallCalls.length).toBeGreaterThan(0);
    expect(descriptor.status).toBe(BACKEND_STATUS.INSTALLABLE);
  });

  test('refuses while an install is running', async () => {
    let release;
    const stack = makeStack();
    stack.backend.install = () => new Promise((resolve) => (release = resolve));
    const pending = stack.installer.install('fake-engine');
    await Promise.resolve();

    await expect(stack.installer.uninstall('fake-engine')).rejects.toThrow(/already running/);
    release({});
    await pending.catch(() => {});
  });
});

describe('events', () => {
  test('reports progress and a final outcome', async () => {
    await installer.install('fake-engine');
    const names = events.map((e) => e.name);
    expect(names).toContain('transcription_install_progress');
    expect(names).toContain('transcription_install_complete');

    const finished = events.find((e) => e.name === 'transcription_install_complete');
    expect(finished.payload).toEqual({
      backendId: 'fake-engine',
      outcome: 'installed',
      message: null
    });
    // The engine's status change reaches the UI through the registry's own
    // event, not a second one invented here.
    expect(names).toContain('transcription_backend_changed');
  });

  test('reports a failure as failed, with its message', async () => {
    const stack = makeStack({ installError: new Error('pip exploded') });
    await stack.installer.install('fake-engine').catch(() => {});
    const finished = stack.events.find((e) => e.name === 'transcription_install_complete');
    expect(finished.payload).toMatchObject({ outcome: 'failed', message: 'pip exploded' });
  });

  test('reports a cancellation as cancelled, not as a failure', async () => {
    const stack = makeStack();
    stack.backend.install = (context) =>
      new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => reject(TranscriptionError.cancelled()));
      });
    const pending = stack.installer.install('fake-engine');
    await Promise.resolve();
    stack.installer.cancel();
    await pending.catch(() => {});

    const finished = stack.events.find((e) => e.name === 'transcription_install_complete');
    expect(finished.payload.outcome).toBe('cancelled');
  });

  test('works without an event bus at all', async () => {
    const bare = new BackendInstaller({
      logger: silentLogger,
      transcriptionBackendRegistry: registry
    });
    await expect(bare.install('fake-engine')).resolves.toBeDefined();
  });
});

describe('Basic Pitch install steps', () => {
  /** Import lazily: the module resolves paths at import time. */
  async function makeBasicPitch(runnerResults, dataDir) {
    const { BasicPitchBackend } =
      await import('../../src/transcription/backends/BasicPitchBackend.js');
    const calls = [];
    const queue = [...runnerResults];
    const runner = {
      calls,
      run: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        const next = queue.shift();
        if (typeof next === 'function') return next({ command, args, options });
        if (next instanceof Error) throw next;
        return { code: 0, stdout: '', stderr: '', ...(next || {}) };
      }
    };
    const engine = new BasicPitchBackend({
      logger: silentLogger,
      config: { transcription: { dataDir } },
      processRunner: runner
    });
    return { engine, runner };
  }

  test('creates the venv, installs the pinned requirements, then verifies', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-install-'));
    try {
      const { engine, runner } = await makeBasicPitch(
        [
          { code: 0, stdout: 'Python 3.11.2\n' }, // python3 --version
          async () => {
            // `python -m venv` — materialise the interpreter it would create.
            await fs.mkdir(path.join(dataDir, 'venvs', 'basic-pitch', 'bin'), { recursive: true });
            await fs.writeFile(
              path.join(dataDir, 'venvs', 'basic-pitch', 'bin', 'python'),
              '#!/bin/sh\n'
            );
            return { code: 0 };
          },
          { code: 0, stdout: 'Successfully installed basic-pitch-0.4.0\n' }, // pip
          {
            code: 0,
            stdout: JSON.stringify({ protocolVersion: 1, ok: true, version: '0.4.0' }) + '\n'
          }
        ],
        dataDir
      );

      const stages = [];
      const report = await engine.install({ onProgress: (p) => stages.push(p.stage) });

      expect(report.status).toBe(BACKEND_STATUS.AVAILABLE);
      expect(stages).toEqual(['checking', 'creating_environment', 'downloading', 'verifying']);
      expect(runner.calls[1].args).toEqual(['-m', 'venv', engine.venvDir]);
      // The requirements FILE is what pip is given — never a package list
      // assembled in code, so the pinned versions are the ones installed.
      expect(runner.calls[2].args).toContain('-r');
      expect(runner.calls[2].args.some((a) => a.endsWith('requirements.txt'))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test('fails clearly when there is no Python to build the environment with', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-install-'));
    try {
      const { engine } = await makeBasicPitch([new Error('ENOENT'), new Error('ENOENT')], dataDir);
      const error = await engine.install({}).catch((e) => e);
      expect(error.reason).toBe('BACKEND_NOT_INSTALLED');
      // Says what is needed, not just that something is missing.
      expect(error.message).toMatch(/Python 3\.9 . 3\.11 is required/);
      expect(error.message).toMatch(/not found/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test('surfaces a pip failure with the tail of its output', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-install-'));
    try {
      const { engine } = await makeBasicPitch(
        [
          { code: 0, stdout: 'Python 3.11.2\n' },
          { code: 0 },
          { code: 1, stderr: 'ERROR: No matching distribution found for tensorflow==2.15.1\n' }
        ],
        dataDir
      );
      const error = await engine.install({}).catch((e) => e);
      expect(error.message).toMatch(/No matching distribution/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test('uninstall removes only its own environment, and is idempotent', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmboop-install-'));
    try {
      const { engine } = await makeBasicPitch([], dataDir);
      await fs.mkdir(engine.venvDir, { recursive: true });
      await fs.writeFile(path.join(engine.venvDir, 'marker'), 'x');
      // A sibling directory that must survive.
      const sibling = path.join(dataDir, 'venvs', 'other-engine');
      await fs.mkdir(sibling, { recursive: true });

      await engine.uninstall();
      await expect(fs.access(engine.venvDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(sibling)).resolves.toBeUndefined();

      // Removing what is already gone succeeds.
      await expect(engine.uninstall()).resolves.toBeUndefined();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

// Without this the Settings panel shows an install that never starts and
// never finishes: the EventBus never reaches a browser.
describe('reaching the browser', () => {
  test('install progress and completion are broadcast, not only emitted', async () => {
    const stack = makeStack();
    stack.attachWs();

    await stack.installer.install('fake-engine', { acceptLicense: true });

    const names = stack.broadcasts.map((b) => b.name);
    expect(names).toContain('transcription_install_progress');
    expect(names).toContain('transcription_install_complete');
    expect(stack.broadcasts.at(-1).payload.outcome).toBe('installed');
  });

  test('a failed install says so to the browser', async () => {
    const stack = makeStack({ installError: new Error('pip fell over') });
    stack.attachWs();

    await expect(stack.installer.install('fake-engine', { acceptLicense: true })).rejects.toThrow();

    const finished = stack.broadcasts.filter((b) => b.name === 'transcription_install_complete');
    expect(finished).toHaveLength(1);
    expect(finished[0].payload.outcome).toBe('failed');
  });

  test('installs fine with no WebSocket server attached', async () => {
    const stack = makeStack();
    await expect(
      stack.installer.install('fake-engine', { acceptLicense: true })
    ).resolves.toBeDefined();
    expect(stack.events.map((e) => e.name)).toContain('transcription_install_complete');
  });
});
