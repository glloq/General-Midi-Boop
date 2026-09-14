/**
 * @file src/transcription/TranscriptionBackendRegistry.js
 * @description Holds every known transcription engine, caches what each one
 * can actually do on this host, and answers "which engine should run this
 * job?".
 *
 * It is the only place allowed to know that several engines exist: services
 * ask the registry for a backend and then talk to the
 * {@link TranscriptionBackend} interface. Nothing here imports a model, spawns
 * a process or touches the network — a host with no Python, no FFmpeg and no
 * model still constructs the registry successfully, it simply lists no
 * available backend (§44).
 *
 * Backends under `backends/` are auto-discovered the same way command modules
 * are (`CommandRegistry.loadCommandModules`): a module that fails to import —
 * because its optional runtime is missing — is logged and skipped, never
 * fatal.
 */
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  BACKEND_STATUS,
  isBackendUsable,
  normalizeBackendMetadata,
  HARDWARE_PROFILE,
  QUALITY_PROFILE
} from './TranscriptionCapabilities.js';
import { resolveTranscriptionConfig } from './TranscriptionConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Used when no logger is injected (tests). */
const NULL_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

/**
 * How long a backend that says nothing gets to answer `checkAvailability()`.
 *
 * The point is a backend that HANGS — a subprocess probe with no timeout of
 * its own, a stat on a dead NFS mount — not one that is merely slow. A
 * backend that knows its probe is slow says so with `probeTimeoutMs`:
 * loading TensorFlow takes tens of seconds on a Raspberry Pi, and capping
 * that at eight would report a perfectly good engine as `broken` on every
 * boot, then send its owner to reinstall something that was never broken.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** No backend may exceed this, whatever it declares. */
const MAX_PROBE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The probe budget for one backend: its own, clamped.
 *
 * @param {Object} backend
 * @returns {number}
 */
export function probeTimeoutFor(backend) {
  const declared = Number(backend?.probeTimeoutMs);
  if (!Number.isFinite(declared) || declared <= 0) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(Math.max(declared, DEFAULT_PROBE_TIMEOUT_MS), MAX_PROBE_TIMEOUT_MS);
}

/**
 * Availability record kept per backend.
 * @typedef {Object} CachedAvailability
 * @property {string} status
 * @property {?string} detail
 * @property {?string} version
 * @property {?string} modelVersion
 * @property {?string} modelChecksum
 * @property {number} checkedAt - Epoch ms.
 */

/** Registry of transcription engines. Registered in `Application.initialize()`. */
export class TranscriptionBackendRegistry {
  /**
   * @param {Object} [deps] - Service-container facade. Reads `logger`,
   *   `eventBus` and `config`; all are optional.
   */
  constructor(deps = {}) {
    this._deps = deps;
    this.logger = deps.logger || NULL_LOGGER;
    this.eventBus = deps.eventBus || null;
    this.settings = resolveTranscriptionConfig(deps.config);

    /** @type {Map<string, import('./TranscriptionBackend.js').TranscriptionBackend>} */
    this._backends = new Map();
    /** @type {Map<string, Object>} Normalised metadata, by backend id. */
    this._metadata = new Map();
    /** @type {Map<string, CachedAvailability>} */
    this._availability = new Map();
    /** @type {Map<string, Promise<CachedAvailability>>} In-flight probes. */
    this._probes = new Map();
  }

  /** @returns {number} Number of registered backends. */
  get size() {
    return this._backends.size;
  }

  /**
   * Register a backend instance. Metadata is normalised (and therefore
   * validated) here, so an authoring mistake fails loudly at boot rather
   * than at the first transcription.
   *
   * @param {Object} backend - A {@link TranscriptionBackend} instance.
   * @returns {string} The registered backend id.
   * @throws {Error} On malformed metadata, a duplicate id, or a missing
   *   method of the interface.
   */
  register(backend) {
    if (!backend || typeof backend.getMetadata !== 'function') {
      throw new Error('TranscriptionBackendRegistry: backend must implement getMetadata()');
    }
    const metadata = normalizeBackendMetadata(backend.getMetadata());
    for (const method of ['checkAvailability', 'transcribe']) {
      if (typeof backend[method] !== 'function') {
        throw new Error(`Backend "${metadata.id}" must implement ${method}()`);
      }
    }
    if (this._backends.has(metadata.id)) {
      throw new Error(`Backend "${metadata.id}" is already registered`);
    }
    this._backends.set(metadata.id, backend);
    this._metadata.set(metadata.id, metadata);
    this.logger.info(
      `Transcription backend registered: ${metadata.id} (${metadata.name}${metadata.version ? ` ${metadata.version}` : ''})`
    );
    return metadata.id;
  }

