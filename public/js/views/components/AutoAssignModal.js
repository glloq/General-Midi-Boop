// public/js/views/components/AutoAssignModal.js

const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

/**
 * AutoAssignModal - Modal for auto-assigning MIDI channels to instruments
 *
 * Displays suggestions for each channel with compatibility scores
 * and allows the user to select, modify, or skip the instrument for each channel.
 */
class AutoAssignModal {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.fileId = null;
    this.midiData = null; // Store MIDI data for preview
    this.suggestions = {};
    this.autoSelection = {};
    this.channelAnalyses = {}; // Store analyses indexed by channel
    this.selectedAssignments = {}; // User's selections
    this.skippedChannels = new Set(); // Channels user chose to skip
    this.modal = null;
    this.audioPreview = null; // Audio preview instance
    this._escHandler = null;
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
   * @param {number} fileId - MIDI file ID
   */
  async show(fileId) {
    this.fileId = fileId;

    // Show loading modal
    this.showLoading();

    try {
      // Step 1: Validate instrument capabilities
      const validationResponse = await this.apiClient.sendCommand('validate_instrument_capabilities', {});

      if (validationResponse && validationResponse.incompleteInstruments && validationResponse.incompleteInstruments.length > 0) {
        if (!window.InstrumentCapabilitiesModal) {
          console.error('InstrumentCapabilitiesModal not loaded');
          throw new Error(_t('autoAssign.capabilitiesModalNotAvailable') || 'Le module de capacités instruments n\'est pas disponible');
        }

        // Some instruments have incomplete capabilities
        // Close loading modal
        if (this.modal) {
          this.modal.remove();
          this.modal = null;
        }

        // Show capabilities modal
        const capabilitiesModal = new window.InstrumentCapabilitiesModal(this.apiClient);

        await new Promise((resolve) => {
          capabilitiesModal.show(validationResponse.incompleteInstruments, (updates) => {
            console.log('Capabilities updated:', updates);
            resolve();
          });
        });

        // Re-show loading after capabilities completion
        this.showLoading();
      }

      // Step 2: Get MIDI file data for preview
      const fileResponse = await this.apiClient.sendCommand('file_read', { fileId: fileId });
      if (fileResponse && fileResponse.midiData) {
        this.midiData = fileResponse.midiData;
      }

      // Step 3: Generate suggestions
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
      this.autoSelection = response.autoSelection;
      this.confidenceScore = response.confidenceScore;

      // Store channel analyses indexed by channel number for easy lookup
      if (response.channelAnalyses) {
        for (const analysis of response.channelAnalyses) {
          this.channelAnalyses[analysis.channel] = analysis;
        }
      }

      // Initialize selected assignments with auto-selection
      this.selectedAssignments = JSON.parse(JSON.stringify(this.autoSelection));
      this.skippedChannels = new Set();

      // Initialize audio preview
      if (!this.audioPreview && window.AudioPreview) {
        this.audioPreview = new window.AudioPreview(this.apiClient);
      }

      // Show suggestions modal
      this.showSuggestions();
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
    if (this.modal) {
      this.modal.remove();
    }

    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container" style="max-width: 600px;">
          <div class="modal-header">
            <h2>${_t('autoAssign.error')}</h2>
            <button class="modal-close" onclick="document.getElementById('autoAssignModal').remove()">x</button>
          </div>
          <div class="modal-body" style="padding: 32px; text-align: center;">
            <p style="color: #ff4444; font-size: 16px;">${escapeHtml(message)}</p>
            <button class="button button-secondary" onclick="document.getElementById('autoAssignModal').remove()" style="margin-top: 16px;">
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
   * Show suggestions interface
   */
  showSuggestions() {
    if (this.modal) {
      this.modal.remove();
    }
    // Clean up previous ESC handler
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
    }

    const channels = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));

    if (channels.length === 0) {
      this.showError(_t('autoAssign.noActiveChannels'));
      return;
    }

    const channelsHTML = channels.map(channel => this.renderChannelSuggestions(parseInt(channel))).join('');

