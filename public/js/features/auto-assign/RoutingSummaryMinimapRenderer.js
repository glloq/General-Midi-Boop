// public/js/features/auto-assign/RoutingSummaryMinimapRenderer.js
// Canvas rendering for the minimap playhead view (P2-F.4f).
//
// Pure drawing given { canvas, width, height, buckets, splitMode,
// segments, channels, multiChannel, playheadPct, colors, bgColor }.
// No access to `this` state — suitable for unit testing via a mocked
// canvas context.

(function() {
  'use strict';

  const CHANNEL_COLORS = Object.freeze([
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
    '#f97316', '#6366f1', '#14b8a6', '#e11d48',
    '#a855f7', '#0ea5e9', '#22c55e', '#eab308'
  ]);

  function resolveBgColor(explicit) {
    if (explicit) return explicit;
    if (typeof document !== 'undefined' && document.documentElement) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim();
      if (v) return v;
    }
    return '#f0f0f0';
  }

  /**
   * @param {Object} params
   * @param {HTMLCanvasElement} params.canvas
   * @param {number} params.width
   * @param {number} params.height
   * @param {number} [params.dpr] - device pixel ratio ; defaults to window.devicePixelRatio || 1
   * @param {boolean} params.splitMode
   * @param {Array<number>|null} params.segments - split segment indices
   * @param {Array<number>|null} params.channels - active channel list (for multi-channel)
   * @param {boolean} params.multiChannel
   * @param {Array<boolean>|Map<number, Array<boolean>>} params.buckets
   * @param {number} [params.playheadPct]
   * @param {Array<string>} [params.splitColors]
   * @param {string} [params.bgColor]
   */
  function drawMinimapFrame(params) {
    const {
      canvas,
      width,
      height,
      dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      splitMode,
      segments,
      channels,
      multiChannel,
      buckets,
      playheadPct = 0,
      splitColors = [],
      bgColor
    } = params;

    if (!canvas || !canvas.parentNode) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = resolveBgColor(bgColor);
    ctx.fillRect(0, 0, width, height);

    if (!buckets) return;

    if (splitMode && segments) {
      const numSeg = segments.length;
      const gap = numSeg > 1 ? 1 : 0;
      const totalGap = gap * (numSeg - 1);
      const rowH = (height - totalGap) / numSeg;
      for (let si = 0; si < numSeg; si++) {
        const seg = segments[si];
        const rowBuckets = buckets.get ? buckets.get(seg) : null;
        if (!rowBuckets) continue;
        ctx.fillStyle = splitColors[seg % splitColors.length] || '#4285f4';
        const rowTop = si * (rowH + gap);
        for (let i = 0; i < width; i++) {
          if (rowBuckets[i]) ctx.fillRect(i, rowTop, 1, rowH);
        }
      }
    } else if (multiChannel && channels) {
      const numCh = channels.length;
      const rowH = height / numCh;
      for (let ci = 0; ci < numCh; ci++) {
        const ch = channels[ci];
        const rowBuckets = buckets.get ? buckets.get(ch) : null;
        if (!rowBuckets) continue;
        ctx.fillStyle = CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
        const rowTop = ci * rowH;
        for (let i = 0; i < width; i++) {
          if (rowBuckets[i]) ctx.fillRect(i, rowTop, 1, rowH);
        }
      }
    } else {
      ctx.fillStyle = '#4285f4';
      for (let i = 0; i < width; i++) {
        if (buckets[i]) ctx.fillRect(i, 0, 1, height);
      }
    }

    if (playheadPct > 0 && playheadPct <= 1) {
      const x = Math.floor(playheadPct * width);
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(x, 0, 2, height);
    }
  }

  window.RoutingSummaryMinimapRenderer = Object.freeze({
    drawMinimapFrame,
    CHANNEL_COLORS
  });
})();