  /**
   * @param {string} id
   * @returns {boolean} True when a backend was removed.
   */
  unregister(id) {
    const backend = this._backends.get(id);
    if (!backend) return false;
    try {
      backend.destroy?.();
    } catch (error) {
      this.logger.warn(`Transcription backend "${id}" destroy() failed: ${error.message}`);
    }
    this._backends.delete(id);
    this._metadata.delete(id);
    this._availability.delete(id);
    this._probes.delete(id);
    return true;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._backends.has(id);
  }

  /**
   * @param {string} id
   * @returns {?Object} The backend instance, or null when unknown.
   */
  get(id) {
    return this._backends.get(id) || null;
  }

  /**
   * Every backend with its last known status, ready for the API and the
   * Settings UI. Ordered by descending selection priority then by name, so
   * the list is stable across calls.
   *
   * Statuses come from the cache: call {@link detectAvailable} first if a
   * fresh probe matters. A never-probed backend reports `not_installed`
   * rather than pretending to be ready.
   *
   * @returns {Object[]}
   */
  list() {
    const entries = [];
    for (const [id, backend] of this._backends) {
      entries.push(this._describe(id, backend));
    }
    entries.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    return entries;
  }

  /**
   * Probe every backend (respecting the availability cache) and return the
   * descriptors of those that can run right now.
   *
   * @param {{force?: boolean}} [options] - `force` bypasses the cache.
   * @returns {Promise<Object[]>} Usable backends, in `list()` order.
   */
  async detectAvailable({ force = false } = {}) {
    await Promise.all(
      [...this._backends.keys()].map((id) =>
        this._probe(id, { force }).catch(() => {
          /* _probe never rejects; guard is belt-and-braces */
        })
      )
    );
    return this.list().filter((entry) => entry.available);
  }

  /**
   * Force a fresh probe, of one backend or of all of them.
   *
   * @param {?string} [id] - Omit to refresh everything.
   * @returns {Promise<Object[]>} Descriptors of the refreshed backends.
   */
  async refresh(id = null) {
    if (id) {
      if (!this._backends.has(id)) return [];
      await this._probe(id, { force: true });
      return [this._describe(id, this._backends.get(id))];
    }
    await this.detectAvailable({ force: true });
    return this.list();
  }