    const activeCount = channels.length - this.skippedChannels.size;

    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container" style="max-width: 900px; max-height: 90vh; overflow-y: auto;">
          <div class="modal-header">
            <h2>${_t('autoAssign.title')}</h2>
            <button class="modal-close" onclick="autoAssignModalInstance.close()">x</button>
          </div>
          <div class="modal-body" style="padding: 0;">
            <div style="padding: 16px; background: #f5f5f5; border-bottom: 1px solid #ddd;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <div>
                  <strong>${_t('autoAssign.confidenceScore')}:</strong>
                  <span style="font-size: 18px; font-weight: bold; color: ${this.getScoreColor(this.confidenceScore)};">
                    ${this.confidenceScore}/100
                  </span>
                  ${this.getScoreStars(this.confidenceScore)}
                </div>
                <div style="color: #666; font-size: 13px;">
                  ${_t('autoAssign.channelsWillBeAssigned', {active: activeCount, total: channels.length})}
                  ${this.skippedChannels.size > 0 ? ` (${_t('autoAssign.skippedCount', {count: this.skippedChannels.size})})` : ''}
                </div>
              </div>
              <div style="margin-top: 8px; font-size: 12px; color: #888;">
                ${_t('autoAssign.instructions')}
              </div>
            </div>

            <div style="padding: 16px;">
              ${channelsHTML}
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; padding: 16px; border-top: 1px solid #ddd;">
            <button class="button button-secondary" onclick="autoAssignModalInstance.close()">
              ${_t('common.cancel')}
            </button>
            <div id="previewControls" style="display: flex; gap: 8px; align-items: center;">
              ${this.midiData ? `
                <button class="button button-secondary" onclick="autoAssignModalInstance.previewOriginal()" title="${_t('autoAssign.previewOriginalTip')}">
                  ${_t('autoAssign.previewOriginal')}
                </button>
                <button class="button button-secondary" onclick="autoAssignModalInstance.previewAdapted()" title="${_t('autoAssign.previewAdaptedTip')}">
                  ${_t('autoAssign.previewAdapted')}
                </button>
                <button class="button button-secondary" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                  ${_t('autoAssign.stop')}
                </button>
              ` : ''}
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="button button-info" onclick="autoAssignModalInstance.quickAssign()" title="${_t('autoAssign.quickAssignTip')}">
                ${_t('autoAssign.quickAssign')}
              </button>
              <button class="button button-primary" onclick="autoAssignModalInstance.apply()">
                ${_t('autoAssign.apply')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);
    this.modal = document.getElementById('autoAssignModal');

    // Make instance globally accessible for event handlers
    window.autoAssignModalInstance = this;

    // ESC key handler
    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    // Click overlay to close
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  /**
   * Render channel statistics - uses stored channelAnalyses as fallback
   */
  renderChannelStats(channel) {
    // Try to get analysis from selectedAssignments first, fallback to stored analyses
    const analysis = this.selectedAssignments[channel]?.channelAnalysis || this.channelAnalyses[channel];
    if (!analysis) return '';

    const noteRange = analysis.noteRange || {};
    const polyphony = analysis.polyphony || {};

    return `
      <div style="background: #f0f8ff; padding: 8px 10px; border-radius: 4px; margin-bottom: 8px; font-size: 12px;">
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
          <div>
            <strong>${_t('autoAssign.noteRange')}:</strong><br>
            ${noteRange.min != null ? `${noteRange.min} - ${noteRange.max} (${noteRange.max - noteRange.min} st)` : 'N/A'}
          </div>
          <div>
            <strong>${_t('autoAssign.polyphony')}:</strong><br>
            ${polyphony.max != null ? `Max: ${polyphony.max}${polyphony.avg !== undefined ? ` | Avg: ${polyphony.avg.toFixed(1)}` : ''}` : 'N/A'}
          </div>
          <div>
            <strong>${_t('autoAssign.type')}:</strong><br>
            ${escapeHtml(analysis.estimatedType)} ${analysis.typeConfidence ? `(${analysis.typeConfidence}%)` : ''}
          </div>
        </div>
        ${noteRange.min != null ? this.renderMiniPiano(noteRange) : ''}
      </div>
    `;
  }

