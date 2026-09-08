/**
 * @file src/api/commands/schemas/file.schemas.js
 * @description Declarative validation schemas for `file_*` WebSocket
 * commands. Consumed by `JsonValidator.validateFileCommand`.
 *
 * Note: `file_upload` is no longer a WebSocket command — uploads go through
 * `POST /api/files` (HTTP multipart-style raw body). See `apiRoutes.js`.
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isNumLike,
  isBoolLike,
  isStr,
  isNonEmptyStr,
  isArrayMax
} from './helpers.js';

const requireFileId = {
  custom: (data) => (!data.fileId ? 'fileId is required' : null)
};

export const file_delete = requireFileId;
export const file_export = requireFileId;

/**
 * Reject filenames containing path separators, control bytes, or
 * traversal segments. Stays liberal otherwise (unicode names, spaces,
 * punctuation) because the value is only persisted in the DB row and
 * displayed in the UI — disk paths use the content hash, not the
 * filename. Length cap matches the SQLite TEXT-with-CHECK convention.
 *
 * @param {*} value
 * @returns {?string} error message or null when valid.
 */
function validateFilename(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'newFilename is required';
  }
  if (value.length > 255) return 'newFilename is too long (max 255 chars)';
  if (/[\x00-\x1f\\/]/.test(value)) {
    return 'newFilename must not contain path separators or control bytes';
  }
  if (value === '.' || value === '..') return 'newFilename is reserved';
  return null;
}

/**
 * Folder paths are slash-separated POSIX-style and rooted at `/`. The
 * UI never builds an absolute disk path from them, but they appear in
 * routing-status broadcasts and filter responses so we still strip
 * traversal segments and control bytes.
 */
function validateFolder(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'folder is required';
  }
  if (value.length > 512) return 'folder is too long (max 512 chars)';
  if (/[\x00-\x1f\\]/.test(value)) {
    return 'folder must not contain control bytes or backslashes';
  }
  // Reject any `..` segment (defence in depth — current consumers don't
  // resolve the value against the filesystem, but future code might).
  if (value.split('/').some((seg) => seg === '..')) {
    return 'folder must not contain traversal segments';
  }
  return null;
}

export const file_rename = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    const filenameErr = validateFilename(data.newFilename);
    if (filenameErr) errors.push(filenameErr);
    return errors;
  }
};

export const file_move = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    const folderErr = validateFolder(data.folder);
    if (folderErr) errors.push(folderErr);
    return errors;
  }
};

// Bound the parsed-MIDI payload so a malformed or oversized write (the body is
// serialised straight to bytes and stored) is rejected at the edge instead of
// reaching `writeMidi`/BlobStore unchecked (audit P2 — file_write was
// unvalidated). Caps are generous but finite.
const MAX_WRITE_TRACKS = 256;
const MAX_WRITE_EVENTS = 500000;

// The `midi-file` writer serialises text/sysEx metas via Buffer.concat per
// event — O(n²) within a track. `file_write`/`file_save_as` are editor-only and
// the editor emits ZERO such metas, so this cap is pure DoS defence (audit D
// CRITICAL-2: ~50 000 marker events froze the single Node thread ~85 s).
const MAX_WRITE_META_EVENTS = 5000;

// SMF variable-length quantities are 28-bit. A `deltaTime` ≥ 2³¹ makes the
// library's writeVarInt spin forever (Int32 sign flip) and grow an array toward
// 2³² entries — a single event OOM-kills the Pi (audit D CRITICAL-1). Reject
// anything outside the legal VLQ range. deltaTimes are gaps between events, so
// legitimate values are tiny; this only rejects corrupt/malicious payloads.
const MIDI_VLQ_MAX = 0x0fffffff;

