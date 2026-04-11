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

/**
 * GM default polyphony by program (0-127).
 * Typical polyphony of the real acoustic instrument.
 */
const GM_DEFAULT_POLYPHONY = {
  0:16,1:16,2:16,3:16,4:16,5:16,6:8,7:8, // Piano
  8:8,9:4,10:4,11:6,12:4,13:4,14:8,15:4, // Chromatic Percussion
  16:16,17:16,18:16,19:16,20:16,21:8,22:1,23:8, // Organ
  24:6,25:6,26:6,27:6,28:6,29:6,30:6,31:6, // Guitar
  32:1,33:1,34:1,35:1,36:1,37:1,38:1,39:1, // Bass
  40:4,41:4,42:4,43:4,44:8,45:8,46:8,47:2, // Strings
  48:16,49:16,50:16,51:16,52:16,53:16,54:16,55:1, // Ensemble
  56:1,57:1,58:1,59:1,60:1,61:8,62:8,63:8, // Brass
  64:1,65:1,66:1,67:1,68:1,69:1,70:1,71:1, // Reed
  72:1,73:1,74:1,75:1,76:1,77:1,78:1,79:1, // Pipe/Flute
  80:1,81:1,82:1,83:1,84:1,85:1,86:2,87:2, // Synth Lead
  88:8,89:8,90:8,91:8,92:8,93:8,94:8,95:8, // Synth Pad
  96:4,97:4,98:4,99:4,100:4,101:4,102:4,103:4, // Synth FX
  104:4,105:6,106:4,107:4,108:4,109:1,110:4,111:1, // Ethnic
  112:4,113:4,114:2,115:2,116:4,117:4,118:4,119:4, // Percussive
  120:1,121:1,122:1,123:1,124:1,125:1,126:1,127:1  // Sound FX
};

function getGmDefaultPolyphony(gmProgram) {
  if (gmProgram == null || gmProgram < 0 || gmProgram > 127) return 16;
  return GM_DEFAULT_POLYPHONY[gmProgram] ?? 16;
}

const NOTE_NAMES = MidiConstants.NOTE_NAMES;

function midiNoteToName(note) {
  return NOTE_NAMES[note % 12] + Math.floor(note / 12);
}

/**
 * Clamp a note range to valid MIDI bounds and ensure min <= max.
 * Returns a safe { min, max } object.
 */
function safeNoteRange(min, max) {
  let lo = Math.max(0, Math.min(127, Math.round(min ?? 0)));
  let hi = Math.max(0, Math.min(127, Math.round(max ?? 127)));
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  return { min: lo, max: hi };
}

// Module-level constants (avoid recreating per render)
const SPLIT_COLORS = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];

