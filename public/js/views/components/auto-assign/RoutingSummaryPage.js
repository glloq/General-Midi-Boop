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
  return NOTE_NAMES[note % 12] + Math.floor(note / 12);
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
    this.ccRemapping = {}; // Per-channel CC remapping { [channel]: { sourceCC: targetCC, ... } }
    this.showLowScores = {}; // Per-channel toggle for low score instruments
    this.autoAdaptation = true; // Toggle for automatic MIDI channel adaptation

    // Preview state
    this.midiData = null;
    this.audioPreview = null;
    this._previewState = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this._previewMode = null; // 'all' | 'channel' | 'original'
    this._previewingChannel = null;
    this._minimapCanvas = null;
    this._minimapBuckets = null;       // Single: Array<bool>, Multi: Map<ch, Array<bool>>
    this._minimapChannels = [];        // Sorted unique channel numbers
    this._minimapMultiChannel = false;
    this._minimapWidth = 0;
    this._minimapHeight = 0;
    this._minimapTotalTicks = 0;

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

      // Generate auto-assignment suggestions (splits disabled — user adds instruments manually)
      const response = await this.api.sendCommand('generate_assignment_suggestions', {
        fileId: fileId,
        topN: 5,
        minScore: 30,
        excludeVirtual: excludeVirtual,
        includeMatrix: false,
        scoringOverrides: {
          ...this.scoringOverrides,
          splitting: { ...(this.scoringOverrides?.splitting || {}), triggerBelowScore: 0 }
        }
      });

      if (!response.success) {
        this._showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      // Store results (splitProposals cleared — multi-instrument is user-driven)
      this.suggestions = response.suggestions || {};
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection || {};
      this.confidenceScore = response.confidenceScore || 0;
      this.splitProposals = {};
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
        const inst = matched?.instrument
          || (this.allInstruments || []).find(i => i.id === assignment.instrumentId);
        if (inst) {
          assignment.gmProgram = inst.gm_program;
          assignment.noteRangeMin = inst.note_range_min;
          assignment.noteRangeMax = inst.note_range_max;
          assignment.noteSelectionMode = inst.note_selection_mode;
          assignment.polyphony = inst.polyphony;
          // supportedCcs: prefer allInstruments (always has full DB data incl. supported_ccs)
          const fullInst = (this.allInstruments || []).find(i => i.id === assignment.instrumentId);
          assignment.supportedCcs = fullInst?.supported_ccs || inst.supported_ccs || null;
          if (!assignment.customName) {
            assignment.customName = inst.custom_name || null;
          }
          assignment.instrumentDisplayName = this._getInstrumentDisplayName(inst);
        }
        // Store scoreBreakdown from compatibility data
        if (matched?.compatibility?.scoreBreakdown) {
          assignment.scoreBreakdown = matched.compatibility.scoreBreakdown;
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
    // Guard against re-entrant calls: _bindEvents() can trigger synthetic change
    // events on pre-checked radios / pre-selected selects, whose handlers call
    // _refreshUI() → _renderContent() again → infinite loop → browser freeze.
    // This guard protects ALL call sites (show(), _refreshUI(), etc.).
    if (this._isRendering) return;
    this._isRendering = true;
    try {
      // Save scroll positions before re-render
      const summaryPanel = this.modal.querySelector('#rsSummaryPanel');
      const detailPanel = this.modal.querySelector('#rsDetailPanel');
      const savedSummaryScroll = summaryPanel?.scrollTop || 0;
      const savedDetailScroll = detailPanel?.scrollTop || 0;

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
                ${(() => {
                  const displayScore = this._getDisplayScore();
                  const scoreLabel = this.selectedChannel !== null
                    ? `Ch ${this.selectedChannel + 1} : ${displayScore}/100`
                    : `${displayScore}/100 — ${getScoreLabel(displayScore)}`;
                  return `<div class="rs-score-wrapper">
                    <button class="rs-score-btn ${getScoreBgClass(displayScore)}" id="rsScoreBtn" title="${_t('routingSummary.clickForDetails') || 'Cliquer pour voir le détail'}">
                      ${scoreLabel}
                    </button>
                    <div class="rs-score-popup" id="rsScorePopup" style="display:none">
                      ${this._renderScoreDetail()}
                    </div>
                  </div>`;
                })()}
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

      // Restore scroll positions after re-render
      const newSummary = this.modal.querySelector('#rsSummaryPanel');
      const newDetail = this.modal.querySelector('#rsDetailPanel');
      if (newSummary) newSummary.scrollTop = savedSummaryScroll;
      if (newDetail) newDetail.scrollTop = savedDetailScroll;
    } finally {
      this._isRendering = false;
    }
  }

  // ============================================================================
  // Score detail popup
  // ============================================================================

  _renderScoreDetail() {
    const allKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    // In detail mode, show only the selected channel
    const channelKeys = this.selectedChannel !== null
      ? allKeys.filter(ch => parseInt(ch) === this.selectedChannel)
      : allKeys;
    if (channelKeys.length === 0) return `<div class="rs-score-empty">${_t('routingSummary.noChannels') || 'Aucun canal'}</div>`;

    const breakdownLabels = {
      program: _t('autoAssign.scoreProgram') || 'Programme',
      noteRange: _t('autoAssign.scoreNoteRange') || 'Tessiture',
      polyphony: _t('autoAssign.scorePolyphony') || 'Polyphonie',
      ccSupport: _t('autoAssign.scoreCcSupport') || 'CC Support',
      instrumentType: _t('autoAssign.scoreInstrumentType') || 'Type',
      percussion: _t('autoAssign.scorePercussion') || 'Percussion'
    };

    const rows = channelKeys.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = this.skippedChannels.has(channel);
      const assignment = this.selectedAssignments[ch];
      const analysis = this.channelAnalyses[channel];
      const score = assignment?.score || 0;
      const gmName = channel === 9
        ? (_t('autoAssign.drums') || 'Drums')
        : (getGmProgramName(analysis?.primaryProgram) || '\u2014');
      const instName = isSkipped
        ? `<span class="rs-score-muted">${_t('routingSummary.muted') || 'Muté'}</span>`
        : escapeHtml(assignment?.instrumentDisplayName || assignment?.customName || assignment?.instrumentName || '\u2014');

      // Score breakdown bars
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
          }).join('') +
          `</div>`;
      }

      // Issues
      const issues = (!isSkipped && assignment?.issues?.length)
        ? `<div class="rs-score-issues">${assignment.issues.map(i =>
            `<span class="rs-score-issue rs-score-issue-${i.type || 'warning'}">${escapeHtml(i.message)}</span>`
          ).join('')}</div>`
        : '';

      return `<div class="rs-score-row ${isSkipped ? 'rs-score-row-skipped' : ''}">
        <div class="rs-score-row-header">
          <span class="rs-score-row-ch">CH ${channel + 1}</span>
          <span class="rs-score-row-gm">${escapeHtml(gmName)}</span>
          <span class="rs-score-row-arrow">\u2192</span>
          <span class="rs-score-row-inst">${instName}</span>
          <span class="rs-score-row-score ${getScoreClass(score)}">${isSkipped ? '\u2014' : score}</span>
        </div>
        ${breakdownHtml}${issues}
      </div>`;
    }).join('');

    return `<div class="rs-score-detail-content">${rows}</div>`;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Get the score to display in the header button.
   * - Summary mode (no channel selected): average of all non-skipped channel scores
   * - Detail mode (channel selected): score of the selected channel
   */
  _getDisplayScore() {
    if (this.selectedChannel !== null) {
      const ch = String(this.selectedChannel);
      const isSplit = this.splitChannels.has(this.selectedChannel);
      return isSplit
        ? (this.splitAssignments[this.selectedChannel]?.quality || 0)
        : (this.selectedAssignments[ch]?.score || 0);
    }
    // Average of all non-skipped channel scores
    const channelKeys = Object.keys(this.suggestions);
    let total = 0, count = 0;
    for (const ch of channelKeys) {
      const channel = parseInt(ch);
      if (this.skippedChannels.has(channel)) continue;
      const isSplit = this.splitChannels.has(channel);
      const score = isSplit
        ? (this.splitAssignments[channel]?.quality || 0)
        : (this.selectedAssignments[ch]?.score || 0);
      total += score;
      count++;
    }
    return count > 0 ? Math.round(total / count) : 0;
  }

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
   * Get max polyphony used by a MIDI channel from analysis data.
   * Handles both { max, avg } objects and raw number formats.
   */
  _getChannelPolyphony(channel) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[parseInt(channel)] || this.selectedAssignments[ch]?.channelAnalysis;
    if (!analysis?.polyphony) return null;
    if (typeof analysis.polyphony === 'number') return analysis.polyphony;
    return analysis.polyphony.max ?? null;
  }

  /**
   * Get total polyphony capacity of assigned instrument(s) for a channel.
   */
  _getInstrumentPolyphony(channel) {
    const ch = String(channel);
    const chNum = parseInt(channel);
    if (this.splitChannels.has(chNum) && this.splitAssignments[chNum]) {
      return (this.splitAssignments[chNum].segments || []).reduce((s, seg) => {
        // Look up instrument polyphony from allInstruments
        const inst = (this.allInstruments || []).find(i => i.id === seg.instrumentId);
        return s + (inst?.polyphony || seg.polyphonyShare || 16);
      }, 0);
    }
    const assignment = this.selectedAssignments[ch];
    if (!assignment) return null;
    // Prefer allInstruments data (always populated from DB)
    const inst = (this.allInstruments || []).find(i => i.id === assignment.instrumentId);
    return inst?.polyphony || assignment.polyphony || null;
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
    const isCondensed = this.selectedChannel !== null;

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

      // Condensed mode: show only channel, GM, routed instrument name, mute button
      if (isCondensed) {
        // Get routed instrument name(s)
        let routedName = '';
        if (isSkipped) {
          routedName = `<span class="rs-skipped-condensed">${_t('routingSummary.muted') || 'Muté'}</span>`;
        } else if (isSplit && this.splitAssignments[channel]) {
          const segments = this.splitAssignments[channel].segments || [];
          routedName = segments.map(seg => seg.instrumentName || '?').join(' + ');
        } else if (assignment?.instrumentName || assignment?.customName) {
          routedName = assignment.customName || assignment.instrumentName;
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
            <td class="rs-col-gm-condensed" title="${escapeHtml(gmName)}">${escapeHtml(gmName)}</td>
            <td class="rs-col-routed-condensed" title="${typeof routedName === 'string' ? escapeHtml(routedName) : ''}">${routedName}</td>
            <td class="rs-col-mute-condensed">
              ${!isSkipped
                ? `<button class="btn btn-sm rs-btn-skip rs-btn-mute" data-channel="${channel}" title="${_t('routingSummary.skip') || 'Muter'}">🔊</button>`
                : `<button class="btn btn-sm rs-btn-unskip rs-btn-unmute" data-channel="${channel}" title="${_t('routingSummary.unskip') || 'Activer'}">🔇</button>`}
            </td>
          </tr>
        `;
      }

      // Full mode: dropdown, score, polyphony, playable, actions
      let assignedHTML;
      if (isSkipped) {
        assignedHTML = `<span class="rs-skipped">${_t('autoAssign.overviewStatusSkipped')}</span>`;
      } else if (isSplit && this.splitAssignments[channel]) {
        const segments = this.splitAssignments[channel].segments || [];
        const splitParts = segments.map((seg, i) => {
          const color = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'][i % 4];
          const name = seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument';
          const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
          return `<span class="rs-split-inst-name" style="color:${color}" title="${escapeHtml(name)}">${escapeHtml(displayName)}</span>`;
        });
        assignedHTML = `<div class="rs-split-instruments">${splitParts.join('<span class="rs-split-sep">+</span>')}</div>`;
      } else {
        assignedHTML = `<div class="rs-select-zone"><select class="rs-instrument-select" data-channel="${ch}">${this._buildInstrumentOptions(ch, assignment, isSkipped)}</select></div>`;
      }

      // Score column
      const scoreHTML = (!isSkipped && score > 0) ? `<span class="rs-score-value ${getScoreClass(score)}">${score}</span>` : '';

      // Polyphony column: instrument capacity / channel polyphony
      let polyHTML = '';
      if (!isSkipped) {
        const chPoly = this._getChannelPolyphony(channel);
        const instPoly = this._getInstrumentPolyphony(channel);
        if (chPoly && instPoly) {
          const ok = instPoly >= chPoly;
          polyHTML = `<span class="rs-poly-cell ${ok ? 'rs-poly-ok' : 'rs-poly-warn'}">${instPoly}/${chPoly}</span>`;
        }
      }

      // Playable notes column
      let playableHTML = '';
      if (!isSkipped) {
        const playableInfo = this._computePlayableNotes(ch);
        if (playableInfo) {
          const ok = playableInfo.playable === playableInfo.total;
          playableHTML = `<span class="rs-playable-cell ${ok ? 'rs-poly-ok' : 'rs-poly-warn'}">${playableInfo.playable}/${playableInfo.total}</span>`;
        }
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
          <td class="rs-col-poly">${polyHTML}</td>
          <td class="rs-col-playable">${playableHTML}</td>
          <td class="rs-col-actions">
            ${!isSkipped ? `<button class="btn btn-sm rs-btn-skip rs-btn-mute" data-channel="${channel}" title="${_t('routingSummary.skip')}">🔊</button>` : `<button class="btn btn-sm rs-btn-unskip rs-btn-unmute" data-channel="${channel}" title="${_t('routingSummary.unskip')}">🔇</button>`}
          </td>
        </tr>
      `;
    }).join('');

    // Condensed header (when detail panel open)
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

    // Full table (no detail panel open)
    return `
      <div class="rs-table-wrapper">
        <table class="rs-table">
          <thead>
            <tr>
              <th>${_t('autoAssign.overviewChannel')}</th>
              <th>${_t('autoAssign.overviewOriginal')}</th>
              <th>${_t('autoAssign.overviewAssigned')}</th>
              <th>${_t('routingSummary.score') || 'Score'}</th>
              <th title="${_t('autoAssign.polyphony') || 'Polyphonie'}">\u266B</th>
              <th title="${_t('autoAssign.channelNotes') || 'Notes jouables'}">\u266A</th>
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
    const assignedName = assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || null;

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
          ${pitchShift === 'manual' ? (() => {
            const playableWithTranspose = this._computePlayableNotes(channel);
            const playableLabel = playableWithTranspose
              ? `<span class="rs-transpose-playable">${playableWithTranspose.playable}/${playableWithTranspose.total}</span>`
              : '';
            return `
            <div class="rs-adapt-row rs-transpose-row">
              <span class="rs-adapt-label">${_t('autoAssign.transposition')}</span>
              <div class="rs-transpose-controls">
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="-12">-12</button>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="-1">-1</button>
                <span class="rs-transpose-value">${semitones > 0 ? '+' : ''}${semitones}st ${playableLabel}</span>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="1">+1</button>
                <button class="btn btn-sm rs-transpose-btn" data-channel="${channel}" data-delta="12">+12</button>
              </div>
            </div>`;
          })() : ''}
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

    // Split section — only render if multi-instrument is active (user-accepted)
    let splitHTML = '';
    if (isSplit && this.splitAssignments[channel]) {
      const expanded = this.splitExpanded[channel] ?? true;
      const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
      const activeData = this.splitAssignments[channel];
      const segments = activeData.segments || [];
      const activeMode = activeData.type;

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
      const currentStrategy = activeData?.overlapStrategy || null;
      const overlapsHTML = overlaps.map((ov, idx) => {
        const nameA = segments[ov.segA]?.instrumentName || `Inst ${ov.segA + 1}`;
        const nameB = segments[ov.segB]?.instrumentName || `Inst ${ov.segB + 1}`;
        const sharedLabel = _t('autoAssign.splitMixed') || 'Les deux';
        const sharedActive = currentStrategy === 'shared' ? ' rs-overlap-btn-active' : '';
        return `
          <div class="rs-overlap-warning ${currentStrategy === 'shared' ? 'rs-overlap-shared' : ''}">
            <span>${currentStrategy === 'shared' ? '🔀' : '\u26A0'} ${midiNoteToName(ov.min)}-${midiNoteToName(ov.max)}: ${escapeHtml(nameA)} / ${escapeHtml(nameB)}${currentStrategy === 'shared' ? ' <em class="rs-overlap-shared-label">(' + sharedLabel + ')</em>' : ''}</span>
            <div class="rs-overlap-btns">
              <button class="btn btn-sm rs-overlap-resolve-btn" data-channel="${channel}" data-overlap="${idx}" data-strategy="first">${escapeHtml(nameA)}</button>
              <button class="btn btn-sm rs-overlap-resolve-btn" data-channel="${channel}" data-overlap="${idx}" data-strategy="second">${escapeHtml(nameB)}</button>
              <button class="btn btn-sm rs-overlap-resolve-btn${sharedActive}" data-channel="${channel}" data-overlap="${idx}" data-strategy="shared">${sharedLabel}</button>
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

      const actionsHTML = `
        <div class="rs-split-actions">
          <button class="btn btn-sm rs-btn-add-segment" data-channel="${channel}">+ ${_t('routingSummary.addInstrument') || 'Ajouter instrument'}</button>
          <button class="btn btn-sm rs-btn-remove-split" data-channel="${channel}">${_t('routingSummary.removeMulti') || 'Retirer multi-instrument'}</button>
        </div>
      `;

      const segCount = segments.length;

      splitHTML = `
        <div class="rs-split-section active">
          <div class="rs-split-header" data-channel="${channel}">
            <span class="rs-split-toggle">${expanded ? '\u25BE' : '\u25B8'}</span>
            <span>${_t('routingSummary.multiInstrument') || 'Multi-instrument'} (${segCount})</span>
            <button class="btn btn-sm rs-btn-remove-split rs-split-toggle-btn" data-channel="${channel}" title="${_t('routingSummary.removeMulti') || 'Retirer multi-instrument'}">\u2716</button>
          </div>
          <div class="rs-split-body ${expanded ? '' : 'collapsed'}">
            ${renderSplitBar(activeData, analysis)}
            <div class="rs-split-segments">${segCardsHTML}</div>
            ${overlapsHTML}
            ${uncoveredHTML}
            ${actionsHTML}
          </div>
        </div>
      `;
    }

    // "Add instrument" button — visible when single instrument assigned, no split active
    let addInstrumentHTML = '';
    if (!isSplit && !isSkipped && assignment?.instrumentId) {
      addInstrumentHTML = `<button class="btn btn-sm rs-btn-add-multi" data-channel="${channel}">+ ${_t('routingSummary.addInstrument') || 'Ajouter instrument'}</button>`;
    }

    // Smart split suggestion — show when score is low and a split proposal exists
    let splitSuggestionHTML = '';
    if (!isSplit && !isSkipped && score > 0 && score < 60 && hasSplitProposal) {
      const proposal = this.splitProposals[channel];
      const estimatedQuality = proposal?.quality ? Math.round(proposal.quality) : null;
      const qualityLabel = estimatedQuality ? ` (${_t('autoAssign.estimatedScore') || 'score estimé'}: ${estimatedQuality})` : '';
      splitSuggestionHTML = `
        <div class="rs-split-suggestion">
          <span class="rs-split-suggestion-icon">💡</span>
          <span class="rs-split-suggestion-text">${_t('autoAssign.splitSuggestion') || 'Score faible — essayez le mode multi-instrument'}${qualityLabel}</span>
          <button class="btn btn-sm rs-btn-try-split" data-channel="${channel}">${_t('autoAssign.trySplit') || 'Essayer'}</button>
        </div>
      `;
    }

    // Build route display for title
    let routeHTML;
    if (isSplit && this.splitAssignments[channel]) {
      const segments = this.splitAssignments[channel].segments || [];
      const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
      routeHTML = escapeHtml(gmName) + ' \u2192 ' + segments.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument';
        return `<strong style="color:${color}">${escapeHtml(name)}</strong>`;
      }).join(' + ');
    } else {
      routeHTML = `${escapeHtml(gmName)}${assignedName ? ` \u2192 <strong>${escapeHtml(assignedName)}</strong>` : ''}`;
    }

    // Polyphony info: instrument(s) capacity vs channel usage
    let polyHTML = '';
    const channelPoly = this._getChannelPolyphony(channel);
    const instPoly = this._getInstrumentPolyphony(channel);
    if (channelPoly && instPoly) {
      const polyOk = instPoly >= channelPoly;
      polyHTML = `<span class="rs-detail-poly ${polyOk ? 'rs-poly-ok' : 'rs-poly-warn'}" title="${_t('autoAssign.polyphony') || 'Polyphonie'}">\u266B ${instPoly}/${channelPoly}</span>`;
    }

    return `
      <div class="rs-detail-content">
        <div class="rs-detail-header">
          <div class="rs-detail-title">
            <span class="rs-detail-ch">${typeIcon} Ch ${channel + 1}${channel === 9 ? ' DR' : ''}</span>
            <span class="rs-detail-route">${routeHTML}</span>
            ${score > 0 ? `<span class="rs-detail-score ${getScoreClass(score)}">${score}</span>` : ''}
            ${polyHTML}
            ${playableInfo ? `<span class="rs-detail-playable">${playableInfo}</span>` : ''}
          </div>
          <button class="btn btn-sm rs-detail-close" id="rsDetailClose">&times;</button>
        </div>

        ${rangeBarsHTML}
        ${instrumentChipsHTML}
        ${adaptHTML}
        ${splitSuggestionHTML}
        ${splitHTML}
        ${addInstrumentHTML}
        ${this._renderCCSection(channel)}
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
      // Add overlap zone visualization inside a positioned wrapper
      const overlaps = this._detectOverlaps(segs);
      const overlapZonesHTML = overlaps.length > 0 ? overlaps.map(ov => {
        const oLeft = (ov.min / FULL_RANGE) * 100;
        const oWidth = Math.max(0.5, ((ov.max - ov.min) / FULL_RANGE) * 100);
        const nameA = segs[ov.segA]?.instrumentName || `Inst ${ov.segA + 1}`;
        const nameB = segs[ov.segB]?.instrumentName || `Inst ${ov.segB + 1}`;
        return `<div class="rs-range-overlap-zone" style="left:${oLeft}%;width:${oWidth}%" title="\u26A0 ${_t('routingSummary.overlap') || 'Superposition'}: ${midiNoteToName(ov.min)}-${midiNoteToName(ov.max)} (${escapeHtml(nameA)} / ${escapeHtml(nameB)})"></div>`;
      }).join('') : '';

      // Wrap inst bars + overlap zones in positioned container
      instBarsHTML = `<div class="rs-range-inst-area">${instBarsHTML}${overlapZonesHTML}</div>`;

      legendItems = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || `Inst ${i + 1}`;
        return `<span class="rs-range-legend-item"><span class="rs-range-legend-key" style="background:${color}80;border:1px solid ${color}"></span>${escapeHtml(name)}</span>`;
      }).join('');
      if (overlaps.length > 0) {
        legendItems += `<span class="rs-range-legend-item"><span class="rs-range-legend-key" style="background:repeating-linear-gradient(45deg,rgba(245,158,11,0.3),rgba(245,158,11,0.3) 2px,transparent 2px,transparent 4px);border:1px dashed #f59e0b"></span>${_t('routingSummary.overlap') || 'Superposition'}</span>`;
      }
    } else if (assignment?.noteRangeMin != null) {
      // Single instrument
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

    // Score detail popup toggle
    const scoreEl = modal.querySelector('#rsScoreBtn');
    const popupEl = modal.querySelector('#rsScorePopup');
    if (scoreEl && popupEl) {
      scoreEl.addEventListener('click', (e) => {
        e.stopPropagation();
        popupEl.style.display = popupEl.style.display === 'none' ? '' : 'none';
      });
      popupEl.addEventListener('click', (e) => e.stopPropagation());
      // Close popup when clicking anywhere else in modal
      modal.addEventListener('click', () => {
        if (popupEl.style.display !== 'none') popupEl.style.display = 'none';
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
        e.stopPropagation();
        const ch = sel.dataset.channel;
        const instId = sel.value;
        if (instId) this._selectInstrument(ch, instId, channelKeys);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
    });

    // Select zone: click anywhere in the zone opens the dropdown (not the detail panel)
    modal.querySelectorAll('.rs-select-zone').forEach(zone => {
      zone.addEventListener('click', (e) => {
        e.stopPropagation();
        const sel = zone.querySelector('.rs-instrument-select');
        if (sel && e.target !== sel) {
          sel.focus();
          sel.showPicker?.();
        }
      });
    });

    // Row clicks — select channel for detail (replaces gear button)
    modal.querySelectorAll('.rs-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger on button/select/zone clicks
        if (e.target.closest('.rs-btn-skip, .rs-btn-unskip, .rs-instrument-select, .rs-select-zone')) return;
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

    // Add instrument button (multi-instrument)
    modal.querySelectorAll('.rs-btn-add-multi').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        this._addInstrumentToChannel(ch, channelKeys);
      });
    });

    // Smart split suggestion — "try split" button
    modal.querySelectorAll('.rs-btn-try-split').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = parseInt(btn.dataset.channel);
        const proposal = this.splitProposals[ch];
        if (proposal) {
          this.splitChannels.add(ch);
          this.splitAssignments[ch] = { ...proposal };
          this._refreshUI(channelKeys);
        }
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
          // Skip if value hasn't actually changed (prevents re-render loop from
          // synthetic change events fired by browser on pre-checked radios)
          if (radio.value === this.adaptationSettings[ch]?.[field]) return;

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
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent bubble to .rs-split-header toggle handler
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

    // CC remapping dropdowns
    modal.querySelectorAll('.rs-cc-remap').forEach(sel => {
      sel.addEventListener('change', () => {
        const ch = sel.dataset.channel;
        const sourceCC = parseInt(sel.dataset.source);
        const targetCC = sel.value ? parseInt(sel.value) : null;
        if (!this.ccRemapping[ch]) this.ccRemapping[ch] = {};
        if (targetCC !== null) {
          this.ccRemapping[ch][sourceCC] = targetCC;
        } else {
          delete this.ccRemapping[ch][sourceCC];
          if (Object.keys(this.ccRemapping[ch]).length === 0) delete this.ccRemapping[ch];
        }
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
    return null;
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

    // Store the overlap strategy on the split data for persistence
    data.overlapStrategy = strategy;
    this.splitEdited[channel] = true;

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
      instrumentName: selected.instrument.name,
      customName: selected.instrument.custom_name,
      instrumentDisplayName: this._getInstrumentDisplayName(selected.instrument),
      score: selected.compatibility.score,
      transposition: selected.compatibility.transposition,
      noteRemapping: selected.compatibility.noteRemapping,
      issues: selected.compatibility.issues,
      info: selected.compatibility.info,
      scoreBreakdown: selected.compatibility.scoreBreakdown || null,
      gmProgram: selected.instrument.gm_program,
      noteRangeMin: selected.instrument.note_range_min,
      noteRangeMax: selected.instrument.note_range_max,
      noteSelectionMode: selected.instrument.note_selection_mode,
      polyphony: selected.instrument.polyphony,
      supportedCcs: selected.instrument.supported_ccs
        || ((this.allInstruments || []).find(i => i.id === instrumentId))?.supported_ccs
        || null,
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
    // Legacy: accept a backend proposal (kept for compatibility)
    const proposal = this.splitProposals[channel];
    if (!proposal) return;
    const activeMode = this.activeSplitMode[channel] || proposal.type;
    const allModes = [proposal, ...(proposal.alternatives || [])];
    const chosen = allModes.find(m => m.type === activeMode) || proposal;
    this.splitChannels.add(channel);
    this.splitAssignments[channel] = JSON.parse(JSON.stringify(chosen));
    this._refreshUI(channelKeys);
  }

  /**
   * Add a second instrument to a channel (user-driven multi-instrument).
   * Creates a split from the current single assignment + a new instrument.
   */
  _addInstrumentToChannel(channel, channelKeys) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const analysis = this.channelAnalyses[channel];
    if (!assignment?.instrumentId) return;

    // Segment for the currently assigned instrument
    const currentSeg = {
      instrumentId: assignment.instrumentId,
      deviceId: assignment.deviceId,
      instrumentChannel: assignment.instrumentChannel,
      instrumentName: assignment.customName || getGmProgramName(assignment.gmProgram) || assignment.instrumentName,
      gmProgram: assignment.gmProgram,
      noteRange: { min: analysis?.noteRange?.min ?? 0, max: analysis?.noteRange?.max ?? 127 },
      fullRange: { min: assignment.noteRangeMin ?? 0, max: assignment.noteRangeMax ?? 127 }
    };

    // Find a compatible second instrument
    const candidates = this._getCompatibleInstrumentsForSegment(ch, analysis?.noteRange || { min: 0, max: 127 });
    const secondInst = candidates.find(c => c.id !== assignment.instrumentId);
    const secondSeg = secondInst ? {
      instrumentId: secondInst.id,
      deviceId: secondInst.device_id,
      instrumentChannel: secondInst.channel,
      instrumentName: this._getInstrumentDisplayName(secondInst),
      gmProgram: secondInst.gm_program,
      noteRange: { min: analysis?.noteRange?.min ?? 0, max: analysis?.noteRange?.max ?? 127 },
      fullRange: { min: secondInst.note_range_min ?? 0, max: secondInst.note_range_max ?? 127 }
    } : { ...currentSeg }; // Duplicate if nothing else available

    this.splitChannels.add(channel);
    this.splitAssignments[channel] = {
      type: 'range',
      quality: 0,
      overlapStrategy: 'shared',
      segments: [currentSeg, secondSeg]
    };
    this.splitExpanded[channel] = true;
    this._refreshUI(channelKeys);
  }

  _refreshUI(channelKeys) {
    // Stop any active preview since the view is changing
    this._safeStopPreview();
    // Invalidate canvas ref before re-render (prevents drawing to detached canvas)
    this._minimapCanvas = null;
    // Re-render the content area (preserving modal shell)
    // _renderContent() has its own re-entrancy guard and schedules minimap via _bindPreviewEvents()
    this._renderContent();
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
        score: assignment.score,
        ccRemapping: this.ccRemapping[ch] || null
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
        overlapStrategy: splitData.overlapStrategy || null,
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

    // Detect if physical file modifications are needed
    let hasTransposition = false;
    let hasOorSuppression = false;
    let hasCCRemap = false;
    for (const [ch, a] of Object.entries(assignments)) {
      if (a.transposition?.semitones && a.transposition.semitones !== 0) hasTransposition = true;
      if (a.suppressOutOfRange) hasOorSuppression = true;
      if (a.noteCompression) hasOorSuppression = true;
      if (a.ccRemapping && Object.keys(a.ccRemapping).length > 0) hasCCRemap = true;
    }
    const needsFileModification = hasSplit || hasTransposition || hasOorSuppression || hasCCRemap;

    // Ask user how to save if file modification is needed
    let overwriteOriginal = false;
    if (needsFileModification && typeof showConfirm === 'function') {
      const splitInfo = hasSplit ? (_t('routingSummary.splitChannelInfo') || 'Des canaux seront dupliqués pour le multi-instrument.') + ' ' : '';
      const transposeInfo = hasTransposition ? (_t('routingSummary.transposeInfo') || 'Des transpositions seront appliquées.') + ' ' : '';

      // Build custom 3-button dialog
      const dialogResult = await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay rs-save-dialog-overlay';
        overlay.innerHTML = `
          <div class="modal-content rs-save-dialog">
            <div class="modal-header">
              <h2>${_t('routingSummary.saveDialogTitle') || 'Enregistrer le routage'}</h2>
            </div>
            <div class="rs-save-dialog-body">
              <p>${splitInfo}${transposeInfo}${_t('routingSummary.saveDialogMessage') || 'Le fichier MIDI doit être modifié. Comment souhaitez-vous enregistrer ?'}</p>
            </div>
            <div class="rs-save-dialog-buttons">
              <button class="btn" data-action="cancel">${_t('common.cancel') || 'Annuler'}</button>
              <button class="btn btn-primary" data-action="adapted">${_t('routingSummary.saveAsAdapted') || 'Version adaptée'}</button>
              <button class="btn btn-danger" data-action="overwrite">${_t('routingSummary.overwriteOriginal') || 'Écraser l\'original'}</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelectorAll('[data-action]').forEach(btn => {
          btn.addEventListener('click', () => {
            overlay.remove();
            resolve(btn.dataset.action);
          });
        });
      });

      if (dialogResult === 'cancel') return;
      overwriteOriginal = (dialogResult === 'overwrite');
    }

    try {
      // Use apply_assignments which handles both normal and split routings
      const result = await this.api.sendCommand('apply_assignments', {
        originalFileId: this.fileId,
        assignments,
        createAdaptedFile: needsFileModification,
        overwriteOriginal
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

      // Show warnings if any (e.g., insufficient free channels fallback)
      if (result?.warnings?.length > 0 && typeof showAlert === 'function') {
        await showAlert(result.warnings.join('\n'), {
          title: _t('routingSummary.warningsTitle') || 'Avertissements',
          icon: '⚠️'
        });
      }

      // Notify other components
      const effectiveFileId = result?.adaptedFileId || this.fileId;
      if (window.eventBus) {
        window.eventBus.emit('routing:changed', {
          fileId: effectiveFileId,
          channels: routing,
          hasSplits: hasSplit
        });
      }

      if (window.midiFileManager) {
        window.midiFileManager.refreshFileList();
      }

      if (this.onApplyCallback) {
        this.onApplyCallback({
          fileId: effectiveFileId,
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
  // CC Management
  // ============================================================================

  /**
   * Get CC name from InstrumentSettingsModal.CC_GROUPS lookup
   */
  _getCCName(ccNum) {
    if (typeof InstrumentSettingsModal !== 'undefined' && InstrumentSettingsModal.CC_GROUPS) {
      for (const group of Object.values(InstrumentSettingsModal.CC_GROUPS)) {
        if (group.ccs && group.ccs[ccNum]) {
          return group.ccs[ccNum].name;
        }
      }
    }
    return `CC ${ccNum}`;
  }

  /**
   * Render CC management section for a channel's detail panel
   */
  /**
   * Get supported CCs for a single instrument, searching allInstruments as fallback.
   * @returns {number[]|null} Array of CC numbers, or null if unknown
   */
  _getInstrumentCCs(instrumentId) {
    // Priority 1: allInstruments (always has full DB data)
    const fullInst = (this.allInstruments || []).find(i => i.id === instrumentId);
    if (fullInst?.supported_ccs) {
      return Array.isArray(fullInst.supported_ccs) ? fullInst.supported_ccs : JSON.parse(fullInst.supported_ccs || '[]');
    }
    // Priority 2: suggestions
    const found = this._findInstrumentById(instrumentId);
    if (found?.supported_ccs) {
      return Array.isArray(found.supported_ccs) ? found.supported_ccs : JSON.parse(found.supported_ccs || '[]');
    }
    return null;
  }

  _renderCCSection(channel) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel];
    const channelCCs = analysis?.usedCCs || [];
    const assignment = this.selectedAssignments[ch];
    const isSplit = this.splitChannels.has(channel);
    const isSkipped = this.skippedChannels.has(channel);

    if (isSkipped || (!assignment && !isSplit)) return '';
    if (channelCCs.length === 0) return '';

    const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
    const currentRemap = this.ccRemapping[ch] || {};

    // ── Split mode: per-instrument columns ──
    if (isSplit && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      if (segs.length === 0) return '';

      // Resolve CCs for each segment
      const segCCs = segs.map(seg => this._getInstrumentCCs(seg.instrumentId));
      const allUnknown = segCCs.every(ccs => ccs === null);

      // Table header: CC | Name | Inst1 | Inst2 | ...
      const headerCols = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const name = (seg.instrumentName || '?');
        const short = name.length > 10 ? name.slice(0, 9) + '\u2026' : name;
        return `<th class="rs-cc-inst-col" style="color:${color}" title="${escapeHtml(name)}">${escapeHtml(short)}</th>`;
      }).join('');

      // Table rows: one per CC used by channel, with remap for unsupported
      const currentRemap = this.ccRemapping[ch] || {};
      let supportedByAll = 0;
      let unsupportedByAny = 0;
      const bodyRows = channelCCs.map(ccNum => {
        const name = this._getCCName(ccNum);
        const cells = segCCs.map((ccs, i) => {
          if (ccs === null) return `<td class="rs-cc-cell rs-cc-cell-unknown" title="?">?</td>`;
          if (ccs.includes(ccNum)) return `<td class="rs-cc-cell rs-cc-cell-ok">\u2713</td>`;
          // Unsupported: show remap dropdown
          const currentTarget = currentRemap[ccNum];
          const remapOpts = (ccs || [])
            .filter(tc => !channelCCs.includes(tc) || tc === ccNum)
            .map(tc => `<option value="${tc}" ${currentTarget === tc ? 'selected' : ''}>${this._getCCName(tc)}</option>`)
            .join('');
          return `<td class="rs-cc-cell rs-cc-cell-no">
            <select class="rs-cc-remap rs-cc-remap-split" data-channel="${ch}" data-source="${ccNum}">
              <option value="">\u2717</option>
              ${remapOpts}
            </select>
          </td>`;
        }).join('');

        const anyUnsupported = segCCs.some(ccs => ccs !== null && !ccs.includes(ccNum));
        if (anyUnsupported) unsupportedByAny++;
        else supportedByAll++;

        const rowClass = anyUnsupported ? 'rs-cc-row-warn' : '';
        return `<tr class="${rowClass}"><td class="rs-cc-num">CC${ccNum}</td><td class="rs-cc-name">${escapeHtml(name)}</td>${cells}</tr>`;
      }).join('');

      // Summary
      let summaryHTML;
      if (allUnknown) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
      } else if (unsupportedByAny === 0) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedByAll})</span>`;
      } else {
        summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedByAll}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedByAny} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
      }

      return `
        <div class="rs-cc-section">
          <h4 class="rs-cc-title">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'}</h4>
          ${summaryHTML}
          <table class="rs-cc-table">
            <thead><tr><th>CC</th><th>${_t('common.name') || 'Nom'}</th>${headerCols}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`;
    }

    // ── Single instrument mode ──
    let instrumentCCs = assignment?.supportedCcs ?? null;
    if (instrumentCCs && typeof instrumentCCs === 'string') {
      try { instrumentCCs = JSON.parse(instrumentCCs); } catch { instrumentCCs = null; }
    }
    if (instrumentCCs == null && assignment?.instrumentId) {
      instrumentCCs = this._getInstrumentCCs(assignment.instrumentId);
    }

    let supportedCount = 0;
    let unsupportedCount = 0;

    const rows = channelCCs.map(ccNum => {
      const name = this._getCCName(ccNum);
      let statusIcon, statusClass;

      if (instrumentCCs === null) {
        statusIcon = '?'; statusClass = 'rs-cc-unknown'; supportedCount++;
      } else if (instrumentCCs.includes(ccNum)) {
        statusIcon = '\u2713'; statusClass = 'rs-cc-supported'; supportedCount++;
      } else {
        statusIcon = '\u2717'; statusClass = 'rs-cc-unsupported'; unsupportedCount++;
      }

      let remapHTML = '';
      if (statusClass === 'rs-cc-unsupported' && instrumentCCs) {
        const currentTarget = currentRemap[ccNum];
        const options = instrumentCCs
          .filter(targetCC => !channelCCs.includes(targetCC) || targetCC === ccNum)
          .map(targetCC => {
            const selected = currentTarget === targetCC ? 'selected' : '';
            return `<option value="${targetCC}" ${selected}>${this._getCCName(targetCC)}</option>`;
          });
        remapHTML = `
          <select class="rs-cc-remap" data-channel="${ch}" data-source="${ccNum}">
            <option value="">${_t('routingSummary.ccIgnore') || '\u2014 ignorer \u2014'}</option>
            ${options.join('')}
          </select>`;
      } else if (currentRemap[ccNum] !== undefined) {
        remapHTML = `<span class="rs-cc-remap-info">\u2192 ${this._getCCName(currentRemap[ccNum])}</span>`;
      }

      return `
        <div class="rs-cc-row ${statusClass}">
          <span class="rs-cc-num">CC${ccNum}</span>
          <span class="rs-cc-name">${escapeHtml(name)}</span>
          <span class="rs-cc-status">${statusIcon}</span>
          ${remapHTML}
        </div>`;
    }).join('');

    let summaryHTML;
    if (instrumentCCs === null) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
    } else if (unsupportedCount === 0) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedCount})</span>`;
    } else {
      summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedCount}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedCount} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
    }

    return `
      <div class="rs-cc-section">
        <h4 class="rs-cc-title">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'}</h4>
        ${summaryHTML}
        <div class="rs-cc-list">
          ${rows}
        </div>
      </div>`;
  }

  /**
   * Find instrument data by ID across all suggestions
   */
  _findInstrumentById(instrumentId) {
    for (const ch of Object.keys(this.suggestions)) {
      const options = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
      const found = options.find(o => o.instrument.id === instrumentId);
      if (found) return found.instrument;
    }
    // Fallback: search in allInstruments (has full data including supported_ccs)
    return (this.allInstruments || []).find(i => i.id === instrumentId) || null;
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
        <button class="btn btn-sm rs-prev-btn rs-prev-btn-label" id="rsPreviewOrigBtn" title="${_t('routingSummary.previewOriginal')}">
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

    // Determine channel filter based on active preview mode
    let channelFilter = null;
    if (this._previewMode === 'channel') {
      channelFilter = this._previewingChannel;
    } else if (this._previewMode === 'all' || this._previewMode === 'original') {
      channelFilter = null; // show all channels
    } else {
      channelFilter = (this.selectedChannel !== null) ? this.selectedChannel : null;
    }
    const skipRangeFilter = this._previewMode === 'original';
    const notes = this._extractNotesForMinimap(channelFilter, skipRangeFilter);
    const totalTicks = notes.length > 0 ? notes[notes.length - 1].t + 1 : 1;

    this._minimapWidth = w;
    this._minimapHeight = h;
    this._minimapTotalTicks = totalTicks;
    // Detect unique channels in notes
    const channelSet = new Set();
    for (const note of notes) channelSet.add(note.ch);
    this._minimapChannels = Array.from(channelSet).sort((a, b) => a - b);
    this._minimapMultiChannel = this._minimapChannels.length > 1;

    if (this._minimapMultiChannel) {
      // Multi-channel: per-channel boolean buckets
      const bucketMap = new Map();
      for (const ch of this._minimapChannels) bucketMap.set(ch, new Array(w).fill(false));
      for (const note of notes) {
        const col = Math.floor((note.t / totalTicks) * w);
        if (col >= 0 && col < w) bucketMap.get(note.ch)[col] = true;
      }
      this._minimapBuckets = bucketMap;
    } else {
      // Single channel: simple boolean buckets
      const buckets = new Array(w).fill(false);
      for (const note of notes) {
        const col = Math.floor((note.t / totalTicks) * w);
        if (col >= 0 && col < w) buckets[col] = true;
      }
      this._minimapBuckets = buckets;
    }

    this._drawMinimapFrame(0);
  }

  _drawMinimapFrame(playheadPct) {
    const canvas = this._minimapCanvas;
    if (!canvas || !canvas.parentNode) return; // Skip if canvas detached from DOM

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this._minimapWidth || 400;
    const h = this._minimapHeight || 32;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim() || '#f0f0f0';
    ctx.fillRect(0, 0, w, h);

    if (!this._minimapBuckets) return;

    const CHANNEL_COLORS = [
      '#3b82f6','#ef4444','#10b981','#f59e0b',
      '#8b5cf6','#ec4899','#06b6d4','#84cc16',
      '#f97316','#6366f1','#14b8a6','#e11d48',
      '#a855f7','#0ea5e9','#22c55e','#eab308'
    ];

    if (this._minimapMultiChannel) {
      const numCh = this._minimapChannels.length;
      const rowH = h / numCh;
      for (let ci = 0; ci < numCh; ci++) {
        const ch = this._minimapChannels[ci];
        const buckets = this._minimapBuckets.get(ch);
        if (!buckets) continue;
        ctx.fillStyle = CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
        const rowTop = ci * rowH;
        for (let i = 0; i < w; i++) {
          if (buckets[i]) ctx.fillRect(i, rowTop, 1, rowH);
        }
      }
    } else {
      ctx.fillStyle = '#4285f4';
      for (let i = 0; i < w; i++) {
        if (this._minimapBuckets[i]) ctx.fillRect(i, 0, 1, h);
      }
    }

    // Playhead
    if (playheadPct > 0 && playheadPct <= 1) {
      const x = Math.floor(playheadPct * w);
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(x, 0, 2, h);
    }
  }

  _extractNotesForMinimap(channelFilter, skipRangeFilter = false) {
    const notes = [];
    if (!this.midiData?.tracks) return notes;

    // Determine playable range for filtering (per-channel instrument ranges)
    const getRange = (ch) => {
      if (skipRangeFilter) return null;
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

          notes.push({ t: tick, n: note, ch: ch });
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
    const splitChannelMappings = [];
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

      // For split channels, route each segment to a different synth channel
      if (this.splitChannels.has(chNum) && this.splitAssignments[chNum]) {
        const segs = this.splitAssignments[chNum].segments || [];
        if (segs.length > 1) {
          // Segment 0 keeps the source channel; segments 1..N get free channels
          splitChannelMappings.push({ sourceChannel: chNum, segments: segs, semitones });
        } else if (segs.length === 1) {
          channelConfigs[ch] = {
            transposition: { semitones },
            instrumentConstraints: {
              gmProgram: segs[0].gmProgram ?? (constraints?.gmProgram),
              noteRangeMin: segs[0].noteRange?.min ?? 0,
              noteRangeMax: segs[0].noteRange?.max ?? 127
            }
          };
        }
        continue;
      }

      channelConfigs[ch] = {
        transposition: { semitones },
        instrumentConstraints: constraints
      };
    }

    // Pre-process split channels: redistribute notes to virtual channels
    let previewMidi = this.midiData;
    if (splitChannelMappings.length > 0) {
      previewMidi = JSON.parse(JSON.stringify(this.midiData));
      // Find all used channels
      const usedCh = new Set();
      for (const [c] of Object.entries(channelConfigs)) usedCh.add(Number(c));
      for (const m of splitChannelMappings) usedCh.add(m.sourceChannel);

      for (const mapping of splitChannelMappings) {
        const { sourceChannel, segments, semitones } = mapping;
        // Allocate free channels for segments 1..N
        const segChannels = [sourceChannel];
        for (let si = 1; si < segments.length; si++) {
          for (let c = 0; c < 16; c++) {
            if (c === 9 || usedCh.has(c)) continue;
            segChannels.push(c);
            usedCh.add(c);
            break;
          }
        }
        // Redistribute notes by range; duplicate for 'shared' overlap
        const overlapStrat = this.splitAssignments[sourceChannel]?.overlapStrategy;
        for (const track of (previewMidi.tracks || [])) {
          const dupes = [];
          let tick = 0;
          for (const evt of track.events) {
            if (evt.deltaTime !== undefined) tick += evt.deltaTime;
            evt._absTick = tick;
            if ((evt.type === 'noteOn' || evt.type === 'noteOff') && (evt.channel ?? 0) === sourceChannel) {
              const note = evt.note ?? evt.noteNumber ?? 60;
              const matches = [];
              for (let si = 0; si < segments.length; si++) {
                const rMin = segments[si].noteRange?.min ?? 0;
                const rMax = segments[si].noteRange?.max ?? 127;
                if (note >= rMin && note <= rMax && si < segChannels.length) matches.push(si);
              }
              if (matches.length > 0) {
                evt.channel = segChannels[matches[0]];
                if (overlapStrat === 'shared' && matches.length > 1) {
                  for (let mi = 1; mi < matches.length; mi++) {
                    dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                  }
                }
              }
            }
          }
          if (dupes.length > 0) {
            const allEvts = [...track.events, ...dupes];
            allEvts.sort((a, b) => a._absTick - b._absTick);
            let prev = 0;
            for (const e of allEvts) { e.deltaTime = e._absTick - prev; prev = e._absTick; }
            track.events = allEvts;
          }
          for (const evt of track.events) delete evt._absTick;
        }
        // Config for each segment channel
        segments.forEach((seg, i) => {
          if (i >= segChannels.length) return;
          channelConfigs[segChannels[i]] = {
            transposition: { semitones },
            instrumentConstraints: {
              gmProgram: seg.gmProgram,
              noteRangeMin: seg.noteRange?.min ?? 0,
              noteRangeMax: seg.noteRange?.max ?? 127
            }
          };
        });
      }
    }

    try {
      this._connectPreviewCallbacks();
      await this.audioPreview.previewAllChannels(previewMidi, channelConfigs, 0);
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

    // Split channels: route notes to different synth voices per segment
    if (this.splitChannels.has(channel) && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      if (segs.length > 1) {
        // Find free channels for segments 1..N (segment 0 keeps source channel)
        const usedChannels = new Set();
        if (this.midiData?.tracks) {
          for (const track of this.midiData.tracks) {
            for (const evt of (track.events || [])) {
              if (evt.type === 'noteOn' && evt.channel != null) usedChannels.add(evt.channel);
            }
          }
        }
        const freeChannels = [];
        for (let c = 0; c < 16; c++) {
          if (c === 9) continue; // skip drums
          if (c === channel) continue;
          if (!usedChannels.has(c)) freeChannels.push(c);
          if (freeChannels.length >= segs.length - 1) break;
        }

        // Map segments to target channels
        const segChannels = [channel, ...freeChannels.slice(0, segs.length - 1)];

        // Build modified MIDI data: redistribute notes by range
        // In 'shared' mode, duplicate notes to all matching segments
        const overlapStrategy = this.splitAssignments[channel]?.overlapStrategy;
        const splitMidi = JSON.parse(JSON.stringify(this.midiData));
        for (const track of (splitMidi.tracks || [])) {
          // First pass: compute absolute ticks and redistribute
          const dupes = [];
          let tick = 0;
          for (const evt of track.events) {
            if (evt.deltaTime !== undefined) tick += evt.deltaTime;
            evt._absTick = tick;

            if ((evt.type === 'noteOn' || evt.type === 'noteOff') && (evt.channel ?? 0) === channel) {
              const note = evt.note ?? evt.noteNumber ?? 60;
              const matches = [];
              for (let si = 0; si < segs.length; si++) {
                const rMin = segs[si].noteRange?.min ?? 0;
                const rMax = segs[si].noteRange?.max ?? 127;
                if (note >= rMin && note <= rMax && si < segChannels.length) matches.push(si);
              }
              if (matches.length > 0) {
                evt.channel = segChannels[matches[0]];
                // Shared overlap: duplicate to additional segments
                if (overlapStrategy === 'shared' && matches.length > 1) {
                  for (let mi = 1; mi < matches.length; mi++) {
                    dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                  }
                }
              }
            }
          }
          // Second pass: merge duplicates back, re-sort by absolute tick, recompute deltas
          if (dupes.length > 0) {
            const allEvents = [...track.events, ...dupes];
            allEvents.sort((a, b) => a._absTick - b._absTick);
            let prevTick = 0;
            for (const evt of allEvents) {
              evt.deltaTime = evt._absTick - prevTick;
              prevTick = evt._absTick;
            }
            track.events = allEvents;
          }
          // Clean up temp field
          for (const evt of track.events) delete evt._absTick;
        }

        // Build configs: one per segment with its own gmProgram and range
        const channelConfigs = {};
        segs.forEach((seg, i) => {
          if (i >= segChannels.length) return;
          channelConfigs[segChannels[i]] = {
            transposition: { semitones: transposition.semitones },
            instrumentConstraints: {
              gmProgram: seg.gmProgram ?? assignment?.gmProgram,
              noteRangeMin: seg.noteRange?.min ?? 0,
              noteRangeMax: seg.noteRange?.max ?? 127
            }
          };
        });

        try {
          this._connectPreviewCallbacks();
          await this.audioPreview.previewAllChannels(splitMidi, channelConfigs, 0);
          this._previewState = 'playing';
          this._updatePreviewUI();
          this._renderMinimap();
        } catch (err) {
          console.error('[Preview] split preview failed:', err);
          this._previewState = 'stopped';
          this._updatePreviewUI();
          this._showPreviewError(err.message);
        }
        return;
      }
    }

    // Single instrument: standard preview
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
    this._previewingChannel = null;

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
    this._safeStopPreview();
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
        scoringOverrides: {
          ...this.scoringOverrides,
          splitting: { ...(this.scoringOverrides?.splitting || {}), triggerBelowScore: 0 }
        }
      });

      if (!response.success) {
        this._showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      // Reset state with new results (splitProposals cleared)
      this.suggestions = response.suggestions || {};
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection || {};
      this.confidenceScore = response.confidenceScore || 0;
      this.splitProposals = {};
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
          if (!assignment.customName) {
            assignment.customName = matched.instrument.custom_name || null;
          }
          assignment.instrumentDisplayName = this._getInstrumentDisplayName(matched.instrument);
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