// Event types the `midi-file` writer recognises. An unknown/absent `type` makes
// it throw a bare STRING, which surfaces to the client as a generic
// "Internal server error" with `Command failed: undefined` in the log (audit D
// MEDIUM-3); reject it here as a clean ValidationError instead.
const KNOWN_EVENT_TYPES = new Set([
  'sequenceNumber',
  'text',
  'copyrightNotice',
  'trackName',
  'instrumentName',
  'lyrics',
  'marker',
  'cuePoint',
  'channelPrefix',
  'portPrefix',
  'endOfTrack',
  'setTempo',
  'smpteOffset',
  'timeSignature',
  'keySignature',
  'sequencerSpecific',
  'unknownMeta',
  'sysEx',
  'endSysEx',
  'noteOff',
  'noteOn',
  'noteAftertouch',
  'controller',
  'programChange',
  'channelAftertouch',
  'pitchBend'
]);

// The subset serialised through the O(n²) writeBytes/writeString path.
const META_HEAVY_TYPES = new Set([
  'text',
  'copyrightNotice',
  'trackName',
  'instrumentName',
  'lyrics',
  'marker',
  'cuePoint',
  'sequencerSpecific',
  'unknownMeta',
  'sysEx',
  'endSysEx'
]);

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Validate one decoded event's ranges. The frontend clamps every value, but a
// LAN peer / older / malicious client bypasses it (HTTP auth is waived on the
// LAN), and `writeMidi` masks values with `& 0xFF` / `0x90 | channel` — so an
// out-of-nibble channel (e.g. 112 → status byte 0xF0) injects a sysEx marker
// mid-stream and corrupts the file, and out-of-range notes are stored wrong
// (audit D MEDIUM-5). Returns an error string, or null when the event is valid.
function validateWriteEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'event must be an object';
  if (!isInt(ev.deltaTime, 0, MIDI_VLQ_MAX)) {
    return `event deltaTime must be an integer in [0, ${MIDI_VLQ_MAX}]`;
  }
  if (typeof ev.type !== 'string' || !KNOWN_EVENT_TYPES.has(ev.type)) {
    return `unknown event type: ${ev.type}`;
  }
  switch (ev.type) {
    case 'noteOn':
    case 'noteOff':
      return isInt(ev.channel, 0, 15) && isInt(ev.noteNumber, 0, 127) && isInt(ev.velocity, 0, 127)
        ? null
        : `${ev.type} channel/noteNumber/velocity out of range`;
    case 'noteAftertouch':
      return isInt(ev.channel, 0, 15) && isInt(ev.noteNumber, 0, 127) && isInt(ev.amount, 0, 127)
        ? null
        : 'noteAftertouch channel/noteNumber/amount out of range';
    case 'controller':
      return isInt(ev.channel, 0, 15) && isInt(ev.controllerType, 0, 127) && isInt(ev.value, 0, 127)
        ? null
        : 'controller channel/controllerType/value out of range';
    case 'programChange':
      return isInt(ev.channel, 0, 15) && isInt(ev.programNumber, 0, 127)
        ? null
        : 'programChange channel/programNumber out of range';
    case 'channelAftertouch':
      return isInt(ev.channel, 0, 15) && isInt(ev.amount, 0, 127)
        ? null
        : 'channelAftertouch channel/amount out of range';
    case 'pitchBend':
      return isInt(ev.channel, 0, 15) && isInt(ev.value, -8192, 8191)
        ? null
        : 'pitchBend channel/value out of range';
    case 'setTempo':
      return Number.isFinite(ev.microsecondsPerBeat) &&
        ev.microsecondsPerBeat >= 1 &&
        ev.microsecondsPerBeat <= 0xffffff
        ? null
        : 'setTempo microsecondsPerBeat out of range';
    default:
      // Meta / sysEx structural types: deltaTime is bounded above and the count
      // is capped separately; their content is frame-size-bounded.
      return null;
  }
}

function validateFileIdField(data, errors) {
  if (!data.fileId) {
    errors.push('fileId is required');
  } else if (!Number.isFinite(Number(data.fileId)) || Number(data.fileId) <= 0) {
    errors.push('fileId must be a positive number');
  }
}

