// public/js/views/components/auto-assign/RoutingSummaryPage.js
// RoutingSummaryPage — Page résumé du routage automatique avec layout deux panneaux
(function() {
const MAX_INST_NAME = 18;
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

function getTypeColor(type) {
  const colors = {
    drums: '#E91E63', bass: '#9C27B0', melody: '#2196F3',
    harmony: '#4CAF50', pad: '#00BCD4', strings: '#FF9800',
    brass: '#F44336', piano: '#3F51B5', organ: '#795548',
    guitar: '#FF5722', reed: '#009688', pipe: '#607D8B',
    ensemble: '#8BC34A', synth_lead: '#673AB7', synth_pad: '#00BCD4'
  };
  return colors[type] || '#607D8B';
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

/**
 * Render a split visualization bar showing how instruments divide the note range
 */
function renderSplitBar(splitData, channelAnalysis) {
  if (!splitData || !splitData.segments || splitData.segments.length === 0) return '';
  if (!channelAnalysis?.noteRange?.min) return '';

  const chMin = channelAnalysis.noteRange.min;
  const chMax = channelAnalysis.noteRange.max;
  const span = chMax - chMin || 1;
  const colors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];

  const segBars = splitData.segments.map((seg, i) => {
    if (!seg.noteRange) return '';
    const left = Math.round(((seg.noteRange.min - chMin) / span) * 100);
    const width = Math.max(3, Math.round(((seg.noteRange.max - seg.noteRange.min) / span) * 100));
    const color = colors[i % colors.length];
    return `<div class="rs-split-seg-bar" style="left:${left}%;width:${width}%;background:${color}" title="${seg.instrumentName || ''}: ${midiNoteToName(seg.noteRange.min)}-${midiNoteToName(seg.noteRange.max)}"></div>`;
  }).join('');

  return `<div class="rs-split-viz">${segBars}</div>`;
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
    this.activeSplitMode = {}; // { [channel]: 'range'|'polyphony'|'mixed' }
    this.splitExpanded = {}; // { [channel]: boolean } — collapsible split UI
    this.splitEdited = {}; // { [channel]: boolean } — user edited proposal segments (locks mode tabs)
    this.allInstruments = [];
    this.confidenceScore = 0;

    // UI state
    this.selectedChannel = null; // Channel selected for detail view
    this.onApplyCallback = null;
    this.loading = true;
    this.adaptationSettings = {}; // Per-channel adaptation overrides
    this.showLowScores = {}; // Per-channel toggle for low score instruments
    this.autoAdaptation = true; // Toggle for automatic MIDI channel adaptation

    // Preview state
    this.midiData = null;
    this.audioPreview = null;
    this._previewState = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this._previewMode = null; // 'all' | 'channel' | 'original'
    this._previewingChannel = null;
    this._minimapCanvas = null;
    this._minimapBuckets = null;
    this._minimapBucketsOOR = null;
    this._minimapMaxVal = 0;
    this._minimapWidth = 0;
    this._minimapHeight = 0;
    this._minimapTotalTicks = 0;
    this._minimapInstRange = null;

    // Scoring overrides (loaded from localStorage, sent to API)
    this.scoringOverrides = this._loadScoringOverrides();
  }

  // ============================================================================
  // Scoring overrides defaults & persistence
  // ============================================================================

  _getDefaultOverrides() {
    // Must match ScoringSettingsModal.getDefaults() structure
    return ScoringSettingsModal
      ? ScoringSettingsModal.getDefaults()
      : {
        weights: { noteRange: 40, programMatch: 22, instrumentType: 20, polyphony: 13, ccSupport: 5 },
        scoreThresholds: { acceptable: 60, minimum: 30 },
        penalties: { transpositionPerOctave: 3, maxTranspositionOctaves: 3 },
        bonuses: { sameCategoryMatch: 15, sameFamilyMatch: 12, exactTypeMatch: 20 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 50, instrumentType: 30, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { minQuality: 50, maxInstruments: 4, triggerBelowScore: 60 }
      };
  }

  _loadScoringOverrides() {
    try {
      const saved = JSON.parse(localStorage.getItem('maestro_settings') || '{}');
      if (saved.scoringConfig) return saved.scoringConfig;
    } catch (e) { /* ignore */ }
    return this._getDefaultOverrides();
  }

  _saveScoringOverrides() {
    try {
      const settings = JSON.parse(localStorage.getItem('maestro_settings') || '{}');
      settings.scoringConfig = this.scoringOverrides;
      localStorage.setItem('maestro_settings', JSON.stringify(settings));
    } catch (e) { console.warn('[RoutingSummary] Failed to save scoring config:', e); }
  }

  _isOverrideModified() {
    const defaults = this._getDefaultOverrides();
    // Ignore _preset key (UI-only, not a scoring parameter)
    const clean = (obj) => { const c = { ...obj }; delete c._preset; return c; };
    return JSON.stringify(clean(this.scoringOverrides)) !== JSON.stringify(clean(defaults));
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

      // Initialize adaptation settings per channel
      const channelKeys = Object.keys(this.suggestions);
      for (const ch of channelKeys) {
        const assignment = this.selectedAssignments[ch];
        this.adaptationSettings[ch] = {
          pitchShift: assignment?.transposition?.semitones ? 'auto' : 'none',
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          oorHandling: 'passThrough'
        };
      }

      // Load MIDI data for preview minimap
      try {
        const fileResponse = await this.api.sendCommand('file_read', { fileId });
        if (fileResponse?.midiData) {
          const raw = fileResponse.midiData;
          this.midiData = (raw.midi && raw.midi.tracks)
            ? { ...raw.midi, tempo: raw.tempo || raw.midi.tempo, duration: raw.duration || undefined }
            : raw;
        }
      } catch (e) { console.warn('[RoutingSummary] Could not load MIDI data for preview:', e.message); }

      // Initialize audio preview
      if (!this.audioPreview && window.AudioPreview) {
        this.audioPreview = new window.AudioPreview(this.api);
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
          <div class="rs-header-row">
            <div class="rs-header-left">
              ${this.midiData ? this._renderHeaderButtons() : `<h2>${_t('routingSummary.title')}</h2>`}
            </div>
            <div class="rs-header-center">
              <span class="rs-confidence ${getScoreClass(this.confidenceScore)}">
                ${this.confidenceScore}/100 — ${getScoreLabel(this.confidenceScore)}
              </span>
              <button class="rs-adapt-toggle ${this.autoAdaptation ? 'active' : ''}" id="rsAutoAdaptToggle" title="${_t('routingSummary.autoAdaptation') || 'Adaptation automatique canal MIDI'}">
                ${this.autoAdaptation ? '&#9889; Auto' : '&#9889; Manuel'}
              </button>
              <span class="rs-channel-count">
                ${_t('autoAssign.channelsWillBeAssigned', { active: activeCount, total: channelKeys.length })}
              </span>
            </div>
            <div class="rs-header-right">
              <button class="rs-settings-btn ${this._isOverrideModified() ? 'modified' : ''}" id="rsSettingsBtn" title="${_t('routingSummary.settings')}">&#9881;</button>
              <button class="modal-close" id="rsSummaryClose">&times;</button>
            </div>
          </div>
          ${this.midiData ? '<div class="rs-header-minimap" id="rsMinimapContainer"></div>' : ''}
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
          <div class="rs-footer-center"></div>
          <div class="rs-footer-right">
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
  // Helpers
  // ============================================================================

  /**
   * Get display name for an instrument. Prefers custom_name, then GM program name, then device name.
   */
  _getInstrumentDisplayName(inst) {
    if (!inst) return '?';
    if (inst.custom_name) return inst.custom_name;
    const gmName = getGmProgramName(inst.gm_program ?? inst.gmProgram ?? null);
    if (gmName) return gmName;
    return inst.name || '?';
  }

  /**
   * Compute playable notes ratio for a channel's assignment.
   * @returns {{ playable: number, total: number } | null}
   */
  _computePlayableNotes(ch) {
    const assignment = this.selectedAssignments[String(ch)];
    const analysis = this.channelAnalyses[parseInt(ch)] || assignment?.channelAnalysis;
    if (!assignment || !analysis?.noteDistribution) return null;

    const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
    const totalNotes = usedNotes.length;
    if (totalNotes === 0) return null;

    const instMin = assignment.noteRangeMin ?? 0;
    const instMax = assignment.noteRangeMax ?? 127;
    const adapt = this.adaptationSettings[String(ch)] || {};
    const semi = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
    const playable = usedNotes.filter(n => {
      const shifted = n + semi;
      return shifted >= instMin && shifted <= instMax;
    }).length;
    return { playable, total: totalNotes };
  }

  /**
   * Build <option> list for instrument dropdown in summary table.
   */
  _buildInstrumentOptions(ch, assignment, isSkipped) {
    const options = this.suggestions[String(ch)] || [];
    const lowOptions = this.lowScoreSuggestions[String(ch)] || [];
    const allOptions = [...options, ...lowOptions];
    const currentId = assignment?.instrumentId || '';

    if (allOptions.length === 0) {
      return `<option value="">\u2014</option>`;
    }

    let html = '';
    for (const opt of allOptions) {
      const inst = opt.instrument;
      const score = opt.compatibility?.score || 0;
      const name = this._getInstrumentDisplayName(inst);
      const displayName = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;
      const selected = inst.id === currentId ? 'selected' : '';
      html += `<option value="${inst.id}" ${selected}>${escapeHtml(displayName)} (${score})</option>`;
    }
    return html;
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

      // Status class
      let statusClass;
      if (isSkipped) {
        statusClass = 'skipped';
      } else if (isSplit || score >= 70) {
        statusClass = 'ok';
      } else {
        statusClass = 'warning';
      }

      const typeIcon = analysis?.estimatedType ? getTypeIcon(analysis.estimatedType) : '';
      const isSelected = this.selectedChannel === channel;

      // Score dot indicator
      const scoreDotClass = isSkipped ? 'rs-dot-skip' : (score >= 70 ? 'rs-dot-ok' : score >= 40 ? 'rs-dot-warn' : 'rs-dot-poor');

      // Assigned column: dropdown for single instrument, text for split
      let assignedHTML;
      if (isSkipped) {
        assignedHTML = `<span class="rs-skipped">${_t('autoAssign.overviewStatusSkipped')}</span>`;
      } else if (isSplit && this.splitAssignments[channel]) {
        // Show split instrument names with separator spans
        const segments = this.splitAssignments[channel].segments || [];
        const splitParts = segments.map((seg, i) => {
          const color = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'][i % 4];
          const name = seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument';
          const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
          return `<span class="rs-split-inst-name" style="color:${color}" title="${escapeHtml(name)}">${escapeHtml(displayName)}</span>`;
        });
        assignedHTML = `<div class="rs-split-instruments">${splitParts.join('<span class="rs-split-sep">+</span>')}</div>`;
      } else {
        // Dropdown for single instrument selection
        assignedHTML = `<select class="rs-instrument-select" data-channel="${ch}">${this._buildInstrumentOptions(ch, assignment, isSkipped)}</select>`;
      }

      // Score + playable notes
      let scoreHTML = '';
      if (!isSkipped) {
        const playableInfo = this._computePlayableNotes(ch);
        const playableText = playableInfo ? `<span class="rs-playable-count">${playableInfo.playable}/${playableInfo.total}</span>` : '';
        scoreHTML = `<span class="rs-score-value ${getScoreClass(score)}">${score}</span>${playableText}`;
      }

      return `
        <tr class="rs-row ${isSkipped ? 'skipped' : ''} ${statusClass} ${isSelected ? 'selected' : ''}"
            tabindex="0" role="button" data-channel="${channel}"
            aria-label="${_t('autoAssign.channel')} ${channel + 1}">
          <td class="rs-col-ch">
            <span class="rs-score-dot ${scoreDotClass}"></span>
            ${typeIcon} Ch ${channel + 1}${channel === 9 ? ' <span class="rs-drum-badge">DR</span>' : ''}
          </td>
          <td class="rs-col-original">${escapeHtml(gmName)}</td>
          <td class="rs-col-assigned">${assignedHTML}</td>
          <td class="rs-col-score">${scoreHTML}</td>
          <td class="rs-col-actions">
            <button class="btn btn-sm rs-btn-intelligent" data-channel="${channel}" title="${_t('routingSummary.openIntelligent') || 'Routage intelligent'}">&#9881;</button>
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
              <th>${_t('routingSummary.score') || 'Score'}</th>
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
    const isDrumChannel = channel === 9 || analysis?.estimatedType === 'drums';
    const adaptation = this.adaptationSettings[ch] || {};

    // Channel info
    const gmName = channel === 9 ? _t('autoAssign.drums') : (getGmProgramName(analysis?.primaryProgram) || '\u2014');
    const typeIcon = analysis?.estimatedType ? getTypeIcon(analysis.estimatedType) : '';
    const score = assignment?.score || 0;
    const assignedName = assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || null;

    // Compute playable notes ratio
    const playableData = this._computePlayableNotes(ch);
    const playableInfo = playableData ? `(${playableData.playable}/${playableData.total})` : '';

    // Adaptation controls (pitch shift + OOR handling)
    let adaptHTML = '';
    if (!isSkipped && assignment?.instrumentId && !isDrumChannel) {
      const pitchShift = adaptation.pitchShift || 'none';
      const semitones = adaptation.transpositionSemitones || 0;
      const oorHandling = adaptation.oorHandling || 'passThrough';

      // Show transposition info for auto mode
      const autoInfo = (pitchShift === 'auto' && semitones !== 0)
        ? ` <span class="rs-adapt-auto-info">(${semitones > 0 ? '+' : ''}${semitones}st)</span>`
        : '';

      adaptHTML = `
        <div class="rs-adaptation">
          <h4>${_t('autoAssign.adaptationTitle')}</h4>
          <div class="rs-adapt-row">
            <span class="rs-adapt-label">${_t('autoAssign.pitchShiftTitle')}</span>
            <div class="rs-adapt-options">
              <label class="rs-adapt-radio ${pitchShift === 'none' ? 'selected' : ''}">
                <input type="radio" name="rs_pitch_${channel}" value="none" ${pitchShift === 'none' ? 'checked' : ''} data-channel="${channel}" data-field="pitchShift">
                ${_t('autoAssign.pitchNone')}
              </label>
              <label class="rs-adapt-radio ${pitchShift === 'auto' ? 'selected' : ''}">
                <input type="radio" name="rs_pitch_${channel}" value="auto" ${pitchShift === 'auto' ? 'checked' : ''} data-channel="${channel}" data-field="pitchShift">
                ${_t('autoAssign.pitchAuto')}${autoInfo}
              </label>
              <label class="rs-adapt-radio ${pitchShift === 'manual' ? 'selected' : ''}">
                <input type="radio" name="rs_pitch_${channel}" value="manual" ${pitchShift === 'manual' ? 'checked' : ''} data-channel="${channel}" data-field="pitchShift">
                ${_t('autoAssign.pitchManual')}
              </label>
            </div>
          </div>
          ${pitchShift === 'manual' ? `
            <div class="rs-adapt-row rs-transpose-row">
              <span class="rs-adapt-label">${_t('autoAssign.transposition')}</span>
              <div class="rs-transpose-controls">
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="-12">-12</button>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="-1">-1</button>
                <span class="rs-transpose-value">${semitones > 0 ? '+' : ''}${semitones}st</span>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="1">+1</button>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="12">+12</button>
              </div>
            </div>
          ` : ''}
          <div class="rs-adapt-row">
            <span class="rs-adapt-label">${_t('autoAssign.oorTitle')}</span>
            <div class="rs-adapt-options">
              <label class="rs-adapt-radio ${oorHandling === 'passThrough' ? 'selected' : ''}">
                <input type="radio" name="rs_oor_${channel}" value="passThrough" ${oorHandling === 'passThrough' ? 'checked' : ''} data-channel="${channel}" data-field="oorHandling">
                ${_t('autoAssign.oorPassThrough')}
              </label>
              <label class="rs-adapt-radio ${oorHandling === 'octaveWrap' ? 'selected' : ''}">
                <input type="radio" name="rs_oor_${channel}" value="octaveWrap" ${oorHandling === 'octaveWrap' ? 'checked' : ''} data-channel="${channel}" data-field="oorHandling">
                ${_t('autoAssign.oorOctaveWrap')}
              </label>
              <label class="rs-adapt-radio ${oorHandling === 'suppress' ? 'selected' : ''}">
                <input type="radio" name="rs_oor_${channel}" value="suppress" ${oorHandling === 'suppress' ? 'checked' : ''} data-channel="${channel}" data-field="oorHandling">
                ${_t('autoAssign.oorSuppress')}
              </label>
            </div>
          </div>
        </div>
      `;
    }

    // Instrument chips (horizontal bar) — always show, even on skipped channels
    const instrumentChipsHTML = (options.length > 0)
      ? this._renderInstrumentChips(channel, options, lowOptions, assignment, isSkipped)
      : `<p class="rs-no-instruments">${_t('autoAssign.noCompatible')}</p>`;
    // Range bars (channel notes vs instrument capability)
    // Range bars: show for assigned instrument OR for active split (accepted only)
    const hasSplitData = isSplit;
    const rangeBarsHTML = (!isDrumChannel && (assignment?.noteRangeMin != null || hasSplitData))
      ? this._renderRangeBars(channel, analysis, assignment) : '';

    // Split section — only render if split is accepted by user
    let splitHTML = '';
    if (isSplit) {
      const expanded = this.splitExpanded[channel] ?? isSplit;
      const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
      const splitModeNames = { fullCoverage: _t('autoAssign.splitFullCoverage'), range: _t('autoAssign.splitByRange'), polyphony: _t('autoAssign.splitByPolyphony'), mixed: _t('autoAssign.splitMixed') };

      // Determine active data (proposal or accepted)
      let activeData, segments, activeMode;
      if (isSplit && this.splitAssignments[channel]) {
        activeData = this.splitAssignments[channel];
        segments = activeData.segments || [];
        activeMode = activeData.type;
      } else {
        const proposal = this.splitProposals[channel];
        const allModes = [proposal, ...(proposal.alternatives || [])];
        activeMode = this.activeSplitMode[channel] || proposal.type;
        activeData = allModes.find(m => m.type === activeMode) || proposal;
        segments = activeData.segments || [];
      }

      // Mode tabs (only for proposals with alternatives)
      // Mode tabs — hidden once user edits segments (to prevent losing changes)
      let modeTabs = '';
      if (!isSplit && !this.splitEdited[channel] && this.splitProposals[channel]) {
        const proposal = this.splitProposals[channel];
        const allModes = [proposal, ...(proposal.alternatives || [])];
        if (allModes.length > 1) {
          modeTabs = `<div class="rs-split-modes">${allModes.map(m => `
            <button class="rs-split-mode-btn ${m.type === activeMode ? 'active' : ''}" data-channel="${channel}" data-mode="${m.type}">
              ${splitModeNames[m.type] || m.type} <span class="rs-split-quality">${m.quality}</span>
            </button>
          `).join('')}</div>`;
        }
      }

      // Render segment cards with instrument select + range inputs + remove button
      const segCardsHTML = segments.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const compatInstruments = this._getCompatibleInstrumentsForSegment(ch, seg.noteRange);
        // Also include the currently assigned instrument even if not in compatible list
        const seen = new Set(compatInstruments.map(inst => inst.id));
        if (seg.instrumentId && !seen.has(seg.instrumentId)) {
          const currentInst = (this.allInstruments || []).find(i => i.id === seg.instrumentId);
          if (currentInst) compatInstruments.unshift({ ...currentInst, _score: -1 });
        }
        const selectOptions = compatInstruments.map(inst => {
          const selected = inst.id === seg.instrumentId ? 'selected' : '';
          const name = this._getInstrumentDisplayName(inst);
          const label = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;
          return `<option value="${inst.id}" ${selected}>${escapeHtml(label)}</option>`;
        }).join('');
        const canRemove = segments.length > 1;
        const rMin = seg.noteRange?.min ?? 0;
        const rMax = seg.noteRange?.max ?? 127;
        return `
          <div class="rs-seg-card" style="border-left: 3px solid ${color}">
            <div class="rs-seg-card-row">
              <select class="rs-seg-instrument-select" data-channel="${channel}" data-seg="${i}" data-mode="${activeMode}">
                ${selectOptions}
              </select>
              ${canRemove ? `<button class="btn btn-sm rs-btn-remove-segment" data-channel="${channel}" data-seg="${i}" title="${_t('common.delete')}">&times;</button>` : ''}
            </div>
            <div class="rs-seg-range-controls">
              <span class="rs-seg-range-label">${midiNoteToName(rMin)}</span>
              <input type="number" class="rs-seg-range-input" data-channel="${channel}" data-seg="${i}" data-bound="min" value="${rMin}" min="0" max="127">
              <span>\u2013</span>
              <input type="number" class="rs-seg-range-input" data-channel="${channel}" data-seg="${i}" data-bound="max" value="${rMax}" min="0" max="127">
              <span class="rs-seg-range-label">${midiNoteToName(rMax)}</span>
            </div>
          </div>
        `;
      }).join('');

      // Detect overlaps between segments
      const overlaps = this._detectOverlaps(segments);
      const overlapsHTML = overlaps.map((ov, idx) => {
        const nameA = segments[ov.segA]?.instrumentName || `Inst ${ov.segA + 1}`;
        const nameB = segments[ov.segB]?.instrumentName || `Inst ${ov.segB + 1}`;
        return `
          <div class="rs-overlap-warning">
            <span>\u26A0 ${midiNoteToName(ov.min)}-${midiNoteToName(ov.max)}: ${escapeHtml(nameA)} / ${escapeHtml(nameB)}</span>
            <div class="rs-overlap-btns">
              <button class="btn btn-sm rs-overlap-resolve-btn" data-channel="${channel}" data-overlap="${idx}" data-strategy="first">${escapeHtml(nameA)}</button>
              <button class="btn btn-sm rs-overlap-resolve-btn" data-channel="${channel}" data-overlap="${idx}" data-strategy="second">${escapeHtml(nameB)}</button>
              <button class="btn btn-sm rs-overlap-resolve-btn" data-channel="${channel}" data-overlap="${idx}" data-strategy="shared">${_t('autoAssign.splitMixed')}</button>
            </div>
          </div>
        `;
      }).join('');

      // Detect uncovered notes
      let uncoveredHTML = '';
      if (analysis?.noteDistribution && segments.length > 0) {
        const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
        const adapt = this.adaptationSettings[ch] || {};
        const semi = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
        const uncoveredNotes = usedNotes.filter(n => {
          const shifted = n + semi;
          return !segments.some(seg => {
            const sMin = seg.noteRange?.min ?? 0;
            const sMax = seg.noteRange?.max ?? 127;
            return shifted >= sMin && shifted <= sMax;
          });
        });
        if (uncoveredNotes.length > 0) {
          const uncMin = Math.min(...uncoveredNotes);
          const uncMax = Math.max(...uncoveredNotes);
          uncoveredHTML = `
            <div class="rs-uncovered-warning">
              <span>\u26A0 ${uncoveredNotes.length} ${_t('routingSummary.uncoveredNotes') || 'notes non couvertes'} (${midiNoteToName(uncMin)}-${midiNoteToName(uncMax)})</span>
              <button class="btn btn-sm rs-btn-add-segment" data-channel="${channel}">+ ${_t('routingSummary.addInstrument') || 'Ajouter instrument'}</button>
            </div>
          `;
        }
      }

      // Action buttons
      let actionsHTML = '';
      if (isSplit) {
        actionsHTML = `
          <div class="rs-split-actions">
            <button class="btn btn-sm rs-btn-add-segment" data-channel="${channel}">+ ${_t('routingSummary.addInstrument')}</button>
            <button class="btn btn-sm rs-btn-remove-split" data-channel="${channel}">${_t('autoAssign.removeSplit')}</button>
          </div>
        `;
      } else {
        actionsHTML = `
          <div class="rs-split-actions">
            <button class="btn btn-sm rs-btn-add-segment" data-channel="${channel}">+ ${_t('routingSummary.addInstrument')}</button>
            <button class="btn btn-sm rs-btn-accept-split" data-channel="${channel}">${_t('autoAssign.acceptSplit')}</button>
          </div>
        `;
      }

      const segCount = segments.length;
      const quality = activeData?.quality || 0;

      const splitStatusLabel = isSplit
        ? `${_t('routingSummary.splitActive') || 'Decoupe active'} (${segCount} instr.)`
        : `${_t('routingSummary.splitAvailable') || 'Decoupe disponible'} (${segCount} instr., ${_t('routingSummary.quality')}: ${quality})`;

      splitHTML = `
        <div class="rs-split-section ${isSplit ? 'active' : ''}">
          <div class="rs-split-header" data-channel="${channel}">
            <span class="rs-split-toggle">${expanded ? '\u25BE' : '\u25B8'}</span>
            <span>${splitStatusLabel}</span>
            ${isSplit
              ? `<button class="btn btn-sm rs-btn-remove-split rs-split-toggle-btn" data-channel="${channel}" title="${_t('autoAssign.removeSplit') || 'Desactiver decoupe'}">\u2716</button>`
              : `<button class="btn btn-sm rs-btn-accept-split rs-split-toggle-btn" data-channel="${channel}" title="${_t('routingSummary.activateSplit') || 'Activer decoupe'}">\u2714</button>`
            }
          </div>
          <div class="rs-split-body ${expanded ? '' : 'collapsed'}">
            ${modeTabs}
            ${renderSplitBar(activeData, analysis)}
            <div class="rs-split-segments">${segCardsHTML}</div>
            ${overlapsHTML}
            ${uncoveredHTML}
            ${actionsHTML}
          </div>
        </div>
      `;
    }

    // Multi-instrument list (for split channels)
    let multiInstHTML = '';
    if (isSplit && this.splitAssignments[channel]) {
      const segments = this.splitAssignments[channel].segments || [];
      const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
      multiInstHTML = `<div class="rs-multi-inst-list">
        ${segments.map((seg, i) => {
          const color = splitColors[i % splitColors.length];
          const name = seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument';
          const rMin = seg.noteRange?.min ?? 0;
          const rMax = seg.noteRange?.max ?? 127;
          return `<div class="rs-multi-inst-item" style="border-left: 3px solid ${color}">
            <span class="rs-multi-inst-name" style="color:${color}">${escapeHtml(name)}</span>
            <span class="rs-multi-inst-range">${midiNoteToName(rMin)} - ${midiNoteToName(rMax)}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    // "Activate split" button — only if proposal exists and split not yet accepted
    let splitActivateHTML = '';
    if (!isSplit && hasSplitProposal) {
      splitActivateHTML = `<button class="btn btn-sm rs-btn-accept-split rs-btn-activate-split" data-channel="${channel}">${_t('routingSummary.activateSplit') || 'Activer decoupe'}</button>`;
    }

    return `
      <div class="rs-detail-content">
        <div class="rs-detail-header">
          <div class="rs-detail-title">
            <span class="rs-detail-ch">${typeIcon} Ch ${channel + 1}${channel === 9 ? ' DR' : ''}</span>
            <span class="rs-detail-route">
              ${escapeHtml(gmName)}${assignedName ? ` \u2192 <strong>${escapeHtml(assignedName)}</strong>` : ''}
            </span>
            ${score > 0 ? `<span class="rs-detail-score ${getScoreClass(score)}">${score}</span>` : ''}
            ${playableInfo ? `<span class="rs-detail-playable">${playableInfo}</span>` : ''}
          </div>
          <button class="btn btn-sm rs-detail-close" id="rsDetailClose">&times;</button>
        </div>
        ${isSplit ? multiInstHTML : ''}

        ${rangeBarsHTML}
        ${instrumentChipsHTML}
        ${adaptHTML}
        ${splitHTML}
        ${splitActivateHTML}
      </div>
    `;
  }

  /**
   * Render instrument selection as horizontal scrollable chips
   */
  _renderInstrumentChips(channel, options, lowOptions, assignment, isSkipped = false) {
    const ch = String(channel);
    const isSplit = this.splitChannels.has(channel);
    const showLow = this.showLowScores[ch];

    // For split channels, don't show chips — the split section handles segment display
    if (isSplit) return '';

    // Normal: show top options as chips
    const chips = options.map(opt => {
      const inst = opt.instrument;
      const score = opt.compatibility.score;
      const isSelected = assignment?.instrumentId === inst.id;
      const instType = inst.instrument_type || '';
      const typeColor = getTypeColor(instType);
      const name = this._getInstrumentDisplayName(inst);
      const displayName = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;

      return `
        <button class="aa-instbar-btn ${isSelected ? 'assigned' : ''}" style="border-left: 3px solid ${typeColor}"
                data-instrument-id="${inst.id}" data-channel="${ch}"
                title="${escapeHtml(name)} \u2014 ${score}/100">
          <span class="aa-instbar-dot" style="background:${typeColor}"></span>
          <span class="aa-instbar-name">${escapeHtml(displayName)}</span>
          <span class="aa-instbar-score ${getScoreClass(score)}">${score}</span>
          ${isSelected ? '<span class="aa-instbar-check">\u2713</span>' : ''}
        </button>
      `;
    }).join('');

    // Low-score chips (hidden by default)
    let lowChips = '';
    if (showLow && lowOptions.length > 0) {
      lowChips = lowOptions.map(opt => {
        const inst = opt.instrument;
        const score = opt.compatibility.score;
        const isSelected = assignment?.instrumentId === inst.id;
        const typeColor = getTypeColor(inst.instrument_type || '');
        const name = inst.custom_name || inst.name || '?';
        const displayName = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;
        return `
          <button class="aa-instbar-btn unrouted ${isSelected ? 'assigned' : ''}" style="border-left: 3px solid ${typeColor}"
                  data-instrument-id="${inst.id}" data-channel="${ch}"
                  title="${escapeHtml(name)} \u2014 ${score}/100">
            <span class="aa-instbar-dot" style="background:${typeColor}"></span>
            <span class="aa-instbar-name">${escapeHtml(displayName)}</span>
            <span class="aa-instbar-score ${getScoreClass(score)}">${score}</span>
            ${isSelected ? '<span class="aa-instbar-check">\u2713</span>' : ''}
          </button>
        `;
      }).join('');
    }

    const showMoreBtn = lowOptions.length > 0 ? `
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
   * Render full 0-127 MIDI range visualization with two-line display.
   * Line 1: Channel notes (with transposition applied directly)
   * Line 2: Instrument playable range(s) with name labels and vertical connectors
   */
  _renderRangeBars(channel, analysis, assignment) {
    if (!analysis?.noteRange || analysis.noteRange.min == null) return '';

    const ch = String(channel);
    const chMin = analysis.noteRange.min;
    const chMax = analysis.noteRange.max;
    const FULL_RANGE = 128; // 0-127

    // Transposition: directly shift channel notes position
    const adapt = this.adaptationSettings[ch] || {};
    const semitones = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
    const displayChMin = Math.max(0, Math.min(127, chMin + semitones));
    const displayChMax = Math.max(0, Math.min(127, chMax + semitones));

    // Channel notes bar (line 1) - position on 0-127 scale
    const chLeft = (displayChMin / FULL_RANGE) * 100;
    const chWidth = Math.max(1, ((displayChMax - displayChMin) / FULL_RANGE) * 100);

    const transLabel = semitones !== 0 ? ` (${semitones > 0 ? '+' : ''}${semitones}st)` : '';
    const chBarTitle = `${_t('autoAssign.channelNotes')}: ${midiNoteToName(displayChMin)}-${midiNoteToName(displayChMax)}${transLabel}`;

    // Instrument bars (line 2) - one or multiple depending on split
    const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
    let instBarsHTML = '';
    let legendItems = '';

    const splitData = this._getActiveSplitData(channel);
    if (splitData?.segments?.length > 0) {
      // Multi-instrument split
      const segs = splitData.segments;
      instBarsHTML = segs.map((seg, i) => {
        const sMin = seg.fullRange?.min ?? seg.noteRange?.min ?? 0;
        const sMax = seg.fullRange?.max ?? seg.noteRange?.max ?? 127;
        const left = (sMin / FULL_RANGE) * 100;
        const width = Math.max(1, ((sMax - sMin) / FULL_RANGE) * 100);
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || `Inst ${i + 1}`;

        // Detect non-played portions (dotted) based on channel note distribution
        let dottedCSS = '';
        if (analysis?.noteDistribution) {
          const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
          const shiftedNotes = usedNotes.map(n => n + semitones);
          const hasNotesInRange = shiftedNotes.some(n => n >= sMin && n <= sMax);
          if (!hasNotesInRange) {
            dottedCSS = 'rs-range-dotted';
          }
        }

        // Vertical connectors at extremities
        const connLeftPct = (sMin / FULL_RANGE) * 100;
        const connRightPct = (sMax / FULL_RANGE) * 100;

        return `
          <div class="rs-range-inst-line">
            <div class="rs-range-connector" style="left:${connLeftPct}%"></div>
            <div class="rs-range-connector" style="left:${connRightPct}%"></div>
            <div class="rs-range-bar rs-range-inst-bar ${dottedCSS}" style="left:${left}%;width:${width}%;background:${color}33;border:1px solid ${color}" title="${escapeHtml(name)}: ${midiNoteToName(sMin)}-${midiNoteToName(sMax)}"></div>
            <span class="rs-range-inst-label" style="left:${left}%;color:${color}">${escapeHtml(name)}</span>
          </div>
        `;
      }).join('');
      legendItems = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || `Inst ${i + 1}`;
        return `<span class="rs-range-legend-item"><span class="rs-range-legend-key" style="background:${color}80;border:1px solid ${color}"></span>${escapeHtml(name)}</span>`;
      }).join('');
    } else if (assignment?.noteRangeMin != null) {
      // Single instrument
      const iMin = assignment.noteRangeMin;
      const iMax = assignment.noteRangeMax;
      const left = (iMin / FULL_RANGE) * 100;
      const width = Math.max(1, ((iMax - iMin) / FULL_RANGE) * 100);
      const color = '#4A90D9';
      const instName = assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || _t('autoAssign.instrumentRange');
      const connLeftPct = (iMin / FULL_RANGE) * 100;
      const connRightPct = (iMax / FULL_RANGE) * 100;

      instBarsHTML = `
        <div class="rs-range-inst-line">
          <div class="rs-range-connector" style="left:${connLeftPct}%"></div>
          <div class="rs-range-connector" style="left:${connRightPct}%"></div>
          <div class="rs-range-bar rs-range-inst-bar" style="left:${left}%;width:${width}%;background:${color}33;border:1px solid ${color}" title="${escapeHtml(instName)}: ${midiNoteToName(iMin)}-${midiNoteToName(iMax)}"></div>
          <span class="rs-range-inst-label" style="left:${left}%;color:${color}">${escapeHtml(instName)}</span>
        </div>
      `;
      legendItems = `<span class="rs-range-legend-item"><span class="rs-range-legend-key rs-range-legend-inst"></span>${escapeHtml(instName)}</span>`;
    }

    // Octave markers for full 0-127 range
    const octaveMarkers = [];
    for (let oct = 0; oct <= 10; oct++) {
      const note = oct * 12;
      if (note <= 127) {
        const pct = (note / FULL_RANGE) * 100;
        octaveMarkers.push(`<span class="rs-range-octave-mark" style="left:${pct}%">C${oct - 1}</span>`);
      }
    }

    return `
      <div class="rs-range-full">
        <div class="rs-range-labels-full">
          <span>0</span>
          <span>${midiNoteToName(displayChMin)}-${midiNoteToName(displayChMax)}${transLabel}</span>
          <span>127</span>
        </div>
        <div class="rs-range-octaves">${octaveMarkers.join('')}</div>
        <div class="rs-range-track-line" title="${chBarTitle}">
          <div class="rs-range-bar rs-range-ch-bar" style="left:${chLeft}%;width:${chWidth}%"></div>
        </div>
        ${instBarsHTML}
        <div class="rs-range-legend">
          <span class="rs-range-legend-item"><span class="rs-range-legend-key rs-range-legend-ch"></span>${_t('autoAssign.channelNotes')}${transLabel}</span>
          ${legendItems}
        </div>
      </div>
    `;
  }

  /**
   * Get instruments compatible with a split segment's note range.
   * Returns instruments whose range intersects the segment range.
   */
  _getCompatibleInstrumentsForSegment(ch, segNoteRange) {
    if (!segNoteRange) return [];
    const segMin = segNoteRange.min ?? 0;
    const segMax = segNoteRange.max ?? 127;

    // Collect all available instruments from suggestions + allInstruments
    const seen = new Set();
    const candidates = [];

    // Priority 1: instruments from suggestions (have compatibility scores)
    for (const opt of [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])]) {
      const inst = opt.instrument;
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      const iMin = inst.note_range_min ?? 0;
      const iMax = inst.note_range_max ?? 127;
      // Check intersection
      if (iMin <= segMax && iMax >= segMin) {
        candidates.push({ ...inst, _score: opt.compatibility?.score || 0 });
      }
    }

    // Priority 2: all instruments (no score, lower priority)
    for (const inst of (this.allInstruments || [])) {
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      const iMin = inst.note_range_min ?? 0;
      const iMax = inst.note_range_max ?? 127;
      if (iMin <= segMax && iMax >= segMin) {
        candidates.push({ ...inst, _score: 0 });
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b._score - a._score);
    return candidates;
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

    // Settings button — open dedicated modal
    const settingsBtn = modal.querySelector('#rsSettingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        if (!window.ScoringSettingsModal) {
          console.error('ScoringSettingsModal not available');
          return;
        }
        const settingsModal = new window.ScoringSettingsModal(this.scoringOverrides, (newOverrides) => {
          this.scoringOverrides = newOverrides;
          this._saveScoringOverrides();
          this._recalculate();
        });
        settingsModal.open();
      });
    }

    // Auto-adaptation toggle
    const adaptToggle = modal.querySelector('#rsAutoAdaptToggle');
    if (adaptToggle) {
      adaptToggle.addEventListener('click', () => {
        this.autoAdaptation = !this.autoAdaptation;
        this._refreshUI(channelKeys);
      });
    }

    // Instrument dropdown in summary table
    modal.querySelectorAll('.rs-instrument-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation(); // Don't trigger row click
        const ch = sel.dataset.channel;
        const instId = sel.value;
        if (instId) this._selectInstrument(ch, instId, channelKeys);
      });
      // Prevent row click when interacting with dropdown
      sel.addEventListener('click', (e) => e.stopPropagation());
    });

    // Intelligent routing button per channel
    modal.querySelectorAll('.rs-btn-intelligent').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ch = parseInt(btn.dataset.channel);
        this._selectChannel(ch);
      });
    });

    // Row clicks — select channel for detail
    modal.querySelectorAll('.rs-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger on button/select clicks
        if (e.target.closest('.rs-btn-skip, .rs-btn-unskip, .rs-btn-intelligent, .rs-instrument-select')) return;
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

    // Preview events
    this._bindPreviewEvents();
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

    // Mute button in detail panel
    modal.querySelectorAll('.rs-btn-mute').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        if (this.skippedChannels.has(ch)) {
          this.skippedChannels.delete(ch);
        } else {
          this.skippedChannels.add(ch);
        }
        this._refreshUI(channelKeys);
      });
    });

    // Instrument chip selection
    modal.querySelectorAll('.aa-instbar-btn[data-instrument-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const instId = btn.dataset.instrumentId;
        const ch = btn.dataset.channel;
        this._selectInstrument(ch, instId, channelKeys);
      });
    });

    // Adaptation controls (radio buttons)
    modal.querySelectorAll('.rs-adapt-radio input[type="radio"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const ch = radio.dataset.channel;
        const field = radio.dataset.field;
        if (ch && field) {
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          this.adaptationSettings[ch][field] = radio.value;

          // When switching pitch mode, sync transposition value
          if (field === 'pitchShift') {
            const assignment = this.selectedAssignments[ch];
            const autoSemitones = assignment?.transposition?.semitones || 0;
            if (radio.value === 'manual') {
              // Initialize manual value from auto suggestion (or keep current)
              if (!this.adaptationSettings[ch].transpositionSemitones) {
                this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
              }
            } else if (radio.value === 'auto') {
              // Restore auto value
              this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
            } else {
              // None: reset to 0
              this.adaptationSettings[ch].transpositionSemitones = 0;
            }
          }

          this._refreshUI(channelKeys);
        }
      });
    });

    // Transposition buttons
    modal.querySelectorAll('.rs-transpose-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = btn.dataset.channel;
        const delta = parseInt(btn.dataset.delta);
        if (ch && !isNaN(delta)) {
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          const current = this.adaptationSettings[ch].transpositionSemitones || 0;
          this.adaptationSettings[ch].transpositionSemitones = Math.max(-36, Math.min(36, current + delta));
          this._refreshUI(channelKeys);
        }
      });
    });

    // Low score toggle (show more chips)
    modal.querySelectorAll('.aa-instbar-show-all').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = btn.dataset.channel;
        this.showLowScores[ch] = !this.showLowScores[ch];
        this._refreshUI(channelKeys);
      });
    });

    // Accept split button
    modal.querySelectorAll('.rs-btn-accept-split').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this._acceptSplit(ch, channelKeys);
      });
    });

    // Split mode tabs
    modal.querySelectorAll('.rs-split-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this.activeSplitMode[ch] = btn.dataset.mode;
        this._refreshUI(channelKeys);
      });
    });

    // Remove split
    modal.querySelectorAll('.rs-btn-remove-split').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this.splitChannels.delete(ch);
        delete this.splitAssignments[ch];
        this._refreshUI(channelKeys);
      });
    });

    // Split section collapse/expand
    modal.querySelectorAll('.rs-split-header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const ch = parseInt(hdr.dataset.channel);
        this.splitExpanded[ch] = !this.splitExpanded[ch];
        this._refreshUI(channelKeys);
      });
    });

    // Split segment instrument selection
    modal.querySelectorAll('.rs-seg-instrument-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const ch = parseInt(sel.dataset.channel);
        const segIdx = parseInt(sel.dataset.seg);
        const mode = sel.dataset.mode;
        this._updateSegmentInstrument(ch, segIdx, sel.value, mode, channelKeys);
      });
    });

    // Add segment
    modal.querySelectorAll('.rs-btn-add-segment').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this._addSplitSegment(ch, channelKeys);
      });
    });

    // Remove segment
    modal.querySelectorAll('.rs-btn-remove-segment').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        const segIdx = parseInt(btn.dataset.seg);
        this._removeSplitSegment(ch, segIdx, channelKeys);
      });
    });

    // Segment range inputs
    modal.querySelectorAll('.rs-seg-range-input').forEach(input => {
      input.addEventListener('change', () => {
        const ch = parseInt(input.dataset.channel);
        const segIdx = parseInt(input.dataset.seg);
        const bound = input.dataset.bound; // 'min' or 'max'
        this._updateSegmentRange(ch, segIdx, bound, input.value, channelKeys);
      });
    });

    // Overlap resolution
    modal.querySelectorAll('.rs-overlap-resolve-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        const overlapIdx = parseInt(btn.dataset.overlap);
        const strategy = btn.dataset.strategy;
        this._resolveOverlap(ch, overlapIdx, strategy, channelKeys);
      });
    });
  }

  /**
   * Update the instrument for a specific split segment.
   */
  _updateSegmentInstrument(channel, segIdx, instrumentId, mode, channelKeys) {
    // Find the instrument in suggestions or allInstruments
    const ch = String(channel);
    let inst = null;
    for (const opt of [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])]) {
      if (opt.instrument.id === instrumentId) { inst = opt.instrument; break; }
    }
    if (!inst) {
      inst = (this.allInstruments || []).find(i => i.id === instrumentId);
    }
    if (!inst) return;
    this.splitEdited[channel] = true;

    // Determine which data to update (proposal or accepted assignment)
    const isSplit = this.splitChannels.has(channel);
    let target;
    if (isSplit && this.splitAssignments[channel]) {
      target = this.splitAssignments[channel];
    } else {
      // Update the proposal's active mode segments
      const proposal = this.splitProposals[channel];
      if (!proposal) return;
      const allModes = [proposal, ...(proposal.alternatives || [])];
      target = allModes.find(m => m.type === mode) || proposal;
    }

    if (!target?.segments?.[segIdx]) return;

    // Update the segment with the new instrument
    target.segments[segIdx] = {
      ...target.segments[segIdx],
      instrumentId: inst.id,
      deviceId: inst.device_id,
      instrumentChannel: inst.channel,
      instrumentName: inst.custom_name || getGmProgramName(inst.gm_program) || inst.name,
      gmProgram: inst.gm_program,
      fullRange: { min: inst.note_range_min ?? 0, max: inst.note_range_max ?? 127 }
    };

    this._refreshUI(channelKeys);
  }

  /**
   * Detect overlapping note ranges between segments.
   */
  _detectOverlaps(segments) {
    if (!segments || segments.length < 2) return [];
    const overlaps = [];
    for (let a = 0; a < segments.length; a++) {
      for (let b = a + 1; b < segments.length; b++) {
        const rA = segments[a].noteRange;
        const rB = segments[b].noteRange;
        if (!rA || !rB) continue;
        const oMin = Math.max(rA.min, rB.min);
        const oMax = Math.min(rA.max, rB.max);
        if (oMin <= oMax) {
          overlaps.push({ min: oMin, max: oMax, segA: a, segB: b });
        }
      }
    }
    return overlaps;
  }

  /**
   * Get the active split data (proposal mode or accepted assignment).
   */
  _getActiveSplitData(channel) {
    const isSplit = this.splitChannels.has(channel);
    if (isSplit && this.splitAssignments[channel]) return this.splitAssignments[channel];
    const proposal = this.splitProposals[channel];
    if (!proposal) return null;
    const activeMode = this.activeSplitMode[channel] || proposal.type;
    const allModes = [proposal, ...(proposal.alternatives || [])];
    return allModes.find(m => m.type === activeMode) || proposal;
  }

  /**
   * Add a new segment to the split.
   */
  _addSplitSegment(channel, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments) return;
    this.splitEdited[channel] = true;
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel];

    // Find an instrument not already used in segments
    const usedIds = new Set(data.segments.map(s => s.instrumentId));
    const candidates = this._getCompatibleInstrumentsForSegment(ch, analysis?.noteRange || { min: 0, max: 127 });
    const newInst = candidates.find(inst => !usedIds.has(inst.id));
    if (!newInst) return; // no available instrument

    // Compute default range: largest gap in current coverage, or instrument range
    const chMin = analysis?.noteRange?.min ?? 0;
    const chMax = analysis?.noteRange?.max ?? 127;
    const sorted = [...data.segments].sort((a, b) => (a.noteRange?.min ?? 0) - (b.noteRange?.min ?? 0));
    let bestGap = { min: chMin, max: chMax, size: 0 };
    let prev = chMin;
    for (const seg of sorted) {
      const gapStart = prev;
      const gapEnd = (seg.noteRange?.min ?? chMin) - 1;
      if (gapEnd >= gapStart && (gapEnd - gapStart) > bestGap.size) {
        bestGap = { min: gapStart, max: gapEnd, size: gapEnd - gapStart };
      }
      prev = Math.max(prev, (seg.noteRange?.max ?? 0) + 1);
    }
    // Check trailing gap
    if (chMax >= prev && (chMax - prev) > bestGap.size) {
      bestGap = { min: prev, max: chMax, size: chMax - prev };
    }
    // If no meaningful gap, use instrument range clipped to channel
    const rangeMin = bestGap.size > 0 ? bestGap.min : Math.max(chMin, newInst.note_range_min ?? 0);
    const rangeMax = bestGap.size > 0 ? bestGap.max : Math.min(chMax, newInst.note_range_max ?? 127);

    data.segments.push({
      instrumentId: newInst.id,
      deviceId: newInst.device_id,
      instrumentChannel: newInst.channel,
      instrumentName: newInst.custom_name || getGmProgramName(newInst.gm_program) || newInst.name,
      gmProgram: newInst.gm_program,
      noteRange: { min: rangeMin, max: rangeMax },
      fullRange: { min: newInst.note_range_min ?? 0, max: newInst.note_range_max ?? 127 },
      polyphonyShare: newInst.polyphony || 16
    });

    this._refreshUI(channelKeys);
  }

  /**
   * Remove a segment from the split. If only 1 remains, revert to single instrument.
   */
  _removeSplitSegment(channel, segIdx, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments || data.segments.length <= 1) return;
    this.splitEdited[channel] = true;
    data.segments.splice(segIdx, 1);

    // If only 1 segment left, revert to single instrument routing
    if (data.segments.length === 1) {
      const remaining = data.segments[0];
      this.splitChannels.delete(channel);
      delete this.splitAssignments[channel];
      // Assign the remaining instrument as the channel's single assignment
      const ch = String(channel);
      const options = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
      const matched = options.find(o => o.instrument.id === remaining.instrumentId);
      if (matched) {
        this._selectInstrument(ch, remaining.instrumentId, channelKeys);
        return;
      }
    }

    this._refreshUI(channelKeys);
  }

  /**
   * Update the note range of a segment.
   */
  _updateSegmentRange(channel, segIdx, bound, value, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments?.[segIdx]) return;
    this.splitEdited[channel] = true;
    const clamped = Math.max(0, Math.min(127, parseInt(value) || 0));
    if (bound === 'min') {
      data.segments[segIdx].noteRange.min = clamped;
      // Ensure min <= max
      if (clamped > data.segments[segIdx].noteRange.max) {
        data.segments[segIdx].noteRange.max = clamped;
      }
    } else {
      data.segments[segIdx].noteRange.max = clamped;
      if (clamped < data.segments[segIdx].noteRange.min) {
        data.segments[segIdx].noteRange.min = clamped;
      }
    }
    this._refreshUI(channelKeys);
  }

  /**
   * Resolve an overlap between two segments.
   */
  _resolveOverlap(channel, overlapIdx, strategy, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments) return;
    const overlaps = this._detectOverlaps(data.segments);
    const ov = overlaps[overlapIdx];
    if (!ov) return;

    const segA = data.segments[ov.segA];
    const segB = data.segments[ov.segB];
    if (!segA?.noteRange || !segB?.noteRange) return;

    if (strategy === 'first') {
      // Give overlap zone to segment A: shrink B's min
      segB.noteRange.min = ov.max + 1;
    } else if (strategy === 'second') {
      // Give overlap zone to segment B: shrink A's max
      segA.noteRange.max = ov.min - 1;
    }
    // 'shared' = keep overlapping (round-robin at playback), no range change

    this._refreshUI(channelKeys);
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
      instrumentName: selected.instrument.custom_name || getGmProgramName(selected.instrument.gm_program) || selected.instrument.name,
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

    // Update adaptation settings for the new instrument's transposition
    const autoSemitones = selected.compatibility.transposition?.semitones || 0;
    if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
    this.adaptationSettings[ch].pitchShift = autoSemitones ? 'auto' : 'none';
    this.adaptationSettings[ch].transpositionSemitones = autoSemitones;

    this.skippedChannels.delete(parseInt(ch));
    this._refreshUI(channelKeys);
  }

  _acceptSplit(channel, channelKeys) {
    const proposal = this.splitProposals[channel];
    if (!proposal) return;
    // Use the active mode if user switched tabs
    const activeMode = this.activeSplitMode[channel] || proposal.type;
    const allModes = [proposal, ...(proposal.alternatives || [])];
    const chosen = allModes.find(m => m.type === activeMode) || proposal;
    this.splitChannels.add(channel);
    this.splitAssignments[channel] = JSON.parse(JSON.stringify(chosen));
    this._refreshUI(channelKeys);
  }

  _refreshUI(channelKeys) {
    // Re-render the content area (preserving modal shell)
    this._renderContent();
    // Ensure minimap updates after channel tab switch
    requestAnimationFrame(() => requestAnimationFrame(() => this._renderMinimap()));
  }

  /**
   * Apply the current routing assignments
   */
  async _applyRouting() {
    const assignments = {};
    let hasAssignment = false;
    let hasSplit = false;

    // Build assignments for non-split channels
    for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
      const chNum = parseInt(ch);
      if (this.skippedChannels.has(chNum)) continue;
      if (this.splitChannels.has(chNum)) continue; // handled below
      if (!assignment || !assignment.deviceId) continue;

      const adapt = this.adaptationSettings[ch] || {};
      const semitones = this.autoAdaptation ? (adapt.transpositionSemitones || 0) : 0;
      const oorSuppress = this.autoAdaptation ? (adapt.oorHandling === 'suppress') : false;
      const oorCompress = this.autoAdaptation ? (adapt.oorHandling === 'compress') : false;
      assignments[ch] = {
        deviceId: assignment.deviceId,
        instrumentId: assignment.instrumentId,
        instrumentChannel: assignment.instrumentChannel,
        instrumentName: assignment.customName || assignment.instrumentName,
        transposition: { semitones },
        noteRemapping: assignment.noteRemapping || null,
        suppressOutOfRange: oorSuppress,
        noteCompression: oorCompress,
        gmProgram: assignment.gmProgram,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        noteSelectionMode: assignment.noteSelectionMode,
        score: assignment.score
      };
      hasAssignment = true;
    }

    // Build assignments for split channels — send full segment data
    for (const [ch, splitData] of Object.entries(this.splitAssignments)) {
      const chNum = parseInt(ch);
      if (!this.splitChannels.has(chNum)) continue;
      if (!splitData?.segments?.length) continue;

      const adapt = this.adaptationSettings[ch] || {};
      const splitSemitones = this.autoAdaptation ? (adapt.transpositionSemitones || 0) : 0;
      assignments[ch] = {
        split: true,
        splitMode: splitData.type || 'range',
        transposition: { semitones: splitSemitones },
        suppressOutOfRange: this.autoAdaptation ? (adapt.oorHandling === 'suppress') : false,
        noteCompression: this.autoAdaptation ? (adapt.oorHandling === 'compress') : false,
        segments: splitData.segments.map(seg => ({
          deviceId: seg.deviceId,
          instrumentId: seg.instrumentId,
          instrumentChannel: seg.instrumentChannel,
          instrumentName: seg.instrumentName,
          noteRange: seg.noteRange,
          fullRange: seg.fullRange,
          polyphonyShare: seg.polyphonyShare,
          score: splitData.quality || null,
          transposition: seg.transposition || undefined
        }))
      };
      hasAssignment = true;
      hasSplit = true;
    }

    if (!hasAssignment) return;

    try {
      // Use apply_assignments which handles both normal and split routings
      const result = await this.api.sendCommand('apply_assignments', {
        originalFileId: this.fileId,
        assignments,
        createAdaptedFile: hasSplit // create adapted file when splits need physical channel separation
      });

      // Also build simple routing map for localStorage/eventBus compatibility
      const routing = {};
      for (const [ch, assignment] of Object.entries(assignments)) {
        if (assignment.split) {
          const firstSeg = assignment.segments[0];
          routing[ch] = firstSeg.instrumentChannel !== undefined
            ? `${firstSeg.deviceId}::${firstSeg.instrumentChannel}`
            : firstSeg.deviceId;
        } else {
          routing[ch] = assignment.instrumentChannel !== undefined
            ? `${assignment.deviceId}::${assignment.instrumentChannel}`
            : assignment.deviceId;
        }
      }

      // Save simple routing to localStorage as backup
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
        window.eventBus.emit('routing:changed', {
          fileId: result?.adaptedFileId || this.fileId,
          channels: routing,
          hasSplits: hasSplit
        });
      }

      if (window.midiFileManager) {
        window.midiFileManager.refreshFileList();
      }

      if (this.onApplyCallback) {
        this.onApplyCallback({
          fileId: result?.adaptedFileId || this.fileId,
          routing,
          hasSplits: hasSplit
        });
      }

      this.close();

    } catch (error) {
      console.error('[RoutingSummary] Apply failed:', error);
    }
  }

  // ============================================================================
  // Preview bar & minimap
  // ============================================================================

  _renderHeaderButtons() {
    const ch = this.selectedChannel;
    const chLabel = ch !== null ? (ch + 1) : '?';
    const fnDisplay = this.filename || '';
    const fnShort = fnDisplay.length > 30 ? fnDisplay.slice(0, 27) + '\u2026' : fnDisplay;
    return `
      <div class="rs-hdr-prev-btns">
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewAllBtn" title="${_t('routingSummary.previewAll')}">
          <span class="rs-prev-icon">&#9654;</span> ${_t('routingSummary.previewAll') || 'Tout'}
        </button>
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewChBtn" title="${_t('routingSummary.previewChannel')} ${chLabel}" ${ch === null ? 'disabled' : ''}>
          <span class="rs-prev-icon">&#9654;</span> Canal ${chLabel}
        </button>
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewOrigBtn" title="${_t('routingSummary.previewOriginal')}" ${ch === null ? 'disabled' : ''}>
          <span class="rs-prev-icon">&#9835;</span> ${_t('routingSummary.previewOriginal') || 'Original'}
        </button>
        <button class="btn btn-sm rs-prev-btn" id="rsPreviewPauseBtn" style="display:none">&#10074;&#10074;</button>
        <button class="btn btn-sm rs-prev-btn" id="rsPreviewStopBtn" style="display:none">&#9632;</button>
        <span class="rs-preview-time" id="rsPreviewTime"></span>
        <span class="rs-header-filename" title="${escapeHtml(fnDisplay)}">${escapeHtml(fnShort)}</span>
      </div>
    `;
  }

  _bindPreviewEvents() {
    const modal = this.modal;
    if (!modal) return;

    modal.querySelector('#rsPreviewAllBtn')?.addEventListener('click', () => this._previewAll());
    modal.querySelector('#rsPreviewChBtn')?.addEventListener('click', () => this._previewChannel(this.selectedChannel));
    modal.querySelector('#rsPreviewOrigBtn')?.addEventListener('click', () => this._previewOriginal(this.selectedChannel));
    modal.querySelector('#rsPreviewPauseBtn')?.addEventListener('click', () => {
      if (this._previewState === 'paused') this._resumePreview();
      else this._pausePreview();
    });
    modal.querySelector('#rsPreviewStopBtn')?.addEventListener('click', () => this._stopPreview());

    // Minimap click → seek
    const container = modal.querySelector('#rsMinimapContainer');
    if (container) {
      container.addEventListener('click', (e) => {
        const rect = container.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const totalSec = this.audioPreview?.totalDuration || 0;
        if (totalSec > 0 && this.audioPreview?.seek) {
          this.audioPreview.seek(pct * totalSec);
        }
      });
    }

    // Render minimap after layout paint (double-rAF to ensure container has dimensions)
    requestAnimationFrame(() => requestAnimationFrame(() => this._renderMinimap()));
  }

  _renderMinimap() {
    const container = this.modal?.querySelector('#rsMinimapContainer');
    if (!container || !this.midiData) return;

    let canvas = this._minimapCanvas;
    if (!canvas || !canvas.parentNode) {
      canvas = document.createElement('canvas');
      canvas.className = 'rs-minimap-canvas';
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.cursor = 'pointer';
      container.textContent = '';
      container.appendChild(canvas);
      this._minimapCanvas = canvas;
    }

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth || 400;
    const h = 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';

    // Determine channel filter
    const channelFilter = (this.selectedChannel !== null) ? this.selectedChannel : null;
    const notes = this._extractNotesForMinimap(channelFilter);
    const totalTicks = notes.length > 0 ? notes[notes.length - 1].t + 1 : 1;

    this._minimapWidth = w;
    this._minimapHeight = h;
    this._minimapTotalTicks = totalTicks;
    this._minimapBuckets = new Array(w).fill(0);
    this._minimapBucketsOOR = new Array(w).fill(0);
    this._minimapMaxVal = 0;

    // Get instrument range for coloring
    let instMin = null, instMax = null;
    if (this.selectedChannel !== null) {
      const ch = String(this.selectedChannel);
      const assignment = this.selectedAssignments[ch];
      if (assignment) {
        instMin = assignment.noteRangeMin;
        instMax = assignment.noteRangeMax;
      }
      // For splits, use combined range
      if (this.splitChannels.has(this.selectedChannel) && this.splitAssignments[this.selectedChannel]) {
        const segs = this.splitAssignments[this.selectedChannel].segments || [];
        if (segs.length > 0) {
          instMin = Math.min(...segs.map(s => s.fullRange?.min ?? s.noteRange?.min ?? 0));
          instMax = Math.max(...segs.map(s => s.fullRange?.max ?? s.noteRange?.max ?? 127));
        }
      }
    }
    this._minimapInstRange = (instMin != null && instMax != null) ? { min: instMin, max: instMax } : null;

    for (const note of notes) {
      const col = Math.floor((note.t / totalTicks) * w);
      if (col < 0 || col >= w) continue;
      this._minimapBuckets[col]++;
      if (this._minimapBuckets[col] > this._minimapMaxVal) this._minimapMaxVal = this._minimapBuckets[col];
      if (this._minimapInstRange && (note.n < instMin || note.n > instMax)) {
        this._minimapBucketsOOR[col]++;
      }
    }

    this._drawMinimapFrame(0);
  }

  _drawMinimapFrame(playheadPct) {
    const canvas = this._minimapCanvas;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = this._minimapWidth || 400;
    const h = this._minimapHeight || 32;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim() || '#f0f0f0';
    ctx.fillRect(0, 0, w, h);

    if (!this._minimapBuckets) return;
    const maxVal = this._minimapMaxVal || 1;

    for (let i = 0; i < w; i++) {
      if (this._minimapBuckets[i] === 0) continue;
      const inRange = this._minimapBuckets[i] - (this._minimapBucketsOOR[i] || 0);
      if (inRange > 0) {
        const barH = Math.max(1, (inRange / maxVal) * (h - 2));
        ctx.fillStyle = '#4285f4';
        ctx.fillRect(i, h - 1 - barH, 1, barH);
      }
      if (this._minimapBucketsOOR[i] > 0) {
        const outH = Math.max(1, (this._minimapBucketsOOR[i] / maxVal) * (h - 2));
        const inH = inRange > 0 ? Math.max(1, (inRange / maxVal) * (h - 2)) : 0;
        ctx.fillStyle = '#e74c3c';
        ctx.fillRect(i, h - 1 - inH - outH, 1, outH);
      }
    }

    // Playhead
    if (playheadPct > 0 && playheadPct <= 1) {
      const x = Math.floor(playheadPct * w);
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(x, 0, 2, h);
    }
  }

  _extractNotesForMinimap(channelFilter) {
    const notes = [];
    if (!this.midiData?.tracks) return notes;

    // Determine playable range for filtering (per-channel instrument ranges)
    const getRange = (ch) => {
      const chStr = String(ch);
      const assignment = this.selectedAssignments[chStr];
      if (!assignment) return null;
      // For splits, use combined range
      if (this.splitChannels.has(ch) && this.splitAssignments[ch]) {
        const segs = this.splitAssignments[ch].segments || [];
        if (segs.length > 0) {
          return {
            min: Math.min(...segs.map(s => s.fullRange?.min ?? s.noteRange?.min ?? 0)),
            max: Math.max(...segs.map(s => s.fullRange?.max ?? s.noteRange?.max ?? 127))
          };
        }
      }
      if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
        return { min: assignment.noteRangeMin, max: assignment.noteRangeMax };
      }
      return null;
    };

    for (const track of this.midiData.tracks) {
      if (!track.events) continue;
      let tick = 0;
      for (const event of track.events) {
        if (event.deltaTime !== undefined) tick += event.deltaTime;
        if (event.type === 'noteOn' && event.velocity > 0) {
          const ch = event.channel ?? 0;
          if (channelFilter !== null && ch !== channelFilter) continue;
          const note = event.note ?? event.noteNumber ?? 60;

          // Filter: only include notes playable on assigned instrument(s)
          const range = getRange(ch);
          if (range && (note < range.min || note > range.max)) continue;

          notes.push({ t: tick, n: note });
        }
      }
    }
    notes.sort((a, b) => a.t - b.t);
    return notes;
  }

  // ============================================================================
  // Audio preview playback
  // ============================================================================

  async _previewAll() {
    if (!this.audioPreview || !this.midiData) {
      console.warn('[Preview] No audioPreview or midiData available');
      return;
    }
    this._safeStopPreview();
    this._previewMode = 'all';
    this._previewingChannel = null;

    const channelConfigs = {};
    for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
      const chNum = parseInt(ch);
      if (this.skippedChannels.has(chNum)) { channelConfigs[ch] = { skipped: true }; continue; }

      const adapt = this.adaptationSettings[ch] || {};
      const semitones = adapt.transpositionSemitones || 0;

      // Build full instrument constraints from assignment
      const constraints = assignment ? {
        gmProgram: assignment.gmProgram,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        noteSelectionMode: assignment.noteSelectionMode || undefined,
        selectedNotes: assignment.selectedNotes || undefined,
        suppressOutOfRange: adapt.oorHandling === 'suppress',
        noteCompression: adapt.oorHandling === 'compress'
      } : null;

      // For split channels, build combined constraints
      if (this.splitChannels.has(chNum) && this.splitAssignments[chNum]) {
        const segs = this.splitAssignments[chNum].segments || [];
        if (segs.length > 0) {
          const combinedMin = Math.min(...segs.map(s => s.fullRange?.min ?? s.noteRange?.min ?? 0));
          const combinedMax = Math.max(...segs.map(s => s.fullRange?.max ?? s.noteRange?.max ?? 127));
          channelConfigs[ch] = {
            transposition: { semitones },
            instrumentConstraints: {
              gmProgram: segs[0].gmProgram ?? (constraints?.gmProgram),
              noteRangeMin: combinedMin,
              noteRangeMax: combinedMax
            }
          };
          continue;
        }
      }

      channelConfigs[ch] = {
        transposition: { semitones },
        instrumentConstraints: constraints
      };
    }

    try {
      this._connectPreviewCallbacks();
      await this.audioPreview.previewAllChannels(this.midiData, channelConfigs, 0);
      this._previewState = 'playing';
      this._updatePreviewUI();
      this._renderMinimap();
    } catch (err) {
      console.error('[Preview] previewAll failed:', err);
      this._previewState = 'stopped';
      this._updatePreviewUI();
      this._showPreviewError(err.message);
    }
  }

  async _previewChannel(channel) {
    if (!this.audioPreview || !this.midiData) {
      console.warn('[Preview] No audioPreview or midiData available');
      return;
    }
    if (channel === null || channel === undefined) {
      console.warn('[Preview] No channel selected');
      return;
    }
    this._safeStopPreview();
    this._previewMode = 'channel';
    this._previewingChannel = channel;

    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const adapt = this.adaptationSettings[ch] || {};
    const transposition = { semitones: adapt.transpositionSemitones || 0 };

    // Build instrument constraints — pass empty object (not null) so AudioPreview
    // still initializes the synthesizer and creates a valid sequence
    const constraints = assignment ? {
      gmProgram: assignment.gmProgram,
      noteRangeMin: assignment.noteRangeMin,
      noteRangeMax: assignment.noteRangeMax,
      noteSelectionMode: assignment.noteSelectionMode || undefined,
      selectedNotes: assignment.selectedNotes || undefined
    } : {};

    try {
      this._connectPreviewCallbacks();
      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, transposition, constraints, 0, 0, true
      );
      this._previewState = 'playing';
      this._updatePreviewUI();
      this._renderMinimap();
    } catch (err) {
      console.error('[Preview] previewChannel failed:', err);
      this._previewState = 'stopped';
      this._updatePreviewUI();
      this._showPreviewError(err.message);
    }
  }

  async _previewOriginal(channel) {
    if (!this.audioPreview || !this.midiData) {
      console.warn('[Preview] No audioPreview or midiData available');
      return;
    }
    this._safeStopPreview();
    this._previewMode = 'original';
    this._previewingChannel = channel;

    try {
      this._connectPreviewCallbacks();
      await this.audioPreview.previewOriginal(this.midiData, 0, 0, true);
      this._previewState = 'playing';
      this._updatePreviewUI();
      this._renderMinimap();
    } catch (err) {
      console.error('[Preview] previewOriginal failed:', err);
      this._previewState = 'stopped';
      this._updatePreviewUI();
      this._showPreviewError(err.message);
    }
  }

  _pausePreview() {
    if (!this.audioPreview) return;
    try { this.audioPreview.pause(); } catch (e) { /* ignore */ }
    this._previewState = 'paused';
    this._updatePreviewUI();
  }

  _resumePreview() {
    if (!this.audioPreview) return;
    try { this.audioPreview.resume(); } catch (e) { /* ignore */ }
    this._previewState = 'playing';
    this._updatePreviewUI();
  }

  _safeStopPreview() {
    if (this.audioPreview?.isPreviewing || this.audioPreview?.isPlaying) {
      try { this.audioPreview.stop(); } catch (e) { /* ignore */ }
    }
    this._previewState = 'stopped';
    this._previewMode = null;
  }

  _stopPreview() {
    this._safeStopPreview();
    this._updatePreviewUI();
  }

  _showPreviewError(msg) {
    const timeEl = this.modal?.querySelector('#rsPreviewTime');
    if (timeEl) {
      timeEl.textContent = msg || 'Preview error';
      timeEl.style.color = '#e74c3c';
      setTimeout(() => { if (timeEl) { timeEl.textContent = ''; timeEl.style.color = ''; } }, 4000);
    }
  }

  _connectPreviewCallbacks() {
    if (!this.audioPreview) return;
    this.audioPreview.onProgress = (currentTick, totalTicks, currentSec, totalSec) => {
      // Update time display
      const timeEl = this.modal?.querySelector('#rsPreviewTime');
      if (timeEl) {
        const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        timeEl.textContent = `${fmt(currentSec)} / ${fmt(totalSec)}`;
      }
      // Update minimap playhead
      const pct = totalTicks > 0 ? currentTick / totalTicks : 0;
      this._drawMinimapFrame(pct);
    };
    this.audioPreview.onPlaybackEnd = () => {
      this._previewState = 'stopped';
      this._updatePreviewUI();
      this._drawMinimapFrame(0);
    };
  }

  _updatePreviewUI() {
    const modal = this.modal;
    if (!modal) return;
    const playing = this._previewState === 'playing';
    const paused = this._previewState === 'paused';
    const active = playing || paused;

    const allBtn = modal.querySelector('#rsPreviewAllBtn');
    const chBtn = modal.querySelector('#rsPreviewChBtn');
    const origBtn = modal.querySelector('#rsPreviewOrigBtn');
    const pauseBtn = modal.querySelector('#rsPreviewPauseBtn');
    const stopBtn = modal.querySelector('#rsPreviewStopBtn');

    if (allBtn) allBtn.style.display = active ? 'none' : '';
    if (chBtn) chBtn.style.display = active ? 'none' : '';
    if (origBtn) origBtn.style.display = active ? 'none' : '';
    if (pauseBtn) { pauseBtn.style.display = active ? '' : 'none'; pauseBtn.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;'; }
    if (stopBtn) stopBtn.style.display = active ? '' : 'none';
  }

  // ============================================================================
  // Recalculate
  // ============================================================================

  async _recalculate() {
    this.loading = true;
    this._showLoading();

    try {
      let excludeVirtual = true;
      try {
        const saved = JSON.parse(localStorage.getItem('maestro_settings') || '{}');
        if (saved.virtualInstrument) excludeVirtual = false;
      } catch (e) { /* ignore */ }

      const response = await this.api.sendCommand('generate_assignment_suggestions', {
        fileId: this.fileId,
        topN: 5,
        minScore: this.scoringOverrides.scoreThresholds?.minimum || 30,
        excludeVirtual: excludeVirtual,
        includeMatrix: false,
        scoringOverrides: this.scoringOverrides
      });

      if (!response.success) {
        this._showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      // Reset state with new results
      this.suggestions = response.suggestions || {};
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection || {};
      this.confidenceScore = response.confidenceScore || 0;
      this.splitProposals = response.splitProposals || {};
      this.allInstruments = response.allInstruments || [];
      this.channelAnalyses = {};
      if (response.channelAnalyses) {
        for (const analysis of response.channelAnalyses) {
          this.channelAnalyses[analysis.channel] = analysis;
        }
      }

      const autoSkippedChannels = this.autoSelection._autoSkipped || [];
      delete this.autoSelection._autoSkipped;
      this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
      this.skippedChannels = new Set(autoSkippedChannels);
      this.autoSkippedChannels = new Set(autoSkippedChannels);
      this.splitChannels = new Set();
      this.splitAssignments = {};

      // Enrich assignments
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

      // Re-init adaptation settings
      const channelKeys = Object.keys(this.suggestions);
      for (const ch of channelKeys) {
        const assignment = this.selectedAssignments[ch];
        this.adaptationSettings[ch] = {
          pitchShift: assignment?.transposition?.semitones ? 'auto' : 'none',
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          oorHandling: 'passThrough'
        };
      }

      this.loading = false;
      this._renderContent();
    } catch (error) {
      this._showError(error.message || _t('autoAssign.generateFailed'));
    }
  }

  // ============================================================================
  // Close / cleanup
  // ============================================================================

  close() {
    this._stopPreview();
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    this._minimapCanvas = null;
    document.body.style.overflow = this._prevBodyOverflow || '';
  }
}

window.RoutingSummaryPage = RoutingSummaryPage;
})();
