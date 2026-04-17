// public/js/views/components/auto-assign/RoutingSummaryRenderers.js
// Pure HTML renderers extracted from RoutingSummaryPage.js (P2-F.4 — step 4
// of plan §11 protocol : extract UI rendering as sub-components).
// These are standalone helpers with no DOM side-effects, easily unit-tested.

(function() {
  'use strict';

  const RSC = window.RoutingSummaryConstants;
  const { BLACK_KEYS, safeNoteRange, midiNoteToName } = RSC;

  const _t = (key, params) => (typeof i18n !== 'undefined' ? i18n.t(key, params) : key);

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

  /**
   * Mini note range visualisation bar for the summary table.
   * @param {Object|null} analysis - channel analysis ({ noteRange: { min, max } })
   * @param {Object|null} [assignment] - optional instrument assignment
   *   ({ noteRangeMin, noteRangeMax }) — shown as an overlaid instrument range.
   */
  function renderMiniRange(analysis, assignment) {
    if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';

    const chMin = analysis.noteRange.min;
    const chMax = analysis.noteRange.max;
    const left = Math.round((chMin / 127) * 100);
    const width = Math.max(2, Math.round(((chMax - chMin) / 127) * 100));

    let instBar = '';
    if (assignment && assignment.noteRangeMin != null) {
      const iLeft = Math.round((assignment.noteRangeMin / 127) * 100);
      const iWidth = Math.max(2, Math.round(((assignment.noteRangeMax - assignment.noteRangeMin) / 127) * 100));
      instBar = `<div class="rs-range-inst" style="left: ${iLeft}%; width: ${iWidth}%" title="${_t('autoAssign.instrumentRange')}: ${midiNoteToName(assignment.noteRangeMin)}-${midiNoteToName(assignment.noteRangeMax)}"></div>`;
    }

    return `
      <div class="rs-mini-range" title="${midiNoteToName(chMin)}-${midiNoteToName(chMax)}">
        ${instBar}
        <div class="rs-range-channel" style="left: ${left}%; width: ${width}%"></div>
      </div>
    `;
  }

  /** Placeholder shown in the right-side detail panel when no channel is selected. */
  function renderDetailPlaceholder() {
    return `
      <div class="rs-detail-placeholder">
        <p>${_t('routingSummary.selectChannelHint')}</p>
      </div>
    `;
  }

  /**
   * Preview header button bar with Play-all / Play-channel / Play-original /
   * Pause / Stop buttons and the filename tag.
   * @param {object} opts
   * @param {number|null} opts.selectedChannel  - currently selected channel (null → disabled)
   * @param {string}      opts.filename         - full filename (truncated to 30 chars for display)
   * @param {(s:string) => string} [opts.escape] - HTML-escape helper ; defaults to identity
   */
  function renderHeaderButtons(opts) {
    const ch = opts.selectedChannel;
    const chLabel = ch !== null && ch !== undefined ? (ch + 1) : '?';
    const fnDisplay = opts.filename || '';
    const fnShort = fnDisplay.length > 30 ? fnDisplay.slice(0, 27) + '\u2026' : fnDisplay;
    const escape = opts.escape || ((s) => s);
    return `
      <div class="rs-hdr-prev-btns">
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewAllBtn" title="${_t('routingSummary.previewAll')}">
          <span class="rs-prev-icon">&#9654;</span> ${_t('routingSummary.previewAll') || 'Tout'}
        </button>
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewChBtn" title="${_t('routingSummary.previewChannel')} ${chLabel}" ${ch === null || ch === undefined ? 'disabled' : ''}>
          <span class="rs-prev-icon">&#9654;</span> ${_t('routingSummary.previewChannel') || 'Channel'} ${chLabel}
        </button>
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewOrigBtn" title="${_t('routingSummary.previewOriginal')}">
          <span class="rs-prev-icon">&#9835;</span> ${_t('routingSummary.previewOriginal') || 'Original'}
        </button>
        <button class="btn btn-sm rs-prev-btn" id="rsPreviewPauseBtn" style="display:none">&#10074;&#10074;</button>
        <button class="btn btn-sm rs-prev-btn" id="rsPreviewStopBtn" style="display:none">&#9632;</button>
        <span class="rs-preview-time" id="rsPreviewTime"></span>
        <span class="rs-header-filename" title="${escape(fnDisplay)}">${escape(fnShort)}</span>
      </div>
    `;
  }

  window.RoutingSummaryRenderers = Object.freeze({
    renderMiniKeyboard,
    renderChannelHistogram,
    renderMiniRange,
    renderDetailPlaceholder,
    renderHeaderButtons
  });
})();
