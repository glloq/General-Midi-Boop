// public/js/views/components/auto-assign/RoutingSummaryPage.js
// RoutingSummaryPage — Page résumé du routage automatique avec layout deux panneaux
(function() {
'use strict';

const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

// ============================================================================
// Utility helpers (standalone, no dependency on AutoAssignModal mixins)
// ============================================================================

function getScoreClass(score) {
  if (score >= 80) return 'rs-color-excellent';
  if (score >= 60) return 'rs-color-good';
  if (score >= 40) return 'rs-color-fair';
  return 'rs-color-poor';
}

function getScoreBgClass(score) {
  if (score >= 80) return 'rs-bg-excellent';
  if (score >= 60) return 'rs-bg-good';
  if (score >= 40) return 'rs-bg-fair';
  return 'rs-bg-poor';
}

function getScoreLabel(score) {
  if (score >= 90) return _t('autoAssign.scoreExcellent');
  if (score >= 75) return _t('autoAssign.scoreGood');
  if (score >= 60) return _t('autoAssign.scoreAverage');
  if (score >= 40) return _t('autoAssign.scoreFair');
  return _t('autoAssign.scorePoor');
}

function getTypeIcon(type) {
  const icons = {
    drums: '\uD83E\uDD41', bass: '\uD83C\uDFB8', melody: '\uD83C\uDFB9',
    harmony: '\uD83C\uDFB5', pad: '\uD83C\uDFB6', strings: '\uD83C\uDFBB',
    brass: '\uD83C\uDFBA', piano: '\uD83C\uDFB9', organ: '\uD83C\uDFB9',
    guitar: '\uD83C\uDFB8', reed: '\uD83C\uDFB7', pipe: '\uD83E\uDE88',
    ensemble: '\uD83C\uDFB5', synth_lead: '\uD83C\uDFB9', synth_pad: '\uD83C\uDFB6'
  };
  return icons[type] || '\uD83C\uDFB5';
}

function getGmProgramName(program) {
  if (program == null || program < 0 || program > 127) return null;
  if (typeof getGMInstrumentName === 'function') return getGMInstrumentName(program);
  if (typeof GM_INSTRUMENTS !== 'undefined' && GM_INSTRUMENTS[program]) return GM_INSTRUMENTS[program];
  return `Program ${program}`;
}

const NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiNoteToName(note) {
  return NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
}

// ============================================================================
// RoutingSummaryPage class
// ============================================================================

class RoutingSummaryPage {
  constructor(apiClient) {
    this.api = apiClient;
    this.fileId = null;
    this.filename = null;
    this.channels = [];
    this.modal = null;
    this._escHandler = null;

    // Auto-assign data
    this.suggestions = {};
    this.lowScoreSuggestions = {};
    this.autoSelection = {};
    this.selectedAssignments = {};
    this.channelAnalyses = {};
    this.skippedChannels = new Set();
    this.autoSkippedChannels = new Set();
    this.splitProposals = {};
    this.splitChannels = new Set();
    this.splitAssignments = {};
    this.allInstruments = [];
    this.confidenceScore = 0;

    // UI state
    this.selectedChannel = null; // Channel selected for detail view
    this.onApplyCallback = null;
    this.loading = true;
  }

  /**
   * Open the routing summary page for a file
   * @param {number} fileId
   * @param {string} filename
   * @param {Array} channels - Parsed channel list from MIDI file
   * @param {Function} [onApply] - Called when routing is applied
   */
  async show(fileId, filename, channels, onApply) {
    this.fileId = fileId;
    this.filename = filename;
    this.channels = channels;
    this.onApplyCallback = onApply || null;
    this.loading = true;

    this._renderModal();
    this._showLoading();

    try {
      // Check if virtual instruments are enabled
      let excludeVirtual = true;
      try {
        const saved = localStorage.getItem('maestro_settings');
        if (saved && JSON.parse(saved).virtualInstrument) excludeVirtual = false;
      } catch (e) { /* ignore */ }

      // Generate auto-assignment suggestions
      const response = await this.api.sendCommand('generate_assignment_suggestions', {
        fileId: fileId,
        topN: 5,
        minScore: 30,
        excludeVirtual: excludeVirtual,
        includeMatrix: false
      });

      if (!response.success) {
        this._showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      // Store results
      this.suggestions = response.suggestions || {};
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection || {};
      this.confidenceScore = response.confidenceScore || 0;
      this.splitProposals = response.splitProposals || {};
      this.allInstruments = response.allInstruments || [];

      if (response.channelAnalyses) {
        for (const analysis of response.channelAnalyses) {
          this.channelAnalyses[analysis.channel] = analysis;
        }
      }

      // Initialize assignments from auto-selection
      const autoSkippedChannels = this.autoSelection._autoSkipped || [];
      delete this.autoSelection._autoSkipped;
      this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
      this.skippedChannels = new Set(autoSkippedChannels);
      this.autoSkippedChannels = new Set(autoSkippedChannels);

      // Enrich assignments with instrument capabilities
      for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
        if (!assignment || !assignment.instrumentId) continue;
        const options = this.suggestions[ch] || [];
        const lowOptions = this.lowScoreSuggestions[ch] || [];
        const matched = options.find(o => o.instrument.id === assignment.instrumentId)
          || lowOptions.find(o => o.instrument.id === assignment.instrumentId);
        if (matched) {
          assignment.gmProgram = matched.instrument.gm_program;
          assignment.noteRangeMin = matched.instrument.note_range_min;
          assignment.noteRangeMax = matched.instrument.note_range_max;
          assignment.noteSelectionMode = matched.instrument.note_selection_mode;
          assignment.polyphony = matched.instrument.polyphony;
        }
      }

      this.loading = false;
      this._renderContent();

    } catch (error) {
      this._showError(error.message || _t('autoAssign.generateFailed'));
    }
  }

  // ============================================================================
  // Modal rendering
  // ============================================================================

  _renderModal() {
    if (this.modal) this.modal.remove();
    if (this._escHandler) document.removeEventListener('keydown', this._escHandler);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay rs-modal';
    overlay.id = 'routingSummaryModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', _t('routingSummary.title'));
    document.body.appendChild(overlay);
    this.modal = overlay;

    // Prevent body scrolling
    this._prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // ESC to close
    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    // Click overlay to close
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
  }

  _showLoading() {
    this.modal.innerHTML = `
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
    this.modal.querySelector('#rsSummaryClose').addEventListener('click', () => this.close());
  }

  _showError(message) {
    this.modal.innerHTML = `
      <div class="rs-container">
        <div class="rs-header">
          <h2>${_t('autoAssign.error')}</h2>
          <button class="modal-close" id="rsSummaryClose">&times;</button>
        </div>
        <div class="rs-body rs-error">
          <p>${escapeHtml(message)}</p>
          <button class="btn" id="rsSummaryCloseBtn">${_t('common.close')}</button>
        </div>
      </div>
    `;
    this.modal.querySelector('#rsSummaryClose').addEventListener('click', () => this.close());
    this.modal.querySelector('#rsSummaryCloseBtn').addEventListener('click', () => this.close());
  }

  _renderContent() {
    const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    const activeCount = channelKeys.length - this.skippedChannels.size;

    this.modal.innerHTML = `
      <div class="rs-container ${this.selectedChannel !== null ? 'rs-with-detail' : ''}">
        <div class="rs-header">
          <div class="rs-header-left">
            <h2>${_t('routingSummary.title')}</h2>
            <span class="rs-filename">${escapeHtml(this.filename)}</span>
          </div>
          <div class="rs-header-center">
            <span class="rs-confidence ${getScoreClass(this.confidenceScore)}">
              ${this.confidenceScore}/100 — ${getScoreLabel(this.confidenceScore)}
            </span>
            <span class="rs-channel-count">
              ${_t('autoAssign.channelsWillBeAssigned', { active: activeCount, total: channelKeys.length })}
            </span>
          </div>
          <button class="modal-close" id="rsSummaryClose">&times;</button>
        </div>

        <div class="rs-layout">
          <div class="rs-summary-panel" id="rsSummaryPanel">
            ${this._renderSummaryTable(channelKeys)}
          </div>
          <div class="rs-detail-panel" id="rsDetailPanel">
            ${this.selectedChannel !== null ? this._renderDetailPanel(this.selectedChannel) : this._renderDetailPlaceholder()}
          </div>
        </div>

        <div class="rs-footer">
          <button class="btn" id="rsSummaryCancel">${_t('common.cancel')}</button>
          <div class="rs-footer-center">
            ${this._renderSplitBanner(channelKeys)}
          </div>
          <div class="rs-footer-right">
            <button class="btn" id="rsSummaryAdvanced" title="${_t('routingSummary.openAdvanced')}">
              ${_t('routingSummary.openAdvanced')}
            </button>
            <button class="btn btn-primary" id="rsSummaryApply">
              ${_t('routingSummary.applyAll')}
            </button>
          </div>
        </div>
      </div>
    `;

    this._bindEvents(channelKeys);
  }

  // ============================================================================
  // Summary table (left panel)
  // ============================================================================

  _renderSummaryTable(channelKeys) {
    const rows = channelKeys.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = this.skippedChannels.has(channel);
      const isSplit = this.splitChannels.has(channel);
      const assignment = this.selectedAssignments[ch];
      const score = isSplit ? (this.splitAssignments[channel]?.quality || 0) : (assignment?.score || 0);
      const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;

      // Original MIDI instrument
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (getGmProgramName(analysis?.primaryProgram) || '\u2014');

      // Assigned instrument(s)
      let assignedName;
      if (isSplit && this.splitAssignments[channel]) {
        const segments = this.splitAssignments[channel].segments || [];
        assignedName = segments.map(seg => seg.instrumentName || 'Instrument').join(' + ');
      } else {
        assignedName = assignment?.customName || assignment?.instrumentName || '\u2014';
      }

      // Status
      const hasSplitProposal = !!this.splitProposals[channel];
      let statusIcon, statusClass, statusLabel;
      if (isSkipped) {
        statusIcon = '\u2014';
        statusClass = 'skipped';
        statusLabel = _t('autoAssign.overviewStatusSkipped');
      } else if (isSplit) {
        statusIcon = '&#8645;';
        statusClass = 'ok';
        statusLabel = _t('autoAssign.splitProposed');
      } else if (score >= 70) {
        statusIcon = '&#10003;';
        statusClass = 'ok';
        statusLabel = _t('autoAssign.overviewStatusOk');
      } else {
        statusIcon = '!';
        statusClass = 'warning';
        statusLabel = _t('autoAssign.overviewStatusWarning');
      }

      const splitBadge = (hasSplitProposal && !isSplit && !isSkipped)
        ? '<span class="rs-split-badge" title="' + _t('autoAssign.splitProposed') + '">SP</span>'
        : (isSplit ? '<span class="rs-split-badge active">SP</span>' : '');

      const typeIcon = analysis?.estimatedType ? getTypeIcon(analysis.estimatedType) : '';
      const isSelected = this.selectedChannel === channel;

      // Note range mini-viz
      const rangeViz = this._renderMiniRange(channel, analysis, assignment);

      return `
        <tr class="rs-row ${isSkipped ? 'skipped' : ''} ${statusClass} ${isSelected ? 'selected' : ''}"
            tabindex="0" role="button" data-channel="${channel}"
            aria-label="${_t('autoAssign.channel')} ${channel + 1}">
          <td class="rs-col-ch">
            ${typeIcon} Ch ${channel + 1}${channel === 9 ? ' <span class="rs-drum-badge">DR</span>' : ''} ${splitBadge}
          </td>
          <td class="rs-col-original">${escapeHtml(gmName)}</td>
          <td class="rs-col-assigned">${isSkipped ? '<span class="rs-skipped">' + statusLabel + '</span>' : escapeHtml(assignedName)}</td>
          <td class="rs-col-range">${rangeViz}</td>
          <td class="rs-col-score">
            ${isSkipped ? '\u2014' : `
              <div class="rs-score-bar">
                <div class="rs-score-fill ${getScoreBgClass(score)}" style="width: ${score}%"></div>
              </div>
              <span class="${getScoreClass(score)}">${score}</span>
            `}
          </td>
          <td class="rs-col-status">
            <span class="rs-status-icon ${statusClass}">${statusIcon}</span>
          </td>
          <td class="rs-col-actions">
            ${!isSkipped ? `<button class="btn btn-sm rs-btn-skip" data-channel="${channel}" title="${_t('routingSummary.skip')}">&times;</button>` : `<button class="btn btn-sm rs-btn-unskip" data-channel="${channel}" title="${_t('routingSummary.unskip')}">+</button>`}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="rs-table-wrapper">
        <table class="rs-table">
          <thead>
            <tr>
              <th>${_t('autoAssign.overviewChannel')}</th>
              <th>${_t('autoAssign.overviewOriginal')}</th>
              <th>${_t('autoAssign.overviewAssigned')}</th>
              <th>${_t('routingSummary.noteRange')}</th>
              <th>${_t('autoAssign.overviewScore')}</th>
              <th>${_t('autoAssign.overviewStatus')}</th>
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

  /**
   * Mini note range visualization bar for summary table
   */
  _renderMiniRange(channel, analysis, assignment) {
    if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';

    const chMin = analysis.noteRange.min;
    const chMax = analysis.noteRange.max;
    // Normalize to 0-127 range for display
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

  // ============================================================================
  // Split banner
  // ============================================================================

  _renderSplitBanner(channelKeys) {
    const pendingSplits = Object.keys(this.splitProposals)
      .map(Number)
      .filter(ch => !this.splitChannels.has(ch));

    if (pendingSplits.length === 0) return '';

    return `
      <span class="rs-split-info">
        &#8645; ${_t('autoAssign.splitAvailableBanner', { count: pendingSplits.length })}
      </span>
      <button class="btn btn-sm" id="rsAcceptAllSplits">
        ${_t('autoAssign.acceptAllSplits')}
      </button>
    `;
  }

  // ============================================================================
  // Detail panel (right side)
  // ============================================================================

  _renderDetailPlaceholder() {
    return `
      <div class="rs-detail-placeholder">
        <p>${_t('routingSummary.selectChannelHint')}</p>
      </div>
    `;
  }

  _renderDetailPanel(channel) {
    const ch = String(channel);
    const isSkipped = this.skippedChannels.has(channel);
    const assignment = this.selectedAssignments[ch];
    const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;
    const options = this.suggestions[ch] || [];
    const lowOptions = this.lowScoreSuggestions[ch] || [];
    const hasSplitProposal = !!this.splitProposals[channel];
    const isSplit = this.splitChannels.has(channel);

    // Channel info section
    const gmName = channel === 9 ? _t('autoAssign.drums') : (getGmProgramName(analysis?.primaryProgram) || '\u2014');
    const typeIcon = analysis?.estimatedType ? getTypeIcon(analysis.estimatedType) : '';
    const noteRangeStr = analysis?.noteRange?.min != null
      ? `${midiNoteToName(analysis.noteRange.min)} - ${midiNoteToName(analysis.noteRange.max)}`
      : 'N/A';
    const polyStr = analysis?.polyphony?.max != null ? `${analysis.polyphony.max}` : 'N/A';

    // Instrument list
    const instrumentRows = options.map(opt => {
      const inst = opt.instrument;
      const compat = opt.compatibility;
      const isSelected = assignment?.instrumentId === inst.id;
      return `
        <div class="rs-instrument-option ${isSelected ? 'selected' : ''}" data-instrument-id="${inst.id}" data-channel="${channel}">
          <div class="rs-inst-name">${escapeHtml(inst.custom_name || inst.name)}</div>
          <div class="rs-inst-score">
            <div class="rs-score-bar-sm">
              <div class="rs-score-fill ${getScoreBgClass(compat.score)}" style="width: ${compat.score}%"></div>
            </div>
            <span class="${getScoreClass(compat.score)}">${compat.score}</span>
          </div>
          ${compat.transposition?.semitones ? `<span class="rs-inst-trans" title="${_t('autoAssign.transposition')}">${compat.transposition.semitones > 0 ? '+' : ''}${compat.transposition.semitones}st</span>` : ''}
          ${compat.issues?.length ? `<span class="rs-inst-issues" title="${compat.issues.map(i => i.message).join(', ')}">!</span>` : ''}
        </div>
      `;
    }).join('');

    // Split section
    let splitHTML = '';
    if (hasSplitProposal && !isSplit) {
      const proposal = this.splitProposals[channel];
      const segments = proposal.segments || [];
      splitHTML = `
        <div class="rs-split-section">
          <h4>${_t('autoAssign.splitProposed')} (${proposal.type}, ${_t('routingSummary.quality')}: ${proposal.quality})</h4>
          <div class="rs-split-segments">
            ${segments.map((seg, i) => `
              <div class="rs-split-segment">
                <span class="rs-seg-name">${escapeHtml(seg.instrumentName || 'Instrument ' + (i + 1))}</span>
                <span class="rs-seg-range">${seg.noteRange ? midiNoteToName(seg.noteRange.min) + '-' + midiNoteToName(seg.noteRange.max) : ''}</span>
              </div>
            `).join('')}
          </div>
          <button class="btn btn-sm rs-btn-accept-split" data-channel="${channel}">
            ${_t('autoAssign.acceptSplit')}
          </button>
        </div>
      `;
    } else if (isSplit && this.splitAssignments[channel]) {
      const accepted = this.splitAssignments[channel];
      splitHTML = `
        <div class="rs-split-section active">
          <h4>${_t('autoAssign.splitProposed')} (${_t('routingSummary.accepted')})</h4>
          <div class="rs-split-segments">
            ${(accepted.segments || []).map((seg, i) => `
              <div class="rs-split-segment">
                <span class="rs-seg-name">${escapeHtml(seg.instrumentName || 'Instrument ' + (i + 1))}</span>
                <span class="rs-seg-range">${seg.noteRange ? midiNoteToName(seg.noteRange.min) + '-' + midiNoteToName(seg.noteRange.max) : ''}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `
      <div class="rs-detail-content">
        <div class="rs-detail-header">
          <h3>${typeIcon} ${_t('autoAssign.channel')} ${channel + 1}${channel === 9 ? ' (Drums)' : ''}</h3>
          <span class="rs-detail-gm">${escapeHtml(gmName)}</span>
          <button class="btn btn-sm rs-detail-close" id="rsDetailClose">&times;</button>
        </div>

        <div class="rs-detail-stats">
          <div class="rs-stat">
            <span class="rs-stat-label">${_t('autoAssign.noteRange')}</span>
            <span class="rs-stat-value">${noteRangeStr}</span>
          </div>
          <div class="rs-stat">
            <span class="rs-stat-label">${_t('autoAssign.polyphony')}</span>
            <span class="rs-stat-value">${polyStr}</span>
          </div>
          <div class="rs-stat">
            <span class="rs-stat-label">${_t('autoAssign.type')}</span>
            <span class="rs-stat-value">${analysis?.estimatedType || 'N/A'}</span>
          </div>
        </div>

        <div class="rs-detail-instruments">
          <h4>${_t('routingSummary.compatibleInstruments')} (${options.length})</h4>
          ${instrumentRows || `<p class="rs-no-instruments">${_t('autoAssign.noCompatible')}</p>`}
        </div>

        ${splitHTML}
      </div>
    `;
  }

  // ============================================================================
  // Event binding
  // ============================================================================

  _bindEvents(channelKeys) {
    const modal = this.modal;

    // Close button
    modal.querySelector('#rsSummaryClose').addEventListener('click', () => this.close());
    modal.querySelector('#rsSummaryCancel').addEventListener('click', () => this.close());

    // Apply button
    modal.querySelector('#rsSummaryApply').addEventListener('click', () => this._applyRouting());

    // Advanced button — open full AutoAssignModal
    const advBtn = modal.querySelector('#rsSummaryAdvanced');
    if (advBtn) {
      advBtn.addEventListener('click', () => this._openAdvancedModal());
    }

    // Accept all splits
    const splitBtn = modal.querySelector('#rsAcceptAllSplits');
    if (splitBtn) {
      splitBtn.addEventListener('click', () => this._acceptAllSplits(channelKeys));
    }

    // Row clicks — select channel for detail
    modal.querySelectorAll('.rs-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger on button clicks
        if (e.target.closest('.rs-btn-skip, .rs-btn-unskip')) return;
        const ch = parseInt(row.dataset.channel);
        this._selectChannel(ch);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const ch = parseInt(row.dataset.channel);
          this._selectChannel(ch);
        }
      });
    });

    // Skip/Unskip buttons
    modal.querySelectorAll('.rs-btn-skip').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this.skippedChannels.add(ch);
        this._refreshUI(channelKeys);
      });
    });
    modal.querySelectorAll('.rs-btn-unskip').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this.skippedChannels.delete(ch);
        this._refreshUI(channelKeys);
      });
    });

    // Detail panel events
    this._bindDetailEvents(channelKeys);
  }

  _bindDetailEvents(channelKeys) {
    const modal = this.modal;

    // Close detail
    const closeBtn = modal.querySelector('#rsDetailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.selectedChannel = null;
        this._refreshUI(channelKeys);
      });
    }

    // Instrument selection
    modal.querySelectorAll('.rs-instrument-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const instId = parseInt(opt.dataset.instrumentId);
        const ch = opt.dataset.channel;
        this._selectInstrument(ch, instId, channelKeys);
      });
    });

    // Accept split button
    modal.querySelectorAll('.rs-btn-accept-split').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this._acceptSplit(ch, channelKeys);
      });
    });
  }

  // ============================================================================
  // Actions
  // ============================================================================

  _selectChannel(channel) {
    this.selectedChannel = channel;
    const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    this._refreshUI(channelKeys);
  }

  _selectInstrument(ch, instrumentId, channelKeys) {
    const options = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selected = options.find(o => o.instrument.id === instrumentId);
    if (!selected) return;

    this.selectedAssignments[ch] = {
      deviceId: selected.instrument.device_id,
      instrumentId: selected.instrument.id,
      instrumentChannel: selected.instrument.channel,
      instrumentName: selected.instrument.name,
      customName: selected.instrument.custom_name,
      score: selected.compatibility.score,
      transposition: selected.compatibility.transposition,
      noteRemapping: selected.compatibility.noteRemapping,
      issues: selected.compatibility.issues,
      info: selected.compatibility.info,
      gmProgram: selected.instrument.gm_program,
      noteRangeMin: selected.instrument.note_range_min,
      noteRangeMax: selected.instrument.note_range_max,
      noteSelectionMode: selected.instrument.note_selection_mode,
      polyphony: selected.instrument.polyphony,
      channelAnalysis: this.channelAnalyses[parseInt(ch)] || null
    };

    this.skippedChannels.delete(parseInt(ch));
    this._refreshUI(channelKeys);
  }

  _acceptSplit(channel, channelKeys) {
    const proposal = this.splitProposals[channel];
    if (!proposal) return;
    this.splitChannels.add(channel);
    this.splitAssignments[channel] = proposal;
    this._refreshUI(channelKeys);
  }

  _acceptAllSplits(channelKeys) {
    for (const [ch, proposal] of Object.entries(this.splitProposals)) {
      const channel = parseInt(ch);
      if (!this.splitChannels.has(channel)) {
        this.splitChannels.add(channel);
        this.splitAssignments[channel] = proposal;
      }
    }
    this._refreshUI(channelKeys);
  }

  _refreshUI(channelKeys) {
    // Re-render the content area (preserving modal shell)
    this._renderContent();
  }

  /**
   * Open the full AutoAssignModal for advanced per-channel editing
   */
  _openAdvancedModal() {
    if (!window.AutoAssignModal) {
      console.error('AutoAssignModal not available');
      return;
    }
    const autoModal = new window.AutoAssignModal(this.api, null);
    autoModal.show(this.fileId, (result) => {
      this.close();
      if (this.onApplyCallback) this.onApplyCallback(result);
    });
  }

  /**
   * Apply the current routing assignments
   */
  async _applyRouting() {
    const routing = {};
    let hasRouting = false;

    for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
      if (this.skippedChannels.has(parseInt(ch))) continue;
      if (!assignment || !assignment.deviceId) continue;

      const targetChannel = assignment.instrumentChannel;
      routing[ch] = targetChannel !== undefined && targetChannel !== null
        ? `${assignment.deviceId}::${targetChannel}`
        : assignment.deviceId;
      hasRouting = true;
    }

    // Also include split assignments
    for (const [ch, splitData] of Object.entries(this.splitAssignments)) {
      if (!this.splitChannels.has(parseInt(ch))) continue;
      // For splits, route to the first segment's instrument (primary)
      const firstSeg = splitData.segments?.[0];
      if (firstSeg) {
        routing[ch] = firstSeg.instrumentChannel !== undefined
          ? `${firstSeg.deviceId}::${firstSeg.instrumentChannel}`
          : firstSeg.deviceId;
        hasRouting = true;
      }
    }

    if (!hasRouting) {
      return;
    }

    try {
      // Save routing to database
      await this.api.sendCommand('file_routing_sync', {
        fileId: this.fileId,
        channels: routing
      });

      // Also save to localStorage as backup
      if (typeof fileRoutingConfig !== 'undefined') {
        fileRoutingConfig[this.fileId] = {
          channels: routing,
          configured: true,
          lastModified: Date.now()
        };
        if (typeof saveRoutingConfig === 'function') saveRoutingConfig();
      }

      // Notify other components
      if (window.eventBus) {
        window.eventBus.emit('routing:changed', { fileId: this.fileId, channels: routing });
      }

      // Refresh file list
      if (window.midiFileManager) {
        window.midiFileManager.refreshFileList();
      }

      if (this.onApplyCallback) {
        this.onApplyCallback({ fileId: this.fileId, routing });
      }

      this.close();

    } catch (error) {
      console.error('[RoutingSummary] Apply failed:', error);
    }
  }

  // ============================================================================
  // Close / cleanup
  // ============================================================================

  close() {
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    document.body.style.overflow = this._prevBodyOverflow || '';
  }
}

window.RoutingSummaryPage = RoutingSummaryPage;
})();
