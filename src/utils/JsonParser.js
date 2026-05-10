/**
 * @file src/utils/JsonParser.js
 * @description Tiny JSON helpers that centralise the
 *   "is it already an object? a string? a null?" branching that was
 * repeated across the API command handlers and the persistence layer.
 */

/**
 * Parse `value` as JSON, returning `fallback` on null/undefined/parse
 * errors. Already-parsed values (non-string, non-null) are returned
 * as-is so callers can pass through values that may or may not have
 * been deserialised by SQLite/`JSON.parse`.
 *
 * @template T
 * @param {*} value - String to parse, or any already-parsed value.
 * @param {T} [fallback=null] - Value returned when parsing fails.
 * @returns {*|T}
 */
export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
