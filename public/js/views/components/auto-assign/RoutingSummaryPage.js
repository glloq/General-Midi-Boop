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

function isBlackKey(note) {
  const n = note % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}

function getScoreStars(score) {
  const filled = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;
  return '<span class="rs-stars">' + '&#9733;'.repeat(filled) + '&#9734;'.repeat(5 - filled) + '</span>';
}

/**
 * Render a score breakdown bar for a single criterion
 */
function renderScoreBar(labelKey, data) {
  if (!data || data.max === 0) return '';
  const pct = data.max > 0 ? Math.round((data.score / data.max) * 100) : 0;
  return `
    <div class="rs-breakdown-row">
      <span class="rs-breakdown-label">${_t(labelKey)}</span>
      <div class="rs-breakdown-bar">
        <div class="rs-breakdown-fill ${getScoreBgClass(pct)}" style="width: ${pct}%"></div>
      </div>
      <span class="rs-breakdown-value">${data.score}/${data.max}</span>
    </div>
  `;
}

/**
 * Render a mini piano roll showing channel notes vs instrument range
 */
function renderPianoRoll(analysis, assignment) {
  if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';
  if (!assignment || assignment.noteRangeMin == null) return '';

  const noteDistribution = analysis.noteDistribution || {};
  const usedNotes = Object.keys(noteDistribution).map(Number);
  if (usedNotes.length === 0) return '';

  const instMin = assignment.noteRangeMin != null ? assignment.noteRangeMin : 0;
  const instMax = assignment.noteRangeMax != null ? assignment.noteRangeMax : 127;
  const chMin = Math.min(...usedNotes);
  const chMax = Math.max(...usedNotes);

  const globalMin = Math.max(0, Math.min(chMin, instMin) - 2);
  const globalMax = Math.min(127, Math.max(chMax, instMax) + 2);
  const maxCount = Math.max(...Object.values(noteDistribution), 1);

  let inRangeCount = 0, outOfRangeCount = 0;
  for (const note of usedNotes) {
    if (note >= instMin && note <= instMax) inRangeCount++;
    else outOfRangeCount++;
  }

  let keysHTML = '';
  for (let note = globalMin; note <= globalMax; note++) {
    const black = isBlackKey(note);
    const isUsed = noteDistribution[note] !== undefined;
    const inRange = note >= instMin && note <= instMax;
    const usage = isUsed ? noteDistribution[note] / maxCount : 0;

    let statusClass = '';
    if (isUsed && inRange) statusClass = 'used-ok';
    else if (isUsed && !inRange) statusClass = 'used-out';
    else if (inRange) statusClass = 'in-range';

    const opacity = isUsed ? `opacity: ${Math.max(0.4, usage)}` : '';
    const title = isUsed
      ? `${midiNoteToName(note)} (${note}) - ${noteDistribution[note]}x${inRange ? '' : ' [OUT]'}`
      : `${midiNoteToName(note)} (${note})`;

    keysHTML += `<div class="rs-piano-key ${black ? 'black' : 'white'} ${statusClass}" title="${title}" style="${opacity}"></div>`;
  }

  const summaryClass = outOfRangeCount > 0 ? 'rs-summary-warning' : 'rs-summary-ok';
  const summaryText = outOfRangeCount > 0
    ? `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${inRangeCount} ${_t('autoAssign.inRange')}, ${outOfRangeCount} ${_t('autoAssign.outOfRange')}`
    : `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${_t('autoAssign.allInRange')}`;

  return `
    <div class="rs-piano-section">
      <div class="rs-piano-labels">
        <span>${_t('autoAssign.channelNotes')}: ${midiNoteToName(chMin)}-${midiNoteToName(chMax)}</span>
        <span>${_t('autoAssign.instrumentRange')}: ${midiNoteToName(instMin)}-${midiNoteToName(instMax)}</span>
      </div>
      <div class="rs-piano-roll">${keysHTML}</div>
      <div class="rs-piano-legend">
        <span class="rs-legend-item"><span class="rs-legend-key used-ok"></span> ${_t('autoAssign.legendInRange')}</span>
        <span class="rs-legend-item"><span class="rs-legend-key used-out"></span> ${_t('autoAssign.legendOutOfRange')}</span>
        <span class="rs-legend-item"><span class="rs-legend-key in-range"></span> ${_t('autoAssign.legendAvailable')}</span>
      </div>
      <div class="rs-piano-summary ${summaryClass}">${summaryText}</div>
    </div>
  `;
}

