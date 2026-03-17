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

      // Generate suggestions
      const response = await this.apiClient.sendCommand('generate_assignment_suggestions', {
        fileId: fileId,
        topN: 5,
        minScore: 30
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

      // Initialize adaptation settings per channel
      this.channels = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));
      for (const ch of this.channels) {
        const assignment = this.selectedAssignments[ch];
        this.adaptationSettings[ch] = {
          transpositionSemitones: assignment?.transposition?.semitones || 0,
          octaveWrappingEnabled: assignment?.octaveWrappingEnabled || false,
          noteOffset: 0
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
   * Render adaptation controls for a channel
   */
  renderAdaptationControls(channel, adaptation) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const semitones = adaptation.transpositionSemitones || 0;
    const hasOctaveWrapping = assignment && assignment.octaveWrappingInfo;

    // Visual note range indicator
    const analysis = assignment?.channelAnalysis || this.channelAnalyses[channel];
    const noteRangeViz = this.renderNoteRangeViz(channel, analysis, assignment, semitones);

    return `
      <div class="aa-adaptation-section">
        <h4>${_t('autoAssign.adaptationTitle')}</h4>

        ${noteRangeViz}

        <div class="aa-adaptation-controls">
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

          ${hasOctaveWrapping ? `
            <div class="aa-control-group">
              <label>
                <input type="checkbox"
                       id="octaveWrapping_${channel}"
                       ${adaptation.octaveWrappingEnabled ? 'checked' : ''}
                       onchange="autoAssignModalInstance.toggleOctaveWrapping(${channel}, this.checked)">
                ${_t('autoAssign.enableOctaveWrapping')}
              </label>
              <div class="aa-control-hint">${escapeHtml(assignment.octaveWrappingInfo)}</div>
            </div>
          ` : ''}

          ${channel === 9 ? `
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
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render visual note range comparison: channel notes vs instrument range
   */
  renderNoteRangeViz(channel, analysis, assignment, semitones) {
    if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';

    // Find the selected instrument from suggestions
    const ch = String(channel);
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.device_id === assignment?.deviceId);
    if (!selectedOption) return '';

    const inst = selectedOption.instrument;
    if (inst.note_range_min == null || inst.note_range_max == null) return '';

    // Calculate transposed channel range
    const chMin = analysis.noteRange.min + semitones;
    const chMax = analysis.noteRange.max + semitones;
    const instMin = inst.note_range_min;
    const instMax = inst.note_range_max;

    // Global range for visualization (with padding)
    const globalMin = Math.max(0, Math.min(chMin, instMin) - 3);
    const globalMax = Math.min(127, Math.max(chMax, instMax) + 3);
    const totalRange = globalMax - globalMin || 1;

    // Calculate positions as percentages
    const chLeft = ((chMin - globalMin) / totalRange) * 100;
    const chWidth = Math.max(1, ((chMax - chMin) / totalRange) * 100);
    const instLeft = ((instMin - globalMin) / totalRange) * 100;
    const instWidth = Math.max(1, ((instMax - instMin) / totalRange) * 100);

    // Check if notes fit
    const notesOutside = chMin < instMin || chMax > instMax;
    const fitClass = notesOutside ? 'out-of-range' : 'in-range';

    return `
      <div class="aa-note-range-viz">
        <div class="aa-note-range-labels">
          <span>${_t('autoAssign.channelNotes')}: ${chMin}-${chMax}</span>
          <span>${_t('autoAssign.instrumentRange')}: ${instMin}-${instMax}</span>
        </div>
        <div class="aa-note-range-track">
          <div class="aa-note-range-inst" style="left: ${instLeft}%; width: ${instWidth}%"
               title="${_t('autoAssign.instrumentRange')}: ${instMin}-${instMax}"></div>
          <div class="aa-note-range-ch ${fitClass}" style="left: ${chLeft}%; width: ${chWidth}%"
               title="${_t('autoAssign.channelNotes')}: ${chMin}-${chMax}"></div>
        </div>
        <div class="aa-note-range-scale">
          <span>${globalMin}</span>
          <span>${globalMax}</span>
        </div>
      </div>
    `;
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
   * Render the drum mapping configuration section
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
      55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 59: 'Ride Cymbal 2'
    };

    // Get overrides for this channel
    const overrides = this.drumMappingOverrides[ch] || {};

    // Build mapping table from noteRemapping
    const mappingEntries = Object.entries(noteRemapping).map(([src, tgt]) => {
      const srcNote = parseInt(src);
      const tgtNote = overrides[srcNote] !== undefined ? overrides[srcNote] : tgt;
      const srcName = drumNames[srcNote] || `Note ${srcNote}`;
      const tgtName = drumNames[tgtNote] || `Note ${tgtNote}`;
      const isModified = srcNote !== tgtNote;
      const isOverridden = overrides[srcNote] !== undefined;
      return { srcNote, tgtNote, srcName, tgtName, isModified, isOverridden };
    }).sort((a, b) => a.srcNote - b.srcNote);

    if (mappingEntries.length === 0 && Object.keys(overrides).length === 0) {
      return `
        <div class="aa-drum-mapping-section">
          <button class="aa-toggle-drum-mapping" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
            ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          </button>
          ${showMapping ? `<p class="aa-no-compatible">${_t('autoAssign.noDrumMapping')}</p>` : ''}
        </div>
      `;
    }

    const mappingHTML = showMapping ? `
      <div class="aa-drum-mapping-table">
        <div class="aa-drum-mapping-header">
          <span>${_t('autoAssign.originalNote')}</span>
          <span></span>
          <span>${_t('autoAssign.mappedTo')}</span>
          <span></span>
        </div>
        ${mappingEntries.map(entry => `
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
    ` : '';

    return `
      <div class="aa-drum-mapping-section">
        <button class="aa-toggle-drum-mapping" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
          ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          ${mappingEntries.filter(e => e.isModified).length > 0
            ? `<span class="aa-drum-mapping-count">${mappingEntries.filter(e => e.isModified).length} ${_t('autoAssign.substitutions')}</span>`
            : ''}
        </button>
        ${mappingHTML}
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
    if (enabled) {
      this.skippedChannels.delete(channel);
      if (!this.selectedAssignments[channel] && this.autoSelection[channel]) {
        this.selectedAssignments[channel] = JSON.parse(JSON.stringify(this.autoSelection[channel]));
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
      octaveWrappingEnabled: selectedOption.compatibility.octaveWrappingEnabled || false
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

        // Override transposition with user's value
        if (adaptation.transpositionSemitones !== undefined) {
          preparedAssignments[channel].transposition = {
            ...(assignment.transposition || {}),
            semitones: adaptation.transpositionSemitones
          };
        }

        // Add note offset for drums
        if (adaptation.noteOffset && adaptation.noteOffset !== 0) {
          preparedAssignments[channel].noteOffset = adaptation.noteOffset;
        }

        // Apply drum mapping overrides
        const drumOverrides = this.drumMappingOverrides[channel] || {};
        if (Object.keys(drumOverrides).length > 0) {
          const baseRemapping = preparedAssignments[channel].noteRemapping || {};
          preparedAssignments[channel].noteRemapping = { ...baseRemapping, ...drumOverrides };
        }

        // Combine noteRemapping with octaveWrapping if enabled
        if (adaptation.octaveWrappingEnabled && assignment.octaveWrapping) {
          const baseRemapping = assignment.noteRemapping || {};
          preparedAssignments[channel].noteRemapping = {
            ...baseRemapping,
            ...assignment.octaveWrapping
          };
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

      // Close the current editor modal if it exists
      if (this.editorRef && typeof this.editorRef.doClose === 'function') {
        this.editorRef.doClose();
      }

      // Open the adapted file in a new editor
      if (response.adaptedFileId && window.MidiEditorModal) {
        const newEditor = new window.MidiEditorModal(null, this.apiClient);
        newEditor.show(response.adaptedFileId, response.filename || null);
      } else if (response.filename) {
        // Fallback: refresh file list so user can open it
        if (window.midiFileManager) {
          window.midiFileManager.refreshFileList();
        }
        const skippedMsg = this.skippedChannels.size > 0
          ? `\n${this.skippedChannels.size} ${_t('autoAssign.channelsSkipped')}`
          : '';
        const notesChanged = response.stats?.notesChanged || 0;
        alert(`${_t('autoAssign.applySuccess')}\n\n${response.filename}\n${notesChanged} ${_t('autoAssign.notesTransposed')}${skippedMsg}`);
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
      const transpositions = {};
      const instrumentPrograms = {};

      if (assignment) {
        let noteRemapping = assignment.noteRemapping || {};
        if (adaptation.octaveWrappingEnabled && assignment.octaveWrapping) {
          noteRemapping = { ...noteRemapping, ...assignment.octaveWrapping };
        }

        transpositions[channel] = {
          semitones: adaptation.transpositionSemitones || 0,
          noteRemapping: Object.keys(noteRemapping).length > 0 ? noteRemapping : null
        };

        // Use the selected instrument's GM program for preview
        if (assignment.gmProgram !== null && assignment.gmProgram !== undefined) {
          instrumentPrograms[channel] = assignment.gmProgram;
        }
      }

      await this.audioPreview.previewAdapted(this.midiData, transpositions, 0, 15, instrumentPrograms);
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
