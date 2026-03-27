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
    this.activeTab = null; // Currently active channel tab
    this.channels = []; // Sorted channel list
    this.viewMode = 'overview'; // 'overview' or 'detail'
    this.channelDetailsExpanded = {}; // Per-channel toggle for progressive disclosure
    this.adaptationSettings = {}; // Per-channel adaptation overrides
    this.lowScoreSuggestions = {}; // Low-score instruments per channel
    this.showLowScores = {}; // Per-channel toggle for showing low scores
    this.showScoreDetails = {}; // Per-channel/instrument toggle for score breakdown
    this.showDrumMapping = {}; // Per-channel toggle for drum mapping view
    this.drumMappingOverrides = {}; // Per-channel drum note overrides { channel: { midiNote: instrumentNote } }
    this.expandedDrumCategories = {}; // Per-channel/category toggle { 'ch_category': true/false }

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
  async show(fileId) {
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

      // Generate suggestions
      const response = await this.apiClient.sendCommand('generate_assignment_suggestions', {
        fileId: fileId,
        topN: 5,
        minScore: 30,
        excludeVirtual: excludeVirtual
      });

      if (!response.success) {
        this.showError(response.error || _t('autoAssign.generateFailed'));
        return;
      }

      this.suggestions = response.suggestions;
      this.lowScoreSuggestions = response.lowScoreSuggestions || {};
      this.autoSelection = response.autoSelection;
      this.confidenceScore = response.confidenceScore;

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

  /**
   * Switch between 'overview' and 'detail' view modes
   */
  setViewMode(mode) {
    this.viewMode = mode;
    this.showTabbedUI();
  }

  /**
   * Navigate from overview to detail view for a specific channel
   */
  overviewGoToChannel(channel) {
    this.activeTab = channel;
    this.viewMode = 'detail';
    this.showTabbedUI();
  }

  /**
   * Update preview button for current channel
   */
  updatePreviewButton(channel) {
    if (!this.modal) return;
    const footer = this.modal.querySelector('.aa-footer-center');
    if (!footer || !this.midiData) return;
    footer.innerHTML = `
      <button class="btn" onclick="autoAssignModalInstance.previewChannel(${channel})" title="${_t('autoAssign.previewChannelTip')}">
        ${_t('autoAssign.previewChannel', {num: channel + 1})}
      </button>
      <button class="btn" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
        ${_t('autoAssign.stop')}
      </button>
    `;
  }

  /**
   * Render content for a single channel tab
   */
  /**
   * Toggle expanded/collapsed state for a channel's detail view
   */
  toggleChannelDetails(channel) {
    const ch = String(channel);
    this.channelDetailsExpanded[ch] = !this.channelDetailsExpanded[ch];
    this.refreshCurrentTab();
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
    const color = this.getScoreColor(pct);
    return `
      <div class="aa-score-bar-row">
        <span class="aa-score-bar-label">${_t(labelKey)}</span>
        <div class="aa-score-bar-track">
          <div class="aa-score-bar-fill" style="width: ${pct}%; background: ${color}"></div>
        </div>
        <span class="aa-score-bar-value">${scoreData.score}/${scoreData.max}</span>
      </div>
    `;
  }

  // ========================================================================
  // TOGGLE METHODS
  // ========================================================================

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
    this.adaptationSettings[ch].transpositionSemitones = (this.adaptationSettings[ch].transpositionSemitones || 0) + delta;

    // Clamp to reasonable range
    this.adaptationSettings[ch].transpositionSemitones = Math.max(-48, Math.min(48, this.adaptationSettings[ch].transpositionSemitones));

    const el = document.getElementById(`transpo_${channel}`);
    if (el) {
      const val = this.adaptationSettings[ch].transpositionSemitones;
      el.textContent = `${val > 0 ? '+' : ''}${val} st`;
    }
  }

  /**
   * Reset transposition to suggested value
   */
  resetTransposition(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    this.adaptationSettings[ch].transpositionSemitones = assignment?.transposition?.semitones || 0;
    const el = document.getElementById(`transpo_${channel}`);
    if (el) {
      const val = this.adaptationSettings[ch].transpositionSemitones;
      el.textContent = `${val > 0 ? '+' : ''}${val} st`;
    }
  }

  /**
   * Adjust note offset for drums
   */
  adjustNoteOffset(channel, delta) {
    const ch = String(channel);
    if (!this.adaptationSettings[ch]) return;
    this.adaptationSettings[ch].noteOffset = (this.adaptationSettings[ch].noteOffset || 0) + delta;
    this.adaptationSettings[ch].noteOffset = Math.max(-24, Math.min(24, this.adaptationSettings[ch].noteOffset));

    const el = document.getElementById(`noteOffset_${channel}`);
    if (el) {
      const val = this.adaptationSettings[ch].noteOffset;
      el.textContent = `${val > 0 ? '+' : ''}${val}`;
    }
  }

  /**
   * Reset note offset
   */
  resetNoteOffset(channel) {
    const ch = String(channel);
    this.adaptationSettings[ch].noteOffset = 0;
    const el = document.getElementById(`noteOffset_${channel}`);
    if (el) el.textContent = '0';
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
    this.refreshStickyHeader();
    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderTabContent(this.activeTab);
    }
  }

  /**
   * Refresh sticky channel header (range bar, instrument info)
   */
  refreshStickyHeader() {
    const sticky = document.getElementById('aaChannelSticky');
    if (sticky) {
      sticky.innerHTML = this.renderChannelStickyHeader(this.activeTab);
    }
    const rangeBar = document.getElementById('aaRangeBar');
    if (rangeBar) {
      rangeBar.innerHTML = this.renderRangeBar(this.activeTab);
    }
  }

  /**
   * Quick assign: apply auto-selection immediately
   */
  async quickAssign() {
    if (typeof window.showConfirm === 'function') {
      const confirmed = await window.showConfirm(_t('autoAssign.quickAssignConfirm'));
      if (!confirmed) return;
    } else {
      if (!confirm(_t('autoAssign.quickAssignConfirm'))) return;
    }
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

  getScoreColor(score) {
    if (score >= 80) return '#4CAF50';
    if (score >= 60) return '#8BC34A';
    if (score >= 40) return '#FF9800';
    return '#F44336';
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
   * Close the modal
   */
  close() {
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
}

// Make available globally

// Apply extracted mixins
const _autoassignMixins = [
    typeof AutoAssignUIMixin !== 'undefined' ? AutoAssignUIMixin : null,
    typeof AutoAssignVizMixin !== 'undefined' ? AutoAssignVizMixin : null,
    typeof AutoAssignActionsMixin !== 'undefined' ? AutoAssignActionsMixin : null,
];
_autoassignMixins.forEach(m => { if (m) Object.keys(m).forEach(k => { AutoAssignModal.prototype[k] = m[k]; }); });

window.AutoAssignModal = AutoAssignModal;
})();
