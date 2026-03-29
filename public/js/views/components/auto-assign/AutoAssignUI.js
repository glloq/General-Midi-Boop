// Auto-extracted from AutoAssignModal.js
(function() {
    'use strict';
    const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    const AutoAssignUIMixin = {};


  // ========================================================================
  // TAB-BASED UI
  // ========================================================================

  /**
   * Main UI: tabs for each channel + content area
   */
    AutoAssignUIMixin.showTabbedUI = function() {
    if (this.modal) this.modal.remove();
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
    }

    const tabsHTML = this.channels.map(ch => {
      const channel = parseInt(ch);
      const isActive = channel === this.activeTab;
      const isSkipped = this.skippedChannels.has(channel);
      const isSplit = this.isSplitChannel(channel);
      const assignment = this.selectedAssignments[ch];
      const score = isSplit ? (this.splitAssignments[channel]?.quality || 0) : (assignment?.score || 0);
      const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (this.getGmProgramName(analysis?.primaryProgram) || '');
      // Truncate long names for tab display
      const gmShort = gmName.length > 14 ? gmName.slice(0, 13) + '…' : gmName;

      return `
        <button class="aa-tab ${isActive ? 'active' : ''} ${isSkipped ? 'skipped' : ''} ${isSplit ? 'split' : ''}"
                role="tab"
                aria-selected="${isActive}"
                aria-controls="aaTabContent"
                tabindex="${isActive ? '0' : '-1'}"
                data-channel="${channel}"
                onclick="autoAssignModalInstance.switchTab(${channel})"
                title="${escapeHtml(gmName)}">
          <div class="aa-tab-main">
            <span class="aa-tab-label">Ch ${channel + 1}</span>
            ${channel === 9 ? '<span class="aa-tab-drum">DR</span>' : ''}
            ${isSplit ? '<span class="aa-tab-split">SP</span>' : ''}
            ${isSkipped
              ? '<span class="aa-tab-status skipped">—</span>'
              : `<span class="aa-tab-status" style="color: ${this.getScoreColor(score)}">${score}</span>`
            }
          </div>
          ${gmShort ? `<div class="aa-tab-gm">${escapeHtml(gmShort)}</div>` : ''}
        </button>
      `;
    }).join('');

    const activeCount = this.channels.length - this.skippedChannels.size;

    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal">
        <div class="modal-container aa-container">
          <div class="modal-header">
            <div class="aa-header-content">
              <div class="aa-header-top">
                <h2>${_t('autoAssign.title')}</h2>
                <div class="aa-header-stats">
                  <span class="aa-confidence" style="color: ${this.getScoreColor(this.confidenceScore)}">
                    ${this.getScoreStars(this.confidenceScore)} ${this.confidenceScore}/100 — ${this.getScoreLabel(this.confidenceScore)}
                  </span>
                  <span class="aa-channel-count">
                    ${_t('autoAssign.channelsWillBeAssigned', {active: activeCount, total: this.channels.length})}
                  </span>
                </div>
                <div class="aa-view-toggle">
                  <button class="aa-view-btn ${this.viewMode === 'overview' ? 'active' : ''}"
                          onclick="autoAssignModalInstance.setViewMode('overview')">
                    ${_t('autoAssign.overviewTitle')}
                  </button>
                  <button class="aa-view-btn ${this.viewMode === 'detail' ? 'active' : ''}"
                          onclick="autoAssignModalInstance.setViewMode('detail')">
                    ${_t('autoAssign.overviewDetail')}
                  </button>
                </div>
              </div>
              <div class="aa-header-range" id="aaRangeBar">
                ${this.renderRangeBar(this.activeTab)}
              </div>
            </div>
            <button class="modal-close" onclick="autoAssignModalInstance.close()">x</button>
          </div>

          ${this.viewMode === 'detail' ? `
            <div class="aa-tabs-bar" role="tablist" aria-label="${_t('autoAssign.title')}">
              ${tabsHTML}
            </div>

            <div class="aa-channel-sticky" id="aaChannelSticky">
              ${this.renderChannelStickyHeader(this.activeTab)}
            </div>

            <div class="modal-body aa-body" id="aaTabContent" role="tabpanel" aria-live="polite">
              ${this.renderTabContent(this.activeTab)}
            </div>
          ` : `
            <div class="modal-body aa-body" id="aaTabContent" role="region" aria-live="polite">
              ${this.renderOverviewTable()}
            </div>
          `}

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

    // Keyboard navigation for tabs (arrow keys)
    this._tabKeyHandler = (e) => {
      const tabsBar = this.modal?.querySelector('.aa-tabs-bar');
      if (!tabsBar || !tabsBar.contains(document.activeElement)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

      e.preventDefault();
      const currentIndex = this.channels.indexOf(String(this.activeTab));
      let newIndex;
      if (e.key === 'ArrowRight') {
        newIndex = (currentIndex + 1) % this.channels.length;
      } else {
        newIndex = (currentIndex - 1 + this.channels.length) % this.channels.length;
      }
      const newChannel = parseInt(this.channels[newIndex]);
      this.switchTab(newChannel);
      // Focus the new tab
      const newTab = tabsBar.querySelector(`[data-channel="${newChannel}"]`);
      if (newTab) newTab.focus();
    };
    document.addEventListener('keydown', this._tabKeyHandler);

    // Focus trap using a11y utility if available
    if (typeof window.a11y !== 'undefined' && typeof window.a11y.trapFocus === 'function') {
      this._focusTrap = window.a11y.trapFocus(this.modal);
    }
  }

  /**
   * Switch to a different channel tab
   */
    AutoAssignUIMixin.switchTab = function(channel) {
    if (!this.modal) return;
    this.activeTab = channel;
    // Update tab active states
    const tabs = this.modal.querySelectorAll('.aa-tab');
    tabs.forEach(tab => {
      const ch = parseInt(tab.dataset.channel);
      const isActive = ch === channel;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    // Update sticky header
    this.refreshStickyHeader();
    // Update content
    const content = document.getElementById('aaTabContent');
    if (content) {
      content.innerHTML = this.renderTabContent(channel);
    }
    // Update preview button
    this.updatePreviewButton(channel);
  }

  /**
   * Render the overview summary table for all channels
   */
    AutoAssignUIMixin.renderOverviewTable = function() {
    const rows = this.channels.map(ch => {
      const channel = parseInt(ch);
      const isSkipped = this.skippedChannels.has(channel);
      const isSplit = this.isSplitChannel(channel);
      const assignment = this.selectedAssignments[ch];
      const score = isSplit ? (this.splitAssignments[channel]?.quality || 0) : (assignment?.score || 0);
      const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;

      // Original MIDI instrument
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (this.getGmProgramName(analysis?.primaryProgram) || '—');

      // Assigned instrument(s)
      let assignedName;
      if (isSplit && this.splitAssignments[channel]) {
        const segments = this.splitAssignments[channel].segments || [];
        assignedName = segments.map(seg => {
          const name = seg.instrumentName || 'Instrument';
          const range = seg.noteRange ? `(${this.midiNoteToName(seg.noteRange.min)}-${this.midiNoteToName(seg.noteRange.max)})` : '';
          return `${name} ${range}`;
        }).join(' + ');
      } else {
        assignedName = assignment?.customName || assignment?.instrumentName || '—';
      }

      // Status
      let statusIcon, statusClass, statusLabel;
      if (isSkipped) {
        statusIcon = '—';
        statusClass = 'skipped';
        statusLabel = _t('autoAssign.overviewStatusSkipped');
      } else if (score >= 70) {
        statusIcon = '&#10003;';
        statusClass = 'ok';
        statusLabel = _t('autoAssign.overviewStatusOk');
      } else {
        statusIcon = '!';
        statusClass = 'warning';
        statusLabel = _t('autoAssign.overviewStatusWarning');
      }

      const typeIcon = analysis?.estimatedType ? this.getTypeIcon(analysis.estimatedType) : '';

      return `
        <tr class="aa-overview-row ${isSkipped ? 'skipped' : ''} ${statusClass}"
            onclick="autoAssignModalInstance.overviewGoToChannel(${channel})">
          <td class="aa-ov-ch">${typeIcon} Ch ${channel + 1}${channel === 9 ? ' <span class="aa-tab-drum">DR</span>' : ''}</td>
          <td class="aa-ov-original">${escapeHtml(gmName)}</td>
          <td class="aa-ov-assigned">${isSkipped ? `<span class="aa-ov-skipped">${statusLabel}</span>` : escapeHtml(assignedName)}</td>
          <td class="aa-ov-score">
            ${isSkipped ? '—' : `
              <div class="aa-ov-score-bar">
                <div class="aa-ov-score-fill" style="width: ${score}%; background: ${this.getScoreColor(score)}"></div>
              </div>
              <span style="color: ${this.getScoreColor(score)}">${score} — ${this.getScoreLabel(score)}</span>
            `}
          </td>
          <td class="aa-ov-status">
            <span class="aa-ov-status-icon ${statusClass}">${statusIcon}</span>
          </td>
        </tr>
      `;
    }).join('');

    // Check if all channels are good
    const allGood = this.channels.every(ch => {
      const channel = parseInt(ch);
      return this.skippedChannels.has(channel) || (this.selectedAssignments[ch]?.score || 0) >= 70;
    });

    return `
      <div class="aa-overview">
        ${allGood ? `<div class="aa-overview-banner ok">${_t('autoAssign.overviewAllGood')}</div>` : ''}
        <table class="aa-overview-table">
          <thead>
            <tr>
              <th>${_t('autoAssign.overviewChannel')}</th>
              <th>${_t('autoAssign.overviewOriginal')}</th>
              <th>${_t('autoAssign.overviewAssigned')}</th>
              <th>${_t('autoAssign.overviewScore')}</th>
              <th>${_t('autoAssign.overviewStatus')}</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Render sticky channel header (stays visible while scrolling)
   * Contains: channel title + original MIDI instrument
   */
    AutoAssignUIMixin.renderChannelStickyHeader = function(channel) {
    const ch = String(channel);
    const isSkipped = this.skippedChannels.has(channel);
    const analysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[channel];

    // Original MIDI instrument from the file
    const primaryProgram = analysis?.primaryProgram;
    const midiInstrumentName = channel === 9
      ? _t('autoAssign.drums')
      : this.getGmProgramName(primaryProgram);
    const midiInstrumentHTML = midiInstrumentName
      ? `<span class="aa-midi-instrument" title="MIDI: ${primaryProgram != null ? escapeHtml(this.getGmProgramName(primaryProgram) || 'Program ' + primaryProgram) : 'Drums'}">${escapeHtml(midiInstrumentName)}</span>`
      : '';

    const isAutoSkipped = this.autoSkippedChannels && this.autoSkippedChannels.has(channel);

    return `
      <div class="aa-channel-header">
        <h3>${_t('autoAssign.channel')} ${channel + 1}
          ${channel === 9 ? `<span class="aa-drum-badge">(MIDI 10)</span>` : ''}
          ${midiInstrumentHTML}
          ${isSkipped && isAutoSkipped
            ? `<span class="aa-autoskip-badge">[${_t('autoAssign.autoSkippedLabel')}]</span>`
            : isSkipped ? `<span class="aa-skipped-badge">[${_t('autoAssign.skippedLabel')}]</span>` : ''}
        </h3>
      </div>
    `;
  }

    AutoAssignUIMixin.renderTabContent = function(channel) {
    const ch = String(channel);
    const options = this.suggestions[ch] || [];
    const isSkipped = this.skippedChannels.has(channel);
    const selectedInstrumentId = this.selectedAssignments[ch]?.instrumentId;
    const analysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch];
    const adaptation = this.adaptationSettings[ch] || {};
    const assignment = this.selectedAssignments[ch];
    const score = assignment?.score || 0;

    // Progressive disclosure: channels with score >= 80 show compact by default
    const isWellAssigned = score >= 80 && !isSkipped && selectedInstrumentId;
    const isExpanded = this.channelDetailsExpanded[ch] !== undefined
      ? this.channelDetailsExpanded[ch]
      : !isWellAssigned; // Auto-expand problematic channels

    // Compact view for well-assigned channels
    if (isWellAssigned && !isExpanded) {
      const assignedName = assignment?.customName || assignment?.instrumentName || '—';
      return `
        <div class="aa-tab-content">
          <div class="aa-compact-summary">
            <div class="aa-compact-info">
              <span class="aa-compact-instrument">${escapeHtml(assignedName)}</span>
              <span class="aa-compact-score" style="color: ${this.getScoreColor(score)}">
                ${this.getScoreStars(score)} ${score} — ${this.getScoreLabel(score)}
              </span>
            </div>
            <button class="aa-compact-expand" onclick="autoAssignModalInstance.toggleChannelDetails(${channel})">
              ${_t('autoAssign.viewDetails')} &#9660;
            </button>
          </div>
          ${this.renderChannelStats(channel, analysis)}
        </div>
      `;
    }

    // Channel stats section
    const statsHTML = this.renderChannelStats(channel, analysis);

    // Collapse button for expanded well-assigned channels
    const collapseHTML = isWellAssigned ? `
      <button class="aa-compact-collapse" onclick="autoAssignModalInstance.toggleChannelDetails(${channel})">
        ${_t('autoAssign.hideSection')} &#9650;
      </button>
    ` : '';

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
                return this.renderInstrumentOption(channel, option, index, selectedInstrumentId, true);
              }).join('')}
            </div>
          ` : ''}
        </div>
      ` : '';

      // Split proposal for channels with no single-instrument match
      const splitHTML = this.renderSplitProposal ? this.renderSplitProposal(channel) : '';

      return `
        <div class="aa-tab-content">
          ${statsHTML}
          ${skipHTML}
          ${splitHTML || `<p class="aa-no-compatible">${_t('autoAssign.noCompatible')}</p>`}
          ${fallbackHTML}
        </div>
      `;
    }

    // Instrument options
    const optionsHTML = isSkipped ? '' : options.map((option, index) => {
      return this.renderInstrumentOption(channel, option, index, selectedInstrumentId, false);
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
              return this.renderInstrumentOption(channel, option, options.length + index, selectedInstrumentId, true);
            }).join('')}
          </div>
        ` : ''}
      </div>
    ` : '';

    // Adaptation controls (only if not skipped and instrument selected)
    const adaptationHTML = (!isSkipped && selectedInstrumentId) ? this.renderAdaptationControls(channel, adaptation) : '';

    // Drum mapping config section (only for channel 9 or percussion-type channels)
    const isDrumChannel = channel === 9 || (analysis && analysis.estimatedType === 'drums');
    const drumMappingHTML = (!isSkipped && isDrumChannel && selectedInstrumentId) ? this.renderDrumMappingSection(channel) : '';

    // Split proposal (show if available and channel has suggestions)
    const splitProposalHTML = this.renderSplitProposal ? this.renderSplitProposal(channel) : '';

    return `
      <div class="aa-tab-content">
        ${collapseHTML}
        ${statsHTML}
        ${skipHTML}
        ${this.isSplitChannel(channel) ? splitProposalHTML : `
          <div class="aa-instruments-list">
            ${optionsHTML}
          </div>
          ${lowScoreHTML}
          ${adaptationHTML}
          ${drumMappingHTML}
          ${splitProposalHTML}
        `}
      </div>
    `;
  }

  /**
   * Render channel statistics
   */
    AutoAssignUIMixin.renderChannelStats = function(channel, analysis) {
    if (!analysis) return '';

    const noteRange = analysis.noteRange || {};
    const polyphony = analysis.polyphony || {};
    const typeIcon = this.getTypeIcon(analysis.estimatedType);
    const typeLabel = analysis.estimatedType ? _t(`autoAssign.type_${analysis.estimatedType}`, { _: analysis.estimatedType }) : 'N/A';

    return `
      <div class="aa-channel-stats">
        <div class="aa-stat">
          <strong>${_t('autoAssign.noteRange')}:</strong>
          ${noteRange.min != null ? `${this.midiNoteToName(noteRange.min)} — ${this.midiNoteToName(noteRange.max)} <span class="aa-stat-detail">(${noteRange.max - noteRange.min} ${_t('autoAssign.semitones')})</span>` : 'N/A'}
        </div>
        <div class="aa-stat">
          <strong>${_t('autoAssign.polyphony')}:</strong>
          ${this.getPolyphonyLabel(polyphony)}
        </div>
        <div class="aa-stat">
          <span class="aa-type-icon">${typeIcon}</span>
          <strong>${_t('autoAssign.type')}:</strong>
          ${escapeHtml(typeLabel)} ${analysis.typeConfidence ? `<span class="aa-stat-detail">(${analysis.typeConfidence}%)</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render adaptation controls for a channel with strategy selector
   */
    AutoAssignUIMixin.renderAdaptationControls = function(channel, adaptation) {
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

    if (typeof window !== 'undefined') window.AutoAssignUIMixin = AutoAssignUIMixin;
})();
