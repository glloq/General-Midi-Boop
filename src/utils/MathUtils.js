/**
 * @file src/utils/MathUtils.js
 * @description Numeric helpers used across the backend. Centralises
 * the `Math.max(min, Math.min(max, value))` pattern that was repeated
 * a dozen times in lighting drivers and elsewhere.
 */

/**
 * Clamp `value` to the inclusive `[min, max]` range. Defaults to the
 * DMX/8-bit colour range (0-255) so the typical lighting call reads
 * as `clamp(value)`.
 *
 * @param {number} value - Value to clamp
 * @param {number} [min=0] - Lower bound (inclusive)
 * @param {number} [max=255] - Upper bound (inclusive)
 * @returns {number}
 */
export function clamp(value, min = 0, max = 255) {
  // Non-finite input (NaN / undefined / a non-numeric) would otherwise pass
  // BOTH comparisons and be returned verbatim, poisoning every downstream
  // computation (e.g. a bad master-dimmer value turned all brightness into NaN
  // — audit B1). Treat it as the lower bound, a safe floor for the DMX/8-bit
  // ranges this helper serves.
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
