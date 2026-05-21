/**
 * @file src/midi/adaptation/SuggestionCacheService.js
 * @description LRU cache + critical-section mutex backing the
 * `generate_assignment_suggestions` command.
 *
 * Extracted from `PlaybackAnalysisCommands` (ROADMAP_DI_2026-05-21 reco
 * #7) to remove the anti-pattern of using the `deps` Proxy facade as a
 * mutable per-app store via `app._suggestionCache`/`app._suggestionLock`
 * — the Proxy target is `{}`, so those writes were invisible to anyone
 * reading through the `Application` instance.
 *
 * Cache invalidation:
 *   - The underlying `AnalysisCache` self-invalidates on file events
 *     (`file_write`/`file_delete`/`file_uploaded`).
 *   - Wholesale clear on `instrument_settings_changed` /
 *     `device_settings_changed` — those events can change the scoring
 *     surface for *every* file, so per-file invalidation is too narrow.
 *
 * Suggestion lock:
 *   - `applyScoringOverrides` mutates a global singleton; the lock
 *     serialises the apply→compute→restore window so concurrent
 *     requests cannot interleave each other's scoring weights.
 *   - Read-only cache hits stay outside the lock (handled by the
 *     command itself) so reopening the modal is never blocked.
 */
import AnalysisCache from '../playback/AnalysisCache.js';

const DEFAULT_MAX_SIZE = 64;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class SuggestionCacheService {
  /**
   * @param {Object} deps - DI bag. Reads `eventBus` and `logger`.
   */
  constructor(deps) {
    this._eventBus = deps.eventBus || null;
    this._logger = deps.logger || null;
    this._cache = new AnalysisCache({
      maxSize: DEFAULT_MAX_SIZE,
      maxBytes: DEFAULT_MAX_BYTES,
      eventBus: this._eventBus,
      logger: this._logger
    });
    this._lock = Promise.resolve();

    if (this._eventBus && typeof this._eventBus.on === 'function') {
      this._onSettingsChanged = () => this._cache.clear();
      this._eventBus.on('instrument_settings_changed', this._onSettingsChanged);
      this._eventBus.on('device_settings_changed', this._onSettingsChanged);
    }
  }

  /**
   * @param {string|number} fileId
   * @param {string} key
   * @returns {*} The cached value, or `undefined`.
   */
  get(fileId, key) {
    return this._cache.get(fileId, key);
  }

  /**
   * @param {string|number} fileId
   * @param {string} key
   * @param {*} value
   */
  set(fileId, key, value) {
    this._cache.set(fileId, key, value);
  }

  /**
   * Serialise an apply→compute→restore critical section. Concurrent
   * calls queue behind each other; rejections of `fn` release the lock
   * so the next caller is not stuck.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  runExclusive(fn) {
    const prev = this._lock;
    let release;
    this._lock = new Promise((r) => { release = r; });
    const run = prev.then(() => fn());
    run.then(release, release);
    return run;
  }
}

export default SuggestionCacheService;
