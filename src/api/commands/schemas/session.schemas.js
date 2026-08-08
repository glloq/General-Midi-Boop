/**
 * @file src/api/commands/schemas/session.schemas.js
 * @description Validation schemas for `session_*` WebSocket commands.
 *
 * These commands previously reached their handlers with no payload
 * validation: a `SESSION_SCHEMA`/`validateSession` pair existed in
 * `JsonValidator` but was never wired into the dispatch path, so
 * `session_import` persisted an arbitrary, unbounded `data` blob to the DB
 * and `session_save` an arbitrary name (audit A2 M2). Registering these in
 * the compiled-schema map closes that gap.
 */

const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;
// A session snapshot (device list + routing table + player status) is small;
// cap the imported blob so a crafted `session_import` cannot persist an
// unbounded string straight into the DB.
const MAX_IMPORT_DATA = 1024 * 1024; // 1 MB

function requireSessionId(data, errors) {
  if (data.sessionId === undefined || data.sessionId === null || data.sessionId === '') {
    errors.push('sessionId is required');
  }
}

function validateName(value, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push('name is required');
  } else if (value.length > MAX_NAME) {
    errors.push(`name is too long (max ${MAX_NAME} chars)`);
  }
}

function validateDescription(value, errors) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    errors.push('description must be a string');
  } else if (value.length > MAX_DESCRIPTION) {
    errors.push(`description is too long (max ${MAX_DESCRIPTION} chars)`);
  }
}

export const session_save = {
  custom: (data) => {
    const errors = [];
    validateName(data.name, errors);
    validateDescription(data.description, errors);
    return errors;
  }
};

export const session_load = {
  custom: (data) => {
    const errors = [];
    requireSessionId(data, errors);
    if (data.dryRun !== undefined && typeof data.dryRun !== 'boolean') {
      errors.push('dryRun must be a boolean');
    }
    return errors;
  }
};

export const session_delete = {
  custom: (data) => {
    const errors = [];
    requireSessionId(data, errors);
    return errors;
  }
};

export const session_export = {
  custom: (data) => {
    const errors = [];
    requireSessionId(data, errors);
    return errors;
  }
};

export const session_import = {
  custom: (data) => {
    const errors = [];
    validateName(data.name, errors);
    validateDescription(data.description, errors);
    if (typeof data.data !== 'string') {
      errors.push('data must be a JSON string');
    } else if (data.data.length > MAX_IMPORT_DATA) {
      errors.push(`data exceeds ${MAX_IMPORT_DATA} bytes`);
    }
    return errors;
  }
};

const schemas = {
  session_save,
  session_load,
  session_delete,
  session_export,
  session_import
};

export default schemas;
