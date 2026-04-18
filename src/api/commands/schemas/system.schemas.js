/**
 * @file src/api/commands/schemas/system.schemas.js
 * @description Declarative validation schemas for `system_*` WebSocket
 * commands. Consumed by `JsonValidator.validateByCommand`.
 */

/**
 * `system_backup`: optional `path` must be a string when present.
 * Preserves the historical error message exactly.
 */
export const system_backup = {
  custom: (data) => {
    if (data.path && typeof data.path !== 'string') {
      return 'path must be a string';
    }
    return null;
  }
};

const schemas = {
  system_backup
};

export default schemas;
