// src/utils/ValidationUtils.js
// Shared validation utilities for command handlers.

import { ValidationError, ConfigurationError } from '../core/errors/index.js';

/**
 * Require a field to be present (truthy) in data.
 * Uses the same falsy check (!value) as the original inline patterns.
 * @param {object} data - Data object
 * @param {string} fieldName - Field name to check
 * @param {string} [message] - Custom error message
 * @returns {*} The field value
 * @throws {ValidationError} if field is falsy
 */
export function requireField(data, fieldName, message) {
  if (!data[fieldName]) {
    throw new ValidationError(message || `${fieldName} is required`, fieldName);
  }
  return data[fieldName];
}

/**
 * Require multiple fields to be present (truthy) in data.
 * @param {object} data - Data object
 * @param {string[]} fieldNames - Field names to check
 * @throws {ValidationError} if any field is falsy
 */
export function requireFields(data, fieldNames) {
  for (const fieldName of fieldNames) {
    requireField(data, fieldName);
  }
}

/**
 * Validate that a value (if defined) is within the MIDI 0-127 range.
 * @param {number|undefined} value - Value to check
 * @param {string} name - Field name for error message
 * @throws {ValidationError} if value is out of range
 */
export function validateMidiRange(value, name) {
  if (value !== undefined && (value < 0 || value > 127)) {
    throw new ValidationError(`${name} must be 0-127`, name);
  }
}

/**
 * Require a manager to be available (non-null/undefined).
 * @param {*} manager - Manager instance
 * @param {string} name - Manager name for error message
 * @returns {*} The manager instance
 * @throws {ConfigurationError} if manager is falsy
 */
export function requireManager(manager, name) {
  if (!manager) {
    throw new ConfigurationError(`${name} not available`);
  }
  return manager;
}
