/**
 * @file src/midi/routing/ChannelSplitter.js
 * @description Splits a single MIDI channel across multiple instruments
 * of the same type when no single instrument can cover the channel
 * (note range too wide, polyphony too low, etc.).
 *
 * Three split strategies, selected by {@link AutoAssigner} based on the
 * channel profile:
 *   - `'range'`     — each instrument receives notes that fall inside
 *                     its own playable range.
 *   - `'polyphony'` — round-robin allocation when combined polyphony is
 *                     the bottleneck.
 *   - `'mixed'`     — combination of both — primary instrument covers
 *                     its range, overflow notes spill onto secondaries.
 *
 * The file is large (~870 LOC); only the public entry points carry full
 * JSDoc, internal helpers retain their existing inline documentation.
 */

import ScoringConfig from '../adaptation/ScoringConfig.js';

class ChannelSplitter {
  constructor(logger) {
    this.logger = logger;
    this.config = ScoringConfig.splitting || {};
  }

  /**
   * Selects the best instruments by channel range coverage.
   * Instead of taking the first N in DB order, picks those that
   * maximize combined coverage of the channel's note range.
   * @param {Array<Object>} instruments - Candidate instruments
   * @param {Object} channelAnalysis - Channel analysis
   * @param {number} maxCount - Maximum number of instruments to select
   * @returns {Array<Object>} - Instruments selected for optimal coverage
   */
  selectBestInstrumentsForCoverage(instruments, channelAnalysis, maxCount) {
    if (!channelAnalysis.noteRange || channelAnalysis.noteRange.min === null) {
      return instruments.slice(0, maxCount);
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    // Greedy selection by complementary coverage
    const selected = [];
    const remaining = [...instruments];
    const coveredNotes = new Set();

    while (selected.length < maxCount && remaining.length > 0) {
      let bestIdx = -1;
      let bestNewCoverage = -1;

      for (let i = 0; i < remaining.length; i++) {
        const inst = remaining[i];
        const instMin = inst.note_range_min != null ? inst.note_range_min : 0;
        const instMax = inst.note_range_max != null ? inst.note_range_max : 127;
        const effectiveMin = Math.max(instMin, channelMin);
        const effectiveMax = Math.min(instMax, channelMax);

        if (effectiveMin > effectiveMax) continue;

        // Count newly covered notes (not already covered)
        let newCoverage = 0;
        for (let n = effectiveMin; n <= effectiveMax; n++) {
          if (!coveredNotes.has(n)) newCoverage++;
        }

        if (newCoverage > bestNewCoverage) {
          bestNewCoverage = newCoverage;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const chosen = remaining.splice(bestIdx, 1)[0];
      selected.push(chosen);

      // Update coverage
      const instMin = chosen.note_range_min != null ? chosen.note_range_min : 0;
      const instMax = chosen.note_range_max != null ? chosen.note_range_max : 127;
      const effectiveMin = Math.max(instMin, channelMin);
      const effectiveMax = Math.min(instMax, channelMax);
      for (let n = effectiveMin; n <= effectiveMax; n++) {
        coveredNotes.add(n);
      }
    }

    return selected;
  }

  /**
   * Evaluates ALL possible split types and returns the best + alternatives.
   * Uses optimal coverage instrument selection instead of .slice(0, max).
   * @param {Object} channelAnalysis
   * @param {Array<Object>} sameTypeInstruments
   * @returns {Object|null} - { ...bestProposal, alternatives: [SplitProposal...] } or null
   */
  evaluateAllSplits(channelAnalysis, sameTypeInstruments) {
    const minInstruments = this.config.minInstruments || 2;
    const maxInstruments = this.config.maxInstruments || 4;

    if (!sameTypeInstruments || sameTypeInstruments.length < minInstruments) {
      return null;
    }

    if (!channelAnalysis.noteRange || channelAnalysis.noteRange.min === null) {
      return null;
    }

    // Smart selection: choose instruments by optimal coverage
    // For range/mixed splits, prefer 2 instruments (minimal cuts = highest score)
    const instrumentsFor2 = this.selectBestInstrumentsForCoverage(
      sameTypeInstruments,
      channelAnalysis,
      2
    );
    // For polyphony splits, select up to maxInstruments but the split itself will minimize
    const instrumentsForPoly = this.selectBestInstrumentsForCoverage(
      sameTypeInstruments,
      channelAnalysis,
      Math.min(maxInstruments, 4)
    );

    if (instrumentsFor2.length < minInstruments && instrumentsForPoly.length < minInstruments) {
      return null;
    }

    // Try full-coverage split first (2 instruments covering 100% of notes, with optional transposition)
    const fullCoverageSplit = this.calculateFullCoverageSplit(channelAnalysis, sameTypeInstruments);

    const rangeSplit =
      instrumentsFor2.length >= 2
        ? this.calculateRangeSplit(channelAnalysis, instrumentsFor2)
        : null;
    const polyphonySplit =
      instrumentsForPoly.length >= 2
        ? this.calculatePolyphonySplit(channelAnalysis, instrumentsForPoly)
        : null;
    const mixedSplit =
      instrumentsFor2.length >= 2
        ? this.calculateMixedSplit(channelAnalysis, instrumentsFor2)
        : null;

    const minQuality = this.config.minQuality || 50;
    const all = [fullCoverageSplit, rangeSplit, polyphonySplit, mixedSplit].filter(
      (s) => s !== null && s.quality >= minQuality
    );

    if (all.length === 0) return null;

    all.sort((a, b) => b.quality - a.quality);
    const best = all[0];
    const alternatives = all.slice(1);

    return { ...best, alternatives };
  }

  /**
   * Calculates a range-based split.
   * Each instrument receives notes within its physical range.
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculateRangeSplit(channelAnalysis, instruments) {
    if (
      !channelAnalysis.noteRange ||
      channelAnalysis.noteRange.min === null ||
      channelAnalysis.noteRange.max === null
    ) {
      return null;
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    // Filter instruments that have a defined range
    const withRange = instruments.filter(
      (inst) =>
        inst.note_range_min !== null &&
        inst.note_range_min !== undefined &&
        inst.note_range_max !== null &&
        inst.note_range_max !== undefined
    );

    if (withRange.length < 2) return null;

    // Sort by note_range_min ascending
    withRange.sort((a, b) => a.note_range_min - b.note_range_min);

    // Check combined coverage
    const combinedMin = Math.min(...withRange.map((i) => i.note_range_min));
    const combinedMax = Math.max(...withRange.map((i) => i.note_range_max));

    // Combined coverage must cover the channel
    if (combinedMin > channelMin || combinedMax < channelMax) {
      this.logger.debug(
        `Channel ${channelAnalysis.channel}: combined range [${combinedMin}-${combinedMax}] doesn't cover channel [${channelMin}-${channelMax}]`
      );
      return null;
    }

    // Build segments
    const segments = [];
    const overlapZones = [];

    for (let i = 0; i < withRange.length; i++) {
      const inst = withRange[i];
      const seg = this._buildSegment(inst, channelMin, channelMax);

      if (seg.noteRange.min > seg.noteRange.max) continue; // no overlap with channel

      segments.push(seg);

      // Detect overlap zones with the next segment
      if (i < withRange.length - 1) {
        const next = withRange[i + 1];
        const nextEffectiveMin = Math.max(next.note_range_min, channelMin);
        if (seg.noteRange.max >= nextEffectiveMin) {
          overlapZones.push({
            min: nextEffectiveMin,
            max: seg.noteRange.max,
            strategy: 'least_loaded',
            instruments: [inst.id, next.id]
          });
        }
      }
    }

    if (segments.length < 2) return null;

    // Check for gaps in coverage
    const gaps = this.findCoverageGaps(segments, channelMin, channelMax);

    // Calculate split quality
    const quality = this.scoreSplitQuality({
      type: 'range',
      segments,
      overlapZones,
      gaps,
      channelAnalysis
    });

    return {
      type: 'range',
      channel: channelAnalysis.channel,
      quality,
      segments,
      overlapZones,
      gaps
    };
  }

  /**
   * Calculates a polyphony-based split (round-robin).
   * Distributes notes across instruments when polyphony is insufficient.
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculatePolyphonySplit(channelAnalysis, instruments) {
    const channelMaxPoly = channelAnalysis.polyphony.max;

    // No need to split if channel polyphony is low
    if (channelMaxPoly <= 1) return null;

    // Keep all playable instruments (polyphony > 0), sort by descending polyphony
    const withPoly = instruments
      .filter((inst) => (inst.polyphony || 16) > 0)
      .sort((a, b) => (b.polyphony || 16) - (a.polyphony || 16));

    if (withPoly.length < 2) return null;

    // Check that no single instrument is sufficient (otherwise no split needed)
    const anyCoversAll = withPoly.some((inst) => (inst.polyphony || 16) >= channelMaxPoly);
    if (anyCoversAll) return null;

    // Find minimum number of instruments to cover channel polyphony
    let selected = [];
    let totalPolyphony = 0;
    for (const inst of withPoly) {
      selected.push(inst);
      totalPolyphony += inst.polyphony || 16;
      if (totalPolyphony >= channelMaxPoly) break;
    }

    // If not enough polyphony even with all instruments, use them all
    if (totalPolyphony < channelMaxPoly) {
      selected = withPoly;
      totalPolyphony = withPoly.reduce((sum, inst) => sum + (inst.polyphony || 16), 0);
      if (totalPolyphony < channelMaxPoly) {
        this.logger.debug(
          `Channel ${channelAnalysis.channel}: combined polyphony ${totalPolyphony} < channel max ${channelMaxPoly}`
        );
        return null;
      }
    }

    // Build round-robin segments (only selected instruments)
    const segments = selected.map((inst) =>
      this._buildSegment(inst, 0, 127, { strategy: 'round_robin' })
    );

    const quality = this.scoreSplitQuality({
      type: 'polyphony',
      segments,
      overlapZones: [],
      gaps: [],
      channelAnalysis
    });

    return {
      type: 'polyphony',
      channel: channelAnalysis.channel,
      quality,
      segments,
      overlapZones: [],
      gaps: []
    };
  }

  /**
   * Calculates a mixed split (range + polyphony).
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculateMixedSplit(channelAnalysis, instruments) {
    if (
      !channelAnalysis.noteRange ||
      channelAnalysis.noteRange.min === null ||
      channelAnalysis.noteRange.max === null
    ) {
      return null;
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    const withRange = instruments.filter(
      (inst) =>
        inst.note_range_min !== null &&
        inst.note_range_min !== undefined &&
        inst.note_range_max !== null &&
        inst.note_range_max !== undefined
    );

    if (withRange.length < 2) return null;

    withRange.sort((a, b) => a.note_range_min - b.note_range_min);

    // Build segments with range split AND polyphony sharing
    const segments = [];
    const overlapZones = [];

    for (let i = 0; i < withRange.length; i++) {
      const inst = withRange[i];
      const seg = this._buildSegment(inst, channelMin, channelMax, {
        strategy: 'range_with_polyphony'
      });

      if (seg.noteRange.min > seg.noteRange.max) continue;

      segments.push(seg);

      // Overlap zones -> round-robin within the zone
      if (i < withRange.length - 1) {
        const next = withRange[i + 1];
        const nextEffectiveMin = Math.max(next.note_range_min, channelMin);
        if (seg.noteRange.max >= nextEffectiveMin) {
          overlapZones.push({
            min: nextEffectiveMin,
            max: seg.noteRange.max,
            strategy: 'round_robin',
            instruments: [inst.id, next.id]
          });
        }
      }
    }

    if (segments.length < 2) return null;

    const gaps = this.findCoverageGaps(segments, channelMin, channelMax);

    const quality = this.scoreSplitQuality({
      type: 'mixed',
      segments,
      overlapZones,
      gaps,
      channelAnalysis
    });

    return {
      type: 'mixed',
      channel: channelAnalysis.channel,
      quality,
      segments,
      overlapZones,
      gaps
    };
  }

  /**
   * Build a segment object for a split proposal.
   * @param {Object} inst - Instrument
   * @param {number} channelMin - Channel note range min
   * @param {number} channelMax - Channel note range max
   * @param {Object} [extraProps] - Additional properties to merge
   * @returns {Object} Segment object
   */
  _buildSegment(inst, channelMin, channelMax, extraProps = {}) {
    const instMin = inst.note_range_min ?? 0;
    const instMax = inst.note_range_max ?? 127;
    return {
      instrumentId: inst.id,
      deviceId: inst.device_id,
      instrumentChannel: inst.channel,
      instrumentName: inst.name || inst.custom_name,
      gmProgram: inst.gm_program,
      noteRange: { min: Math.max(instMin, channelMin), max: Math.min(instMax, channelMax) },
      fullRange: { min: inst.note_range_min, max: inst.note_range_max },
      polyphonyShare: inst.polyphony || 16,
      ...extraProps
    };
  }

  /**
   * Finds gaps in segment coverage
   * @param {Array} segments
   * @param {number} channelMin
   * @param {number} channelMax
   * @returns {Array<{ min: number, max: number }>}
   */
  findCoverageGaps(segments, channelMin, channelMax) {
    if (segments.length === 0) return [{ min: channelMin, max: channelMax }];

    // Sort by noteRange.min
    const sorted = [...segments].sort((a, b) => a.noteRange.min - b.noteRange.min);
    const gaps = [];

    let currentEnd = channelMin - 1;
    for (const seg of sorted) {
      if (seg.noteRange.min > currentEnd + 1) {
        gaps.push({ min: currentEnd + 1, max: seg.noteRange.min - 1 });
      }
      currentEnd = Math.max(currentEnd, seg.noteRange.max);
    }

    if (currentEnd < channelMax) {
      gaps.push({ min: currentEnd + 1, max: channelMax });
    }

    return gaps;
  }

  /**
   * Calculates a "full coverage" split: finds 2 instruments covering 100% of the channel's notes.
   * Tries without transposition first, then with octave transpositions (+-12, +-24).
   * Prioritizes pairs requiring the least transposition.
   *
   * @param {Object} channelAnalysis
   * @param {Array<Object>} allInstruments - Full instrument pool (not the selected subset)
   * @returns {SplitProposal|null}
   */
  calculateFullCoverageSplit(channelAnalysis, allInstruments) {
    if (!channelAnalysis.noteRange || channelAnalysis.noteRange.min === null) return null;
    if (!allInstruments || allInstruments.length < 2) return null;

    const chMin = channelAnalysis.noteRange.min;
    const chMax = channelAnalysis.noteRange.max;
    const channelNotes = new Set();
    // Use actual note distribution if available, otherwise use full range
    if (channelAnalysis.noteDistribution) {
      for (const n of Object.keys(channelAnalysis.noteDistribution)) channelNotes.add(Number(n));
    } else {
      for (let n = chMin; n <= chMax; n++) channelNotes.add(n);
    }
    if (channelNotes.size === 0) return null;

    const totalNotes = channelNotes.size;
    const transpositions = [0, -12, 12, -24, 24]; // Try no transposition first
    const penaltyPerOctave = this.config?.penalties?.transpositionPerOctave || 3;
    const maxOctaves = this.config?.penalties?.maxTranspositionOctaves || 3;

    let bestPair = null;
    let bestPenalty = Infinity;

    // Filter instruments with defined ranges
    const viable = allInstruments.filter(
      (inst) => inst.note_range_min != null && inst.note_range_max != null
    );

    for (let a = 0; a < viable.length; a++) {
      for (let b = a + 1; b < viable.length; b++) {
        const instA = viable[a];
        const instB = viable[b];

        // Try transposition combinations for each instrument
        for (const trA of transpositions) {
          if (Math.abs(trA) > maxOctaves * 12) continue;
          for (const trB of transpositions) {
            if (Math.abs(trB) > maxOctaves * 12) continue;

            const aMin = instA.note_range_min + trA;
            const aMax = instA.note_range_max + trA;
            const bMin = instB.note_range_min + trB;
            const bMax = instB.note_range_max + trB;

            // Count how many channel notes are covered
            let covered = 0;
            for (const note of channelNotes) {
              if ((note >= aMin && note <= aMax) || (note >= bMin && note <= bMax)) {
                covered++;
              }
            }

            if (covered === totalNotes) {
              // Full coverage! Compute transposition penalty
              const penalty =
                Math.abs(trA / 12) * penaltyPerOctave + Math.abs(trB / 12) * penaltyPerOctave;
              if (penalty < bestPenalty) {
                bestPenalty = penalty;
                bestPair = { instA, instB, trA, trB, aMin, aMax, bMin, bMax };
              }
            }
          }
          // Optimization: if we already have a pair without transposition, no need to search further for this instrument
          if (bestPair && bestPenalty === 0) break;
        }
        if (bestPair && bestPenalty === 0) break;
      }
      if (bestPair && bestPenalty === 0) break;
    }

    if (!bestPair) return null;

    const { instA, instB, trA, trB, aMin, aMax, bMin, bMax } = bestPair;

    const segments = [
      {
        instrumentId: instA.id,
        deviceId: instA.device_id,
        instrumentChannel: instA.channel,
        instrumentName: instA.name || instA.custom_name,
        gmProgram: instA.gm_program,
        noteRange: { min: Math.max(chMin, aMin), max: Math.min(chMax, aMax) },
        fullRange: { min: instA.note_range_min, max: instA.note_range_max },
        polyphonyShare: instA.polyphony || 16,
        transposition: trA !== 0 ? { semitones: trA } : undefined
      },
      {
        instrumentId: instB.id,
        deviceId: instB.device_id,
        instrumentChannel: instB.channel,
        instrumentName: instB.name || instB.custom_name,
        gmProgram: instB.gm_program,
        noteRange: { min: Math.max(chMin, bMin), max: Math.min(chMax, bMax) },
        fullRange: { min: instB.note_range_min, max: instB.note_range_max },
        polyphonyShare: instB.polyphony || 16,
        transposition: trB !== 0 ? { semitones: trB } : undefined
      }
    ];

    // Detect overlap
    const overlapMin = Math.max(segments[0].noteRange.min, segments[1].noteRange.min);
    const overlapMax = Math.min(segments[0].noteRange.max, segments[1].noteRange.max);
    const overlapZones =
      overlapMin <= overlapMax
        ? [
            {
              min: overlapMin,
              max: overlapMax,
              strategy: 'least_loaded',
              instruments: [instA.id, instB.id]
            }
          ]
        : [];

    const proposal = {
      type: 'fullCoverage',
      channel: channelAnalysis.channel,
      segments,
      overlapZones,
      gaps: [], // Full coverage = no gaps
      channelAnalysis
    };

    // Score: full coverage + 2 instruments = high score, minus transposition penalty
    proposal.quality = Math.max(50, Math.round(this.scoreSplitQuality(proposal) - bestPenalty));

    return proposal;
  }

  /**
   * Split quality score (0-100).
   * @param {Object} proposal
   * @returns {number}
   */
  scoreSplitQuality(proposal) {
    const weights = this.config.weights || {
      noteCoverage: 40,
      polyphonyCoverage: 25,
      minimalCuts: 20,
      minimalOverlap: 15
    };

    const { segments, overlapZones, gaps, channelAnalysis } = proposal;
    let score = 0;

    // 1. Note coverage (40%)
    const channelSpan = channelAnalysis.noteRange.max - channelAnalysis.noteRange.min + 1;
    if (channelSpan > 0) {
      const gapSize = (gaps || []).reduce((sum, g) => sum + (g.max - g.min + 1), 0);
      const coverage = 1 - gapSize / channelSpan;
      score += coverage * weights.noteCoverage;
    } else {
      score += weights.noteCoverage;
    }

    // 2. Sufficient polyphony (25%)
    const totalPoly = segments.reduce((sum, s) => sum + s.polyphonyShare, 0);
    const channelMaxPoly = channelAnalysis.polyphony.max || 1;
    const polyRatio = Math.min(1, totalPoly / channelMaxPoly);
    score += polyRatio * weights.polyphonyCoverage;

    // 3. Minimal number of cuts (20%) - fewer segments = better
    const cutPenalty = Math.max(0, 1 - (segments.length - 2) * 0.25);
    score += cutPenalty * weights.minimalCuts;

    // 4. Minimal overlap (15%) - less overlap = better
    if (overlapZones.length === 0) {
      score += weights.minimalOverlap;
    } else {
      const totalOverlap = overlapZones.reduce((sum, z) => sum + (z.max - z.min + 1), 0);
      const overlapRatio = channelSpan > 0 ? totalOverlap / channelSpan : 0;
      score += (1 - Math.min(1, overlapRatio)) * weights.minimalOverlap;
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }
}

export default ChannelSplitter;
