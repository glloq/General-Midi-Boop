/**
 * @file tests/transcription/backend-registry.test.js
 * @description Registry behaviour (§10/§36/§44): registration validation,
 * availability caching and probe isolation, the `transcription_backend_changed`
 * event, and the deterministic `auto` engine selection.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import TranscriptionBackendRegistry, {
  scoreBackend
} from '../../src/transcription/TranscriptionBackendRegistry.js';
import TranscriptionBackend from '../../src/transcription/TranscriptionBackend.js';
import {
  BACKEND_STATUS,
  HARDWARE_PROFILE,
  QUALITY_PROFILE
} from '../../src/transcription/TranscriptionCapabilities.js';
import { transcriptionPaths } from '../../src/transcription/TranscriptionConfig.js';
import { existsSync } from 'fs';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Configurable fake engine — no subprocess, no filesystem. */
class FakeBackend extends TranscriptionBackend {
  constructor({ id, name, status = BACKEND_STATUS.AVAILABLE, ...rest } = {}) {
    super({ logger: silentLogger });
    this._id = id;
    this._name = name || id;
    this._status = status;
    this._rest = rest;
    this.probeCount = 0;
    this.destroyed = false;
  }

  getMetadata() {
    return {
      id: this._id,
      name: this._name,
      capabilities: this._rest.capabilities,
      runtime: this._rest.runtime,
      priority: this._rest.priority
    };
  }

  async checkAvailability() {
    this.probeCount++;
    if (this._rest.throwOnProbe) throw new Error('probe exploded');
    if (this._rest.hangOnProbe) return new Promise(() => {});
    return { status: this._status, detail: this._rest.detail ?? null };
  }

  async transcribe() {
    return { tracks: [] };
  }

  destroy() {
    this.destroyed = true;
  }
}

/** Registry with a deterministic, non-caching availability window. */
function makeRegistry(extraDeps = {}) {
  const events = [];
  // The deps object is returned as well as used, so a test can add a service
  // that registers LATER (as `wsServer` really does) and check that the
  // registry reads it at use rather than having captured it.
  const deps = {
    logger: silentLogger,
    eventBus: { emit: (name, payload) => events.push({ name, payload }) },
    config: { transcription: { availabilityCacheMs: 0 } },
    ...extraDeps
  };
  const registry = new TranscriptionBackendRegistry(deps);
  return { registry, events, deps };
}

describe('registration', () => {
  let registry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
  });

  test('registers a backend and exposes it by id', () => {
    const backend = new FakeBackend({ id: 'alpha', name: 'Alpha' });
    expect(registry.register(backend)).toBe('alpha');
    expect(registry.size).toBe(1);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.get('alpha')).toBe(backend);
    expect(registry.get('nope')).toBeNull();
  });

  test('refuses a duplicate id', () => {
    registry.register(new FakeBackend({ id: 'alpha' }));
    expect(() => registry.register(new FakeBackend({ id: 'alpha' }))).toThrow(/already registered/);
  });

  test('refuses an incomplete implementation at registration, not at run time', () => {
    expect(() => registry.register(null)).toThrow(/getMetadata/);
    expect(() => registry.register({ getMetadata: () => ({ id: 'x-y', name: 'X' }) })).toThrow(
      /must implement checkAvailability/
    );
    expect(() =>
      registry.register({
        getMetadata: () => ({ id: 'x-y', name: 'X' }),
        checkAvailability: async () => ({})
      })
    ).toThrow(/must implement transcribe/);
  });

  test('refuses malformed metadata', () => {
    expect(() => registry.register(new FakeBackend({ id: 'Not Valid' }))).toThrow(/Backend id/);
  });

  test('unregister removes the entry and releases the backend', () => {
    const backend = new FakeBackend({ id: 'alpha' });
    registry.register(backend);
    expect(registry.unregister('alpha')).toBe(true);
    expect(backend.destroyed).toBe(true);
    expect(registry.has('alpha')).toBe(false);
    expect(registry.unregister('alpha')).toBe(false);
  });

  test('destroy() releases every backend (Application.stop)', () => {
    const a = new FakeBackend({ id: 'alpha' });
    const b = new FakeBackend({ id: 'beta' });
    registry.register(a);
    registry.register(b);
    registry.destroy();
    expect(registry.size).toBe(0);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
  });
});

