// Auto-extracted from AutoAssignModal.js
(function() {
    'use strict';
    const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    const AutoAssignVizMixin = {};


  /**
   * Render visual piano roll: channel notes vs instrument range
   * Each key is colored by status: green=used+in-range, red=used+out-of-range,
   * light gray=instrument range but unused, white=outside both
   */
    AutoAssignVizMixin.renderNoteRangeViz = function(channel, analysis, assignment, semitones) {
    if (!analysis || !analysis.noteRange || analysis.noteRange.min == null) return '';

    const ch = String(channel);
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.id === assignment?.instrumentId);
    if (!selectedOption) return '';

    const inst = selectedOption.instrument;
    const noteDistribution = analysis.noteDistribution || {};
    const usedNotes = Object.keys(noteDistribution).map(Number);
    if (usedNotes.length === 0) return '';

    // Calculate transposed used notes
    const transposedNotes = usedNotes.map(n => n + semitones);
    const transposedMin = Math.min(...transposedNotes);
    const transposedMax = Math.max(...transposedNotes);

    // Determine instrument range bounds
    const instMin = inst.note_range_min != null ? inst.note_range_min : 0;
    const instMax = inst.note_range_max != null ? inst.note_range_max : 127;

    // Global display range (with padding)
    const globalMin = Math.max(0, Math.min(transposedMin, instMin) - 2);
    const globalMax = Math.min(127, Math.max(transposedMax, instMax) + 2);

    // Build note-level data
    const transposedDistribution = {};
    for (const [note, count] of Object.entries(noteDistribution)) {
      transposedDistribution[Number(note) + semitones] = count;
    }
    const maxCount = Math.max(...Object.values(transposedDistribution), 1);

    // Count in-range vs out-of-range
    let inRangeCount = 0;
    let outOfRangeCount = 0;
    for (const note of transposedNotes) {
      if (this.isNoteInInstrumentRange(note, inst)) {
        inRangeCount++;
      } else {
        outOfRangeCount++;
      }
    }

    // Generate piano keys
    let keysHTML = '';
    let octaveMarkers = '';
    for (let note = globalMin; note <= globalMax; note++) {
      const isBlack = this.isBlackKey(note);
      const isUsed = transposedDistribution[note] !== undefined;
      const inRange = this.isNoteInInstrumentRange(note, inst);
      const usage = isUsed ? transposedDistribution[note] / maxCount : 0;

      let statusClass = '';
      if (isUsed && inRange) statusClass = 'used-ok';
      else if (isUsed && !inRange) statusClass = 'used-out';
      else if (inRange) statusClass = 'in-range';

      const opacityStyle = isUsed ? `opacity: ${Math.max(0.4, usage)}` : '';
      const title = isUsed
        ? `${this.midiNoteToName(note)} (${note}) - ${transposedDistribution[note]}x${inRange ? '' : ' [OUT]'}`
        : `${this.midiNoteToName(note)} (${note})${inRange ? ' [inst]' : ''}`;

      keysHTML += `<div class="aa-piano-key ${isBlack ? 'black' : 'white'} ${statusClass}" title="${title}" style="${opacityStyle}"></div>`;

      // Add octave markers for C notes
      if (note % 12 === 0) {
        const pos = ((note - globalMin) / (globalMax - globalMin)) * 100;
        octaveMarkers += `<span class="aa-octave-marker" style="left: ${pos}%">${this.midiNoteToName(note)}</span>`;
      }
    }

    // Summary text
    const summaryClass = outOfRangeCount > 0 ? 'aa-summary-warning' : 'aa-summary-ok';
    const summaryText = outOfRangeCount > 0
      ? `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${inRangeCount} ${_t('autoAssign.inRange')}, ${outOfRangeCount} ${_t('autoAssign.outOfRange')}`
      : `${usedNotes.length} ${_t('autoAssign.notesUsed')} — ${_t('autoAssign.allInRange')}`;

    return `
      <div class="aa-note-range-viz">
        <div class="aa-note-range-labels">
          <span>${_t('autoAssign.channelNotes')}: ${this.midiNoteToName(transposedMin)}-${this.midiNoteToName(transposedMax)}</span>
          <span>${_t('autoAssign.instrumentRange')}: ${this.midiNoteToName(instMin)}-${this.midiNoteToName(instMax)}</span>
        </div>
        <div class="aa-piano-roll">
          ${keysHTML}
        </div>
        <div class="aa-piano-roll-octaves">
          ${octaveMarkers}
        </div>
        <div class="aa-piano-roll-legend">
          <span class="aa-legend-item"><span class="aa-legend-color used-ok"></span> ${_t('autoAssign.legendInRange')}</span>
          <span class="aa-legend-item"><span class="aa-legend-color used-out"></span> ${_t('autoAssign.legendOutOfRange')}</span>
          <span class="aa-legend-item"><span class="aa-legend-color in-range"></span> ${_t('autoAssign.legendAvailable')}</span>
        </div>
        <div class="${summaryClass}">${summaryText}</div>
      </div>
    `;
  }

  // ========================================================================
  // COMPACT RANGE BAR VISUALIZATION
  // ========================================================================

  /**
   * Render compact linear range bar: instrument range (green) vs channel notes (blue/orange)
   * For splits, shows multiple colored segments per instrument.
   * For drums/discrete instruments, shows a text summary instead.
   */
    AutoAssignVizMixin.renderRangeBar = function(channel) {
    const ch = String(channel);
    const analysis = (this.selectedAssignments[ch]?.channelAnalysis) || this.channelAnalyses[channel];
    if (!analysis?.noteRange || analysis.noteRange.min == null) return '';

    const pct = v => ((Math.max(0, Math.min(127, v)) / 127) * 100).toFixed(1);
    const chanLabel = `Ch.${channel + 1}`;
    const splitColors = ['#667eea', '#764ba2', '#f093fb', '#4facfe'];

    // ---- SPLIT MODE: multiple instruments per channel ----
    if (this.isSplitChannel(channel)) {
      const proposal = this.splitAssignments[channel];
      if (!proposal || !proposal.segments || proposal.segments.length === 0) return '';

      const chanMin = analysis.noteRange.min;
      const chanMax = analysis.noteRange.max;
      const chanLeft = pct(chanMin);
      const chanWidth = Math.max(0.5, ((chanMax - chanMin) / 127) * 100).toFixed(1);

      const segmentBarsHTML = proposal.segments.map((seg, i) => {
        const segMin = seg.noteRange?.min ?? chanMin;
        const segMax = seg.noteRange?.max ?? chanMax;
        const left = pct(segMin);
        const width = Math.max(0.5, ((segMax - segMin) / 127) * 100).toFixed(1);
        const color = splitColors[i % splitColors.length];
        const name = escapeHtml(seg.instrumentName || '?');
        return `<div class="aa-range-split-segment" style="left:${left}%;width:${width}%;background:${color}"
                     title="${name}: ${this.midiNoteToName(segMin)}-${this.midiNoteToName(segMax)}"></div>`;
      }).join('');

      const legendItems = proposal.segments.map((seg, i) => {
        const color = splitColors[i % splitColors.length];
        const name = seg.instrumentName || '?';
        const shortName = name.length > 18 ? name.slice(0, 17) + '…' : name;
        return `<span class="aa-range-legend-item"><span class="aa-rleg-color" style="background:${color};border-color:${color}"></span>${escapeHtml(shortName)}</span>`;
      }).join('');

      return `<div class="aa-range-bar-container">
        <div class="aa-range-bar">
          <div class="aa-range-split-bg" style="left:${chanLeft}%;width:${chanWidth}%"
               title="${chanLabel}: ${this.midiNoteToName(chanMin)}-${this.midiNoteToName(chanMax)}"></div>
          ${segmentBarsHTML}
        </div>
        <div class="aa-range-legend">
          ${legendItems}
          <span class="aa-range-legend-item"><span class="aa-rleg-color aa-rleg-chan-bg"></span>${chanLabel}</span>
        </div>
      </div>`;
    }

    // ---- NORMAL MODE: single instrument ----
    const assignment = this.selectedAssignments[ch];

    // ---- NO INSTRUMENT SELECTED: show channel range only ----
    if (!assignment?.instrumentId) {
      const chanMin = analysis.noteRange.min;
      const chanMax = analysis.noteRange.max;
      const chanLeft = pct(chanMin);
      const chanWidth = Math.max(0.5, ((chanMax - chanMin) / 127) * 100).toFixed(1);
      const gmName = channel === 9
        ? _t('autoAssign.drums')
        : (this.getGmProgramName(analysis.primaryProgram) || chanLabel);
      return `<div class="aa-range-bar-container">
        <div class="aa-range-bar">
          <div class="aa-range-channel in-range" style="left:${chanLeft}%;width:${chanWidth}%"
               title="${chanLabel}: ${this.midiNoteToName(chanMin)}-${this.midiNoteToName(chanMax)}"></div>
        </div>
        <div class="aa-range-legend">
          <span class="aa-range-legend-item"><span class="aa-rleg-color chan in-range"></span>${chanLabel} — ${escapeHtml(gmName)}</span>
        </div>
      </div>`;
    }

    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.id === assignment.instrumentId);
    if (!selectedOption) return '';
    const inst = selectedOption.instrument;

    const isDrumOrDiscrete = channel === 9
      || (analysis.estimatedType === 'drums')
      || inst.note_selection_mode === 'discrete';

    if (isDrumOrDiscrete) {
      const instName = inst.custom_name || inst.name || '?';
      const shortName = instName.length > 20 ? instName.slice(0, 19) + '…' : instName;
      const mappingCount = Object.keys(assignment.noteRemapping || {}).length;
      return `<div class="aa-range-bar-container aa-range-drums">
        ${escapeHtml(shortName)} — ${mappingCount} ${_t('autoAssign.notesMapped')}
      </div>`;
    }

    const adaptation = this.adaptationSettings[ch] || {};
    const semitones = adaptation.transpositionSemitones || 0;
    const strategy = adaptation.strategy || 'ignore';

    const instMin = inst.note_range_min ?? 0;
    const instMax = inst.note_range_max ?? 127;
    const chanMin = analysis.noteRange.min + semitones;
    const chanMax = analysis.noteRange.max + semitones;

    const instLeft = pct(instMin);
    const instWidth = (((instMax - instMin) / 127) * 100).toFixed(1);
    const chanLeft = pct(chanMin);
    const chanWidth = Math.max(0.5, ((chanMax - chanMin) / 127) * 100).toFixed(1);

    // Instrument display name (truncated)
    const instName = inst.custom_name || inst.name || '?';
    const shortInstName = instName.length > 20 ? instName.slice(0, 19) + '…' : instName;

    // Channel label with transposition
    const transpoSuffix = semitones ? ` (${semitones > 0 ? '+' : ''}${semitones}st)` : '';

    // Adaptation result
    const result = this.calculateAdaptationResult(channel, strategy);
    const allOk = result.outOfRange === 0;
    const chanClass = allOk ? 'in-range' : 'out-of-range';

    let summaryHTML = '';
    if (result.totalNotes > 0) {
      if (allOk) {
        summaryHTML = `<span class="aa-range-summary ok">${result.totalNotes}/${result.totalNotes} OK</span>`;
      } else {
        const playable = result.inRange + result.recovered;
        summaryHTML = `<span class="aa-range-summary warning">${playable}/${result.totalNotes} — ${result.outOfRange} ${_t('autoAssign.outOfRange')}</span>`;
      }
    }

    return `<div class="aa-range-bar-container">
      <div class="aa-range-bar">
        <div class="aa-range-instrument" style="left:${instLeft}%;width:${instWidth}%"
             title="${_t('autoAssign.instrumentRange')}: ${this.midiNoteToName(instMin)}-${this.midiNoteToName(instMax)}"></div>
        <div class="aa-range-channel ${chanClass}" style="left:${chanLeft}%;width:${chanWidth}%"
             title="${_t('autoAssign.channelNotes')}: ${this.midiNoteToName(chanMin)}-${this.midiNoteToName(chanMax)}"></div>
      </div>
      <div class="aa-range-legend">
        <span class="aa-range-legend-item"><span class="aa-rleg-color inst"></span>${escapeHtml(shortInstName)}</span>
        <span class="aa-range-legend-item"><span class="aa-rleg-color chan ${chanClass}"></span>${chanLabel}${escapeHtml(transpoSuffix)}</span>
        ${summaryHTML}
      </div>
    </div>`;
  }

  /**
   * Render a single instrument option (used for both normal and low-score lists)
   */
    AutoAssignVizMixin.renderInstrumentOption = function(channel, option, index, selectedInstrumentId, isLowScore) {
    const instrument = option.instrument;
    const compat = option.compatibility;
    const isSelected = instrument.id === selectedInstrumentId;
    const escapedName = escapeHtml(instrument.custom_name || instrument.name);
    const escapedInstrumentId = escapeHtml(instrument.id);
    const detailKey = `${channel}_${escapedInstrumentId}`;
    const showDetails = this.showScoreDetails[detailKey] || false;

    // Check if this instrument is already used by another channel
    const otherChannels = this.getOtherChannelsUsingInstrument(instrument.id, channel);
    const duplicateWarning = (isSelected && otherChannels.length > 0)
      ? `<span class="aa-duplicate-badge" title="${_t('autoAssign.duplicateInstrumentTip', {channels: otherChannels.join(', ')})}">${_t('autoAssign.duplicateInstrument', {channels: otherChannels.join(', ')})}</span>`
      : '';

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
           data-instrument-id="${escapedInstrumentId}">
        <div class="aa-instrument-main"
             onclick="autoAssignModalInstance.selectInstrument(${channel}, '${escapedInstrumentId.replace(/'/g, "\\'")}')">
          <div class="aa-instrument-info">
            <div class="aa-instrument-name">
              ${escapedName}
              ${index === 0 && !isLowScore ? `<span class="aa-recommended">${_t('autoAssign.recommended')}</span>` : ''}
              ${isLowScore ? `<span class="aa-low-score-badge">${_t('autoAssign.lowScore')}</span>` : ''}
              ${duplicateWarning}
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
            <span class="aa-score-value ${this.getScoreClass(compat.score)}">${compat.score}</span>
            <span class="aa-score-label ${this.getScoreClass(compat.score)}">${this.getScoreLabel(compat.score)}</span>
            <span class="aa-score-stars">${this.getScoreStars(compat.score)}</span>
          </div>
        </div>
        <div class="aa-option-actions">
          <button class="aa-score-detail-toggle" aria-expanded="${showDetails}" onclick="autoAssignModalInstance.toggleScoreDetails('${detailKey}')">
            ${showDetails ? _t('autoAssign.hideDetails') : _t('autoAssign.showDetails')}
          </button>
          ${this.midiData ? `
            <button class="aa-inline-preview" onclick="event.stopPropagation(); autoAssignModalInstance.previewInstrument(${channel}, '${escapedInstrumentId.replace(/'/g, "\\'")}')" title="${_t('autoAssign.previewChannelTip')}">
              &#9654;
            </button>
          ` : ''}
        </div>
        ${breakdownHTML}
      </div>
    `;
  }

  /**
   * Render the drum mapping configuration section — categorized view with summary
   */
    AutoAssignVizMixin.renderDrumMappingSection = function(channel) {
    const ch = String(channel);
    const showMapping = this.showDrumMapping[ch] || false;
    const assignment = this.selectedAssignments[ch];
    if (!assignment) return '';

    // Find the selected instrument's compatibility data
    const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
    const selectedOption = allOptions.find(opt => opt.instrument.id === assignment.instrumentId);
    const noteRemapping = assignment.noteRemapping || (selectedOption && selectedOption.compatibility.noteRemapping) || {};

    // GM drum note names
    const drumNames = {
      35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
      39: 'Hand Clap', 40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat',
      43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
      47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom',
      51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine',
      55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 59: 'Ride Cymbal 2',
      60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga', 63: 'Open Hi Conga',
      64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale', 67: 'High Agogo',
      68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas', 71: 'Short Whistle',
      72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves',
      76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica', 79: 'Open Cuica',
      80: 'Mute Triangle', 81: 'Open Triangle'
    };

    // Get overrides for this channel
    const overrides = this.drumMappingOverrides[ch] || {};

    // Build mapping entries
    const mappingEntries = Object.entries(noteRemapping).map(([src, tgt]) => {
      const srcNote = parseInt(src);
      const tgtNote = overrides[srcNote] !== undefined ? overrides[srcNote] : tgt;
      const srcName = drumNames[srcNote] || `Note ${srcNote}`;
      const tgtName = drumNames[tgtNote] || `Note ${tgtNote}`;
      const isModified = srcNote !== tgtNote;
      const isOverridden = overrides[srcNote] !== undefined;
      return { srcNote, tgtNote, srcName, tgtName, isModified, isOverridden };
    }).sort((a, b) => a.srcNote - b.srcNote);

    // Get notes actually used in the channel
    const analysis = this.channelAnalyses[channel] || assignment.channelAnalysis;
    const usedNotes = analysis?.noteDistribution ? Object.keys(analysis.noteDistribution).map(Number) : [];

    if (mappingEntries.length === 0 && usedNotes.length === 0) {
      return `
        <div class="aa-drum-mapping-section">
          <button class="aa-toggle-drum-mapping" aria-expanded="${showMapping}" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
            ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          </button>
          ${showMapping ? `<p class="aa-no-compatible">${_t('autoAssign.noDrumMapping')}</p>` : ''}
        </div>
      `;
    }

    // Group entries by drum category
    const mappingByNote = {};
    for (const entry of mappingEntries) {
      mappingByNote[entry.srcNote] = entry;
    }

    // Build category summary and detail
    const categoryData = [];
    for (const [catKey, catDef] of Object.entries(this.DRUM_CATEGORIES)) {
      const catNotes = catDef.notes.filter(n => usedNotes.includes(n) || mappingByNote[n]);
      if (catNotes.length === 0) continue;

      const entries = catNotes.map(n => {
        if (mappingByNote[n]) return mappingByNote[n];
        // Note used but no remapping needed (direct mapping)
        const name = drumNames[n] || `Note ${n}`;
        return { srcNote: n, tgtNote: n, srcName: name, tgtName: name, isModified: false, isOverridden: false };
      });

      const mapped = entries.filter(e => !e.isModified || e.tgtNote !== undefined).length;
      const total = entries.length;
      const modified = entries.filter(e => e.isModified).length;

      categoryData.push({
        key: catKey,
        label: catDef.label,
        entries,
        mapped,
        total,
        modified,
        status: mapped === total ? 'ok' : (mapped > 0 ? 'partial' : 'missing')
      });
    }

    // Use backend quality score if available, fallback to local exact-match ratio
    const backendQuality = selectedOption?.compatibility?.drumMappingQuality?.score;
    const totalEntries = categoryData.reduce((sum, c) => sum + c.total, 0);
    const exactMatches = categoryData.reduce((sum, c) => sum + c.entries.filter(e => !e.isModified).length, 0);
    const qualityScore = backendQuality != null
      ? Math.round(backendQuality)
      : (totalEntries > 0 ? Math.round((exactMatches / totalEntries) * 100) : 100);

    // Summary badges
    const summaryHTML = `
      <div class="aa-drum-summary">
        <div class="aa-drum-quality">
          ${this.getScoreStars(qualityScore)} ${qualityScore}/100
        </div>
        <div class="aa-drum-category-badges">
          ${categoryData.map(cat => {
            const icon = cat.status === 'ok' ? '&#10003;' : (cat.status === 'partial' ? '!' : '&#10007;');
            return `<span class="aa-drum-badge-cat ${cat.status}">${icon} ${cat.label} (${cat.mapped}/${cat.total})</span>`;
          }).join('')}
        </div>
      </div>
    `;

    // Category accordions (when expanded)
    const categoriesHTML = showMapping ? categoryData.map(cat => {
      const expanded = this.expandedDrumCategories[`${ch}_${cat.key}`] || false;
      return `
        <div class="aa-drum-category">
          <button class="aa-drum-category-header ${cat.status}" aria-expanded="${expanded}" onclick="autoAssignModalInstance.toggleDrumCategory(${channel}, '${cat.key}')">
            <span>${expanded ? '&#9660;' : '&#9654;'} ${cat.label}</span>
            <span class="aa-drum-cat-count">${cat.mapped}/${cat.total}${cat.modified > 0 ? ` (${cat.modified} sub.)` : ''}</span>
          </button>
          ${expanded ? `
            <div class="aa-drum-category-entries">
              ${cat.entries.map(entry => `
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
          ` : ''}
        </div>
      `;
    }).join('') : '';

    // Drum strategy selector
    const drumStrategy = this.adaptationSettings[ch]?.drumStrategy || 'intelligent';
    const drumStrategyHTML = showMapping ? `
      <div class="aa-drum-strategy">
        <label class="aa-strategy-title">${_t('autoAssign.drumAdaptStrategy')}:</label>
        <div class="aa-drum-strategy-options">
          <label class="${drumStrategy === 'intelligent' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="intelligent"
                   ${drumStrategy === 'intelligent' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'intelligent')">
            ${_t('autoAssign.drumStrategyIntelligent')}
          </label>
          <label class="${drumStrategy === 'direct' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="direct"
                   ${drumStrategy === 'direct' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'direct')">
            ${_t('autoAssign.drumStrategyDirect')}
          </label>
          <label class="${drumStrategy === 'manual' ? 'selected' : ''}">
            <input type="radio" name="drumStrategy_${channel}" value="manual"
                   ${drumStrategy === 'manual' ? 'checked' : ''}
                   onchange="autoAssignModalInstance.setDrumStrategy(${channel}, 'manual')">
            ${_t('autoAssign.drumStrategyManual')}
          </label>
        </div>
      </div>
    ` : '';

    const totalModified = mappingEntries.filter(e => e.isModified).length;

    return `
      <div class="aa-drum-mapping-section">
        <button class="aa-toggle-drum-mapping" aria-expanded="${showMapping}" onclick="autoAssignModalInstance.toggleDrumMapping('${ch}')">
          ${showMapping ? '&#9660;' : '&#9654;'} ${_t('autoAssign.drumMapping')}
          ${totalModified > 0
            ? `<span class="aa-drum-mapping-count">${totalModified} ${_t('autoAssign.substitutions')}</span>`
            : ''}
        </button>
        ${summaryHTML}
        ${categoriesHTML}
        ${drumStrategyHTML}
      </div>
    `;
  }

  // ========================================================================
  // SPLIT PROPOSAL RENDERING
  // ========================================================================

  /**
   * Render split proposal section for a channel
   * @param {number} channel
   * @returns {string} HTML
   */
  AutoAssignVizMixin.renderSplitProposal = function(channel) {
    const baseProposal = this.splitProposals[channel];
    if (!baseProposal) return '';

    const isSplit = this.isSplitChannel(channel);
    const analysis = this.channelAnalyses[channel];
    const channelMin = analysis?.noteRange?.min ?? 0;
    const channelMax = analysis?.noteRange?.max ?? 127;

    // Use the active split type (user may have switched)
    const activeProposal = this.getActiveSplitProposal
      ? this.getActiveSplitProposal(channel)
      : baseProposal;
    const proposal = isSplit ? this.splitAssignments[channel] : activeProposal;

    const typeLabels = { range: _t('autoAssign.splitByRange'), polyphony: _t('autoAssign.splitByPolyphony'), mixed: _t('autoAssign.splitMixed') };

    // Build type tabs (best + alternatives)
    const allTypes = [baseProposal, ...(baseProposal.alternatives || [])];
    const activeType = this.activeSplitType?.[channel] || baseProposal.type;
    const typeTabsHTML = allTypes.length > 1 ? allTypes.map(p => {
      const isActive = p.type === activeType;
      const label = typeLabels[p.type] || p.type;
      return `<button class="aa-split-type-tab ${isActive ? 'active' : ''}"
                      onclick="autoAssignModalInstance.switchSplitType(${channel}, '${p.type}')"
                      ${isSplit ? 'disabled' : ''}>
        ${label} <span class="aa-split-type-quality">${p.quality}</span>
      </button>`;
    }).join('') : `<span class="aa-split-type-badge">${typeLabels[proposal.type] || proposal.type}</span>`;

    // Build coverage bar
    const totalSpan = Math.max(1, channelMax - channelMin + 1);
    const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe'];
    const segmentBars = proposal.segments.map((seg, i) => {
      const segMin = seg.noteRange?.min ?? channelMin;
      const segMax = seg.noteRange?.max ?? channelMax;
      const left = ((segMin - channelMin) / totalSpan * 100).toFixed(1);
      const width = ((segMax - segMin + 1) / totalSpan * 100).toFixed(1);
      const color = colors[i % colors.length];
      return `<div class="aa-split-bar-segment" style="left:${left}%;width:${width}%;background:${color}" title="${seg.instrumentName}: ${this.midiNoteToName(segMin)}-${this.midiNoteToName(segMax)}"></div>`;
    }).join('');

    // Segment cards
    const segmentCards = proposal.segments.map((seg, i) => {
      const rangeText = seg.noteRange
        ? `${this.midiNoteToName(seg.noteRange.min)} - ${this.midiNoteToName(seg.noteRange.max)}`
        : (seg.strategy === 'round_robin' ? _t('autoAssign.roundRobin') : '—');
      const polyText = seg.polyphonyShare ? `${_t('autoAssign.polyphony')}: ${seg.polyphonyShare}` : '';

      return `
        <div class="aa-split-segment">
          <div class="aa-split-segment-color" style="background:${colors[i % colors.length]}"></div>
          <div class="aa-split-segment-info">
            <span class="aa-split-segment-name">${escapeHtml(seg.instrumentName || 'Instrument')}</span>
            <span class="aa-split-segment-range">${rangeText}</span>
            ${polyText ? `<span class="aa-split-segment-poly">${polyText}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Actions: different when accepted vs proposed
    let actionsHTML;
    if (isSplit) {
      actionsHTML = `
        <div class="aa-split-actions">
          <span class="aa-split-accepted-badge">✓ ${_t('autoAssign.splitAccepted')}</span>
          <button class="btn aa-btn-sm aa-split-remove" onclick="autoAssignModalInstance.rejectSplit(${channel})">✕ ${_t('autoAssign.removeSplit')}</button>
        </div>`;
    } else {
      actionsHTML = `
        <div class="aa-split-actions">
          <button class="btn btn-primary aa-split-accept" onclick="autoAssignModalInstance.acceptSplit(${channel})">${_t('autoAssign.acceptSplit')}</button>
          <button class="btn aa-split-ignore" onclick="autoAssignModalInstance.rejectSplit(${channel})">${_t('autoAssign.ignoreSplit')}</button>
        </div>`;
    }

    return `
      <div class="aa-split-section ${isSplit ? 'accepted' : ''}">
        <div class="aa-split-header">
          <span class="aa-split-icon">⇅</span>
          <span class="aa-split-title">${_t('autoAssign.splitProposed')}</span>
          <div class="aa-split-type-tabs">${typeTabsHTML}</div>
          <span class="aa-split-quality ${this.getScoreClass(proposal.quality)}">
            ${this.getScoreStars(proposal.quality)} ${proposal.quality}/100
          </span>
        </div>
        <div class="aa-split-coverage">
          <div class="aa-split-bar">
            ${segmentBars}
          </div>
          <div class="aa-split-range-labels">
            <span>${this.midiNoteToName(channelMin)}</span>
            <span>${this.midiNoteToName(channelMax)}</span>
          </div>
        </div>
        <div class="aa-split-segments">
          ${segmentCards}
        </div>
        ${proposal.overlapZones && proposal.overlapZones.length > 0 ? `
          <div class="aa-split-overlap">
            ${proposal.overlapZones.map(z =>
              `<span class="aa-split-overlap-info">${_t('autoAssign.overlapZone')}: ${this.midiNoteToName(z.min)}-${this.midiNoteToName(z.max)}</span>`
            ).join('')}
          </div>
        ` : ''}
        ${actionsHTML}
      </div>
    `;
  };

    if (typeof window !== 'undefined') window.AutoAssignVizMixin = AutoAssignVizMixin;
})();
