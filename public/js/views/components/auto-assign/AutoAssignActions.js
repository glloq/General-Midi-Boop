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

    // Fallback: instrument from allInstruments (unrouted/unscored)
    if (!selectedOption) {
      const inst = (this.allInstruments || []).find(i => i.id === instrumentId);
      if (!inst) return;

      const existingAnalysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch] || null;

      this.selectedAssignments[ch] = {
        deviceId: inst.device_id,
        instrumentId: inst.id,
        instrumentName: inst.name,
        customName: inst.custom_name,
        gmProgram: inst.gm_program,
        noteRangeMin: inst.note_range_min,
        noteRangeMax: inst.note_range_max,
        noteSelectionMode: inst.note_selection_mode,
        selectedNotes: inst.selected_notes,
        polyphony: inst.polyphony,
        supportedCCs: inst.supported_ccs,
        score: 0,
        transposition: null,
        noteRemapping: null,
        octaveWrapping: null,
        octaveWrappingEnabled: false,
        octaveWrappingInfo: null,
        issues: [],
        info: null,
        channelAnalysis: existingAnalysis
      };

      this.adaptationSettings[ch] = {
        ...this.adaptationSettings[ch],
        transpositionSemitones: 0,
        octaveWrappingEnabled: false,
        pitchShift: 'none',
        oorHandling: 'passThrough',
        polyReductionEnabled: this.adaptationSettings[ch]?.polyReductionEnabled || false,
        ccRemapEnabled: this.adaptationSettings[ch]?.ccRemapEnabled || false
      };

      this.skippedChannels.delete(channel);
      this._isDirty = true;
      this.refreshCurrentTab();
      this.refreshTabBar();
      return;
    }

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
      polyphony: selectedOption.instrument.polyphony,
      supportedCCs: selectedOption.instrument.supported_ccs,
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

    // Update adaptation settings with new transposition (preserve independent options)
    const hasWrap = selectedOption.compatibility.octaveWrappingEnabled || false;
    const hasTrans = selectedOption.compatibility.transposition?.semitones || 0;
    this.adaptationSettings[ch] = {
      ...this.adaptationSettings[ch],
      transpositionSemitones: hasTrans,
      octaveWrappingEnabled: hasWrap,
      pitchShift: hasWrap ? 'manual' : hasTrans ? 'manual' : 'none',
      oorHandling: hasWrap ? 'octaveWrap' : (this.adaptationSettings[ch]?.oorHandling || 'passThrough'),
      polyReductionEnabled: this.adaptationSettings[ch]?.polyReductionEnabled || false,
      ccRemapEnabled: this.adaptationSettings[ch]?.ccRemapEnabled || false
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
        const pitchShift = adaptation.pitchShift || 'none';
        const oorHandling = adaptation.oorHandling || 'passThrough';

        // Dimension 1: Pitch shift
        if (pitchShift === 'auto' || pitchShift === 'manual') {
          preparedAssignments[channel].transposition = {
            ...(assignment.transposition || {}),
            semitones: adaptation.transpositionSemitones || 0
          };
        }

        // Dimension 2: Out-of-range handling
        if (oorHandling === 'octaveWrap') {
          if (assignment.octaveWrapping) {
            const baseRemapping = assignment.noteRemapping || {};
            preparedAssignments[channel].noteRemapping = {
              ...baseRemapping,
              ...assignment.octaveWrapping
            };
          }
        } else if (oorHandling === 'suppress') {
          if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
            preparedAssignments[channel].suppressOutOfRange = true;
            preparedAssignments[channel].noteRangeMin = assignment.noteRangeMin;
            preparedAssignments[channel].noteRangeMax = assignment.noteRangeMax;
          }
        } else if (oorHandling === 'compress') {
          if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
            preparedAssignments[channel].noteCompression = true;
            preparedAssignments[channel].noteRangeMin = assignment.noteRangeMin;
            preparedAssignments[channel].noteRangeMax = assignment.noteRangeMax;
          }
        }

        // Apply independent options (can be combined with any main strategy)
        if (adaptation.polyReductionEnabled) {
          const instPoly = assignment.polyphony || 16;
          preparedAssignments[channel].polyReduction = true;
          preparedAssignments[channel].maxPolyphony = instPoly;
        }
        if (adaptation.ccRemapEnabled) {
          const analysis = this.channelAnalyses[parseInt(channel)] || assignment.channelAnalysis;
          const usedCCs = analysis?.usedCCs || [];
          let supportedCCs;
          try {
            supportedCCs = assignment.supportedCCs
              ? (typeof assignment.supportedCCs === 'string' ? JSON.parse(assignment.supportedCCs) : assignment.supportedCCs)
              : [];
          } catch (e) { supportedCCs = []; }
          const supportedSet = new Set(supportedCCs);
          const CC_REMAP_TABLE = { 11: 7, 1: 74, 71: 74, 73: 72, 91: 93, 93: 91 };
          const ccRemapping = {};
          for (const cc of usedCCs) {
            if (!supportedSet.has(cc)) {
              const target = CC_REMAP_TABLE[cc];
              if (target !== undefined && supportedSet.has(target)) {
                ccRemapping[cc] = target;
              }
            }
          }
          if (Object.keys(ccRemapping).length > 0) {
            preparedAssignments[channel].ccRemapping = ccRemapping;
          }
        }

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
  // PREVIEW - STATE & HELPERS
  // ========================================================================

  /**
   * Build transposition + instrumentConstraints for a single channel,
   * using the current selectedAssignments and adaptationSettings.
   * Returns { transposition, instrumentConstraints }.
   */
    AutoAssignActionsMixin._buildChannelPreviewConfig = function(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const adaptation = this.adaptationSettings[ch] || {};
    const transposition = {};
    const instrumentConstraints = {};

    if (!assignment) return { transposition, instrumentConstraints };

    const pitchShift = adaptation.pitchShift || 'none';
    const oorHandling = adaptation.oorHandling || 'passThrough';
    let noteRemapping = assignment.noteRemapping || {};

    // Dimension 1: Pitch shift
    if (pitchShift === 'auto' || pitchShift === 'manual') {
      transposition.semitones = adaptation.transpositionSemitones || 0;
    }

    // Dimension 2: Out-of-range handling
    if (oorHandling === 'octaveWrap') {
      if (assignment.octaveWrapping) {
        noteRemapping = { ...noteRemapping, ...assignment.octaveWrapping };
      }
    } else if (oorHandling === 'suppress') {
      if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
        instrumentConstraints.suppressOutOfRange = true;
      }
    } else if (oorHandling === 'compress') {
      instrumentConstraints.noteCompression = true;
    }

    // Apply drum strategy filtering
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

    return { transposition, instrumentConstraints };
  }

  /**
   * Connect progress callbacks from AudioPreview to the modal UI.
   */
    AutoAssignActionsMixin._connectPreviewCallbacks = function() {
    if (!this.audioPreview) return;

    this.audioPreview.onProgress = (currentTick, totalTicks, currentSec, totalSec) => {
      this._onPreviewProgress(currentTick, totalTicks, currentSec, totalSec);
    };

    this.audioPreview.onPlaybackEnd = () => {
      this._previewState = 'stopped';
      this._previewMode = null;
      this._previewChannel = null;
      this.updatePreviewUI();
    };
  }

  /**
   * Called on each progress tick from AudioPreview.
   * Updates the progress bar and minimap playhead via direct DOM manipulation.
   */
    AutoAssignActionsMixin._onPreviewProgress = function(currentTick, totalTicks, currentSec, totalSec) {
    // Update progress bar fill
    const fill = this.modal?.querySelector('.aa-progress-fill');
    if (fill && totalSec > 0) {
      const pct = Math.min(100, (currentSec / totalSec) * 100);
      fill.style.width = pct + '%';
    }

    // Update time display
    const timeEl = this.modal?.querySelector('.aa-progress-time');
    if (timeEl) {
      timeEl.textContent = this._formatTime(currentSec) + ' / ' + this._formatTime(totalSec);
    }

    // Update minimap playhead
    if (this._minimapCanvas && totalTicks > 0) {
      this.updateMinimapPlayhead(currentTick, totalTicks);
    }
  }

  /**
   * Format seconds as M:SS
   */
    AutoAssignActionsMixin._formatTime = function(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ========================================================================
  // PREVIEW - ACTIONS
  // ========================================================================

  /**
   * Preview ALL channels with their assigned instruments (global preview).
   */
    AutoAssignActionsMixin.previewAll = async function() {
    if (!this.audioPreview || !this.midiData) {
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewNotAvailable'), 'warning');
      }
      return;
    }

    if (this._previewInProgress) return;
    this._previewInProgress = true;

    try {
      this.stopPreview();

      // Build channelConfigs for all non-skipped channels
      const channelConfigs = {};
      for (const chStr of this.channels) {
        const ch = parseInt(chStr);
        if (this.skippedChannels.has(ch)) continue;

        const { transposition, instrumentConstraints } = this._buildChannelPreviewConfig(ch);
        channelConfigs[ch] = {
          transposition,
          instrumentConstraints,
          skipped: false
        };
      }

      this._connectPreviewCallbacks();
      await this.audioPreview.previewAllChannels(this.midiData, channelConfigs, 0);

      this._previewState = 'playing';
      this._previewMode = 'all';
      this._previewChannel = null;
      this.updatePreviewUI();
    } catch (error) {
      console.error('Preview all error:', error);
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewFailed') + ': ' + (error.message || ''), 'error');
      }
    } finally {
      this._previewInProgress = false;
    }
  }

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

      this._connectPreviewCallbacks();
      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, transposition, instrumentConstraints, 0, 10
      );

      this._previewState = 'playing';
      this._previewMode = 'channel';
      this._previewChannel = channel;
      this.updatePreviewUI();
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
          const instrumentConstraints = {};
          const splitAnalysis = this.channelAnalyses[channel];
          if (splitAnalysis?.primaryProgram != null) {
            instrumentConstraints.gmProgram = splitAnalysis.primaryProgram;
          }
          const allMins = segments.map(s => s.noteRange?.min).filter(v => v != null);
          const allMaxs = segments.map(s => s.noteRange?.max).filter(v => v != null);
          if (allMins.length > 0) instrumentConstraints.noteRangeMin = Math.min(...allMins);
          if (allMaxs.length > 0) instrumentConstraints.noteRangeMax = Math.max(...allMaxs);

          this._connectPreviewCallbacks();
          await this.audioPreview.previewSingleChannel(
            this.midiData, channel, {}, instrumentConstraints, 0, 15, true
          );

          this._previewState = 'playing';
          this._previewMode = 'channel';
          this._previewChannel = channel;
          this.updatePreviewUI();
        }
        return;
      }

      const { transposition, instrumentConstraints } = this._buildChannelPreviewConfig(channel);

      this._connectPreviewCallbacks();
      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, transposition, instrumentConstraints, 0, 15, true
      );

      this._previewState = 'playing';
      this._previewMode = 'channel';
      this._previewChannel = channel;
      this.updatePreviewUI();
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

      const instrumentConstraints = {};
      if (analysis?.primaryProgram != null) {
        instrumentConstraints.gmProgram = analysis.primaryProgram;
      }

      this._connectPreviewCallbacks();
      await this.audioPreview.previewSingleChannel(
        this.midiData, channel, {}, instrumentConstraints, 0, 15, true
      );

      this._previewState = 'playing';
      this._previewMode = 'original';
      this._previewChannel = channel;
      this.updatePreviewUI();
    } catch (error) {
      console.error('Preview original error:', error);
      if (typeof window.showToast === 'function') {
        window.showToast(_t('autoAssign.previewFailed') + ': ' + (error.message || ''), 'error');
      }
    } finally {
      this._previewInProgress = false;
    }
  }

  // ========================================================================
  // PREVIEW - PAUSE / RESUME / SEEK
  // ========================================================================

  /**
   * Pause current preview
   */
    AutoAssignActionsMixin.pausePreview = function() {
    if (!this.audioPreview || this._previewState !== 'playing') return;
    this.audioPreview.pause();
    this._previewState = 'paused';
    this.updatePreviewUI();
  }

  /**
   * Resume paused preview
   */
    AutoAssignActionsMixin.resumePreview = function() {
    if (!this.audioPreview || this._previewState !== 'paused') return;
    this.audioPreview.resume();
    this._previewState = 'playing';
    this.updatePreviewUI();
  }

  /**
   * Seek preview to a position in seconds
   */
    AutoAssignActionsMixin.seekPreview = function(timeSec) {
    if (!this.audioPreview) return;
    this.audioPreview.seek(timeSec);
  }

  /**
   * Handle click on the progress bar to seek.
   */
    AutoAssignActionsMixin._onProgressBarClick = function(e) {
    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const totalSec = this.audioPreview?.totalDuration || 0;
    if (totalSec > 0) {
      this.seekPreview(pct * totalSec);
    }
  }

  /**
   * Update the preview controls UI to reflect current state.
   * Called after play/pause/stop/end transitions.
   */
    AutoAssignActionsMixin.updatePreviewUI = function() {
    if (!this.modal) return;

    const state = this._previewState || 'stopped';
    const mode = this._previewMode;

    // Play All button
    const playAllBtn = this.modal.querySelector('#aaPreviewAllBtn');
    if (playAllBtn) {
      playAllBtn.classList.toggle('active', state === 'playing' && mode === 'all');
    }

    // Play Channel button
    const playChBtn = this.modal.querySelector('#aaPreviewChBtn');
    if (playChBtn) {
      playChBtn.classList.toggle('active', state === 'playing' && mode === 'channel');
    }

    // Play Original button
    const playOrigBtn = this.modal.querySelector('#aaPreviewOrigBtn');
    if (playOrigBtn) {
      playOrigBtn.classList.toggle('active', state === 'playing' && mode === 'original');
    }

    // Pause / Resume button
    const pauseBtn = this.modal.querySelector('#aaPreviewPauseBtn');
    if (pauseBtn) {
      if (state === 'stopped') {
        pauseBtn.style.display = 'none';
      } else {
        pauseBtn.style.display = 'inline-flex';
        pauseBtn.innerHTML = state === 'paused'
          ? '<span class="aa-btn-icon">&#9654;</span>'   // play triangle = resume
          : '<span class="aa-btn-icon">&#10074;&#10074;</span>'; // pause bars
        pauseBtn.title = state === 'paused' ? _t('autoAssign.resume') : _t('autoAssign.pause');
      }
    }

    // Stop button
    const stopBtn = this.modal.querySelector('#aaPreviewStopBtn');
    if (stopBtn) {
      stopBtn.style.display = state === 'stopped' ? 'none' : 'inline-flex';
    }

    // Progress bar visibility
    const progressSection = this.modal.querySelector('.aa-preview-progress');
    if (progressSection) {
      progressSection.style.display = state === 'stopped' ? 'none' : 'flex';
    }

    // Reset progress bar on stop
    if (state === 'stopped') {
      const fill = this.modal.querySelector('.aa-progress-fill');
      if (fill) fill.style.width = '0%';
      const timeEl = this.modal.querySelector('.aa-progress-time');
      if (timeEl) timeEl.textContent = '0:00 / 0:00';
    }

    // Minimap: show when playing single channel, render/update
    const minimapContainer = this.modal.querySelector('.aa-minimap-container');
    if (minimapContainer) {
      const showMinimap = state !== 'stopped';
      minimapContainer.style.display = showMinimap ? 'block' : 'none';
      if (showMinimap) {
        // Render or re-render minimap for appropriate channel(s)
        this.renderNoteMinimap();
      }
    }
  }

    if (typeof window !== 'undefined') window.AutoAssignActionsMixin = AutoAssignActionsMixin;
})();