describe('availability detection', () => {
  test('an empty registry is a valid state, not an error (fresh install)', async () => {
    const { registry } = makeRegistry();
    expect(registry.list()).toEqual([]);
    await expect(registry.detectAvailable()).resolves.toEqual([]);
    expect(registry.getRecommendedBackend()).toBeNull();
  });

  test('a never-probed backend is not_installed rather than optimistically ready', () => {
    const { registry } = makeRegistry();
    registry.register(new FakeBackend({ id: 'alpha' }));
    const [entry] = registry.list();
    expect(entry.status).toBe(BACKEND_STATUS.NOT_INSTALLED);
    expect(entry.available).toBe(false);
  });

  test('detectAvailable returns only the usable engines', async () => {
    const { registry } = makeRegistry();
    registry.register(new FakeBackend({ id: 'ready-one' }));
    registry.register(new FakeBackend({ id: 'missing-one', status: BACKEND_STATUS.NOT_INSTALLED }));
    const available = await registry.detectAvailable();
    expect(available.map((e) => e.id)).toEqual(['ready-one']);
    expect(registry.list()).toHaveLength(2);
  });

  test('a probe that throws marks the backend broken instead of rejecting', async () => {
    const { registry } = makeRegistry();
    registry.register(new FakeBackend({ id: 'crashy', throwOnProbe: true }));
    await expect(registry.detectAvailable()).resolves.toEqual([]);
    const [entry] = registry.list();
    expect(entry.status).toBe(BACKEND_STATUS.BROKEN);
    expect(entry.detail).toBe('probe exploded');
  });

  test('an invalid availability report is treated as broken', async () => {
    const { registry } = makeRegistry();
    const backend = new FakeBackend({ id: 'liar' });
    backend.checkAvailability = async () => ({ status: 'totally-fine' });
    registry.register(backend);
    await registry.detectAvailable();
    expect(registry.list()[0].status).toBe(BACKEND_STATUS.BROKEN);
  });

  test('a hanging probe times out and does not wedge the registry', async () => {
    jest.useFakeTimers();
    try {
      const { registry } = makeRegistry();
      registry.register(new FakeBackend({ id: 'hangy', hangOnProbe: true }));
      const pending = registry.detectAvailable();
      await jest.advanceTimersByTimeAsync(9000);
      await expect(pending).resolves.toEqual([]);
      expect(registry.list()[0].status).toBe(BACKEND_STATUS.BROKEN);
      expect(registry.list()[0].detail).toMatch(/timed out/);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the cache spares repeated probes, and refresh() bypasses it', async () => {
    const { registry } = makeRegistry({
      config: { transcription: { availabilityCacheMs: 60000 } }
    });
    const backend = new FakeBackend({ id: 'alpha' });
    registry.register(backend);

    await registry.detectAvailable();
    await registry.detectAvailable();
    expect(backend.probeCount).toBe(1);

    await registry.refresh('alpha');
    expect(backend.probeCount).toBe(2);

    await registry.refresh();
    expect(backend.probeCount).toBe(3);
  });

  test('concurrent probes of the same backend are coalesced', async () => {
    const { registry } = makeRegistry();
    const backend = new FakeBackend({ id: 'alpha' });
    registry.register(backend);
    await Promise.all([registry.detectAvailable(), registry.detectAvailable()]);
    expect(backend.probeCount).toBe(1);
  });

  test('refresh() on an unknown id is a no-op', async () => {
    const { registry } = makeRegistry();
    await expect(registry.refresh('ghost')).resolves.toEqual([]);
  });

  test('a status change reaches the browser, not only the bus', async () => {
    const broadcasts = [];
    const { registry, deps } = makeRegistry();
    // Attached AFTER construction on purpose: `wsServer` registers after the
    // registry, so it must be read at use, never captured in the constructor.
    deps.wsServer = { broadcast: (name, payload) => broadcasts.push({ name, payload }) };
    registry.register(new FakeBackend({ id: 'alpha', status: BACKEND_STATUS.AVAILABLE }));

    await registry.detectAvailable();

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].name).toBe('transcription_backend_changed');
    expect(broadcasts[0].payload).toMatchObject({
      backendId: 'alpha',
      status: BACKEND_STATUS.AVAILABLE
    });
  });

  test('probes fine with no WebSocket server attached', async () => {
    const { registry, events } = makeRegistry();
    registry.register(new FakeBackend({ id: 'alpha', status: BACKEND_STATUS.AVAILABLE }));
    await expect(registry.detectAvailable()).resolves.toHaveLength(1);
    expect(events.map((e) => e.name)).toContain('transcription_backend_changed');
  });

  test('emits transcription_backend_changed only on a status transition', async () => {
    const { registry, events } = makeRegistry();
    const backend = new FakeBackend({ id: 'alpha', status: BACKEND_STATUS.NOT_INSTALLED });
    registry.register(backend);

    await registry.detectAvailable();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      name: 'transcription_backend_changed',
      payload: {
        backendId: 'alpha',
        status: BACKEND_STATUS.NOT_INSTALLED,
        previousStatus: null,
        detail: null
      }
    });

    await registry.refresh('alpha');
    expect(events).toHaveLength(1);

    backend._status = BACKEND_STATUS.AVAILABLE;
    await registry.refresh('alpha');
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({
      status: BACKEND_STATUS.AVAILABLE,
      previousStatus: BACKEND_STATUS.NOT_INSTALLED
    });
  });

  test('works without an event bus', async () => {
    const registry = new TranscriptionBackendRegistry({ logger: silentLogger });
    registry.register(new FakeBackend({ id: 'alpha' }));
    await expect(registry.detectAvailable()).resolves.toHaveLength(1);
  });
});

