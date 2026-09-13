/**
 * @file src/transcription/TranscriptionConfig.js
 * @description Resolves the `transcription` section of the layered GMB
 * configuration (`config.json` → `.env` → `GMBOOP_*`) into one frozen,
 * validated settings object, and derives the on-disk layout from it.
 *
 * Resolution lives here rather than in each service so the resource guards
 * that keep a Raspberry Pi alive (§22) are defined once and cannot drift:
 * every value is clamped to a range the hardware can actually survive, and
 * an operator typo degrades to the default instead of disabling a limit.
 */
import path from 'path';

/**
 * Defaults tuned for the smallest supported target (Pi 3B+, 1 GB RAM,
 * Node heap capped at 384 MB by `ecosystem.config.cjs`).
 * @type {Readonly<Object>}
 */
export const TRANSCRIPTION_DEFAULTS = Object.freeze({
  /** Master switch. When false the feature reports `disabled` everywhere. */
  enabled: true,
  /** Root of everything the feature writes. Relative paths resolve from cwd. */
  dataDir: './data/transcription',
  /** Largest audio file accepted for upload (bytes). */
  maxAudioFileBytes: 100 * 1024 * 1024,
  /** Longest audio accepted (seconds). 10 min ≈ 20 min of CPU on a Pi 4. */
  maxAudioDurationSeconds: 600,
  /** Concurrent transcriptions. 1 on a Pi: a second job would swap. */
  maxParallelJobs: 1,
  /** Ceiling for `<dataDir>/tmp` before new jobs are refused (bytes). */
  maxTempDiskBytes: 2 * 1024 * 1024 * 1024,
  /** Wall-clock cap for one job, all stages included (ms). */
  jobTimeoutMs: 15 * 60 * 1000,
  /** Keep the uploaded audio after import? Off — GMB is a MIDI library (§28). */
  keepOriginalAudio: false,
  /** Keep per-job scratch directories for debugging (§21). */
  keepTempFiles: false,
  /** Default MidiPostProcessor preset: `raw` | `balanced` | `clean` (§13). */
  postProcessingPreset: 'balanced',
  /** How long a backend availability probe is trusted (ms). */
  availabilityCacheMs: 60 * 1000,
  /** Import the generated MIDI into the library automatically (§26). */
  autoImportToLibrary: true
});

/** Accepted values for `postProcessingPreset`. */
export const POST_PROCESSING_PRESETS = Object.freeze(['raw', 'balanced', 'clean']);

/**
 * Bounds applied to every numeric setting. The upper bounds are not
 * arbitrary: they are the point past which the feature would compete with
 * playback for RAM and CPU on the reference hardware.
 */
const BOUNDS = Object.freeze({
  maxAudioFileBytes: { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 },
  maxAudioDurationSeconds: { min: 1, max: 4 * 60 * 60 },
  maxParallelJobs: { min: 1, max: 8 },
  maxTempDiskBytes: { min: 64 * 1024 * 1024, max: 64 * 1024 * 1024 * 1024 },
  jobTimeoutMs: { min: 10 * 1000, max: 6 * 60 * 60 * 1000 },
  availabilityCacheMs: { min: 0, max: 60 * 60 * 1000 }
});

/**
 * Read `transcription.<key>` from a {@link module:src/core/Config} instance
 * or from a plain object — tests and scripts should not have to build a
 * Config to resolve settings.
 *
 * @param {Object} config - Config instance (`.get(path, default)`) or a
 *   plain `{ transcription: {...} }` / `{...}` object.
 * @param {string} key
 * @returns {*} Raw value or undefined.
 */
function readValue(config, key) {
  if (!config) return undefined;
  if (typeof config.get === 'function') {
    const value = config.get(`transcription.${key}`, undefined);
    if (value !== undefined && value !== null) return value;
    return undefined;
  }
  const section =
    config.transcription && typeof config.transcription === 'object'
      ? config.transcription
      : config;
  const value = section[key];
  return value === null ? undefined : value;
}

/**
 * @param {*} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

/**
 * Coerce to a number and clamp into `BOUNDS[key]`. An unparseable value
 * falls back to the default: a limit must never end up disabled because a
 * config file has a typo in it.
 *
 * @param {*} value
 * @param {string} key
 * @returns {number}
 */
