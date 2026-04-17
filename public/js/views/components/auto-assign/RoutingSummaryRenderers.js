// public/js/views/components/auto-assign/RoutingSummaryRenderers.js
// Pure HTML renderers extracted from RoutingSummaryPage.js (P2-F.4 — step 4
// of plan §11 protocol : extract UI rendering as sub-components).
// These are standalone helpers with no DOM side-effects, easily unit-tested.

(function() {
  'use strict';

  const RSC = window.RoutingSummaryConstants;
  const { BLACK_KEYS, safeNoteRange, midiNoteToName } = RSC;

  /**
   * Render a mini piano keyboard aligned to the channel's note range.
   * White keys are full-height, black keys are shorter and overlaid.
   * C notes get a small label below.
   */
  function renderMiniKeyboard(chMin, chMax) {
    if (chMin > chMax || !isFinite(chMin) || !isFinite(chMax)) return '';
    const noteCount = chMax - chMin + 1;
    if (noteCount <= 0) return '';
    const keyW = 100 / noteCount;
    let keysHTML = '';

    for (let n = chMin; n <= chMax; n++) {
      const semitone = n % 12;
      const isBlack = BLACK_KEYS.has(semitone);
      const leftPct = ((n - chMin) / noteCount) * 100;
      const cls = isBlack ? 'rs-kb-key rs-kb-black' : 'rs-kb-key rs-kb-white';
      keysHTML += `<div class="${cls}" style="left:${leftPct.toFixed(2)}%;width:${keyW.toFixed(2)}%"></div>`;

      if (semitone === 0) {
        const octave = Math.floor(n / 12);
        keysHTML += `<span class="rs-kb-label" style="left:${leftPct.toFixed(2)}%">C${octave}</span>`;
      }
    }

    return `<div class="rs-kb-keyboard">${keysHTML}</div>`;
  }

  /**
   * Render the channel note distribution histogram bar.
   * @param {Object} channelAnalysis
   * @param {number} transposition - semitones to shift display (default 0)
   */
  function renderChannelHistogram(channelAnalysis, transposition = 0) {
    if (!channelAnalysis?.noteRange || channelAnalysis.noteRange.min == null) return '';
    const r = safeNoteRange(channelAnalysis.noteRange.min + transposition, channelAnalysis.noteRange.max + transposition);
    const chMin = r.min;
    const chMax = r.max;
    const noteCount = chMax - chMin + 1;
    if (noteCount <= 0) return '';
    const dist = channelAnalysis.noteDistribution;
    let histoBarsHTML = '';
    if (dist && typeof dist === 'object') {
      const entries = Object.entries(dist);
      if (entries.length > 0) {
        const maxCount = Math.max(...entries.map(([, c]) => c));
        histoBarsHTML = entries.map(([note, count]) => {
          const n = parseInt(note) + transposition;
          if (n < chMin || n > chMax) return '';
          const leftPct = ((n - chMin) / noteCount) * 100;
          const barW = Math.max(0.8, 100 / noteCount);
          const heightPct = Math.max(8, (count / maxCount) * 100);
          return `<div class="rs-split-viz-histo-bar" style="left:${leftPct.toFixed(1)}%;width:${barW.toFixed(1)}%;height:${heightPct.toFixed(0)}%"></div>`;
        }).join('');
      }
    }
    return `<div class="rs-split-viz-ch-track" title="${midiNoteToName(chMin)}\u2013${midiNoteToName(chMax)}">${histoBarsHTML}</div>`;
  }

  window.RoutingSummaryRenderers = Object.freeze({
    renderMiniKeyboard,
    renderChannelHistogram
  });
})();
