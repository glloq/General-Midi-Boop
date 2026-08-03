/**
 * @file MinimapUtils.js
 * Shared utilities for canvas minimap widgets.
 *
 * Exposed as window.MinimapUtils (browser) or module.exports (Node/tests).
 */
(function () {
  'use strict';

  const _BAND_FILL_CACHE = new Map();

  /**
   * Convert a #rrggbb hex colour to an rgba() string at the given alpha,
   * with memoisation so hot draw paths don't re-parse the hex every frame.
   * Falls back to a neutral grey when the input is not a valid 7-char hex.
   *
   * @param {string} hex          '#rrggbb'
   * @param {number} [alpha=0.18]
   * @returns {string}            'rgba(r, g, b, alpha)'
   */
  function bandFillRgba(hex, alpha = 0.18) {
    const key = `${hex}|${alpha}`;
    let v = _BAND_FILL_CACHE.get(key);
    if (v) return v;
    if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') {
      v = `rgba(107,114,128,${alpha})`;
    } else {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      v = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    _BAND_FILL_CACHE.set(key, v);
    return v;
  }

  if (typeof window !== 'undefined') {
    window.MinimapUtils = Object.freeze({ bandFillRgba });
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bandFillRgba };
  }
})();
