// src/core/errors/index.js

/**
 * Base application error with error code support.
 */
export class ApplicationError extends Error {
  constructor(message, code = 'ERR_APPLICATION', statusCode = 500) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      error: this.name,
      code: this.code,
      message: this.message
    };
  }
}

/**
 * Validation error for invalid input data.
 */
export class ValidationError extends ApplicationError {
  constructor(message, field = null) {
    super(message, 'ERR_VALIDATION', 400);
    this.name = 'ValidationError';
    this.field = field;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      field: this.field
    };
  }
}

/**
 * Resource not found error.
 */
export class NotFoundError extends ApplicationError {
  constructor(resource, id = null) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 'ERR_NOT_FOUND', 404);
    this.name = 'NotFoundError';
    this.resource = resource;
  }
}

/**
 * Authentication/authorization error.
 */
export class AuthenticationError extends ApplicationError {
  constructor(message = 'Authentication required') {
    super(message, 'ERR_UNAUTHORIZED', 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Configuration error.
 */
export class ConfigurationError extends ApplicationError {
  constructor(message) {
    super(message, 'ERR_CONFIGURATION', 500);
    this.name = 'ConfigurationError';
  }
}

/**
 * MIDI-specific error.
 */
export class MidiError extends ApplicationError {
  constructor(message, device = null) {
    super(message, 'ERR_MIDI', 500);
    this.name = 'MidiError';
    this.device = device;
  }
}

/**
 * Database operation error.
 */
export class DatabaseError extends ApplicationError {
  constructor(message, operation = null) {
    super(message, 'ERR_DATABASE', 500);
    this.name = 'DatabaseError';
    this.operation = operation;
  }
}