function validateMidiDataField(md, errors) {
  if (!md || typeof md !== 'object' || Array.isArray(md)) {
    errors.push('midiData must be an object');
    return;
  }
  if (!md.header || typeof md.header !== 'object') {
    errors.push('midiData.header must be an object');
  }
  if (!Array.isArray(md.tracks)) {
    errors.push('midiData.tracks must be an array');
    return;
  }
  if (md.tracks.length > MAX_WRITE_TRACKS) {
    errors.push(`midiData.tracks exceeds ${MAX_WRITE_TRACKS} tracks`);
    return;
  }
  // Validate EVERY event: total count, meta-heavy count, deltaTime range, known
  // type, and per-type value ranges — so nothing dangerous reaches writeMidi
  // (audit D). O(total events), itself bounded by the count cap. Bail on the
  // first offending event to keep the error message and the cost bounded.
  let total = 0;
  let metaCount = 0;
  for (const track of md.tracks) {
    if (!Array.isArray(track)) {
      errors.push('each midiData track must be an array of events');
      return;
    }
    for (const ev of track) {
      if (++total > MAX_WRITE_EVENTS) {
        errors.push(`midiData exceeds ${MAX_WRITE_EVENTS} events`);
        return;
      }
      if (ev && META_HEAVY_TYPES.has(ev.type) && ++metaCount > MAX_WRITE_META_EVENTS) {
        errors.push(`midiData exceeds ${MAX_WRITE_META_EVENTS} text/sysEx meta events`);
        return;
      }
      const evErr = validateWriteEvent(ev);
      if (evErr) {
        errors.push(`invalid midiData event: ${evErr}`);
        return;
      }
    }
  }
}

export const file_write = {
  custom: (data) => {
    const errors = [];
    validateFileIdField(data, errors);
    validateMidiDataField(data.midiData, errors);
    return errors;
  }
};

// `file_save_as` is the twin sink of `file_write`: it serialises `midiData`
// through `writeMidi` BEFORE any size check (FileManager.saveFileAs), so it
// needs the same track/event caps or a crafted payload OOMs the Pi. It also
// persists `newFilename` to the DB (reflected into the UI), so it must run the
// same filename sanitizer as `file_rename` (audit A2 Serial-cluster M1 — this
// command shipped with no schema at all).
export const file_save_as = {
  custom: (data) => {
    const errors = [];
    validateFileIdField(data, errors);
    const nameErr = validateFilename(data.newFilename);
    if (nameErr) errors.push(nameErr);
    validateMidiDataField(data.midiData, errors);
    return errors;
  }
};

// T2.2 — the shared folder structure is an opaque client-owned tree, so we only
// gate the top-level type; the contents stay permissive.
export const file_folders_set = {
  custom: (data) => {
    const errors = [];
    if (
      data.folders !== undefined &&
      (typeof data.folders !== 'object' || data.folders === null || Array.isArray(data.folders))
    ) {
      errors.push('folders must be an object');
    }
    return errors;
  }
};

// ── F-19 backfill: the reads and the filter ─────────────────────────
// Seven `file_*` commands turned `{fileId:{}}` into a masked "Internal server
// error" straight from the SQLite driver ("Too few parameter values were
// provided"), and `FileCommands` produced 34 of the campaign's 138 internal
// errors — the worst ratio after `DeviceCommands`
// (docs/audit/2026-09-07/01_API_CONTRACT.md §3.3). One identifier rule closes
// all of them.

const requireFileIdTyped = {
  custom: fieldRules([
    ['fileId', isIdLike, 'fileId must be a number or non-empty string', { required: true }]
  ])
};

export const file_read = requireFileIdTyped;
export const file_metadata = requireFileIdTyped;
export const file_channels = requireFileIdTyped;
export const file_tempo_map = requireFileIdTyped;
export const file_routing_status = requireFileIdTyped;
export const file_duplicate = requireFileIdTyped;
export const file_bake_cc = requireFileIdTyped;

export const file_text_events = {
  custom: fieldRules([
    ['fileId', isIdLike, 'fileId must be a number or non-empty string', { required: true }],
    ['eventType', (v) => isNonEmptyStr(v, 64), 'eventType must be a non-empty string']
  ])
};

