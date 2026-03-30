// public/js/views/components/AutoAssignModal.js
(function() {
'use strict';

const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

/**
 * AutoAssignModal - Tab-based modal for auto-assigning MIDI channels to instruments
 *
 * Each MIDI channel gets its own tab with:
 * - Channel statistics (note range, polyphony, type)
 * - Scored instrument suggestions
 * - Adaptation controls (transposition, octave wrapping, note offset)
 * After validation, creates an adapted file and opens it in the editor.
 */
class AutoAssignModal {
  constructor(apiClient, editorRef) {
    this.apiClient = apiClient;
    this.editorRef = editorRef; // Reference to MidiEditorModal for close/open flow
    this.onApply = null; // Optional callback when assignments are applied (for routing modal context)
    this.fileId = null;
    this.midiData = null;
    this.suggestions = {};
    this.autoSelection = {};
    this.channelAnalyses = {};
    this.selectedAssignments = {};
    this.skippedChannels = new Set();
    this.autoSkippedChannels = new Set();
    this.modal = null;
    this.audioPreview = null;
    this._escHandler = null;
    this._isDirty = false; // Tracks unsaved modifications
    this.activeTab = null; // Currently active channel tab
    this.channels = []; // Sorted channel list
    this.activeChannel = null; // Selected channel (for instrument bar + main content)
    this.matrixScores = null; // Pre-computed scores { channel: { instrumentId: { score, ... } } }
    this.instrumentList = null; // List of all instruments with info
    this.splitSelectionMode = null; // Channel in manual split mode (or null)
    this.manualSplitSelection = {}; // { channel: Set<instrumentId> }
    this.adaptationSettings = {}; // Per-channel adaptation overrides
    this.lowScoreSuggestions = {}; // Low-score instruments per channel
    this.showLowScores = {}; // Per-channel toggle for showing low scores
    this.showScoreDetails = {}; // Per-channel/instrument toggle for score breakdown
    this.showDrumMapping = {}; // Per-channel toggle for drum mapping view
    this.drumMappingOverrides = {}; // Per-channel drum note overrides { channel: { midiNote: instrumentNote } }
    this.expandedDrumCategories = {}; // Per-channel/category toggle { 'ch_category': true/false }
    this.splitProposals = {}; // { channel: SplitProposal } from backend
    this.splitChannels = new Set(); // Channels where user accepted a split
    this.splitAssignments = {}; // { channel: SplitProposal } accepted splits
    this.allInstruments = []; // Full instrument list (for "show all" toggle)
    this.showAllInstruments = false; // Toggle for showing unrouted instruments

    // GM Drum categories (mirrored from DrumNoteMapper backend)
    this.DRUM_CATEGORIES = {
      kicks: { label: 'Kicks', notes: [35, 36] },
      snares: { label: 'Snares', notes: [37, 38, 40] },
      hiHats: { label: 'Hi-Hats', notes: [42, 44, 46] },
      toms: { label: 'Toms', notes: [41, 43, 45, 47, 48, 50] },
      crashes: { label: 'Crashes', notes: [49, 55, 57] },
      rides: { label: 'Rides', notes: [51, 53, 59] },
      latin: { label: 'Latin', notes: [60, 61, 62, 63, 64, 65, 66, 67, 68] },
      misc: { label: 'Misc', notes: [39, 52, 54, 56, 58, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81] }
    };

    // Note names for MIDI to name conversion
    this.NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  }

  /**
   * Show a styled confirmation dialog on top of the auto-assign modal.
   * Uses z-index higher than the auto-assign overlay (10005) so it's always visible.
   * @param {string} message - Body text
   * @param {Object} [options] - { title, icon, okText, cancelText, danger }
   * @returns {Promise<boolean>}
   */
  _showConfirm(message, options = {}) {
    return new Promise((resolve) => {
      const title = options.title || _t('common.confirm');
      const icon = options.icon || '⚠️';
      const okText = options.okText || _t('common.confirm');
      const cancelText = options.cancelText || _t('common.cancel');
      const danger = options.danger !== false;

      const overlay = document.createElement('div');
      overlay.className = 'aa-confirm-overlay';
      overlay.innerHTML = `
        <div class="aa-confirm-dialog">
          <div class="aa-confirm-icon">${icon}</div>
          <div class="aa-confirm-title">${escapeHtml(title)}</div>
          <div class="aa-confirm-message">${escapeHtml(message)}</div>
          <div class="aa-confirm-buttons">
            <button class="btn aa-confirm-cancel">${escapeHtml(cancelText)}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} aa-confirm-ok">${escapeHtml(okText)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Animate in
      requestAnimationFrame(() => overlay.classList.add('visible'));

      const cleanup = (result) => {
        overlay.classList.remove('visible');
        setTimeout(() => { if (overlay.parentNode) overlay.remove(); resolve(result); }, 200);
      };

      overlay.querySelector('.aa-confirm-ok').addEventListener('click', () => cleanup(true));
      overlay.querySelector('.aa-confirm-cancel').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

      const keyHandler = (e) => {
        if (e.key === 'Escape') { document.removeEventListener('keydown', keyHandler); cleanup(false); }
      };
      document.addEventListener('keydown', keyHandler);

      // Focus cancel button (safer default)
      overlay.querySelector('.aa-confirm-cancel').focus();
    });
  }

  /**
   * Safely format info field (can be string or array)
   */
  formatInfo(info) {
    if (!info) return '';
    if (Array.isArray(info)) return info.map(i => escapeHtml(i)).join(' &bull; ');
    return escapeHtml(String(info));
  }

  /**
   * Get GM program name from program number
   */
  getGmProgramName(program) {
    if (program == null || program < 0 || program > 127) return null;
    if (this.editorRef && typeof this.editorRef.getInstrumentName === 'function') {
      return this.editorRef.getInstrumentName(program);
    }
    if (typeof getGMInstrumentName === 'function') {
      return getGMInstrumentName(program);
    }
    if (typeof GM_INSTRUMENTS !== 'undefined' && GM_INSTRUMENTS[program]) {
      return GM_INSTRUMENTS[program];
    }
    return `Program ${program}`;
  }

  /**
   * Convert MIDI note number to name (e.g. 60 → "C4", 61 → "C#4")
   */
  midiNoteToName(note) {
    return this.NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
  }

  /**
   * Check if a MIDI note is a black key (sharp/flat)
   */
  isBlackKey(note) {
    const n = note % 12;
    return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
  }

  /**
   * Check if a note is within an instrument's playable range
   */
  isNoteInInstrumentRange(note, instrument) {
    if (!instrument) return false;
    if (instrument.note_selection_mode === 'discrete' && instrument.selected_notes) {
      const notes = Array.isArray(instrument.selected_notes)
        ? instrument.selected_notes
        : (typeof instrument.selected_notes === 'string' ? JSON.parse(instrument.selected_notes) : []);
      return notes.includes(note);
    }
    return note >= (instrument.note_range_min || 0) && note <= (instrument.note_range_max || 127);
  }

  /**
   * Calculate adaptation result for a given strategy
   * Returns { totalNotes, inRange, outOfRange, recovered }
   */
  calculateAdaptationResult(channel, strategy) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;
    const adaptation = this.adaptationSettings[ch] || {};
    const assignment = this.selectedAssignments[ch];

    if (!analysis || !analysis.noteDistribution || !assignment) {
      return { totalNotes: 0, inRange: 0, outOfRange: 0, recovered: 0 };
    }

    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.id === assignment.instrumentId);
    if (!selectedOption) return { totalNotes: 0, inRange: 0, outOfRange: 0, recovered: 0 };

    const inst = selectedOption.instrument;
    const semitones = adaptation.transpositionSemitones || 0;
    const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
    const totalNotes = usedNotes.length;

    let inRange = 0;
    let recovered = 0;

    for (const note of usedNotes) {
      let adjustedNote = note;

      if (strategy === 'transpose') {
        adjustedNote = note + semitones;
      }

      if (this.isNoteInInstrumentRange(adjustedNote, inst)) {
        inRange++;
      } else if (strategy === 'octaveWrap' && inst.note_selection_mode !== 'discrete') {
        // Try wrapping ±1 octave (not meaningful for discrete instruments like drums/pads)
        const up = adjustedNote + 12;
        const down = adjustedNote - 12;
        if (this.isNoteInInstrumentRange(up, inst) || this.isNoteInInstrumentRange(down, inst)) {
          recovered++;
        }
      } else if (strategy === 'suppress') {
        // Out of range notes will be suppressed - counted as "recovered" (handled)
        recovered++;
      }
    }

    return {
      totalNotes,
      inRange,
      outOfRange: totalNotes - inRange - recovered,
      recovered
    };
  }

  /**
   * Show the modal with auto-assignment suggestions
   */
  async show(fileId, onApply) {
    this.onApply = onApply || null;
    this.fileId = fileId;
    this.showLoading();

    try {
      // Get MIDI file data for preview
      const fileResponse = await this.apiClient.sendCommand('file_read', { fileId: fileId });
      if (fileResponse && fileResponse.midiData) {
        const raw = fileResponse.midiData;
        if (raw.midi && raw.midi.tracks) {
          this.midiData = { ...raw.midi, tempo: raw.tempo || raw.midi.tempo };
        } else if (Array.isArray(raw.tracks)) {
          this.midiData = raw;
        } else {
          this.midiData = raw;
        }
      }

      // Check if virtual instruments are enabled in settings
      let excludeVirtual = true;
      try {
        const saved = localStorage.getItem('maestro_settings');
        if (saved && JSON.parse(saved).virtualInstrument) {
          excludeVirtual = false;
        }
      } catch (e) { /* ignore */ }

      // Generate suggestions (with matrix data for routing overview)
      const response = await this.apiClient.sendCommand('generate_assignment_suggestions', {
        fileId: fileId,
        topN: 5,
        minScore: 30,
        excludeVirtual: excludeVirtual,
        includeMatrix: true
      });

      if (!response.success) {
        this.showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      this.suggestions = response.suggestions;
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection;
      this.confidenceScore = response.confidenceScore;
      this.splitProposals = response.splitProposals || {};
      this.allInstruments = response.allInstruments || [];
      this.matrixScores = response.matrixScores || null;
      this.instrumentList = response.instrumentList || null;

      if (response.channelAnalyses) {
        for (const analysis of response.channelAnalyses) {
          this.channelAnalyses[analysis.channel] = analysis;
        }
      }

      // Initialize selected assignments with auto-selection
      // Extract auto-skipped channels (not enough instruments)
      const autoSkippedChannels = this.autoSelection._autoSkipped || [];
      delete this.autoSelection._autoSkipped;

      this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
      this.skippedChannels = new Set();

      // Auto-skip channels that have no unique instrument available
      for (const ch of autoSkippedChannels) {
        this.skippedChannels.add(ch);
      }
      this.autoSkippedChannels = new Set(autoSkippedChannels);

      // Enrich auto-selected assignments with instrument capabilities (gmProgram, note range, etc.)
      // The backend autoSelection doesn't include these, so we look them up from suggestions
      for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
        if (!assignment || !assignment.instrumentId) continue;
        const options = this.suggestions[ch] || [];
        const lowOptions = this.lowScoreSuggestions[ch] || [];
        const matchedOption = options.find(opt => opt.instrument.id === assignment.instrumentId)
          || lowOptions.find(opt => opt.instrument.id === assignment.instrumentId);
        if (matchedOption) {
          assignment.gmProgram = matchedOption.instrument.gm_program;
          assignment.noteRangeMin = matchedOption.instrument.note_range_min;
          assignment.noteRangeMax = matchedOption.instrument.note_range_max;
          assignment.noteSelectionMode = matchedOption.instrument.note_selection_mode;
          assignment.selectedNotes = matchedOption.instrument.selected_notes;
        }
      }

      // Initialize adaptation settings per channel
      this.channels = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
      for (const ch of this.channels) {
        const assignment = this.selectedAssignments[ch];
        this.adaptationSettings[ch] = {
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          octaveWrappingEnabled: assignment?.octaveWrappingEnabled || false,
          noteOffset: 0,
          strategy: assignment?.octaveWrappingEnabled ? 'octaveWrap' : (assignment?.transposition?.semitones) ? 'transpose' : 'ignore',
          drumStrategy: 'intelligent'
        };
      }

      // Initialize audio preview
      if (!this.audioPreview && window.AudioPreview) {
        this.audioPreview = new window.AudioPreview(this.apiClient);
      }

      if (this.channels.length === 0) {
        this.showError(_t('autoAssign.noActiveChannels'));
        return;
      }

      this.activeTab = parseInt(this.channels[0]);
      this.activeChannel = parseInt(this.channels[0]);
      this.showTabbedUI();
    } catch (error) {
      this.showError(error.message || _t('autoAssign.generateFailed'));
    }
  }

  /**
   * Show loading state
   */
  showLoading() {
    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container" style="max-width: 600px;">
          <div class="modal-header">
            <h2>${_t('autoAssign.title')}</h2>
          </div>
          <div class="modal-body" style="text-align: center; padding: 40px;">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">${_t('autoAssign.analyzing')}</p>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    this.modal = document.getElementById('autoAssignModal');
  }

  /**
   * Show error message
   */
  showError(message) {
    if (this.modal) this.modal.remove();
    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container" style="max-width: 600px;">
          <div class="modal-header">
            <h2>${_t('autoAssign.error')}</h2>
            <button class="modal-close" onclick="document.getElementById('autoAssignModal').remove()">x</button>
          </div>
          <div class="modal-body" style="padding: 32px; text-align: center;">
            <p style="color: #ff4444; font-size: 16px;">${escapeHtml(message)}</p>
            <button class="btn" onclick="document.getElementById('autoAssignModal').remove()" style="margin-top: 16px;">
              ${_t('common.close')}
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    this.modal = document.getElementById('autoAssignModal');
  }


  // ========================================================================
  // OVERVIEW INTERACTIONS
  // ========================================================================

  /**
   * Select a channel in overview (updates instrument bar)
   */
  selectOverviewChannel(channel) {
    this.activeChannel = channel;
    this.activeTab = channel;
    this.refreshMainContent();
  }

  /**
   * Assign an instrument to a channel from the overview instrument bar
   */
  assignFromOverview(channel, instrumentId) {
    this.activeChannel = channel;
    this.activeTab = channel;
    // Use existing selectInstrument (from AutoAssignActionsMixin)
    this.selectInstrument(channel, instrumentId);
  }

  /**
   * Toggle split selection mode for a channel
   */
  toggleSplitMode(channel) {
    if (this.splitSelectionMode === channel) {
      // Cancel split mode
      this.splitSelectionMode = null;
      delete this.manualSplitSelection[channel];
    } else {
      this.splitSelectionMode = channel;
      this.manualSplitSelection[channel] = new Set();
    }
    // Refresh instrument bar to show multi-select UI
    const instBar = document.getElementById('aaInstrumentBar');
    if (instBar) {
      instBar.innerHTML = this.renderInstrumentBar(channel);
    }
  }

  /**
   * Toggle an instrument in manual split selection
   */
  toggleSplitInstrument(channel, instrumentId) {
    if (!this.manualSplitSelection[channel]) {
      this.manualSplitSelection[channel] = new Set();
    }
    const sel = this.manualSplitSelection[channel];
    if (sel.has(instrumentId)) {
      sel.delete(instrumentId);
    } else {
      sel.add(instrumentId);
    }
    // Refresh instrument bar
    const instBar = document.getElementById('aaInstrumentBar');
    if (instBar) {
      instBar.innerHTML = this.renderInstrumentBar(channel);
    }
  }

  /**
   * Create a manual split from selected instruments
   */
  createManualSplit(channel) {
    const sel = this.manualSplitSelection[channel];
    if (!sel || sel.size < 2) return;

    const ch = String(channel);
    const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;
    if (!analysis?.noteRange) return;

    const channelMin = analysis.noteRange.min;
    const channelMax = analysis.noteRange.max;
    const totalSpan = channelMax - channelMin + 1;

    // Build segments dividing note range equally
    const instrumentIds = Array.from(sel);
    const segmentSize = Math.ceil(totalSpan / instrumentIds.length);
    const segments = instrumentIds.map((instId, i) => {
      const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
      const option = allOptions.find(opt => opt.instrument.id === instId);
      const inst = option?.instrument || this.instrumentList?.find(x => x.id === instId);
      const segMin = channelMin + i * segmentSize;
      const segMax = Math.min(channelMax, segMin + segmentSize - 1);
      return {
        instrumentId: instId,
        deviceId: inst?.device_id,
        instrumentChannel: inst?.channel,
        instrumentName: inst?.custom_name || inst?.name || 'Instrument',
        noteRange: { min: segMin, max: segMax },
        polyphonyShare: Math.ceil((inst?.polyphony || 16) / instrumentIds.length)
      };
    });

    const proposal = {
      type: 'range',
      channel: channel,
      quality: 70,
      segments: segments,
      overlapZones: [],
      gaps: []
    };

    this.splitProposals[channel] = proposal;
    this.acceptSplit(channel);
    this.splitSelectionMode = null;
    delete this.manualSplitSelection[channel];
    this._isDirty = true;
    this.refreshMainContent();
  }


  /**
   * Refresh the main content (channel detail + bars + header)
   */
  refreshMainContent() {
    if (!this.modal) return;
    const ch = this.activeChannel != null ? this.activeChannel : this.activeTab;
    // Update main content
    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderTabContent(ch);
    }
    // Update sticky header
    this.refreshStickyHeader();
    // Update instrument bar
    const instBar = document.getElementById('aaInstrumentBar');
    if (instBar && ch !== null) {
      instBar.innerHTML = this.renderInstrumentBar(ch);
    }
    // Update channel bar (scores/badges)
    const chBar = document.getElementById('aaChannelBar');
    if (chBar) {
      chBar.innerHTML = this.renderChannelBar();
    }
    // Update range bar
    const rangeBar = document.getElementById('aaRangeBar');
    if (rangeBar) {
      rangeBar.innerHTML = this.renderRangeBar(ch);
    }
    // Update preview buttons
    this.updatePreviewButton(ch);
  }

  /**
   * Update preview button for current channel
   */
  updatePreviewButton(channel) {
    if (!this.modal) return;
    const footer = this.modal.querySelector('.aa-footer-center');
    if (!footer || !this.midiData) return;
    footer.innerHTML = `
      <button class="btn aa-btn-preview-original" onclick="autoAssignModalInstance.previewOriginal(${channel})" title="${_t('autoAssign.previewOriginalTip')}">
        ${_t('autoAssign.previewOriginal')}
      </button>
      <button class="btn" onclick="autoAssignModalInstance.previewChannel(${channel})" title="${_t('autoAssign.previewChannelTip')}">
        ${_t('autoAssign.previewChannel', {num: channel + 1})}
      </button>
      <button class="btn" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
        ${_t('autoAssign.stop')}
      </button>
    `;
  }


  // ========================================================================
  // INSTRUMENT OPTION RENDERING
  // ========================================================================

  /**
   * Get list of other channels currently assigned to the same instrument
   */
  getOtherChannelsUsingInstrument(instrumentId, excludeChannel) {
    const others = [];
    for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
      const chNum = parseInt(ch);
      if (chNum !== excludeChannel && !this.skippedChannels.has(chNum) && assignment?.instrumentId === instrumentId) {
        others.push(chNum + 1); // display as 1-based
      }
    }
    return others;
  }

  /**
   * Render a single score bar for the breakdown
   */
  renderScoreBar(labelKey, scoreData) {
    if (!scoreData) return '';
    const pct = scoreData.max > 0 ? Math.round((scoreData.score / scoreData.max) * 100) : 0;
    const bgClass = this.getScoreBgClass(pct);
    return `
      <div class="aa-score-bar-row">
        <span class="aa-score-bar-label">${_t(labelKey)}</span>
        <div class="aa-score-bar-track">
          <div class="aa-score-bar-fill ${bgClass}" style="width: ${pct}%"></div>
        </div>
        <span class="aa-score-bar-value">${scoreData.score}/${scoreData.max}</span>
      </div>
    `;
  }

  // ========================================================================
  // TOGGLE METHODS
  // ========================================================================

  /**
   * Toggle showing all instruments (including unrouted) in instrument bar
   */
  toggleAllInstruments() {
    this.showAllInstruments = !this.showAllInstruments;
    this.refreshMainContent();
  }

  /**
   * Toggle showing low-score instruments for a channel
   */
  toggleLowScores(channel) {
    const ch = String(channel);
    this.showLowScores[ch] = !this.showLowScores[ch];
    this.refreshCurrentTab();
  }

  /**
   * Toggle score detail breakdown for an instrument
   */
  toggleScoreDetails(detailKey) {
    this.showScoreDetails[detailKey] = !this.showScoreDetails[detailKey];
    this.refreshCurrentTab();
  }

  /**
   * Toggle drum mapping section visibility
   */
  toggleDrumMapping(ch) {
    this.showDrumMapping[ch] = !this.showDrumMapping[ch];
    this.refreshCurrentTab();
  }

  /**
   * Toggle drum category expansion
   */
  toggleDrumCategory(channel, category) {
    const key = `${channel}_${category}`;
    this.expandedDrumCategories[key] = !this.expandedDrumCategories[key];
    this.refreshCurrentTab();
  }

  /**
   * Set adaptation strategy for a channel
   */
  setStrategy(channel, strategy) {
    const ch = String(channel);
    if (!this.adaptationSettings[ch]) return;
    this._isDirty = true;
    this.adaptationSettings[ch].strategy = strategy;

    // When switching to octaveWrap, enable octave wrapping on the assignment
    if (strategy === 'octaveWrap') {
      this.adaptationSettings[ch].octaveWrappingEnabled = true;
      if (this.selectedAssignments[ch]) {
        this.selectedAssignments[ch].octaveWrappingEnabled = true;
      }
    } else {
      this.adaptationSettings[ch].octaveWrappingEnabled = false;
      if (this.selectedAssignments[ch]) {
        this.selectedAssignments[ch].octaveWrappingEnabled = false;
      }
    }

    this.refreshCurrentTab();
  }

  /**
   * Set drum adaptation strategy for a channel
   */
  setDrumStrategy(channel, drumStrategy) {
    const ch = String(channel);
    if (!this.adaptationSettings[ch]) return;
    this.adaptationSettings[ch].drumStrategy = drumStrategy;
    this.refreshCurrentTab();
  }

  /**
   * Adjust a drum note mapping override
   */
  adjustDrumNote(channel, srcNote, delta) {
    const ch = String(channel);
    if (!this.drumMappingOverrides[ch]) this.drumMappingOverrides[ch] = {};

    // Get current target note
    const assignment = this.selectedAssignments[ch];
    const remapping = assignment?.noteRemapping || {};
    const currentTarget = this.drumMappingOverrides[ch][srcNote] !== undefined
      ? this.drumMappingOverrides[ch][srcNote]
      : (remapping[srcNote] || srcNote);

    const newTarget = Math.max(0, Math.min(127, currentTarget + delta));
    this.drumMappingOverrides[ch][srcNote] = newTarget;
    this.refreshCurrentTab();
  }

  /**
   * Reset a drum note mapping override
   */
  resetDrumNote(channel, srcNote) {
    const ch = String(channel);
    if (this.drumMappingOverrides[ch]) {
      delete this.drumMappingOverrides[ch][srcNote];
    }
    this.refreshCurrentTab();
  }

  // ========================================================================
  // ACTIONS
  // ========================================================================

  /**
   * Toggle channel on/off
   */
  toggleChannel(channel, enabled) {
    const ch = String(channel);
    this._isDirty = true;
    if (enabled) {
      this.skippedChannels.delete(channel);
      if (!this.selectedAssignments[ch] && this.autoSelection[ch]) {
        this.selectedAssignments[ch] = JSON.parse(JSON.stringify(this.autoSelection[ch]));
      }
    } else {
      this.skippedChannels.add(channel);
    }
    this.refreshCurrentTab();
    this.refreshTabBar();
  }

  /**
   * Adjust transposition for a channel
   */
  adjustTransposition(channel, delta) {
    const ch = String(channel);
    if (!this.adaptationSettings[ch]) return;
    this._isDirty = true;
    this.adaptationSettings[ch].transpositionSemitones = (this.adaptationSettings[ch].transpositionSemitones || 0) + delta;

    // Clamp to reasonable range
    this.adaptationSettings[ch].transpositionSemitones = Math.max(-48, Math.min(48, this.adaptationSettings[ch].transpositionSemitones));

    // Full refresh to update piano roll and adaptation result
    this.refreshCurrentTab();
  }

  /**
   * Reset transposition to suggested value
   */
  resetTransposition(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    this.adaptationSettings[ch].transpositionSemitones = assignment?.transposition?.semitones || 0;

    // Full refresh to update piano roll and adaptation result
    this.refreshCurrentTab();
  }

  /**
   * Adjust note offset for drums
   */
  adjustNoteOffset(channel, delta) {
    const ch = String(channel);
    if (!this.adaptationSettings[ch]) return;
    this._isDirty = true;
    this.adaptationSettings[ch].noteOffset = (this.adaptationSettings[ch].noteOffset || 0) + delta;
    this.adaptationSettings[ch].noteOffset = Math.max(-24, Math.min(24, this.adaptationSettings[ch].noteOffset));
    this.refreshCurrentTab();
  }

  /**
   * Reset note offset
   */
  resetNoteOffset(channel) {
    const ch = String(channel);
    this.adaptationSettings[ch].noteOffset = 0;
    this.refreshCurrentTab();
  }

  /**
   * Toggle octave wrapping for a channel
   */
  toggleOctaveWrapping(channel, enabled) {
    const ch = String(channel);
    if (this.selectedAssignments[ch]) {
      this.selectedAssignments[ch].octaveWrappingEnabled = enabled;
    }
    if (this.adaptationSettings[ch]) {
      this.adaptationSettings[ch].octaveWrappingEnabled = enabled;
    }
  }

  /**
   * Refresh current tab content without full re-render
   */
  refreshCurrentTab() {
    this.refreshMainContent();
  }

  /**
   * Refresh sticky channel header (range bar, instrument info)
   */
  refreshStickyHeader() {
    const rangeBar = document.getElementById('aaRangeBar');
    if (rangeBar) {
      rangeBar.innerHTML = this.renderRangeBar(this.activeTab);
    }
  }

  /**
   * Quick assign: apply auto-selection immediately with summary
   */
  async quickAssign() {
    // Build summary of what will be assigned
    const assigned = [];
    const lowScore = [];
    const splitCount = Object.keys(this.splitProposals).length;

    for (const ch of this.channels) {
      const channel = parseInt(ch);
      const assignment = this.selectedAssignments[ch];
      if (!assignment) continue;
      const name = assignment.customName || assignment.instrumentName || '?';
      const score = assignment.score || 0;
      assigned.push({ channel: channel + 1, name, score });
      if (score < 60) lowScore.push(channel + 1);
    }

    let summary = _t('autoAssign.quickAssignConfirm');
    summary += `\n\n${assigned.length}/${this.channels.length} ` + _t('autoAssign.channelsWillBeAssigned', { active: assigned.length, total: this.channels.length });
    if (lowScore.length > 0) {
      summary += `\n⚠ Ch ${lowScore.join(', ')}: score < 60`;
    }
    if (splitCount > 0) {
      summary += `\n↕ ${splitCount} split(s) available`;
    }

    const confirmed = await this._showConfirm(summary, {
      title: _t('autoAssign.quickAssign'),
      icon: '⚡',
      okText: _t('autoAssign.quickAssign'),
      danger: false
    });
    if (!confirmed) return;
    this.skippedChannels.clear();
    await this.validateAndApply();
  }

  stopPreview() {
    if (this.audioPreview) this.audioPreview.stop();
    this.hideStopButton();
  }

  showStopButton() {
    const btn = document.getElementById('stopPreviewBtn');
    if (btn) btn.style.display = 'inline-block';
  }

  hideStopButton() {
    const btn = document.getElementById('stopPreviewBtn');
    if (btn) btn.style.display = 'none';
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================

  formatInstrumentInfo(instrument, compat) {
    const parts = [];
    if (instrument.gm_program !== null && instrument.gm_program !== undefined) {
      const gmName = this.getGmProgramName(instrument.gm_program);
      parts.push(gmName || `GM ${instrument.gm_program}`);
    }
    if (compat.transposition && compat.transposition.octaves !== 0) {
      const direction = compat.transposition.octaves > 0 ? 'up' : 'down';
      parts.push(`${Math.abs(compat.transposition.octaves)} ${_t('common.octave')}(s) ${direction}`);
    } else {
      parts.push(_t('autoAssign.noTransposition'));
    }
    if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
      parts.push(`${_t('autoAssign.range')}: ${this.midiNoteToName(instrument.note_range_min)}–${this.midiNoteToName(instrument.note_range_max)}`);
    }
    return parts.join(' &bull; ');
  }

  // Fallback methods — overridden by AutoAssignUtilsMixin if loaded
  getScoreColor(score) {
    if (score >= 80) return 'var(--aa-score-excellent, #00c896)';
    if (score >= 60) return 'var(--aa-score-good, #7bc67e)';
    if (score >= 40) return 'var(--aa-score-fair, #f0b429)';
    return 'var(--aa-score-poor, #e8365d)';
  }

  getScoreClass(score) {
    if (score >= 80) return 'aa-color-excellent';
    if (score >= 60) return 'aa-color-good';
    if (score >= 40) return 'aa-color-fair';
    return 'aa-color-poor';
  }

  getScoreBgClass(score) {
    if (score >= 80) return 'aa-bg-excellent';
    if (score >= 60) return 'aa-bg-good';
    if (score >= 40) return 'aa-bg-fair';
    return 'aa-bg-poor';
  }

  getScoreStars(score) {
    const filled = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;
    return '<span class="aa-stars">' + '&#9733;'.repeat(filled) + '&#9734;'.repeat(5 - filled) + '</span>';
  }

  /**
   * Get a human-readable qualitative label for a score
   */
  getScoreLabel(score) {
    if (score >= 90) return _t('autoAssign.scoreExcellent');
    if (score >= 75) return _t('autoAssign.scoreGood');
    if (score >= 60) return _t('autoAssign.scoreAverage');
    if (score >= 40) return _t('autoAssign.scoreFair');
    return _t('autoAssign.scorePoor');
  }

  /**
   * Get a human-readable description of polyphony
   */
  getPolyphonyLabel(polyphony) {
    if (!polyphony || polyphony.max == null) return 'N/A';
    const max = polyphony.max;
    if (max <= 1) return _t('autoAssign.polyphonyMono');
    if (max <= 3) return _t('autoAssign.polyphonyLight', { max });
    if (max <= 6) return _t('autoAssign.polyphonyChords', { max });
    return _t('autoAssign.polyphonyDense', { max });
  }

  /**
   * Get an icon/emoji for an estimated instrument type
   */
  getTypeIcon(type) {
    const icons = {
      drums: '🥁',
      bass: '🎸',
      melody: '🎹',
      harmony: '🎵',
      pad: '🎶',
      strings: '🎻',
      brass: '🎺',
      woodwind: '🪈',
      guitar: '🎸',
      keyboard: '🎹'
    };
    return icons[type] || '🎵';
  }

  /**
   * Close the modal (with unsaved changes confirmation via styled modal)
   * @param {boolean} [force=false] - Skip dirty check (used after successful apply)
   */
  async close(force) {
    if (!force && this._isDirty) {
      const confirmed = await this._showConfirm(
        _t('autoAssign.unsavedChangesMessage'),
        {
          title: _t('autoAssign.unsavedChanges'),
          icon: '⚠️',
          okText: _t('autoAssign.discardChanges'),
          cancelText: _t('common.cancel'),
          danger: true
        }
      );
      if (!confirmed) return;
    }
    this.stopPreview();

    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    if (this._tabKeyHandler) {
      document.removeEventListener('keydown', this._tabKeyHandler);
      this._tabKeyHandler = null;
    }

    if (this._focusTrap && typeof this._focusTrap.release === 'function') {
      this._focusTrap.release();
      this._focusTrap = null;
    }

    // Restore body scrolling
    document.body.style.overflow = this._prevBodyOverflow || '';

    if (this.modal) {
      if (this._overlayClickHandler) {
        this.modal.removeEventListener('click', this._overlayClickHandler);
        this._overlayClickHandler = null;
      }
      this.modal.remove();
      this.modal = null;
    }

    if (this.audioPreview) {
      this.audioPreview.destroy();
      this.audioPreview = null;
    }

    if (window.autoAssignModalInstance === this) {
      delete window.autoAssignModalInstance;
    }
  }

  // ==================== SPLIT MANAGEMENT ====================

  /**
   * Accept a split proposal for a channel
   * @param {number} channel
   */
  acceptSplit(channel) {
    const proposal = this.splitProposals[channel];
    if (!proposal) return;

    this._isDirty = true;
    this.splitChannels.add(channel);
    this.splitAssignments[channel] = proposal;

    // Remove from skipped if it was auto-skipped
    this.skippedChannels.delete(channel);

    // Clear single instrument selection for this channel
    delete this.selectedAssignments[channel];

    this.refreshCurrentTab();
    this.refreshTabBar();
  }

  /**
   * Reject a split proposal — revert to normal or skipped
   * @param {number} channel
   */
  rejectSplit(channel) {
    this._isDirty = true;
    this.splitChannels.delete(channel);
    delete this.splitAssignments[channel];

    // If was auto-skipped, re-skip it
    if (this.autoSkippedChannels.has(channel)) {
      this.skippedChannels.add(channel);
    }

    this.refreshCurrentTab();
    this.refreshTabBar();
  }

  /**
   * Check if a channel is in split mode
   * @param {number} channel
   * @returns {boolean}
   */
  isSplitChannel(channel) {
    return this.splitChannels.has(channel);
  }

  /**
   * Accept all pending split proposals at once
   */
  async acceptAllSplits() {
    const pendingCount = Object.keys(this.splitProposals).filter(ch => !this.splitChannels.has(Number(ch))).length;
    if (pendingCount === 0) return;

    const confirmed = await this._showConfirm(
      _t('autoAssign.acceptAllSplitsConfirm', { count: pendingCount }),
      { title: _t('autoAssign.acceptAllSplits'), icon: '⇅', danger: false }
    );
    if (!confirmed) return;

    for (const [ch, proposal] of Object.entries(this.splitProposals)) {
      const channel = Number(ch);
      if (this.splitChannels.has(channel)) continue; // already accepted

      this.splitChannels.add(channel);
      this.splitAssignments[channel] = proposal;
      this.skippedChannels.delete(channel);
      delete this.selectedAssignments[ch];
    }
    // Full re-render to update overview, tabs, and footer
    this.showTabbedUI();
  }
}

// Make available globally

// Apply extracted mixins
const _autoassignMixins = [
    typeof AutoAssignUIMixin !== 'undefined' ? AutoAssignUIMixin : null,
    typeof AutoAssignVizMixin !== 'undefined' ? AutoAssignVizMixin : null,
    typeof AutoAssignActionsMixin !== 'undefined' ? AutoAssignActionsMixin : null,
    typeof AutoAssignUtilsMixin !== 'undefined' ? AutoAssignUtilsMixin : null,
];
_autoassignMixins.forEach(m => { if (m) Object.keys(m).forEach(k => { AutoAssignModal.prototype[k] = m[k]; }); });

window.AutoAssignModal = AutoAssignModal;
})();
