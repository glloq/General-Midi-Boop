/**
 * @file src/transcription/TranscriptionCapabilities.js
 * @description The vocabulary shared by every transcription backend:
 * lifecycle status, declared capabilities, expected audio format and
 * licensing. Normalisers here are the single gate through which backend
 * metadata enters the rest of the system, so a partially-filled descriptor
 * can never reach the UI as a set of `undefined` flags.
 *
 * Two deliberate safe defaults:
 *   - every capability defaults to **false** — a backend advertises what it
 *     can do, it never inherits an ability it did not claim (§6);
 *   - `commercialUse` / `redistribution` default to **false** and
 *     `modelLicense` to `null` — an unverified licence is never presented as
 *     permissive (§9).
 */

/**
 * Lifecycle status of a backend on this host.
 *
 * - `available` — installed, smoke-tested, usable right now.
 * - `not_installed` — known backend, nothing installed, and this build has
 *   no automated installer for it.
 * - `installable` — not installed, but the backend can install itself
 *   (PR 11) on this platform.
 * - `license_restricted` — installable only after the user has read and
 *   accepted the model licence; never auto-installed, never bundled.
 * - `unsupported_platform` — this CPU architecture / OS cannot run it.
 * - `broken` — installed but unusable (missing venv, failed smoke test).
 * @enum {string}
 */
export const BACKEND_STATUS = Object.freeze({
  AVAILABLE: 'available',
  NOT_INSTALLED: 'not_installed',
  INSTALLABLE: 'installable',
  LICENSE_RESTRICTED: 'license_restricted',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  BROKEN: 'broken'
});

/** @type {ReadonlyArray<string>} Every value of {@link BACKEND_STATUS}. */
export const BACKEND_STATUSES = Object.freeze(Object.values(BACKEND_STATUS));

/**
 * Coarse hardware classes used by the `auto` engine selection (§36/§37).
 * Detection itself is out of scope here — callers pass the profile in.
 * @enum {string}
 */
export const HARDWARE_PROFILE = Object.freeze({
  LOW: 'low',
  STANDARD: 'standard',
  HIGH: 'high'
});

/**
 * Quality presets offered in the UI (§30). They select a backend and a
 * post-processing preset; they are NOT the post-processing presets
 * themselves (`raw` / `balanced` / `clean`, see MidiPostProcessor in PR 4).
 * @enum {string}
 */
export const QUALITY_PROFILE = Object.freeze({
  FAST: 'fast',
  BALANCED: 'balanced',
  MAXIMUM: 'maximum'
});

/**
 * What a backend can extract. Everything defaults to false.
 * @typedef {Object} BackendCapabilities
 * @property {boolean} polyphonic - Several simultaneous notes per source.
 * @property {boolean} multiInstrument - Separates sources into tracks.
 * @property {boolean} drums - Recognises percussion as percussion.
 * @property {boolean} pitchBend - Emits continuous pitch information.
 * @property {boolean} dynamics - Emits meaningful per-note velocity.
 * @property {boolean} instrumentRecognition - Labels tracks by instrument.
 * @property {boolean} tempoDetection - Emits a tempo map.
 * @property {boolean} progress - Reports progress while running (otherwise
 *   the UI must show an indeterminate bar — §31).
 */
export const DEFAULT_BACKEND_CAPABILITIES = Object.freeze({
  polyphonic: false,
  multiInstrument: false,
  drums: false,
  pitchBend: false,
  dynamics: false,
  instrumentRecognition: false,
  tempoDetection: false,
  progress: false
});

/**
 * Runtime requirements, used to decide whether a backend is a sane choice
 * on the current host and what the installer has to provide.
 * @typedef {Object} BackendRuntime
 * @property {boolean} python - Needs an isolated Python environment.
 * @property {boolean} gpu - Needs (or strongly benefits from) a GPU.
 * @property {boolean} raspberryPiSuitable - Realistically usable on a Pi.
 * @property {?number} minimumRamMb - Advisory RAM floor, null when unknown.
 */
export const DEFAULT_BACKEND_RUNTIME = Object.freeze({
  python: false,
  gpu: false,
  raspberryPiSuitable: false,
  minimumRamMb: null
});

