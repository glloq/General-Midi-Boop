// public/js/views/components/AutoAssignModal.js

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
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  /**
   * Safely format info field (can be string or array)
   */
  formatInfo(info) {
    if (!info) return '';
    if (Array.isArray(info)) return info.map(i => this.escapeHtml(i)).join(' &bull; ');
    return this.escapeHtml(String(info));
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
        this.showError(response.error || 'Failed to generate suggestions');
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
      this.showError(error.message || 'Failed to generate suggestions');
    }
  }

  /**
   * Show loading state
   */
  showLoading() {
    const html = `
      <div class="modal-overlay" id="autoAssignModal">
        <div class="modal-container" style="max-width: 600px;">
          <div class="modal-header">
            <h2>Auto-Assign Instruments</h2>
          </div>
          <div class="modal-body" style="text-align: center; padding: 40px;">
            <div class="spinner"></div>
            <p style="margin-top: 20px;">Analyzing channels and instruments...</p>
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
      <div class="modal-overlay" id="autoAssignModal">
        <div class="modal-container" style="max-width: 600px;">
          <div class="modal-header">
            <h2>Auto-Assign Error</h2>
            <button class="modal-close" onclick="document.getElementById('autoAssignModal').remove()">x</button>
          </div>
          <div class="modal-body" style="padding: 40px; text-align: center;">
            <p style="color: #ff4444; font-size: 16px;">${this.escapeHtml(message)}</p>
            <button class="button button-secondary" onclick="document.getElementById('autoAssignModal').remove()" style="margin-top: 20px;">
              Close
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

    const channels = Object.keys(this.suggestions).sort((a, b) => parseInt(a) - parseInt(b));

    if (channels.length === 0) {
      this.showError('No active channels found in this MIDI file');
      return;
    }

    const channelsHTML = channels.map(channel => this.renderChannelSuggestions(parseInt(channel))).join('');

    const activeCount = channels.length - this.skippedChannels.size;

    const html = `
      <div class="modal-overlay" id="autoAssignModal">
        <div class="modal-container" style="max-width: 900px; max-height: 90vh; overflow-y: auto;">
          <div class="modal-header">
            <h2>Auto-Assign Instruments</h2>
            <button class="modal-close" onclick="autoAssignModalInstance.close()">x</button>
          </div>
          <div class="modal-body" style="padding: 0;">
            <div style="padding: 20px; background: #f5f5f5; border-bottom: 1px solid #ddd;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <div>
                  <strong>Confidence Score:</strong>
                  <span style="font-size: 20px; font-weight: bold; color: ${this.getScoreColor(this.confidenceScore)};">
                    ${this.confidenceScore}/100
                  </span>
                  ${this.getScoreStars(this.confidenceScore)}
                </div>
                <div style="color: #666; font-size: 14px;">
                  ${activeCount}/${channels.length} channel(s) will be assigned
                  ${this.skippedChannels.size > 0 ? ` (${this.skippedChannels.size} skipped)` : ''}
                </div>
              </div>
              <div style="margin-top: 10px; font-size: 13px; color: #888;">
                Click on an instrument to select it, or use the toggle to skip a channel.
              </div>
            </div>

            <div style="padding: 20px;">
              ${channelsHTML}
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; padding: 20px; border-top: 1px solid #ddd;">
            <button class="button button-secondary" onclick="autoAssignModalInstance.close()">
              Cancel
            </button>
            <div id="previewControls" style="display: flex; gap: 10px; align-items: center;">
              ${this.midiData ? `
                <button class="button button-secondary" onclick="autoAssignModalInstance.previewOriginal()" title="Preview original MIDI file">
                  Preview Original
                </button>
                <button class="button button-secondary" onclick="autoAssignModalInstance.previewAdapted()" title="Preview adapted MIDI with transpositions">
                  Preview Adapted
                </button>
                <button class="button button-secondary" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                  Stop
                </button>
              ` : ''}
            </div>
            <div style="display: flex; gap: 10px;">
              <button class="button button-info" onclick="autoAssignModalInstance.quickAssign()" title="Auto-assign and apply in one click">
                Quick Assign & Apply
              </button>
              <button class="button button-primary" onclick="autoAssignModalInstance.apply()">
                Apply Assignments
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
  }

  /**
   * Render channel statistics - uses stored channelAnalyses as fallback
   */
  renderChannelStats(channel) {
    // Try to get analysis from selectedAssignments first, fallback to stored analyses
    const analysis = this.selectedAssignments[channel]?.channelAnalysis || this.channelAnalyses[channel];
    if (!analysis) return '';

    return `
      <div style="background: #f0f8ff; padding: 10px; border-radius: 4px; margin-bottom: 10px; font-size: 12px;">
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
          <div>
            <strong>Note Range:</strong><br>
            ${analysis.noteRange.min} - ${analysis.noteRange.max} (${analysis.noteRange.max - analysis.noteRange.min} semitones)
          </div>
          <div>
            <strong>Polyphony:</strong><br>
            Max: ${analysis.polyphony.max}${analysis.polyphony.avg !== undefined ? ` | Avg: ${analysis.polyphony.avg.toFixed(1)}` : ''}
          </div>
          <div>
            <strong>Type:</strong><br>
            ${this.escapeHtml(analysis.estimatedType)} ${analysis.typeConfidence ? `(${analysis.typeConfidence}%)` : ''}
          </div>
        </div>
        ${this.renderMiniPiano(analysis.noteRange)}
      </div>
    `;
  }

  /**
   * Render mini piano visualization
   */
  renderMiniPiano(noteRange) {
    return `
      <div style="margin-top: 8px;">
        <div style="display: flex; align-items: center; gap: 4px; font-size: 10px;">
          <span>Range:</span>
          <div style="flex: 1; height: 20px; background: linear-gradient(to right, #ddd, #4CAF50, #ddd); border-radius: 3px; position: relative;">
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
        <div class="channel-suggestions" style="margin-bottom: 30px; padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px;">
          <h3 style="margin: 0 0 15px 0; color: #333;">
            Channel ${channel + 1}
            ${channel === 9 ? '<span style="color: #888; font-size: 14px;">(Drums)</span>' : ''}
          </h3>
          ${this.renderChannelStats(channel)}
          <p style="color: #999;">No compatible instruments found</p>
        </div>
      `;
    }

    // Skip/enable toggle for this channel
    const skipToggle = `
      <div style="margin-bottom: 15px; padding: 10px; background: ${isSkipped ? '#fff3f3' : '#f0fff0'}; border: 1px solid ${isSkipped ? '#ffcccc' : '#c8e6c9'}; border-radius: 6px;">
        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none;">
          <input type="checkbox"
                 ${isSkipped ? '' : 'checked'}
                 onchange="autoAssignModalInstance.toggleChannel(${channel}, this.checked)"
                 style="cursor: pointer; width: 18px; height: 18px;">
          <span style="font-size: 14px; font-weight: 600; color: ${isSkipped ? '#cc0000' : '#2e7d32'};">
            ${isSkipped ? 'Channel skipped - will not be assigned' : 'Assign this channel to an instrument'}
          </span>
        </label>
      </div>
    `;

    const optionsHTML = isSkipped ? '' : options.map((option, index) => {
      const instrument = option.instrument;
      const compat = option.compatibility;
      const isSelected = instrument.device_id === selectedDeviceId;
      const escapedName = this.escapeHtml(instrument.custom_name || instrument.name);
      const escapedDeviceId = this.escapeHtml(instrument.device_id);

      return `
        <div class="instrument-option ${isSelected ? 'selected' : ''}"
             data-channel="${channel}"
             data-device-id="${escapedDeviceId}"
             onclick="autoAssignModalInstance.selectInstrument(${channel}, '${escapedDeviceId}')"
             style="padding: 15px; margin-bottom: 10px; border: 2px solid ${isSelected ? '#4CAF50' : '#ddd'};
                    border-radius: 8px; cursor: pointer; background: ${isSelected ? '#f0fff0' : '#fff'};
                    transition: all 0.2s;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1;">
              <div style="font-weight: bold; font-size: 16px; margin-bottom: 5px;">
                ${escapedName}
              </div>
              <div style="color: #666; font-size: 13px; margin-bottom: 8px;">
                ${this.formatInstrumentInfo(instrument, compat)}
              </div>
              ${compat.info ? `
                <div style="color: #4CAF50; font-size: 12px;">
                  ${this.formatInfo(compat.info)}
                </div>
              ` : ''}
              ${compat.issues && compat.issues.length > 0 ? `
                <div style="color: #ff9800; font-size: 12px; margin-top: 4px;">
                  ${compat.issues.map(i => this.escapeHtml(i.message)).join(' &bull; ')}
                </div>
              ` : ''}
            </div>
            <div style="text-align: right; margin-left: 20px;">
              <div style="font-size: 24px; font-weight: bold; color: ${this.getScoreColor(compat.score)};">
                ${compat.score}
              </div>
              <div style="font-size: 11px; color: #666;">
                ${this.getScoreStars(compat.score)}
              </div>
              ${index === 0 ? '<div style="font-size: 11px; color: #4CAF50; margin-top: 4px;">RECOMMENDED</div>' : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Add octave wrapping toggle if available and channel is not skipped
    const assignment = this.selectedAssignments[channel];
    const octaveWrappingToggle = !isSkipped && assignment && assignment.octaveWrappingInfo ? `
      <div style="margin-top: 15px; padding: 10px; background: #fff9e6; border: 1px solid #ffd700; border-radius: 4px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
          <input type="checkbox"
                 id="octaveWrapping_${channel}"
                 ${assignment.octaveWrappingEnabled ? 'checked' : ''}
                 onchange="autoAssignModalInstance.toggleOctaveWrapping(${channel}, this.checked)"
                 style="cursor: pointer;">
          <span style="font-size: 13px;">
            <strong>Enable Octave Wrapping</strong><br>
            <span style="color: #666; font-size: 12px;">${this.escapeHtml(assignment.octaveWrappingInfo)}</span>
          </span>
        </label>
      </div>
    ` : '';

    // Add preview button for this channel (only if not skipped)
    const previewButton = !isSkipped && this.midiData ? `
      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd;">
        <button class="button button-secondary"
                onclick="autoAssignModalInstance.previewChannel(${channel})"
                style="font-size: 13px; padding: 8px 12px;">
          Preview Channel ${channel + 1}
        </button>
      </div>
    ` : '';

    return `
      <div class="channel-suggestions" style="margin-bottom: 30px; padding: 20px; background: ${isSkipped ? '#fafafa' : '#fafafa'}; border: 1px solid ${isSkipped ? '#e0e0e0' : '#ddd'}; border-radius: 8px; ${isSkipped ? 'opacity: 0.7;' : ''}">
        <h3 style="margin: 0 0 15px 0; color: #333;">
          Channel ${channel + 1}
          ${channel === 9 ? '<span style="color: #888; font-size: 14px;">(MIDI 10 - Drums)</span>' : ''}
          ${isSkipped ? '<span style="color: #cc0000; font-size: 14px; margin-left: 10px;">[SKIPPED]</span>' : ''}
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
      parts.push(`GM Program ${instrument.gm_program}`);
    }

    if (compat.transposition && compat.transposition.octaves !== 0) {
      const direction = compat.transposition.octaves > 0 ? 'up' : 'down';
      parts.push(`${Math.abs(compat.transposition.octaves)} octave(s) ${direction}`);
    } else {
      parts.push('No transposition');
    }

    if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
      parts.push(`Range: ${instrument.note_range_min}-${instrument.note_range_max}`);
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
      alert('No assignments selected. All channels are skipped.');
      return;
    }

    // Show applying state
    if (this.modal) {
      const footer = this.modal.querySelector('.modal-footer');
      footer.innerHTML = `
        <div style="width: 100%; text-align: center;">
          <div class="spinner" style="display: inline-block;"></div>
          <p style="margin-top: 10px;">Creating adapted file and applying assignments...</p>
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
        alert('Failed to apply assignments: ' + (response.error || 'Unknown error'));
        this.close();
        return;
      }

      // Success!
      const skippedMsg = this.skippedChannels.size > 0
        ? `\n${this.skippedChannels.size} channel(s) were skipped.`
        : '';
      alert(`Assignments applied successfully!\n\nAdapted file created: ${response.filename}\n${response.stats.notesChanged} notes transposed${skippedMsg}`);

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
      alert('Error applying assignments: ' + error.message);
      this.close();
    }
  }

  /**
   * Quick assign: apply auto-selection immediately without manual review
   */
  async quickAssign() {
    if (!confirm('This will automatically assign all channels to the recommended instruments and apply immediately. Continue?')) {
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
      alert('Audio preview not available');
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
      alert('Failed to preview channel: ' + error.message);
    }
  }

  /**
   * Preview original MIDI file (no transpositions)
   */
  async previewOriginal() {
    if (!this.audioPreview || !this.midiData) {
      alert('Audio preview not available');
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
      alert('Failed to preview original: ' + error.message);
    }
  }

  /**
   * Preview adapted MIDI with all transpositions
   */
  async previewAdapted() {
    if (!this.audioPreview || !this.midiData) {
      alert('Audio preview not available');
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
      alert('Failed to preview adapted: ' + error.message);
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
