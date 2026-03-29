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
   * Évalue si un canal peut être splitté entre plusieurs instruments du même type
   * @param {Object} channelAnalysis - Analyse du canal (noteRange, polyphony, etc.)
   * @param {Array<Object>} sameTypeInstruments - Instruments du même type avec capabilities
   * @returns {SplitProposal|null} - Proposition de split ou null si non applicable
   */
  evaluateSplit(channelAnalysis, sameTypeInstruments) {
    const minInstruments = this.config.minInstruments || 2;
    const maxInstruments = this.config.maxInstruments || 4;

    if (!sameTypeInstruments || sameTypeInstruments.length < minInstruments) {
      return null;
    }

    // Limiter au max d'instruments
    const instruments = sameTypeInstruments.slice(0, maxInstruments);

    // Pas de split si le canal n'a pas de notes
    if (!channelAnalysis.noteRange || channelAnalysis.noteRange.min === null) {
      return null;
    }

    // Évaluer les différents modes de split
    const rangeSplit = this.calculateRangeSplit(channelAnalysis, instruments);
    const polyphonySplit = this.calculatePolyphonySplit(channelAnalysis, instruments);

    // Choisir le meilleur split
    const candidates = [rangeSplit, polyphonySplit].filter(s => s !== null);

    if (candidates.length === 0) {
      // Tenter un split mixte si ni range ni polyphonie seuls ne marchent
      const mixedSplit = this.calculateMixedSplit(channelAnalysis, instruments);
      if (mixedSplit) candidates.push(mixedSplit);
    }

    if (candidates.length === 0) {
      return null;
    }

    // Prendre le split de meilleure qualité
    candidates.sort((a, b) => b.quality - a.quality);
    const best = candidates[0];

    const minQuality = this.config.minQuality || 50;
    if (best.quality < minQuality) {
      this.logger.debug(`Channel ${channelAnalysis.channel}: split quality ${best.quality} below threshold ${minQuality}`);
      return null;
    }

    return best;
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
    const channelSpan = channelMax - channelMin;

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
  scoreSplitQuality(proposal) {
    const weights = this.config.weights || {
      noteCoverage: 40,
      polyphonyCoverage: 25,
      minimalCuts: 20,
      minimalOverlap: 15
    };

    const { segments, overlapZones, gaps, channelAnalysis, type } = proposal;
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
