// Auto-assign Panels - Channel info (left) and Instrument info (right) panels
(function() {
    'use strict';
    const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    const AutoAssignPanelsMixin = {};

  // ========================================================================
  // CHANNEL PANEL (LEFT)
  // ========================================================================

  /**
   * Render detailed channel information panel
   */
  AutoAssignPanelsMixin.renderChannelPanel = function(channel) {
    const ch = String(channel);
    const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;
    const assignment = this.selectedAssignments[ch];
    const isSkipped = this.skippedChannels.has(channel);
    const isSplit = this.isSplitChannel(channel);

    if (!analysis) {
      return `<div class="aa-panel-empty">${_t('autoAssign.matrix.noChannelData')}</div>`;
    }

    const gmName = channel === 9
      ? _t('autoAssign.drums')
      : (this.getGmProgramName(analysis.primaryProgram) || '—');
    const typeIcon = analysis.estimatedType ? this.getTypeIcon(analysis.estimatedType) : '';
    const typeLabel = analysis.estimatedType || '—';
    const confidence = analysis.typeConfidence || 0;

    // Note range
    const hasRange = analysis.noteRange && analysis.noteRange.min != null;
    const rangeMin = hasRange ? this.midiNoteToName(analysis.noteRange.min) : '—';
    const rangeMax = hasRange ? this.midiNoteToName(analysis.noteRange.max) : '—';

    // Polyphony
    const polyMax = analysis.polyphony?.max || '—';
    const polyAvg = analysis.polyphony?.avg != null ? Math.round(analysis.polyphony.avg * 10) / 10 : '—';

    // Density
    const density = analysis.density != null ? Math.round(analysis.density * 10) / 10 : '—';

    // Used CCs
    const usedCCs = analysis.usedCCs || [];
    const ccList = usedCCs.length > 0 ? usedCCs.slice(0, 8).join(', ') + (usedCCs.length > 8 ? '…' : '') : '—';

    // Track names
    const trackNames = analysis.trackNames || [];
    const trackNamesStr = trackNames.length > 0 ? trackNames.join(', ') : '—';

    // Total notes
    const totalNotes = analysis.totalNotes || 0;

    // Mini piano roll
    const miniPiano = hasRange ? this._renderMiniPianoRoll(analysis, null) : '';

    return `
      <div class="aa-panel-content aa-panel-channel">
        <div class="aa-panel-header">
          <h3>
            ${typeIcon} ${_t('autoAssign.channel')} ${channel + 1}
            ${channel === 9 ? '<span class="aa-tab-drum">DR</span>' : ''}
            ${isSplit ? '<span class="aa-tab-split">SP</span>' : ''}
          </h3>
          ${isSkipped ? `<span class="aa-panel-badge skipped">${_t('autoAssign.skippedLabel')}</span>` : ''}
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.gmProgram')}</span>
            <span class="aa-panel-value">${escapeHtml(gmName)}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.type')}</span>
            <span class="aa-panel-value">${escapeHtml(typeLabel)} <span class="aa-panel-confidence">${confidence}%</span></span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.noteRange')}</span>
            <span class="aa-panel-value">${rangeMin} — ${rangeMax}</span>
          </div>
          ${miniPiano}
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.totalNotes')}</span>
            <span class="aa-panel-value">${totalNotes}</span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.polyphony')}</span>
            <span class="aa-panel-value">max ${polyMax} / avg ${polyAvg}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.density')}</span>
            <span class="aa-panel-value">${density} ${_t('autoAssign.matrix.notesPerSec')}</span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.usedCCs')}</span>
            <span class="aa-panel-value aa-panel-value-small">${ccList}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.trackNames')}</span>
            <span class="aa-panel-value aa-panel-value-small">${escapeHtml(trackNamesStr)}</span>
          </div>
        </div>

        ${assignment ? `
          <div class="aa-panel-section aa-panel-assignment">
            <div class="aa-panel-field">
              <span class="aa-panel-label">${_t('autoAssign.matrix.assignedTo')}</span>
              <span class="aa-panel-value aa-panel-assigned-name">${escapeHtml(assignment.customName || assignment.instrumentName || '—')}</span>
            </div>
            <div class="aa-panel-field">
              <span class="aa-panel-label">${_t('autoAssign.overviewScore')}</span>
              <span class="aa-panel-value ${this.getScoreClass(assignment.score)}">${assignment.score}/100 — ${this.getScoreLabel(assignment.score)}</span>
            </div>
          </div>
        ` : ''}

        <div class="aa-panel-actions">
          ${this.midiData ? `
            <button class="btn aa-btn-sm aa-btn-block" onclick="autoAssignModalInstance.previewOriginal(${channel})">
              ${_t('autoAssign.previewOriginal')}
            </button>
          ` : ''}
        </div>
      </div>
    `;
  };

  // ========================================================================
  // INSTRUMENT PANEL (RIGHT)
  // ========================================================================

  /**
   * Render detailed instrument information panel
   */
  AutoAssignPanelsMixin.renderInstrumentPanel = function(instrumentId) {
    const inst = this._findInstrument(instrumentId);
    if (!inst) {
      return `<div class="aa-panel-empty">${_t('autoAssign.matrix.noInstrumentData')}</div>`;
    }

    const displayName = inst.custom_name || inst.name || 'Unknown';
    const typeIcon = this.getTypeIcon(inst.instrument_type || '');
    const connectionIcon = this._getConnectionIcon(inst);

    // Note range
    const hasRange = inst.note_range_min != null && inst.note_range_max != null;
    const rangeMin = hasRange ? this.midiNoteToName(inst.note_range_min) : '—';
    const rangeMax = hasRange ? this.midiNoteToName(inst.note_range_max) : '—';

    // Polyphony
    const polyphony = inst.polyphony || '—';

    // Latency
    const latency = inst.sync_delay || 0;

    // GM Program
    const gmName = inst.gm_program != null ? (this.getGmProgramName(inst.gm_program) || `Program ${inst.gm_program}`) : '—';

    // Type
    const typeLabel = inst.instrument_type || '—';
    const subtypeLabel = inst.instrument_subtype || '';

    // CCs
    let supportedCCs = '—';
    if (inst.supported_ccs) {
      try {
        const ccs = typeof inst.supported_ccs === 'string' ? JSON.parse(inst.supported_ccs) : inst.supported_ccs;
        if (Array.isArray(ccs) && ccs.length > 0) {
          supportedCCs = ccs.slice(0, 8).join(', ') + (ccs.length > 8 ? '…' : '');
        }
      } catch (e) { /* ignore */ }
    }

    // Capabilities source
    const capSource = inst.capabilities_source || '—';

    // Note selection mode
    const noteMode = inst.note_selection_mode || 'range';

    // Mini piano roll for instrument
    const miniPiano = hasRange ? this._renderMiniPianoRoll(null, inst) : '';

    // Which channels is this instrument assigned to?
    const assignedChannels = [];
    for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
      if (assignment && typeof assignment === 'object' && assignment.instrumentId === instrumentId) {
        assignedChannels.push(parseInt(ch));
      }
    }

    return `
      <div class="aa-panel-content aa-panel-instrument">
        <div class="aa-panel-header">
          <h3>${typeIcon} ${escapeHtml(displayName)}</h3>
          <span class="aa-panel-conn-badge">${connectionIcon}</span>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.deviceId')}</span>
            <span class="aa-panel-value aa-panel-value-small">${escapeHtml(inst.device_id || '—')}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.gmProgram')}</span>
            <span class="aa-panel-value">${escapeHtml(gmName)}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.type')}</span>
            <span class="aa-panel-value">${escapeHtml(typeLabel)}${subtypeLabel ? ' / ' + escapeHtml(subtypeLabel) : ''}</span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.noteRange')}</span>
            <span class="aa-panel-value">${rangeMin} — ${rangeMax}</span>
          </div>
          ${miniPiano}
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.noteMode')}</span>
            <span class="aa-panel-value">${noteMode === 'discrete' ? _t('autoAssign.matrix.noteModeDiscrete') : _t('autoAssign.matrix.noteModeRange')}</span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.polyphony')}</span>
            <span class="aa-panel-value">${polyphony}</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.latency')}</span>
            <span class="aa-panel-value">${latency} ms</span>
          </div>
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.capSource')}</span>
            <span class="aa-panel-value">${escapeHtml(capSource)}</span>
          </div>
        </div>

        <div class="aa-panel-section">
          <div class="aa-panel-field">
            <span class="aa-panel-label">${_t('autoAssign.matrix.supportedCCs')}</span>
            <span class="aa-panel-value aa-panel-value-small">${supportedCCs}</span>
          </div>
        </div>

        ${assignedChannels.length > 0 ? `
          <div class="aa-panel-section aa-panel-assignment">
            <div class="aa-panel-field">
              <span class="aa-panel-label">${_t('autoAssign.matrix.assignedToChannels')}</span>
              <span class="aa-panel-value">
                ${assignedChannels.map(ch => `<span class="aa-panel-ch-badge" onclick="autoAssignModalInstance.selectMatrixChannel(${ch})">Ch ${ch + 1}</span>`).join(' ')}
              </span>
            </div>
          </div>
        ` : ''}

        <div class="aa-panel-actions">
          <button class="btn aa-btn-sm aa-btn-block" onclick="autoAssignModalInstance.openInstrumentSettings('${instrumentId}')">
            ${_t('autoAssign.matrix.configureInstrument')}
          </button>
        </div>
      </div>
    `;
  };

  // ========================================================================
  // MINI PIANO ROLL
  // ========================================================================

  /**
   * Render a compact mini piano roll showing note range
   * @param {Object|null} analysis - Channel analysis (for used notes)
   * @param {Object|null} instrument - Instrument (for playable range)
   */
  AutoAssignPanelsMixin._renderMiniPianoRoll = function(analysis, instrument) {
    // Determine range to display (C1=24 to C7=96 by default)
    let displayMin = 24;
    let displayMax = 96;

    if (analysis?.noteRange) {
      displayMin = Math.max(0, analysis.noteRange.min - 6);
      displayMax = Math.min(127, analysis.noteRange.max + 6);
    }
    if (instrument?.note_range_min != null && instrument?.note_range_max != null) {
      displayMin = Math.min(displayMin, Math.max(0, instrument.note_range_min - 6));
      displayMax = Math.max(displayMax, Math.min(127, instrument.note_range_max + 6));
    }

    // Clamp to reasonable range
    const noteCount = displayMax - displayMin + 1;
    if (noteCount > 80) {
      displayMin = 21; // A0
      displayMax = 108; // C8
    }

    const keys = [];
    for (let n = displayMin; n <= displayMax; n++) {
      const isBlack = this.isBlackKey(n);
      const isUsed = analysis?.noteDistribution ? (analysis.noteDistribution[n] > 0) : false;
      const isInRange = instrument ? this.isNoteInInstrumentRange(n, instrument) : false;

      let cls = 'aa-mini-key';
      if (isBlack) cls += ' black';
      if (isUsed && isInRange) cls += ' used-ok';
      else if (isUsed) cls += ' used-out';
      else if (isInRange) cls += ' in-range';

      keys.push(`<div class="${cls}" title="${this.midiNoteToName(n)}"></div>`);
    }

    return `
      <div class="aa-mini-piano-wrapper">
        <div class="aa-mini-piano">${keys.join('')}</div>
        <div class="aa-mini-piano-legend">
          ${analysis ? `<span class="aa-mini-legend used-ok">${_t('autoAssign.legendInRange')}</span>
                        <span class="aa-mini-legend used-out">${_t('autoAssign.legendOutOfRange')}</span>` : ''}
          ${instrument ? `<span class="aa-mini-legend in-range">${_t('autoAssign.legendAvailable')}</span>` : ''}
        </div>
      </div>
    `;
  };

  // ========================================================================
  // HELPERS
  // ========================================================================

  /**
   * Find an instrument by ID in the instrumentList
   */
  AutoAssignPanelsMixin._findInstrument = function(instrumentId) {
    if (!this.instrumentList) return null;
    return this.instrumentList.find(inst => inst.id === instrumentId) || null;
  };

  /**
   * Open the InstrumentSettingsModal for a given instrument
   */
  AutoAssignPanelsMixin.openInstrumentSettings = function(instrumentId) {
    const inst = this._findInstrument(instrumentId);
    if (!inst) return;

    // Try global function, or InstrumentSettingsModal directly
    if (typeof window.openInstrumentSettings === 'function') {
      window.openInstrumentSettings(inst.device_id, inst.channel);
    } else if (typeof window.InstrumentSettingsModal !== 'undefined' && this.apiClient) {
      const settingsModal = new window.InstrumentSettingsModal(this.apiClient);
      settingsModal.show(inst.id);
    } else if (typeof showToast === 'function') {
      showToast(_t('autoAssign.matrix.settingsNotAvailable'), 'warning');
    }
  };

  // Expose mixin
  if (typeof window !== 'undefined') {
    window.AutoAssignPanelsMixin = AutoAssignPanelsMixin;
  }
})();