  /**
   * Pick the engine for a job (§36). Synchronous by design — it reads the
   * cached availability, so callers run {@link detectAvailable} first and
   * then make several decisions without re-probing.
   *
   * The reason is returned (and logged) so an unexpected choice can be
   * explained without re-running anything.
   *
   * @param {Object} [options]
   * @param {?string} [options.backendId] - Explicit user choice; wins when
   *   usable, and is reported as unavailable rather than silently replaced.
   * @param {string} [options.quality] - A {@link QUALITY_PROFILE} value.
   * @param {?number} [options.durationSeconds] - Source length, if known.
   * @param {boolean} [options.requireDrums]
   * @param {boolean} [options.requireMultiInstrument]
   * @param {string} [options.hardwareProfile] - A {@link HARDWARE_PROFILE}.
   * @returns {?{backend: Object, metadata: Object, reason: string}}
   */
  getRecommendedBackend(options = {}) {
    const {
      backendId = null,
      quality = QUALITY_PROFILE.BALANCED,
      requireDrums = false,
      requireMultiInstrument = false,
      hardwareProfile = HARDWARE_PROFILE.STANDARD
    } = options;

    const usable = this.list().filter((entry) => entry.available);
    if (usable.length === 0) {
      this.logger.info('Transcription: no backend available — nothing to recommend');
      return null;
    }

    if (backendId) {
      const explicit = usable.find((entry) => entry.id === backendId);
      if (!explicit) return null;
      return this._selection(explicit, `explicitly requested backend "${backendId}"`);
    }

    let candidates = usable;
    if (requireDrums) {
      candidates = candidates.filter((entry) => entry.capabilities.drums);
    }
    if (requireMultiInstrument) {
      candidates = candidates.filter((entry) => entry.capabilities.multiInstrument);
    }
    if (candidates.length === 0) {
      this.logger.info(
        `Transcription: no available backend satisfies the requested capabilities (drums=${requireDrums}, multiInstrument=${requireMultiInstrument})`
      );
      return null;
    }

    // On constrained hardware, an engine that does not claim to be Pi-suitable
    // is only used when it is the sole option.
    if (hardwareProfile === HARDWARE_PROFILE.LOW) {
      const light = candidates.filter((entry) => entry.runtime.raspberryPiSuitable);
      if (light.length > 0) candidates = light;
    }

    const scored = candidates
      .map((entry) => ({ entry, score: scoreBackend(entry, quality, hardwareProfile) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.priority - a.entry.priority ||
          a.entry.id.localeCompare(b.entry.id)
      );

    const best = scored[0];
    const reason =
      `auto selection for quality="${quality}" on a "${hardwareProfile}" host ` +
      `(score ${best.score}, ${scored.length} candidate${scored.length > 1 ? 's' : ''})`;
    return this._selection(best.entry, reason);
  }

  /**
   * Discover and register every backend module in `backends/`.
   *
   * A module must export either `createBackend(deps)` or a default class.
   * Import or registration failures are logged and skipped: an engine whose
   * optional runtime is absent must never prevent GMB from booting.
   *
   * @returns {Promise<string[]>} Ids of the backends that registered.
   */
  async loadBuiltinBackends() {
    const backendsDir = join(__dirname, 'backends');
    let files;
    try {
      files = readdirSync(backendsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
    } catch (error) {
      this.logger.warn(`Transcription: backends directory unreadable: ${error.message}`);
      return [];
    }

    const loaded = [];
    for (const file of files.sort()) {
      try {
        const mod = await import(join(backendsDir, file));
        const backend =
          typeof mod.createBackend === 'function'
            ? mod.createBackend(this._deps)
            : typeof mod.default === 'function'
              ? new mod.default(this._deps)
              : null;
        if (!backend) {
          this.logger.warn(
            `Transcription: ${file} exports neither createBackend() nor a default class, skipping`
          );
          continue;
        }
        loaded.push(this.register(backend));
      } catch (error) {
        this.logger.warn(`Transcription: backend module ${file} not loaded: ${error.message}`);
      }
    }
    this.logger.info(
      `Transcription backend registry initialized with ${this._backends.size} backend(s)`
    );
    return loaded;
  }

  /**
   * Drop cached probes and release every backend. Called from
   * `Application.stop()`.
   * @returns {void}
   */
  destroy() {
    for (const id of [...this._backends.keys()]) {
      this.unregister(id);
    }
    this._availability.clear();
    this._probes.clear();
  }

  /**
   * @param {string} id
   * @param {Object} backend
   * @returns {Object} Descriptor merging metadata and cached availability.
   * @private
   */
  _describe(id, backend) {
    const availability = this._availability.get(id) || null;
    if (typeof backend.describe === 'function') {
      return backend.describe(availability);
    }
    // A backend that does not extend the base class still gets a usable
    // descriptor — the interface is structural, not nominal.
    const metadata = this._metadata.get(id);
    const status = availability?.status || BACKEND_STATUS.NOT_INSTALLED;
    return {
      ...metadata,
      status,
      available: isBackendUsable(status),
      installed: status === BACKEND_STATUS.AVAILABLE || status === BACKEND_STATUS.BROKEN,
      detail: availability?.detail ?? null,
      installedVersion: availability?.version ?? null,
      modelVersion: availability?.modelVersion ?? null,
      modelChecksum: availability?.modelChecksum ?? null,
      checkedAt: availability?.checkedAt ?? null
    };
  }

  /**
   * @param {Object} entry - Descriptor from {@link list}.
   * @param {string} reason
   * @returns {{backend: Object, metadata: Object, reason: string}}
   * @private
   */
  _selection(entry, reason) {
    this.logger.info(`Transcription: selected backend "${entry.id}" — ${reason}`);
    return {
      backend: this._backends.get(entry.id),
      metadata: entry,
      reason
    };
  }

  /**
   * Probe one backend, honouring the cache and de-duplicating concurrent
   * calls. Never rejects: a throwing or hanging probe is an answer
   * (`broken`), not an exception for callers to handle.
   *
   * @param {string} id
   * @param {{force?: boolean}} [options]
   * @returns {Promise<CachedAvailability>}
   * @private
   */
  async _probe(id, { force = false } = {}) {
    const backend = this._backends.get(id);
    if (!backend) {
      return { status: BACKEND_STATUS.NOT_INSTALLED, detail: 'unknown backend', checkedAt: 0 };
    }

    const cached = this._availability.get(id);
    const ttl = this.settings.availabilityCacheMs;
    if (!force && cached && ttl > 0 && Date.now() - cached.checkedAt < ttl) {
      return cached;
    }
    const inFlight = this._probes.get(id);
    if (inFlight) return inFlight;

    const promise = this._runProbe(id, backend).finally(() => this._probes.delete(id));
    this._probes.set(id, promise);
    return promise;
  }

  /**
   * @param {string} id
   * @param {Object} backend
   * @returns {Promise<CachedAvailability>}
   * @private
   */
  async _runProbe(id, backend) {
    let timer = null;
    let report;
    const budgetMs = probeTimeoutFor(backend);
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: BACKEND_STATUS.BROKEN,
              detail: `availability check timed out after ${budgetMs}ms`
            }),
          budgetMs
        );
        if (timer.unref) timer.unref();
      });
      report = await Promise.race([
        Promise.resolve().then(() => backend.checkAvailability()),
        timeout
      ]);
    } catch (error) {
      report = { status: BACKEND_STATUS.BROKEN, detail: error.message };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const record = normalizeAvailability(report);
    const previous = this._availability.get(id);
    this._availability.set(id, record);

    if (!previous || previous.status !== record.status) {
      this.logger.info(
        `Transcription backend "${id}": ${previous ? previous.status : 'unknown'} → ${record.status}${record.detail ? ` (${record.detail})` : ''}`
      );
      // The UI mirrors backend availability, so this goes to the browser as
      // well as the bus — an engine that breaks mid-session should not need
      // a reopened panel to show it. `wsServer` registers after this
      // service, hence the lazy read rather than a captured reference.
      const payload = {
        backendId: id,
        status: record.status,
        previousStatus: previous ? previous.status : null,
        detail: record.detail
      };
      this.eventBus?.emit?.('transcription_backend_changed', payload);
      this._deps?.wsServer?.broadcast?.('transcription_backend_changed', payload);
    }
    return record;
  }
}

