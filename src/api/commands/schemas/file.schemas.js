/**
 * @file src/api/commands/schemas/file.schemas.js
 * @description Declarative validation schemas for `file_*` WebSocket
 * commands. Consumed by `JsonValidator.validateFileCommand`.
 *
 * Note: `file_upload` is no longer a WebSocket command — uploads go through
 * `POST /api/files` (HTTP multipart-style raw body). See `apiRoutes.js`.
 */

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

// Bound the parsed-MIDI payload so a malformed or oversized `file_write`
// (the body is serialised straight to bytes and stored) is rejected at the
// edge instead of reaching `writeMidi`/BlobStore unchecked (audit P2 —
// file_write was unvalidated). Caps are generous but finite.
const MAX_WRITE_TRACKS = 256;
const MAX_WRITE_EVENTS = 500000;

export const file_write = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) {
      errors.push('fileId is required');
    } else if (!Number.isFinite(Number(data.fileId)) || Number(data.fileId) <= 0) {
      errors.push('fileId must be a positive number');
    }

    const md = data.midiData;
    if (!md || typeof md !== 'object' || Array.isArray(md)) {
      errors.push('midiData must be an object');
      return errors;
    }
    if (!md.header || typeof md.header !== 'object') {
      errors.push('midiData.header must be an object');
    }
    if (!Array.isArray(md.tracks)) {
      errors.push('midiData.tracks must be an array');
    } else if (md.tracks.length > MAX_WRITE_TRACKS) {
      errors.push(`midiData.tracks exceeds ${MAX_WRITE_TRACKS} tracks`);
    } else {
      let total = 0;
      for (const track of md.tracks) {
        if (!Array.isArray(track)) {
          errors.push('each midiData track must be an array of events');
          break;
        }
        total += track.length;
        if (total > MAX_WRITE_EVENTS) {
          errors.push(`midiData exceeds ${MAX_WRITE_EVENTS} events`);
          break;
        }
      }
    }
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

const schemas = {
  file_delete,
  file_export,
  file_rename,
  file_move,
  file_write,
  file_folders_set
};

export default schemas;
