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

  /**
   * Loading state for the Routing Summary modal (spinner + "analyzing" text).
   * Caller remains responsible for binding the close button to its handler.
   */
  function renderLoadingScreen() {
    return `
      <div class="rs-container">
        <div class="rs-header">
          <h2>${_t('routingSummary.title')}</h2>
          <button class="modal-close" id="rsSummaryClose">&times;</button>
        </div>
        <div class="rs-body rs-loading">
          <div class="spinner"></div>
          <p>${_t('autoAssign.analyzing')}</p>
        </div>
      </div>
    `;
  }

  /**
   * Error state for the Routing Summary modal.
   * @param {string} message - human-readable error (escaped by caller or renderer).
   * @param {(s:string) => string} [escape] - HTML-escape helper ; defaults to identity.
   */
  function renderErrorScreen(message, escape) {
    const esc = escape || ((s) => s);
    return `
      <div class="rs-container">
        <div class="rs-header">
          <h2>${_t('autoAssign.error')}</h2>
          <button class="modal-close" id="rsSummaryClose">&times;</button>
        </div>
        <div class="rs-body rs-error">
          <p>${esc(message)}</p>
          <button class="btn" id="rsSummaryCloseBtn">${_t('common.close')}</button>
        </div>
      </div>
    `;
  }

  /**
   * Render the horizontal scrollable list of instrument chips for a channel.
   * Returns empty string for split channels (handled elsewhere).
   *
   * @param {Object} opts
   * @param {number} opts.channel
   * @param {Array<Object>} opts.options      - high-score suggestions
   * @param {Array<Object>} opts.lowOptions   - low-score suggestions (hidden behind toggle)
   * @param {Object|null} opts.assignment     - currently assigned instrument (or null)
   * @param {boolean} [opts.isSkipped]
   * @param {boolean} [opts.isSplit]
   * @param {boolean} [opts.showLow]          - whether to display low-score chips
   * @param {(inst:Object) => string} opts.getDisplayName
   * @param {(html:string) => string} opts.escape
   */
  function renderInstrumentChips(opts) {
    const {
      channel,
      options = [],
      lowOptions = [],
      assignment,
      isSkipped = false,
      isSplit = false,
      showLow = false,
      getDisplayName,
      escape
    } = opts;
    const {
      MAX_INST_NAME,
      getTypeColor,
      getScoreClass
    } = window.RoutingSummaryConstants;

    // For split channels, the dedicated split section handles segment display.
    if (isSplit) return '';

    const ch = String(channel);

    const chipHTML = (opt, extraClass = '') => {
      const inst = opt.instrument;
      const score = opt.compatibility?.score ?? 0;
      const isSelected = assignment?.instrumentId === inst.id;
      const typeColor = getTypeColor(inst.instrument_type || '');
      const name = getDisplayName ? getDisplayName(inst) : (inst.custom_name || inst.name || '?');
      const displayName = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;
      return `
        <button class="aa-instbar-btn ${extraClass} ${isSelected ? 'assigned' : ''}" style="border-left: 3px solid ${typeColor}"
                data-instrument-id="${inst.id}" data-channel="${ch}"
                title="${escape(name)} \u2014 ${score}/100">
          <span class="aa-instbar-dot" style="background:${typeColor}"></span>
          <span class="aa-instbar-name">${escape(displayName)}</span>
          <span class="aa-instbar-score ${getScoreClass(score)}">${score}</span>
          ${isSelected ? '<span class="aa-instbar-check">\u2713</span>' : ''}
        </button>
      `;
    };

    const chips = options.map((opt) => chipHTML(opt)).join('');

    const showLowChips = showLow || options.length === 0;
    const lowChips = (showLowChips && lowOptions.length > 0)
      ? lowOptions.map((opt) => chipHTML(opt, 'unrouted')).join('')
      : '';

    const showMoreBtn = (lowOptions.length > 0 && options.length > 0) ? `
      <button class="aa-instbar-btn aa-instbar-show-all ${showLow ? 'active' : ''}" data-channel="${ch}">
        ${showLow ? '\u25C9' : '\u25CB'} ${showLow ? _t('autoAssign.hideDetails') : `+${lowOptions.length}`}
      </button>
    ` : '';

    return `
      <div class="aa-instbar-content ${isSkipped ? 'rs-chips-skipped' : ''}">
        <div class="aa-instbar-list">${chips}${lowChips}${showMoreBtn}</div>
      </div>
    `;
  }

  /**
   * Polyphony reduction section : shown only when the channel's polyphony
   * exceeds the instrument's capacity. Renders radios for none/auto/manual,
   * an optional target input, and strategy radios.
   *
   * @param {Object} opts
   * @param {number} opts.channel
   * @param {Object} opts.adaptation            - { polyReduction, polyStrategy, polyTarget }
   * @param {Object|null} opts.assignment       - used only for gmProgram fallback
   * @param {number|null} opts.channelPolyphony - actual polyphony of the channel
   * @param {number|null} opts.instrumentPolyphony - polyphony of the routed instrument (0/null → GM default)
   */
  function renderPolyReductionSection(opts) {
    const {
      channel, adaptation, assignment,
      channelPolyphony, instrumentPolyphony
    } = opts;
    const { getGmDefaultPolyphony } = window.RoutingSummaryConstants;

    const gmPoly = getGmDefaultPolyphony(assignment?.gmProgram);
    const effectivePoly = instrumentPolyphony || gmPoly;

    if (!channelPolyphony || !effectivePoly || channelPolyphony <= effectivePoly) {
      return '';
    }

    const polyReduction = adaptation.polyReduction || 'none';
    const polyStrategy = adaptation.polyStrategy || 'shorten';
    const polyTarget = polyReduction === 'manual' && adaptation.polyTarget != null
      ? adaptation.polyTarget
      : effectivePoly;
    const polyExcess = channelPolyphony - polyTarget;
    const impactKey = polyStrategy === 'shorten' ? 'autoAssign.polyImpactShorten' : 'autoAssign.polyImpactDrop';

    return `
      <div class="rs-adapt-row rs-poly-section">
        <span class="rs-adapt-label">${_t('autoAssign.polyReductionTitle')}</span>
        <div class="rs-adapt-options">
          <label class="rs-adapt-radio ${polyReduction === 'none' ? 'selected' : ''}">
            <input type="radio" name="rs_poly_${channel}" value="none" ${polyReduction === 'none' ? 'checked' : ''} data-channel="${channel}" data-field="polyReduction">
            ${_t('autoAssign.polyNone')}
          </label>
          <label class="rs-adapt-radio ${polyReduction === 'auto' ? 'selected' : ''}">
            <input type="radio" name="rs_poly_${channel}" value="auto" ${polyReduction === 'auto' ? 'checked' : ''} data-channel="${channel}" data-field="polyReduction">
            ${_t('autoAssign.polyAuto')} <span class="rs-adapt-auto-info">(${effectivePoly})</span>
          </label>
          <label class="rs-adapt-radio ${polyReduction === 'manual' ? 'selected' : ''}">
            <input type="radio" name="rs_poly_${channel}" value="manual" ${polyReduction === 'manual' ? 'checked' : ''} data-channel="${channel}" data-field="polyReduction">
            ${_t('autoAssign.polyManual')}
          </label>
        </div>
      </div>
      ${polyReduction === 'manual' ? `
      <div class="rs-adapt-row rs-poly-target-row">
        <span class="rs-adapt-label">${_t('autoAssign.polyTargetLabel')}</span>
        <div class="rs-transpose-controls">
          <button class="btn btn-sm rs-poly-target-btn" data-channel="${channel}" data-delta="-1">-1</button>
          <input type="number" class="rs-poly-target-input" data-channel="${channel}" value="${polyTarget}" min="1" max="${channelPolyphony}">
          <button class="btn btn-sm rs-poly-target-btn" data-channel="${channel}" data-delta="1">+1</button>
        </div>
      </div>` : ''}
      ${polyReduction !== 'none' ? `
      <div class="rs-adapt-row rs-poly-strategy-row">
        <span class="rs-adapt-label">${_t('autoAssign.polyStrategyTitle')}</span>
        <div class="rs-adapt-options">
          <label class="rs-adapt-radio ${polyStrategy === 'shorten' ? 'selected' : ''}" title="${_t('autoAssign.polyStrategyShortenDesc')}">
            <input type="radio" name="rs_polystrat_${channel}" value="shorten" ${polyStrategy === 'shorten' ? 'checked' : ''} data-channel="${channel}" data-field="polyStrategy">
            ${_t('autoAssign.polyStrategyShorten')}
          </label>
          <label class="rs-adapt-radio ${polyStrategy === 'drop' ? 'selected' : ''}" title="${_t('autoAssign.polyStrategyDropDesc')}">
            <input type="radio" name="rs_polystrat_${channel}" value="drop" ${polyStrategy === 'drop' ? 'checked' : ''} data-channel="${channel}" data-field="polyStrategy">
            ${_t('autoAssign.polyStrategyDrop')}
          </label>
        </div>
      </div>
      <div class="rs-poly-info">
        <span class="rs-poly-info-detail">\u266B ${_t('autoAssign.channelPolyphony')}: ${channelPolyphony} | ${_t('autoAssign.instrumentPolyphony')}: ${effectivePoly}${polyReduction === 'manual' ? ` | ${_t('autoAssign.polyTargetLabel')}: ${polyTarget}` : ''}</span>
        ${polyExcess > 0 ? `<span class="rs-poly-info-impact">\u2248 ${polyExcess} ${_t(impactKey)}</span>` : ''}
      </div>` : ''}
    `;
  }

  /**
   * Full 0-127 MIDI range visualisation with two-line display :
   *   line 1 = channel notes (transposition applied),
   *   line 2 = instrument playable range(s) with labels + connectors.
   *
   * @param {Object} opts
   * @param {number} opts.channel
   * @param {Object} opts.analysis     - { noteRange, noteDistribution }
   * @param {Object|null} opts.assignment
   * @param {Object} opts.adaptSettings - per-channel adaptation settings
   * @param {boolean} opts.autoAdaptation
   * @param {Object|null} opts.splitData - from getActiveSplitData(channel)
   * @param {Array<Object>} opts.allInstruments
   * @param {(segs: Array) => Array} opts.detectOverlaps
   * @param {(inst:Object) => string} opts.getDisplayName
   * @param {(s:string) => string} opts.escape
   */
  function renderRangeBars(opts) {
    const {
      channel, analysis, assignment,
      adaptSettings, autoAdaptation,
      splitData, allInstruments = [],
      detectOverlaps, getDisplayName, escape
    } = opts;
    const {
      SPLIT_COLORS, FULL_RANGE, getGmProgramName, midiNoteToName
    } = window.RoutingSummaryConstants;

    if (!analysis?.noteRange || analysis.noteRange.min == null) return '';

    const ch = String(channel);
    const chMin = analysis.noteRange.min;
    const chMax = analysis.noteRange.max;

    const adapt = adaptSettings[ch] || {};
    const semitones = (autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
    const displayChMin = Math.max(0, Math.min(127, chMin + semitones));
    const displayChMax = Math.max(0, Math.min(127, chMax + semitones));

    const chLeft = (displayChMin / FULL_RANGE) * 100;
    const chWidth = Math.max(1, ((displayChMax - displayChMin) / FULL_RANGE) * 100);

    const transLabel = semitones !== 0 ? ` (${semitones > 0 ? '+' : ''}${semitones}st)` : '';
    const chBarTitle = `${_t('autoAssign.channelNotes')}: ${midiNoteToName(displayChMin)}-${midiNoteToName(displayChMax)}${transLabel}`;

    const splitColors = SPLIT_COLORS;
    let instBarsHTML = '';
    let legendItems = '';

    if (splitData?.segments?.length > 0) {
      const segs = splitData.segments;
      instBarsHTML = segs.map((seg, i) => {
        const sMin = seg.fullRange?.min ?? seg.noteRange?.min ?? 0;
        const sMax = seg.fullRange?.max ?? seg.noteRange?.max ?? 127;
        const left = (sMin / FULL_RANGE) * 100;
        const width = Math.max(1, ((sMax - sMin) / FULL_RANGE) * 100);
        const color = splitColors[i % splitColors.length];
        const instLookup = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
        const name = instLookup ? getDisplayName(instLookup) : (seg.instrumentName || `Inst ${i + 1}`);

        let dottedCSS = '';
        if (analysis?.noteDistribution) {
          const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
          const shiftedNotes = usedNotes.map(n => n + semitones);
          const hasNotesInRange = shiftedNotes.some(n => n >= sMin && n <= sMax);
          if (!hasNotesInRange) dottedCSS = 'rs-range-dotted';
        }

        const connLeftPct = (sMin / FULL_RANGE) * 100;
        const connRightPct = (sMax / FULL_RANGE) * 100;

        return `
          <div class="rs-range-inst-line">
            <div class="rs-range-connector" style="left:${connLeftPct}%"></div>
            <div class="rs-range-connector" style="left:${connRightPct}%"></div>
            <div class="rs-range-bar rs-range-inst-bar ${dottedCSS}" style="left:${left}%;width:${width}%;background:${color}33;border:1px solid ${color}" title="${escape(name)}: ${midiNoteToName(sMin)}-${midiNoteToName(sMax)}"></div>
            <span class="rs-range-inst-label" style="left:${left}%;color:${color}">${escape(name)}</span>
          </div>
        `;
      }).join('');

      const behaviorMode = splitData.behaviorMode;
      const skipOverlapViz = (behaviorMode === 'overflow' || behaviorMode === 'alternate');
      const overlaps = skipOverlapViz ? [] : (detectOverlaps ? detectOverlaps(segs) : []);
      const overlapZonesHTML = overlaps.length > 0 ? overlaps.map(ov => {
        const oLeft = (ov.min / FULL_RANGE) * 100;
        const oWidth = Math.max(0.5, ((ov.max - ov.min) / FULL_RANGE) * 100);
        const instA = segs[ov.segA]?.instrumentId ? allInstruments.find(ii => ii.id === segs[ov.segA].instrumentId) : null;
        const instB = segs[ov.segB]?.instrumentId ? allInstruments.find(ii => ii.id === segs[ov.segB].instrumentId) : null;
        const nameA = instA ? getDisplayName(instA) : (segs[ov.segA]?.instrumentName || `Inst ${ov.segA + 1}`);
        const nameB = instB ? getDisplayName(instB) : (segs[ov.segB]?.instrumentName || `Inst ${ov.segB + 1}`);
        return `<div class="rs-range-overlap-zone" style="left:${oLeft}%;width:${oWidth}%" title="\u26A0 ${_t('routingSummary.overlap') || 'Superposition'}: ${midiNoteToName(ov.min)}-${midiNoteToName(ov.max)} (${escape(nameA)} / ${escape(nameB)})"></div>`;
      }).join('') : '';

      instBarsHTML = `<div class="rs-range-inst-area">${instBarsHTML}${overlapZonesHTML}</div>`;

      legendItems = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const instL = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
        const name = instL ? getDisplayName(instL) : (seg.instrumentName || `Inst ${i + 1}`);
        return `<span class="rs-range-legend-item"><span class="rs-range-legend-key" style="background:${color}80;border:1px solid ${color}"></span>${escape(name)}</span>`;
      }).join('');
      if (overlaps.length > 0) {
        legendItems += `<span class="rs-range-legend-item"><span class="rs-range-legend-key" style="background:repeating-linear-gradient(45deg,rgba(245,158,11,0.3),rgba(245,158,11,0.3) 2px,transparent 2px,transparent 4px);border:1px dashed #f59e0b"></span>${_t('routingSummary.overlap') || 'Superposition'}</span>`;
      }
    } else if (assignment?.noteRangeMin != null) {
      const iMin = assignment.noteRangeMin;
      const iMax = assignment.noteRangeMax;
      const left = (iMin / FULL_RANGE) * 100;
      const width = Math.max(1, ((iMax - iMin) / FULL_RANGE) * 100);
      const color = '#4A90D9';
      const instName = assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || _t('autoAssign.instrumentRange');
      const connLeftPct = (iMin / FULL_RANGE) * 100;
      const connRightPct = (iMax / FULL_RANGE) * 100;

      instBarsHTML = `
        <div class="rs-range-inst-line">
          <div class="rs-range-connector" style="left:${connLeftPct}%"></div>
          <div class="rs-range-connector" style="left:${connRightPct}%"></div>
          <div class="rs-range-bar rs-range-inst-bar" style="left:${left}%;width:${width}%;background:${color}33;border:1px solid ${color}" title="${escape(instName)}: ${midiNoteToName(iMin)}-${midiNoteToName(iMax)}"></div>
          <span class="rs-range-inst-label" style="left:${left}%;color:${color}">${escape(instName)}</span>
        </div>
      `;
      legendItems = `<span class="rs-range-legend-item"><span class="rs-range-legend-key rs-range-legend-inst"></span>${escape(instName)}</span>`;
    }

    const octaveMarkers = [];
    for (let oct = 0; oct <= 10; oct++) {
      const note = oct * 12;
      if (note <= 127) {
        const pct = (note / FULL_RANGE) * 100;
        octaveMarkers.push(`<span class="rs-range-octave-mark" style="left:${pct}%">C${oct}</span>`);
      }
    }

    return `
      <div class="rs-range-full">
        <div class="rs-range-labels-full">
          <span class="rs-range-label-ch" style="color:var(--accent-color, #4285f4)">${_t('autoAssign.channelNotes') || 'Notes canal'}: ${midiNoteToName(displayChMin)}-${midiNoteToName(displayChMax)}${transLabel}</span>
        </div>
        <div class="rs-range-octaves">${octaveMarkers.join('')}</div>
        <div class="rs-range-track-line" title="${chBarTitle}">
          <div class="rs-range-bar rs-range-ch-bar" style="left:${chLeft}%;width:${chWidth}%"></div>
        </div>
        ${instBarsHTML}
      </div>
    `;
  }

  /**
   * Drum note mapping section (source → destination). Collapsed state
   * shows only a toggle ; expanded state shows a full table with per-note
   * dropdown + mute toggle.
   *
   * @param {Object} opts
   * @param {number} opts.channel
   * @param {Object|null} opts.assignment
   * @param {Object|null} opts.analysis
   * @param {boolean} opts.isExpanded
   * @param {Array<number>} opts.instrumentNotes - available drum notes on the instrument
   * @param {Object} opts.baseMapping - auto-generated noteRemapping (srcNote → destNote)
   * @param {Object} opts.customMap - user overrides
   * @param {Set<number>} opts.mutedNotes
   * @param {(s:string) => string} opts.escape
   */
  function renderDrumMappingSection(opts) {
    const {
      channel, assignment, analysis,
      isExpanded, instrumentNotes,
      baseMapping = {}, customMap = {}, mutedNotes = new Set(),
      escape
    } = opts;
    const { DRUM_NAMES } = window.RoutingSummaryConstants;

    if (!assignment || !analysis?.noteEvents) return '';

    if (!isExpanded) {
      const noteCount = Object.keys(analysis.noteDistribution || {}).filter(n => +n >= 35 && +n <= 81).length;
      if (noteCount === 0) return '';
      return `
        <div class="rs-drum-mapping">
          <h4 class="rs-drum-mapping-toggle" data-channel="${channel}" style="cursor:pointer">
            ${_t('autoAssign.drumMapping') || 'Drum Mapping'} \u25B8 <small>(${noteCount} notes)</small>
          </h4>
        </div>`;
    }

    if (!instrumentNotes || instrumentNotes.length === 0) return '';

    const noteDistribution = analysis.noteDistribution || {};
    const channelNotes = Object.keys(noteDistribution)
      .map(Number)
      .filter(n => n >= 35 && n <= 81)
      .sort((a, b) => a - b);

    if (channelNotes.length === 0) return '';

    const sortedInstrumentNotes = instrumentNotes.slice().sort((a, b) => a - b);

    const rows = channelNotes.map(srcNote => {
      const count = noteDistribution[srcNote] || 0;
      const srcName = DRUM_NAMES[srcNote] || `Note ${srcNote}`;

      let destNote;
      if (customMap[srcNote] !== undefined) destNote = customMap[srcNote];
      else if (baseMapping[srcNote] !== undefined) destNote = baseMapping[srcNote];
      else destNote = srcNote;

      const isExact = destNote === srcNote && !customMap[srcNote] && !baseMapping[srcNote];
      const isSubstitution = !isExact && destNote !== srcNote;
      const isCustom = customMap[srcNote] !== undefined;
      const isMuted = mutedNotes.has(srcNote);
      const isAvailable = instrumentNotes.includes(srcNote);

      let typeLabel, typeClass;
      if (isMuted) { typeLabel = 'Muté'; typeClass = 'rs-drum-type-muted'; }
      else if (isCustom) { typeLabel = 'Manuel'; typeClass = 'rs-drum-type-custom'; }
      else if (isExact && isAvailable) { typeLabel = 'Exact'; typeClass = 'rs-drum-type-exact'; }
      else if (isSubstitution) { typeLabel = 'Subst.'; typeClass = 'rs-drum-type-subst'; }
      else { typeLabel = 'N/A'; typeClass = 'rs-drum-type-na'; }

      const destOptions = sortedInstrumentNotes.map(n => {
        const name = DRUM_NAMES[n] || `Note ${n}`;
        const sel = n === destNote ? 'selected' : '';
        return `<option value="${n}" ${sel}>${n}: ${escape(name)}</option>`;
      }).join('');

      return `<tr class="rs-drum-row${isMuted ? ' rs-drum-row-muted' : ''}">
        <td class="rs-drum-src" title="${escape(srcName)}">${srcNote}: ${escape(srcName.length > 14 ? srcName.slice(0, 13) + '\u2026' : srcName)}</td>
        <td class="rs-drum-count">${count}</td>
        <td class="rs-drum-arrow">\u2192</td>
        <td class="rs-drum-dest">
          <select class="rs-drum-dest-select" data-channel="${channel}" data-src="${srcNote}" ${isMuted ? 'disabled' : ''}>
            ${destOptions}
          </select>
        </td>
        <td class="rs-drum-type ${typeClass}">${typeLabel}</td>
        <td class="rs-drum-toggle">
          <label class="rs-drum-toggle-label">
            <input type="checkbox" class="rs-drum-note-toggle" data-channel="${channel}" data-note="${srcNote}" ${isMuted ? '' : 'checked'}>
            <span class="rs-drum-toggle-slider"></span>
          </label>
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="rs-drum-mapping">
        <h4 class="rs-drum-mapping-toggle" data-channel="${channel}" style="cursor:pointer">${_t('autoAssign.drumMapping') || 'Drum Mapping'} \u25BE <small>(${channelNotes.length} notes)</small></h4>
        <table class="rs-drum-mapping-table">
          <thead>
            <tr>
              <th>${_t('autoAssign.drumSource') || 'Source'}</th>
              <th>#</th>
              <th></th>
              <th>${_t('autoAssign.drumDest') || 'Destination'}</th>
              <th>${_t('autoAssign.drumType') || 'Type'}</th>
              <th>${_t('autoAssign.drumEnabled') || 'On'}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  /**
   * CC (MIDI Controller Change) mapping section with collapsed/expanded states.
   * Supports single-instrument + multi-segment split layouts.
   *
   * @param {Object} opts
   * @param {number} opts.channel
   * @param {Array<number>} opts.channelCCs     - CCs observed in the channel
   * @param {Object|null} opts.assignment
   * @param {boolean} opts.isSplit
   * @param {boolean} opts.isSkipped
   * @param {boolean} opts.isExpanded
   * @param {boolean} opts.showAll              - pagination toggle
   * @param {string} opts.summaryHTML           - pre-rendered summary block
   * @param {Object} opts.currentRemap          - per-CC remap dict (-1 = disabled)
   * @param {Array<Object>} [opts.segments]
   * @param {Array<Array<number>|null>} [opts.segCCs] - CCs supported by each segment
   * @param {Object<number, Set<number>>} [opts.ccSegmentMute] - per-CC, set of muted segments
   * @param {Array<Object>} [opts.allInstruments]
   * @param {Array<number>|null} [opts.instrumentCCs] - single-instrument mode
   * @param {string} [opts.instrumentName]
   * @param {(id:string) => string} opts.getInstrumentDisplayName
   * @param {(cc:number) => string} opts.getCCName
   * @param {(s:string) => string} opts.escape
   */
  function renderCCSection(opts) {
    const {
      channel, channelCCs, assignment, isSplit, isSkipped, isExpanded, showAll,
      summaryHTML, currentRemap,
      segments = [], segCCs = [], ccSegmentMute = {},
      allInstruments = [],
      instrumentCCs = null, instrumentName = '',
      getInstrumentDisplayName, getCCName, escape
    } = opts;
    const { CC_PAGE_SIZE, SPLIT_COLORS, getGmProgramName } = window.RoutingSummaryConstants;
    const ch = String(channel);

    if (isSkipped || (!assignment && !isSplit)) return '';
    if (channelCCs.length === 0) return '';

    const toggleIcon = isExpanded ? '\u25BE' : '\u25B8';

    if (!isExpanded) {
      return `
        <div class="rs-cc-section">
          <h4 class="rs-cc-title rs-cc-toggle" data-channel="${channel}" style="cursor:pointer">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'} ${toggleIcon} <small>(${channelCCs.length})</small></h4>
          ${summaryHTML}
        </div>`;
    }

    const visibleCCs = showAll ? channelCCs : channelCCs.slice(0, CC_PAGE_SIZE);
    const hasMore = !showAll && channelCCs.length > CC_PAGE_SIZE;
    const channelCCSet = new Set(channelCCs);

    // Split mode
    if (isSplit && segments.length > 0) {
      const headerCols = segments.map((seg, i) => {
        const color = SPLIT_COLORS[i % SPLIT_COLORS.length];
        const instRef = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
        const name = instRef ? getInstrumentDisplayName(instRef) : (seg.instrumentName || '?');
        const short = name.length > 10 ? name.slice(0, 9) + '\u2026' : name;
        return `<th class="rs-cc-inst-col" style="color:${color}" title="${escape(name)}">${escape(short)}</th>`;
      }).join('');

      const bodyRows = visibleCCs.map(ccNum => {
        const name = getCCName(ccNum);
        const isDisabled = currentRemap[ccNum] === -1;
        const muteActive = isDisabled ? ' rs-cc-mute-active' : '';
        const muteTitle = isDisabled
          ? (_t('routingSummary.ccEnable') || 'Activer ce CC')
          : (_t('routingSummary.ccDisable') || 'Désactiver ce CC');
        const muteBtn = `<td class="rs-cc-mute-cell"><button class="rs-cc-mute-btn${muteActive}" data-channel="${ch}" data-cc="${ccNum}" title="${muteTitle}">${isDisabled ? '\u{1F507}' : '\u{1F509}'}</button></td>`;

        const segMutes = ccSegmentMute[channel]?.[ccNum];
        let cells;
        if (isDisabled) {
          cells = segments.map(() => `<td class="rs-cc-cell rs-cc-cell-disabled">\u2014</td>`).join('');
        } else {
          cells = segCCs.map((ccs, i) => {
            const isSegMuted = segMutes?.has(i);
            const segToggleClass = isSegMuted ? ' rs-cc-seg-muted' : '';
            const segToggleBtn = `<button class="rs-cc-seg-toggle${segToggleClass}" data-channel="${channel}" data-cc="${ccNum}" data-seg="${i}" title="${isSegMuted ? _t('routingSummary.ccEnable') || 'Enable this CC' : _t('routingSummary.ccDisable') || 'Disable this CC'}">${isSegMuted ? '\u{1F507}' : '\u{1F509}'}</button>`;

            if (isSegMuted) return `<td class="rs-cc-cell rs-cc-cell-seg-muted">${segToggleBtn}</td>`;
            if (ccs === null) return `<td class="rs-cc-cell rs-cc-cell-unknown">${segToggleBtn} ?</td>`;
            if (ccs.includes(ccNum)) return `<td class="rs-cc-cell rs-cc-cell-ok">${segToggleBtn} \u2713</td>`;
            const currentTarget = currentRemap[ccNum];
            const remapOpts = (ccs || [])
              .filter(tc => !channelCCSet.has(tc) || tc === ccNum)
              .map(tc => `<option value="${tc}" ${currentTarget === tc ? 'selected' : ''}>${getCCName(tc)}</option>`)
              .join('');
            return `<td class="rs-cc-cell rs-cc-cell-no">
              ${segToggleBtn}
              <select class="rs-cc-remap rs-cc-remap-split" data-channel="${ch}" data-source="${ccNum}">
                <option value="">\u2717</option>
                ${remapOpts}
              </select>
            </td>`;
          }).join('');
        }

        const anyUnsupported = !isDisabled && segCCs.some(ccs => ccs !== null && !ccs.includes(ccNum));
        const rowClass = isDisabled ? 'rs-cc-row-disabled' : (anyUnsupported ? 'rs-cc-row-warn' : '');
        return `<tr class="${rowClass}">${muteBtn}<td class="rs-cc-num">CC${ccNum}</td><td class="rs-cc-name">${escape(name)}</td>${cells}</tr>`;
      }).join('');

      const showMoreRow = hasMore
        ? `<tr><td colspan="${3 + segments.length}" class="rs-cc-show-more" data-channel="${channel}" style="cursor:pointer;text-align:center;padding:6px">${_t('routingSummary.showAllCCs') || 'Voir tout'} (${channelCCs.length - CC_PAGE_SIZE} ${_t('routingSummary.more') || 'de plus'})</td></tr>`
        : '';

      return `
        <div class="rs-cc-section">
          <h4 class="rs-cc-title rs-cc-toggle" data-channel="${channel}" style="cursor:pointer">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'} ${toggleIcon} <small>(${channelCCs.length})</small></h4>
          ${summaryHTML}
          <table class="rs-cc-table">
            <thead><tr><th></th><th>CC</th><th>${_t('common.name') || 'Nom'}</th>${headerCols}</tr></thead>
            <tbody>${bodyRows}${showMoreRow}</tbody>
          </table>
        </div>`;
    }

    // Single instrument mode
    const instName = instrumentName || assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || _t('autoAssign.instrument');
    const instShort = instName.length > 10 ? instName.slice(0, 9) + '\u2026' : instName;

    const bodyRows = visibleCCs.map(ccNum => {
      const name = getCCName(ccNum);
      const isDisabled = currentRemap[ccNum] === -1;
      const muteActive = isDisabled ? ' rs-cc-mute-active' : '';
      const muteTitle = isDisabled
        ? (_t('routingSummary.ccEnable') || 'Activer ce CC')
        : (_t('routingSummary.ccDisable') || 'Désactiver ce CC');
      const muteBtn = `<td class="rs-cc-mute-cell"><button class="rs-cc-mute-btn${muteActive}" data-channel="${ch}" data-cc="${ccNum}" title="${muteTitle}">${isDisabled ? '\u{1F507}' : '\u{1F509}'}</button></td>`;

      let statusCell;
      if (isDisabled) {
        statusCell = `<td class="rs-cc-cell rs-cc-cell-disabled">\u2014</td>`;
      } else if (instrumentCCs === null) {
        statusCell = `<td class="rs-cc-cell rs-cc-cell-unknown">?</td>`;
      } else if (instrumentCCs.includes(ccNum)) {
        statusCell = `<td class="rs-cc-cell rs-cc-cell-ok">\u2713</td>`;
      } else {
        const currentTarget = currentRemap[ccNum];
        const remapOpts = instrumentCCs
          .filter(targetCC => !channelCCSet.has(targetCC) || targetCC === ccNum)
          .map(targetCC => {
            const selected = currentTarget === targetCC ? 'selected' : '';
            return `<option value="${targetCC}" ${selected}>${getCCName(targetCC)}</option>`;
          }).join('');
        statusCell = `<td class="rs-cc-cell rs-cc-cell-no">
          <select class="rs-cc-remap" data-channel="${ch}" data-source="${ccNum}">
            <option value="">\u2717</option>
            ${remapOpts}
          </select>
        </td>`;
      }

      const rowClass = isDisabled ? 'rs-cc-row-disabled' : (instrumentCCs !== null && !instrumentCCs.includes(ccNum) && !isDisabled ? 'rs-cc-row-warn' : '');
      return `<tr class="${rowClass}">${muteBtn}<td class="rs-cc-num">CC${ccNum}</td><td class="rs-cc-name">${escape(name)}</td>${statusCell}</tr>`;
    }).join('');

    const showMoreRow = hasMore
      ? `<tr><td colspan="4" class="rs-cc-show-more" data-channel="${channel}" style="cursor:pointer;text-align:center;padding:6px">${_t('routingSummary.showAllCCs') || 'Voir tout'} (${channelCCs.length - CC_PAGE_SIZE} ${_t('routingSummary.more') || 'de plus'})</td></tr>`
      : '';

    return `
      <div class="rs-cc-section">
        <h4 class="rs-cc-title rs-cc-toggle" data-channel="${channel}" style="cursor:pointer">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'} ${toggleIcon} <small>(${channelCCs.length})</small></h4>
        ${summaryHTML}
        <table class="rs-cc-table">
          <thead><tr><th></th><th>CC</th><th>${_t('common.name') || 'Nom'}</th><th class="rs-cc-inst-col" title="${escape(instName)}">${escape(instShort)}</th></tr></thead>
          <tbody>${bodyRows}${showMoreRow}</tbody>
        </table>
      </div>`;
  }

  /**
   * Score detail panel. Three layouts :
   *   - empty      : no channels suggested → placeholder
   *   - detail     : one channel selected  → score breakdown or per-segment coverage
   *   - summary    : no channel selected   → compact cells grid
   *
   * @param {Object} opts
   * @param {Object} opts.suggestions           - per-channel suggestion list
   * @param {number|null} opts.selectedChannel
   * @param {Set<number>} opts.skippedChannels
   * @param {Set<number>} opts.splitChannels
   * @param {Object} opts.selectedAssignments
   * @param {Object} opts.channelAnalyses
   * @param {Object} opts.splitAssignments
   * @param {Object} opts.adaptationSettings
   * @param {boolean} opts.autoAdaptation
   * @param {Array<Object>} opts.allInstruments
   * @param {(inst:Object) => string} opts.getDisplayName
   * @param {(s:string) => string} opts.escape
   */
  function renderScoreDetail(opts) {
    const {
      suggestions, selectedChannel,
      skippedChannels, splitChannels,
      selectedAssignments, channelAnalyses, splitAssignments,
      adaptationSettings, autoAdaptation,
      allInstruments,
      getDisplayName, escape
    } = opts;
    const {
      SPLIT_COLORS, getGmProgramName, midiNoteToName, getScoreClass, getScoreBgClass
    } = window.RoutingSummaryConstants;

    const allKeys = Object.keys(suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    const isDetailMode = selectedChannel !== null;
    const channelKeys = isDetailMode
      ? allKeys.filter(ch => parseInt(ch) === selectedChannel)
      : allKeys;
    if (channelKeys.length === 0) return `<div class="rs-score-empty">${_t('routingSummary.noChannels') || 'Aucun canal'}</div>`;

    if (isDetailMode) {
      const breakdownLabels = {
        program: _t('autoAssign.scoreProgram') || 'Programme',
        noteRange: _t('autoAssign.scoreNoteRange') || 'Tessiture',
        polyphony: _t('autoAssign.scorePolyphony') || 'Polyphonie',
        ccSupport: _t('autoAssign.scoreCCSupport') || 'CC Support',
        instrumentType: _t('autoAssign.scoreType') || 'Type',
        percussion: _t('autoAssign.scorePercussion') || 'Percussion'
      };
      const ch = channelKeys[0];
      const channel = parseInt(ch);
      const isSkipped = skippedChannels.has(channel);
      const isSplit = splitChannels.has(channel);
      const assignment = selectedAssignments[ch];
      const analysis = channelAnalyses[channel];
      const gmName = channel === 9 ? (_t('autoAssign.drums') || 'Drums') : (getGmProgramName(analysis?.primaryProgram) || '\u2014');

      if (isSplit && splitAssignments[channel]) {
        const segments = splitAssignments[channel].segments || [];
        const totalNotes = analysis?.noteDistribution ? Object.values(analysis.noteDistribution).reduce((s, c) => s + c, 0) : 0;

        const segRows = segments.map((seg, i) => {
          const color = SPLIT_COLORS[i % SPLIT_COLORS.length];
          const inst = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
          const name = inst ? getDisplayName(inst) : (seg.instrumentName || `Inst ${i + 1}`);
          const rMin = seg.noteRange?.min ?? 0;
          const rMax = seg.noteRange?.max ?? 127;
          let segNotes = 0;
          if (analysis?.noteDistribution) {
            const adapt = adaptationSettings[ch] || {};
            const semi = (autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
            for (const [note, count] of Object.entries(analysis.noteDistribution)) {
              const shifted = parseInt(note) + semi;
              if (shifted >= rMin && shifted <= rMax) segNotes += count;
            }
          }
          const coveragePct = totalNotes > 0 ? Math.round((segNotes / totalNotes) * 100) : 0;

          return `<div class="rs-score-bar-row">
            <span class="rs-score-bar-label" style="color:${color}">${escape(name)}</span>
            <div class="rs-score-bar-track">
              <div class="rs-score-bar-fill" style="width:${coveragePct}%;background:${color}"></div>
            </div>
            <span class="rs-score-bar-value">${coveragePct}% (${midiNoteToName(rMin)}\u2013${midiNoteToName(rMax)})</span>
          </div>`;
        }).join('');

        return `<div class="rs-score-detail-content">
          <div class="rs-score-row">
            <div class="rs-score-row-header">
              <span class="rs-score-row-ch">CH ${channel + 1}</span>
              <span class="rs-score-row-gm">${escape(gmName)}</span>
              <span class="rs-score-row-arrow">\u2192</span>
              <span class="rs-score-row-inst">${segments.length} instruments</span>
            </div>
            <div class="rs-score-breakdown">
              <div class="rs-score-bar-row">
                <span class="rs-score-bar-label" style="font-weight:600">${_t('routingSummary.noteCoverage') || 'Couverture notes'}</span>
                <span class="rs-score-bar-value"></span>
              </div>
              ${segRows}
            </div>
          </div>
        </div>`;
      }

      const score = assignment?.score || 0;
      const instName = isSkipped
        ? `<span class="rs-score-muted">${_t('routingSummary.muted') || 'Muté'}</span>`
        : escape(assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || '\u2014');

      const breakdown = assignment?.scoreBreakdown;
      let breakdownHtml = '';
      if (breakdown && !isSkipped) {
        const entries = Object.entries(breakdown).filter(([, v]) => v && v.max > 0);
        breakdownHtml = `<div class="rs-score-breakdown">` +
          entries.map(([key, val]) => {
            const pct = val.max > 0 ? Math.round((val.score / val.max) * 100) : 0;
            return `<div class="rs-score-bar-row">
              <span class="rs-score-bar-label">${breakdownLabels[key] || key}</span>
              <div class="rs-score-bar-track">
                <div class="rs-score-bar-fill ${getScoreBgClass(pct)}" style="width:${pct}%"></div>
              </div>
              <span class="rs-score-bar-value">${val.score}/${val.max}</span>
            </div>`;
          }).join('') + `</div>`;
      }
      const issues = (!isSkipped && assignment?.issues?.length)
        ? `<div class="rs-score-issues">${assignment.issues.map(i =>
            `<span class="rs-score-issue rs-score-issue-${i.type || 'warning'}">${escape(i.message)}</span>`
          ).join('')}</div>` : '';

      return `<div class="rs-score-detail-content">
        <div class="rs-score-row">
          <div class="rs-score-row-header">
            <span class="rs-score-row-ch">CH ${channel + 1}</span>
            <span class="rs-score-row-gm">${escape(gmName)}</span>
            <span class="rs-score-row-arrow">\u2192</span>
            <span class="rs-score-row-inst">${instName}</span>
            <span class="rs-score-row-score ${getScoreClass(score)}">${isSkipped ? '\u2014' : score}</span>
          </div>
          ${breakdownHtml}${issues}
        </div>
      </div>`;
    }

    // Summary mode
    const cells = channelKeys.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = skippedChannels.has(channel);
      const assignment = selectedAssignments[ch];
      const score = assignment?.score || 0;
      const isShared = assignment?.shared || (assignment?.sharedWith && assignment.sharedWith.length > 0);
      const instName = isSkipped
        ? (_t('routingSummary.muted') || 'Muté')
        : (assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || '\u2014');
      const displayName = instName.length > 12 ? instName.slice(0, 11) + '\u2026' : instName;
      const sharedClass = isShared ? ' rs-score-cell-shared' : '';
      const sharedTitle = isShared && assignment.sharedWith?.length
        ? ` (${_t('routingSummary.sharedWith', { channels: assignment.sharedWith.map(c => c + 1).join(', ') }) || 'Partagé avec Ch ' + assignment.sharedWith.map(c => c + 1).join(', ')})`
        : '';
      return `<div class="rs-score-cell ${isSkipped ? 'rs-score-cell-skipped' : ''}${sharedClass}" title="${escape(instName + sharedTitle)}">
        <span class="rs-score-cell-ch">CH ${channel + 1}</span>
        <span class="rs-score-cell-score ${getScoreBgClass(score)}">${isSkipped ? '\u2014' : score}${isShared ? '<span class="rs-shared-badge" title="' + escape((_t('routingSummary.sharedTooltip') || 'Instrument partagé')) + '">\u{1F517}</span>' : ''}</span>
        <span class="rs-score-cell-inst">${escape(displayName)}</span>
      </div>`;
    }).join('');

    return `<div class="rs-score-grid">${cells}</div>`;
  }

  /**
   * Main summary table of channels (either full 9-column or condensed 4-column
   * when a detail panel is open).
   *
   * @param {Object} opts
   * @param {Array<string>} opts.channelKeys
   * @param {number|null} opts.selectedChannel
   * @param {Set<number>} opts.skippedChannels
   * @param {Set<number>} opts.splitChannels
   * @param {Object} opts.selectedAssignments
   * @param {Object} opts.splitAssignments
   * @param {Object} opts.channelAnalyses
   * @param {Array<Object>} opts.allInstruments
   * @param {Object} opts.adaptationSettings
   * @param {boolean} opts.autoAdaptation
   * @param {(inst:Object) => string} opts.getDisplayName
   * @param {(ch:string, assignment:Object, isSkipped:boolean) => string} opts.buildInstrumentOptions
   * @param {(channel:number) => number|null} opts.getChannelPolyphony
   * @param {(channel:number) => number|null} opts.getInstrumentPolyphony
   * @param {(ch:string) => {total:number, playable:number}|null} opts.computePlayableNotes
   * @param {(channel:number) => string} opts.renderVolumeSlider
   * @param {(s:string) => string} opts.escape
   */
  function renderSummaryTable(opts) {
    const {
      channelKeys, selectedChannel,
      skippedChannels, splitChannels,
      selectedAssignments, splitAssignments,
      channelAnalyses, allInstruments,
      adaptationSettings, autoAdaptation,
      getDisplayName, buildInstrumentOptions,
      getChannelPolyphony, getInstrumentPolyphony,
      computePlayableNotes, renderVolumeSlider,
      escape
    } = opts;
    const {
      SPLIT_COLORS, getGmProgramName, getScoreClass, getTypeIcon, getTypeColor
    } = window.RoutingSummaryConstants;
    const isCondensed = selectedChannel !== null;

    const rows = channelKeys.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = skippedChannels.has(channel);
      const isSplit = splitChannels.has(channel);
      const assignment = selectedAssignments[ch];
      const score = isSplit ? (splitAssignments[channel]?.quality || 0) : (assignment?.score || 0);
      const analysis = channelAnalyses[channel] || assignment?.channelAnalysis;

      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (getGmProgramName(analysis?.primaryProgram) || '\u2014');

      let statusClass;
      if (isSkipped) statusClass = 'skipped';
      else if (isSplit || score >= 70) statusClass = 'ok';
      else statusClass = 'warning';

      const displayType = (analysis?.estimatedCategory && analysis.estimatedCategory !== 'unknown')
        ? analysis.estimatedCategory
        : (analysis?.estimatedType || '');
      const typeIcon = displayType ? getTypeIcon(displayType) : '';
      const isSelected = selectedChannel === channel;

      const scoreDotClass = isSkipped ? 'rs-dot-skip' : (score >= 70 ? 'rs-dot-ok' : score >= 40 ? 'rs-dot-warn' : 'rs-dot-poor');

      if (isCondensed) {
        let routedName = '';
        if (isSkipped) {
          routedName = `<span class="rs-skipped-condensed">${_t('routingSummary.muted') || 'Muté'}</span>`;
        } else if (isSplit && splitAssignments[channel]) {
          const segments = splitAssignments[channel].segments || [];
          routedName = segments.map(seg => {
            const inst = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
            return inst ? getDisplayName(inst) : (seg.instrumentName || '?');
          }).join(' + ');
        } else if (assignment?.instrumentDisplayName || assignment?.customName || assignment?.instrumentName) {
          routedName = assignment.instrumentDisplayName || assignment.customName || getGmProgramName(assignment.gmProgram) || assignment.instrumentName;
          if (assignment.shared || (assignment.sharedWith && assignment.sharedWith.length > 0)) {
            routedName += ' <span class="rs-shared-badge" title="' + escape((_t('routingSummary.sharedTooltip') || 'Instrument partagé')) + '">\u{1F517}</span>';
          }
        } else {
          routedName = `<span class="rs-unassigned">\u2014</span>`;
        }

        return `
          <tr class="rs-row rs-row-condensed ${isSkipped ? 'skipped' : ''} ${isSelected ? 'selected' : ''}"
              tabindex="0" role="button" data-channel="${channel}">
            <td class="rs-col-ch-condensed">
              <span class="rs-score-dot ${scoreDotClass}"></span>
              ${typeIcon} <strong>${channel + 1}</strong>${channel === 9 ? ' <span class="rs-drum-badge">DR</span>' : ''}
            </td>
            <td class="rs-col-gm-condensed" title="${escape(gmName)}">${escape(gmName)}</td>
            <td class="rs-col-routed-condensed" title="${typeof routedName === 'string' ? escape(routedName) : ''}">${routedName}</td>
            <td class="rs-col-mute-condensed">
              ${!isSkipped
                ? `<button class="btn btn-sm rs-btn-skip rs-btn-mute" data-channel="${channel}" title="${_t('routingSummary.skip') || 'Muter'}">🔊</button>`
                : `<button class="btn btn-sm rs-btn-unskip rs-btn-unmute" data-channel="${channel}" title="${_t('routingSummary.unskip') || 'Activer'}">🔇</button>`}
            </td>
          </tr>
        `;
      }

      let assignedHTML;
      if (isSplit && !isSkipped && splitAssignments[channel]) {
        const segments = splitAssignments[channel].segments || [];
        const splitParts = segments.map((seg, i) => {
          const color = SPLIT_COLORS[i % SPLIT_COLORS.length];
          const instRef = seg.instrumentId ? allInstruments.find(ii => ii.id === seg.instrumentId) : null;
          const name = instRef ? getDisplayName(instRef) : (seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument');
          const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
          return `<span class="rs-split-inst-name" style="color:${color}" title="${escape(name)}">${escape(displayName)}</span>`;
        });
        assignedHTML = `<div class="rs-split-instruments">${splitParts.join('<span class="rs-split-sep">+</span>')}</div>`;
      } else {
        assignedHTML = `<div class="rs-select-zone"><select class="rs-instrument-select" data-channel="${ch}">${buildInstrumentOptions(ch, assignment, isSkipped)}</select></div>`;
      }

      const isShared = assignment?.shared || (assignment?.sharedWith && assignment.sharedWith.length > 0);
      const sharedBadge = (!isSkipped && isShared)
        ? `<span class="rs-shared-badge" title="${escape((_t('routingSummary.sharedTooltip') || 'Instrument partagé'))}">\u{1F517}</span>`
        : '';
      const scoreHTML = (!isSkipped && score > 0) ? `<span class="rs-score-value ${getScoreClass(score)}">${score}${sharedBadge}</span>` : '';

      let polyHTML = '';
      if (!isSkipped) {
        const chPoly = getChannelPolyphony(channel);
        const instPoly = getInstrumentPolyphony(channel);
        if (chPoly && instPoly) {
          const adapt = adaptationSettings[ch];
          const polyActive = autoAdaptation && adapt?.polyReduction && adapt.polyReduction !== 'none';
          const ok = polyActive || instPoly >= chPoly;
          const polyLabel = polyActive ? `${chPoly}\u2192${adapt.polyTarget || instPoly}` : `${chPoly}/${instPoly}`;
          polyHTML = `<span class="rs-poly-cell ${ok ? 'rs-poly-ok' : 'rs-poly-warn'}">${polyLabel}</span>`;
        }
      }

      let playableHTML = '';
      if (!isSkipped) {
        const playableInfo = computePlayableNotes(ch);
        if (playableInfo) {
          const ok = playableInfo.playable === playableInfo.total;
          playableHTML = `<span class="rs-playable-cell ${ok ? 'rs-poly-ok' : 'rs-poly-warn'}">${playableInfo.total}/${playableInfo.playable}</span>`;
        }
      }

      return `
        <tr class="rs-row ${isSkipped ? 'skipped' : ''} ${statusClass} ${isSelected ? 'selected' : ''}"
            tabindex="0" role="button" data-channel="${channel}"
            aria-label="${_t('autoAssign.channel')} ${channel + 1}">
          <td class="rs-col-ch">
            <span class="rs-score-dot ${scoreDotClass}"></span>
            Ch ${channel + 1}${channel === 9 ? ' <span class="rs-drum-badge">DR</span>' : ''}
          </td>
          <td class="rs-col-original">${escape(gmName)}</td>
          <td class="rs-col-type"><span class="rs-type-badge" style="color:${getTypeColor(displayType)}" title="${displayType ? (_t('autoAssign.type_' + displayType) || displayType) : ''}">${typeIcon} ${displayType ? (_t('autoAssign.type_' + displayType) || displayType) : ''}</span></td>
          <td class="rs-col-assigned">${assignedHTML}</td>
          <td class="rs-col-volume">${renderVolumeSlider(channel)}</td>
          <td class="rs-col-score">${scoreHTML}</td>
          <td class="rs-col-poly">${polyHTML}</td>
          <td class="rs-col-playable">${playableHTML}</td>
          <td class="rs-col-actions">
            ${!isSkipped ? `<button class="btn btn-sm rs-btn-skip rs-btn-mute" data-channel="${channel}" title="${_t('routingSummary.skip')}">🔊</button>` : `<button class="btn btn-sm rs-btn-unskip rs-btn-unmute" data-channel="${channel}" title="${_t('routingSummary.unskip')}">🔇</button>`}
          </td>
        </tr>
      `;
    }).join('');

    if (isCondensed) {
      return `
        <div class="rs-table-wrapper rs-table-condensed">
          <table class="rs-table">
            <thead>
              <tr>
                <th>Ch</th>
                <th>GM</th>
                <th>${_t('autoAssign.overviewAssigned') || 'Routé'}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
        </table>
      </div>
    `;
    }

    return `
      <div class="rs-table-wrapper">
        <table class="rs-table">
          <thead>
            <tr>
              <th>${_t('autoAssign.overviewChannel')}</th>
              <th>${_t('autoAssign.overviewOriginal')}</th>
              <th>${_t('autoAssign.type') || 'Type'}</th>
              <th>${_t('autoAssign.overviewAssigned')}</th>
              <th class="rs-th-compact">Vol</th>
              <th>${_t('routingSummary.score') || 'Score'}</th>
              <th class="rs-th-compact">${_t('autoAssign.polyphony') || 'Polyphonie'}<br><span class="rs-th-sub">${_t('autoAssign.polyphonyHint') || 'canal / instru.'}</span></th>
              <th class="rs-th-compact">Notes<br><span class="rs-th-sub">${_t('autoAssign.channelNotesHint') || 'total / jouables'}</span></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  window.RoutingSummaryRenderers = Object.freeze({
    renderMiniKeyboard,
    renderChannelHistogram,
    renderMiniRange,
    renderDetailPlaceholder,
    renderHeaderButtons,
    renderLoadingScreen,
    renderErrorScreen,
    renderInstrumentChips,
    renderPolyReductionSection,
    renderRangeBars,
    renderDrumMappingSection,
    renderCCSection,
    renderScoreDetail,
    renderSummaryTable
  });
})();
