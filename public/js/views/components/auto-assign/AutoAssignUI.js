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

    const activeCount = this.channels.length - this.skippedChannels.size;
    const activeChannel = this.activeChannel != null ? this.activeChannel : this.activeTab;

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
              </div>
              <div class="aa-header-range" id="aaRangeBar">
                ${this.renderRangeBar(activeChannel)}
              </div>
            </div>
            <button class="modal-close" onclick="autoAssignModalInstance.close()" aria-label="${_t('common.close')}">&times;</button>
          </div>

          <div class="aa-bars-container">
            <div class="aa-channel-bar" id="aaChannelBar">
              ${this.renderChannelBar()}
            </div>
            <div class="aa-instrument-bar" id="aaInstrumentBar">
              ${activeChannel !== null ? this.renderInstrumentBar(activeChannel) : `<div class="aa-instbar-placeholder">${_t('autoAssign.overview.selectChannelHint')}</div>`}
            </div>
          </div>

          <div class="modal-body aa-body" id="aaTabContent" role="region" aria-live="polite">
            ${this.renderTabContent(activeChannel)}
          </div>

          <div class="modal-footer aa-footer">
            <button class="btn" onclick="autoAssignModalInstance.close()">
              ${_t('common.cancel')}
            </button>
            <div class="aa-footer-center">
              ${this.midiData ? `
                <button class="btn aa-btn-preview-original" onclick="autoAssignModalInstance.previewOriginal(${activeChannel})" title="${_t('autoAssign.previewOriginalTip')}">
                  ${_t('autoAssign.previewOriginal')}
                </button>
                <button class="btn" onclick="autoAssignModalInstance.previewChannel(${activeChannel})" title="${_t('autoAssign.previewChannelTip')}">
                  ${_t('autoAssign.previewChannel', {num: activeChannel + 1})}
                </button>
                <button class="btn" id="stopPreviewBtn" onclick="autoAssignModalInstance.stopPreview()" style="display: none;">
                  ${_t('autoAssign.stop')}
                </button>
              ` : ''}
            </div>
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
        this.close();
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
            onclick="autoAssignModalInstance.selectOverviewChannel(${channel})"
            onkeydown="if(event.key==='Enter')autoAssignModalInstance.selectOverviewChannel(${channel})">
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
        <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.selectOverviewChannel(${pendingSplitChannels[0]})">
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
    const isSkipped = this.skippedChannels.has(channel);
    const selectedInstrumentId = this.selectedAssignments[ch]?.instrumentId;
    const analysis = this.selectedAssignments[ch]?.channelAnalysis || this.channelAnalyses[ch];
    const adaptation = this.adaptationSettings[ch] || {};
    const assignment = this.selectedAssignments[ch];
    const isDrumChannel = channel === 9 || (analysis && analysis.estimatedType === 'drums');
    const semitones = adaptation.transpositionSemitones || 0;

    // Channel stats
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

    // Split channel — show split viz only
    if (this.isSplitChannel(channel)) {
      const splitProposalHTML = this.renderSplitProposal ? this.renderSplitProposal(channel) : '';
      return `
        <div class="aa-tab-content">
          ${statsHTML}
          ${skipHTML}
          ${splitProposalHTML}
        </div>
      `;
    }

    // Selected instrument info (or placeholder)
    const instrumentInfoHTML = this.renderSelectedInstrumentInfo(channel);

    // Adaptation controls (only if instrument selected and not skipped)
    const adaptationHTML = (!isSkipped && selectedInstrumentId) ? this.renderAdaptationControls(channel, adaptation) : '';

    // Piano roll visualization (non-drum channels with instrument selected)
    const noteRangeVizHTML = (!isSkipped && !isDrumChannel && selectedInstrumentId && this.renderNoteRangeViz)
      ? this.renderNoteRangeViz(channel, analysis, assignment, semitones)
      : '';

    // Drum mapping (drum channels with instrument selected)
    const drumMappingHTML = (!isSkipped && isDrumChannel && selectedInstrumentId) ? this.renderDrumMappingSection(channel) : '';

    // Split proposal (if available but not yet accepted)
    const splitProposalHTML = this.renderSplitProposal ? this.renderSplitProposal(channel) : '';

    return `
      <div class="aa-tab-content">
        ${statsHTML}
        ${skipHTML}
        ${instrumentInfoHTML}
        ${adaptationHTML}
        ${noteRangeVizHTML}
        ${drumMappingHTML}
        ${splitProposalHTML}
      </div>
    `;
  }

  /**
   * Render selected instrument info card
   */
  AutoAssignUIMixin.renderSelectedInstrumentInfo = function(channel) {
    const ch = String(channel);
    const assignment = this.selectedAssignments[ch];
    const isSkipped = this.skippedChannels.has(channel);

    if (isSkipped) return '';

    if (!assignment || !assignment.instrumentId) {
      return `
        <div class="aa-selected-instrument aa-selected-instrument-empty">
          <p>${_t('autoAssign.overview.selectInstrumentHint')}</p>
        </div>
      `;
    }

    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.id === assignment.instrumentId);
    const compat = selectedOption?.compatibility;
    const instrument = selectedOption?.instrument;
    const score = assignment.score || 0;
    const displayName = assignment.customName || assignment.instrumentName || '—';
    const instType = instrument?.instrument_type || '';
    const typeColor = this.getTypeColor ? this.getTypeColor(instType) : '#607D8B';
    const typeIcon = this.getTypeIcon ? this.getTypeIcon(instType) : '';

    // Score breakdown bars
    const scoreBreakdown = compat?.scoreBreakdown;
    const breakdownHTML = scoreBreakdown ? `
      <div class="aa-score-breakdown">
        ${this.renderScoreBar('autoAssign.scoreProgram', scoreBreakdown.program)}
        ${this.renderScoreBar('autoAssign.scoreNoteRange', scoreBreakdown.noteRange)}
        ${this.renderScoreBar('autoAssign.scorePolyphony', scoreBreakdown.polyphony)}
        ${this.renderScoreBar('autoAssign.scoreCCSupport', scoreBreakdown.ccSupport)}
        ${this.renderScoreBar('autoAssign.scoreType', scoreBreakdown.instrumentType)}
        ${scoreBreakdown.percussion && scoreBreakdown.percussion.max !== 0 ? this.renderScoreBar('autoAssign.scorePercussion', scoreBreakdown.percussion) : ''}
      </div>
    ` : '';

    // Compatibility info and issues
    const infoHTML = compat?.info ? `<div class="aa-instrument-compat-info">${this.formatInfo(compat.info)}</div>` : '';
    const issuesHTML = compat?.issues?.length > 0 ? `
      <div class="aa-instrument-issues">
        ${compat.issues.map(i => escapeHtml(i.message || i)).join(' &bull; ')}
      </div>
    ` : '';

    // Instrument details
    const detailParts = [];
    if (instrument) {
      detailParts.push(this.formatInstrumentInfo(instrument, compat || {}));
    }
    const detailHTML = detailParts.length > 0 ? `<div class="aa-instrument-details">${detailParts.join('')}</div>` : '';

    // Duplicate warning
    const otherChannels = this.getOtherChannelsUsingInstrument(assignment.instrumentId, channel);
    const duplicateWarning = otherChannels.length > 0
      ? `<span class="aa-duplicate-badge" title="${_t('autoAssign.duplicateInstrumentTip', {channels: otherChannels.join(', ')})}">${_t('autoAssign.duplicateInstrument', {channels: otherChannels.join(', ')})}</span>`
      : '';

    // Preview button
    const previewHTML = this.midiData ? `
      <button class="btn aa-btn-sm aa-inst-preview" onclick="event.stopPropagation(); autoAssignModalInstance.previewChannel(${channel})" title="${_t('autoAssign.previewChannelTip')}">
        &#9654; ${_t('autoAssign.previewChannel', {num: channel + 1})}
      </button>
    ` : '';

    return `
      <div class="aa-selected-instrument" style="border-left: 4px solid ${typeColor}">
        <div class="aa-selected-instrument-header">
          <span class="aa-selected-instrument-dot" style="background:${typeColor}"></span>
          <span class="aa-selected-instrument-type-icon">${typeIcon}</span>
          <div class="aa-selected-instrument-name">${escapeHtml(displayName)} ${duplicateWarning}</div>
          <div class="aa-selected-instrument-score">
            <span class="aa-score-value ${this.getScoreClass(score)}">${score}</span>
            <span class="aa-score-label ${this.getScoreClass(score)}">${this.getScoreLabel(score)}</span>
            <span class="aa-score-stars">${this.getScoreStars(score)}</span>
          </div>
          ${previewHTML}
        </div>
        ${detailHTML}
        ${infoHTML}
        ${issuesHTML}
        ${breakdownHTML}
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

    const isDrumChannel = channel === 9 || (analysis.estimatedType === 'drums');
    const rangeDisplay = this.formatNoteRange
      ? this.formatNoteRange(noteRange, isDrumChannel, analysis.noteDistribution)
      : (noteRange.min != null ? `${this.midiNoteToName(noteRange.min)} — ${this.midiNoteToName(noteRange.max)}` : 'N/A');

    return `
      <div class="aa-channel-stats">
        <div class="aa-stat">
          <strong>${_t('autoAssign.noteRange')}:</strong>
          ${rangeDisplay}
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

  // ========================================================================
  // OVERVIEW — CHANNEL BAR
  // ========================================================================

  AutoAssignUIMixin.renderChannelBar = function() {
    return this.channels.map(ch => {
      const channel = parseInt(ch);
      const isActive = channel === this.activeChannel;
      const isSkipped = this.skippedChannels.has(channel);
      const isSplit = this.isSplitChannel(channel);
      const assignment = this.selectedAssignments[ch];
      const score = isSplit ? (this.splitAssignments[channel]?.quality || 0) : (assignment?.score || 0);
      const analysis = this.channelAnalyses[channel] || assignment?.channelAnalysis;
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (this.getGmProgramName(analysis?.primaryProgram) || '');
      const gmShort = gmName.length > 12 ? gmName.slice(0, 11) + '…' : gmName;
      const typeIcon = analysis?.estimatedType ? this.getTypeIcon(analysis.estimatedType) : '';

      const isDrumChannel = channel === 9 || analysis?.estimatedType === 'drums';
      const noteRange = analysis?.noteRange;
      const rangeLabel = this.formatNoteRange
        ? this.formatNoteRange(noteRange, isDrumChannel, analysis?.noteDistribution)
        : '';
      const typeColor = this.getTypeColor ? this.getTypeColor(analysis?.estimatedType || analysis?.estimatedCategory || '') : '';

      return `
        <button class="aa-chbar-btn ${isActive ? 'active' : ''} ${isSkipped ? 'skipped' : ''} ${this.getScoreClass(score)}"
                data-channel="${channel}"
                style="${typeColor ? 'border-left: 3px solid ' + typeColor : ''}"
                onclick="autoAssignModalInstance.selectOverviewChannel(${channel})"
                title="${escapeHtml(gmName)}${rangeLabel ? ' | ' + rangeLabel : ''}">
          <span class="aa-chbar-icon">${typeIcon}</span>
          <span class="aa-chbar-label">Ch ${channel + 1}</span>
          ${channel === 9 ? '<span class="aa-tab-drum">DR</span>' : ''}
          ${isSplit ? '<span class="aa-tab-split">SP</span>' : ''}
          ${!isSkipped ? `<span class="aa-chbar-score">${score}</span>` : '<span class="aa-chbar-score">—</span>'}
          ${gmShort ? `<span class="aa-chbar-gm">${escapeHtml(gmShort)}</span>` : ''}
          ${rangeLabel ? `<span class="aa-chbar-range">${rangeLabel}</span>` : ''}
        </button>
      `;
    }).join('');
  };

  // ========================================================================
  // OVERVIEW — INSTRUMENT BAR
  // ========================================================================

  AutoAssignUIMixin.renderInstrumentBar = function(channel) {
    const ch = String(channel);
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    // Sort by score descending
    allOptions.sort((a, b) => b.compatibility.score - a.compatibility.score);

    const currentAssignment = this.selectedAssignments[ch];
    const isSplitMode = this.splitSelectionMode === channel;
    const splitSel = this.manualSplitSelection[channel] || new Set();

    if (allOptions.length === 0) {
      return `<div class="aa-instbar-placeholder">${_t('autoAssign.noCompatible')}</div>`;
    }

    const buttonsHTML = allOptions.map(option => {
      const inst = option.instrument;
      const score = option.compatibility.score;
      const isAssigned = currentAssignment?.instrumentId === inst.id;
      const isInSplit = splitSel.has(inst.id);
      const shortName = (inst.custom_name || inst.name || '?');
      const displayName = shortName.length > 16 ? shortName.slice(0, 15) + '…' : shortName;

      const safeId = escapeHtml(inst.id).replace(/'/g, "\\'");
      const instType = inst.instrument_type || inst.gm_program != null ? (this._getGmCategory ? this._getGmCategory(inst.gm_program) : '') : '';
      const typeColor = this.getTypeColor ? this.getTypeColor(instType || inst.instrument_type || '') : '#607D8B';
      const instTypeIcon = this.getTypeIcon ? this.getTypeIcon(instType || inst.instrument_type || '') : '';

      if (isSplitMode) {
        return `
          <button class="aa-instbar-btn ${isInSplit ? 'split-selected' : ''}"
                  style="border-left: 3px solid ${typeColor}"
                  onclick="autoAssignModalInstance.toggleSplitInstrument(${channel}, '${safeId}')"
                  title="${escapeHtml(shortName)} — ${score}/100">
            <span class="aa-instbar-dot" style="background:${typeColor}"></span>
            <span class="aa-instbar-icon">${instTypeIcon}</span>
            <span class="aa-instbar-name">${escapeHtml(displayName)}</span>
            <span class="aa-instbar-score ${this.getScoreClass(score)}">${score}</span>
            ${isInSplit ? '<span class="aa-instbar-check">✓</span>' : ''}
          </button>
        `;
      }

      return `
        <button class="aa-instbar-btn ${isAssigned ? 'assigned' : ''}"
                style="border-left: 3px solid ${typeColor}"
                onclick="autoAssignModalInstance.assignFromOverview(${channel}, '${safeId}')"
                title="${escapeHtml(shortName)} — ${score}/100">
          <span class="aa-instbar-dot" style="background:${typeColor}"></span>
          <span class="aa-instbar-icon">${instTypeIcon}</span>
          <span class="aa-instbar-name">${escapeHtml(displayName)}</span>
          <span class="aa-instbar-score ${this.getScoreClass(score)}">${score}</span>
          ${isAssigned ? '<span class="aa-instbar-check">✓</span>' : ''}
        </button>
      `;
    }).join('');

    // Split mode controls
    let splitControls = '';
    if (isSplitMode) {
      const canValidate = splitSel.size >= 2;
      splitControls = `
        <div class="aa-instbar-split-controls">
          <button class="btn aa-btn-sm ${canValidate ? 'btn-primary' : ''}" ${canValidate ? '' : 'disabled'}
                  onclick="autoAssignModalInstance.createManualSplit(${channel})">
            ${_t('autoAssign.overview.validateSplit')} (${splitSel.size})
          </button>
          <button class="btn aa-btn-sm" onclick="autoAssignModalInstance.toggleSplitMode(${channel})">
            ${_t('common.cancel')}
          </button>
        </div>
      `;
    } else {
      splitControls = `
        <button class="aa-instbar-btn aa-instbar-split-btn" onclick="autoAssignModalInstance.toggleSplitMode(${channel})"
                title="${_t('autoAssign.overview.addSplit')}">
          + ${_t('autoAssign.overview.split')}
        </button>
      `;
    }

    return `
      <div class="aa-instbar-content ${isSplitMode ? 'split-mode' : ''}">
        <div class="aa-instbar-list">${buttonsHTML}</div>
        ${splitControls}
      </div>
    `;
  };


    if (typeof window !== 'undefined') window.AutoAssignUIMixin = AutoAssignUIMixin;
})();
