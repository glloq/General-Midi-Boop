// public/js/features/auto-assign/RoutingSummaryPage.js
// RoutingSummaryPage — Automatic routing summary page with two-panel layout
(function() {
'use strict';

// Constants and helpers extracted to RoutingSummaryConstants.js (P2-F.1).
// Loaded earlier in index.html so window.RoutingSummaryConstants is available.
const RSC = window.RoutingSummaryConstants;
const {
  MAX_INST_NAME,
  SPLIT_COLORS,
  BLACK_KEYS,
  NOTE_NAMES,
  GM_DEFAULT_POLYPHONY,
  FULL_RANGE,
  CC_PAGE_SIZE,
  DRUM_NAMES,
  getGmDefaultPolyphony,
  midiNoteToName,
  safeNoteRange,
  getScoreClass,
  getScoreBgClass,
  getScoreLabel,
  getTypeIcon,
  getTypeColor,
  getGmProgramName
} = RSC;

const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

/**
 * Render a mini piano keyboard aligned to the channel's note range.
 * White keys are full-height, black keys are shorter and overlaid.
 * C notes get a small label below.
 */
// Pure HTML renderers extracted to RoutingSummaryRenderers.js (P2-F.4/F.4b..F.4t).
const {
  renderMiniKeyboard, renderChannelHistogram, renderMiniRange,
  renderDetailPlaceholder, renderHeaderButtons,
  renderLoadingScreen, renderErrorScreen,
  renderInstrumentChips, renderPolyReductionSection,
  renderRangeBars, renderDrumMappingSection, renderCCSection,
  renderScoreDetail, renderSummaryTable, renderAdaptationBlock,
  renderSplitSection, renderContentShell, renderDetailContainer
} = window.RoutingSummaryRenderers;

// ============================================================================
// RoutingSummaryPage class
// ============================================================================

class RoutingSummaryPage {
  constructor(apiClient) {
    this.api = apiClient;
    // P2-F.2 : centralised API facade. `this.api` kept for components that
    // still wrap it (e.g. AudioPreview) until they migrate too.
    this.apiClient = new window.RoutingSummaryApi(apiClient);
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
    this.drumMappingExpanded = {}; // Per-channel drum mapping collapse state
    this.customDrumMappings = {}; // Per-channel custom drum note mappings { [channel]: { sourceNote: destNote } }
    this.mutedDrumNotes = {}; // Per-channel muted drum notes { [channel]: Set<midiNote> }
    this.ccShowAll = {}; // Per-channel CC pagination (show all rows)
    this._rafPending = false; // RAF debounce for _refreshUI
    this._pendingHint = null; // Pending render hint for RAF coalescence
    this._pendingChannelKeys = null;
    this.showLowScores = {}; // Per-channel toggle for low score instruments
    this.autoAdaptation = true; // Toggle for automatic MIDI channel adaptation
    this.channelVolumes = {}; // Per-channel volume overrides (CC7, 0-127, default 100)
    this._instrumentOptionsCache = {}; // Memoized <option> HTML per channel for summary dropdowns

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
      const saved = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
      if (saved.scoringConfig) return saved.scoringConfig;
    } catch (e) { /* ignore */ }
    return this._getDefaultOverrides();
  }

  _saveScoringOverrides() {
    try {
      const settings = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
      settings.scoringConfig = this.scoringOverrides;
      localStorage.setItem('gmboop_settings', JSON.stringify(settings));
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
        const saved = localStorage.getItem('gmboop_settings');
        if (saved && JSON.parse(saved).virtualInstrument) excludeVirtual = false;
      } catch (e) { /* ignore */ }

      // Generate auto-assignment suggestions (splits disabled — user adds instruments manually)
      const response = await this.apiClient.generateSuggestions({
        fileId,
        topN: 5,
        minScore: 30,
        excludeVirtual,
        includeMatrix: false,
        scoringOverrides: this.scoringOverrides
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
        const savedResp = await this.apiClient.getSavedRoutings(fileId);
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
        const fileResponse = await this.apiClient.readFile(fileId);
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
    this.modal.innerHTML = renderLoadingScreen();
    this.modal.querySelector('#rsSummaryClose').addEventListener('click', () => this.close());
  }

  _showError(message) {
    this.modal.innerHTML = renderErrorScreen(message, escapeHtml);
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
        const displayScore = this._getDisplayScore();
        const scoreLabel = this.selectedChannel !== null
          ? `Ch ${this.selectedChannel + 1} : ${displayScore}/100`
          : `${displayScore}/100 — ${getScoreLabel(displayScore)}`;

        this.modal.innerHTML = renderContentShell({
          hasDetail: this.selectedChannel !== null,
          hasMidiData: !!this.midiData,
          autoAdaptation: !!this.autoAdaptation,
          isOverrideModified: this._isOverrideModified(),
          displayScore,
          selectedChannel: this.selectedChannel,
          scoreLabel,
          activeCount,
          totalCount: channelKeys.length,
          headerButtonsHTML: this._renderHeaderButtons(),
          scoreDetailHTML: this._renderScoreDetail(),
          summaryTableHTML: this._renderSummaryTable(channelKeys),
          detailPanelHTML: this.selectedChannel !== null
            ? this._safeRenderDetailPanel(this.selectedChannel)
            : this._renderDetailPlaceholder()
        });

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

    // Score popup content: only re-render when the popup is actually visible.
    // Otherwise mark it stale so it rebuilds the next time the user opens it.
    const scorePopup = modal.querySelector('#rsScorePopup');
    if (scorePopup) {
      if (scorePopup.style.display !== 'none') {
        scorePopup.innerHTML = this._renderScoreDetail();
        scorePopup.dataset.stale = '';
      } else {
        scorePopup.dataset.stale = '1';
      }
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
    return renderScoreDetail({
      suggestions: this.suggestions,
      selectedChannel: this.selectedChannel,
      skippedChannels: this.skippedChannels,
      splitChannels: this.splitChannels,
      selectedAssignments: this.selectedAssignments,
      channelAnalyses: this.channelAnalyses,
      splitAssignments: this.splitAssignments,
      adaptationSettings: this.adaptationSettings,
      autoAdaptation: this.autoAdaptation,
      allInstruments: this.allInstruments || [],
      getDisplayName: (inst) => this._getInstrumentDisplayName(inst),
      escape: escapeHtml
    });
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Resolve the GM program for a split segment.
   * Falls back to looking up the instrument in allInstruments if seg.gmProgram is missing.
   */
  _resolveSegmentGmProgram(seg) {
    return window.RoutingSummaryHelpers.resolveSegmentGmProgram(seg, this.allInstruments || []);
  }

  /**
   * Get the score to display in the header button.
   * - Summary mode (no channel selected): average of all non-skipped channel scores
   * - Detail mode (channel selected): score of the selected channel
   */
  _getDisplayScore() {
    if (this.selectedChannel !== null) {
      const ch = String(this.selectedChannel);
      const isSplit = this.splitChannels.has(this.selectedChannel);
      if (isSplit) {
        // Compute coverage-based score for multi-instrument
        return this._computeSplitCoverageScore(this.selectedChannel);
      }
      return this.selectedAssignments[ch]?.score || 0;
    }
    // Average of all non-skipped channel scores
    const channelKeys = Object.keys(this.suggestions);
    let total = 0, count = 0;
    for (const ch of channelKeys) {
      const channel = parseInt(ch);
      if (this.skippedChannels.has(channel)) continue;
      const isSplit = this.splitChannels.has(channel);
      const score = isSplit
        ? this._computeSplitCoverageScore(channel)
        : (this.selectedAssignments[ch]?.score || 0);
      total += score;
      count++;
    }
    return count > 0 ? Math.round(total / count) : 0;
  }

  /**
   * Compute a coverage-based score (0-100) for a multi-instrument split channel.
   * Based on what percentage of channel notes are covered by at least one segment.
   */
  _computeSplitCoverageScore(channel) {
    return window.RoutingSummaryHelpers.computeSplitCoverageScore({
      splitData: this.splitAssignments[channel],
      analysis: this.channelAnalyses[channel],
      adapt: this.adaptationSettings[String(channel)] || {},
      autoAdaptation: this.autoAdaptation
    });
  }

  /**
   * Get display name for an instrument. Prefers custom_name, then GM program name, then device name.
   */
  _getInstrumentDisplayName(inst) {
    return window.RoutingSummaryHelpers.getInstrumentDisplayName(inst);
  }

  /**
   * Get max polyphony used by a MIDI channel from analysis data.
   * Handles both { max, avg } objects and raw number formats.
   */
  _getChannelPolyphony(channel) {
    return window.RoutingSummaryHelpers.getChannelPolyphony({
      channel,
      channelAnalyses: this.channelAnalyses,
      selectedAssignments: this.selectedAssignments
    });
  }

  /**
   * Get total polyphony capacity of assigned instrument(s) for a channel.
   */
  _getInstrumentPolyphony(channel) {
    return window.RoutingSummaryHelpers.getInstrumentPolyphony({
      channel,
      splitChannels: this.splitChannels,
      splitAssignments: this.splitAssignments,
      selectedAssignments: this.selectedAssignments,
      allInstruments: this.allInstruments || []
    });
  }

  /**
   * Compute playable notes ratio for a channel's assignment.
   * @returns {{ playable: number, total: number } | null}
   */
  _computePlayableNotes(ch) {
    return window.RoutingSummaryHelpers.computePlayableNotes({
      channel: ch,
      selectedAssignments: this.selectedAssignments,
      channelAnalyses: this.channelAnalyses,
      adaptationSettings: this.adaptationSettings,
      autoAdaptation: this.autoAdaptation
    });
  }

  /**
   * Build <option> list for instrument dropdown in summary table.
   * Memoized per (channel, selected instrument, skipped flag) — output
   * is pure HTML that only changes when one of those inputs changes, so
   * we can avoid rebuilding 16 large option strings on every refresh.
   */
  _buildInstrumentOptions(ch, assignment, isSkipped) {
    const key = `${ch}|${assignment?.instrumentId || ''}|${isSkipped ? 1 : 0}`;
    const cached = this._instrumentOptionsCache[key];
    if (cached !== undefined) return cached;
    const html = window.RoutingSummaryHelpers.buildInstrumentOptions({
      channel: ch,
      assignment,
      isSkipped,
      suggestions: this.suggestions,
      lowScoreSuggestions: this.lowScoreSuggestions,
      maxNameLen: MAX_INST_NAME,
      escape: escapeHtml,
      getDisplayName: (inst) => this._getInstrumentDisplayName(inst)
    });
    this._instrumentOptionsCache[key] = html;
    return html;
  }

  // ============================================================================
  // Summary table (left panel)
  // ============================================================================

  _renderSummaryTable(channelKeys) {
    return renderSummaryTable({
      channelKeys,
      selectedChannel: this.selectedChannel,
      skippedChannels: this.skippedChannels,
      splitChannels: this.splitChannels,
      selectedAssignments: this.selectedAssignments,
      splitAssignments: this.splitAssignments,
      channelAnalyses: this.channelAnalyses,
      allInstruments: this.allInstruments || [],
      adaptationSettings: this.adaptationSettings,
      autoAdaptation: this.autoAdaptation,
      getDisplayName: (inst) => this._getInstrumentDisplayName(inst),
      buildInstrumentOptions: (ch, assignment, isSkipped) => this._buildInstrumentOptions(ch, assignment, isSkipped),
      getChannelPolyphony: (channel) => this._getChannelPolyphony(channel),
      getInstrumentPolyphony: (channel) => this._getInstrumentPolyphony(channel),
      computePlayableNotes: (ch) => this._computePlayableNotes(ch),
      renderVolumeSlider: (channel) => this._renderVolumeSlider(channel),
      escape: escapeHtml
    });
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

  // _renderMiniRange / _renderDetailPlaceholder extracted to
  // RoutingSummaryRenderers (P2-F.4c). Delegators kept for legacy call
  // sites within this class.
  _renderMiniRange(channel, analysis, assignment) {
    return renderMiniRange(analysis, assignment);
  }

  // ============================================================================
  // Detail panel (right side)
  // ============================================================================

  _renderDetailPlaceholder() {
    return renderDetailPlaceholder();
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
    // Prefer estimatedCategory (from GM program) over estimatedType (heuristic) for display
    const detailDisplayType = (analysis?.estimatedCategory && analysis.estimatedCategory !== 'unknown')
      ? analysis.estimatedCategory
      : (analysis?.estimatedType || '');
    const typeIcon = detailDisplayType ? getTypeIcon(detailDisplayType) : '';
    const score = assignment?.score || 0;
    const assignedName = assignment?.instrumentDisplayName || assignment?.customName || getGmProgramName(assignment?.gmProgram) || assignment?.instrumentName || null;

    // Compute playable notes ratio
    const playableData = this._computePlayableNotes(ch);
    const playableInfo = playableData ? `(${playableData.playable}/${playableData.total})` : '';

    // Adaptation controls (pitch shift + OOR handling) — P2-F.4q
    const adaptHTML = this._renderAdaptationBlock(channel);

    // Instrument chips (horizontal bar) — always show, even on skipped channels
    const instrumentChipsHTML = (options.length > 0 || lowOptions.length > 0)
      ? this._renderInstrumentChips(channel, options, lowOptions, assignment, isSkipped)
      : `<p class="rs-no-instruments">${_t('autoAssign.noCompatible')}</p>`;
    // Range bars (channel notes vs instrument capability)
    // Range bars: show for assigned instrument OR for active split (accepted only)
    const hasSplitData = isSplit;
    const rangeBarsHTML = (!isDrumChannel && (assignment?.noteRangeMin != null || hasSplitData))
      ? this._renderRangeBars(channel, analysis, assignment) : '';

    // Drum note mapping section (for drum channels with assigned instruments)
    const drumMappingHTML = (isDrumChannel && assignment?.instrumentId)
      ? this._renderDrumMappingSection(channel) : '';

    // Split section — only render if multi-instrument is active (user-accepted) — P2-F.4r
    let splitHTML = '';
    if (isSplit && this.splitAssignments[channel]) {
      const adapt = this.adaptationSettings[ch] || {};
      const splitSemitones = (this.autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
      splitHTML = renderSplitSection({
        channel,
        analysis,
        splitData: this.splitAssignments[channel],
        expanded: this.splitExpanded[channel] ?? true,
        semitones: splitSemitones,
        allInstruments: this.allInstruments || [],
        getCompatibleInstrumentsForSegment: (chStr, segNoteRange) =>
          this._getCompatibleInstrumentsForSegment(chStr, segNoteRange),
        getDisplayName: (inst) => this._getInstrumentDisplayName(inst),
        detectOverlaps: (segs) => this._detectOverlaps(segs),
        escape: escapeHtml
      });
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

    return renderDetailContainer({
      channel,
      typeIcon,
      routeHTML,
      isSplit,
      score,
      assignment,
      polyHTML,
      playableInfo,
      rangeBarsHTML,
      drumMappingHTML,
      instrumentChipsHTML,
      adaptHTML,
      splitSuggestionHTML,
      splitHTML,
      addInstrumentHTML,
      ccSectionHTML: this._renderCCSection(channel),
      escape: escapeHtml
    });
  }

  /**
   * Render instrument selection as horizontal scrollable chips.
   * Delegates to RoutingSummaryRenderers.renderInstrumentChips (P2-F.4j).
   */
  _renderInstrumentChips(channel, options, lowOptions, assignment, isSkipped = false) {
    return renderInstrumentChips({
      channel,
      options,
      lowOptions,
      assignment,
      isSkipped,
      isSplit: this.splitChannels.has(channel),
      showLow: this.showLowScores[String(channel)],
      getDisplayName: (inst) => this._getInstrumentDisplayName(inst),
      escape: escapeHtml
    });
  }

  /**
   * Render the polyphony reduction section for channel adaptation.
   * Shows controls only when channel polyphony exceeds instrument capacity.
   */
  _renderPolyReductionSection(channel, adaptation, analysis, assignment) {
    return renderPolyReductionSection({
      channel,
      adaptation,
      assignment,
      channelPolyphony: this._getChannelPolyphony(channel),
      instrumentPolyphony: this._getInstrumentPolyphony(channel)
    });
  }

  /**
   * Render the adaptation block for a channel (pitch-shift + OOR + polyphony).
   * Used both during full detail rebuilds and for the targeted partial refresh
   * triggered by adaptation radio toggles.
   */
  _renderAdaptationBlock(channel) {
    const ch = String(channel);
    const isSkipped = this.skippedChannels.has(channel);
    const assignment = this.selectedAssignments[ch];
    const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;
    const isDrumChannel = channel === 9 || analysis?.estimatedType === 'drums';
    const adaptation = this.adaptationSettings[ch] || {};
    return renderAdaptationBlock({
      channel,
      adaptation,
      analysis,
      assignment,
      isSkipped,
      isDrumChannel,
      playableWithTranspose: (adaptation.pitchShift === 'manual') ? this._computePlayableNotes(ch) : null,
      polyReductionHTML: this._renderPolyReductionSection(channel, adaptation, analysis, assignment)
    });
  }

  /**
   * Targeted partial update of the .rs-adaptation block for a channel.
   * Avoids rebuilding the entire detail panel when only an adaptation
   * radio toggle changed (pitchShift / oorHandling / polyReduction /
   * polyStrategy) — those changes don't affect the rest of the panel.
   * Returns false if the block isn't currently in the DOM (caller should
   * fall back to a full refresh).
   */
  _refreshAdaptationBlock(channel) {
    const panel = this.modal?.querySelector('#rsDetailPanel');
    const block = panel?.querySelector('.rs-adaptation');
    if (!block) return false;
    const html = this._renderAdaptationBlock(channel);
    if (!html) return false;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const fresh = wrapper.firstElementChild;
    if (!fresh) return false;
    block.replaceWith(fresh);
    return true;
  }

  /**
   * Render full 0-127 MIDI range visualization with two-line display.
   * Line 1: Channel notes (with transposition applied directly)
   * Line 2: Instrument playable range(s) with name labels and vertical connectors
   */
  // ============================================================================
  // Drum Note Mapping Section
  // ============================================================================

  /**
   * Render drum note mapping table showing source→destination with substitution info.
   * Allows changing destination notes and disabling individual notes.
   */
  _renderDrumMappingSection(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const analysis = this.channelAnalyses[channel];

    // Resolve the instrument's available notes (may come from assignment
    // or from the allInstruments catalog).
    let instrumentNotes = null;
    if (assignment?.selectedNotes) {
      try {
        instrumentNotes = typeof assignment.selectedNotes === 'string'
          ? JSON.parse(assignment.selectedNotes) : assignment.selectedNotes;
      } catch (e) { instrumentNotes = null; }
    }
    if (!instrumentNotes && assignment) {
      const inst = (this.allInstruments || []).find(i => i.id === assignment.instrumentId);
      if (inst?.selected_notes) {
        try {
          instrumentNotes = typeof inst.selected_notes === 'string'
            ? JSON.parse(inst.selected_notes) : inst.selected_notes;
        } catch (e) { instrumentNotes = null; }
      }
    }

    return renderDrumMappingSection({
      channel,
      assignment,
      analysis,
      isExpanded: this.drumMappingExpanded[channel] ?? false,
      instrumentNotes,
      baseMapping: assignment?.noteRemapping || {},
      customMap: this.customDrumMappings[channel] || {},
      mutedNotes: this.mutedDrumNotes[channel] || new Set(),
      escape: escapeHtml
    });
  }

  _renderRangeBars(channel, analysis, assignment) {
    return renderRangeBars({
      channel,
      analysis,
      assignment,
      adaptSettings: this.adaptationSettings,
      autoAdaptation: this.autoAdaptation,
      splitData: this._getActiveSplitData(channel),
      allInstruments: this.allInstruments || [],
      detectOverlaps: (segs) => this._detectOverlaps(segs),
      getDisplayName: (inst) => this._getInstrumentDisplayName(inst),
      escape: escapeHtml
    });
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
        const opening = popupEl.style.display === 'none';
        if (opening && popupEl.dataset.stale === '1') {
          popupEl.innerHTML = this._renderScoreDetail();
          popupEl.dataset.stale = '';
        }
        popupEl.style.display = opening ? '' : 'none';
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
        const chNum = parseInt(ch);
        if (target.value === 'ignore') {
          // Select "Ignore" → skip/mute this channel
          this.skippedChannels.add(chNum);
          this._refreshUI(channelKeys, 'both-panels');
        } else if (target.value) {
          // Instrument selected → unskip if needed, then select
          if (this.skippedChannels.has(chNum)) {
            this.skippedChannels.delete(chNum);
          }
          this._selectInstrument(ch, target.value, channelKeys);
        }
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
          const oldSemi = this.adaptationSettings[ch].transpositionSemitones || 0;
          const newSemi = Math.max(-36, Math.min(36, oldSemi + delta));
          this.adaptationSettings[ch].transpositionSemitones = newSemi;
          this._reclampSplitRanges(parseInt(ch), oldSemi, newSemi);
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
          if (!this._refreshAdaptationBlock(parseInt(ch))) {
            this._refreshUI(channelKeys, 'detail');
          }
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

      // Drum mapping collapse/expand
      const drumToggle = target.closest('.rs-drum-mapping-toggle');
      if (drumToggle) {
        const ch = parseInt(drumToggle.dataset.channel);
        this.drumMappingExpanded[ch] = !this.drumMappingExpanded[ch];
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

          let transpositionChanged = false;
          if (field === 'pitchShift') {
            const assignment = this.selectedAssignments[ch];
            const autoSemitones = assignment?.transposition?.semitones || 0;
            const oldSemi = this.adaptationSettings[ch].transpositionSemitones || 0;
            if (target.value === 'manual') {
              if (!this.adaptationSettings[ch].transpositionSemitones) {
                this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
              }
            } else if (target.value === 'auto') {
              this.adaptationSettings[ch].transpositionSemitones = autoSemitones;
            } else {
              this.adaptationSettings[ch].transpositionSemitones = 0;
            }
            const newSemi = this.adaptationSettings[ch].transpositionSemitones || 0;
            transpositionChanged = oldSemi !== newSemi;
            this._reclampSplitRanges(parseInt(ch), oldSemi, newSemi);
          }
          // When the transposition value didn't change, only the adaptation
          // block needs to be re-rendered. A full detail rebuild is wasteful
          // (and laggy on complex panels). Falls back to the heavy path
          // when the targeted update can't apply.
          if (transpositionChanged) {
            this._refreshUI(channelKeys, 'both-panels');
          } else if (!this._refreshAdaptationBlock(parseInt(ch))) {
            this._refreshUI(channelKeys, 'detail');
          }
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
          if (!this._refreshAdaptationBlock(parseInt(ch))) {
            this._refreshUI(channelKeys, 'detail');
          }
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

      // Drum destination note change
      if (target.matches('.rs-drum-dest-select')) {
        const chNum = parseInt(target.dataset.channel);
        const srcNote = parseInt(target.dataset.src);
        const destNote = parseInt(target.value);
        if (!this.customDrumMappings[chNum]) this.customDrumMappings[chNum] = {};
        this.customDrumMappings[chNum][srcNote] = destNote;
        this._refreshUI(channelKeys, 'detail');
        return;
      }

      // Drum note enable/disable toggle
      if (target.matches('.rs-drum-note-toggle')) {
        const chNum = parseInt(target.dataset.channel);
        const note = parseInt(target.dataset.note);
        if (!this.mutedDrumNotes[chNum]) this.mutedDrumNotes[chNum] = new Set();
        if (target.checked) {
          this.mutedDrumNotes[chNum].delete(note);
        } else {
          this.mutedDrumNotes[chNum].add(note);
        }
        this._refreshUI(channelKeys, 'detail');
        return;
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
        noteValue = Math.max(Math.max(physMin, chMin), Math.min(Math.min(physMax, chMax), noteValue));
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
    return window.RoutingSummaryHelpers.detectOverlaps(segments);
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
   * Reclamp all split segment noteRanges when transposition changes.
   * Shifts segment ranges by the transposition delta so they follow the channel notes,
   * then clamps to the instrument's physical range and 0-127.
   * @param {number} channel
   * @param {number} oldSemitones - previous transposition value
   * @param {number} newSemitones - new transposition value
   */
  _reclampSplitRanges(channel, oldSemitones, newSemitones) {
    window.RoutingSummaryHelpers.reclampSplitRanges({
      splitData: this._getActiveSplitData(channel),
      oldSemitones,
      newSemitones,
      channelNoteRange: this.channelAnalyses[channel]?.noteRange
    });
  }

  /**
   * Update the note range of a segment.
   */
  _updateSegmentRange(channel, segIdx, bound, value, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments?.[segIdx]) return;
    this.splitEdited[channel] = true;
    window.RoutingSummaryHelpers.updateSegmentRange({ splitData: data, segIdx, bound, value });
    this._refreshUI(channelKeys, 'both-panels');
  }

  /**
   * Resolve an overlap between two segments.
   */
  _resolveOverlap(channel, overlapIdx, strategy, channelKeys) {
    const data = this._getActiveSplitData(channel);
    if (!data?.segments) return;
    window.RoutingSummaryHelpers.resolveOverlap({ splitData: data, overlapIdx, strategy });
    this.splitEdited[channel] = true;
    this._refreshUI(channelKeys, 'both-panels');
  }

  // ============================================================================
  // Actions
  // ============================================================================

  _selectChannel(channel) {
    const prevChannel = this.selectedChannel;
    this.selectedChannel = channel;
    const channelKeys = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
    // Optimize: when opening/switching detail, render detail first, then defer summary update.
    // This avoids a long synchronous block rebuilding both panels at once.
    const layoutChanged = (prevChannel === null) !== (channel === null);
    if (layoutChanged) {
      // Layout structure changes (full↔condensed): render detail immediately, defer summary
      this._refreshUI(channelKeys, 'detail');
      // Toggle layout class immediately for CSS transition
      const container = this.modal?.querySelector('.rs-container');
      if (container) container.classList.toggle('rs-with-detail', channel !== null);
      // Defer summary rebuild to next frame so detail appears first
      requestAnimationFrame(() => this._refreshUI(channelKeys, 'summary'));
    } else {
      this._refreshUI(channelKeys, 'both-panels');
    }
  }

  _selectInstrument(ch, instrumentId, channelKeys) {
    // Invalidate segment instrument cache when assignment changes
    this._segmentInstrumentCache = null;
    this._instrumentOptionsCache = {};
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
    window.RoutingSummaryHelpers.applyBehaviorMode({
      splitData: this.splitAssignments[channel],
      channelNoteRange: this.channelAnalyses[channel]?.noteRange,
      mode
    });
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
    return window.RoutingSummaryHelpers.mergeHints(a, b);
  }

  /**
   * Apply the current routing assignments
   */
  async _applyRouting() {
    const builder = window.RoutingSummaryAssignmentBuilder;
    const { assignments, hasAssignment, hasSplit } = builder.buildAssignmentsPayload({
      selectedAssignments: this.selectedAssignments,
      splitAssignments: this.splitAssignments,
      splitChannels: this.splitChannels,
      skippedChannels: this.skippedChannels,
      adaptationSettings: this.adaptationSettings,
      ccRemapping: this.ccRemapping,
      ccSegmentMute: this.ccSegmentMute,
      autoAdaptation: this.autoAdaptation,
      getInstrumentPolyphony: (ch) => this._getInstrumentPolyphony(ch),
      getChannelVolume: (ch) => this._getChannelVolume(ch)
    });

    if (!hasAssignment) return;

    const { hasTransposition, needsFileModification } =
      builder.computeModificationFlags(assignments, hasSplit);

    // Ask user how to save if file modification is needed (P2-F.4b :
    // dialog rendering extracted to RoutingSummarySaveDialog).
    let overwriteOriginal = false;
    if (needsFileModification && typeof showConfirm === 'function') {
      const dialogResult = await window.RoutingSummarySaveDialog.askSaveChoice({
        hasSplit,
        hasTransposition
      });
      if (dialogResult === 'cancel') return;
      overwriteOriginal = (dialogResult === 'overwrite');
    }

    try {
      // Use apply_assignments which handles both normal and split routings
      const result = await this.apiClient.applyAssignments({
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
    if (!this._ccNameCache) this._ccNameCache = {};
    return window.RoutingSummaryHelpers.getCCName(ccNum, this._ccNameCache);
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
    return window.RoutingSummaryHelpers.getInstrumentCCs(
      instrumentId,
      this.allInstruments || [],
      (id) => this._findInstrumentById(id)
    );
  }

  /**
   * Compute CC summary counts (lightweight — no DOM generation).
   * Returns { summaryHTML, supportedCount, unsupportedCount, allUnknown }.
   */
  _computeCCSummary(channel) {
    return window.RoutingSummaryHelpers.computeCCSummary({
      channel,
      channelAnalyses: this.channelAnalyses,
      selectedAssignments: this.selectedAssignments,
      splitChannels: this.splitChannels,
      splitAssignments: this.splitAssignments,
      ccRemapping: this.ccRemapping,
      getInstrumentCCs: (id) => this._getInstrumentCCs(id)
    });
  }

  _renderCCSection(channel) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel];
    const assignment = this.selectedAssignments[ch];
    const isSplit = this.splitChannels.has(channel);

    // Pre-resolve data for the pure renderer.
    const segments = (isSplit && this.splitAssignments[channel]?.segments) || [];
    const segCCs = segments.map(seg => this._getInstrumentCCs(seg.instrumentId));

    let instrumentCCs = assignment?.supportedCcs ?? null;
    if (instrumentCCs && typeof instrumentCCs === 'string') {
      try { instrumentCCs = JSON.parse(instrumentCCs); } catch { instrumentCCs = null; }
    }
    if (instrumentCCs == null && assignment?.instrumentId) {
      instrumentCCs = this._getInstrumentCCs(assignment.instrumentId);
    }

    const { summaryHTML } = this._computeCCSummary(channel);

    return renderCCSection({
      channel,
      channelCCs: analysis?.usedCCs || [],
      assignment,
      isSplit,
      isSkipped: this.skippedChannels.has(channel),
      isExpanded: this.ccExpanded[channel] ?? false,
      showAll: this.ccShowAll[channel] ?? false,
      summaryHTML,
      currentRemap: this.ccRemapping[ch] || {},
      segments,
      segCCs,
      ccSegmentMute: this.ccSegmentMute,
      allInstruments: this.allInstruments || [],
      instrumentCCs,
      getInstrumentDisplayName: (inst) => this._getInstrumentDisplayName(inst),
      getCCName: (cc) => this._getCCName(cc),
      escape: escapeHtml
    });
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
    return renderHeaderButtons({
      selectedChannel: this.selectedChannel,
      filename: this.filename,
      escape: escapeHtml
    });
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

    // Determine channel filter based on active preview mode
    let channelFilter = null;
    if (this._previewMode === 'channel') {
      channelFilter = this._previewingChannel;
    } else if (this._previewMode === 'all' || this._previewMode === 'original') {
      channelFilter = null; // show all channels
    } else {
      channelFilter = (this.selectedChannel !== null) ? this.selectedChannel : null;
    }

    // Detect split mode: single channel with multiple instrument segments
    const isSplitView = channelFilter != null
      && this.splitChannels.has(channelFilter)
      && this.splitAssignments[channelFilter]?.segments?.length > 1;

    // Adapt height: taller when showing multiple instrument rows in split mode
    const splitSegCount = isSplitView ? (this.splitAssignments[channelFilter].segments.length) : 0;
    const h = splitSegCount > 1 ? Math.max(24, splitSegCount * 12) : 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';

    const skipRangeFilter = this._previewMode === 'original';
    const notes = this._extractNotesForMinimap(channelFilter, skipRangeFilter);

    // Bucket aggregation delegated to RoutingSummaryMinimapNotes (P2-F.4g).
    const bucketState = window.RoutingSummaryMinimapNotes.buildMinimapBuckets({
      notes,
      width: w,
      isSplitView,
      splitSegmentCount: isSplitView ? this.splitAssignments[channelFilter].segments.length : 0
    });

    this._minimapWidth = w;
    this._minimapHeight = h;
    this._minimapTotalTicks = bucketState.totalTicks;
    this._minimapSplitMode = bucketState.splitMode;
    this._minimapSegments = bucketState.segments;
    this._minimapChannels = bucketState.channels;
    this._minimapMultiChannel = bucketState.multiChannel;
    this._minimapBuckets = bucketState.buckets;

    this._drawMinimapFrame(0);
  }

  _drawMinimapFrame(playheadPct) {
    // Canvas rendering delegated to RoutingSummaryMinimapRenderer (P2-F.4f).
    window.RoutingSummaryMinimapRenderer.drawMinimapFrame({
      canvas: this._minimapCanvas,
      width: this._minimapWidth || 400,
      height: this._minimapHeight || 32,
      splitMode: this._minimapSplitMode,
      segments: this._minimapSegments,
      channels: this._minimapChannels,
      multiChannel: this._minimapMultiChannel,
      buckets: this._minimapBuckets,
      playheadPct,
      splitColors: SPLIT_COLORS
    });
  }

  _extractNotesForMinimap(channelFilter, skipRangeFilter = false) {
    // Pure extraction delegated to RoutingSummaryMinimapNotes (P2-F.4e).
    return window.RoutingSummaryMinimapNotes.extractNotesForMinimap({
      midiData: this.midiData,
      selectedAssignments: this.selectedAssignments,
      splitChannels: this.splitChannels,
      splitAssignments: this.splitAssignments,
      adaptationSettings: this.adaptationSettings,
      channelFilter,
      skipRangeFilter
    });
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

      // Apply custom drum mappings for channel 9
      const chTransposition = { semitones };
      if (chNum === 9) {
        const baseRemap = assignment?.noteRemapping || {};
        const customMap = this.customDrumMappings[chNum] || {};
        const mutedNotes = this.mutedDrumNotes[chNum] || new Set();
        const mergedRemap = { ...baseRemap, ...customMap };
        for (const note of mutedNotes) mergedRemap[note] = -1;
        if (Object.keys(mergedRemap).length > 0) {
          chTransposition.noteRemapping = mergedRemap;
        }
      }

      channelConfigs[ch] = {
        transposition: chTransposition,
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
        const free = window.RoutingSummaryPreview.allocateFreeChannels({
          count: segments.length - 1,
          usedChannels: usedCh,
          excluded: new Set([sourceChannel])
        });
        for (const c of free) usedCh.add(c);
        const segChannels = [sourceChannel, ...free];

        window.RoutingSummaryPreview.redistributeSplitChannel({
          midiData: previewMidi,
          sourceChannel,
          segments,
          segChannels,
          overlapStrategy: this.splitAssignments[sourceChannel]?.overlapStrategy,
          chRemap: this.ccRemapping[String(sourceChannel)] || {},
          chSegMute: this.ccSegmentMute[sourceChannel] || {}
        });

        segments.forEach((seg, i) => {
          if (i >= segChannels.length) return;
          channelConfigs[segChannels[i]] = {
            transposition: { semitones },
            instrumentConstraints: {
              gmProgram: this._resolveSegmentGmProgram(seg),
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
        const usedChannels = window.RoutingSummaryPreview.collectUsedChannels(this.midiData);
        const freeChannels = window.RoutingSummaryPreview.allocateFreeChannels({
          count: segs.length - 1,
          usedChannels,
          excluded: new Set([channel])
        });
        const segChannels = [channel, ...freeChannels];

        const splitMidi = JSON.parse(JSON.stringify(this.midiData));
        window.RoutingSummaryPreview.redistributeSplitChannel({
          midiData: splitMidi,
          sourceChannel: channel,
          segments: segs,
          segChannels,
          overlapStrategy: this.splitAssignments[channel]?.overlapStrategy,
          chRemap: this.ccRemapping[ch] || {},
          chSegMute: this.ccSegmentMute[channel] || {}
        });

        // Build configs: one per segment with its own gmProgram and range
        // Mark all other channels as skipped so only segments are heard
        const channelConfigs = {};
        for (let c = 0; c < 16; c++) channelConfigs[c] = { skipped: true };
        segs.forEach((seg, i) => {
          if (i >= segChannels.length) return;
          channelConfigs[segChannels[i]] = {
            transposition: { semitones: transposition.semitones },
            instrumentConstraints: {
              gmProgram: this._resolveSegmentGmProgram(seg) ?? assignment?.gmProgram,
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

    // Apply custom drum mappings and muted notes to the transposition's noteRemapping
    const isDrumChannel = channel === 9;
    if (isDrumChannel) {
      const baseRemap = assignment?.noteRemapping || {};
      const customMap = this.customDrumMappings[channel] || {};
      const mutedNotes = this.mutedDrumNotes[channel] || new Set();
      const mergedRemap = { ...baseRemap, ...customMap };
      // Muted notes: map to -1 (will be filtered out by note filter)
      for (const note of mutedNotes) mergedRemap[note] = -1;
      if (Object.keys(mergedRemap).length > 0) {
        transposition.noteRemapping = mergedRemap;
      }
    }

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
        const saved = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
        if (saved.virtualInstrument) excludeVirtual = false;
      } catch (e) { /* ignore */ }

      const response = await this.apiClient.generateSuggestions({
        fileId: this.fileId,
        topN: 5,
        minScore: this.scoringOverrides.scoreThresholds?.minimum || 30,
        excludeVirtual,
        includeMatrix: false,
        scoringOverrides: this.scoringOverrides
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
      this._instrumentOptionsCache = {};

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
