// public/js/features/auto-assign/RoutingSummaryAssignmentBuilder.js
// Pure state → apply_assignments payload builder (P2-F.3, plan §11 step 3).
// Extracted from RoutingSummaryPage._applyRouting so the transformation can
// be unit-tested and reused without a DOM.

(function() {
  'use strict';

  const RSC = window.RoutingSummaryConstants;

  /**
   * Build the assignments payload sent to `apply_assignments`.
   *
   * @param {object} state
   * @param {object} state.selectedAssignments
   * @param {object} state.splitAssignments
   * @param {Set<number>} state.splitChannels
   * @param {Set<number>} state.skippedChannels
   * @param {object} state.adaptationSettings      - per-channel
   * @param {object} state.ccRemapping             - per-channel
   * @param {object} state.ccSegmentMute           - per-channel, per-cc, Set of segment indices
   * @param {boolean} state.autoAdaptation
   * @param {(ch: number) => number|null} state.getInstrumentPolyphony
   * @param {(ch: number) => number} state.getChannelVolume
   * @returns {{ assignments: object, hasAssignment: boolean, hasSplit: boolean }}
   */
  function buildAssignmentsPayload(state) {
    const {
      selectedAssignments, splitAssignments,
      splitChannels, skippedChannels,
      adaptationSettings, ccRemapping, ccSegmentMute,
      autoAdaptation,
      getInstrumentPolyphony, getChannelVolume
    } = state;

    const assignments = {};
    let hasAssignment = false;
    let hasSplit = false;

    // Non-split channels
    for (const [ch, assignment] of Object.entries(selectedAssignments || {})) {
      const chNum = parseInt(ch, 10);
      if (skippedChannels && skippedChannels.has(chNum)) continue;
      if (splitChannels && splitChannels.has(chNum)) continue;
      if (!assignment || !assignment.deviceId) continue;

      const adapt = (adaptationSettings && adaptationSettings[ch]) || {};
      const semitones = autoAdaptation ? (adapt.transpositionSemitones || 0) : 0;
      const oorSuppress = autoAdaptation ? (adapt.oorHandling === 'suppress') : false;
      const oorCompress = autoAdaptation ? (adapt.oorHandling === 'compress') : false;

      const polyEnabled = autoAdaptation && adapt.polyReduction && adapt.polyReduction !== 'none';
      let polyTarget = null;
      if (polyEnabled) {
        if (adapt.polyReduction === 'manual' && adapt.polyTarget != null) {
          polyTarget = adapt.polyTarget;
        } else {
          const fromInstrument = getInstrumentPolyphony ? getInstrumentPolyphony(parseInt(ch, 10)) : null;
          polyTarget = fromInstrument || RSC.getGmDefaultPolyphony(assignment.gmProgram);
        }
      }

      assignments[ch] = {
        deviceId: assignment.deviceId,
        instrumentId: assignment.instrumentId,
        instrumentChannel: assignment.instrumentChannel,
        instrumentName: assignment.customName || assignment.instrumentName,
        transposition: { semitones },
        noteRemapping: assignment.noteRemapping || null,
        suppressOutOfRange: oorSuppress,
        noteCompression: oorCompress,
        gmProgram: assignment.gmProgram,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        noteSelectionMode: assignment.noteSelectionMode,
        score: assignment.score,
        ccRemapping: (ccRemapping && ccRemapping[ch]) || null,
        polyReduction: polyEnabled,
        maxPolyphony: polyTarget,
        polyStrategy: polyEnabled ? (adapt.polyStrategy || 'shorten') : null,
        channelVolume: getChannelVolume ? getChannelVolume(parseInt(ch, 10)) : 100
      };
      hasAssignment = true;
    }

    // Split channels
    for (const [ch, splitData] of Object.entries(splitAssignments || {})) {
      const chNum = parseInt(ch, 10);
      if (!splitChannels || !splitChannels.has(chNum)) continue;
      if (!splitData || !Array.isArray(splitData.segments) || splitData.segments.length === 0) continue;

      const adapt = (adaptationSettings && adaptationSettings[ch]) || {};
      const splitSemitones = autoAdaptation ? (adapt.transpositionSemitones || 0) : 0;

      const segMuteData = ccSegmentMute && ccSegmentMute[chNum];
      const ccSegMuteSerialized = segMuteData
        ? Object.fromEntries(
          Object.entries(segMuteData).map(([cc, segs]) => [cc, [...segs]])
        )
        : null;

      assignments[ch] = {
        split: true,
        splitMode: splitData.type || 'range',
        overlapStrategy: splitData.overlapStrategy || null,
        behaviorMode: splitData.behaviorMode || null,
        transposition: { semitones: splitSemitones },
        suppressOutOfRange: autoAdaptation ? (adapt.oorHandling === 'suppress') : false,
        noteCompression: autoAdaptation ? (adapt.oorHandling === 'compress') : false,
        ccRemapping: (ccRemapping && ccRemapping[ch]) || null,
        ccSegmentMute: ccSegMuteSerialized,
        channelVolume: getChannelVolume ? getChannelVolume(parseInt(ch, 10)) : 100,
        segments: splitData.segments.map((seg) => ({
          deviceId: seg.deviceId,
          instrumentId: seg.instrumentId,
          instrumentChannel: seg.instrumentChannel,
          instrumentName: seg.instrumentName,
          noteRange: seg.noteRange,
          fullRange: seg.fullRange,
          polyphonyShare: seg.polyphonyShare,
          score: splitData.quality || null,
          transposition: seg.transposition || undefined
        }))
      };
      hasAssignment = true;
      hasSplit = true;
    }

    return { assignments, hasAssignment, hasSplit };
  }

  /**
   * Detect whether the assignments require a physical file modification
   * (split / transposition / out-of-range handling / CC remapping / volume change).
   */
  function computeModificationFlags(assignments, hasSplit) {
    let hasTransposition = false;
    let hasOorSuppression = false;
    let hasCCRemap = false;
    let hasVolumeChange = false;

    for (const a of Object.values(assignments || {})) {
      if (a.transposition?.semitones && a.transposition.semitones !== 0) hasTransposition = true;
      if (a.suppressOutOfRange) hasOorSuppression = true;
      if (a.noteCompression) hasOorSuppression = true;
      if (a.ccRemapping && Object.keys(a.ccRemapping).length > 0) hasCCRemap = true;
      if (a.channelVolume !== undefined && a.channelVolume !== 100) hasVolumeChange = true;
    }

    return {
      hasTransposition,
      hasOorSuppression,
      hasCCRemap,
      hasVolumeChange,
      needsFileModification: !!hasSplit || hasTransposition || hasOorSuppression || hasCCRemap || hasVolumeChange
    };
  }

  window.RoutingSummaryAssignmentBuilder = Object.freeze({
    buildAssignmentsPayload,
    computeModificationFlags
  });
})();