/**
 * Audio the backend expects to be handed. The preprocessor converts every
 * user file to exactly this (§4/§5) — no backend ever decodes user bytes
 * itself.
 * @typedef {Object} BackendAudioFormat
 * @property {string} container - `wav` only, for now.
 * @property {string} encoding - FFmpeg codec name, e.g. `pcm_s16le`.
 * @property {number} sampleRate - Hz.
 * @property {number} channels - 1 (mono) or 2 (stereo).
 */
export const DEFAULT_AUDIO_FORMAT = Object.freeze({
  container: 'wav',
  encoding: 'pcm_s16le',
  sampleRate: 22050,
  channels: 1
});

/**
 * Licensing of the backend's CODE and of its MODEL WEIGHTS — they routinely
 * differ, and the distinction is the whole point of §9.
 * @typedef {Object} BackendLicensing
 * @property {string} codeLicense - SPDX id of the runner/wrapper code.
 * @property {?string} modelLicense - SPDX id or free text; null when the
 *   backend ships no weights or the licence has not been verified.
 * @property {boolean} commercialUse - False unless verified permissive.
 * @property {boolean} redistribution - May GMB redistribute the weights?
 * @property {boolean} bundled - Are the weights shipped inside this repo?
 *   Must stay false for anything non-trivial (§47.15).
 * @property {?string} licenseUrl - Canonical licence text.
 * @property {?string} notice - Short sentence shown before installation.
 * @property {boolean} requiresConsent - Installation must be gated behind an
 *   explicit "I accept" action (§8).
 */
export const DEFAULT_LICENSING = Object.freeze({
  codeLicense: 'unknown',
  modelLicense: null,
  commercialUse: false,
  redistribution: false,
  bundled: false,
  licenseUrl: null,
  notice: null,
  requiresConsent: true
});

/** Backend ids are used in paths (venvs, temp dirs) and in the API. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * @param {*} value
 * @returns {boolean} True for plain `{...}` objects (excludes arrays/null).
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `source` onto `defaults`, keeping only keys that exist in
 * `defaults` and coercing each value to the default's type. Unknown keys
 * are dropped so a typo cannot masquerade as a capability.
 *
 * @param {Object} defaults
 * @param {*} source
 * @returns {Object} Frozen merged record.
 */
function mergeTyped(defaults, source) {
  const input = isPlainObject(source) ? source : {};
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key];
    if (value === undefined || value === null) {
      out[key] = fallback;
      continue;
    }
    if (typeof fallback === 'boolean') {
      out[key] = value === true;
    } else if (typeof fallback === 'number') {
      out[key] = Number.isFinite(Number(value)) ? Number(value) : fallback;
    } else if (typeof fallback === 'string') {
      out[key] = typeof value === 'string' ? value : fallback;
    } else {
      // Nullable field (string|null, number|null): accept the raw value when
      // it is a primitive, otherwise keep the default.
      out[key] = typeof value === 'object' ? fallback : value;
    }
  }
  return Object.freeze(out);
}

/**
 * @param {*} capabilities
 * @returns {BackendCapabilities}
 */
export function normalizeCapabilities(capabilities) {
  return /** @type {BackendCapabilities} */ (
    mergeTyped(DEFAULT_BACKEND_CAPABILITIES, capabilities)
  );
}

/**
 * @param {*} runtime
 * @returns {BackendRuntime}
 */
export function normalizeRuntime(runtime) {
  return /** @type {BackendRuntime} */ (mergeTyped(DEFAULT_BACKEND_RUNTIME, runtime));
}

/**
 * @param {*} format
 * @returns {BackendAudioFormat}
 */
export function normalizeAudioFormat(format) {
  const merged = mergeTyped(DEFAULT_AUDIO_FORMAT, format);
  const sampleRate =
    Number.isFinite(merged.sampleRate) && merged.sampleRate > 0
      ? Math.round(merged.sampleRate)
      : DEFAULT_AUDIO_FORMAT.sampleRate;
  const channels = merged.channels === 2 ? 2 : 1;
  return Object.freeze({ ...merged, sampleRate, channels });
}

/**
 * @param {*} licensing
 * @returns {BackendLicensing}
 */
