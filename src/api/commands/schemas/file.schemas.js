/**
 * @file src/api/commands/schemas/file.schemas.js
 * @description Declarative validation schemas for `file_*` WebSocket
 * commands (P1-3.2c, ADR-004). Consumed by
 * `JsonValidator.validateFileCommand`.
 */

/**
 * Local copy of the base64 well-formedness check, intentionally
 * duplicated from `JsonValidator.isValidBase64` to avoid a circular
 * import — JsonValidator loads this schema map at module init time.
 *
 * @param {*} str
 * @returns {boolean}
 */
function isValidBase64(str) {
  if (typeof str !== 'string') return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return false;
  if (str.length % 4 !== 0) return false;
  return true;
}

const requireFileId = {
  custom: (data) => (!data.fileId ? 'fileId is required' : null)
};

export const file_delete = requireFileId;
export const file_export = requireFileId;

export const file_upload = {
  custom: (data) => {
    const errors = [];
    if (!data.filename) errors.push('filename is required');
    if (!data.data) errors.push('data is required');
    if (data.data && !isValidBase64(data.data)) {
      errors.push('data must be valid base64 string');
    }
    return errors;
  }
};

export const file_rename = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    if (!data.newFilename) errors.push('newFilename is required');
    return errors;
  }
};

export const file_move = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    if (!data.folder) errors.push('folder is required');
    return errors;
  }
};

const schemas = {
  file_upload,
  file_delete,
  file_export,
  file_rename,
  file_move
};

export default schemas;
