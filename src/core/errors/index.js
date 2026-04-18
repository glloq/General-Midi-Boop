/**
 * @file src/core/errors/index.js
 * @description Domain-specific Error subclasses thrown across the backend.
 * Each carries a stable string `code` and HTTP-style `statusCode` so the
 * API layer can translate them into structured JSON responses without
 * sniffing `instanceof` everywhere.
 *
 * Convention: any error reaching the WebSocket / HTTP boundary should be
 * (or extend) {@link ApplicationError} so `toJSON()` produces the canonical
 * `{ error, code, message }` shape consumed by the frontend.
 */

/**
 * Base error class for the application. Adds a stable string `code` and an
 * HTTP-style `statusCode` to a regular `Error`, plus a `toJSON()` method so
 * it serialises predictably when sent over HTTP/WS.
 *
 * @example
 *   throw new ApplicationError('Boom', 'ERR_BOOM', 500);
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
