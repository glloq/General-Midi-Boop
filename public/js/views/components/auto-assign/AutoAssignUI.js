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
              : `<span class="aa-tab-status ${this.getScoreClass(score)}">${score}</span>`
            }
          </div>
          ${gmShort ? `<div class="aa-tab-gm">${escapeHtml(gmShort)}</div>` : ''}
        </button>
      `;
    }).join('');

    const activeCount = this.channels.length - this.skippedChannels.size;

    const html = `
      <div class="modal-overlay auto-assign-modal" id="autoAssignModal" role="dialog" aria-modal="true" aria-label="${_t('autoAssign.title')}">
        <div class="modal-container aa-container">
          <div class="modal-header">
            <div class="aa-header-content">
              <div class="aa-header-top">
                <h2>${_t('autoAssign.title')}</h2>
                <div class="aa-header-stats">
                  <span class="aa-confidence ${this.getScoreClass(this.confidenceScore)}">
                    ${this.getScoreStars(this.confidenceScore)} ${this.confidenceScore}/100 — ${this.getScoreLabel(this.confidenceScore)}
                  </span>
                  <span class="aa-channel-count">
                    ${_t('autoAssign.channelsWillBeAssigned', {active: activeCount, total: this.channels.length})}
                  </span>
                </div>
                <div class="aa-view-toggle">
                  <button class="aa-view-btn ${this.viewMode === 'matrix' ? 'active' : ''}"
                          onclick="autoAssignModalInstance.setViewMode('matrix')">
                    ${_t('autoAssign.matrix.title')}
                  </button>
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
            <button class="modal-close" onclick="autoAssignModalInstance.close()" aria-label="${_t('common.close')}">&times;</button>
          </div>

          ${this.viewMode === 'matrix' && typeof this.renderMatrixView === 'function' ? `
            <div class="modal-body aa-body aa-body-matrix" id="aaTabContent" role="region" aria-live="polite">
              ${this.renderMatrixView()}
            </div>
          ` : this.viewMode === 'detail' ? `
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
            ${this.viewMode !== 'matrix' ? `
              <div class="aa-footer-center">
                ${this.midiData ? `
                  <button class="btn aa-btn-preview-original" onclick="autoAssignModalInstance.previewOriginal(${this.activeTab})" title="${_t('autoAssign.previewOriginalTip')}">
                    ${_t('autoAssign.previewOriginal')}
                  </button>
                  <button class="btn" onclick="autoAssignModalInstance.previewChannel(${this.activeTab})" title="${_t('autoAssign.previewChannelTip')}">
                    ${_t('autoAssign.previewChannel', {num: this.activeTab + 1})}
                  </button>
                  <button class="btn" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                    ${_t('autoAssign.stop')}
                  </button>
                ` : ''}
              </div>
            ` : `
              <div class="aa-footer-center">
                <span class="aa-footer-info">
                  ${_t('autoAssign.matrix.clickToAssign')}
                </span>
              </div>
            `}
            <div class="aa-footer-right">
              ${Object.keys(this.splitProposals).filter(ch => !this.splitChannels.has(Number(ch))).length > 0 ? `
                <button class="btn" onclick="autoAssignModalInstance.acceptAllSplits()">
                  ${_t('autoAssign.acceptAllSplits')}
                </button>
              ` : ''}
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

    // Prevent body scrolling while modal is open
    this._prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    this._escHandler = (e) => {
      if (e.key === 'Escape') {
        // In detail view, go back to matrix; in overview, go back to matrix; in matrix, close
        if (this.viewMode === 'detail' || this.viewMode === 'overview') {
          e.preventDefault();
          this.setViewMode('matrix');
        } else {
          this.close();
        }
      }
    };
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
    // Scroll active tab into view
    const activeTabEl = this.modal.querySelector('.aa-tab.active');
    if (activeTabEl) activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
      const hasSplitProposal = !!this.splitProposals[channel];
      let statusIcon, statusClass, statusLabel;
      if (isSkipped) {
        statusIcon = '—';
        statusClass = 'skipped';
        statusLabel = _t('autoAssign.overviewStatusSkipped');
      } else if (isSplit) {
        statusIcon = '&#8645;';
        statusClass = 'ok';
        statusLabel = _t('autoAssign.splitProposed');
      } else if (score >= 70) {
        statusIcon = '&#10003;';
        statusClass = 'ok';
        statusLabel = _t('autoAssign.overviewStatusOk');
      } else {
        statusIcon = '!';
        statusClass = 'warning';
        statusLabel = _t('autoAssign.overviewStatusWarning');
      }

      // Badge for split availability (not yet accepted)
      const splitBadge = (hasSplitProposal && !isSplit && !isSkipped)
        ? '<span class="aa-tab-split" title="' + _t('autoAssign.splitProposed') + '">SP</span>'
        : (isSplit ? '<span class="aa-tab-split active" title="' + _t('autoAssign.splitProposed') + '">SP</span>' : '');

      const typeIcon = analysis?.estimatedType ? this.getTypeIcon(analysis.estimatedType) : '';

      // Strategy badge for assigned channels
      const adapt = this.adaptationSettings[ch] || {};
      const strategyBadgeMap = { transpose: 'T', octaveWrap: 'W', suppress: 'S' };
      const strategyTitleMap = { transpose: _t('autoAssign.strategyTranspose'), octaveWrap: _t('autoAssign.strategyOctaveWrap'), suppress: _t('autoAssign.strategySuppress') };
      const strategyBadge = (!isSkipped && !isSplit && adapt.strategy && strategyBadgeMap[adapt.strategy])
        ? `<span class="aa-ov-strategy-badge" title="${strategyTitleMap[adapt.strategy]}">${strategyBadgeMap[adapt.strategy]}</span>`
        : '';

      return `
        <tr class="aa-overview-row ${isSkipped ? 'skipped' : ''} ${statusClass}"
            tabindex="0" role="button"
            onclick="autoAssignModalInstance.overviewGoToChannel(${channel})"
            onkeydown="if(event.key==='Enter')autoAssignModalInstance.overviewGoToChannel(${channel})">
          <td class="aa-ov-ch">${typeIcon} Ch ${channel + 1}${channel === 9 ? ' <span class="aa-tab-drum">DR</span>' : ''} ${splitBadge}</td>
          <td class="aa-ov-original">${escapeHtml(gmName)}</td>
          <td class="aa-ov-assigned">${isSkipped ? `<span class="aa-ov-skipped">${statusLabel}</span>` : `${escapeHtml(assignedName)} ${strategyBadge}${
            (!isSplit && assignment?.instrumentId && this.getOtherChannelsUsingInstrument(assignment.instrumentId, channel).length > 0)
              ? ` <span class="aa-duplicate-badge" title="${_t('autoAssign.duplicateInstrumentTip', {channels: this.getOtherChannelsUsingInstrument(assignment.instrumentId, channel).join(', ')})}">!</span>`
              : ''
          }`}</td>
          <td class="aa-ov-score">
            ${isSkipped ? '—' : `
              <div class="aa-ov-score-bar">
                <div class="aa-ov-score-fill ${this.getScoreBgClass(score)}" style="width: ${score}%"></div>
              </div>
              <span class="${this.getScoreClass(score)}">${score} — ${this.getScoreLabel(score)}</span>
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

    // Check if ALL channels are skipped (no instruments available)
    const allSkipped = this.channels.every(ch => this.skippedChannels.has(parseInt(ch)));
    const allSkippedHTML = allSkipped ? `
      <div class="aa-overview-banner warning">
        ${_t('autoAssign.allChannelsSkipped')}
      </div>
    ` : '';

    // Count available (non-accepted) split proposals
    const pendingSplitChannels = Object.keys(this.splitProposals)
      .map(Number)
      .filter(ch => !this.splitChannels.has(ch));
    const splitBannerHTML = pendingSplitChannels.length > 0 ? `
      <div class="aa-overview-banner split">
        <span>&#8645; ${_t('autoAssign.splitAvailableBanner', {count: pendingSplitChannels.length})}</span>
        <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.overviewGoToChannel(${pendingSplitChannels[0]})">
          ${_t('autoAssign.reviewSplits')}
        </button>
      </div>
    ` : '';

    return `
      <div class="aa-overview">
        ${allSkippedHTML}
        ${allGood && !allSkipped ? `<div class="aa-overview-banner ok">${_t('autoAssign.overviewAllGood')}</div>` : ''}
        ${splitBannerHTML}
        <div class="aa-overview-table-wrapper">
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
    const isSplit = this.isSplitChannel(channel);
    const headerAdaptation = this.adaptationSettings[ch] || {};
    const headerStrategy = headerAdaptation.strategy || 'ignore';
    const strategyLabels = { transpose: _t('autoAssign.strategyTranspose'), octaveWrap: _t('autoAssign.strategyOctaveWrap'), suppress: _t('autoAssign.strategySuppress') };
    const strategyBadgeHTML = (!isSkipped && !isSplit && strategyLabels[headerStrategy])
      ? `<span class="aa-ov-strategy-badge">${strategyLabels[headerStrategy]}</span>`
      : (isSplit ? `<span class="aa-ov-strategy-badge">${_t('autoAssign.splitProposed')}</span>` : '');

    return `
      <div class="aa-channel-header">
        <h3>${_t('autoAssign.channel')} ${channel + 1}
          ${channel === 9 ? `<span class="aa-drum-badge">(MIDI 10)</span>` : ''}
          ${midiInstrumentHTML}
          ${strategyBadgeHTML}
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
      const compactStrategy = adaptation.strategy || 'ignore';

      // Show adaptation result in compact view if a strategy is active
      let compactResultHTML = '';
      if (compactStrategy !== 'ignore') {
        const result = this.calculateAdaptationResult(channel, compactStrategy);
        if (result.totalNotes > 0) {
          const playable = result.inRange + result.recovered;
          const allOk = result.outOfRange === 0;
          compactResultHTML = `<span class="aa-compact-adaptation ${allOk ? 'ok' : 'warning'}">${playable}/${result.totalNotes}</span>`;
        }
      }

      return `
        <div class="aa-tab-content">
          <div class="aa-compact-summary">
            <div class="aa-compact-info">
              <span class="aa-compact-instrument">${escapeHtml(assignedName)}</span>
              <span class="aa-compact-score ${this.getScoreClass(score)}">
                ${this.getScoreStars(score)} ${score} — ${this.getScoreLabel(score)}
              </span>
              ${compactResultHTML}
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
          <button class="aa-toggle-low-scores" aria-expanded="${showLow}" onclick="autoAssignModalInstance.toggleLowScores(${channel})">
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
        <button class="aa-toggle-low-scores" aria-expanded="${showLow}" onclick="autoAssignModalInstance.toggleLowScores(${channel})">
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

    // Note range piano roll visualization (only for non-drum channels with an instrument selected)
    const isDrumChannel = channel === 9 || (analysis && analysis.estimatedType === 'drums');
    const semitones = adaptation.transpositionSemitones || 0;
    const noteRangeVizHTML = (!isSkipped && !isDrumChannel && selectedInstrumentId && this.renderNoteRangeViz)
      ? this.renderNoteRangeViz(channel, analysis, assignment, semitones)
      : '';

    // Drum mapping config section (only for channel 9 or percussion-type channels)
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
          ${noteRangeVizHTML}
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

    // Adaptation result feedback (real-time impact of current strategy)
    let adaptationResultHTML = '';
    if (!isDrumChannel && strategy !== 'ignore') {
      const result = this.calculateAdaptationResult(channel, strategy);
      if (result.totalNotes > 0) {
        const allOk = result.outOfRange === 0;
        const playable = result.inRange + result.recovered;
        const pct = Math.round((playable / result.totalNotes) * 100);
        const allLost = playable === 0 && result.totalNotes > 0;
        const resultClass = allLost ? 'critical' : (allOk ? 'ok' : (result.outOfRange > 3 ? 'warning' : 'partial'));
        adaptationResultHTML = `
          <div class="aa-adaptation-result ${resultClass}">
            <div class="aa-adaptation-result-bar">
              <div class="aa-adaptation-result-fill ${allOk ? 'aa-bg-excellent' : (pct >= 80 ? 'aa-bg-good' : (pct >= 60 ? 'aa-bg-fair' : 'aa-bg-poor'))}" style="width: ${Math.max(pct, allLost ? 100 : 0)}%"></div>
            </div>
            <span class="aa-adaptation-result-text">
              ${allOk
                ? `${result.totalNotes}/${result.totalNotes} ${_t('autoAssign.notesPlayable')}`
                : `${playable}/${result.totalNotes} ${_t('autoAssign.notesPlayable')}${result.recovered > 0 ? ` (${result.recovered} ${_t('autoAssign.notesRecovered')})` : ''}${result.outOfRange > 0 ? ` — ${result.outOfRange} ${_t('autoAssign.notesLost')}` : ''}`
              }
            </span>
          </div>
        `;
      }
    }

    return `
      <div class="aa-adaptation-section">
        <h4>${_t('autoAssign.adaptationTitle')}</h4>

        ${strategyHTML}

        <div class="aa-adaptation-controls">
          ${transpoHTML}
          ${drumOffsetHTML}
        </div>

        ${adaptationResultHTML}
      </div>
    `;
  }

    if (typeof window !== 'undefined') window.AutoAssignUIMixin = AutoAssignUIMixin;
})();
