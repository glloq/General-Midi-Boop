// src/utils/ColorUtils.js
// Shared color conversion utilities used by lighting drivers, effects engine, and commands.

/**
 * Parse a hex color string to RGB components.
 * @param {string} hex - Color string, e.g. "#FF00AA" or "FF00AA"
 * @returns {{ r: number, g: number, b: number }} RGB object (0-255 each), defaults to white if invalid
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
 * Convert HSV color to RGB.
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-1)
 * @param {number} v - Value/brightness (0-1)
 * @returns {{ r: number, g: number, b: number }} RGB object (0-255 each)
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