export function normalizeLicensing(licensing) {
  const merged = mergeTyped(DEFAULT_LICENSING, licensing);
  // A model whose licence forbids commercial use or redistribution can never
  // be shipped inside the repository, whatever the descriptor claims.
  const bundled = merged.bundled && merged.redistribution;
  // Consent is mandatory as soon as the model is restricted in any way, even
  // if the backend author forgot to ask for it. Only a backend that both
  // allows commercial use and opts out explicitly installs without a prompt.
  const requiresConsent = merged.requiresConsent || !merged.commercialUse;
  return Object.freeze({ ...merged, bundled, requiresConsent });
}

/**
 * Validate and normalise a backend descriptor.
 *
 * @param {Object} metadata - Raw value returned by `backend.getMetadata()`.
 * @returns {Object} Frozen descriptor with every section filled in.
 * @throws {Error} When `id` or `name` is missing or malformed — an authoring
 *   mistake that must fail at registration, not at the first transcription.
 */
export function normalizeBackendMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    throw new Error('Backend metadata must be an object');
  }
  const { id, name } = metadata;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(
      `Backend id must match ${ID_PATTERN} (lowercase, digits and dashes): ${JSON.stringify(id)}`
    );
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Backend "${id}" must declare a non-empty name`);
  }
  return Object.freeze({
    id,
    name: name.trim(),
    description: typeof metadata.description === 'string' ? metadata.description : '',
    version: typeof metadata.version === 'string' ? metadata.version : null,
    /** Short marketing-free positioning line shown in Settings (§33). */
    kind: typeof metadata.kind === 'string' ? metadata.kind : 'unknown',
    capabilities: normalizeCapabilities(metadata.capabilities),
    runtime: normalizeRuntime(metadata.runtime),
    audioFormat: normalizeAudioFormat(metadata.audioFormat),
    licensing: normalizeLicensing(metadata.licensing),
    /**
     * Quality profiles the backend actually implements. The modal disables
     * the ones a backend does not offer instead of silently ignoring them.
     */
    qualityProfiles: Array.isArray(metadata.qualityProfiles)
      ? Object.freeze(
          metadata.qualityProfiles.filter((p) => Object.values(QUALITY_PROFILE).includes(p))
        )
      : Object.freeze([QUALITY_PROFILE.BALANCED]),
    /**
     * Selection weight for `auto` mode: higher wins among otherwise equal
     * candidates. Keeps the recommendation deterministic (§36).
     */
    priority: Number.isFinite(metadata.priority) ? Number(metadata.priority) : 0
  });
}

/**
 * @param {string} status - A {@link BACKEND_STATUS} value.
 * @returns {boolean} True when the backend can run a transcription now.
 */
export function isBackendUsable(status) {
  return status === BACKEND_STATUS.AVAILABLE;
}

/**
 * Bridge to the health vocabulary used by `Application.getCapabilityStatus()`
 * (`ready` / `degraded` / `failed` / `disabled`).
 *
 * "Not installed" maps to **disabled**, never to failed: transcription is an
 * optional feature and its absence must not drag `/api/health` down (§23/§44).
 * Only a backend that IS installed and broken is a failure.
 *
 * @param {string} status - A {@link BACKEND_STATUS} value.
 * @returns {string} `ready` | `failed` | `disabled`
 */
export function backendStatusToHealth(status) {
  switch (status) {
    case BACKEND_STATUS.AVAILABLE:
      return 'ready';
    case BACKEND_STATUS.BROKEN:
      return 'failed';
    default:
      return 'disabled';
  }
}

export default {
  BACKEND_STATUS,
  BACKEND_STATUSES,
  HARDWARE_PROFILE,
  QUALITY_PROFILE,
  DEFAULT_BACKEND_CAPABILITIES,
  DEFAULT_BACKEND_RUNTIME,
  DEFAULT_AUDIO_FORMAT,
  DEFAULT_LICENSING,
  normalizeCapabilities,
  normalizeRuntime,
  normalizeAudioFormat,
  normalizeLicensing,
  normalizeBackendMetadata,
  isBackendUsable,
  backendStatusToHealth
};