// Black key pattern within an octave (0-11): C#=1, D#=3, F#=6, G#=8, A#=10
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

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
    this.ccSegmentMute = {}; // Per-segment CC mute { [channel]: { [ccNum]: Set<segIndex> } }
    this.ccExpanded = {}; // Per-channel CC section collapse state
    this.ccShowAll = {}; // Per-channel CC pagination (show all rows)
    this._rafPending = false; // RAF debounce for _refreshUI
    this._pendingHint = null; // Pending render hint for RAF coalescence
    this._pendingChannelKeys = null;
    this.showLowScores = {}; // Per-channel toggle for low score instruments
    this.autoAdaptation = true; // Toggle for automatic MIDI channel adaptation
    this.channelVolumes = {}; // Per-channel volume overrides (CC7, 0-127, default 100)

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

      // Store results — load backend split proposals (auto-split avoid transposition, etc.)
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

      // Check for existing saved routings before using auto-selection
      let savedRoutings = [];
      try {
        const savedResp = await this.api.sendCommand('get_file_routings', { fileId });
        if (savedResp?.success && savedResp.routings?.length > 0) {
          savedRoutings = savedResp.routings;
        }
      } catch (e) { /* ignore — fall back to auto-selection */ }

      // Initialize assignments from auto-selection
      const autoSkippedChannels = this.autoSelection._autoSkipped || [];
      delete this.autoSelection._autoSkipped;

      if (savedRoutings.length > 0) {
        // Use saved routings as default assignments (preserve user's previous choices)
        this.selectedAssignments = {};
        const usedChannels = new Set();
        for (const r of savedRoutings) {
          const ch = String(r.channel);
          // Find the instrument in allInstruments by device_id + instrument_name
          const inst = (this.allInstruments || []).find(i =>
            i.device_id === r.device_id && (i.custom_name === r.instrument_name || i.name === r.instrument_name)
          );
          if (inst) {
            this.selectedAssignments[ch] = {
              instrumentId: inst.id,
              deviceId: r.device_id,
              instrumentName: r.instrument_name,
              score: r.compatibility_score || 0,
              transposition: r.transposition_applied ? { semitones: r.transposition_applied } : null,
            };
            usedChannels.add(r.channel);
          }
        }
        // For channels not in saved routings, fall back to auto-selection
        for (const [ch, assignment] of Object.entries(this.autoSelection)) {
          if (!this.selectedAssignments[ch]) {
            this.selectedAssignments[ch] = JSON.parse(JSON.stringify(assignment));
          }
        }
        this.skippedChannels = new Set(autoSkippedChannels);
        this.autoSkippedChannels = new Set(autoSkippedChannels);
      } else {
        this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
        this.skippedChannels = new Set(autoSkippedChannels);
        this.autoSkippedChannels = new Set(autoSkippedChannels);
      }

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
        const adapt = {
          pitchShift: assignment?.transposition?.semitones ? 'auto' : 'none',
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          oorHandling: 'passThrough',
          polyReduction: 'none',
          polyStrategy: 'shorten',
          polyTarget: null
        };

        // Auto-adaptation: enable polyphony reduction when instrument capacity is lower
        if (this.autoAdaptation) {
          const chPoly = this._getChannelPolyphony(parseInt(ch));
          const instPoly = this._getInstrumentPolyphony(parseInt(ch))
            || getGmDefaultPolyphony(assignment?.gmProgram);
          if (chPoly && instPoly && chPoly > instPoly) {
            adapt.polyReduction = 'auto';
            adapt.polyTarget = instPoly;
            // Large gap (>2x): drop excess notes; close: shorten durations
            adapt.polyStrategy = chPoly > instPoly * 2 ? 'drop' : 'shorten';
          }
        }

        this.adaptationSettings[ch] = adapt;
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

  _renderContent(hint = 'all') {
    // Guard against re-entrant calls: _bindEvents() can trigger synthetic change
    // events on pre-checked radios / pre-selected selects, whose handlers call
    // _refreshUI() → _renderContent() again → infinite loop → browser freeze.
    // This guard protects ALL call sites (show(), _refreshUI(), etc.).
    if (this._isRendering) return;
    this._isRendering = true;
    try {
      const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));

      if (hint === 'all') {
        // Full rebuild — initial render or structural changes
        const summaryPanel = this.modal.querySelector('#rsSummaryPanel');
        const detailPanel = this.modal.querySelector('#rsDetailPanel');
        const savedSummaryScroll = summaryPanel?.scrollTop || 0;
        const savedDetailScroll = detailPanel?.scrollTop || 0;

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
                ${this.selectedChannel !== null ? this._safeRenderDetailPanel(this.selectedChannel) : this._renderDetailPlaceholder()}
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

        this._bindGlobalEvents(channelKeys);
        this._bindSummaryEvents(channelKeys);
        this._bindDetailEvents(channelKeys);
        this._bindPreviewEvents();

        const newSummary = this.modal.querySelector('#rsSummaryPanel');
        const newDetail = this.modal.querySelector('#rsDetailPanel');
        if (newSummary) newSummary.scrollTop = savedSummaryScroll;
        if (newDetail) newDetail.scrollTop = savedDetailScroll;
      } else {
        // Partial update — only rebuild the affected panel(s)
        if (hint === 'summary' || hint === 'both-panels') {
          const panel = this.modal.querySelector('#rsSummaryPanel');
          if (panel) {
            const saved = panel.scrollTop;
            panel.innerHTML = this._renderSummaryTable(channelKeys);
            panel.scrollTop = saved;
            this._bindSummaryEvents(channelKeys);
          }
        }
        if (hint === 'detail' || hint === 'both-panels') {
          const panel = this.modal.querySelector('#rsDetailPanel');
          if (panel) {
            const saved = panel.scrollTop;
            panel.innerHTML = this.selectedChannel !== null
              ? this._safeRenderDetailPanel(this.selectedChannel)
              : this._renderDetailPlaceholder();
            panel.scrollTop = saved;
            this._bindDetailEvents(channelKeys);
          }
        }
        // Sync container layout class (detail visible or not)
        const container = this.modal.querySelector('.rs-container');
        if (container) container.classList.toggle('rs-with-detail', this.selectedChannel !== null);
        // Update header (score, channel count, preview buttons)
        this._updateHeaderState();
      }
    } catch (error) {
      console.error('[RoutingSummary] Render failed:', error);
    } finally {
      this._isRendering = false;
    }
  }

  /**
   * Lightweight header state sync without full re-render.
   * Updates score display, channel count, and preview button states.
   */
  _updateHeaderState() {
    const modal = this.modal;
    if (!modal) return;

    // Score button
    const scoreBtn = modal.querySelector('#rsScoreBtn');
    if (scoreBtn) {
      const displayScore = this._getDisplayScore();
      const scoreLabel = this.selectedChannel !== null
        ? `Ch ${this.selectedChannel + 1} : ${displayScore}/100`
        : `${displayScore}/100 — ${getScoreLabel(displayScore)}`;
      scoreBtn.textContent = scoreLabel;
      scoreBtn.className = `rs-score-btn ${getScoreBgClass(displayScore)}`;
    }

    // Channel count
    const channelKeys = Object.keys(this.suggestions);
    const activeCount = channelKeys.length - this.skippedChannels.size;
    const countEl = modal.querySelector('.rs-channel-count');
    if (countEl) {
      countEl.textContent = _t('autoAssign.channelsWillBeAssigned', { active: activeCount, total: channelKeys.length });
    }

    // Preview channel button: update disabled state and label
    const chBtn = modal.querySelector('#rsPreviewChBtn');
    if (chBtn) {
      const ch = this.selectedChannel;
      chBtn.disabled = ch === null;
      const chLabel = ch !== null ? (ch + 1) : '?';
      // Update label text (preserve icon span)
      const iconSpan = chBtn.querySelector('.rs-prev-icon');
      const iconHTML = iconSpan ? iconSpan.outerHTML : '<span class="rs-prev-icon">&#9654;</span>';
      chBtn.innerHTML = `${iconHTML} ${_t('routingSummary.previewChannel') || 'Channel'} ${chLabel}`;
    }
  }

  // ============================================================================
  // Score detail popup
  // ============================================================================

  _renderScoreDetail() {
    const allKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    const isDetailMode = this.selectedChannel !== null;
    const channelKeys = isDetailMode
      ? allKeys.filter(ch => parseInt(ch) === this.selectedChannel)
      : allKeys;
    if (channelKeys.length === 0) return `<div class="rs-score-empty">${_t('routingSummary.noChannels') || 'Aucun canal'}</div>`;

    // Detail mode: full breakdown for one channel
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
      const isSkipped = this.skippedChannels.has(channel);
      const isSplit = this.splitChannels.has(channel);
      const assignment = this.selectedAssignments[ch];
      const analysis = this.channelAnalyses[channel];
      const gmName = channel === 9 ? (_t('autoAssign.drums') || 'Drums') : (getGmProgramName(analysis?.primaryProgram) || '\u2014');

      // Multi-instrument mode: show per-segment info
      if (isSplit && this.splitAssignments[channel]) {
        const segments = this.splitAssignments[channel].segments || [];
        const splitColors = SPLIT_COLORS;
        const totalNotes = analysis?.noteDistribution ? Object.values(analysis.noteDistribution).reduce((s, c) => s + c, 0) : 0;

        const segRows = segments.map((seg, i) => {
          const color = splitColors[i % splitColors.length];
          const inst = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
          const name = inst ? this._getInstrumentDisplayName(inst) : (seg.instrumentName || `Inst ${i + 1}`);
          const rMin = seg.noteRange?.min ?? 0;
          const rMax = seg.noteRange?.max ?? 127;
          // Count notes in this segment's range
          let segNotes = 0;
          if (analysis?.noteDistribution) {
            const adapt = this.adaptationSettings[ch] || {};
            const semi = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
            for (const [note, count] of Object.entries(analysis.noteDistribution)) {
              const shifted = parseInt(note) + semi;
              if (shifted >= rMin && shifted <= rMax) segNotes += count;
            }
          }
          const coveragePct = totalNotes > 0 ? Math.round((segNotes / totalNotes) * 100) : 0;

          return `<div class="rs-score-bar-row">
            <span class="rs-score-bar-label" style="color:${color}">${escapeHtml(name)}</span>
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
              <span class="rs-score-row-gm">${escapeHtml(gmName)}</span>
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

      // Single instrument mode
      const score = assignment?.score || 0;
      const instName = isSkipped
        ? `<span class="rs-score-muted">${_t('routingSummary.muted') || 'Muté'}</span>`
        : escapeHtml(assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || '\u2014');

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
            `<span class="rs-score-issue rs-score-issue-${i.type || 'warning'}">${escapeHtml(i.message)}</span>`
          ).join('')}</div>` : '';

      return `<div class="rs-score-detail-content">
        <div class="rs-score-row">
          <div class="rs-score-row-header">
            <span class="rs-score-row-ch">CH ${channel + 1}</span>
            <span class="rs-score-row-gm">${escapeHtml(gmName)}</span>
            <span class="rs-score-row-arrow">\u2192</span>
            <span class="rs-score-row-inst">${instName}</span>
            <span class="rs-score-row-score ${getScoreClass(score)}">${isSkipped ? '\u2014' : score}</span>
          </div>
          ${breakdownHtml}${issues}
        </div>
      </div>`;
    }

    // Summary mode: compact grid with all channels
    const cells = channelKeys.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = this.skippedChannels.has(channel);
      const assignment = this.selectedAssignments[ch];
      const score = assignment?.score || 0;
      const instName = isSkipped
        ? (_t('routingSummary.muted') || 'Muté')
        : (assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || '\u2014');
      const displayName = instName.length > 12 ? instName.slice(0, 11) + '\u2026' : instName;
      return `<div class="rs-score-cell ${isSkipped ? 'rs-score-cell-skipped' : ''}" title="${escapeHtml(instName)}">
        <span class="rs-score-cell-ch">CH ${channel + 1}</span>
        <span class="rs-score-cell-score ${getScoreBgClass(score)}">${isSkipped ? '\u2014' : score}</span>
        <span class="rs-score-cell-inst">${escapeHtml(displayName)}</span>
      </div>`;
    }).join('');

    return `<div class="rs-score-grid">${cells}</div>`;
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
          routedName = segments.map(seg => {
            const inst = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
            return inst ? this._getInstrumentDisplayName(inst) : (seg.instrumentName || '?');
          }).join(' + ');
        } else if (assignment?.instrumentDisplayName || assignment?.customName || assignment?.instrumentName) {
          routedName = assignment.instrumentDisplayName || assignment.customName || getGmProgramName(assignment.gmProgram) || assignment.instrumentName;
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
          const color = SPLIT_COLORS[i % SPLIT_COLORS.length];
          const instRef = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
          const name = instRef ? this._getInstrumentDisplayName(instRef) : (seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument');
          const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
          return `<span class="rs-split-inst-name" style="color:${color}" title="${escapeHtml(name)}">${escapeHtml(displayName)}</span>`;
        });
        assignedHTML = `<div class="rs-split-instruments">${splitParts.join('<span class="rs-split-sep">+</span>')}</div>`;
      } else {
        assignedHTML = `<div class="rs-select-zone"><select class="rs-instrument-select" data-channel="${ch}">${this._buildInstrumentOptions(ch, assignment, isSkipped)}</select></div>`;
      }

      // Score column
      const scoreHTML = (!isSkipped && score > 0) ? `<span class="rs-score-value ${getScoreClass(score)}">${score}</span>` : '';

      // Polyphony column: channel max / instrument capacity (+ auto-adapt indicator)
      let polyHTML = '';
      if (!isSkipped) {
        const chPoly = this._getChannelPolyphony(channel);
        const instPoly = this._getInstrumentPolyphony(channel);
        if (chPoly && instPoly) {
          const adapt = this.adaptationSettings[ch];
          const polyActive = this.autoAdaptation && adapt?.polyReduction && adapt.polyReduction !== 'none';
          const ok = polyActive || instPoly >= chPoly;
          const polyLabel = polyActive ? `${chPoly}\u2192${adapt.polyTarget || instPoly}` : `${chPoly}/${instPoly}`;
          polyHTML = `<span class="rs-poly-cell ${ok ? 'rs-poly-ok' : 'rs-poly-warn'}">${polyLabel}</span>`;
        }
      }

      // Playable notes column: total notes / playable by instrument
      let playableHTML = '';
      if (!isSkipped) {
        const playableInfo = this._computePlayableNotes(ch);
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
          <td class="rs-col-original">${escapeHtml(gmName)}</td>
          <td class="rs-col-type"><span class="rs-type-badge" style="color:${getTypeColor(analysis?.estimatedType)}" title="${analysis?.estimatedType ? (_t('autoAssign.type_' + analysis.estimatedType) || analysis.estimatedType) : ''}">${typeIcon} ${analysis?.estimatedType ? (_t('autoAssign.type_' + analysis.estimatedType) || analysis.estimatedType) : ''}</span></td>
          <td class="rs-col-assigned">${assignedHTML}</td>
          <td class="rs-col-volume">${this._renderVolumeSlider(channel)}</td>
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

  /**
   * Render a compact volume slider (CC7) for a channel row.
   * Returns empty string if channel is skipped or instrument doesn't support CC7.
   */
  _renderVolumeSlider(channel) {
    const isSkipped = this.skippedChannels.has(channel);
    if (isSkipped || !this._supportsCC7(channel)) return '';
    const vol = this._getChannelVolume(channel);
    return `<div class="rs-volume-zone"><input type="range" class="rs-volume-slider" min="0" max="127" value="${vol}" data-channel="${channel}" title="Volume CC7: ${vol}"><span class="rs-volume-value">${vol}</span></div>`;
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

  _safeRenderDetailPanel(channel) {
    try {
      return this._renderDetailPanel(channel);
    } catch (error) {
      console.error('[RoutingSummary] Detail panel render failed for channel', channel, ':', error);
      return `<div class="rs-detail-content rs-detail-error">
        <p>${_t('autoAssign.error') || 'Error'}: ${escapeHtml(error.message || String(error))}</p>
        <button class="btn btn-sm rs-detail-close" id="rsDetailClose">&times;</button>
      </div>`;
    }
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
            const playableWithTranspose = this._computePlayableNotes(ch);
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
          ${this._renderPolyReductionSection(channel, adaptation, analysis, assignment)}
        </div>
      `;
    }

    // Instrument chips (horizontal bar) — always show, even on skipped channels
    const instrumentChipsHTML = (options.length > 0 || lowOptions.length > 0)
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
      const splitColors = SPLIT_COLORS;
      const activeData = this.splitAssignments[channel];
      const segments = activeData.segments || [];
      const activeMode = activeData.type;
      // Apply transposition to channel range (shift displayed note positions)
      const adapt = this.adaptationSettings[ch] || {};
      const semitones = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
      const chRange = safeNoteRange((analysis?.noteRange?.min ?? 0) + semitones, (analysis?.noteRange?.max ?? 127) + semitones);
      const chMin = chRange.min;
      const chMax = chRange.max;
      const noteCount = chMax - chMin + 1;

      // Build table rows: one per instrument (color+remove | select | slider)
      const instRowsHTML = segments.map((seg, i) => {
        const color = splitColors[i % splitColors.length];

        // Instrument select
        const compatInstruments = this._getCompatibleInstrumentsForSegment(ch, seg.noteRange);
        const seen = new Set(compatInstruments.map(inst => inst.id));
        if (seg.instrumentId && !seen.has(seg.instrumentId)) {
          const currentInst = (this.allInstruments || []).find(ii => ii.id === seg.instrumentId);
          if (currentInst) compatInstruments.unshift({ ...currentInst, _score: -1 });
        }
        const selectOptions = compatInstruments.map(inst => {
          const selected = inst.id === seg.instrumentId ? 'selected' : '';
          const name = this._getInstrumentDisplayName(inst);
          const label = name.length > MAX_INST_NAME ? name.slice(0, MAX_INST_NAME - 1) + '\u2026' : name;
          return `<option value="${inst.id}" ${selected}>${escapeHtml(label)}</option>`;
        }).join('');
        const canRemove = segments.length > 1;

        // Slider bar computation
        const physMin = seg.fullRange?.min ?? 0;
        const physMax = seg.fullRange?.max ?? 127;
        const displayPhysMin = Math.max(physMin, chMin);
        const displayPhysMax = Math.min(physMax, chMax);
        const physLeft = Math.round(((displayPhysMin - chMin) / noteCount) * 100);
        const physWidth = Math.max(1, Math.round(((displayPhysMax - displayPhysMin + 1) / noteCount) * 100));
        const rMin = seg.noteRange?.min ?? physMin;
        const rMax = seg.noteRange?.max ?? physMax;
        const segLeft = Math.round(((rMin - chMin) / noteCount) * 100);
        const segWidth = Math.max(2, Math.round(((rMax - rMin + 1) / noteCount) * 100));
        const sliderTitle = `${midiNoteToName(rMin)}\u2013${midiNoteToName(rMax)}`;

        return `<div class="rs-split-table-row" data-channel="${channel}" data-seg="${i}">
          <div class="rs-split-table-badge" style="background:${color}20;border-color:${color}">
            <span class="rs-split-badge-dot" style="background:${color}"></span>
            <select class="rs-seg-instrument-select" data-channel="${channel}" data-seg="${i}" data-mode="${activeMode}">
              ${selectOptions}
            </select>
            ${canRemove ? `<button class="rs-split-badge-remove rs-btn-remove-segment" data-channel="${channel}" data-seg="${i}" title="${_t('common.delete')}">&times;</button>` : ''}
          </div>
          <div class="rs-split-table-bar">
            <div class="rs-split-viz-inst-row" data-channel="${channel}" data-seg="${i}">
              <div class="rs-split-viz-phys" style="left:${physLeft}%;width:${physWidth}%" title="${midiNoteToName(physMin)}\u2013${midiNoteToName(physMax)}"></div>
              <div class="rs-split-viz-slider" style="left:${segLeft}%;width:${segWidth}%;background:${color}"
                   title="${sliderTitle}" data-channel="${channel}" data-seg="${i}"
                   data-phys-min="${physMin}" data-phys-max="${physMax}">
                <div class="rs-split-viz-handle rs-split-viz-handle-l" data-bound="min"></div>
                <div class="rs-split-viz-handle rs-split-viz-handle-r" data-bound="max"></div>
              </div>
            </div>
          </div>
        </div>`;
      }).join('');

      // Detect overlaps between any segments
      let overlapsHTML = '';
      const overlaps = this._detectOverlaps(segments);
      if (overlaps.length > 0) {
        const currentStrategy = activeData?.overlapStrategy || 'shared';
        overlapsHTML = overlaps.map((ov, idx) => {
          const colorA = splitColors[ov.segA % splitColors.length];
          const colorB = splitColors[ov.segB % splitColors.length];
          return `
            <div class="rs-overlap-zone-card">
              <div class="rs-overlap-zone-colors">
                <span class="rs-overlap-zone-chip" style="background:${colorA}"></span>
                <span class="rs-overlap-zone-chip" style="background:${colorB}"></span>
                <span class="rs-overlap-zone-range">${midiNoteToName(ov.min)}\u2013${midiNoteToName(ov.max)}</span>
              </div>
              <div class="rs-overlap-zone-btns">
                <button class="btn btn-sm rs-overlap-resolve-btn${currentStrategy === 'shared' ? ' rs-overlap-btn-active' : ''}" data-channel="${channel}" data-overlap="${idx}" data-strategy="shared">${_t('routingSummary.overlapPlay') || 'Jouer'}</button>
                <button class="btn btn-sm rs-overlap-resolve-btn${currentStrategy === 'alternate' ? ' rs-overlap-btn-active' : ''}" data-channel="${channel}" data-overlap="${idx}" data-strategy="alternate">${_t('routingSummary.overlapAlternate') || 'Alterner'}</button>
                <button class="btn btn-sm rs-overlap-resolve-btn${currentStrategy === 'overflow' ? ' rs-overlap-btn-active' : ''}" data-channel="${channel}" data-overlap="${idx}" data-strategy="overflow">${_t('routingSummary.overlapOverflow') || 'D\u00e9bordement'}</button>
              </div>
            </div>
          `;
        }).join('');
      }

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
            </div>
          `;
        }
      }

      const segCount = segments.length;

      splitHTML = `
        <div class="rs-split-section active">
          <div class="rs-split-header" data-channel="${channel}">
            <span class="rs-split-toggle">${expanded ? '\u25BE' : '\u25B8'}</span>
            <span>${_t('routingSummary.multiInstrument') || 'Multi-instrument'} (${segCount})</span>
            <button class="btn btn-sm rs-btn-remove-split rs-split-toggle-btn" data-channel="${channel}" title="${_t('routingSummary.removeMulti') || 'Retirer multi-instrument'}">\u2716</button>
          </div>
          <div class="rs-split-body ${expanded ? '' : 'collapsed'}">
            <div class="rs-split-viz-v2" data-channel="${channel}" data-ch-min="${chMin}" data-ch-max="${chMax}">
              <div class="rs-split-table">
                <div class="rs-split-table-row rs-split-table-header">
                  <div class="rs-split-table-badge-spacer"></div>
                  <div class="rs-split-table-bar">
                    ${renderMiniKeyboard(chMin, chMax)}
                    ${renderChannelHistogram(analysis, semitones)}
                  </div>
                </div>
                ${instRowsHTML}
                <div class="rs-split-table-row rs-split-table-add">
                  <div class="rs-split-table-badge-spacer"></div>
                  <div class="rs-split-table-bar" style="text-align:center">
                    <button class="btn btn-sm rs-btn-add-segment" data-channel="${channel}">+ ${_t('routingSummary.addInstrument') || 'Ajouter instrument'}</button>
                  </div>
                </div>
              </div>
            </div>
            ${overlapsHTML}
            ${uncoveredHTML}
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
      const splitColors = SPLIT_COLORS;
      routeHTML = escapeHtml(gmName) + ' \u2192 ' + segments.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        // Resolve display name: look up instrument for proper naming
        const inst = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
        const name = inst ? this._getInstrumentDisplayName(inst) : (seg.instrumentName || getGmProgramName(seg.gmProgram) || 'Instrument');
        return `<strong style="color:${color}">${escapeHtml(name)}</strong>`;
      }).join(' + ');
    } else {
      routeHTML = `${escapeHtml(gmName)}${assignedName ? ` \u2192 <strong>${escapeHtml(assignedName)}</strong>` : ''}`;
    }

    // Polyphony info: instrument(s) capacity vs channel usage (+ auto-adapt indicator)
    let polyHTML = '';
    const channelPoly = this._getChannelPolyphony(channel);
    const instPoly = this._getInstrumentPolyphony(channel);
    if (channelPoly && instPoly) {
      const adapt = this.adaptationSettings[ch] || {};
      const polyActive = this.autoAdaptation && adapt.polyReduction && adapt.polyReduction !== 'none';
      const polyOk = polyActive || instPoly >= channelPoly;
      const polyLabel = polyActive ? `${channelPoly}\u2192${adapt.polyTarget || instPoly}` : `${channelPoly}/${instPoly}`;
      polyHTML = `<span class="rs-detail-poly ${polyOk ? 'rs-poly-ok' : 'rs-poly-warn'}" title="${_t('autoAssign.polyphony') || 'Polyphonie'} (${_t('autoAssign.polyphonyHint') || 'canal / instrument'})">\u266B ${polyLabel}</span>`;
    }

    return `
      <div class="rs-detail-content">
        <div class="rs-detail-header">
          <div class="rs-detail-title">
            <span class="rs-detail-ch">${typeIcon} Ch ${channel + 1}${channel === 9 ? ' DR' : ''}</span>
            <span class="rs-detail-route">${routeHTML}</span>
            ${(!isSplit && score > 0) ? `<span class="rs-detail-score ${getScoreClass(score)}">${score}</span>` : ''}
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

    // Low-score chips: always visible when no high-score options exist, otherwise toggle
    const showLowChips = showLow || options.length === 0;
    let lowChips = '';
    if (showLowChips && lowOptions.length > 0) {
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

    // Show "more" toggle only when there are high-score options (low chips are behind toggle)
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
   * Render the polyphony reduction section for channel adaptation.
   * Shows controls only when channel polyphony exceeds instrument capacity.
   */
  _renderPolyReductionSection(channel, adaptation, analysis, assignment) {
    const channelPoly = this._getChannelPolyphony(channel);
    const instPoly = this._getInstrumentPolyphony(channel);
    const gmPoly = getGmDefaultPolyphony(assignment?.gmProgram);

    // Determine effective instrument polyphony (routed instrument first, then GM default)
    const effectivePoly = instPoly || gmPoly;

    // Don't show if polyphony is sufficient or no data
    if (!channelPoly || !effectivePoly || channelPoly <= effectivePoly) {
      return '';
    }

    const polyReduction = adaptation.polyReduction || 'none';
    const polyStrategy = adaptation.polyStrategy || 'shorten';
    const polyTarget = polyReduction === 'manual' && adaptation.polyTarget != null
      ? adaptation.polyTarget
      : effectivePoly;

    // Info line: channel poly vs instrument poly
    const polyExcess = channelPoly - polyTarget;
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
          <input type="number" class="rs-poly-target-input" data-channel="${channel}" value="${polyTarget}" min="1" max="${channelPoly}">
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
        <span class="rs-poly-info-detail">\u266B ${_t('autoAssign.channelPolyphony')}: ${channelPoly} | ${_t('autoAssign.instrumentPolyphony')}: ${effectivePoly}${polyReduction === 'manual' ? ` | ${_t('autoAssign.polyTargetLabel')}: ${polyTarget}` : ''}</span>
        ${polyExcess > 0 ? `<span class="rs-poly-info-impact">\u2248 ${polyExcess} ${_t(impactKey)}</span>` : ''}
      </div>` : ''}
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
    const splitColors = SPLIT_COLORS;
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
        // Resolve display name via allInstruments lookup
        const instLookup = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
        const name = instLookup ? this._getInstrumentDisplayName(instLookup) : (seg.instrumentName || `Inst ${i + 1}`);

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
      // Add overlap zone visualization (skip for overflow/alternate where full overlap is intentional)
      const behaviorMode = splitData.behaviorMode;
      const skipOverlapViz = (behaviorMode === 'overflow' || behaviorMode === 'alternate');
      const overlaps = skipOverlapViz ? [] : this._detectOverlaps(segs);
      const overlapZonesHTML = overlaps.length > 0 ? overlaps.map(ov => {
        const oLeft = (ov.min / FULL_RANGE) * 100;
        const oWidth = Math.max(0.5, ((ov.max - ov.min) / FULL_RANGE) * 100);
        const instA = segs[ov.segA]?.instrumentId ? (this.allInstruments || []).find(ii => ii.id === segs[ov.segA].instrumentId) : null;
        const instB = segs[ov.segB]?.instrumentId ? (this.allInstruments || []).find(ii => ii.id === segs[ov.segB].instrumentId) : null;
        const nameA = instA ? this._getInstrumentDisplayName(instA) : (segs[ov.segA]?.instrumentName || `Inst ${ov.segA + 1}`);
        const nameB = instB ? this._getInstrumentDisplayName(instB) : (segs[ov.segB]?.instrumentName || `Inst ${ov.segB + 1}`);
        return `<div class="rs-range-overlap-zone" style="left:${oLeft}%;width:${oWidth}%" title="\u26A0 ${_t('routingSummary.overlap') || 'Superposition'}: ${midiNoteToName(ov.min)}-${midiNoteToName(ov.max)} (${escapeHtml(nameA)} / ${escapeHtml(nameB)})"></div>`;
      }).join('') : '';

      // Wrap inst bars + overlap zones in positioned container
      instBarsHTML = `<div class="rs-range-inst-area">${instBarsHTML}${overlapZonesHTML}</div>`;

      legendItems = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const instL = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
        const name = instL ? this._getInstrumentDisplayName(instL) : (seg.instrumentName || `Inst ${i + 1}`);
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

    // Memoize: result only changes when segment range or instrument list changes
    const cacheKey = `${ch}_${segMin}_${segMax}`;
    if (this._segmentInstrumentCache?.[cacheKey]) return this._segmentInstrumentCache[cacheKey];

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
        const entry = Object.create(inst);
        entry._score = opt.compatibility?.score || 0;
        candidates.push(entry);
      }
    }

    // Priority 2: all instruments (no score, lower priority)
    for (const inst of (this.allInstruments || [])) {
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      const iMin = inst.note_range_min ?? 0;
      const iMax = inst.note_range_max ?? 127;
      if (iMin <= segMax && iMax >= segMin) {
        const entry = Object.create(inst);
        entry._score = 0;
        candidates.push(entry);
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b._score - a._score);

    if (!this._segmentInstrumentCache) this._segmentInstrumentCache = {};
    this._segmentInstrumentCache[cacheKey] = candidates;
    return candidates;
  }

  // ============================================================================
  // Event binding
  // ============================================================================

  /**
   * Bind header/footer/global events (only on full re-render).
   */
  _bindGlobalEvents(channelKeys) {
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
  }

  /**
   * Bind summary panel events using event delegation (3 listeners instead of ~50).
   * Uses AbortController to clean up previous listeners on rebind.
   */
  _bindSummaryEvents(channelKeys) {
    const panel = this.modal.querySelector('#rsSummaryPanel');
    if (!panel) return;

    // Abort previous listeners before rebinding
    if (this._summaryAbort) this._summaryAbort.abort();
    this._summaryAbort = new AbortController();
    const opts = { signal: this._summaryAbort.signal };

    panel.addEventListener('click', (e) => {
      const target = e.target;

      // Skip button
      const skipBtn = target.closest('.rs-btn-skip');
      if (skipBtn) {
        const ch = parseInt(skipBtn.dataset.channel);
        this.skippedChannels.add(ch);
        this._refreshUI(channelKeys, 'both-panels');
        return;
      }

      // Unskip button
      const unskipBtn = target.closest('.rs-btn-unskip');
      if (unskipBtn) {
        const ch = parseInt(unskipBtn.dataset.channel);
        this.skippedChannels.delete(ch);
        this._refreshUI(channelKeys, 'both-panels');
        return;
      }

      // Select zone: open dropdown
      const selectZone = target.closest('.rs-select-zone');
      if (selectZone) {
        e.stopPropagation();
        const sel = selectZone.querySelector('.rs-instrument-select');
        if (sel && target !== sel) {
          sel.focus();
          sel.showPicker?.();
        }
        return;
      }

      // Instrument select click — just stop propagation
      if (target.closest('.rs-instrument-select')) {
        e.stopPropagation();
        return;
      }

      // Volume zone — stop propagation
      if (target.closest('.rs-volume-zone')) {
        e.stopPropagation();
        return;
      }

      // Row click — select channel for detail
      const row = target.closest('.rs-row');
      if (row && !target.closest('.rs-btn-skip, .rs-btn-unskip, .rs-instrument-select, .rs-select-zone, .rs-volume-zone, .rs-volume-slider')) {
        const ch = parseInt(row.dataset.channel);
        this._selectChannel(ch);
      }
    }, opts);

    panel.addEventListener('change', (e) => {
      const target = e.target;
      if (target.matches('.rs-instrument-select')) {
        e.stopPropagation();
        const ch = target.dataset.channel;
        if (target.value) this._selectInstrument(ch, target.value, channelKeys);
      }
    }, opts);

    panel.addEventListener('input', (e) => {
      const target = e.target;
      if (target.matches('.rs-volume-slider')) {
        e.stopPropagation();
        const ch = parseInt(target.dataset.channel);
        const vol = parseInt(target.value);
        this.channelVolumes[ch] = vol;
        target.title = `Volume CC7: ${vol}`;
        const label = target.closest('.rs-volume-zone')?.querySelector('.rs-volume-value');
        if (label) label.textContent = vol;
      }
    }, opts);

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const row = e.target.closest('.rs-row');
        if (row) {
          const ch = parseInt(row.dataset.channel);
          this._selectChannel(ch);
        }
      }
    }, opts);

    // mousedown on volume zone — stop propagation
    panel.addEventListener('mousedown', (e) => {
      if (e.target.closest('.rs-volume-zone, .rs-volume-slider')) {
        e.stopPropagation();
      }
    }, opts);
  }

  /**
   * Bind detail panel events using event delegation (2 listeners instead of ~80).
   * Uses AbortController to clean up previous listeners on rebind.
   */
  _bindDetailEvents(channelKeys) {
    const panel = this.modal.querySelector('#rsDetailPanel');
    if (!panel) return;

    // Abort previous listeners before rebinding
    if (this._detailAbort) this._detailAbort.abort();
    this._detailAbort = new AbortController();
    const opts = { signal: this._detailAbort.signal };

    panel.addEventListener('click', (e) => {
      const target = e.target;

      // Close detail
      if (target.closest('#rsDetailClose')) {
        this._selectChannel(null);
        return;
      }

      // Add multi-instrument
      const addMulti = target.closest('.rs-btn-add-multi');
      if (addMulti) {
        this._addInstrumentToChannel(parseInt(addMulti.dataset.channel), channelKeys);
        return;
      }

      // Try split suggestion
      const trySplit = target.closest('.rs-btn-try-split');
      if (trySplit) {
        const ch = parseInt(trySplit.dataset.channel);
        const proposal = this.splitProposals[ch];
        if (proposal) {
          this.splitChannels.add(ch);
          this.splitAssignments[ch] = { ...proposal };
          this._refreshUI(channelKeys, 'both-panels');
        }
        return;
      }

      // Instrument chip selection
      const chip = target.closest('.aa-instbar-btn[data-instrument-id]');
      if (chip) {
        this._selectInstrument(chip.dataset.channel, chip.dataset.instrumentId, channelKeys);
        return;
      }

      // Low score toggle
      const showAll = target.closest('.aa-instbar-show-all');
      if (showAll) {
        const ch = showAll.dataset.channel;
        this.showLowScores[ch] = !this.showLowScores[ch];
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // Transposition buttons
      const transposeBtn = target.closest('.rs-transpose-btn');
      if (transposeBtn) {
        const ch = transposeBtn.dataset.channel;
        const delta = parseInt(transposeBtn.dataset.delta);
        if (ch && !isNaN(delta)) {
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          const current = this.adaptationSettings[ch].transpositionSemitones || 0;
          this.adaptationSettings[ch].transpositionSemitones = Math.max(-36, Math.min(36, current + delta));
          this._reclampSplitRanges(parseInt(ch));
          this._refreshUI(channelKeys, 'both-panels');
        }
        return;
      }

      // Polyphony target buttons
      const polyBtn = target.closest('.rs-poly-target-btn');
      if (polyBtn) {
        const ch = polyBtn.dataset.channel;
        const delta = parseInt(polyBtn.dataset.delta);
        if (ch && !isNaN(delta)) {
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          const current = this.adaptationSettings[ch].polyTarget || this._getInstrumentPolyphony(ch) || getGmDefaultPolyphony(this.selectedAssignments[ch]?.gmProgram) || 8;
          this.adaptationSettings[ch].polyTarget = Math.max(1, Math.min(128, current + delta));
          this._refreshUI(channelKeys, 'detail');
        }
        return;
      }

      // Accept split
      const acceptSplit = target.closest('.rs-btn-accept-split');
      if (acceptSplit) {
        this._acceptSplit(parseInt(acceptSplit.dataset.channel), channelKeys);
        return;
      }

      // Split mode tabs
      const splitModeBtn = target.closest('.rs-split-mode-btn');
      if (splitModeBtn) {
        const ch = parseInt(splitModeBtn.dataset.channel);
        this.activeSplitMode[ch] = splitModeBtn.dataset.mode;
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // Remove split (must check before split header since it's nested)
      const removeSplit = target.closest('.rs-btn-remove-split');
      if (removeSplit) {
        e.stopPropagation();
        const ch = parseInt(removeSplit.dataset.channel);
        this.splitChannels.delete(ch);
        delete this.splitAssignments[ch];
        this._refreshUI(channelKeys, 'both-panels');
        return;
      }

      // Split header collapse/expand
      const splitHeader = target.closest('.rs-split-header');
      if (splitHeader) {
        const ch = parseInt(splitHeader.dataset.channel);
        this.splitExpanded[ch] = !this.splitExpanded[ch];
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // Add segment
      const addSeg = target.closest('.rs-btn-add-segment');
      if (addSeg) {
        this._addSplitSegment(parseInt(addSeg.dataset.channel), channelKeys);
        return;
      }

      // Remove segment
      const removeSeg = target.closest('.rs-btn-remove-segment');
      if (removeSeg) {
        this._removeSplitSegment(parseInt(removeSeg.dataset.channel), parseInt(removeSeg.dataset.seg), channelKeys);
        return;
      }

      // Overlap resolution
      const overlapBtn = target.closest('.rs-overlap-resolve-btn');
      if (overlapBtn) {
        this._resolveOverlap(parseInt(overlapBtn.dataset.channel), parseInt(overlapBtn.dataset.overlap), overlapBtn.dataset.strategy, channelKeys);
        return;
      }

      // CC mute/unmute
      const muteBtn = target.closest('.rs-cc-mute-btn');
      if (muteBtn) {
        const ch = muteBtn.dataset.channel;
        const ccNum = parseInt(muteBtn.dataset.cc);
        if (!this.ccRemapping[ch]) this.ccRemapping[ch] = {};
        if (this.ccRemapping[ch][ccNum] === -1) {
          delete this.ccRemapping[ch][ccNum];
          if (Object.keys(this.ccRemapping[ch]).length === 0) delete this.ccRemapping[ch];
        } else {
          this.ccRemapping[ch][ccNum] = -1;
        }
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // Per-segment CC toggle
      const segToggle = target.closest('.rs-cc-seg-toggle');
      if (segToggle) {
        e.stopPropagation();
        const channel = parseInt(segToggle.dataset.channel);
        const ccNum = parseInt(segToggle.dataset.cc);
        const segIdx = parseInt(segToggle.dataset.seg);
        if (!this.ccSegmentMute[channel]) this.ccSegmentMute[channel] = {};
        if (!this.ccSegmentMute[channel][ccNum]) this.ccSegmentMute[channel][ccNum] = new Set();
        const muted = this.ccSegmentMute[channel][ccNum];
        if (muted.has(segIdx)) {
          muted.delete(segIdx);
          if (muted.size === 0) delete this.ccSegmentMute[channel][ccNum];
          if (Object.keys(this.ccSegmentMute[channel]).length === 0) delete this.ccSegmentMute[channel];
        } else {
          muted.add(segIdx);
        }
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // CC section collapse/expand
      const ccToggle = target.closest('.rs-cc-toggle');
      if (ccToggle) {
        const ch = parseInt(ccToggle.dataset.channel);
        this.ccExpanded[ch] = !this.ccExpanded[ch];
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // CC show more pagination
      const ccShowMore = target.closest('.rs-cc-show-more');
      if (ccShowMore) {
        this.ccShowAll[parseInt(ccShowMore.dataset.channel)] = true;
        this._refreshUI(channelKeys, 'detail');
        return;
      }
    }, opts);

    // Delegated change handler for selects, radios, and inputs
    panel.addEventListener('change', (e) => {
      const target = e.target;

      // Adaptation radio buttons
      if (target.matches('.rs-adapt-radio input[type="radio"]')) {
        const ch = target.dataset.channel;
        const field = target.dataset.field;
        if (ch && field) {
          if (target.value === this.adaptationSettings[ch]?.[field]) return;
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          this.adaptationSettings[ch][field] = target.value;

          if (field === 'pitchShift') {
            const assignment = this.selectedAssignments[ch];
            const autoSemitones = assignment?.transposition?.semitones || 0;
            if (target.value === 'manual') {
              if (!this.adaptationSettings[ch].transpositionSemitones) {
                this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
              }
            } else if (target.value === 'auto') {
              this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
            } else {
              this.adaptationSettings[ch].transpositionSemitones = 0;
            }
            this._reclampSplitRanges(parseInt(ch));
          }
          this._refreshUI(channelKeys, 'both-panels');
        }
        return;
      }

      // Polyphony target input
      if (target.matches('.rs-poly-target-input')) {
        const ch = target.dataset.channel;
        const val = parseInt(target.value);
        if (ch && !isNaN(val) && val >= 1) {
          if (!this.adaptationSettings[ch]) this.adaptationSettings[ch] = {};
          this.adaptationSettings[ch].polyTarget = Math.max(1, Math.min(128, val));
          this._refreshUI(channelKeys, 'detail');
        }
        return;
      }

      // Segment instrument selection
      if (target.matches('.rs-seg-instrument-select')) {
        this._updateSegmentInstrument(parseInt(target.dataset.channel), parseInt(target.dataset.seg), target.value, target.dataset.mode, channelKeys);
        return;
      }

      // Segment range inputs
      if (target.matches('.rs-seg-range-input')) {
        this._updateSegmentRange(parseInt(target.dataset.channel), parseInt(target.dataset.seg), target.dataset.bound, target.value, channelKeys);
        return;
      }

      // CC remapping dropdowns
      if (target.matches('.rs-cc-remap')) {
        const ch = target.dataset.channel;
        const sourceCC = parseInt(target.dataset.source);
        const targetCC = target.value ? parseInt(target.value) : null;
        if (!this.ccRemapping[ch]) this.ccRemapping[ch] = {};
        if (targetCC !== null) {
          this.ccRemapping[ch][sourceCC] = targetCC;
        } else {
          delete this.ccRemapping[ch][sourceCC];
          if (Object.keys(this.ccRemapping[ch]).length === 0) delete this.ccRemapping[ch];
        }
      }
    }, opts);

    // --- Split viz slider drag handling ---
    // During drag: update slider visually in real-time (no re-render).
    // On pointerup: commit data + full refresh to sync inputs and other UI.
    panel.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.rs-split-viz-handle');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();

      const slider = handle.closest('.rs-split-viz-slider');
      if (!slider) return;
      const vizContainer = slider.closest('.rs-split-viz-v2');
      if (!vizContainer) return;

      const ch = parseInt(slider.dataset.channel);
      const segIdx = parseInt(slider.dataset.seg);
      const bound = handle.dataset.bound; // 'min' or 'max'
      const physMin = parseInt(slider.dataset.physMin);
      const physMax = parseInt(slider.dataset.physMax);
      const chMin = parseInt(vizContainer.dataset.chMin);
      const chMax = parseInt(vizContainer.dataset.chMax);
      const noteCount = chMax - chMin + 1;
      if (noteCount <= 0) return; // invalid range, abort drag

      // Get the inst-row track for coordinate mapping
      const row = slider.closest('.rs-split-viz-inst-row');
      if (!row) return;

      // Read current range from split data
      const data = this._getActiveSplitData(ch);
      if (!data?.segments?.[segIdx]) return;
      let curMin = data.segments[segIdx].noteRange?.min ?? physMin;
      let curMax = data.segments[segIdx].noteRange?.max ?? physMax;

      const onMove = (moveE) => {
        const rect = row.getBoundingClientRect();
        const relX = Math.max(0, Math.min(rect.width, moveE.clientX - rect.left));
        const pct = relX / rect.width;
        let noteValue = Math.round(chMin + pct * (noteCount - 1));
        noteValue = Math.max(physMin, Math.min(physMax, noteValue));
        noteValue = Math.max(0, Math.min(127, noteValue));

        if (bound === 'min') {
          curMin = Math.min(noteValue, curMax);
        } else {
          curMax = Math.max(noteValue, curMin);
        }

        // Visual update (no re-render) — reposition slider + update tooltip
        const leftPct = ((curMin - chMin) / noteCount) * 100;
        const widthPct = Math.max(2, ((curMax - curMin + 1) / noteCount) * 100);
        slider.style.left = leftPct + '%';
        slider.style.width = widthPct + '%';
        slider.title = `${midiNoteToName(curMin)}\u2013${midiNoteToName(curMax)}`;
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        slider.releasePointerCapture?.(e.pointerId);

        // Commit final values to data model + full refresh
        this.splitEdited[ch] = true;
        data.segments[segIdx].noteRange.min = curMin;
        data.segments[segIdx].noteRange.max = curMax;
        this._refreshUI(channelKeys, 'both-panels');
      };

      slider.setPointerCapture?.(e.pointerId);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    }, opts);
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

    // Compute new noteRange clamped to instrument's physical range AND transposed channel range
    const analysis = this.channelAnalyses[channel];
    const adaptSettings = this.adaptationSettings[String(channel)] || {};
    const semi = (this.autoAdaptation && adaptSettings.pitchShift !== 'none') ? (adaptSettings.transpositionSemitones || 0) : 0;
    const tCh = safeNoteRange((analysis?.noteRange?.min ?? 0) + semi, (analysis?.noteRange?.max ?? 127) + semi);
    const instMin = inst.note_range_min ?? 0;
    const instMax = inst.note_range_max ?? 127;
    const newNoteRange = safeNoteRange(Math.max(instMin, tCh.min), Math.min(instMax, tCh.max));

    // Update the segment with the new instrument
    target.segments[segIdx] = {
      ...target.segments[segIdx],
      instrumentId: inst.id,
      deviceId: inst.device_id,
      instrumentChannel: inst.channel,
      instrumentName: this._getInstrumentDisplayName(inst),
      gmProgram: inst.gm_program,
      fullRange: safeNoteRange(instMin, instMax),
      noteRange: newNoteRange
    };

    this._refreshUI(channelKeys, 'both-panels');
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

    // Compute transposed channel range
    const adaptSettings = this.adaptationSettings[ch] || {};
    const semi = (this.autoAdaptation && adaptSettings.pitchShift !== 'none') ? (adaptSettings.transpositionSemitones || 0) : 0;
    const tCh = safeNoteRange((analysis?.noteRange?.min ?? 0) + semi, (analysis?.noteRange?.max ?? 127) + semi);

    // Compute default range: largest gap in current coverage, or instrument range
    const sorted = [...data.segments].sort((a, b) => (a.noteRange?.min ?? 0) - (b.noteRange?.min ?? 0));
    let bestGap = { min: tCh.min, max: tCh.max, size: 0 };
    let prev = tCh.min;
    for (const seg of sorted) {
      const gapStart = prev;
      const gapEnd = (seg.noteRange?.min ?? tCh.min) - 1;
      if (gapEnd >= gapStart && (gapEnd - gapStart) > bestGap.size) {
        bestGap = { min: gapStart, max: gapEnd, size: gapEnd - gapStart };
      }
      prev = Math.max(prev, (seg.noteRange?.max ?? 0) + 1);
    }
    if (tCh.max >= prev && (tCh.max - prev) > bestGap.size) {
      bestGap = { min: prev, max: tCh.max, size: tCh.max - prev };
    }
    // If no meaningful gap, use instrument range clipped to channel
    const rangeMin = bestGap.size > 0 ? bestGap.min : Math.max(tCh.min, newInst.note_range_min ?? 0);
    const rangeMax = bestGap.size > 0 ? bestGap.max : Math.min(tCh.max, newInst.note_range_max ?? 127);

    data.segments.push({
      instrumentId: newInst.id,
      deviceId: newInst.device_id,
      instrumentChannel: newInst.channel,
      instrumentName: this._getInstrumentDisplayName(newInst),
      gmProgram: newInst.gm_program,
      noteRange: safeNoteRange(rangeMin, rangeMax),
      fullRange: safeNoteRange(newInst.note_range_min ?? 0, newInst.note_range_max ?? 127),
      polyphonyShare: newInst.polyphony || 16
    });

    this._refreshUI(channelKeys, 'both-panels');
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

    this._refreshUI(channelKeys, 'both-panels');
  }

  /**
   * Reclamp all split segment noteRanges to the current transposed channel range.
   * Called when transposition changes to keep segments within visible bounds.
   */
  _reclampSplitRanges(channel) {
    const ch = String(channel);
    const data = this._getActiveSplitData(channel);
    if (!data?.segments?.length) return;

    const analysis = this.channelAnalyses[channel];
    const adaptSettings = this.adaptationSettings[ch] || {};
    const semi = (this.autoAdaptation && adaptSettings.pitchShift !== 'none') ? (adaptSettings.transpositionSemitones || 0) : 0;
    const tCh = safeNoteRange((analysis?.noteRange?.min ?? 0) + semi, (analysis?.noteRange?.max ?? 127) + semi);

    for (const seg of data.segments) {
      const physMin = seg.fullRange?.min ?? 0;
      const physMax = seg.fullRange?.max ?? 127;
      // Reclamp: intersection of instrument physical range and transposed channel range
      const clamped = safeNoteRange(Math.max(physMin, tCh.min), Math.min(physMax, tCh.max));
      seg.noteRange = clamped;
    }
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
    this._refreshUI(channelKeys, 'both-panels');
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

    this._refreshUI(channelKeys, 'both-panels');
  }

  // ============================================================================
  // Actions
  // ============================================================================

  _selectChannel(channel) {
    this.selectedChannel = channel;
    const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    this._refreshUI(channelKeys, 'both-panels');
  }

  _selectInstrument(ch, instrumentId, channelKeys) {
    // Invalidate segment instrument cache when assignment changes
    this._segmentInstrumentCache = null;
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
    this._refreshUI(channelKeys, 'both-panels');
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
    this._refreshUI(channelKeys, 'both-panels');
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

    // Compute transposed channel range for clamping
    const adaptSettings = this.adaptationSettings[ch] || {};
    const semi = (this.autoAdaptation && adaptSettings.pitchShift !== 'none') ? (adaptSettings.transpositionSemitones || 0) : 0;
    const tCh = safeNoteRange((analysis?.noteRange?.min ?? 0) + semi, (analysis?.noteRange?.max ?? 127) + semi);

    // Segment for the currently assigned instrument (clamped to its physical range)
    const curInstMin = assignment.noteRangeMin ?? 0;
    const curInstMax = assignment.noteRangeMax ?? 127;
    const curRange = safeNoteRange(Math.max(curInstMin, tCh.min), Math.min(curInstMax, tCh.max));
    const currentSeg = {
      instrumentId: assignment.instrumentId,
      deviceId: assignment.deviceId,
      instrumentChannel: assignment.instrumentChannel,
      instrumentName: assignment.instrumentDisplayName || assignment.customName || getGmProgramName(assignment.gmProgram) || assignment.instrumentName,
      gmProgram: assignment.gmProgram,
      noteRange: curRange,
      fullRange: safeNoteRange(curInstMin, curInstMax)
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
      noteRange: safeNoteRange(Math.max(secondInst.note_range_min ?? 0, tCh.min), Math.min(secondInst.note_range_max ?? 127, tCh.max)),
      fullRange: safeNoteRange(secondInst.note_range_min ?? 0, secondInst.note_range_max ?? 127)
    } : { ...currentSeg }; // Duplicate if nothing else available

    // Default behavior mode: combineNoOverlap (division)
    const defaultMode = 'combineNoOverlap';

    this.splitChannels.add(channel);
    this.splitAssignments[channel] = {
      type: 'range',
      quality: 0,
      overlapStrategy: 'shared',
      behaviorMode: defaultMode,
      segments: [currentSeg, secondSeg]
    };
    this.splitExpanded[channel] = true;

    // Apply the default behavior mode to configure segments properly
    this._applyBehaviorMode(channel, defaultMode);
    this._refreshUI(channelKeys, 'both-panels');
  }

  /**
   * Apply a behavior mode to the split assignment, reconfiguring segments accordingly.
   * @param {number} channel
   * @param {string} mode - 'overflow'|'combineNoOverlap'|'combineWithOverlap'|'alternate'
   */
  _applyBehaviorMode(channel, mode) {
    const splitData = this.splitAssignments[channel];
    if (!splitData || !splitData.segments || splitData.segments.length < 2) return;

    const analysis = this.channelAnalyses[channel];
    const chMin = analysis?.noteRange?.min ?? 0;
    const chMax = analysis?.noteRange?.max ?? 127;
    const segA = splitData.segments[0];
    const segB = splitData.segments[1];

    splitData.behaviorMode = mode;

    switch (mode) {
      case 'overflow':
        // Both instruments cover full channel range; A is primary, B catches overflow
        segA.noteRange = { min: chMin, max: chMax };
        segB.noteRange = { min: chMin, max: chMax };
        splitData.type = 'polyphony';
        splitData.overlapStrategy = 'overflow';
        break;

      case 'combineNoOverlap': {
        // Auto-compute split point based on natural instrument ranges
        const aMax = segA.fullRange?.max ?? chMax;
        const bMin = segB.fullRange?.min ?? chMin;
        // Split point: midpoint of overlap, or boundary of ranges
        let splitPoint;
        if (aMax >= bMin) {
          // Overlap exists — split at midpoint
          splitPoint = Math.round((aMax + bMin) / 2);
        } else {
          // Gap — split at midpoint of gap
          splitPoint = Math.round((aMax + bMin) / 2);
        }
        splitPoint = Math.max(chMin, Math.min(chMax, splitPoint));
        segA.noteRange = { min: chMin, max: splitPoint };
        segB.noteRange = { min: splitPoint + 1, max: chMax };
        splitData.type = 'range';
        splitData.overlapStrategy = 'shared';
        break;
      }

      case 'combineWithOverlap': {
        // Use natural instrument ranges, allowing overlap
        const aEffMin = Math.max(segA.fullRange?.min ?? 0, chMin);
        const aEffMax = Math.min(segA.fullRange?.max ?? 127, chMax);
        const bEffMin = Math.max(segB.fullRange?.min ?? 0, chMin);
        const bEffMax = Math.min(segB.fullRange?.max ?? 127, chMax);
        segA.noteRange = { min: aEffMin, max: aEffMax };
        segB.noteRange = { min: bEffMin, max: bEffMax };
        splitData.type = 'range';
        splitData.overlapStrategy = 'shared';
        break;
      }

      case 'alternate':
        // Both instruments cover full channel range; notes alternate round-robin
        segA.noteRange = { min: chMin, max: chMax };
        segB.noteRange = { min: chMin, max: chMax };
        splitData.type = 'polyphony';
        splitData.overlapStrategy = 'alternate';
        break;
    }
  }

  /**
   * Update the behavior mode for a channel's multi-instrument split.
   * Called when user clicks a behavior mode button.
   */
  _refreshUI(channelKeys, hint = 'all') {
    // Only stop preview on full rebuild or panel-level navigation changes
    if (hint === 'all') {
      this._safeStopPreview();
      this._minimapCanvas = null;
    }

    // Merge hints: coalesce multiple rapid calls into one render per frame
    this._pendingHint = this._mergeHints(this._pendingHint, hint);
    this._pendingChannelKeys = channelKeys;

    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => {
        this._rafPending = false;
        const h = this._pendingHint || 'all';
        this._pendingHint = null;
        this._renderContent(h);
      });
    }
  }

  /**
   * Merge two render hints into the most inclusive one.
   */
  _mergeHints(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a === 'all' || b === 'all') return 'all';
    if (a === b) return a;
    if (a === 'both-panels' || b === 'both-panels') return 'both-panels';
    // summary + detail = both-panels
    if ((a === 'summary' && b === 'detail') || (a === 'detail' && b === 'summary')) return 'both-panels';
    return 'all';
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

      // Polyphony reduction settings
      const polyEnabled = this.autoAdaptation && adapt.polyReduction && adapt.polyReduction !== 'none';
      const polyTarget = polyEnabled
        ? (adapt.polyReduction === 'manual' && adapt.polyTarget != null
          ? adapt.polyTarget
          : (this._getInstrumentPolyphony(ch) || getGmDefaultPolyphony(assignment.gmProgram)))
        : null;

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
        ccRemapping: this.ccRemapping[ch] || null,
        polyReduction: polyEnabled,
        maxPolyphony: polyTarget,
        polyStrategy: polyEnabled ? (adapt.polyStrategy || 'shorten') : null,
        channelVolume: this._getChannelVolume(parseInt(ch))
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
      // Build per-segment CC mute map for serialization (Set → Array)
      const segMuteData = this.ccSegmentMute[chNum];
      const ccSegMuteSerialized = segMuteData ? Object.fromEntries(
        Object.entries(segMuteData).map(([cc, segs]) => [cc, [...segs]])
      ) : null;

      assignments[ch] = {
        split: true,
        splitMode: splitData.type || 'range',
        overlapStrategy: splitData.overlapStrategy || null,
        behaviorMode: splitData.behaviorMode || null,
        transposition: { semitones: splitSemitones },
        suppressOutOfRange: this.autoAdaptation ? (adapt.oorHandling === 'suppress') : false,
        noteCompression: this.autoAdaptation ? (adapt.oorHandling === 'compress') : false,
        ccRemapping: this.ccRemapping[ch] || null,
        ccSegmentMute: ccSegMuteSerialized,
        channelVolume: this._getChannelVolume(parseInt(ch)),
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
    let hasVolumeChange = false;
    for (const [ch, a] of Object.entries(assignments)) {
      if (a.transposition?.semitones && a.transposition.semitones !== 0) hasTransposition = true;
      if (a.suppressOutOfRange) hasOorSuppression = true;
      if (a.noteCompression) hasOorSuppression = true;
      if (a.ccRemapping && Object.keys(a.ccRemapping).length > 0) hasCCRemap = true;
      if (a.channelVolume !== undefined && a.channelVolume !== 100) hasVolumeChange = true;
    }
    const needsFileModification = hasSplit || hasTransposition || hasOorSuppression || hasCCRemap || hasVolumeChange;

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
    // Memoize: CC names are static per session
    if (this._ccNameCache?.[ccNum] !== undefined) return this._ccNameCache[ccNum];
    let name = `CC ${ccNum}`;
    if (typeof InstrumentSettingsModal !== 'undefined' && InstrumentSettingsModal.CC_GROUPS) {
      for (const group of Object.values(InstrumentSettingsModal.CC_GROUPS)) {
        if (group.ccs && group.ccs[ccNum]) {
          name = group.ccs[ccNum].name;
          break;
        }
      }
    }
    if (!this._ccNameCache) this._ccNameCache = {};
    this._ccNameCache[ccNum] = name;
    return name;
  }

  /**
   * Get channel volume (CC7) override, default 100.
   */
  _getChannelVolume(channel) {
    return this.channelVolumes[channel] ?? 100;
  }

  /**
   * Check if the assigned instrument for a channel supports CC7 (volume).
   */
  _supportsCC7(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    if (!assignment) return false;
    let ccs = assignment.supportedCcs;
    if (!ccs) return false;
    if (typeof ccs === 'string') { try { ccs = JSON.parse(ccs); } catch { return false; } }
    return Array.isArray(ccs) && ccs.includes(7);
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
      if (Array.isArray(fullInst.supported_ccs)) return fullInst.supported_ccs;
      try { return JSON.parse(fullInst.supported_ccs || '[]'); } catch { return null; }
    }
    // Priority 2: suggestions
    const found = this._findInstrumentById(instrumentId);
    if (found?.supported_ccs) {
      if (Array.isArray(found.supported_ccs)) return found.supported_ccs;
      try { return JSON.parse(found.supported_ccs || '[]'); } catch { return null; }
    }
    return null;
  }

  /**
   * Compute CC summary counts (lightweight — no DOM generation).
   * Returns { summaryHTML, supportedCount, unsupportedCount, allUnknown }.
   */
  _computeCCSummary(channel) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel];
    const channelCCs = analysis?.usedCCs || [];
    const assignment = this.selectedAssignments[ch];
    const isSplit = this.splitChannels.has(channel);
    const currentRemap = this.ccRemapping[ch] || {};

    if (isSplit && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      const segCCs = segs.map(seg => this._getInstrumentCCs(seg.instrumentId));
      const allUnknown = segCCs.every(ccs => ccs === null);

      let supportedByAll = 0, unsupportedByAny = 0;
      for (const ccNum of channelCCs) {
        const isDisabled = currentRemap[ccNum] === -1;
        const anyUnsupported = !isDisabled && segCCs.some(ccs => ccs !== null && !ccs.includes(ccNum));
        if (isDisabled || anyUnsupported) unsupportedByAny++;
        else supportedByAll++;
      }

      let summaryHTML;
      if (allUnknown) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
      } else if (unsupportedByAny === 0) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedByAll})</span>`;
      } else {
        summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedByAll}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedByAny} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
      }
      return { summaryHTML, supportedCount: supportedByAll, unsupportedCount: unsupportedByAny, allUnknown };
    }

    // Single instrument mode
    let instrumentCCs = assignment?.supportedCcs ?? null;
    if (instrumentCCs && typeof instrumentCCs === 'string') {
      try { instrumentCCs = JSON.parse(instrumentCCs); } catch { instrumentCCs = null; }
    }
    if (instrumentCCs == null && assignment?.instrumentId) {
      instrumentCCs = this._getInstrumentCCs(assignment.instrumentId);
    }

    let supportedCount = 0, unsupportedCount = 0;
    for (const ccNum of channelCCs) {
      const isDisabled = currentRemap[ccNum] === -1;
      if (isDisabled) { unsupportedCount++; }
      else if (instrumentCCs === null || instrumentCCs.includes(ccNum)) { supportedCount++; }
      else { unsupportedCount++; }
    }

    let summaryHTML;
    if (instrumentCCs === null) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
    } else if (unsupportedCount === 0) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedCount})</span>`;
    } else {
      summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedCount}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedCount} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
    }
    return { summaryHTML, supportedCount, unsupportedCount, allUnknown: instrumentCCs === null };
  }

  _renderCCSection(channel) {
    const CC_PAGE_SIZE = 10;
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel];
    const channelCCs = analysis?.usedCCs || [];
    const assignment = this.selectedAssignments[ch];
    const isSplit = this.splitChannels.has(channel);
    const isSkipped = this.skippedChannels.has(channel);

    if (isSkipped || (!assignment && !isSplit)) return '';
    if (channelCCs.length === 0) return '';

    const isExpanded = this.ccExpanded[channel] ?? false;
    const { summaryHTML } = this._computeCCSummary(channel);
    const toggleIcon = isExpanded ? '\u25BE' : '\u25B8';

    // ── Collapsed: show only title + summary (no heavy DOM) ──
    if (!isExpanded) {
      return `
        <div class="rs-cc-section">
          <h4 class="rs-cc-title rs-cc-toggle" data-channel="${channel}" style="cursor:pointer">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'} ${toggleIcon} <small>(${channelCCs.length})</small></h4>
          ${summaryHTML}
        </div>`;
    }

    // ── Expanded: render rows with pagination ──
    const showAll = this.ccShowAll[channel] ?? false;
    const visibleCCs = showAll ? channelCCs : channelCCs.slice(0, CC_PAGE_SIZE);
    const hasMore = !showAll && channelCCs.length > CC_PAGE_SIZE;

    const splitColors = SPLIT_COLORS;
    const currentRemap = this.ccRemapping[ch] || {};
    // Pre-compute Set for O(1) lookups instead of O(n) includes
    const channelCCSet = new Set(channelCCs);

    // ── Split mode: per-instrument columns ──
    if (isSplit && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      if (segs.length === 0) return '';

      // Resolve CCs for each segment
      const segCCs = segs.map(seg => this._getInstrumentCCs(seg.instrumentId));

      // Table header: CC | Name | Inst1 | Inst2 | ...
      const headerCols = segs.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const instRef = seg.instrumentId ? (this.allInstruments || []).find(ii => ii.id === seg.instrumentId) : null;
        const name = instRef ? this._getInstrumentDisplayName(instRef) : (seg.instrumentName || '?');
        const short = name.length > 10 ? name.slice(0, 9) + '\u2026' : name;
        return `<th class="rs-cc-inst-col" style="color:${color}" title="${escapeHtml(name)}">${escapeHtml(short)}</th>`;
      }).join('');

      // Table rows: one per visible CC, with remap for unsupported
      const bodyRows = visibleCCs.map(ccNum => {
        const name = this._getCCName(ccNum);
        const isDisabled = currentRemap[ccNum] === -1;

        const muteActive = isDisabled ? ' rs-cc-mute-active' : '';
        const muteTitle = isDisabled
          ? (_t('routingSummary.ccEnable') || 'Activer ce CC')
          : (_t('routingSummary.ccDisable') || 'Désactiver ce CC');
        const muteBtn = `<td class="rs-cc-mute-cell"><button class="rs-cc-mute-btn${muteActive}" data-channel="${ch}" data-cc="${ccNum}" title="${muteTitle}">${isDisabled ? '\u{1F507}' : '\u{1F509}'}</button></td>`;

        const segMutes = this.ccSegmentMute[channel]?.[ccNum];
        let cells;
        if (isDisabled) {
          cells = segs.map(() => `<td class="rs-cc-cell rs-cc-cell-disabled">\u2014</td>`).join('');
        } else {
          cells = segCCs.map((ccs, i) => {
            const isSegMuted = segMutes?.has(i);
            const segToggleClass = isSegMuted ? ' rs-cc-seg-muted' : '';
            const segToggleBtn = `<button class="rs-cc-seg-toggle${segToggleClass}" data-channel="${channel}" data-cc="${ccNum}" data-seg="${i}" title="${isSegMuted ? _t('routingSummary.ccEnable') || 'Enable this CC' : _t('routingSummary.ccDisable') || 'Disable this CC'}">${isSegMuted ? '\u{1F507}' : '\u{1F509}'}</button>`;

            if (isSegMuted) {
              return `<td class="rs-cc-cell rs-cc-cell-seg-muted">${segToggleBtn}</td>`;
            }
            if (ccs === null) return `<td class="rs-cc-cell rs-cc-cell-unknown">${segToggleBtn} ?</td>`;
            if (ccs.includes(ccNum)) return `<td class="rs-cc-cell rs-cc-cell-ok">${segToggleBtn} \u2713</td>`;
            // Unsupported: show remap dropdown
            const currentTarget = currentRemap[ccNum];
            const remapOpts = (ccs || [])
              .filter(tc => !channelCCSet.has(tc) || tc === ccNum)
              .map(tc => `<option value="${tc}" ${currentTarget === tc ? 'selected' : ''}>${this._getCCName(tc)}</option>`)
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
        return `<tr class="${rowClass}">${muteBtn}<td class="rs-cc-num">CC${ccNum}</td><td class="rs-cc-name">${escapeHtml(name)}</td>${cells}</tr>`;
      }).join('');

      const showMoreRow = hasMore
        ? `<tr><td colspan="${3 + segs.length}" class="rs-cc-show-more" data-channel="${channel}" style="cursor:pointer;text-align:center;padding:6px">${_t('routingSummary.showAllCCs') || 'Voir tout'} (${channelCCs.length - CC_PAGE_SIZE} ${_t('routingSummary.more') || 'de plus'})</td></tr>`
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

    // ── Single instrument mode (table layout matching split mode) ──
    let instrumentCCs = assignment?.supportedCcs ?? null;
    if (instrumentCCs && typeof instrumentCCs === 'string') {
      try { instrumentCCs = JSON.parse(instrumentCCs); } catch { instrumentCCs = null; }
    }
    if (instrumentCCs == null && assignment?.instrumentId) {
      instrumentCCs = this._getInstrumentCCs(assignment.instrumentId);
    }

    const instName = assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || _t('autoAssign.instrument');
    const instShort = instName.length > 10 ? instName.slice(0, 9) + '\u2026' : instName;

    const bodyRows = visibleCCs.map(ccNum => {
      const name = this._getCCName(ccNum);
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
        // Unsupported: show remap dropdown
        const currentTarget = currentRemap[ccNum];
        const remapOpts = instrumentCCs
          .filter(targetCC => !channelCCSet.has(targetCC) || targetCC === ccNum)
          .map(targetCC => {
            const selected = currentTarget === targetCC ? 'selected' : '';
            return `<option value="${targetCC}" ${selected}>${this._getCCName(targetCC)}</option>`;
          }).join('');
        statusCell = `<td class="rs-cc-cell rs-cc-cell-no">
          <select class="rs-cc-remap" data-channel="${ch}" data-source="${ccNum}">
            <option value="">\u2717</option>
            ${remapOpts}
          </select>
        </td>`;
      }

      const rowClass = isDisabled ? 'rs-cc-row-disabled' : (instrumentCCs !== null && !instrumentCCs.includes(ccNum) && !isDisabled ? 'rs-cc-row-warn' : '');
      return `<tr class="${rowClass}">${muteBtn}<td class="rs-cc-num">CC${ccNum}</td><td class="rs-cc-name">${escapeHtml(name)}</td>${statusCell}</tr>`;
    }).join('');

    const showMoreRow = hasMore
      ? `<tr><td colspan="4" class="rs-cc-show-more" data-channel="${channel}" style="cursor:pointer;text-align:center;padding:6px">${_t('routingSummary.showAllCCs') || 'Voir tout'} (${channelCCs.length - CC_PAGE_SIZE} ${_t('routingSummary.more') || 'de plus'})</td></tr>`
      : '';

    return `
      <div class="rs-cc-section">
        <h4 class="rs-cc-title rs-cc-toggle" data-channel="${channel}" style="cursor:pointer">\uD83C\uDF9B ${_t('routingSummary.ccTitle') || 'Contr\u00f4leurs MIDI (CC)'} ${toggleIcon} <small>(${channelCCs.length})</small></h4>
        ${summaryHTML}
        <table class="rs-cc-table">
          <thead><tr><th></th><th>CC</th><th>${_t('common.name') || 'Nom'}</th><th class="rs-cc-inst-col" title="${escapeHtml(instName)}">${escapeHtml(instShort)}</th></tr></thead>
          <tbody>${bodyRows}${showMoreRow}</tbody>
        </table>
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
          <span class="rs-prev-icon">&#9654;</span> ${_t('routingSummary.previewChannel') || 'Channel'} ${chLabel}
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

    // Get transposition semitones for a channel (matches preview behaviour)
    const getTransposition = (ch) => {
      if (skipRangeFilter) return 0;
      const chStr = String(ch);
      const adapt = this.adaptationSettings[chStr] || {};
      return adapt.transpositionSemitones || 0;
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

          // Filter: apply transposition then check instrument range (same as preview)
          const range = getRange(ch);
          if (range) {
            const transposed = Math.max(0, Math.min(127, note + getTransposition(ch)));
            if (transposed < range.min || transposed > range.max) continue;
          }

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

  /**
   * Apply per-channel volume overrides (CC7) to the preview synthesizer.
   */
  _applyPreviewVolumes() {
    if (!this.audioPreview?.synthesizer) return;
    for (let ch = 0; ch < 16; ch++) {
      this.audioPreview.synthesizer.setChannelVolume(ch, this._getChannelVolume(ch));
    }
  }

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
        // Redistribute notes by range, with overlap strategy handling
        // Also duplicate CC events to each segment channel, respecting per-segment mutes
        const overlapStrat = this.splitAssignments[sourceChannel]?.overlapStrategy;
        const chRemap = this.ccRemapping[String(sourceChannel)] || {};
        const chSegMute = this.ccSegmentMute[sourceChannel] || {};
        let alternateCounter = 0; // for 'alternate' round-robin
        const activeNotes = new Map(); // for 'overflow': segChannel -> count of active notes
        for (const sCh of segChannels) activeNotes.set(sCh, 0);
        const segPolyphony = segments.map(seg => seg.polyphonyShare || seg.fullRange?.polyphony || 16);

        for (const track of (previewMidi.tracks || [])) {
          const dupes = [];
          const evtsToRemove = [];
          let tick = 0;
          for (let ei = 0; ei < track.events.length; ei++) {
            const evt = track.events[ei];
            if (evt.deltaTime !== undefined) tick += evt.deltaTime;
            evt._absTick = tick;
            if ((evt.type === 'noteOn' || evt.type === 'noteOff') && (evt.channel ?? 0) === sourceChannel) {
              const note = evt.note ?? evt.noteNumber ?? 60;
              const isNoteOn = evt.type === 'noteOn' && (evt.velocity ?? 0) > 0;
              const matches = [];
              for (let si = 0; si < segments.length; si++) {
                const rMin = segments[si].noteRange?.min ?? 0;
                const rMax = segments[si].noteRange?.max ?? 127;
                if (note >= rMin && note <= rMax && si < segChannels.length) matches.push(si);
              }
              if (matches.length > 0) {
                if (matches.length === 1 || overlapStrat === 'shared') {
                  // No overlap or shared: send to first match + duplicate to others
                  evt.channel = segChannels[matches[0]];
                  if (overlapStrat === 'shared' && matches.length > 1) {
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else if (overlapStrat === 'alternate') {
                  // Round-robin: assign each note-on to next segment in rotation
                  if (isNoteOn) {
                    const target = matches[alternateCounter % matches.length];
                    evt.channel = segChannels[target];
                    alternateCounter++;
                  } else {
                    // noteOff: send to all matching segments (don't know which got the noteOn)
                    evt.channel = segChannels[matches[0]];
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else if (overlapStrat === 'overflow') {
                  // Primary plays until polyphony full, then overflow to secondary
                  if (isNoteOn) {
                    let assigned = false;
                    for (const si of matches) {
                      const sCh = segChannels[si];
                      if ((activeNotes.get(sCh) || 0) < segPolyphony[si]) {
                        evt.channel = sCh;
                        activeNotes.set(sCh, (activeNotes.get(sCh) || 0) + 1);
                        assigned = true;
                        break;
                      }
                    }
                    if (!assigned) evt.channel = segChannels[matches[0]]; // fallback
                  } else {
                    // noteOff: decrement on the segment that has it, send to all
                    evt.channel = segChannels[matches[0]];
                    for (const si of matches) {
                      const sCh = segChannels[si];
                      if ((activeNotes.get(sCh) || 0) > 0) activeNotes.set(sCh, activeNotes.get(sCh) - 1);
                    }
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else {
                  // Default: first match only
                  evt.channel = segChannels[matches[0]];
                }
              }
            } else if ((evt.type === 'controlChange' || evt.type === 'cc') && (evt.channel ?? 0) === sourceChannel) {
              const cc = evt.controllerNumber ?? evt.controller ?? evt.cc;
              // Global suppress: remove CC entirely
              if (chRemap[cc] === -1) { evtsToRemove.push(ei); continue; }
              // Duplicate CC to each non-muted segment channel
              const mutedSegs = chSegMute[cc];
              // Segment 0 keeps the original event (unless muted)
              if (mutedSegs?.has(0)) {
                evtsToRemove.push(ei);
              } else {
                evt.channel = segChannels[0];
              }
              for (let si = 1; si < segChannels.length; si++) {
                if (mutedSegs?.has(si)) continue;
                dupes.push({ ...evt, channel: segChannels[si], _absTick: tick });
              }
            }
          }
          // Remove suppressed events (reverse order)
          for (let ri = evtsToRemove.length - 1; ri >= 0; ri--) {
            track.events.splice(evtsToRemove[ri], 1);
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
      await this.audioPreview.initSynthesizer();
      this._applyPreviewVolumes();
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

        // Build modified MIDI data: redistribute notes by range with overlap strategy
        // Also duplicate CC events to segment channels, respecting per-segment mutes
        const overlapStrategy = this.splitAssignments[channel]?.overlapStrategy;
        const chRemap = this.ccRemapping[ch] || {};
        const chSegMute = this.ccSegmentMute[channel] || {};
        let chAlternateCounter = 0;
        const chActiveNotes = new Map();
        for (const sCh of segChannels) chActiveNotes.set(sCh, 0);
        const chSegPoly = segs.map(seg => seg.polyphonyShare || seg.fullRange?.polyphony || 16);

        const splitMidi = JSON.parse(JSON.stringify(this.midiData));
        for (const track of (splitMidi.tracks || [])) {
          const dupes = [];
          const evtsToRemove = [];
          let tick = 0;
          for (let ei = 0; ei < track.events.length; ei++) {
            const evt = track.events[ei];
            if (evt.deltaTime !== undefined) tick += evt.deltaTime;
            evt._absTick = tick;

            if ((evt.type === 'noteOn' || evt.type === 'noteOff') && (evt.channel ?? 0) === channel) {
              const note = evt.note ?? evt.noteNumber ?? 60;
              const isNoteOn = evt.type === 'noteOn' && (evt.velocity ?? 0) > 0;
              const matches = [];
              for (let si = 0; si < segs.length; si++) {
                const rMin = segs[si].noteRange?.min ?? 0;
                const rMax = segs[si].noteRange?.max ?? 127;
                if (note >= rMin && note <= rMax && si < segChannels.length) matches.push(si);
              }
              if (matches.length > 0) {
                if (matches.length === 1 || overlapStrategy === 'shared') {
                  evt.channel = segChannels[matches[0]];
                  if (overlapStrategy === 'shared' && matches.length > 1) {
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else if (overlapStrategy === 'alternate') {
                  if (isNoteOn) {
                    const target = matches[chAlternateCounter % matches.length];
                    evt.channel = segChannels[target];
                    chAlternateCounter++;
                  } else {
                    evt.channel = segChannels[matches[0]];
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else if (overlapStrategy === 'overflow') {
                  if (isNoteOn) {
                    let assigned = false;
                    for (const si of matches) {
                      const sCh = segChannels[si];
                      if ((chActiveNotes.get(sCh) || 0) < chSegPoly[si]) {
                        evt.channel = sCh;
                        chActiveNotes.set(sCh, (chActiveNotes.get(sCh) || 0) + 1);
                        assigned = true;
                        break;
                      }
                    }
                    if (!assigned) evt.channel = segChannels[matches[0]];
                  } else {
                    evt.channel = segChannels[matches[0]];
                    for (const si of matches) {
                      const sCh = segChannels[si];
                      if ((chActiveNotes.get(sCh) || 0) > 0) chActiveNotes.set(sCh, chActiveNotes.get(sCh) - 1);
                    }
                    for (let mi = 1; mi < matches.length; mi++) {
                      dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                    }
                  }
                } else {
                  evt.channel = segChannels[matches[0]];
                }
              }
            } else if ((evt.type === 'controlChange' || evt.type === 'cc') && (evt.channel ?? 0) === channel) {
              const cc = evt.controllerNumber ?? evt.controller ?? evt.cc;
              if (chRemap[cc] === -1) { evtsToRemove.push(ei); continue; }
              const mutedSegs = chSegMute[cc];
              if (mutedSegs?.has(0)) {
                evtsToRemove.push(ei);
              } else {
                evt.channel = segChannels[0];
              }
              for (let si = 1; si < segChannels.length; si++) {
                if (mutedSegs?.has(si)) continue;
                dupes.push({ ...evt, channel: segChannels[si], _absTick: tick });
              }
            }
          }
          // Remove suppressed events (reverse order)
          for (let ri = evtsToRemove.length - 1; ri >= 0; ri--) {
            track.events.splice(evtsToRemove[ri], 1);
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
        // Mark all other channels as skipped so only segments are heard
        const channelConfigs = {};
        for (let c = 0; c < 16; c++) channelConfigs[c] = { skipped: true };
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
          await this.audioPreview.initSynthesizer();
          this._applyPreviewVolumes();
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
      await this.audioPreview.initSynthesizer();
      this._applyPreviewVolumes();
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

      // Reset state with new results — load backend split proposals
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
        const adapt = {
          pitchShift: assignment?.transposition?.semitones ? 'auto' : 'none',
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          oorHandling: 'passThrough',
          polyReduction: 'none',
          polyStrategy: 'shorten',
          polyTarget: null
        };

        // Auto-adaptation: enable polyphony reduction when instrument capacity is lower
        if (this.autoAdaptation) {
          const chPoly = this._getChannelPolyphony(parseInt(ch));
          const instPoly = this._getInstrumentPolyphony(parseInt(ch))
            || getGmDefaultPolyphony(assignment?.gmProgram);
          if (chPoly && instPoly && chPoly > instPoly) {
            adapt.polyReduction = 'auto';
            adapt.polyTarget = instPoly;
            adapt.polyStrategy = chPoly > instPoly * 2 ? 'drop' : 'shorten';
          }
        }

        this.adaptationSettings[ch] = adapt;
      }

      // Invalidate memoization caches after data reload
      this._segmentInstrumentCache = null;

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
    // Abort all delegated event listeners
    if (this._summaryAbort) { this._summaryAbort.abort(); this._summaryAbort = null; }
    if (this._detailAbort) { this._detailAbort.abort(); this._detailAbort = null; }
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
