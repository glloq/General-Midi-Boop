/**
 * @file src/utils/MidiListParser.js
 * @description Normalise lists of MIDI numbers (CC indices, note
 * numbers) that arrive either as an Array, a CSV string, or a JSON
 * string. Centralises the parse/validate/serialise logic that was
 * duplicated across the persistence and API layers.
 *
 * Validation rule: every entry must be a finite integer in `[0, 127]`.
 * Out-of-range entries are silently dropped — callers that need a
 * strict error path should validate *before* calling these helpers.
 */

import { safeJsonParse } from './JsonParser.js';

/**
 * Coerce `value` to a `number[]` of valid MIDI bytes (0-127).
 * Accepts:
 *   - `null` / `undefined` → `null`
 *   - `Array` → filtered copy
 *   - JSON-string array → parsed then filtered
 *   - CSV string (e.g. `"0,32,64"`) → split then filtered
 * Returns `null` (not `[]`) when no valid entry remains, so callers
 * can treat the column as "unset" in the persistence layer.
 *
 * @param {*} value
 * @returns {number[]|null}
 */
export function parseValidMidiList(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const clean = value
      .map((n) => (typeof n === 'string' ? parseInt(n, 10) : n))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return clean.length === 0 ? null : clean;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // JSON array first — `"[0,32]"` is a common storage form.
    if (trimmed.startsWith('[')) {
      const parsed = safeJsonParse(trimmed);
      if (Array.isArray(parsed)) return parseValidMidiList(parsed);
    }
    const parts = trimmed
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return parts.length === 0 ? null : parts;
  }
  return null;
}

/**
 * Serialise `value` to a JSON-string array of valid MIDI bytes, or
 * `null` when nothing valid remains. Convenience wrapper used by the
 * persistence layer where columns are stored as JSON text.
 *
 * @param {*} value
 * @returns {string|null}
 */
export function serializeValidMidiList(value) {
  const list = parseValidMidiList(value);
  return list ? JSON.stringify(list) : null;
}
