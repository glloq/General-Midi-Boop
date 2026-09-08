/**
 * @file src/core/errors/index.js
 * @description Domain Error subclasses with a stable string `code`,
 * HTTP-style `statusCode`, and `toJSON()`. Anything reaching the WS/HTTP
 * boundary should be (or extend) {@link ApplicationError} so the client
 * receives the canonical `{ error, code, message }` shape.
 */

/**
 * Base error: adds `code` + `statusCode` and a JSON-safe `toJSON()`.
 * @example throw new ApplicationError('Boom', 'ERR_BOOM', 500);
 */
export class ApplicationError extends Error {
  /**
   * @param {string} message - Human-readable error message.
   * @param {string} [code='ERR_APPLICATION'] - Machine-readable error code.
   * @param {number} [statusCode=500] - HTTP status code to surface.
   */
  constructor(message, code = 'ERR_APPLICATION', statusCode = 500) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.statusCode = statusCode;
  }

  /**
   * @returns {{error:string,code:string,message:string}} JSON-safe payload
   *   used by the API layer to serialise the error to the client.
   */
  toJSON() {
    return {
      error: this.name,
      code: this.code,
      message: this.message
    };
  }
}

/**
 * Thrown when caller-supplied input fails schema or business validation.
 * Maps to HTTP 400.
 */
export class ValidationError extends ApplicationError {
  /**
   * @param {string} message - Human-readable validation message.
   * @param {?string} [field=null] - Offending field name, if known.
   */
  constructor(message, field = null) {
    super(message, 'ERR_VALIDATION', 400);
    this.name = 'ValidationError';
    this.field = field;
  }

  /** @returns {Object} Base JSON plus `field`. */
  toJSON() {
    return {
      ...super.toJSON(),
      field: this.field
    };
  }
}

/**
 * Thrown when a requested resource does not exist. Maps to HTTP 404.
 */
export class NotFoundError extends ApplicationError {
  /**
   * @param {string} resource - Resource type (e.g. `"file"`, `"device"`).
   * @param {?(string|number)} [id=null] - Optional identifier of the
   *   missing resource — embedded in the message when provided.
   */
  constructor(resource, id = null) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 'ERR_NOT_FOUND', 404);
    this.name = 'NotFoundError';
    this.resource = resource;
  }

  /** @returns {Object} Base JSON plus `resource`. */
  toJSON() {
    return {
      ...super.toJSON(),
      resource: this.resource
    };
  }
}

/**
 * Thrown by the API authentication middleware when the bearer token is
 * missing or invalid. Maps to HTTP 401.
 */
export class AuthenticationError extends ApplicationError {
  /**
   * @param {string} [message='Authentication required']
   */
  constructor(message = 'Authentication required') {
    super(message, 'ERR_UNAUTHORIZED', 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Thrown when the backend cannot start or operate because of a malformed
 * or missing configuration value. Maps to HTTP 500 (operator-actionable).
 */
export class ConfigurationError extends ApplicationError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'ERR_CONFIGURATION', 500);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown for MIDI hardware/protocol failures (port open, write failure,
 * device timeout). Carries the offending device identifier when available.
 */
export class MidiError extends ApplicationError {
  /**
   * @param {string} message
   * @param {?string} [device=null] - Device id involved in the failure.
   */
  constructor(message, device = null) {
    super(message, 'ERR_MIDI', 500);
    this.name = 'MidiError';
    this.device = device;
  }

  /** @returns {Object} Base JSON plus `device`. */
  toJSON() {
    return {
      ...super.toJSON(),
      device: this.device
    };
  }
}

/**
 * Thrown when a SQLite/`better-sqlite3` operation fails (constraint
 * violation, locked db, schema mismatch). `operation` identifies the
 * call site for log triage.
 */
export class DatabaseError extends ApplicationError {
  /**
   * @param {string} message
   * @param {?string} [operation=null] - Symbolic operation name (e.g.
   *   `"insertFile"`, `"migrate:v3"`).
   */
  constructor(message, operation = null) {
    super(message, 'ERR_DATABASE', 500);
    this.name = 'DatabaseError';
    this.operation = operation;
  }

  /** @returns {Object} Base JSON plus `operation`. */
  toJSON() {
    return {
      ...super.toJSON(),
      operation: this.operation
    };
  }
}

/**
 * Thrown when SQLite refuses a write because another **process** holds the
 * lock and every retry attempt failed. Maps to HTTP 503 (retry later) rather
 * than 500: nothing was written, the request is safe to replay.
 *
 * Exists so a contended write surfaces to the client as a named, actionable
 * error instead of the masked "Internal server error" the audit observed
 * (F-130). See {@link module:src/persistence/busyRetry}.
 */
export class DatabaseBusyError extends ApplicationError {
  /**
   * @param {string} message
   * @param {?string} [operation=null] - Symbolic operation name.
   * @param {{cause?:Error}} [options]
   */
  constructor(message, operation = null, options = {}) {
    super(message, 'ERR_DATABASE_BUSY', 503);
    this.name = 'DatabaseBusyError';
    this.operation = operation;
    if (options.cause) this.cause = options.cause;
  }

  /** @returns {Object} Base JSON plus `operation`. */
  toJSON() {
    return {
      ...super.toJSON(),
      operation: this.operation
    };
  }
}

/**
 * Thrown when a write would silently clobber a concurrent one — optimistic
 * concurrency control failed because the resource changed between the moment
 * the caller read it and the moment it tried to write.
 *
 * Maps to HTTP 409. `expected` / `actual` carry the version tokens
 * (`content_hash`, routing fingerprint…) so the client can tell the operator
 * *what* moved and reload before retrying (F-76 / F-77).
 */
export class ConflictError extends ApplicationError {
  /**
   * @param {string} message
   * @param {{resource?:string, expected?:*, actual?:*}} [details]
   */
  constructor(message, details = {}) {
    super(message, 'ERR_CONFLICT', 409);
    this.name = 'ConflictError';
    this.resource = details.resource ?? null;
    this.expected = details.expected ?? null;
    this.actual = details.actual ?? null;
  }

  /** @returns {Object} Base JSON plus the version tokens. */
  toJSON() {
    return {
      ...super.toJSON(),
      resource: this.resource,
      expected: this.expected,
      actual: this.actual
    };
  }
}
