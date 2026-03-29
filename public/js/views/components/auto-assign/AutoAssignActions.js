// Auto-extracted from AutoAssignModal.js
(function() {
    'use strict';
    const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    const AutoAssignActionsMixin = {};


  /**
   * Select an instrument for a channel
   */
    AutoAssignActionsMixin.selectInstrument = function(channel, instrumentId) {
    const ch = String(channel);
    const options = this.suggestions[ch] || [];
    const lowOptions = this.lowScoreSuggestions[ch] || [];
    const selectedOption = options.find(opt => opt.instrument.id === instrumentId)
      || lowOptions.find(opt => opt.instrument.id === instrumentId);

    if (!selectedOption) return;

    const existingAnalysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch] || null;

    this.selectedAssignments[ch] = {
      deviceId: selectedOption.instrument.device_id,
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
    this._isDirty = true;
    this.refreshCurrentTab();
    this.refreshTabBar();
  }

  /**
   * Refresh tab bar (scores, skip states)
   */
    AutoAssignActionsMixin.refreshTabBar = function() {
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
          statusEl.className = 'aa-tab-status ' + this.getScoreClass(score);
          statusEl.style.color = '';
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
    AutoAssignActionsMixin.validateAndApply = async function() {
    // Filter out skipped channels and merge split assignments
    const activeAssignments = {};

    // Add normal (non-split) assignments
    for (const [channel, assignment] of Object.entries(this.selectedAssignments)) {
      if (!this.skippedChannels.has(parseInt(channel)) && !this.splitChannels.has(parseInt(channel))) {
        activeAssignments[channel] = assignment;
      }
    }

    // Add split assignments
    for (const [channel, proposal] of Object.entries(this.splitAssignments)) {
      if (!this.skippedChannels.has(parseInt(channel))) {
        activeAssignments[channel] = {
          split: true,
          splitMode: proposal.type,
          segments: proposal.segments.map(seg => ({
            deviceId: seg.deviceId,
            instrumentId: seg.instrumentId,
            instrumentChannel: seg.instrumentChannel,
            instrumentName: seg.instrumentName,
            noteRange: seg.noteRange,
            polyphonyShare: seg.polyphonyShare,
            score: proposal.quality
          }))
        };
      }
    }

    if (Object.keys(activeAssignments).length === 0) {
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.noAssignments'), 'warning');
      } else {
        alert(_t('autoAssign.noAssignments'));
      }
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
        if (typeof window.showToast === 'function') {
          window.showToast(_t('autoAssign.applyFailed') + ': ' + (response.error || ''), 'error');
        } else {
          alert(_t('autoAssign.applyFailed') + ': ' + (response.error || ''));
        }
        this.showTabbedUI(); // Re-show the UI
        return;
      }

      // Show success feedback
      const assignedCount = Object.keys(preparedAssignments).length;
      const skippedCount = this.skippedChannels.size;
      const splitCount = Object.values(preparedAssignments).filter(a => a.split).length;
      let successMsg = `${assignedCount} ${_t('autoAssign.channelsAssigned')}`;
      if (splitCount > 0) successMsg += `, ${splitCount} split(s)`;
      if (skippedCount > 0) successMsg += `, ${skippedCount} ${_t('autoAssign.channelsSkipped')}`;
      if (typeof window.showToast === 'function') {
        window.showToast(successMsg, 'success');
      }

      // Close this auto-assign modal (force: skip dirty check after successful apply)
      this.close(true);

      // If a callback was provided (routing modal context), delegate post-apply to caller
      if (this.onApply) {
        this.onApply({
          success: true,
          adaptedFileId: response.adaptedFileId,
          filename: response.filename,
          assignments: preparedAssignments,
          skippedCount: this.skippedChannels.size
        });
        return;
      }

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
        // Reload routings in the editor so UI reflects the changes immediately
        if (this.editorRef) {
          if (typeof this.editorRef._loadSavedRoutings === 'function') {
            await this.editorRef._loadSavedRoutings();
          }
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
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.applyFailed') + ': ' + error.message, 'error');
      } else {
        alert(_t('autoAssign.applyFailed') + ': ' + error.message);
      }
      this.showTabbedUI(); // Re-show the UI
    }
  }

  // ========================================================================
  // PREVIEW
  // ========================================================================

  /**
   * Preview a specific instrument for a channel (from inline play button)
   */
    AutoAssignActionsMixin.previewInstrument = async function(channel, instrumentId) {
    if (!this.audioPreview || !this.midiData) return;
    if (this._previewInProgress) return;

    // Temporarily select this instrument for preview
    const ch = String(channel);
    const options = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const option = options.find(opt => opt.instrument.id === instrumentId);
    if (!option) return;

    this._previewInProgress = true;
    try {
      this.stopPreview();
      const transposition = {};
      const instrumentConstraints = {};
      if (option.instrument.gm_program != null) {
        instrumentConstraints.gmProgram = option.instrument.gm_program;
      }
      instrumentConstraints.noteRangeMin = option.instrument.note_range_min;
      instrumentConstraints.noteRangeMax = option.instrument.note_range_max;

      if (option.compatibility.transposition?.semitones) {
        transposition.semitones = option.compatibility.transposition.semitones;
      }

      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, transposition, instrumentConstraints, 0, 10
      );
      this.showStopButton();
    } catch (error) {
      console.error('Preview error:', error);
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewFailed') + ': ' + (error.message || ''), 'error');
      }
    } finally {
      this._previewInProgress = false;
    }
  }

    AutoAssignActionsMixin.previewChannel = async function(channel) {
    if (!this.audioPreview || !this.midiData) {
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewNotAvailable'), 'warning');
      } else {
        alert(_t('autoAssign.previewNotAvailable'));
      }
      return;
    }

    // Prevent concurrent previews
    if (this._previewInProgress) return;
    this._previewInProgress = true;

    try {
      this.stopPreview();
      const ch = String(channel);

      // Handle split channel preview: play full channel with combined range
      if (this.isSplitChannel(channel) && this.splitAssignments[channel]) {
        const splitProposal = this.splitAssignments[channel];
        const segments = splitProposal.segments || [];
        if (segments.length > 0) {
          // Use first segment's GM program for sound, combined range for constraints
          const instrumentConstraints = {};
          // Use GM program from channel analysis for sound
          const splitAnalysis = this.channelAnalyses[channel];
          if (splitAnalysis?.primaryProgram != null) {
            instrumentConstraints.gmProgram = splitAnalysis.primaryProgram;
          }
          // Find combined note range across all segments
          const allMins = segments.map(s => s.noteRange?.min).filter(v => v != null);
          const allMaxs = segments.map(s => s.noteRange?.max).filter(v => v != null);
          if (allMins.length > 0) instrumentConstraints.noteRangeMin = Math.min(...allMins);
          if (allMaxs.length > 0) instrumentConstraints.noteRangeMax = Math.max(...allMaxs);

          await this.audioPreview.previewSingleChannel(
            this.midiData, channel, {}, instrumentConstraints, 0, 15
          );
          this.showStopButton();
        }
        return;
      }

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

        // Apply drum strategy filtering (mirrors validateAndApply logic)
        const drumStrategy = adaptation.drumStrategy || 'intelligent';
        if (drumStrategy === 'direct') {
          const filtered = {};
          for (const [src, tgt] of Object.entries(noteRemapping)) {
            if (parseInt(src) === tgt) filtered[src] = tgt;
          }
          noteRemapping = filtered;
        } else if (drumStrategy === 'manual') {
          noteRemapping = {};
        }

        // Apply manual drum note overrides on top
        const drumOverrides = this.drumMappingOverrides[ch] || {};
        if (Object.keys(drumOverrides).length > 0) {
          noteRemapping = { ...noteRemapping, ...drumOverrides };
        }

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
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewFailed') + ': ' + error.message, 'error');
      } else {
        alert(_t('autoAssign.previewFailed') + ': ' + error.message);
      }
    } finally {
      this._previewInProgress = false;
    }
  }

  /**
   * Preview original channel without any adaptation (raw MIDI)
   */
    AutoAssignActionsMixin.previewOriginal = async function(channel) {
    if (!this.audioPreview || !this.midiData) {
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewNotAvailable'), 'warning');
      } else {
        alert(_t('autoAssign.previewNotAvailable'));
      }
      return;
    }

    if (this._previewInProgress) return;
    this._previewInProgress = true;

    try {
      this.stopPreview();
      const ch = String(channel);
      const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;

      // No transposition, no constraints — play raw channel
      const instrumentConstraints = {};
      // Use GM program from the MIDI file analysis for sound
      if (analysis?.primaryProgram != null) {
        instrumentConstraints.gmProgram = analysis.primaryProgram;
      }

      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, {}, instrumentConstraints, 0, 15
      );
      this.showStopButton();
    } catch (error) {
      console.error('Preview original error:', error);
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewFailed') + ': ' + (error.message || ''), 'error');
      }
    } finally {
      this._previewInProgress = false;
    }
  }

    if (typeof window !== 'undefined') window.AutoAssignActionsMixin = AutoAssignActionsMixin;
})();
