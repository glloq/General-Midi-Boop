/**
 * @file src/api/commands/schemas/transcription.schemas.js
 * @description Declarative validation for the `transcription_*` commands
 * (ADR-004). Payload validation is fail-closed, so every command that reads
 * its payload needs an entry here — see `validation-policy.js`.
 *
 * The rules are lenient about representation and strict about shape, like
 * every other schema file: the SPA sends what it sends, and the handlers
 * normalise. What these rules stop is an object where a string belongs, a
 * 200 000-character "job id", and an `options` bag deep enough to blow the
 * stack when it is cloned.
 */
import { fieldRules, isNonEmptyStr, isPlainObject, isStr, MAX_ID_LEN } from './helpers.js';

/** Quality profiles the modal offers (§30). */
const QUALITY_VALUES = ['fast', 'balanced', 'maximum'];
/** Post-processing presets (§13). */
const PRESET_VALUES = ['raw', 'balanced', 'clean'];

/**
 * A job id as produced by the job manager: `job-` plus 16 hex characters.
 * Matching the real shape (rather than "any string") keeps a hostile id out
 * of the maps it would otherwise be looked up in.
 * @param {*} value
 * @returns {boolean}
 */
function isJobId(value) {
  return typeof value === 'string' && /^job-[a-f0-9]{8,32}$/.test(value);
}

/**
 * Base64 payload: a plausibly-encoded, bounded string. The real size check
 * happens after decoding, in the handler — this only stops a caller from
 * pinning hundreds of megabytes in the frame parser.
 * @param {*} value
 * @returns {boolean}
 */
function isBase64Audio(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // 8 MB of audio is ~10.7 MB of base64; allow a little headroom.
  if (value.length > 12 * 1024 * 1024) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

/**
 * Options bag: a shallow record of flags the backend and post-processor
 * understand. Rejecting deep nesting here is what keeps a 600-level payload
 * out of the pipeline.
 * @param {*} value
 * @returns {boolean}
 */
function isOptionsBag(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > 32) return false;
  return keys.every((key) => {
    if (key.length > 64) return false;
    const entry = value[key];
    if (entry === null) return true;
    const type = typeof entry;
    if (type === 'boolean' || type === 'number') return true;
    if (type === 'string') return entry.length <= 256;
    // One level of nesting is allowed (`postProcessing: {...}`), no more.
    if (isPlainObject(entry)) {
      return Object.values(entry).every((leaf) => leaf === null || typeof leaf !== 'object');
    }
    return false;
  });
}

const requireJobId = {
  custom: fieldRules([
    ['jobId', isJobId, 'jobId must be a transcription job identifier', { required: true }]
  ])
};

export const transcription_status = {
  // jobId is optional here: without one the command lists every job.
  custom: fieldRules([['jobId', isJobId, 'jobId must be a transcription job identifier']])
};

export const transcription_cancel = requireJobId;
export const transcription_result = requireJobId;
export const transcription_delete = requireJobId;

const optionalRefresh = {
  custom: fieldRules([['refresh', (v) => typeof v === 'boolean', 'refresh must be a boolean']])
};

export const transcription_backends = optionalRefresh;
export const transcription_capabilities = optionalRefresh;

export const transcription_create = {
  custom: fieldRules([
    [
      'filename',
      (v) => isNonEmptyStr(v, 255),
      'filename must be a non-empty string of at most 255 characters',
      { required: true }
    ],
    ['audio', isBase64Audio, 'audio must be a base64-encoded payload', { required: true }],
    ['backendId', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'backendId must be a non-empty string'],
    [
      'quality',
      (v) => QUALITY_VALUES.includes(v),
      `quality must be one of: ${QUALITY_VALUES.join(', ')}`
    ],
    [
      'preset',
      (v) => PRESET_VALUES.includes(v),
      `preset must be one of: ${PRESET_VALUES.join(', ')}`
    ],
    [
      'folder',
      (v) => isStr(v, 512) && v.startsWith('/'),
      'folder must be an absolute library path'
    ],
    ['options', isOptionsBag, 'options must be a shallow object of flags']
  ])
};

const schemas = {
  transcription_capabilities,
  transcription_backends,
  transcription_create,
  transcription_status,
  transcription_cancel,
  transcription_result,
  transcription_delete
};

export default schemas;
