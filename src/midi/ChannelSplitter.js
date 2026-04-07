// src/midi/ChannelSplitter.js

import ScoringConfig from './ScoringConfig.js';

/**
 * ChannelSplitter - Découpe un canal MIDI entre plusieurs instruments
 *
 * Permet d'assigner un canal MIDI à plusieurs instruments du même type
 * lorsqu'un seul instrument ne peut pas couvrir toutes les notes ou
 * que la polyphonie est insuffisante.
 *
 * Modes de split :
 * - 'range' : chaque instrument reçoit les notes de sa plage
 * - 'polyphony' : round-robin quand la polyphonie combinée est nécessaire
 * - 'mixed' : combinaison des deux modes
 */
class ChannelSplitter {
  constructor(logger) {
    this.logger = logger;
    this.config = ScoringConfig.splitting || {};
  }

  /**
   * Sélectionne les meilleurs instruments par couverture de la plage du canal.
   * Au lieu de prendre les N premiers dans l'ordre BDD, on choisit ceux qui
   * maximisent la couverture combinée de la plage de notes du canal.
   * @param {Array<Object>} instruments - Instruments candidats
   * @param {Object} channelAnalysis - Analyse du canal
   * @param {number} maxCount - Nombre max d'instruments à sélectionner
   * @returns {Array<Object>} - Instruments sélectionnés par couverture optimale
   */
  selectBestInstrumentsForCoverage(instruments, channelAnalysis, maxCount) {
    if (!channelAnalysis.noteRange || channelAnalysis.noteRange.min === null) {
      return instruments.slice(0, maxCount);
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    // Sélection gloutonne par complémentarité de couverture
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

        // Compter les nouvelles notes couvertes (pas déjà couvertes)
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

      // Mettre à jour la couverture
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
   * Évalue si un canal peut être splitté entre plusieurs instruments du même type.
   * Délègue à evaluateAllSplits et retourne uniquement le meilleur résultat.
   * @param {Object} channelAnalysis - Analyse du canal (noteRange, polyphony, etc.)
   * @param {Array<Object>} sameTypeInstruments - Instruments du même type avec capabilities
   * @returns {SplitProposal|null} - Proposition de split ou null si non applicable
   */
  evaluateSplit(channelAnalysis, sameTypeInstruments) {
    const result = this.evaluateAllSplits(channelAnalysis, sameTypeInstruments);
    if (!result) return null;
    // Retourner le meilleur sans les alternatives
    const { alternatives, ...best } = result;
    return best;
  }

  /**
   * Évalue TOUS les types de split possibles et retourne le meilleur + les alternatives.
   * Utilise une sélection d'instruments par couverture optimale au lieu de .slice(0, max).
   * @param {Object} channelAnalysis
   * @param {Array<Object>} sameTypeInstruments
   * @returns {Object|null} - { ...bestProposal, alternatives: [SplitProposal...] } ou null
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

    // Sélection intelligente : choisir les instruments par couverture optimale
    // For range/mixed splits, prefer 2 instruments (minimal cuts = highest score)
    const instrumentsFor2 = this.selectBestInstrumentsForCoverage(
      sameTypeInstruments, channelAnalysis, 2
    );
    // For polyphony splits, allow more instruments
    const instrumentsForPoly = this.selectBestInstrumentsForCoverage(
      sameTypeInstruments, channelAnalysis, maxInstruments
    );

    if (instrumentsFor2.length < minInstruments && instrumentsForPoly.length < minInstruments) {
      return null;
    }

    // Try full-coverage split first (2 instruments covering 100% of notes, with optional transposition)
    const fullCoverageSplit = this.calculateFullCoverageSplit(channelAnalysis, sameTypeInstruments);

    const rangeSplit = instrumentsFor2.length >= 2 ? this.calculateRangeSplit(channelAnalysis, instrumentsFor2) : null;
    const polyphonySplit = instrumentsForPoly.length >= 2 ? this.calculatePolyphonySplit(channelAnalysis, instrumentsForPoly) : null;
    const mixedSplit = instrumentsFor2.length >= 2 ? this.calculateMixedSplit(channelAnalysis, instrumentsFor2) : null;

    const minQuality = this.config.minQuality || 50;
    const all = [fullCoverageSplit, rangeSplit, polyphonySplit, mixedSplit].filter(s => s !== null && s.quality >= minQuality);

    if (all.length === 0) return null;

    all.sort((a, b) => b.quality - a.quality);
    const best = all[0];
    const alternatives = all.slice(1);

    return { ...best, alternatives };
  }

  /**
   * Calcule un split par plage de notes
   * Chaque instrument reçoit les notes de sa plage physique
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculateRangeSplit(channelAnalysis, instruments) {
    if (!channelAnalysis.noteRange ||
        channelAnalysis.noteRange.min === null ||
        channelAnalysis.noteRange.max === null) {
      return null;
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    // Filtrer les instruments qui ont une plage définie
    const withRange = instruments.filter(inst =>
      inst.note_range_min !== null && inst.note_range_min !== undefined &&
      inst.note_range_max !== null && inst.note_range_max !== undefined
    );

    if (withRange.length < 2) return null;

    // Trier par note_range_min croissant
    withRange.sort((a, b) => a.note_range_min - b.note_range_min);

    // Vérifier la couverture combinée
    const combinedMin = Math.min(...withRange.map(i => i.note_range_min));
    const combinedMax = Math.max(...withRange.map(i => i.note_range_max));

    // La couverture combinée doit couvrir le canal
    if (combinedMin > channelMin || combinedMax < channelMax) {
      this.logger.debug(`Channel ${channelAnalysis.channel}: combined range [${combinedMin}-${combinedMax}] doesn't cover channel [${channelMin}-${channelMax}]`);
      return null;
    }

    // Construire les segments
    const segments = [];
    const overlapZones = [];

    for (let i = 0; i < withRange.length; i++) {
      const inst = withRange[i];

      // Déterminer les bornes effectives de ce segment
      // (clipper à la plage du canal)
      const effectiveMin = Math.max(inst.note_range_min, channelMin);
      const effectiveMax = Math.min(inst.note_range_max, channelMax);

      if (effectiveMin > effectiveMax) continue; // pas de chevauchement avec le canal

      segments.push({
        instrumentId: inst.id,
        deviceId: inst.device_id,
        instrumentChannel: inst.channel,
        instrumentName: inst.name || inst.custom_name,
        noteRange: { min: effectiveMin, max: effectiveMax },
        fullRange: { min: inst.note_range_min, max: inst.note_range_max },
        polyphonyShare: inst.polyphony || 16
      });

      // Détecter les zones de recouvrement avec le segment suivant
      if (i < withRange.length - 1) {
        const next = withRange[i + 1];
        const nextEffectiveMin = Math.max(next.note_range_min, channelMin);
        if (effectiveMax >= nextEffectiveMin) {
          overlapZones.push({
            min: nextEffectiveMin,
            max: effectiveMax,
            strategy: 'least_loaded',
            instruments: [inst.id, next.id]
          });
        }
      }
    }

    if (segments.length < 2) return null;

    // Vérifier qu'il n'y a pas de trous dans la couverture
    const gaps = this.findCoverageGaps(segments, channelMin, channelMax);

    // Calculer la qualité du split
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
   * Calcule un split par polyphonie (round-robin)
   * Distribue les notes entre instruments quand la polyphonie est insuffisante
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculatePolyphonySplit(channelAnalysis, instruments) {
    const channelMaxPoly = channelAnalysis.polyphony.max;

    // Pas besoin de split si la polyphonie du canal est faible
    if (channelMaxPoly <= 1) return null;

    // Garder tous les instruments jouables (polyphonie > 0)
    const withPoly = instruments.filter(inst => (inst.polyphony || 16) > 0);

    if (withPoly.length < 2) return null;

    // Vérifier qu'aucun instrument seul ne suffit (sinon pas besoin de split)
    const anyCoversAll = withPoly.some(inst => (inst.polyphony || 16) >= channelMaxPoly);
    if (anyCoversAll) return null;

    // Calculer la polyphonie combinée
    const totalPolyphony = withPoly.reduce((sum, inst) => sum + (inst.polyphony || 16), 0);

    // La polyphonie combinée doit être suffisante
    if (totalPolyphony < channelMaxPoly) {
      this.logger.debug(`Channel ${channelAnalysis.channel}: combined polyphony ${totalPolyphony} < channel max ${channelMaxPoly}`);
      return null;
    }

    // Construire les segments en round-robin
    const segments = withPoly.map(inst => ({
      instrumentId: inst.id,
      deviceId: inst.device_id,
      instrumentChannel: inst.channel,
      instrumentName: inst.name || inst.custom_name,
      noteRange: {
        min: inst.note_range_min !== null ? inst.note_range_min : 0,
        max: inst.note_range_max !== null ? inst.note_range_max : 127
      },
      fullRange: { min: inst.note_range_min, max: inst.note_range_max },
      polyphonyShare: inst.polyphony || 16,
      strategy: 'round_robin'
    }));

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
   * Calcule un split mixte (plage + polyphonie)
   * @param {Object} channelAnalysis
   * @param {Array<Object>} instruments
   * @returns {SplitProposal|null}
   */
  calculateMixedSplit(channelAnalysis, instruments) {
    if (!channelAnalysis.noteRange ||
        channelAnalysis.noteRange.min === null ||
        channelAnalysis.noteRange.max === null) {
      return null;
    }

    const channelMin = channelAnalysis.noteRange.min;
    const channelMax = channelAnalysis.noteRange.max;

    const withRange = instruments.filter(inst =>
      inst.note_range_min !== null && inst.note_range_min !== undefined &&
      inst.note_range_max !== null && inst.note_range_max !== undefined
    );

    if (withRange.length < 2) return null;

    withRange.sort((a, b) => a.note_range_min - b.note_range_min);

    // Construire les segments avec split de plage ET partage de polyphonie
    const segments = [];
    const overlapZones = [];

    for (let i = 0; i < withRange.length; i++) {
      const inst = withRange[i];
      const effectiveMin = Math.max(inst.note_range_min, channelMin);
      const effectiveMax = Math.min(inst.note_range_max, channelMax);

      if (effectiveMin > effectiveMax) continue;

      segments.push({
        instrumentId: inst.id,
        deviceId: inst.device_id,
        instrumentChannel: inst.channel,
        instrumentName: inst.name || inst.custom_name,
        noteRange: { min: effectiveMin, max: effectiveMax },
        fullRange: { min: inst.note_range_min, max: inst.note_range_max },
        polyphonyShare: inst.polyphony || 16,
        strategy: 'range_with_polyphony'
      });

      // Zones de recouvrement → round-robin dans la zone
      if (i < withRange.length - 1) {
        const next = withRange[i + 1];
        const nextEffectiveMin = Math.max(next.note_range_min, channelMin);
        if (effectiveMax >= nextEffectiveMin) {
          overlapZones.push({
            min: nextEffectiveMin,
            max: effectiveMax,
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
   * Trouve les trous dans la couverture des segments
   * @param {Array} segments
   * @param {number} channelMin
   * @param {number} channelMax
   * @returns {Array<{ min: number, max: number }>}
   */
  findCoverageGaps(segments, channelMin, channelMax) {
    if (segments.length === 0) return [{ min: channelMin, max: channelMax }];

    // Trier par noteRange.min
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
   * Score de qualité du split proposé (0-100)
   * @param {Object} proposal
   * @returns {number}
   */
  /**
   * Calcule un split "full coverage" : trouver 2 instruments qui couvrent 100% des notes du canal.
   * Essaie d'abord sans transposition, puis avec transpositions par octave (±12, ±24).
   * Priorise les paires avec le moins de transposition necessaire.
   *
   * @param {Object} channelAnalysis
   * @param {Array<Object>} allInstruments - Pool complet d'instruments (pas le subset selectionne)
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
    const viable = allInstruments.filter(inst =>
      inst.note_range_min != null && inst.note_range_max != null
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
              const penalty = Math.abs(trA / 12) * penaltyPerOctave + Math.abs(trB / 12) * penaltyPerOctave;
              if (penalty < bestPenalty) {
                bestPenalty = penalty;
                bestPair = { instA, instB, trA, trB, aMin, aMax, bMin, bMax };
              }
            }
          }
          // Optimisation: si on a deja une paire sans transposition, pas besoin de chercher plus loin pour cet instrument
          if (bestPair && bestPenalty === 0) break;
        }
        if (bestPair && bestPenalty === 0) break;
      }
      if (bestPair && bestPenalty === 0) break;
    }

    if (!bestPair) return null;

    const { instA, instB, trA, trB, aMin, aMax, bMin, bMax } = bestPair;

    // Build segment note ranges: split at the boundary where one instrument ends and the other begins
    // Each note goes to whichever instrument covers it; for overlapping notes, assign to instrument A
    let splitPoint = chMin;
    for (const note of [...channelNotes].sort((a, b) => a - b)) {
      const inA = note >= aMin && note <= aMax;
      const inB = note >= bMin && note <= bMax;
      if (inA && !inB) continue; // clearly A
      if (!inA && inB) { splitPoint = note; break; } // boundary
      // Both cover it → let A handle low notes
    }

    // Determine effective ranges for each segment based on actual channel notes
    const notesArr = [...channelNotes].sort((a, b) => a - b);
    const segANotes = notesArr.filter(n => n >= aMin && n <= aMax);
    const segBNotes = notesArr.filter(n => n >= bMin && n <= bMax && !(n >= aMin && n <= aMax && segANotes.length > 0));
    // If some notes only in B, or assign notes to minimize overlap
    const segAMin = segANotes.length > 0 ? Math.min(...segANotes) : chMin;
    const segAMax = segANotes.length > 0 ? Math.max(...segANotes) : chMin;
    const segBMin = segBNotes.length > 0 ? Math.min(...segBNotes) : segAMax + 1;
    const segBMax = segBNotes.length > 0 ? Math.max(...segBNotes) : chMax;

    const segments = [
      {
        instrumentId: instA.id,
        deviceId: instA.device_id,
        instrumentChannel: instA.channel,
        instrumentName: instA.name || instA.custom_name,
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
        noteRange: { min: Math.max(chMin, bMin), max: Math.min(chMax, bMax) },
        fullRange: { min: instB.note_range_min, max: instB.note_range_max },
        polyphonyShare: instB.polyphony || 16,
        transposition: trB !== 0 ? { semitones: trB } : undefined
      }
    ];

    // Detect overlap
    const overlapMin = Math.max(segments[0].noteRange.min, segments[1].noteRange.min);
    const overlapMax = Math.min(segments[0].noteRange.max, segments[1].noteRange.max);
    const overlapZones = overlapMin <= overlapMax ? [{
      min: overlapMin, max: overlapMax,
      strategy: 'least_loaded',
      instruments: [instA.id, instB.id]
    }] : [];

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

  scoreSplitQuality(proposal) {
    const weights = this.config.weights || {
      noteCoverage: 40,
      polyphonyCoverage: 25,
      minimalCuts: 20,
      minimalOverlap: 15
    };

    const { segments, overlapZones, gaps, channelAnalysis } = proposal;
    let score = 0;

    // 1. Couverture des notes (40%)
    const channelSpan = channelAnalysis.noteRange.max - channelAnalysis.noteRange.min + 1;
    if (channelSpan > 0) {
      const gapSize = (gaps || []).reduce((sum, g) => sum + (g.max - g.min + 1), 0);
      const coverage = 1 - (gapSize / channelSpan);
      score += coverage * weights.noteCoverage;
    } else {
      score += weights.noteCoverage;
    }

    // 2. Polyphonie suffisante (25%)
    const totalPoly = segments.reduce((sum, s) => sum + s.polyphonyShare, 0);
    const channelMaxPoly = channelAnalysis.polyphony.max || 1;
    const polyRatio = Math.min(1, totalPoly / channelMaxPoly);
    score += polyRatio * weights.polyphonyCoverage;

    // 3. Nombre de coupures minimal (20%) - moins de segments = mieux
    const cutPenalty = Math.max(0, 1 - (segments.length - 2) * 0.25);
    score += cutPenalty * weights.minimalCuts;

    // 4. Recouvrement minimal (15%) - moins de recouvrement = mieux
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
