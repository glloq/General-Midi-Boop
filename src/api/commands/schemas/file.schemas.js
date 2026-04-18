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
  file_delete,
  file_export,
  file_rename,
  file_move
};

export default schemas;