  /**
   * Render mini piano visualization
   */
  renderMiniPiano(noteRange) {
    return `
      <div style="margin-top: 6px;">
        <div style="display: flex; align-items: center; gap: 4px; font-size: 10px;">
          <span>${_t('autoAssign.range')}:</span>
          <div style="flex: 1; height: 16px; background: linear-gradient(to right, #ddd, #4CAF50, #ddd); border-radius: 3px; position: relative;">
            <div style="position: absolute; left: 10%; width: 80%; height: 100%; background: #4CAF50; opacity: 0.5; border-radius: 3px;"></div>
          </div>
          <span>${noteRange.min} - ${noteRange.max}</span>
        </div>
      </div>
    `;
  }

  /**
   * Render suggestions for a single channel
   */
  renderChannelSuggestions(channel) {
    const options = this.suggestions[channel] || [];
    const isSkipped = this.skippedChannels.has(channel);
    const selectedDeviceId = this.selectedAssignments[channel]?.deviceId;

    if (options.length === 0) {
      return `
        <div class="channel-suggestions" style="margin-bottom: 20px; padding: 16px; background: #fff; border: 1px solid #ddd; border-radius: 8px;">
          <h3 style="margin: 0 0 10px 0; color: #333; font-size: 15px;">
            ${_t('autoAssign.channel', {num: channel + 1})}
            ${channel === 9 ? `<span style="color: #888; font-size: 13px;">(${_t('autoAssign.drums')})</span>` : ''}
          </h3>
          ${this.renderChannelStats(channel)}
          <p style="color: #999; font-size: 13px;">${_t('autoAssign.noCompatible')}</p>
        </div>
      `;
    }

    // Skip/enable toggle for this channel
    const skipToggle = `
      <div style="margin-bottom: 10px; padding: 8px 10px; background: ${isSkipped ? '#fff3f3' : '#f0fff0'}; border: 1px solid ${isSkipped ? '#ffcccc' : '#c8e6c9'}; border-radius: 6px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
          <input type="checkbox"
                 ${isSkipped ? '' : 'checked'}
                 onchange="autoAssignModalInstance.toggleChannel(${channel}, this.checked)"
                 style="cursor: pointer; width: 16px; height: 16px;">
          <span style="font-size: 13px; font-weight: 600; color: ${isSkipped ? '#cc0000' : '#2e7d32'};">
            ${isSkipped ? _t('autoAssign.channelSkipped') : _t('autoAssign.assignChannel')}
          </span>
        </label>
      </div>
    `;

    const optionsHTML = isSkipped ? '' : options.map((option, index) => {
      const instrument = option.instrument;
      const compat = option.compatibility;
      const isSelected = instrument.device_id === selectedDeviceId;
      const escapedName = escapeHtml(instrument.custom_name || instrument.name);
      const escapedDeviceId = escapeHtml(instrument.device_id);

      return `
        <div class="instrument-option ${isSelected ? 'selected' : ''}"
             data-channel="${channel}"
             data-device-id="${escapedDeviceId}"
             onclick="autoAssignModalInstance.selectInstrument(${channel}, this.dataset.deviceId)"
             style="padding: 10px 12px; margin-bottom: 6px; border: 2px solid ${isSelected ? '#4CAF50' : '#ddd'};
                    border-radius: 6px; cursor: pointer; background: ${isSelected ? '#f0fff0' : '#fff'};
                    transition: all 0.2s;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1;">
              <div style="font-weight: bold; font-size: 14px; margin-bottom: 3px;">
                ${escapedName}
              </div>
              <div style="color: #666; font-size: 12px; margin-bottom: 4px;">
                ${this.formatInstrumentInfo(instrument, compat)}
              </div>
              ${compat.info ? `
                <div style="color: #4CAF50; font-size: 11px;">
                  ${this.formatInfo(compat.info)}
                </div>
              ` : ''}
              ${compat.issues && compat.issues.length > 0 ? `
                <div style="color: #ff9800; font-size: 11px; margin-top: 2px;">
                  ${compat.issues.map(i => escapeHtml(i.message)).join(' &bull; ')}
                </div>
              ` : ''}
            </div>
            <div style="text-align: right; margin-left: 12px;">
              <div style="font-size: 20px; font-weight: bold; color: ${this.getScoreColor(compat.score)};">
                ${compat.score}
              </div>
              <div style="font-size: 10px; color: #666;">
                ${this.getScoreStars(compat.score)}
              </div>
              ${index === 0 ? `<div style="font-size: 10px; color: #4CAF50; margin-top: 2px;">${_t('autoAssign.recommended')}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Add octave wrapping toggle if available and channel is not skipped
    const assignment = this.selectedAssignments[channel];
    const octaveWrappingToggle = !isSkipped && assignment && assignment.octaveWrappingInfo ? `
      <div style="margin-top: 10px; padding: 8px; background: #fff9e6; border: 1px solid #ffd700; border-radius: 4px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
          <input type="checkbox"
                 id="octaveWrapping_${channel}"
                 ${assignment.octaveWrappingEnabled ? 'checked' : ''}
                 onchange="autoAssignModalInstance.toggleOctaveWrapping(${channel}, this.checked)"
                 style="cursor: pointer;">
          <span style="font-size: 12px;">
            <strong>${_t('autoAssign.enableOctaveWrapping')}</strong><br>
            <span style="color: #666; font-size: 11px;">${escapeHtml(assignment.octaveWrappingInfo)}</span>
          </span>
        </label>
      </div>
    ` : '';

    // Add preview button for this channel (only if not skipped)
    const previewButton = !isSkipped && this.midiData ? `
      <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #ddd;">
        <button class="button button-secondary"
                onclick="autoAssignModalInstance.previewChannel(${channel})"
                style="font-size: 12px; padding: 6px 10px;">
          ${_t('autoAssign.previewChannel', {num: channel + 1})}
        </button>
      </div>
    ` : '';

    return `
      <div class="channel-suggestions" style="margin-bottom: 20px; padding: 16px; background: #fafafa; border: 1px solid ${isSkipped ? '#e0e0e0' : '#ddd'}; border-radius: 8px; ${isSkipped ? 'opacity: 0.7;' : ''}">
        <h3 style="margin: 0 0 10px 0; color: #333; font-size: 15px;">
          ${_t('autoAssign.channel', {num: channel + 1})}
          ${channel === 9 ? `<span style="color: #888; font-size: 13px;">(MIDI 10 - ${_t('autoAssign.drums')})</span>` : ''}
          ${isSkipped ? `<span style="color: #cc0000; font-size: 13px; margin-left: 8px;">[${_t('autoAssign.skippedLabel')}]</span>` : ''}
        </h3>
        ${this.renderChannelStats(channel)}
        ${skipToggle}
        ${optionsHTML}
        ${octaveWrappingToggle}
        ${previewButton}
      </div>
    `;
  }

  /**
   * Format instrument info line
   */
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

  /**
   * Get color based on score
   */
  getScoreColor(score) {
    if (score >= 80) return '#4CAF50'; // Green
    if (score >= 60) return '#8BC34A'; // Light green
    if (score >= 40) return '#FF9800'; // Orange
    return '#F44336'; // Red
  }

  /**
   * Get star rating based on score
   */
  getScoreStars(score) {
    const filled = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;
    return '<span style="letter-spacing: 2px;">' + '&#9733;'.repeat(filled) + '&#9734;'.repeat(5 - filled) + '</span>';
  }

  /**
   * Toggle a channel on/off (skip or enable assignment)
   */
  toggleChannel(channel, enabled) {
    if (enabled) {
      this.skippedChannels.delete(channel);
      // Restore the auto-selection if no manual selection exists
      if (!this.selectedAssignments[channel] && this.autoSelection[channel]) {
        this.selectedAssignments[channel] = JSON.parse(JSON.stringify(this.autoSelection[channel]));
      }
    } else {
      this.skippedChannels.add(channel);
    }
    // Re-render
    this.showSuggestions();
  }

  /**
   * Select an instrument for a channel
   */
  selectInstrument(channel, deviceId) {
    // Find the selected option
    const options = this.suggestions[channel] || [];
    const selectedOption = options.find(opt => opt.instrument.device_id === deviceId);

    if (!selectedOption) {
      console.error(`Instrument not found: ${deviceId}`);
      return;
    }

    // Preserve channelAnalysis from existing assignment or from stored analyses
    const existingAnalysis = this.selectedAssignments[channel]?.channelAnalysis || this.channelAnalyses[channel] || null;

    // Update selected assignments
    this.selectedAssignments[channel] = {
      deviceId: deviceId,
      instrumentId: selectedOption.instrument.id,
      instrumentName: selectedOption.instrument.name,
      customName: selectedOption.instrument.custom_name,
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

    // Ensure channel is not skipped when user selects an instrument
    this.skippedChannels.delete(channel);

    // Re-render suggestions to update selection
    this.showSuggestions();
  }

  /**
   * Toggle octave wrapping for a channel
   */
  toggleOctaveWrapping(channel, enabled) {
    if (this.selectedAssignments[channel]) {
      this.selectedAssignments[channel].octaveWrappingEnabled = enabled;
      console.log(`Octave wrapping for channel ${channel}: ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Apply the selected assignments (only non-skipped channels)
   */
  async apply() {
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
      footer.innerHTML = `
        <div style="width: 100%; text-align: center;">
          <div class="spinner" style="display: inline-block;"></div>
          <p style="margin-top: 10px;">${_t('autoAssign.applying')}</p>
        </div>
      `;
    }

    try {
      // Prepare assignments with octave wrapping if enabled
      const preparedAssignments = {};
      for (const [channel, assignment] of Object.entries(activeAssignments)) {
        preparedAssignments[channel] = { ...assignment };

        // Combine noteRemapping with octaveWrapping if enabled
        if (assignment.octaveWrappingEnabled && assignment.octaveWrapping) {
          const baseRemapping = assignment.noteRemapping || {};
          preparedAssignments[channel].noteRemapping = {
            ...baseRemapping,
            ...assignment.octaveWrapping
          };
        }
      }

      // Apply assignments
      const response = await this.apiClient.sendCommand('apply_assignments', {
        originalFileId: this.fileId,
        assignments: preparedAssignments,
        createAdaptedFile: true
      });

      if (!response.success) {
        alert(_t('autoAssign.applyFailed') + ': ' + (response.error || ''));
        this.close();
        return;
      }

      // Success!
      const skippedMsg = this.skippedChannels.size > 0
        ? `\n${this.skippedChannels.size} ${_t('autoAssign.channelsSkipped')}`
        : '';
      const notesChanged = response.stats?.notesChanged || 0;
      alert(`${_t('autoAssign.applySuccess')}\n\n${response.filename}\n${notesChanged} ${_t('autoAssign.notesTransposed')}${skippedMsg}`);

      this.close();

      // Reload file list or notify parent
      if (window.midiFileManager) {
        window.midiFileManager.refreshFileList();
      }

      // Dispatch event for other components
      window.dispatchEvent(new CustomEvent('auto-assignment-applied', {
        detail: {
          adaptedFileId: response.adaptedFileId,
          filename: response.filename,
          routings: response.routings
        }
      }));
    } catch (error) {
      alert(_t('autoAssign.applyFailed') + ': ' + error.message);
      this.close();
    }
  }

  /**
   * Quick assign: apply auto-selection immediately without manual review
   */
  async quickAssign() {
    if (!confirm(_t('autoAssign.quickAssignConfirm'))) {
      return;
    }

    // Reset skipped channels for quick assign
    this.skippedChannels.clear();
    // Use auto-selection (already set in this.selectedAssignments)
    await this.apply();
  }

  /**
   * Preview a specific channel with selected transposition
   */
  async previewChannel(channel) {
    if (!this.audioPreview || !this.midiData) {
      alert(_t('autoAssign.previewNotAvailable'));
      return;
    }

    try {
      // Stop any existing playback
      this.stopPreview();

      // Get transposition for this channel
      const assignment = this.selectedAssignments[channel];
      const transpositions = {};

      if (assignment && assignment.transposition) {
        // Combine noteRemapping with octaveWrapping if enabled
        let noteRemapping = assignment.noteRemapping || {};

        if (assignment.octaveWrappingEnabled && assignment.octaveWrapping) {
          noteRemapping = { ...noteRemapping, ...assignment.octaveWrapping };
        }

        transpositions[channel] = {
          semitones: assignment.transposition.semitones || 0,
          noteRemapping: Object.keys(noteRemapping).length > 0 ? noteRemapping : null
        };
      }

      // Preview 15 seconds starting from beginning
      await this.audioPreview.previewAdapted(this.midiData, transpositions, 0, 15);

      // Show stop button
      this.showStopButton();
    } catch (error) {
      console.error('Preview error:', error);
      alert(_t('autoAssign.previewFailed') + ': ' + error.message);
    }
  }

  /**
   * Preview original MIDI file (no transpositions)
   */
  async previewOriginal() {
    if (!this.audioPreview || !this.midiData) {
      alert(_t('autoAssign.previewNotAvailable'));
      return;
    }

    try {
      // Stop any existing playback
      this.stopPreview();

      // Preview 15 seconds of original
      await this.audioPreview.previewOriginal(this.midiData, 0, 15);

      // Show stop button
      this.showStopButton();
    } catch (error) {
      console.error('Preview error:', error);
      alert(_t('autoAssign.previewFailed') + ': ' + error.message);
    }
  }

  /**
   * Preview adapted MIDI with all transpositions
   */
  async previewAdapted() {
    if (!this.audioPreview || !this.midiData) {
      alert(_t('autoAssign.previewNotAvailable'));
      return;
    }

    try {
      // Stop any existing playback
      this.stopPreview();

      // Build transpositions object from all selected assignments (excluding skipped)
      const transpositions = {};

      for (const [channel, assignment] of Object.entries(this.selectedAssignments)) {
        const channelNum = parseInt(channel);
        if (this.skippedChannels.has(channelNum)) continue;

        if (assignment && assignment.transposition) {
          // Combine noteRemapping with octaveWrapping if enabled
          let noteRemapping = assignment.noteRemapping || {};

          if (assignment.octaveWrappingEnabled && assignment.octaveWrapping) {
            noteRemapping = { ...noteRemapping, ...assignment.octaveWrapping };
          }

          transpositions[channelNum] = {
            semitones: assignment.transposition.semitones || 0,
            noteRemapping: Object.keys(noteRemapping).length > 0 ? noteRemapping : null
          };
        }
      }

      // Preview 15 seconds with all transpositions
      await this.audioPreview.previewAdapted(this.midiData, transpositions, 0, 15);

      // Show stop button
      this.showStopButton();
    } catch (error) {
      console.error('Preview error:', error);
      alert(_t('autoAssign.previewFailed') + ': ' + error.message);
    }
  }

  /**
   * Stop audio preview
   */
  stopPreview() {
    if (this.audioPreview) {
      this.audioPreview.stop();
    }
    this.hideStopButton();
  }

  /**
   * Show stop button in preview controls
   */
  showStopButton() {
    const stopBtn = document.getElementById('stopPreviewBtn');
    if (stopBtn) {
      stopBtn.style.display = 'inline-block';
    }
  }

  /**
   * Hide stop button in preview controls
   */
  hideStopButton() {
    const stopBtn = document.getElementById('stopPreviewBtn');
    if (stopBtn) {
      stopBtn.style.display = 'none';
    }
  }

  /**
   * Close the modal
   */
  close() {
    // Stop any audio preview
    this.stopPreview();

    // Clean up ESC handler
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }

    // Clean up audio preview
    if (this.audioPreview) {
      this.audioPreview.destroy();
      this.audioPreview = null;
    }

    // Clean up global reference
    if (window.autoAssignModalInstance === this) {
      delete window.autoAssignModalInstance;
    }
  }
}

// Make available globally
window.AutoAssignModal = AutoAssignModal;