describe('auto selection (§36)', () => {
  const light = {
    id: 'light-engine',
    capabilities: { polyphonic: true, dynamics: true },
    runtime: { python: true, raspberryPiSuitable: true }
  };
  const heavy = {
    id: 'heavy-engine',
    capabilities: {
      polyphonic: true,
      multiInstrument: true,
      drums: true,
      instrumentRecognition: true
    },
    runtime: { python: true, gpu: true }
  };

  async function readyRegistry(configs) {
    const { registry } = makeRegistry();
    for (const config of configs) registry.register(new FakeBackend(config));
    await registry.detectAvailable();
    return registry;
  }

  test('an explicit choice wins, and an unavailable one is refused rather than swapped', async () => {
    const registry = await readyRegistry([
      light,
      { ...heavy, status: BACKEND_STATUS.NOT_INSTALLED }
    ]);
    const picked = registry.getRecommendedBackend({ backendId: 'light-engine' });
    expect(picked.metadata.id).toBe('light-engine');
    expect(picked.reason).toMatch(/explicitly requested/);
    expect(registry.getRecommendedBackend({ backendId: 'heavy-engine' })).toBeNull();
  });

  test('maximum quality prefers the multi-instrument engine', async () => {
    const registry = await readyRegistry([light, heavy]);
    const picked = registry.getRecommendedBackend({ quality: QUALITY_PROFILE.MAXIMUM });
    expect(picked.metadata.id).toBe('heavy-engine');
    expect(picked.reason).toMatch(/auto selection/);
    expect(picked.backend).toBe(registry.get('heavy-engine'));
  });

  test('fast quality and low-end hardware prefer the light engine', async () => {
    const registry = await readyRegistry([light, heavy]);
    expect(registry.getRecommendedBackend({ quality: QUALITY_PROFILE.FAST }).metadata.id).toBe(
      'light-engine'
    );
    expect(
      registry.getRecommendedBackend({
        quality: QUALITY_PROFILE.MAXIMUM,
        hardwareProfile: HARDWARE_PROFILE.LOW
      }).metadata.id
    ).toBe('light-engine');
  });

  test('a required capability no engine has yields null — no silent downgrade', async () => {
    const registry = await readyRegistry([light]);
    expect(registry.getRecommendedBackend({ requireDrums: true })).toBeNull();
    expect(registry.getRecommendedBackend({ requireMultiInstrument: true })).toBeNull();
  });

  test('a required capability selects the engine that has it', async () => {
    const registry = await readyRegistry([light, heavy]);
    expect(registry.getRecommendedBackend({ requireDrums: true }).metadata.id).toBe('heavy-engine');
  });

  test('ties are broken by declared priority, then by id — never at random', async () => {
    const registry = await readyRegistry([
      { ...light, id: 'engine-b' },
      { ...light, id: 'engine-a' }
    ]);
    expect(registry.getRecommendedBackend().metadata.id).toBe('engine-a');

    const prioritised = await readyRegistry([
      { ...light, id: 'engine-a' },
      { ...light, id: 'engine-b', priority: 10 }
    ]);
    expect(prioritised.getRecommendedBackend().metadata.id).toBe('engine-b');
  });

  test('list() is ordered by priority then name', async () => {
    const registry = await readyRegistry([
      { ...light, id: 'engine-z', priority: 5 },
      { ...light, id: 'engine-a' }
    ]);
    expect(registry.list().map((e) => e.id)).toEqual(['engine-z', 'engine-a']);
  });

  test('scoreBackend penalises a GPU engine on constrained hardware', () => {
    const gpuEntry = { capabilities: {}, runtime: { gpu: true, raspberryPiSuitable: false } };
    const piEntry = { capabilities: {}, runtime: { gpu: false, raspberryPiSuitable: true } };
    expect(scoreBackend(piEntry, QUALITY_PROFILE.BALANCED, HARDWARE_PROFILE.LOW)).toBeGreaterThan(
      scoreBackend(gpuEntry, QUALITY_PROFILE.BALANCED, HARDWARE_PROFILE.LOW)
    );
  });
});