/**
 * Render piano roll for split channels showing multiple instrument ranges
 */
function renderSplitPianoRoll(analysis, splitData) {
  if (!analysis?.noteRange?.min || !splitData?.segments?.length) return '';

  const noteDistribution = analysis.noteDistribution || {};
  const usedNotes = Object.keys(noteDistribution).map(Number);
  if (usedNotes.length === 0) return '';

  const segments = splitData.segments;
  const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];

  // Global range
  let allMins = usedNotes, allMaxs = usedNotes;
  for (const seg of segments) {
    if (seg.noteRange) { allMins = [...allMins, seg.noteRange.min]; allMaxs = [...allMaxs, seg.noteRange.max]; }
    if (seg.fullRange) { allMins = [...allMins, seg.fullRange.min]; allMaxs = [...allMaxs, seg.fullRange.max]; }
  }
  const globalMin = Math.max(0, Math.min(...allMins) - 2);
  const globalMax = Math.min(127, Math.max(...allMaxs) + 2);
  const maxCount = Math.max(...Object.values(noteDistribution), 1);

  // Build instrument range lookup: for each note, which segment(s) cover it
  function noteInSegment(note, seg) {
    const min = seg.fullRange?.min ?? seg.noteRange?.min ?? 0;
    const max = seg.fullRange?.max ?? seg.noteRange?.max ?? 127;
    return note >= min && note <= max;
  }

  let keysHTML = '';
  for (let note = globalMin; note <= globalMax; note++) {
    const black = isBlackKey(note);
    const isUsed = noteDistribution[note] !== undefined;
    const usage = isUsed ? noteDistribution[note] / maxCount : 0;

    // Find which segment covers this note
    const coveringIdx = segments.findIndex(seg => noteInSegment(note, seg));
    const inRange = coveringIdx >= 0;

    let statusClass = '';
    let bgStyle = '';
    if (isUsed && inRange) {
      statusClass = 'used-ok';
      bgStyle = `background: ${splitColors[coveringIdx % splitColors.length]} !important`;
    } else if (isUsed && !inRange) {
      statusClass = 'used-out';
    } else if (inRange) {
      const color = splitColors[coveringIdx % splitColors.length];
      bgStyle = `background: ${color}22`;
    }

    const opacity = isUsed ? `opacity: ${Math.max(0.4, usage)}` : '';
    keysHTML += `<div class="rs-piano-key ${black ? 'black' : 'white'} ${statusClass}" style="${bgStyle};${opacity}"></div>`;
  }

  // Legend with segment colors
  const legendHTML = segments.map((seg, i) => {
    const name = seg.instrumentName || `Instrument ${i + 1}`;
    const color = splitColors[i % splitColors.length];
    const range = seg.noteRange ? `${midiNoteToName(seg.noteRange.min)}-${midiNoteToName(seg.noteRange.max)}` : '';
    return `<span class="rs-legend-item"><span class="rs-legend-key" style="background:${color}"></span> ${escapeHtml(name)} ${range}</span>`;
  }).join('');

  return `
    <div class="rs-piano-section">
      <div class="rs-piano-labels"><span>${_t('autoAssign.channelNotes')}</span><span>${segments.length} ${_t('routingSummary.instruments')}</span></div>
      <div class="rs-piano-roll">${keysHTML}</div>
      <div class="rs-piano-legend">${legendHTML}</div>
    </div>
  `;
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
    this.allInstruments = [];
    this.confidenceScore = 0;

    // UI state
    this.selectedChannel = null; // Channel selected for detail view
    this.onApplyCallback = null;
    this.loading = true;
    this.adaptationSettings = {}; // Per-channel adaptation overrides
    this.showLowScores = {}; // Per-channel toggle for low score instruments

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
          <div class="rs-header-left">
            ${this.midiData ? this._renderHeaderPreview() : `<h2>${_t('routingSummary.title')}</h2>`}
          </div>
          <div class="rs-header-center">
            <span class="rs-confidence ${getScoreClass(this.confidenceScore)}">
              ${this.confidenceScore}/100 — ${getScoreLabel(this.confidenceScore)}
            </span>
            <span class="rs-channel-count">
              ${_t('autoAssign.channelsWillBeAssigned', { active: activeCount, total: channelKeys.length })}
            </span>
          </div>
          <div class="rs-header-right">
            <button class="rs-settings-btn ${this._isOverrideModified() ? 'modified' : ''}" id="rsSettingsBtn" title="${_t('routingSummary.settings')}">&#9881;</button>
            <button class="modal-close" id="rsSummaryClose">&times;</button>
          </div>
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

      // Score dot indicator (compact visual feedback in table)
      const scoreDotClass = isSkipped ? 'rs-dot-skip' : (score >= 70 ? 'rs-dot-ok' : score >= 40 ? 'rs-dot-warn' : 'rs-dot-poor');

      return `
        <tr class="rs-row ${isSkipped ? 'skipped' : ''} ${statusClass} ${isSelected ? 'selected' : ''}"
            tabindex="0" role="button" data-channel="${channel}"
            aria-label="${_t('autoAssign.channel')} ${channel + 1}">
          <td class="rs-col-ch">
            <span class="rs-score-dot ${scoreDotClass}"></span>
            ${typeIcon} Ch ${channel + 1}${channel === 9 ? ' <span class="rs-drum-badge">DR</span>' : ''} ${splitBadge}
          </td>
          <td class="rs-col-original">${escapeHtml(gmName)}</td>
          <td class="rs-col-assigned">${isSkipped ? '<span class="rs-skipped">' + statusLabel + '</span>' : escapeHtml(assignedName)}${isSplit ? renderSplitBar(this.splitAssignments[channel], analysis) : ''}</td>
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
    const isDrumChannel = channel === 9 || analysis?.estimatedType === 'drums';
    const adaptation = this.adaptationSettings[ch] || {};

    // Channel info
    const gmName = channel === 9 ? _t('autoAssign.drums') : (getGmProgramName(analysis?.primaryProgram) || '\u2014');
    const typeIcon = analysis?.estimatedType ? getTypeIcon(analysis.estimatedType) : '';
    const noteRangeStr = analysis?.noteRange?.min != null
      ? `${midiNoteToName(analysis.noteRange.min)} - ${midiNoteToName(analysis.noteRange.max)}`
      : 'N/A';
    const polyStr = analysis?.polyphony?.max != null ? `${analysis.polyphony.max}` : 'N/A';
    const density = analysis?.density != null ? (Math.round(analysis.density * 10) / 10) + ' n/s' : null;
    const totalNotes = analysis?.totalNotes || null;
    const usedCCs = analysis?.usedCCs || [];
    const trackNames = analysis?.trackNames || [];

    // Channel navigation
    const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    const currentIdx = channelKeys.indexOf(ch);
    const prevCh = currentIdx > 0 ? channelKeys[currentIdx - 1] : null;
    const nextCh = currentIdx < channelKeys.length - 1 ? channelKeys[currentIdx + 1] : null;

    // Selected instrument score details
    const allOptions = [...options, ...lowOptions];
    const selectedOption = assignment ? allOptions.find(o => o.instrument.id === assignment.instrumentId) : null;
    const compat = selectedOption?.compatibility;
    const score = assignment?.score || 0;

    // Score breakdown
    const scoreBreakdown = compat?.scoreBreakdown;
    let breakdownHTML = '';
    if (scoreBreakdown && assignment && !isSkipped) {
      breakdownHTML = `
        <div class="rs-score-breakdown">
          <div class="rs-breakdown-header">
            <span class="rs-score-main ${getScoreClass(score)}">${score}</span>
            ${getScoreStars(score)}
            <span class="rs-score-label">${getScoreLabel(score)}</span>
          </div>
          ${renderScoreBar('autoAssign.scoreProgram', scoreBreakdown.program)}
          ${renderScoreBar('autoAssign.scoreNoteRange', scoreBreakdown.noteRange)}
          ${renderScoreBar('autoAssign.scorePolyphony', scoreBreakdown.polyphony)}
          ${renderScoreBar('autoAssign.scoreCCSupport', scoreBreakdown.ccSupport)}
          ${renderScoreBar('autoAssign.scoreType', scoreBreakdown.instrumentType)}
          ${scoreBreakdown.percussion?.max ? renderScoreBar('autoAssign.scorePercussion', scoreBreakdown.percussion) : ''}
        </div>
      `;
    }

    // Compatibility info & issues
    let compatInfoHTML = '';
    if (compat && !isSkipped) {
      const infoStr = compat.info ? (Array.isArray(compat.info) ? compat.info.join(' \u2022 ') : String(compat.info)) : '';
      const issueStr = compat.issues?.length > 0
        ? compat.issues.map(i => `<span class="rs-issue-${i.type || 'info'}">${escapeHtml(i.message || i)}</span>`).join(' ')
        : '';
      if (infoStr || issueStr) {
        compatInfoHTML = `
          <div class="rs-compat-info">
            ${infoStr ? `<div class="rs-compat-info-text">${escapeHtml(infoStr)}</div>` : ''}
            ${issueStr ? `<div class="rs-compat-issues">${issueStr}</div>` : ''}
          </div>
        `;
      }
    }

    // Piano roll visualization
    let pianoHTML = '';
    if (!isSkipped && !isDrumChannel) {
      if (isSplit && this.splitAssignments[channel]) {
        pianoHTML = renderSplitPianoRoll(analysis, this.splitAssignments[channel]);
      } else if (assignment?.instrumentId) {
        pianoHTML = renderPianoRoll(analysis, assignment);
      }
    }

    // Adaptation controls (pitch shift + OOR handling)
    let adaptHTML = '';
    if (!isSkipped && assignment?.instrumentId && !isDrumChannel) {
      const pitchShift = adaptation.pitchShift || 'none';
      const semitones = adaptation.transpositionSemitones || 0;
      const oorHandling = adaptation.oorHandling || 'passThrough';

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
                ${_t('autoAssign.pitchAuto')}
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

    // Instrument chips (horizontal bar) + range bars
    const instrumentChipsHTML = (!isSkipped && options.length > 0)
      ? this._renderInstrumentChips(channel, options, lowOptions, assignment)
      : (isSkipped ? '' : `<p class="rs-no-instruments">${_t('autoAssign.noCompatible')}</p>`);
    const rangeBarsHTML = (!isSkipped && !isDrumChannel)
      ? this._renderRangeBars(channel, analysis, assignment) : '';

    // Split section
    let splitHTML = '';
    if (hasSplitProposal && !isSplit) {
      const proposal = this.splitProposals[channel];
      const segments = proposal.segments || [];
      splitHTML = `
        <div class="rs-split-section">
          <h4>${_t('autoAssign.splitProposed')} (${proposal.type}, ${_t('routingSummary.quality')}: ${proposal.quality})</h4>
          ${renderSplitBar(proposal, analysis)}
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
          ${renderSplitBar(accepted, analysis)}
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
          <div class="rs-detail-nav">
            <button class="btn btn-sm rs-nav-btn" id="rsNavPrev" ${!prevCh ? 'disabled' : ''} data-channel="${prevCh || ''}" title="${_t('routingSummary.prevChannel')}">&#9664;</button>
          </div>
          <div class="rs-detail-title">
            <h3>${typeIcon} ${_t('autoAssign.channel')} ${channel + 1}${channel === 9 ? ' (Drums)' : ''}</h3>
            <span class="rs-detail-gm">${escapeHtml(gmName)}</span>
          </div>
          <div class="rs-detail-nav">
            <button class="btn btn-sm rs-nav-btn" id="rsNavNext" ${!nextCh ? 'disabled' : ''} data-channel="${nextCh || ''}" title="${_t('routingSummary.nextChannel')}">&#9654;</button>
            <button class="btn btn-sm rs-detail-close" id="rsDetailClose">&times;</button>
          </div>
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
          ${density ? `<div class="rs-stat"><span class="rs-stat-label">${_t('routingSummary.density')}</span><span class="rs-stat-value">${density}</span></div>` : ''}
          ${totalNotes ? `<div class="rs-stat"><span class="rs-stat-label">${_t('routingSummary.totalNotes')}</span><span class="rs-stat-value">${totalNotes}</span></div>` : ''}
          ${usedCCs.length > 0 ? `<div class="rs-stat"><span class="rs-stat-label">CCs</span><span class="rs-stat-value">${usedCCs.slice(0, 6).join(', ')}${usedCCs.length > 6 ? '\u2026' : ''}</span></div>` : ''}
          ${trackNames.length > 0 ? `<div class="rs-stat rs-stat-wide"><span class="rs-stat-label">${_t('routingSummary.tracks')}</span><span class="rs-stat-value">${escapeHtml(trackNames.join(', '))}</span></div>` : ''}
        </div>

        ${instrumentChipsHTML}
        ${rangeBarsHTML}
        ${adaptHTML}
        ${pianoHTML}
        ${splitHTML}
        ${breakdownHTML}
        ${compatInfoHTML}
      </div>
    `;
  }

  _renderInstrumentOption(opt, assignment, channel) {
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
        ${compat.transposition?.semitones ? `<span class="rs-inst-trans">${compat.transposition.semitones > 0 ? '+' : ''}${compat.transposition.semitones}st</span>` : ''}
        ${compat.issues?.length ? `<span class="rs-inst-issues" title="${compat.issues.map(i => i.message).join(', ')}">!</span>` : ''}
      </div>
    `;
  }

  /**
   * Render instrument selection as horizontal scrollable chips
   */
  _renderInstrumentChips(channel, options, lowOptions, assignment) {
    const ch = String(channel);
    const isSplit = this.splitChannels.has(channel);
    const showLow = this.showLowScores[ch];

    // For split channels, show segment instruments
    if (isSplit && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];
      const segChips = segs.map((seg, i) => {
        const name = seg.instrumentName || `Instrument ${i + 1}`;
        const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
        const color = splitColors[i % splitColors.length];
        const range = seg.noteRange ? `${midiNoteToName(seg.noteRange.min)}-${midiNoteToName(seg.noteRange.max)}` : '';
        return `
          <span class="aa-instbar-btn assigned" style="border-left: 3px solid ${color}">
            <span class="aa-instbar-dot" style="background:${color}"></span>
            <span class="aa-instbar-name">${escapeHtml(displayName)}</span>
            <span class="aa-instbar-score" style="font-size:9px;color:#888">${range}</span>
            <span class="aa-instbar-check">\u2713</span>
          </span>
        `;
      }).join('');
      return `<div class="aa-instbar-content"><div class="aa-instbar-list">${segChips}</div></div>`;
    }

    // Normal: show top options as chips
    const chips = options.map(opt => {
      const inst = opt.instrument;
      const score = opt.compatibility.score;
      const isSelected = assignment?.instrumentId === inst.id;
      const instType = inst.instrument_type || '';
      const typeColor = getTypeColor(instType);
      const name = inst.custom_name || inst.name || '?';
      const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;

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
        const displayName = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
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
      <div class="aa-instbar-content">
        <div class="aa-instbar-list">${chips}${lowChips}${showMoreBtn}</div>
      </div>
    `;
  }

  /**
   * Render wide dual range bars (channel notes vs instrument range)
   */
  _renderRangeBars(channel, analysis, assignment) {
    if (!analysis?.noteRange || analysis.noteRange.min == null) return '';

    const chMin = analysis.noteRange.min;
    const chMax = analysis.noteRange.max;
    const isSplit = this.splitChannels.has(channel);

    // Compute global range for display
    let globalMin = chMin, globalMax = chMax;
    const splitColors = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];

    let instBars = '';
    if (isSplit && this.splitAssignments[channel]) {
      const segs = this.splitAssignments[channel].segments || [];
      for (const seg of segs) {
        if (seg.fullRange) { globalMin = Math.min(globalMin, seg.fullRange.min); globalMax = Math.max(globalMax, seg.fullRange.max); }
        if (seg.noteRange) { globalMin = Math.min(globalMin, seg.noteRange.min); globalMax = Math.max(globalMax, seg.noteRange.max); }
      }
      instBars = segs.map((seg, i) => {
        const sMin = seg.fullRange?.min ?? seg.noteRange?.min ?? 0;
        const sMax = seg.fullRange?.max ?? seg.noteRange?.max ?? 127;
        const left = Math.round(((sMin - globalMin) / (globalMax - globalMin || 1)) * 100);
        const width = Math.max(2, Math.round(((sMax - sMin) / (globalMax - globalMin || 1)) * 100));
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || `Inst ${i + 1}`;
        return `<div class="rs-range-bar rs-range-inst-bar" style="left:${left}%;width:${width}%;background:${color}33;border:1px solid ${color}" title="${escapeHtml(name)}: ${midiNoteToName(sMin)}-${midiNoteToName(sMax)}"></div>`;
      }).join('');
    } else if (assignment?.noteRangeMin != null) {
      globalMin = Math.min(globalMin, assignment.noteRangeMin);
      globalMax = Math.max(globalMax, assignment.noteRangeMax);
      const iLeft = Math.round(((assignment.noteRangeMin - globalMin) / (globalMax - globalMin || 1)) * 100);
      const iWidth = Math.max(2, Math.round(((assignment.noteRangeMax - assignment.noteRangeMin) / (globalMax - globalMin || 1)) * 100));
      instBars = `<div class="rs-range-bar rs-range-inst-bar" style="left:${iLeft}%;width:${iWidth}%" title="${_t('autoAssign.instrumentRange')}: ${midiNoteToName(assignment.noteRangeMin)}-${midiNoteToName(assignment.noteRangeMax)}"></div>`;
    }

    const chLeft = Math.round(((chMin - globalMin) / (globalMax - globalMin || 1)) * 100);
    const chWidth = Math.max(2, Math.round(((chMax - chMin) / (globalMax - globalMin || 1)) * 100));

    return `
      <div class="rs-range-wide">
        <div class="rs-range-labels">
          <span>${midiNoteToName(globalMin)}</span>
          <span>${_t('autoAssign.channelNotes')}: ${midiNoteToName(chMin)}-${midiNoteToName(chMax)}</span>
          <span>${midiNoteToName(globalMax)}</span>
        </div>
        <div class="rs-range-track">
          ${instBars}
          <div class="rs-range-bar rs-range-ch-bar" style="left:${chLeft}%;width:${chWidth}%" title="${_t('autoAssign.channelNotes')}: ${midiNoteToName(chMin)}-${midiNoteToName(chMax)}"></div>
        </div>
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

    // Channel navigation (prev/next)
    const prevBtn = modal.querySelector('#rsNavPrev');
    const nextBtn = modal.querySelector('#rsNavNext');
    if (prevBtn && prevBtn.dataset.channel) {
      prevBtn.addEventListener('click', () => this._selectChannel(parseInt(prevBtn.dataset.channel)));
    }
    if (nextBtn && nextBtn.dataset.channel) {
      nextBtn.addEventListener('click', () => this._selectChannel(parseInt(nextBtn.dataset.channel)));
    }

    // Instrument chip selection
    modal.querySelectorAll('.aa-instbar-btn[data-instrument-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const instId = parseInt(btn.dataset.instrumentId);
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
  // Preview bar & minimap
  // ============================================================================

  _renderHeaderPreview() {
    const ch = this.selectedChannel;
    const chLabel = ch !== null ? (ch + 1) : '?';
    return `
      <div class="rs-header-preview">
        <div class="rs-hdr-prev-btns">
          <button class="btn btn-sm rs-prev-btn" id="rsPreviewAllBtn" title="${_t('routingSummary.previewAll')}">&#9654;</button>
          <button class="btn btn-sm rs-prev-btn" id="rsPreviewChBtn" title="${_t('routingSummary.previewChannel')} ${chLabel}" ${ch === null ? 'disabled' : ''}>&#9654; Ch${chLabel}</button>
          <button class="btn btn-sm rs-prev-btn" id="rsPreviewOrigBtn" title="${_t('routingSummary.previewOriginal')}" ${ch === null ? 'disabled' : ''}>&#9835;</button>
          <button class="btn btn-sm rs-prev-btn" id="rsPreviewPauseBtn" style="display:none">&#10074;&#10074;</button>
          <button class="btn btn-sm rs-prev-btn" id="rsPreviewStopBtn" style="display:none">&#9632;</button>
        </div>
        <div class="rs-hdr-prev-map" id="rsMinimapContainer" title="${escapeHtml(this.filename)}"></div>
        <span class="rs-preview-time" id="rsPreviewTime"></span>
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
    for (const track of this.midiData.tracks) {
      if (!track.events) continue;
      let tick = 0;
      for (const event of track.events) {
        if (event.deltaTime !== undefined) tick += event.deltaTime;
        if (event.type === 'noteOn' && event.velocity > 0) {
          const ch = event.channel ?? 0;
          if (channelFilter !== null && ch !== channelFilter) continue;
          notes.push({ t: tick, n: event.note ?? event.noteNumber ?? 60 });
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
