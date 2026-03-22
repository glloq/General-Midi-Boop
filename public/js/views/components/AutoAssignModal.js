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
    this.modal = null;
    this.audioPreview = null;
    this._escHandler = null;
    this.activeTab = null; // Currently active channel tab
    this.channels = []; // Sorted channel list
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
    this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
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
    const selectedOption = allOptions.find(opt => opt.instrument.device_id === assignment.deviceId);
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
      this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
      this.skippedChannels = new Set();

      // Enrich auto-selected assignments with instrument capabilities (gmProgram, note range, etc.)
      // The backend autoSelection doesn't include these, so we look them up from suggestions
      for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
        if (!assignment || !assignment.deviceId) continue;
        const options = this.suggestions[ch] || [];
        const lowOptions = this.lowScoreSuggestions[ch] || [];
        const matchedOption = options.find(opt => opt.instrument.device_id === assignment.deviceId)
          || lowOptions.find(opt => opt.instrument.device_id === assignment.deviceId);
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

  // ========================================================================
  // TAB-BASED UI
  // ========================================================================

  /**
   * Main UI: tabs for each channel + content area
   */
  showTabbedUI() {
    if (this.modal) this.modal.remove();
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
    }

    const tabsHTML = this.channels.map(ch => {
      const channel = parseInt(ch);
      const isActive = channel === this.activeTab;
      const isSkipped = this.skippedChannels.has(channel);
      const assignment = this.selectedAssignments[ch];
      const score = assignment?.score || 0;

      return `
        <button class="aa-tab ${isActive ? 'active' : ''} ${isSkipped ? 'skipped' : ''}"
                data-channel="${channel}"
                onclick="autoAssignModalInstance.switchTab(${channel})">
          <span class="aa-tab-label">${_t('autoAssign.channel')} ${channel + 1}</span>
          ${channel === 9 ? '<span class="aa-tab-drum">DR</span>' : ''}
          ${isSkipped
            ? '<span class="aa-tab-status skipped">—</span>'
            : `<span class="aa-tab-status" style="color: ${this.getScoreColor(score)}">${score}</span>`
          }
        </button>
      `;
    }).join('');

    const activeCount = this.channels.length - this.skippedChannels.size;

    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container aa-container">
          <div class="modal-header">
            <div class="aa-header-content">
              <h2>${_t('autoAssign.title')}</h2>
              <div class="aa-header-stats">
                <span class="aa-confidence" style="color: ${this.getScoreColor(this.confidenceScore)}">
                  ${this.getScoreStars(this.confidenceScore)} ${this.confidenceScore}/100
                </span>
                <span class="aa-channel-count">
                  ${_t('autoAssign.channelsWillBeAssigned', {active: activeCount, total: this.channels.length})}
                </span>
              </div>
            </div>
            <button class="modal-close" onclick="autoAssignModalInstance.close()">x</button>
          </div>

          <div class="aa-tabs-bar">
            ${tabsHTML}
          </div>

          <div class="modal-body aa-body" id="aaTabContent">
            ${this.renderTabContent(this.activeTab)}
          </div>

          <div class="modal-footer aa-footer">
            <button class="btn" onclick="autoAssignModalInstance.close()">
              ${_t('common.cancel')}
            </button>
            <div class="aa-footer-center">
              ${this.midiData ? `
                <button class="btn" onclick="autoAssignModalInstance.previewChannel(${this.activeTab})" title="${_t('autoAssign.previewChannelTip')}">
                  ${_t('autoAssign.previewChannel', {num: this.activeTab + 1})}
                </button>
                <button class="btn" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                  ${_t('autoAssign.stop')}
                </button>
              ` : ''}
            </div>
            <div class="aa-footer-right">
              <button class="btn" onclick="autoAssignModalInstance.quickAssign()" title="${_t('autoAssign.quickAssignTip')}">
                ${_t('autoAssign.quickAssign')}
              </button>
              <button class="btn btn-primary" onclick="autoAssignModalInstance.validateAndApply()">
                ${_t('autoAssign.validateAndOpen')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);
    this.modal = document.getElementById('autoAssignModal');
    window.autoAssignModalInstance = this;

    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    this._overlayClickHandler = (e) => {
      if (e.target === this.modal) this.close();
    };
    this.modal.addEventListener('click', this._overlayClickHandler);
  }

  /**
   * Switch to a different channel tab
   */
  switchTab(channel) {
    if (!this.modal) return;
    this.activeTab = channel;
    // Update tab active states
    const tabs = this.modal.querySelectorAll('.aa-tab');
    tabs.forEach(tab => {
      const ch = parseInt(tab.dataset.channel);
      tab.classList.toggle('active', ch === channel);
    });
    // Update content
    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderTabContent(channel);
    }
    // Update preview button
    this.updatePreviewButton(channel);
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
  renderTabContent(channel) {
    const ch = String(channel);
    const options = this.suggestions[ch] || [];
    const isSkipped = this.skippedChannels.has(channel);
    const selectedDeviceId = this.selectedAssignments[ch]?.deviceId;
    const analysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch];
    const adaptation = this.adaptationSettings[ch] || {};

    // Channel stats section
    const statsHTML = this.renderChannelStats(channel, analysis);

    // Skip toggle
    const skipHTML = `
      <div class="aa-skip-toggle ${isSkipped ? 'skipped' : 'active'}">
        <label>
          <input type="checkbox"
                 ${isSkipped ? '' : 'checked'}
                 onchange="autoAssignModalInstance.toggleChannel(${channel}, this.checked)">
          <span>${isSkipped ? _t('autoAssign.channelSkipped') : _t('autoAssign.assignChannel')}</span>
        </label>
      </div>
    `;

    if (options.length === 0) {
      // Even with no recommended instruments, show low-score ones if available
      const lowOptions = this.lowScoreSuggestions[ch] || [];
      const showLow = this.showLowScores[ch] || false;
      const fallbackHTML = lowOptions.length > 0 ? `
        <div class="aa-low-scores-section">
          <button class="aa-toggle-low-scores" onclick="autoAssignModalInstance.toggleLowScores(${channel})">
            ${showLow ? '&#9660;' : '&#9654;'} ${_t('autoAssign.showAllInstruments')} (${lowOptions.length})
          </button>
          ${showLow ? `
            <div class="aa-low-scores-list">
              ${lowOptions.map((option, index) => {
                return this.renderInstrumentOption(channel, option, index, selectedDeviceId, true);
              }).join('')}
            </div>
          ` : ''}
        </div>
      ` : '';

      return `
        <div class="aa-tab-content">
          <div class="aa-channel-header">
            <h3>${_t('autoAssign.channel')} ${channel + 1}
              ${channel === 9 ? `<span class="aa-drum-badge">(MIDI 10 - ${_t('autoAssign.drums')})</span>` : ''}
            </h3>
          </div>
          ${statsHTML}
          ${skipHTML}
          <p class="aa-no-compatible">${_t('autoAssign.noCompatible')}</p>
          ${fallbackHTML}
        </div>
      `;
    }

    // Instrument options
    const optionsHTML = isSkipped ? '' : options.map((option, index) => {
      return this.renderInstrumentOption(channel, option, index, selectedDeviceId, false);
    }).join('');

    // Low-score instruments (collapsible)
    const lowScoreOptions = this.lowScoreSuggestions[ch] || [];
    const showLow = this.showLowScores[ch] || false;
    const lowScoreHTML = (!isSkipped && lowScoreOptions.length > 0) ? `
      <div class="aa-low-scores-section">
        <button class="aa-toggle-low-scores" onclick="autoAssignModalInstance.toggleLowScores(${channel})">
          ${showLow ? '&#9660;' : '&#9654;'} ${_t('autoAssign.showAllInstruments')} (${lowScoreOptions.length})
        </button>
        ${showLow ? `
          <div class="aa-low-scores-list">
            ${lowScoreOptions.map((option, index) => {
              return this.renderInstrumentOption(channel, option, options.length + index, selectedDeviceId, true);
            }).join('')}
          </div>
        ` : ''}
      </div>
    ` : '';

    // Compact range bar (in channel header area)
    const rangeBarHTML = (!isSkipped && selectedDeviceId) ? this.renderRangeBar(channel) : '';

    // Adaptation controls (only if not skipped and instrument selected)
    const adaptationHTML = (!isSkipped && selectedDeviceId) ? this.renderAdaptationControls(channel, adaptation) : '';

    // Drum mapping config section (only for channel 9 or percussion-type channels)
    const isDrumChannel = channel === 9 || (analysis && analysis.estimatedType === 'drums');
    const drumMappingHTML = (!isSkipped && isDrumChannel && selectedDeviceId) ? this.renderDrumMappingSection(channel) : '';

    return `
      <div class="aa-tab-content">
        <div class="aa-channel-header">
          <h3>${_t('autoAssign.channel')} ${channel + 1}
            ${channel === 9 ? `<span class="aa-drum-badge">(MIDI 10 - ${_t('autoAssign.drums')})</span>` : ''}
            ${isSkipped ? `<span class="aa-skipped-badge">[${_t('autoAssign.skippedLabel')}]</span>` : ''}
          </h3>
        </div>
        ${rangeBarHTML}
        ${statsHTML}
        ${skipHTML}
        <div class="aa-instruments-list">
          ${optionsHTML}
        </div>
        ${lowScoreHTML}
        ${adaptationHTML}
        ${drumMappingHTML}
      </div>
    `;
  }

  /**
   * Render channel statistics
   */
  renderChannelStats(channel, analysis) {
    if (!analysis) return '';

    const noteRange = analysis.noteRange || {};
    const polyphony = analysis.polyphony || {};

    return `
      <div class="aa-channel-stats">
        <div class="aa-stat">
          <strong>${_t('autoAssign.noteRange')}:</strong>
          ${noteRange.min != null ? `${noteRange.min} - ${noteRange.max} (${noteRange.max - noteRange.min} st)` : 'N/A'}
        </div>
        <div class="aa-stat">
          <strong>${_t('autoAssign.polyphony')}:</strong>
          ${polyphony.max != null ? `Max: ${polyphony.max}${polyphony.avg !== undefined ? ` | Avg: ${polyphony.avg.toFixed(1)}` : ''}` : 'N/A'}
        </div>
        <div class="aa-stat">
          <strong>${_t('autoAssign.type')}:</strong>
          ${escapeHtml(analysis.estimatedType || 'N/A')} ${analysis.typeConfidence ? `(${analysis.typeConfidence}%)` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render adaptation controls for a channel with strategy selector
   */
  renderAdaptationControls(channel, adaptation) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const semitones = adaptation.transpositionSemitones || 0;
    const strategy = adaptation.strategy || 'ignore';
    const isDrumChannel = channel === 9 || (assignment?.channelAnalysis?.estimatedType === 'drums');

    // Strategy selector (not for drum channels - they have their own drumStrategy)
    const strategies = [
      { value: 'transpose', label: _t('autoAssign.strategyTranspose'), desc: _t('autoAssign.strategyTransposeDesc') },
      { value: 'octaveWrap', label: _t('autoAssign.strategyOctaveWrap'), desc: _t('autoAssign.strategyOctaveWrapDesc') },
      { value: 'suppress', label: _t('autoAssign.strategySuppress'), desc: _t('autoAssign.strategySuppressDesc') },
      { value: 'ignore', label: _t('autoAssign.strategyIgnore'), desc: _t('autoAssign.strategyIgnoreDesc') }
    ];

    const strategyHTML = isDrumChannel ? '' : `
      <div class="aa-strategy-selector">
        <label class="aa-strategy-title">${_t('autoAssign.adaptationStrategy')}:</label>
        <div class="aa-strategy-options">
          ${strategies.map(s => `
            <label class="aa-strategy-option ${strategy === s.value ? 'selected' : ''}">
              <input type="radio" name="strategy_${channel}" value="${s.value}"
                     ${strategy === s.value ? 'checked' : ''}
                     onchange="autoAssignModalInstance.setStrategy(${channel}, '${s.value}')">
              <span class="aa-strategy-label">${s.label}</span>
              <span class="aa-strategy-desc">${s.desc}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;

    // Transposition controls (only visible when strategy is 'transpose', not for drums)
    const transpoHTML = (!isDrumChannel && strategy === 'transpose') ? `
      <div class="aa-control-group">
        <label>${_t('autoAssign.transposition')}</label>
        <div class="aa-transposition-control">
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustTransposition(${channel}, -12)">-Oct</button>
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustTransposition(${channel}, -1)">-1</button>
          <span class="aa-transposition-value" id="transpo_${channel}">
            ${semitones > 0 ? '+' : ''}${semitones} st
          </span>
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustTransposition(${channel}, +1)">+1</button>
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustTransposition(${channel}, +12)">+Oct</button>
          <button class="aa-btn-sm aa-btn-reset" onclick="autoAssignModalInstance.resetTransposition(${channel})">
            ${_t('autoAssign.reset')}
          </button>
        </div>
      </div>
    ` : '';

    // Note offset for drums
    const drumOffsetHTML = channel === 9 ? `
      <div class="aa-control-group">
        <label>${_t('autoAssign.noteOffset')}</label>
        <div class="aa-transposition-control">
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustNoteOffset(${channel}, -1)">-1</button>
          <span class="aa-transposition-value" id="noteOffset_${channel}">
            ${(adaptation.noteOffset || 0) > 0 ? '+' : ''}${adaptation.noteOffset || 0}
          </span>
          <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustNoteOffset(${channel}, +1)">+1</button>
          <button class="aa-btn-sm aa-btn-reset" onclick="autoAssignModalInstance.resetNoteOffset(${channel})">
            ${_t('autoAssign.reset')}
          </button>
        </div>
        <div class="aa-control-hint">${_t('autoAssign.noteOffsetHint')}</div>
      </div>
    ` : '';

    return `
      <div class="aa-adaptation-section">
        <h4>${_t('autoAssign.adaptationTitle')}</h4>

        ${strategyHTML}

        <div class="aa-adaptation-controls">
          ${transpoHTML}
          ${drumOffsetHTML}
        </div>
      </div>
    `;
  }

  /**
   * Render visual piano roll: channel notes vs instrument range
   * Each key is colored by status: green=used+in-range, red=used+out-of-range,
   * light gray=instrument range but unused, white=outside both
   */
  renderNoteRangeViz(channel, analysis, assignment, semitones) {
    if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';

    const ch = String(channel);
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.device_id === assignment?.deviceId);
    if (!selectedOption) return '';

    const inst = selectedOption.instrument;
    const noteDistribution = analysis.noteDistribution || {};
    const usedNotes = Object.keys(noteDistribution).map(Number);
    if (usedNotes.length === 0) return '';

    // Calculate transposed used notes
    const transposedNotes = usedNotes.map(n => n + semitones);
    const transposedMin = Math.min(...transposedNotes);
    const transposedMax = Math.max(...transposedNotes);

    // Determine instrument range bounds
    const instMin = inst.note_range_min != null ? inst.note_range_min : 0;
    const instMax = inst.note_range_max != null ? inst.note_range_max : 127;

    // Global display range (with padding)
    const globalMin = Math.max(0, Math.min(transposedMin, instMin) - 2);
    const globalMax = Math.min(127, Math.max(transposedMax, instMax) + 2);

    // Build note-level data
    const transposedDistribution = {};
    for (const [note, count] of Object.entries(noteDistribution)) {
      transposedDistribution[Number(note) + semitones] = count;
    }
    const maxCount = Math.max(...Object.values(transposedDistribution), 1);

    // Count in-range vs out-of-range
    let inRangeCount = 0;
    let outOfRangeCount = 0;
    for (const note of transposedNotes) {
      if (this.isNoteInInstrumentRange(note, inst)) {
        inRangeCount++;
      } else {
        outOfRangeCount++;
      }
    }

    // Generate piano keys
    let keysHTML = '';
    let octaveMarkers = '';
    for (let note = globalMin; note <= globalMax; note++) {
      const isBlack = this.isBlackKey(note);
      const isUsed = transposedDistribution[note] !== undefined;
      const inRange = this.isNoteInInstrumentRange(note, inst);
      const usage = isUsed ? transposedDistribution[note] / maxCount : 0;

      let statusClass = '';
      if (isUsed && inRange) statusClass = 'used-ok';
      else if (isUsed && !inRange) statusClass = 'used-out';
      else if (inRange) statusClass = 'in-range';

      const opacityStyle = isUsed ? `opacity: ${Math.max(0.4, usage)}` : '';
      const title = isUsed
        ? `${this.midiNoteToName(note)} (${note}) - ${transposedDistribution[note]}x${inRange ? '' : ' [OUT]'}`
        : `${this.midiNoteToName(note)} (${note})${inRange ? ' [inst]' : ''}`;

      keysHTML += `<div class="aa-piano-key ${isBlack ? 'black' : 'white'} ${statusClass}" title="${title}" style="${opacityStyle}"></div>`;

      // Add octave markers for C notes
      if (note % 12 === 0) {
        const pos = ((note - globalMin) / (globalMax - globalMin)) * 100;
        octaveMarkers += `<span class="aa-octave-marker" style="left: ${pos}%">${this.midiNoteToName(note)}</span>`;
      }
    }

    // Summary text
    const summaryClass = outOfRangeCount > 0 ? 'aa-summary-warning' : 'aa-summary-ok';
    const summaryText = outOfRangeCount > 0
      ? `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${inRangeCount} ${_t('autoAssign.inRange')}, ${outOfRangeCount} ${_t('autoAssign.outOfRange')}`
      : `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${_t('autoAssign.allInRange')}`;

    return `
      <div class="aa-note-range-viz">
        <div class="aa-note-range-labels">
          <span>${_t('autoAssign.channelNotes')}: ${this.midiNoteToName(transposedMin)}-${this.midiNoteToName(transposedMax)}</span>
          <span>${_t('autoAssign.instrumentRange')}: ${this.midiNoteToName(instMin)}-${this.midiNoteToName(instMax)}</span>
        </div>
        <div class="aa-piano-roll">
          ${keysHTML}
        </div>
        <div class="aa-piano-roll-octaves">
          ${octaveMarkers}
        </div>
        <div class="aa-piano-roll-legend">
          <span class="aa-legend-item"><span class="aa-legend-color used-ok"></span> ${_t('autoAssign.legendInRange')}</span>
          <span class="aa-legend-item"><span class="aa-legend-color used-out"></span> ${_t('autoAssign.legendOutOfRange')}</span>
          <span class="aa-legend-item"><span class="aa-legend-color in-range"></span> ${_t('autoAssign.legendAvailable')}</span>
        </div>
        <div class="${summaryClass}">${summaryText}</div>
      </div>
    `;
  }

  // ========================================================================
  // COMPACT RANGE BAR VISUALIZATION
  // ========================================================================

  /**
   * Render compact linear range bar: instrument range (green) vs channel notes (blue/orange)
   * For drums/discrete instruments, shows a text summary instead.
   */
  renderRangeBar(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const analysis = assignment?.channelAnalysis || this.channelAnalyses[channel];
    const adaptation = this.adaptationSettings[ch] || {};
    const semitones = adaptation.transpositionSemitones || 0;
    const strategy = adaptation.strategy || 'ignore';

    if (!analysis?.noteRange || analysis.noteRange.min == null || !assignment?.deviceId) return '';

    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.device_id === assignment.deviceId);
    if (!selectedOption) return '';
    const inst = selectedOption.instrument;

    const isDrumOrDiscrete = channel === 9
      || (analysis.estimatedType === 'drums')
      || inst.note_selection_mode === 'discrete';

    if (isDrumOrDiscrete) {
      const mappingCount = Object.keys(assignment.noteRemapping || {}).length;
      return `<div class="aa-range-bar-container aa-range-drums">
        ${mappingCount} ${_t('autoAssign.notesMapped')}
      </div>`;
    }

    // Positions as % of 0-127 MIDI scale
    const instMin = inst.note_range_min ?? 0;
    const instMax = inst.note_range_max ?? 127;
    const chanMin = analysis.noteRange.min + semitones;
    const chanMax = analysis.noteRange.max + semitones;

    const pct = v => ((Math.max(0, Math.min(127, v)) / 127) * 100).toFixed(1);
    const instLeft = pct(instMin);
    const instWidth = (((instMax - instMin) / 127) * 100).toFixed(1);
    const chanLeft = pct(chanMin);
    const chanWidth = Math.max(0.5, ((chanMax - chanMin) / 127) * 100).toFixed(1);

    // Adaptation result
    const result = this.calculateAdaptationResult(channel, strategy);
    const allOk = result.outOfRange === 0;
    const chanClass = allOk ? 'in-range' : 'out-of-range';

    // Compact summary
    let summaryHTML = '';
    if (result.totalNotes > 0) {
      if (allOk) {
        summaryHTML = `<span class="aa-range-summary ok">${result.totalNotes}/${result.totalNotes} OK</span>`;
      } else {
        const playable = result.inRange + result.recovered;
        summaryHTML = `<span class="aa-range-summary warning">${playable}/${result.totalNotes} — ${result.outOfRange} ${_t('autoAssign.outOfRange')}</span>`;
      }
    }

    const transpoLabel = semitones ? ` (${semitones > 0 ? '+' : ''}${semitones}st)` : '';

    return `<div class="aa-range-bar-container">
      <div class="aa-range-bar">
        <div class="aa-range-instrument" style="left:${instLeft}%;width:${instWidth}%"
             title="${_t('autoAssign.instrumentRange')}: ${this.midiNoteToName(instMin)}-${this.midiNoteToName(instMax)}"></div>
        <div class="aa-range-channel ${chanClass}" style="left:${chanLeft}%;width:${chanWidth}%"
             title="${_t('autoAssign.channelNotes')}: ${this.midiNoteToName(chanMin)}-${this.midiNoteToName(chanMax)}"></div>
      </div>
      <div class="aa-range-legend">
        <span class="aa-range-legend-item"><span class="aa-rleg-color inst"></span>${this.midiNoteToName(instMin)}-${this.midiNoteToName(instMax)}</span>
        <span class="aa-range-legend-item"><span class="aa-rleg-color chan ${chanClass}"></span>${this.midiNoteToName(chanMin)}-${this.midiNoteToName(chanMax)}${escapeHtml(transpoLabel)}</span>
        ${summaryHTML}
      </div>
    </div>`;
  }

  // ========================================================================
  // INSTRUMENT OPTION RENDERING
  // ========================================================================

  /**
   * Render a single instrument option (used for both normal and low-score lists)
   */
  renderInstrumentOption(channel, option, index, selectedDeviceId, isLowScore) {
    const instrument = option.instrument;
    const compat = option.compatibility;
    const isSelected = instrument.device_id === selectedDeviceId;
    const escapedName = escapeHtml(instrument.custom_name || instrument.name);
    const escapedDeviceId = escapeHtml(instrument.device_id);
    const detailKey = `${channel}_${escapedDeviceId}`;
    const showDetails = this.showScoreDetails[detailKey] || false;

    const scoreBreakdown = compat.scoreBreakdown;
    const breakdownHTML = (showDetails && scoreBreakdown) ? `
      <div class="aa-score-breakdown">
        ${this.renderScoreBar('autoAssign.scoreProgram', scoreBreakdown.program)}
        ${this.renderScoreBar('autoAssign.scoreNoteRange', scoreBreakdown.noteRange)}
        ${this.renderScoreBar('autoAssign.scorePolyphony', scoreBreakdown.polyphony)}
        ${this.renderScoreBar('autoAssign.scoreCCSupport', scoreBreakdown.ccSupport)}
        ${this.renderScoreBar('autoAssign.scoreType', scoreBreakdown.instrumentType)}
        ${scoreBreakdown.percussion && scoreBreakdown.percussion.max !== 0 ? this.renderScoreBar('autoAssign.scorePercussion', scoreBreakdown.percussion) : ''}
      </div>
    ` : '';

    return `
      <div class="aa-instrument-option ${isSelected ? 'selected' : ''} ${isLowScore ? 'low-score' : ''}"
           data-channel="${channel}"
           data-device-id="${escapedDeviceId}">
        <div class="aa-instrument-main"
             onclick="autoAssignModalInstance.selectInstrument(${channel}, '${escapedDeviceId.replace(/'/g, "\\'")}')">
          <div class="aa-instrument-info">
            <div class="aa-instrument-name">
              ${escapedName}
              ${index === 0 && !isLowScore ? `<span class="aa-recommended">${_t('autoAssign.recommended')}</span>` : ''}
              ${isLowScore ? `<span class="aa-low-score-badge">${_t('autoAssign.lowScore')}</span>` : ''}
            </div>
            <div class="aa-instrument-details">
              ${this.formatInstrumentInfo(instrument, compat)}
            </div>
            ${compat.info ? `<div class="aa-instrument-compat-info">${this.formatInfo(compat.info)}</div>` : ''}
            ${compat.issues && compat.issues.length > 0 ? `
              <div class="aa-instrument-issues">
                ${compat.issues.map(i => escapeHtml(i.message)).join(' &bull; ')}
              </div>
            ` : ''}
          </div>
          <div class="aa-instrument-score">
            <span class="aa-score-value" style="color: ${this.getScoreColor(compat.score)}">${compat.score}</span>
            <span class="aa-score-stars">${this.getScoreStars(compat.score)}</span>
          </div>
        </div>
        <button class="aa-score-detail-toggle" onclick="autoAssignModalInstance.toggleScoreDetails('${detailKey}')">
          ${showDetails ? _t('autoAssign.hideDetails') : _t('autoAssign.showDetails')}
        </button>
        ${breakdownHTML}
      </div>
    `;
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

  /**
   * Render the drum mapping configuration section — categorized view with summary
   */
  renderDrumMappingSection(channel) {
    const ch = String(channel);
    const showMapping = this.showDrumMapping[ch] || false;
    const assignment = this.selectedAssignments[ch];
    if (!assignment) return '';

    // Find the selected instrument's compatibility data
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.device_id === assignment.deviceId);
    const noteRemapping = assignment.noteRemapping || (selectedOption && selectedOption.compatibility.noteRemapping) || {};

    // GM drum note names
    const drumNames = {
      35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
      39: 'Hand Clap', 40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat',
      43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
      47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom',
      51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine',
      55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 59: 'Ride Cymbal 2',
      60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga', 63: 'Open Hi Conga',
      64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale', 67: 'High Agogo',
      68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas', 71: 'Short Whistle',
      72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves',
      76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica', 79: 'Open Cuica',
      80: 'Mute Triangle', 81: 'Open Triangle'
    };

    // Get overrides for this channel
    const overrides = this.drumMappingOverrides[ch] || {};

    // Build mapping entries
    const mappingEntries = Object.entries(noteRemapping).map(([src, tgt]) => {
      const srcNote = parseInt(src);
      const tgtNote = overrides[srcNote] !== undefined ? overrides[srcNote] : tgt;
      const srcName = drumNames[srcNote] || `Note ${srcNote}`;
      const tgtName = drumNames[tgtNote] || `Note ${tgtNote}`;
      const isModified = srcNote !== tgtNote;
      const isOverridden = overrides[srcNote] !== undefined;
      return { srcNote, tgtNote, srcName, tgtName, isModified, isOverridden };
    }).sort((a, b) => a.srcNote - b.srcNote);

    // Get notes actually used in the channel
    const analysis = this.channelAnalyses[channel] || assignment.channelAnalysis;
    const usedNotes = analysis?.noteDistribution ? Object.keys(analysis.noteDistribution).map(Number) : [];

    if (mappingEntries.length === 0 && usedNotes.length === 0) {
      return `
        <div class="aa-drum-mapping-section">
          <button class="aa-toggle-drum-mapping" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
            ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          </button>
          ${showMapping ? `<p class="aa-no-compatible">${_t('autoAssign.noDrumMapping')}</p>` : ''}
        </div>
      `;
    }

    // Group entries by drum category
    const mappingByNote = {};
    for (const entry of mappingEntries) {
      mappingByNote[entry.srcNote] = entry;
    }

    // Build category summary and detail
    const categoryData = [];
    for (const [catKey, catDef] of Object.entries(this.DRUM_CATEGORIES)) {
      const catNotes = catDef.notes.filter(n => usedNotes.includes(n) || mappingByNote[n]);
      if (catNotes.length === 0) continue;

      const entries = catNotes.map(n => {
        if (mappingByNote[n]) return mappingByNote[n];
        // Note used but no remapping needed (direct mapping)
        const name = drumNames[n] || `Note ${n}`;
        return { srcNote: n, tgtNote: n, srcName: name, tgtName: name, isModified: false, isOverridden: false };
      });

      const mapped = entries.filter(e => !e.isModified || e.tgtNote !== undefined).length;
      const total = entries.length;
      const modified = entries.filter(e => e.isModified).length;

      categoryData.push({
        key: catKey,
        label: catDef.label,
        entries,
        mapped,
        total,
        modified,
        status: mapped === total ? 'ok' : (mapped > 0 ? 'partial' : 'missing')
      });
    }

    // Use backend quality score if available, fallback to local exact-match ratio
    const backendQuality = selectedOption?.compatibility?.drumMappingQuality?.score;
    const totalEntries = categoryData.reduce((sum, c) => sum + c.total, 0);
    const exactMatches = categoryData.reduce((sum, c) => sum + c.entries.filter(e => !e.isModified).length, 0);
    const qualityScore = backendQuality != null
      ? Math.round(backendQuality)
      : (totalEntries > 0 ? Math.round((exactMatches / totalEntries) * 100) : 100);

    // Summary badges
    const summaryHTML = `
      <div class="aa-drum-summary">
        <div class="aa-drum-quality">
          ${this.getScoreStars(qualityScore)} ${qualityScore}/100
        </div>
        <div class="aa-drum-category-badges">
          ${categoryData.map(cat => {
            const icon = cat.status === 'ok' ? '&#10003;' : (cat.status === 'partial' ? '!' : '&#10007;');
            return `<span class="aa-drum-badge-cat ${cat.status}">${icon} ${cat.label} (${cat.mapped}/${cat.total})</span>`;
          }).join('')}
        </div>
      </div>
    `;

    // Category accordions (when expanded)
    const categoriesHTML = showMapping ? categoryData.map(cat => {
      const expanded = this.expandedDrumCategories[`${ch}_${cat.key}`] || false;
      return `
        <div class="aa-drum-category">
          <button class="aa-drum-category-header ${cat.status}" onclick="autoAssignModalInstance.toggleDrumCategory(${channel}, '${cat.key}')">
            <span>${expanded ? '&#9660;' : '&#9654;'} ${cat.label}</span>
            <span class="aa-drum-cat-count">${cat.mapped}/${cat.total}${cat.modified > 0 ? ` (${cat.modified} sub.)` : ''}</span>
          </button>
          ${expanded ? `
            <div class="aa-drum-category-entries">
              ${cat.entries.map(entry => `
                <div class="aa-drum-mapping-row ${entry.isModified ? 'modified' : 'exact'} ${entry.isOverridden ? 'overridden' : ''}">
                  <span class="aa-drum-note-name">${escapeHtml(entry.srcName)} <small>(${entry.srcNote})</small></span>
                  <span class="aa-drum-arrow">${entry.isModified ? '&#8594;' : '='}</span>
                  <span class="aa-drum-note-name">${escapeHtml(entry.tgtName)} <small>(${entry.tgtNote})</small></span>
                  <span class="aa-drum-mapping-actions">
                    <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustDrumNote(${channel}, ${entry.srcNote}, -1)" title="-1">-</button>
                    <button class="aa-btn-sm" onclick="autoAssignModalInstance.adjustDrumNote(${channel}, ${entry.srcNote}, 1)" title="+1">+</button>
                    ${entry.isOverridden ? `<button class="aa-btn-sm aa-btn-reset" onclick="autoAssignModalInstance.resetDrumNote(${channel}, ${entry.srcNote})">${_t('autoAssign.reset')}</button>` : ''}
                  </span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('') : '';

    // Drum strategy selector
    const drumStrategy = this.adaptationSettings[ch]?.drumStrategy || 'intelligent';
    const drumStrategyHTML = showMapping ? `
      <div class="aa-drum-strategy">
        <label class="aa-strategy-title">${_t('autoAssign.drumAdaptStrategy')}:</label>
        <div class="aa-drum-strategy-options">
          <label class="${drumStrategy === 'intelligent' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="intelligent"
                   ${drumStrategy === 'intelligent' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'intelligent')">
            ${_t('autoAssign.drumStrategyIntelligent')}
          </label>
          <label class="${drumStrategy === 'direct' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="direct"
                   ${drumStrategy === 'direct' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'direct')">
            ${_t('autoAssign.drumStrategyDirect')}
          </label>
          <label class="${drumStrategy === 'manual' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="manual"
                   ${drumStrategy === 'manual' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'manual')">
            ${_t('autoAssign.drumStrategyManual')}
          </label>
        </div>
      </div>
    ` : '';

    const totalModified = mappingEntries.filter(e => e.isModified).length;

    return `
      <div class="aa-drum-mapping-section">
        <button class="aa-toggle-drum-mapping" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
          ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          ${totalModified > 0
            ? `<span class="aa-drum-mapping-count">${totalModified} ${_t('autoAssign.substitutions')}</span>`
            : ''}
        </button>
        ${summaryHTML}
        ${categoriesHTML}
        ${drumStrategyHTML}
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
   * Select an instrument for a channel
   */
  selectInstrument(channel, deviceId) {
    const ch = String(channel);
    const options = this.suggestions[ch] || [];
    const lowOptions = this.lowScoreSuggestions[ch] || [];
    const selectedOption = options.find(opt => opt.instrument.device_id === deviceId)
      || lowOptions.find(opt => opt.instrument.device_id === deviceId);

    if (!selectedOption) return;

    const existingAnalysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch] || null;

    this.selectedAssignments[ch] = {
      deviceId: deviceId,
      instrumentId: selectedOption.instrument.id,
      instrumentName: selectedOption.instrument.name,
      customName: selectedOption.instrument.custom_name,
      gmProgram: selectedOption.instrument.gm_program,
      noteRangeMin: selectedOption.instrument.note_range_min,
      noteRangeMax: selectedOption.instrument.note_range_max,
      noteSelectionMode: selectedOption.instrument.note_selection_mode,
      selectedNotes: selectedOption.instrument.selected_notes,
      score: selectedOption.compatibility.score,
      transposition: selectedOption.compatibility.transposition,
      noteRemapping: selectedOption.compatibility.noteRemapping,
      octaveWrapping: selectedOption.compatibility.octaveWrapping,
      octaveWrappingEnabled: selectedOption.compatibility.octaveWrappingEnabled || false,
      octaveWrappingInfo: selectedOption.compatibility.octaveWrappingInfo,
      issues: selectedOption.compatibility.issues,
      info: selectedOption.compatibility.info,
      channelAnalysis: existingAnalysis
    };

    // Update adaptation settings with new transposition
    this.adaptationSettings[ch] = {
      ...this.adaptationSettings[ch],
      transpositionSemitones: selectedOption.compatibility.transposition?.semitones || 0,
      octaveWrappingEnabled: selectedOption.compatibility.octaveWrappingEnabled || false,
      strategy: selectedOption.compatibility.octaveWrappingEnabled
        ? 'octaveWrap'
        : (selectedOption.compatibility.transposition?.semitones ? 'transpose' : 'ignore')
    };

    this.skippedChannels.delete(channel);
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
    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderTabContent(this.activeTab);
    }
  }

  /**
   * Refresh tab bar (scores, skip states)
   */
  refreshTabBar() {
    if (!this.modal) return;
    const tabs = this.modal.querySelectorAll('.aa-tab');
    tabs.forEach(tab => {
      const ch = parseInt(tab.dataset.channel);
      const isSkipped = this.skippedChannels.has(ch);
      const assignment = this.selectedAssignments[String(ch)];
      const score = assignment?.score || 0;

      tab.classList.toggle('skipped', isSkipped);

      const statusEl = tab.querySelector('.aa-tab-status');
      if (statusEl) {
        if (isSkipped) {
          statusEl.textContent = '—';
          statusEl.className = 'aa-tab-status skipped';
          statusEl.style.color = '';
        } else {
          statusEl.textContent = score;
          statusEl.className = 'aa-tab-status';
          statusEl.style.color = this.getScoreColor(score);
        }
      }
    });

    // Update channel count in header
    const activeCount = this.channels.length - this.skippedChannels.size;
    const countEl = this.modal.querySelector('.aa-channel-count');
    if (countEl) {
      countEl.textContent = _t('autoAssign.channelsWillBeAssigned', {active: activeCount, total: this.channels.length});
    }
  }

  // ========================================================================
  // APPLY & VALIDATE
  // ========================================================================

  /**
   * Validate all channels and apply: create adapted file, close modals, open editor
   */
  async validateAndApply() {
    // Filter out skipped channels
    const activeAssignments = {};
    for (const [channel, assignment] of Object.entries(this.selectedAssignments)) {
      if (!this.skippedChannels.has(parseInt(channel))) {
        activeAssignments[channel] = assignment;
      }
    }

    if (Object.keys(activeAssignments).length === 0) {
      alert(_t('autoAssign.noAssignments'));
      return;
    }

    // Show applying state
    if (this.modal) {
      const footer = this.modal.querySelector('.modal-footer');
      if (footer) {
        footer.innerHTML = `
          <div style="width: 100%; text-align: center;">
            <div class="spinner" style="display: inline-block;"></div>
            <p style="margin-top: 10px;">${_t('autoAssign.applying')}</p>
          </div>
        `;
      }
    }

    try {
      // Prepare assignments with user overrides
      const preparedAssignments = {};
      for (const [channel, assignment] of Object.entries(activeAssignments)) {
        preparedAssignments[channel] = { ...assignment };

        const adaptation = this.adaptationSettings[channel] || {};
        const strategy = adaptation.strategy || 'ignore';

        // Apply strategy-specific settings
        if (strategy === 'transpose') {
          // Override transposition with user's value
          preparedAssignments[channel].transposition = {
            ...(assignment.transposition || {}),
            semitones: adaptation.transpositionSemitones || 0
          };
        } else if (strategy === 'octaveWrap') {
          // Apply transposition + octave wrapping
          preparedAssignments[channel].transposition = {
            ...(assignment.transposition || {}),
            semitones: adaptation.transpositionSemitones || 0
          };
          if (assignment.octaveWrapping) {
            const baseRemapping = assignment.noteRemapping || {};
            preparedAssignments[channel].noteRemapping = {
              ...baseRemapping,
              ...assignment.octaveWrapping
            };
          }
        } else if (strategy === 'suppress') {
          // Transpose + suppress out-of-range notes
          preparedAssignments[channel].transposition = {
            ...(assignment.transposition || {}),
            semitones: adaptation.transpositionSemitones || 0
          };
          // Only enable suppress if the instrument has a defined range
          if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
            preparedAssignments[channel].suppressOutOfRange = true;
            preparedAssignments[channel].noteRangeMin = assignment.noteRangeMin;
            preparedAssignments[channel].noteRangeMax = assignment.noteRangeMax;
          }
        }
        // 'ignore' strategy: no transposition modifications

        // Add note offset for drums
        if (adaptation.noteOffset && adaptation.noteOffset !== 0) {
          preparedAssignments[channel].noteOffset = adaptation.noteOffset;
        }

        // Apply drum strategy filtering
        const drumStrategy = adaptation.drumStrategy || 'intelligent';
        if (drumStrategy !== 'intelligent') {
          const currentRemapping = preparedAssignments[channel].noteRemapping || {};
          if (drumStrategy === 'direct') {
            // Keep only 1:1 mappings (src === tgt)
            const filtered = {};
            for (const [src, tgt] of Object.entries(currentRemapping)) {
              if (parseInt(src) === tgt) filtered[src] = tgt;
            }
            preparedAssignments[channel].noteRemapping = filtered;
          } else if (drumStrategy === 'manual') {
            // Only use manual overrides, discard auto-mapping
            preparedAssignments[channel].noteRemapping = {};
          }
        }

        // Apply drum mapping overrides (manual adjustments always applied on top)
        const drumOverrides = this.drumMappingOverrides[channel] || {};
        if (Object.keys(drumOverrides).length > 0) {
          const baseRemapping = preparedAssignments[channel].noteRemapping || {};
          preparedAssignments[channel].noteRemapping = { ...baseRemapping, ...drumOverrides };
        }
      }

      // Apply assignments and create adapted file
      const response = await this.apiClient.sendCommand('apply_assignments', {
        originalFileId: this.fileId,
        assignments: preparedAssignments,
        createAdaptedFile: true
      });

      if (!response.success) {
        alert(_t('autoAssign.applyFailed') + ': ' + (response.error || ''));
        this.showTabbedUI(); // Re-show the UI
        return;
      }

      // Close this auto-assign modal
      this.close();

      if (response.adaptedFileId) {
        // Adapted file was created (transpositions were applied)
        // Close the current editor and open the adapted file
        if (this.editorRef && typeof this.editorRef.doClose === 'function') {
          this.editorRef.doClose();
        }

        if (window.MidiEditorModal) {
          const newEditor = new window.MidiEditorModal(null, this.apiClient);
          newEditor.show(response.adaptedFileId, response.filename || null);
        }
      } else {
        // No adapted file needed (no transposition required)
        // Routings were saved against the original file
        // Apply routings to the current MidiPlayer if loaded
        if (this.editorRef) {
          // Notify the editor that routings were applied
          if (typeof this.editorRef.showNotification === 'function') {
            const skippedMsg = this.skippedChannels.size > 0
              ? ` (${this.skippedChannels.size} ${_t('autoAssign.channelsSkipped')})`
              : '';
            this.editorRef.showNotification(
              _t('autoAssign.routingsSaved') + skippedMsg,
              'success'
            );
          }
        }

        // Refresh file list in case routing status changed
        if (window.midiFileManager) {
          window.midiFileManager.refreshFileList();
        }
      }

    } catch (error) {
      alert(_t('autoAssign.applyFailed') + ': ' + error.message);
      this.showTabbedUI(); // Re-show the UI
    }
  }

  /**
   * Quick assign: apply auto-selection immediately
   */
  async quickAssign() {
    if (!confirm(_t('autoAssign.quickAssignConfirm'))) return;
    this.skippedChannels.clear();
    await this.validateAndApply();
  }

  // ========================================================================
  // PREVIEW
  // ========================================================================

  async previewChannel(channel) {
    if (!this.audioPreview || !this.midiData) {
      alert(_t('autoAssign.previewNotAvailable'));
      return;
    }

    // Prevent concurrent previews
    if (this._previewInProgress) return;
    this._previewInProgress = true;

    try {
      this.stopPreview();
      const ch = String(channel);
      const assignment = this.selectedAssignments[ch];
      const adaptation = this.adaptationSettings[ch] || {};

      // Build transposition for this channel
      const transposition = {};
      const instrumentConstraints = {};

      if (assignment) {
        const strategy = adaptation.strategy || 'ignore';
        let noteRemapping = assignment.noteRemapping || {};

        // Mirror strategy logic from validateAndApply
        if (strategy === 'transpose') {
          transposition.semitones = adaptation.transpositionSemitones || 0;
        } else if (strategy === 'octaveWrap') {
          transposition.semitones = adaptation.transpositionSemitones || 0;
          if (assignment.octaveWrapping) {
            noteRemapping = { ...noteRemapping, ...assignment.octaveWrapping };
          }
        } else if (strategy === 'suppress') {
          transposition.semitones = adaptation.transpositionSemitones || 0;
          if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
            instrumentConstraints.suppressOutOfRange = true;
          }
        }
        // 'ignore': no transposition, just base remapping

        transposition.noteRemapping = Object.keys(noteRemapping).length > 0 ? noteRemapping : null;

        // Instrument sound
        if (assignment.gmProgram != null) {
          instrumentConstraints.gmProgram = assignment.gmProgram;
        }

        // Instrument playable note range
        instrumentConstraints.noteRangeMin = assignment.noteRangeMin;
        instrumentConstraints.noteRangeMax = assignment.noteRangeMax;
        instrumentConstraints.noteSelectionMode = assignment.noteSelectionMode;
        instrumentConstraints.selectedNotes = assignment.selectedNotes;
      }

      // Preview only this channel with instrument constraints
      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, transposition, instrumentConstraints, 0, 15
      );
      this.showStopButton();
    } catch (error) {
      console.error('Preview error:', error);
      alert(_t('autoAssign.previewFailed') + ': ' + error.message);
    } finally {
      this._previewInProgress = false;
    }
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
      parts.push(`GM ${instrument.gm_program}`);
    }
    if (compat.transposition && compat.transposition.octaves !== 0) {
      const direction = compat.transposition.octaves > 0 ? 'up' : 'down';
      parts.push(`${Math.abs(compat.transposition.octaves)} ${_t('common.octave')}(s) ${direction}`);
    } else {
      parts.push(_t('autoAssign.noTransposition'));
    }
    if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
      parts.push(`${_t('autoAssign.range')}: ${instrument.note_range_min}-${instrument.note_range_max}`);
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
   * Close the modal
   */
  close() {
    this.stopPreview();

    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
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
window.AutoAssignModal = AutoAssignModal;
})();