/**
 * Coerce whatever `checkAvailability()` returned into a cache record. An
 * unknown status is treated as `broken`: a backend that cannot describe its
 * own state is not one to hand a user's audio to.
 *
 * @param {*} report
 * @returns {CachedAvailability}
 */
function normalizeAvailability(report) {
  const source = report && typeof report === 'object' ? report : {};
  const known = Object.values(BACKEND_STATUS).includes(source.status);
  return {
    status: known ? source.status : BACKEND_STATUS.BROKEN,
    detail:
      typeof source.detail === 'string'
        ? source.detail
        : known
          ? null
          : 'invalid availability report',
    version: typeof source.version === 'string' ? source.version : null,
    modelVersion: typeof source.modelVersion === 'string' ? source.modelVersion : null,
    modelChecksum: typeof source.modelChecksum === 'string' ? source.modelChecksum : null,
    checkedAt: Date.now()
  };
}

/**
 * Score a candidate for `auto` selection. Deterministic and intentionally
 * blunt: the ranking must be explainable in one log line, not tuned.
 *
 * @param {Object} entry - Descriptor from {@link TranscriptionBackendRegistry#list}.
 * @param {string} quality - A {@link QUALITY_PROFILE} value.
 * @param {string} hardwareProfile - A {@link HARDWARE_PROFILE} value.
 * @returns {number}
 */
export function scoreBackend(entry, quality, hardwareProfile) {
  const caps = entry.capabilities;
  const runtime = entry.runtime;
  let score = 0;

  if (quality === QUALITY_PROFILE.MAXIMUM) {
    // Fidelity first: separating instruments is what makes a result usable
    // as an orchestration, and GPU cost is acceptable at this setting.
    if (caps.multiInstrument) score += 4;
    if (caps.instrumentRecognition) score += 2;
    if (caps.drums) score += 1;
    if (caps.pitchBend) score += 1;
  } else if (quality === QUALITY_PROFILE.FAST) {
    // Speed first: prefer something that runs on CPU without a GPU detour.
    if (!runtime.gpu) score += 3;
    if (runtime.raspberryPiSuitable) score += 2;
    if (caps.multiInstrument) score -= 1;
  } else {
    if (caps.multiInstrument) score += 2;
    if (caps.instrumentRecognition) score += 1;
    if (runtime.raspberryPiSuitable) score += 1;
  }

  if (hardwareProfile === HARDWARE_PROFILE.LOW) {
    if (runtime.raspberryPiSuitable) score += 3;
    if (runtime.gpu) score -= 3;
  } else if (hardwareProfile === HARDWARE_PROFILE.HIGH && runtime.gpu) {
    score += 1;
  }

  return score;
}

export default TranscriptionBackendRegistry;
