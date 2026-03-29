// Auto-assign Matrix View - Routing matrix (channels × instruments)
(function() {
    'use strict';
    const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    const AutoAssignMatrixMixin = {};

  /**
   * Render the full matrix layout: left panel + matrix grid + right panel
   */
  AutoAssignMatrixMixin.renderMatrixView = function() {
    const hasSelection = this.selectedChannel !== null || this.selectedInstrumentId !== null;

    return `
      <div class="aa-matrix-layout">
        <div class="aa-channel-panel" id="aaChannelPanel">
          ${this.selectedChannel !== null
            ? this.renderChannelPanel(this.selectedChannel)
            : `<div class="aa-panel-placeholder">${_t('autoAssign.matrix.selectChannel')}</div>`
          }
        </div>
        <div class="aa-matrix-center">
          <div class="aa-matrix-grid-wrapper">
            ${this.renderMatrixGrid()}
          </div>
          ${hasSelection ? this.renderMatrixActionBar() : ''}
        </div>
        <div class="aa-instrument-panel" id="aaInstrumentPanel">
          ${this.selectedInstrumentId !== null
            ? this.renderInstrumentPanel(this.selectedInstrumentId)
            : `<div class="aa-panel-placeholder">${_t('autoAssign.matrix.selectInstrument')}</div>`
          }
        </div>
      </div>
    `;
  };

  /**
   * Render the matrix grid (channels as rows, instruments as columns)
   */
  AutoAssignMatrixMixin.renderMatrixGrid = function() {
    const instruments = this.instrumentList || [];
    const channels = this.channels;

    if (instruments.length === 0) {
      return `<div class="aa-matrix-empty">${_t('autoAssign.matrix.noInstruments')}</div>`;
    }

    // Sort instruments: assigned first, then by average score
    const sortedInstruments = this._sortInstrumentsForMatrix(instruments);

    // Column headers (instruments)
    const colHeaders = sortedInstruments.map(inst => {
      const isSelected = this.selectedInstrumentId === inst.id;
      const isAssigned = this._isInstrumentAssigned(inst.id);
      const displayName = inst.custom_name || inst.name || 'Unknown';
      const shortName = displayName.length > 12 ? displayName.slice(0, 11) + '…' : displayName;
      const typeIcon = this.getTypeIcon(inst.instrument_type || '');
      const connectionIcon = this._getConnectionIcon(inst);

      return `
        <th class="aa-matrix-col-header ${isSelected ? 'selected' : ''} ${isAssigned ? 'assigned' : ''}"
            data-instrument-id="${inst.id}"
            onclick="autoAssignModalInstance.selectMatrixInstrument('${inst.id}')"
            title="${escapeHtml(displayName)}${inst.note_range_min != null && inst.note_range_max != null ? '\n' + this.midiNoteToName(inst.note_range_min) + '-' + this.midiNoteToName(inst.note_range_max) : ''}">
          <div class="aa-matrix-inst-header">
            <span class="aa-matrix-inst-icon">${typeIcon}</span>
            <span class="aa-matrix-inst-name">${escapeHtml(shortName)}</span>
            <span class="aa-matrix-inst-conn">${connectionIcon}</span>
          </div>
          ${inst.note_range_min != null && inst.note_range_max != null ? `<div class="aa-matrix-inst-range">${this.midiNoteToName(inst.note_range_min)}-${this.midiNoteToName(inst.note_range_max)}</div>` : ''}
        </th>
      `;
    }).join('');

    // Rows (channels)
    const rows = channels.map(ch => {
      const channel = parseInt(ch);
      const isSelected = this.selectedChannel === channel;
      const isSkipped = this.skippedChannels.has(channel);
      const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (this.getGmProgramName(analysis?.primaryProgram) || '');
      const gmShort = gmName.length > 14 ? gmName.slice(0, 13) + '…' : gmName;
      const typeIcon = analysis?.estimatedType ? this.getTypeIcon(analysis.estimatedType) : '';
      const isSplit = this.isSplitChannel(channel);

      // Row header
      const rowHeader = `
        <th class="aa-matrix-row-header ${isSelected ? 'selected' : ''} ${isSkipped ? 'skipped' : ''}"
            data-channel="${channel}"
            onclick="autoAssignModalInstance.selectMatrixChannel(${channel})"
            title="Canal ${channel + 1}${gmName ? ' - ' + gmName : ''}">
          <div class="aa-matrix-ch-header">
            <span class="aa-matrix-ch-icon">${typeIcon}</span>
            <span class="aa-matrix-ch-label">Ch ${channel + 1}</span>
            ${channel === 9 ? '<span class="aa-tab-drum">DR</span>' : ''}
            ${isSplit ? '<span class="aa-tab-split">SP</span>' : ''}
            ${isSkipped ? '<span class="aa-matrix-skip-badge">—</span>' : ''}
          </div>
          ${gmShort ? `<div class="aa-matrix-ch-gm">${escapeHtml(gmShort)}</div>` : ''}
        </th>
      `;

      // Cells for each instrument
      const cells = sortedInstruments.map(inst => {
        return this._renderMatrixCell(channel, inst, isSkipped);
      }).join('');

      return `<tr class="${isSkipped ? 'aa-matrix-row-skipped' : ''}">${rowHeader}${cells}</tr>`;
    }).join('');

    return `
      <div class="aa-matrix-scroll">
        <table class="aa-matrix-table">
          <thead>
            <tr>
              <th class="aa-matrix-corner">
                <span class="aa-matrix-corner-label">${_t('autoAssign.matrix.channelsVsInstruments')}</span>
              </th>
              ${colHeaders}
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  };

  /**
   * Render a single matrix cell
   */
  AutoAssignMatrixMixin._renderMatrixCell = function(channel, instrument, isSkipped) {
    const ch = String(channel);
    const matrixData = this.matrixScores?.[channel]?.[instrument.id];
    const score = matrixData?.score ?? 0;
    const isIncompatible = matrixData?.incompatible === true;
    const currentAssignment = this.selectedAssignments[ch];
    const isAssigned = currentAssignment?.instrumentId === instrument.id;
    const hasTransposition = matrixData?.transposition?.semitones && matrixData.transposition.semitones !== 0;

    if (isIncompatible) {
      return `
        <td class="aa-matrix-cell incompatible"
            title="${_t('autoAssign.matrix.incompatible')}">
          <span class="aa-matrix-cell-x">✕</span>
        </td>
      `;
    }

    if (isSkipped && !isAssigned) {
      return `
        <td class="aa-matrix-cell skipped ${this._getScoreCellClass(score)}"
            onclick="autoAssignModalInstance.assignFromMatrix(${channel}, '${instrument.id}')"
            title="${score}/100">
          <span class="aa-matrix-cell-score">${score}</span>
        </td>
      `;
    }

    return `
      <td class="aa-matrix-cell ${this._getScoreCellClass(score)} ${isAssigned ? 'assigned' : ''}"
          onclick="autoAssignModalInstance.assignFromMatrix(${channel}, '${instrument.id}')"
          ondblclick="autoAssignModalInstance.goToDetailFromMatrix(${channel})"
          title="${score}/100${hasTransposition ? ' (T:' + matrixData.transposition.semitones + ')' : ''}${matrixData?.issues?.length ? '\n' + matrixData.issues.join(', ') : ''}">
        ${isAssigned ? '<span class="aa-matrix-check">✓</span>' : ''}
        <span class="aa-matrix-cell-score">${score}</span>
        ${hasTransposition ? '<span class="aa-matrix-cell-badge">T</span>' : ''}
      </td>
    `;
  };

  /**
   * Render the contextual action bar below the matrix
   */
  AutoAssignMatrixMixin.renderMatrixActionBar = function() {
    const ch = String(this.selectedChannel);
    const assignment = this.selectedAssignments[ch];
    const isSkipped = this.selectedChannel !== null && this.skippedChannels.has(this.selectedChannel);
    const adaptation = this.adaptationSettings[ch] || {};
    const strategy = adaptation.strategy || 'ignore';

    return `
      <div class="aa-matrix-action-bar">
        ${this.selectedChannel !== null ? `
          <div class="aa-matrix-action-group">
            <span class="aa-matrix-action-label">Ch ${this.selectedChannel + 1}</span>

            ${assignment ? `
              <div class="aa-matrix-action-item">
                <label>${_t('autoAssign.adaptationStrategy')}</label>
                <select class="aa-matrix-strategy-select" onchange="autoAssignModalInstance.setMatrixStrategy(${this.selectedChannel}, this.value)">
                  <option value="ignore" ${strategy === 'ignore' ? 'selected' : ''}>${_t('autoAssign.strategyIgnore')}</option>
                  <option value="transpose" ${strategy === 'transpose' ? 'selected' : ''}>${_t('autoAssign.strategyTranspose')}</option>
                  <option value="octaveWrap" ${strategy === 'octaveWrap' ? 'selected' : ''}>${_t('autoAssign.strategyOctaveWrap')}</option>
                  <option value="suppress" ${strategy === 'suppress' ? 'selected' : ''}>${_t('autoAssign.strategySuppress')}</option>
                </select>
              </div>

              ${strategy === 'transpose' ? `
                <div class="aa-matrix-action-item">
                  <label>${_t('autoAssign.transposition')}</label>
                  <input type="range" min="-24" max="24" value="${adaptation.transpositionSemitones || 0}"
                         class="aa-matrix-transpose-slider"
                         oninput="autoAssignModalInstance.setMatrixTransposition(${this.selectedChannel}, parseInt(this.value))"
                         title="${(adaptation.transpositionSemitones || 0) > 0 ? '+' : ''}${adaptation.transpositionSemitones || 0} ${_t('autoAssign.semitones')}">
                  <span class="aa-matrix-transpose-value">${(adaptation.transpositionSemitones || 0) > 0 ? '+' : ''}${adaptation.transpositionSemitones || 0}</span>
                </div>
              ` : ''}
            ` : ''}

            <div class="aa-matrix-action-buttons">
              ${this.midiData ? `
                <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.previewOriginal(${this.selectedChannel})"
                        title="${_t('autoAssign.previewOriginalTip')}">
                  ${_t('autoAssign.previewOriginal')}
                </button>
                ${assignment ? `
                  <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.previewChannel(${this.selectedChannel})"
                          title="${_t('autoAssign.previewChannelTip')}">
                    ${_t('autoAssign.previewChannel', {num: this.selectedChannel + 1})}
                  </button>
                ` : ''}
                <button class="btn aa-btn-sm" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                  ${_t('autoAssign.stop')}
                </button>
              ` : ''}

              <button class="btn aa-btn-sm ${isSkipped ? 'active' : ''}"
                      onclick="autoAssignModalInstance.toggleSkipChannel(${this.selectedChannel})"
                      title="${isSkipped ? _t('autoAssign.unskipChannel') : _t('autoAssign.skipChannel')}">
                ${isSkipped ? _t('autoAssign.unskipChannel') : _t('autoAssign.skipChannel')}
              </button>

              <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.goToDetailFromMatrix(${this.selectedChannel})"
                      title="${_t('autoAssign.matrix.goToDetail')}">
                ${_t('autoAssign.matrix.goToDetail')}
              </button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  };

  /**
   * Sort instruments for matrix display: assigned first, then by average score
   */
  AutoAssignMatrixMixin._sortInstrumentsForMatrix = function(instruments) {
    const assignedIds = new Set(
      Object.values(this.selectedAssignments)
        .filter(a => a && typeof a === 'object')
        .map(a => a.instrumentId)
    );

    return [...instruments].sort((a, b) => {
      const aAssigned = assignedIds.has(a.id) ? 1 : 0;
      const bAssigned = assignedIds.has(b.id) ? 1 : 0;
      if (aAssigned !== bAssigned) return bAssigned - aAssigned;

      // Then by average score across all channels
      const aAvg = this._getInstrumentAverageScore(a.id);
      const bAvg = this._getInstrumentAverageScore(b.id);
      return bAvg - aAvg;
    });
  };

  /**
   * Get average score of an instrument across all channels
   */
  AutoAssignMatrixMixin._getInstrumentAverageScore = function(instrumentId) {
    if (!this.matrixScores) return 0;
    let total = 0, count = 0;
    for (const ch of this.channels) {
      const data = this.matrixScores[parseInt(ch)]?.[instrumentId];
      if (data && !data.incompatible) {
        total += data.score;
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  };

  /**
   * Check if an instrument is currently assigned to any channel
   */
  AutoAssignMatrixMixin._isInstrumentAssigned = function(instrumentId) {
    return Object.values(this.selectedAssignments).some(
      a => a && typeof a === 'object' && a.instrumentId === instrumentId
    );
  };

  /**
   * Get CSS class for a score cell background
   */
  AutoAssignMatrixMixin._getScoreCellClass = function(score) {
    if (score >= 80) return 'score-excellent';
    if (score >= 60) return 'score-good';
    if (score >= 40) return 'score-fair';
    return 'score-poor';
  };

  /**
   * Get connection type icon for an instrument
   */
  AutoAssignMatrixMixin._getConnectionIcon = function(inst) {
    if (inst.mac_address) return '<span title="Bluetooth">BT</span>';
    if (inst.usb_serial_number) return '<span title="USB">USB</span>';
    if (inst.device_id?.startsWith('virtual_')) return '<span title="Virtual">V</span>';
    if (inst.device_id?.startsWith('network_')) return '<span title="Network">NET</span>';
    return '';
  };

  /**
   * Refresh matrix view (re-render just the grid and panels)
   */
  AutoAssignMatrixMixin.refreshMatrixView = function() {
    if (!this.modal || this.viewMode !== 'matrix') return;

    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderMatrixView();
    }
  };

  // Expose mixin
  if (typeof window !== 'undefined') {
    window.AutoAssignMatrixMixin = AutoAssignMatrixMixin;
  }
})();