function toBoundedNumber(value, key) {
  const fallback = TRANSCRIPTION_DEFAULTS[key];
  const bounds = BOUNDS[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (value === undefined || !Number.isFinite(parsed)) return fallback;
  if (!bounds) return parsed;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}

/**
 * Resolve the effective, validated transcription settings.
 *
 * @param {Object} config - Config instance or plain object.
 * @returns {Readonly<Object>} Frozen settings; every key of
 *   {@link TRANSCRIPTION_DEFAULTS} is present.
 */
export function resolveTranscriptionConfig(config) {
  const rawPreset = readValue(config, 'postProcessingPreset');
  const preset = POST_PROCESSING_PRESETS.includes(rawPreset)
    ? rawPreset
    : TRANSCRIPTION_DEFAULTS.postProcessingPreset;

  const rawDataDir = readValue(config, 'dataDir');
  const dataDir =
    typeof rawDataDir === 'string' && rawDataDir.trim().length > 0
      ? rawDataDir.trim()
      : TRANSCRIPTION_DEFAULTS.dataDir;

  return Object.freeze({
    enabled: toBoolean(readValue(config, 'enabled'), TRANSCRIPTION_DEFAULTS.enabled),
    dataDir,
    maxAudioFileBytes: toBoundedNumber(readValue(config, 'maxAudioFileBytes'), 'maxAudioFileBytes'),
    maxAudioDurationSeconds: toBoundedNumber(
      readValue(config, 'maxAudioDurationSeconds'),
      'maxAudioDurationSeconds'
    ),
    maxParallelJobs: toBoundedNumber(readValue(config, 'maxParallelJobs'), 'maxParallelJobs'),
    maxTempDiskBytes: toBoundedNumber(readValue(config, 'maxTempDiskBytes'), 'maxTempDiskBytes'),
    jobTimeoutMs: toBoundedNumber(readValue(config, 'jobTimeoutMs'), 'jobTimeoutMs'),
    keepOriginalAudio: toBoolean(
      readValue(config, 'keepOriginalAudio'),
      TRANSCRIPTION_DEFAULTS.keepOriginalAudio
    ),
    keepTempFiles: toBoolean(
      readValue(config, 'keepTempFiles'),
      TRANSCRIPTION_DEFAULTS.keepTempFiles
    ),
    postProcessingPreset: preset,
    availabilityCacheMs: toBoundedNumber(
      readValue(config, 'availabilityCacheMs'),
      'availabilityCacheMs'
    ),
    autoImportToLibrary: toBoolean(
      readValue(config, 'autoImportToLibrary'),
      TRANSCRIPTION_DEFAULTS.autoImportToLibrary
    )
  });
}

/**
 * Derive the on-disk layout (§7/§21). Absolute paths on purpose: the temp
 * guards and the path-traversal checks added with the preprocessor (PR 2)
 * compare resolved prefixes, which only works on absolute paths.
 *
 * Nothing is created here — this module performs no I/O. Directory creation
 * belongs to the services that actually write (TempFileManager, installer).
 *
 * @param {Readonly<Object>} settings - Result of
 *   {@link resolveTranscriptionConfig}.
 * @returns {Readonly<{root:string, tmpDir:string, venvsDir:string,
 *   modelsDir:string, cacheDir:string, audioDir:string}>}
 */
export function transcriptionPaths(settings) {
  const root = path.resolve(settings?.dataDir || TRANSCRIPTION_DEFAULTS.dataDir);
  return Object.freeze({
    root,
    /** Per-job scratch: `<root>/tmp/<job-id>/`. */
    tmpDir: path.join(root, 'tmp'),
    /** Isolated Python environments, one per backend (§7). */
    venvsDir: path.join(root, 'venvs'),
    /** Downloaded model weights — never committed to the repository. */
    modelsDir: path.join(root, 'models'),
    /** Reusable artefacts (probe results, converted audio). */
    cacheDir: path.join(root, 'cache'),
    /** Source audio kept when `keepOriginalAudio` is on (§28). */
    audioDir: path.join(root, 'audio')
  });
}

export default {
  TRANSCRIPTION_DEFAULTS,
  POST_PROCESSING_PRESETS,
  resolveTranscriptionConfig,
  transcriptionPaths
};