// `file_list` defaults to '/' when `folder` is absent or empty, so an empty
// string stays legal; only the type and the length are gated.
export const file_list = {
  custom: fieldRules([
    [
      'folder',
      // eslint-disable-next-line no-control-regex -- control bytes are exactly what we reject
      (v) => isStr(v, 512) && !/[\x00-\x1f]/.test(v),
      'folder must be a string of at most 512 characters without control bytes'
    ]
  ])
};

export const file_search = {
  custom: fieldRules([
    [
      'query',
      (v) => isNonEmptyStr(v, 256),
      'query must be a non-empty string of at most 256 characters',
      { required: true }
    ]
  ])
};

// `file_filter` mirrors `FilterManager.getDefaultFilters()` field for field.
// Every entry is optional and `null` is the UI's "inactive" marker, which the
// compiler skips — so this schema only has to keep objects, arrays and
// oversized strings out of the query builder.
const MAX_FILTER_LIST = 512;
const filterList = isArrayMax(MAX_FILTER_LIST);
const filterText = (v) => isStr(v, 256);
const filterNum = (v) => isNumLike(v);

export const file_filter = {
  custom: fieldRules([
    ['filename', filterText, 'filename must be a string'],
    ['folder', filterText, 'folder must be a string'],
    ['includeSubfolders', isBoolLike, 'includeSubfolders must be a boolean'],
    ['durationMin', filterNum, 'durationMin must be a number'],
    ['durationMax', filterNum, 'durationMax must be a number'],
    ['tempoMin', filterNum, 'tempoMin must be a number'],
    ['tempoMax', filterNum, 'tempoMax must be a number'],
    ['tracksMin', filterNum, 'tracksMin must be a number'],
    ['tracksMax', filterNum, 'tracksMax must be a number'],
    ['uploadedAfter', filterText, 'uploadedAfter must be a date string'],
    ['uploadedBefore', filterText, 'uploadedBefore must be a date string'],
    ['instrumentTypes', filterList, 'instrumentTypes must be an array'],
    ['instrumentMode', filterText, 'instrumentMode must be a string'],
    ['channelCountMin', filterNum, 'channelCountMin must be a number'],
    ['channelCountMax', filterNum, 'channelCountMax must be a number'],
    ['hasRouting', isBoolLike, 'hasRouting must be a boolean'],
    ['isOriginal', isBoolLike, 'isOriginal must be a boolean'],
    ['minCompatibilityScore', filterNum, 'minCompatibilityScore must be a number'],
    ['gmInstruments', filterList, 'gmInstruments must be an array'],
    ['gmCategories', filterList, 'gmCategories must be an array'],
    ['gmPrograms', filterList, 'gmPrograms must be an array'],
    ['gmMode', filterText, 'gmMode must be a string'],
    ['routingStatus', filterText, 'routingStatus must be a string'],
    ['routingStatuses', filterList, 'routingStatuses must be an array'],
    ['playableOnInstruments', filterList, 'playableOnInstruments must be an array'],
    ['playableMode', filterText, 'playableMode must be a string'],
    ['hasDrums', isBoolLike, 'hasDrums must be a boolean'],
    ['hasMelody', isBoolLike, 'hasMelody must be a boolean'],
    ['hasBass', isBoolLike, 'hasBass must be a boolean'],
    ['hasLyrics', isBoolLike, 'hasLyrics must be a boolean'],
    ['sortBy', filterText, 'sortBy must be a string'],
    ['sortOrder', filterText, 'sortOrder must be a string'],
    ['limit', (v) => isIntLike(v, 0, 100000), 'limit must be an integer'],
    ['offset', (v) => isIntLike(v, 0, 10000000), 'offset must be an integer']
  ])
};

const schemas = {
  file_delete,
  file_export,
  file_rename,
  file_move,
  file_write,
  file_save_as,
  file_folders_set,
  file_read,
  file_metadata,
  file_channels,
  file_tempo_map,
  file_routing_status,
  file_duplicate,
  file_bake_cc,
  file_text_events,
  file_list,
  file_search,
  file_filter
};

export default schemas;
