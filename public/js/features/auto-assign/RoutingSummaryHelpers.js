// public/js/features/auto-assign/RoutingSummaryHelpers.js
// Pure computational helpers extracted from RoutingSummaryPage.js (P2-F.4u).
// Exposed on `window.RoutingSummaryHelpers` — IIFE+globals convention.

(function() {
  'use strict';

  const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

  function mergeHints(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a === 'all' || b === 'all') return 'all';
    if (a === b) return a;
    if (a === 'both-panels' || b === 'both-panels') return 'both-panels';
    if ((a === 'summary' && b === 'detail') || (a === 'detail' && b === 'summary')) return 'both-panels';
    return 'all';
  }

  function detectOverlaps(segments) {
    if (!segments || segments.length < 2) return [];
    const overlaps = [];
    for (let a = 0; a < segments.length; a++) {
      for (let b = a + 1; b < segments.length; b++) {
        const rA = segments[a].noteRange;
        const rB = segments[b].noteRange;
        if (!rA || !rB) continue;
        const oMin = Math.max(rA.min, rB.min);
        const oMax = Math.min(rA.max, rB.max);
        if (oMin <= oMax) {
          overlaps.push({ min: oMin, max: oMax, segA: a, segB: b });
        }
      }
    }
    return overlaps;
  }

  function computeSplitCoverageScore({ splitData, analysis, adapt, autoAdaptation }) {
    if (!splitData?.segments?.length) return 0;
    const dist = analysis?.noteDistribution;
    if (!dist) return splitData.quality || 0;
    const semi = (autoAdaptation && adapt?.pitchShift !== 'none')
      ? (adapt?.transpositionSemitones || 0) : 0;
    let covered = 0;
    let total = 0;
    for (const [note, count] of Object.entries(dist)) {
      const shifted = parseInt(note) + semi;
      total += count;
      const inRange = splitData.segments.some(seg => {
        const rMin = seg.noteRange?.min ?? 0;
        const rMax = seg.noteRange?.max ?? 127;
        return shifted >= rMin && shifted <= rMax;
      });
      if (inRange) covered += count;
    }
    return total > 0 ? Math.round((covered / total) * 100) : 0;
  }

  function getCCName(ccNum, cache) {
    if (cache && cache[ccNum] !== undefined) return cache[ccNum];
    let name = `CC ${ccNum}`;
    if (typeof InstrumentSettingsModal !== 'undefined' && InstrumentSettingsModal.CC_GROUPS) {
      for (const group of Object.values(InstrumentSettingsModal.CC_GROUPS)) {
        if (group.ccs && group.ccs[ccNum]) {
          name = group.ccs[ccNum].name;
          break;
        }
      }
    }
    if (cache) cache[ccNum] = name;
    return name;
  }

  function getInstrumentCCs(instrumentId, allInstruments, findInstrumentById) {
    const fullInst = (allInstruments || []).find(i => i.id === instrumentId);
    if (fullInst?.supported_ccs) {
      if (Array.isArray(fullInst.supported_ccs)) return fullInst.supported_ccs;
      try { return JSON.parse(fullInst.supported_ccs || '[]'); } catch { return null; }
    }
    const found = findInstrumentById ? findInstrumentById(instrumentId) : null;
    if (found?.supported_ccs) {
      if (Array.isArray(found.supported_ccs)) return found.supported_ccs;
      try { return JSON.parse(found.supported_ccs || '[]'); } catch { return null; }
    }
    return null;
  }

  function computeCCSummary({
    channel,
    channelAnalyses,
    selectedAssignments,
    splitChannels,
    splitAssignments,
    ccRemapping,
    getInstrumentCCs: resolveCCs
  }) {
    const ch = String(channel);
    const analysis = channelAnalyses[channel];
    const channelCCs = analysis?.usedCCs || [];
    const assignment = selectedAssignments[ch];
    const isSplit = splitChannels.has(channel);
    const currentRemap = ccRemapping[ch] || {};

    if (isSplit && splitAssignments[channel]) {
      const segs = splitAssignments[channel].segments || [];
      const segCCs = segs.map(seg => resolveCCs(seg.instrumentId));
      const allUnknown = segCCs.every(ccs => ccs === null);

      let supportedByAll = 0, unsupportedByAny = 0;
      for (const ccNum of channelCCs) {
        const isDisabled = currentRemap[ccNum] === -1;
        const anyUnsupported = !isDisabled && segCCs.some(ccs => ccs !== null && !ccs.includes(ccNum));
        if (isDisabled || anyUnsupported) unsupportedByAny++;
        else supportedByAll++;
      }

      let summaryHTML;
      if (allUnknown) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
      } else if (unsupportedByAny === 0) {
        summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedByAll})</span>`;
      } else {
        summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedByAll}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedByAny} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
      }
      return { summaryHTML, supportedCount: supportedByAll, unsupportedCount: unsupportedByAny, allUnknown };
    }

    let instrumentCCs = assignment?.supportedCcs ?? null;
    if (instrumentCCs && typeof instrumentCCs === 'string') {
      try { instrumentCCs = JSON.parse(instrumentCCs); } catch { instrumentCCs = null; }
    }
    if (instrumentCCs == null && assignment?.instrumentId) {
      instrumentCCs = resolveCCs(assignment.instrumentId);
    }

    let supportedCount = 0, unsupportedCount = 0;
    for (const ccNum of channelCCs) {
      const isDisabled = currentRemap[ccNum] === -1;
      if (isDisabled) { unsupportedCount++; }
      else if (instrumentCCs === null || instrumentCCs.includes(ccNum)) { supportedCount++; }
      else { unsupportedCount++; }
    }

    let summaryHTML;
    if (instrumentCCs === null) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-unknown-summary">${_t('routingSummary.ccUnknown') || 'CC non configurés \u2014 supposés tous supportés'}</span>`;
    } else if (unsupportedCount === 0) {
      summaryHTML = `<span class="rs-cc-summary rs-cc-ok-summary">\u2713 ${_t('routingSummary.ccAllSupported') || 'Tous les CC supportés'} (${supportedCount})</span>`;
    } else {
      summaryHTML = `<span class="rs-cc-summary rs-cc-warn-summary">${supportedCount}/${channelCCs.length} ${_t('routingSummary.ccSupported') || 'CC supportés'} \u2014 ${unsupportedCount} ${_t('routingSummary.ccUnsupported') || 'non supportés'}</span>`;
    }
    return { summaryHTML, supportedCount, unsupportedCount, allUnknown: instrumentCCs === null };
  }

  function resolveSegmentGmProgram(seg, allInstruments) {
    if (seg.gmProgram != null) return seg.gmProgram;
    if (seg.instrumentId) {
      const inst = (allInstruments || []).find(i => i.id === seg.instrumentId);
      if (inst) return inst.gm_program;
    }
    return null;
  }

  function getInstrumentDisplayName(inst) {
    if (!inst) return '?';
    if (inst.custom_name) return inst.custom_name;
    const gmName = (typeof getGmProgramName === 'function')
      ? getGmProgramName(inst.gm_program ?? inst.gmProgram ?? null)
      : null;
    if (gmName) return gmName;
    return inst.name || '?';
  }

  function getChannelPolyphony({ channel, channelAnalyses, selectedAssignments }) {
    const ch = String(channel);
    const analysis = channelAnalyses[parseInt(channel)] || selectedAssignments[ch]?.channelAnalysis;
    if (!analysis?.polyphony) return null;
    if (typeof analysis.polyphony === 'number') return analysis.polyphony;
    return analysis.polyphony.max ?? null;
  }

  function getInstrumentPolyphony({ channel, splitChannels, splitAssignments, selectedAssignments, allInstruments }) {
    const ch = String(channel);
    const chNum = parseInt(channel);
    if (splitChannels.has(chNum) && splitAssignments[chNum]) {
      return (splitAssignments[chNum].segments || []).reduce((s, seg) => {
        const inst = (allInstruments || []).find(i => i.id === seg.instrumentId);
        return s + (inst?.polyphony || seg.polyphonyShare || 16);
      }, 0);
    }
    const assignment = selectedAssignments[ch];
    if (!assignment) return null;
    const inst = (allInstruments || []).find(i => i.id === assignment.instrumentId);
    return inst?.polyphony || assignment.polyphony || null;
  }

  /**
   * Apply a behavior mode to a split assignment, reconfiguring segments
   * (noteRange, type, overlapStrategy, behaviorMode) in-place.
   * Pure function: mutates the passed `splitData` only — no DOM, no globals.
   */
  function applyBehaviorMode({ splitData, channelNoteRange, mode }) {
    if (!splitData || !splitData.segments || splitData.segments.length < 2) return;

    const chMin = channelNoteRange?.min ?? 0;
    const chMax = channelNoteRange?.max ?? 127;
    const segA = splitData.segments[0];
    const segB = splitData.segments[1];

    splitData.behaviorMode = mode;

    switch (mode) {
      case 'overflow':
        segA.noteRange = { min: chMin, max: chMax };
        segB.noteRange = { min: chMin, max: chMax };
        splitData.type = 'polyphony';
        splitData.overlapStrategy = 'overflow';
        break;

      case 'combineNoOverlap': {
        const aMax = segA.fullRange?.max ?? chMax;
        const bMin = segB.fullRange?.min ?? chMin;
        let splitPoint = Math.round((aMax + bMin) / 2);
        splitPoint = Math.max(chMin, Math.min(chMax, splitPoint));
        segA.noteRange = { min: chMin, max: splitPoint };
        segB.noteRange = { min: splitPoint + 1, max: chMax };
        splitData.type = 'range';
        splitData.overlapStrategy = 'shared';
        break;
      }

      case 'combineWithOverlap': {
        const aEffMin = Math.max(segA.fullRange?.min ?? 0, chMin);
        const aEffMax = Math.min(segA.fullRange?.max ?? 127, chMax);
        const bEffMin = Math.max(segB.fullRange?.min ?? 0, chMin);
        const bEffMax = Math.min(segB.fullRange?.max ?? 127, chMax);
        segA.noteRange = { min: aEffMin, max: aEffMax };
        segB.noteRange = { min: bEffMin, max: bEffMax };
        splitData.type = 'range';
        splitData.overlapStrategy = 'shared';
        break;
      }

      case 'alternate':
        segA.noteRange = { min: chMin, max: chMax };
        segB.noteRange = { min: chMin, max: chMax };
        splitData.type = 'polyphony';
        splitData.overlapStrategy = 'alternate';
        break;
    }
  }

  /**
   * Re-clamp segment noteRanges after the channel transposition changed.
   * Mutates `splitData.segments[*].noteRange`.
   */
  function reclampSplitRanges({ splitData, oldSemitones, newSemitones, channelNoteRange }) {
    if (!splitData?.segments?.length) return;
    const delta = (newSemitones || 0) - (oldSemitones || 0);
    if (delta === 0) return;

    const baseMin = channelNoteRange?.min ?? 0;
    const baseMax = channelNoteRange?.max ?? 127;
    const tCh = {
      min: Math.max(0, Math.min(127, baseMin + (newSemitones || 0))),
      max: Math.max(0, Math.min(127, baseMax + (newSemitones || 0)))
    };
    if (tCh.min > tCh.max) { const t = tCh.min; tCh.min = tCh.max; tCh.max = t; }

    for (const seg of splitData.segments) {
      const physMin = seg.fullRange?.min ?? 0;
      const physMax = seg.fullRange?.max ?? 127;
      const shiftedMinRaw = Math.max(physMin, (seg.noteRange?.min ?? physMin) + delta);
      const shiftedMaxRaw = Math.min(physMax, (seg.noteRange?.max ?? physMax) + delta);
      const sMin = Math.max(0, Math.min(127, shiftedMinRaw));
      const sMax = Math.max(0, Math.min(127, shiftedMaxRaw));
      const lo = Math.max(sMin, tCh.min);
      const hi = Math.min(sMax, tCh.max);
      seg.noteRange = (lo > hi) ? { min: hi, max: lo } : { min: lo, max: hi };
    }
  }

  /**
   * Move one bound (min/max) of a segment range, keeping min <= max.
   * Mutates `splitData.segments[segIdx].noteRange`.
   */
  function updateSegmentRange({ splitData, segIdx, bound, value }) {
    if (!splitData?.segments?.[segIdx]) return;
    const clamped = Math.max(0, Math.min(127, parseInt(value) || 0));
    const seg = splitData.segments[segIdx];
    if (bound === 'min') {
      seg.noteRange.min = clamped;
      if (clamped > seg.noteRange.max) seg.noteRange.max = clamped;
    } else {
      seg.noteRange.max = clamped;
      if (clamped < seg.noteRange.min) seg.noteRange.min = clamped;
    }
  }

  /**
   * Resolve an overlap between two segments by 'first', 'second', or 'shared'.
   * Mutates `splitData`.
   */
  function resolveOverlap({ splitData, overlapIdx, strategy }) {
    if (!splitData?.segments) return;
    const overlaps = detectOverlaps(splitData.segments);
    const ov = overlaps[overlapIdx];
    if (!ov) return;

    const segA = splitData.segments[ov.segA];
    const segB = splitData.segments[ov.segB];
    if (!segA?.noteRange || !segB?.noteRange) return;

    if (strategy === 'first') {
      segB.noteRange.min = ov.max + 1;
    } else if (strategy === 'second') {
      segA.noteRange.max = ov.min - 1;
    }
    splitData.overlapStrategy = strategy;
  }

  function buildInstrumentOptions({ channel, assignment, isSkipped, suggestions, lowScoreSuggestions, maxNameLen, escape, getDisplayName }) {
    const options = suggestions[String(channel)] || [];
    const lowOptions = lowScoreSuggestions[String(channel)] || [];
    const allOptions = [...options, ...lowOptions];
    const currentId = assignment?.instrumentId || '';

    const ignoreLabel = _t('autoAssign.overviewStatusSkipped') || 'Ignore';
    let html = `<option value="ignore" ${isSkipped ? 'selected' : ''}>${escape(ignoreLabel)}</option>`;

    if (allOptions.length === 0) return html;

    for (const opt of allOptions) {
      const inst = opt.instrument;
      const score = opt.compatibility?.score || 0;
      const name = getDisplayName(inst);
      const displayName = name.length > maxNameLen ? name.slice(0, maxNameLen - 1) + '\u2026' : name;
      const selected = (!isSkipped && inst.id === currentId) ? 'selected' : '';
      html += `<option value="${inst.id}" ${selected}>${escape(displayName)} (${score})</option>`;
    }
    return html;
  }

  function computePlayableNotes({ channel, selectedAssignments, channelAnalyses, adaptationSettings, autoAdaptation }) {
    const assignment = selectedAssignments[String(channel)];
    const analysis = channelAnalyses[parseInt(channel)] || assignment?.channelAnalysis;
    if (!assignment || !analysis?.noteDistribution) return null;

    const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
    const totalNotes = usedNotes.length;
    if (totalNotes === 0) return null;

    const instMin = assignment.noteRangeMin ?? 0;
    const instMax = assignment.noteRangeMax ?? 127;
    const adapt = adaptationSettings[String(channel)] || {};
    const semi = (autoAdaptation && adapt.pitchShift !== 'none') ? (adapt.transpositionSemitones || 0) : 0;
    const playable = usedNotes.filter(n => {
      const shifted = n + semi;
      return shifted >= instMin && shifted <= instMax;
    }).length;
    return { playable, total: totalNotes };
  }

  window.RoutingSummaryHelpers = Object.freeze({
    mergeHints,
    detectOverlaps,
    computeSplitCoverageScore,
    getCCName,
    getInstrumentCCs,
    computeCCSummary,
    resolveSegmentGmProgram,
    getInstrumentDisplayName,
    getChannelPolyphony,
    getInstrumentPolyphony,
    computePlayableNotes,
    buildInstrumentOptions,
    applyBehaviorMode,
    reclampSplitRanges,
    updateSegmentRange,
    resolveOverlap
  });
})();