describe('built-in discovery', () => {
  test('registers every engine shipped under backends/', async () => {
    const { registry } = makeRegistry();
    const loaded = await registry.loadBuiltinBackends();
    // Basic Pitch is the engine in the tree today; the assertion is on
    // "discovery works and every module it found registered", not on a
    // hard-coded list that would have to be edited for each new engine.
    expect(loaded).toContain('basic-pitch');
    expect(registry.size).toBe(loaded.length);
  });

  test('a discovered engine is NOT assumed to be installed', async () => {
    const { registry } = makeRegistry();
    await registry.loadBuiltinBackends();
    // Shipping the adapter is not shipping the model: until the operator
    // installs the environment, the engine is listed and unavailable (§44).
    for (const entry of registry.list()) {
      expect(entry.available).toBe(false);
      expect(entry.status).toBe(BACKEND_STATUS.NOT_INSTALLED);
    }
  });
});

describe('settings', () => {
  test('reads the resolved transcription settings from the injected config', () => {
    const registry = new TranscriptionBackendRegistry({
      logger: silentLogger,
      config: { transcription: { maxParallelJobs: 4, availabilityCacheMs: 1000 } }
    });
    expect(registry.settings.maxParallelJobs).toBe(4);
    expect(registry.settings.availabilityCacheMs).toBe(1000);
  });

  test('constructs with no dependencies at all', () => {
    const registry = new TranscriptionBackendRegistry();
    expect(registry.size).toBe(0);
    expect(registry.settings.enabled).toBe(true);
  });

  test('only depends on services the Application registers before it', () => {
    // The registry is built with the app-facade Proxy. It may capture
    // `config`, `logger` and `eventBus` eagerly because those exist from the
    // Application constructor onwards; touching anything else at construction
    // would freeze an `undefined` (registration-order contract, CLAUDE.md).
    const touched = new Set();
    const facade = new Proxy(
      { logger: silentLogger, eventBus: { emit() {} }, config: {} },
      {
        get(target, prop) {
          if (typeof prop === 'string') touched.add(prop);
          return target[prop];
        }
      }
    );
    new TranscriptionBackendRegistry(facade);
    expect([...touched].sort()).toEqual(['config', 'eventBus', 'logger']);
  });

  test('performs no filesystem work at construction', () => {
    const dataDir = `./data/transcription-test-${Date.now()}`;
    const registry = new TranscriptionBackendRegistry({
      logger: silentLogger,
      config: { transcription: { dataDir } }
    });
    expect(registry.settings.dataDir).toBe(dataDir);
    expect(existsSync(transcriptionPaths(registry.settings).root)).toBe(false);
  });
});
