/**
 * @file src/utils/ColorUtils.js
 * @description Color-space conversion helpers shared by the lighting
 * drivers, the effects engine and the lighting commands. Pure functions
 * with no I/O — safe to import from anywhere.
 */

/**
 * Parse a hex color string to RGB components.
 *
 * @param {string} hex - Color string, e.g. `"#FF00AA"` or `"FF00AA"`.
 * @returns {{ r: number, g: number, b: number }} RGB object (0-255 each).
 *   Returns white when the input does not match the 6-hex-digit pattern,
 *   chosen as a safe default so devices stay visible during config errors.
 */
export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
}

/**
 * Convert HSV color to RGB. Implements the standard piecewise formula —
 * see https://en.wikipedia.org/wiki/HSL_and_HSV.
 *
 * @param {number} h - Hue in degrees (0-360, wrapped via modulo).
 * @param {number} s - Saturation (0-1).
 * @param {number} v - Value/brightness (0-1).
 * @returns {{ r: number, g: number, b: number }} RGB object (0-255 each).
 */
export function hsvToRgb(h, s, v) {
  h = h % 360;
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r, g, b;

  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}
