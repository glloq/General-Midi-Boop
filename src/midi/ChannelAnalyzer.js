// src/midi/ChannelAnalyzer.js

import ScoringConfig from './ScoringConfig.js';

/**
 * ChannelAnalyzer - Analyse les caractéristiques d'un canal MIDI
 *
 * Extrait les informations importantes d'un canal :
 * - Plage de notes (min/max)
 * - Distribution des notes
 * - Polyphonie (max/moyenne)
 * - Contrôleurs MIDI utilisés
 * - Programme MIDI principal
 * - Type d'instrument estimé
 */
class ChannelAnalyzer {
  constructor(logger, config = null) {
    this.logger = logger;
    this.config = config || ScoringConfig;
  }

  /**
   * Analyse tous les canaux actifs dans un fichier MIDI
   * @param {Object} midiData - Fichier MIDI parsé
   * @returns {Array<ChannelAnalysis>}
   */
  analyzeAllChannels(midiData) {
    const activeChannels = this.extractActiveChannels(midiData);
    return activeChannels.map(channel => this.analyzeChannel(midiData, channel));
  }

  /**
   * Extrait les numéros de canaux actifs (qui contiennent des notes)
   * @param {Object} midiData - Fichier MIDI parsé
   * @returns {Array<number>} - Canaux actifs (0-15)
   */
  extractActiveChannels(midiData) {
    const channels = new Set();

    if (!midiData || !midiData.tracks) {
      return [];
    }

    for (const track of midiData.tracks) {
      if (!track.events) continue;

      for (const event of track.events) {
        if (event.channel !== undefined &&
            (event.type === 'noteOn' || event.type === 'noteOff')) {
          channels.add(event.channel);
        }
      }
    }

    return Array.from(channels).sort((a, b) => a - b);
  }

  /**
   * Analyse un canal MIDI spécifique
   * @param {Object} midiData - Fichier MIDI parsé
   * @param {number} channel - Canal à analyser (0-15)
   * @returns {ChannelAnalysis}
   */
  analyzeChannel(midiData, channel) {
    const events = this.getChannelEvents(midiData, channel);
    const noteEvents = events.filter(e => e.type === 'noteOn' || e.type === 'noteOff');

    const noteRange = this.extractNoteRange(noteEvents);
    const noteDistribution = this.buildNoteHistogram(noteEvents);
    const totalNotes = this.countNotes(noteEvents);
    const polyphony = this.calculatePolyphony(noteEvents);
    const usedCCs = this.extractUsedCCs(events);
    const usesPitchBend = this.hasPitchBend(events);
    const programs = this.extractPrograms(events);
    const primaryProgram = this.getPrimaryProgram(programs);
    const bankSelect = this.extractBankSelect(events);
    const trackNames = this.getTrackNames(midiData, channel);
    const density = this.calculateNoteDensity(noteEvents, midiData.duration || 0);

    const typeEstimation = this.estimateInstrumentType({
      channel,
      noteRange,
      noteDistribution,
      totalNotes,
      polyphony,
      primaryProgram,
      density,
      trackNames
    });

    return {
      channel,
      noteRange,
      noteDistribution,
      totalNotes,
      polyphony,
      usedCCs,
      usesPitchBend,
      programs,
      primaryProgram,
      bankMSB: bankSelect.msb,
      bankLSB: bankSelect.lsb,
      trackNames,
      density,
      estimatedType: typeEstimation.type,
      typeConfidence: typeEstimation.confidence,
      typeScores: typeEstimation.scores,
      noteEvents // Include note events for intelligent drum mapping
    };
  }

  /**
   * Récupère tous les événements d'un canal spécifique
   * @param {Object} midiData
   * @param {number} channel
   * @returns {Array<Object>}
   */
  getChannelEvents(midiData, channel) {
    const events = [];

    if (!midiData || !midiData.tracks) {
      return events;
    }

    for (const track of midiData.tracks) {
      if (!track.events) continue;

      for (const event of track.events) {
        if (event.channel === channel) {
          events.push(event);
        }
      }
    }

    // Trier par temps
    events.sort((a, b) => (a.time || 0) - (b.time || 0));

    return events;
  }

  /**
   * Extrait la plage de notes utilisées
   * @param {Array<Object>} noteEvents
   * @returns {Object} - { min, max }
   */
  extractNoteRange(noteEvents) {
    let min = 127;
    let max = 0;

    for (const event of noteEvents) {
      if (event.type === 'noteOn' && event.velocity > 0) {
        const note = event.note ?? event.noteNumber ?? 0;
        min = Math.min(min, note);
        max = Math.max(max, note);
      }
    }

    // Si aucune note trouvée, retourner null pour signaler un canal vide
    if (min > max) {
      return { min: null, max: null };
    }

    return { min, max };
  }

  /**
   * Construit un histogram des notes utilisées
   * @param {Array<Object>} noteEvents
   * @returns {Object} - { note: count }
   */
  buildNoteHistogram(noteEvents) {
    const histogram = {};

    for (const event of noteEvents) {
      if (event.type === 'noteOn' && event.velocity > 0) {
        const note = event.note ?? event.noteNumber ?? 0;
        histogram[note] = (histogram[note] || 0) + 1;
      }
    }

    return histogram;
  }

  /**
   * Compte le nombre total de notes
   * @param {Array<Object>} noteEvents
   * @returns {number}
   */
  countNotes(noteEvents) {
    return noteEvents.filter(e => e.type === 'noteOn' && e.velocity > 0).length;
  }

  /**
   * Calcule la polyphonie maximale et moyenne
   * @param {Array<Object>} noteEvents
   * @returns {Object} - { max, avg }
   */
  calculatePolyphony(noteEvents) {
    const activeNotes = new Map(); // note -> count (handles duplicate noteOn without noteOff)
    let maxPoly = 0;
    let totalPoly = 0;
    let measurements = 0;
    let totalActive = 0; // track total active note count separately from Map.size

    for (const event of noteEvents) {
      const note = event.note ?? event.noteNumber ?? 0;

      if (event.type === 'noteOn' && event.velocity > 0) {
        const count = activeNotes.get(note) || 0;
        activeNotes.set(note, count + 1);
        totalActive++;
      } else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
        const count = activeNotes.get(note) || 0;
        if (count <= 1) {
          activeNotes.delete(note);
        } else {
          activeNotes.set(note, count - 1);
        }
        if (totalActive > 0) totalActive--;
      }

      if (totalActive > 0) {
        maxPoly = Math.max(maxPoly, totalActive);
        totalPoly += totalActive;
        measurements++;
      }
    }

    return {
      max: maxPoly,
      avg: measurements > 0 ? totalPoly / measurements : 0
    };
  }

  /**
   * Extrait la liste des contrôleurs MIDI utilisés
   * @param {Array<Object>} events
   * @returns {Array<number>} - Numéros de CC utilisés
   */
  extractUsedCCs(events) {
    const ccs = new Set();

    for (const event of events) {
      if (event.type === 'controller' || event.type === 'cc') {
        const ccNum = event.controller || event.controllerType || 0;
        ccs.add(ccNum);
      }
    }

    return Array.from(ccs).sort((a, b) => a - b);
  }

  /**
   * Vérifie si le pitch bend est utilisé
   * @param {Array<Object>} events
   * @returns {boolean}
   */
  hasPitchBend(events) {
    return events.some(e => e.type === 'pitchBend' || e.type === 'pitchbend');
  }

  /**
   * Extrait tous les changements de programme
   * @param {Array<Object>} events
   * @returns {Array<number>}
   */
  extractPrograms(events) {
    const programs = [];

    for (const event of events) {
      if (event.type === 'programChange' || event.type === 'program') {
        const program = event.program || event.programNumber || 0;
        programs.push(program);
      }
    }

    return programs;
  }

  /**
   * Extrait les valeurs Bank Select MSB (CC0) et LSB (CC32)
   * @param {Array<Object>} events
   * @returns {Object} - { msb, lsb }
   */
  extractBankSelect(events) {
    let msb = null;
    let lsb = null;

    for (const event of events) {
      if (event.type === 'controller' || event.type === 'cc') {
        const ccNum = event.controller || event.controllerType || 0;
        const value = event.value !== undefined ? event.value : 0;
        if (ccNum === 0) {
          msb = value; // Bank Select MSB
        } else if (ccNum === 32) {
          lsb = value; // Bank Select LSB
        }
      }
    }

    return { msb, lsb };
  }

  /**
   * Détermine le programme MIDI principal (le plus utilisé ou le premier)
   * @param {Array<number>} programs
   * @returns {number|null}
   */
  getPrimaryProgram(programs) {
    if (programs.length === 0) {
      return null;
    }

    // Compter les occurrences
    const counts = {};
    for (const prog of programs) {
      counts[prog] = (counts[prog] || 0) + 1;
    }

    // Trouver le plus fréquent
    let maxCount = 0;
    let primaryProgram = programs[0];

    for (const [prog, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        primaryProgram = parseInt(prog);
      }
    }

    return primaryProgram;
  }

  /**
   * Récupère les noms des tracks associés à ce canal
   * @param {Object} midiData
   * @param {number} channel
   * @returns {Array<string>}
   */
  getTrackNames(midiData, channel) {
    const names = [];

    if (!midiData || !midiData.tracks) {
      return names;
    }

    for (const track of midiData.tracks) {
      if (!track.events) continue;

      // Vérifier si ce track contient des événements de ce canal
      const hasChannel = track.events.some(e => e.channel === channel);

      if (hasChannel && track.name) {
        names.push(track.name);
      }
    }

    return names;
  }

  /**
   * Calcule la densité de notes (notes/seconde)
   * @param {Array<Object>} noteEvents
   * @param {number} duration - Durée en secondes
   * @returns {number}
   */
  calculateNoteDensity(noteEvents, duration) {
    if (duration <= 0) {
      return 0;
    }

    const noteCount = this.countNotes(noteEvents);
    return noteCount / duration;
  }

  /**
   * Estime le type d'instrument basé sur les caractéristiques (version améliorée)
   * @param {Object} analysis
   * @returns {Object} - { type: string, confidence: number, scores: Object }
   */
  estimateInstrumentType(analysis) {
    const { channel, noteRange, noteDistribution, polyphony, primaryProgram, density, trackNames } = analysis;

    // Use ScoringConfig thresholds and weights
    const thresholds = this.config.typeThresholds;
    const weights = this.config.typeDetection;

    // Scores pour chaque type (0-100)
    const scores = {
      drums: 0,
      percussive: 0,
      bass: 0,
      melody: 0,
      harmony: 0
    };

    // Canal 9 (MIDI 10) = toujours drums avec 100% confiance
    if (channel === 9) {
      return {
        type: 'drums',
        confidence: 100,
        scores: { drums: 100, percussive: 0, bass: 0, melody: 0, harmony: 0 }
      };
    }

    // 1. Analyse du programme MIDI (fort indicateur, weight: programWeight)
    if (primaryProgram !== null) {
      if (primaryProgram >= 112 && primaryProgram <= 119) {
        scores.percussive += weights.programWeight;
        scores.drums += weights.programWeight * 0.75;
      } else if (primaryProgram >= 32 && primaryProgram <= 39) {
        scores.bass += weights.programWeight;
      } else if (primaryProgram >= 0 && primaryProgram <= 7) {
        scores.harmony += weights.programWeight * 0.875;
        scores.melody += weights.programWeight * 0.375;
      } else if (primaryProgram >= 40 && primaryProgram <= 55) {
        scores.harmony += weights.programWeight;
      } else if (primaryProgram >= 56 && primaryProgram <= 79) {
        scores.melody += weights.programWeight * 0.75;
        scores.harmony += weights.programWeight * 0.5;
      } else if (primaryProgram >= 80 && primaryProgram <= 103) {
        scores.melody += weights.programWeight * 0.875;
        scores.harmony += weights.programWeight * 0.375;
      }
    }

    // 2. Analyse de la plage de notes (weight: rangeWeight)
    const avgNote = this.getAverageNote(noteDistribution);
    const span = noteRange.max - noteRange.min;

    // Notes très basses = bass
    if (avgNote < thresholds.lowNote) {
      scores.bass += weights.rangeWeight;
    } else if (avgNote >= thresholds.lowNote && avgNote < 72) {
      scores.melody += weights.rangeWeight * 0.6;
      scores.harmony += weights.rangeWeight * 0.4;
    } else {
      scores.melody += weights.rangeWeight * 0.8;
    }

    // Plage restreinte en notes basses = drums
    const drumRange = thresholds.drumNoteRange;
    if (noteRange.min >= drumRange.min && noteRange.max <= drumRange.max && span < drumRange.span) {
      scores.drums += weights.rangeWeight * 0.8;
      scores.percussive += weights.rangeWeight * 0.6;
    }

    // Large plage = harmony/piano
    if (span >= thresholds.wideSpan) {
      scores.harmony += weights.rangeWeight * 0.8;
    } else if (span <= thresholds.narrowSpan) {
      scores.drums += weights.rangeWeight * 0.4;
      scores.percussive += weights.rangeWeight * 0.4;
    }

    // 3. Analyse de la polyphonie (weight: polyphonyWeight)
    if (polyphony.max === 1) {
      scores.melody += weights.polyphonyWeight * 1.25;
      scores.bass += weights.polyphonyWeight;
      scores.drums -= weights.polyphonyWeight * 0.5;
      scores.harmony -= weights.polyphonyWeight * 0.5;
    } else if (polyphony.max >= 2 && polyphony.max <= 4) {
      scores.melody += weights.polyphonyWeight * 0.75;
      scores.harmony += weights.polyphonyWeight * 0.5;
    } else if (polyphony.max >= thresholds.highPolyphony) {
      scores.harmony += weights.polyphonyWeight * 1.5;
      scores.melody -= weights.polyphonyWeight * 0.5;
    }

    // Polyphonie moyenne basse avec max haute = drums (notes qui se chevauchent)
    if (polyphony.max >= 3 && polyphony.avg < 1.5) {
      scores.drums += weights.polyphonyWeight * 0.75;
      scores.percussive += weights.polyphonyWeight * 0.5;
    }

    // 4. Analyse de la densité rythmique (weight: densityWeight)
    if (density > thresholds.highDensity) {
      scores.drums += weights.densityWeight * 1.33;
      scores.percussive += weights.densityWeight;
      scores.melody -= weights.densityWeight * 0.33;
    } else if (density > 3 && density <= thresholds.highDensity) {
      scores.melody += weights.densityWeight * 0.67;
    } else if (density <= 1) {
      scores.harmony += weights.densityWeight * 0.67;
      scores.melody += weights.densityWeight * 0.33;
    }

    // 5. Analyse des noms de tracks (weight: trackNameWeight)
    const trackNameLower = trackNames.join(' ').toLowerCase();

    if (trackNameLower.includes('drum') || trackNameLower.includes('kick') ||
        trackNameLower.includes('snare') || trackNameLower.includes('hat')) {
      scores.drums += weights.trackNameWeight;
      scores.percussive += weights.trackNameWeight * 0.67;
    }

    if (trackNameLower.includes('bass')) {
      scores.bass += weights.trackNameWeight;
    }

    if (trackNameLower.includes('piano') || trackNameLower.includes('keys')) {
      scores.harmony += weights.trackNameWeight * 0.83;
    }

    if (trackNameLower.includes('lead') || trackNameLower.includes('solo')) {
      scores.melody += weights.trackNameWeight * 0.83;
    }

    if (trackNameLower.includes('pad') || trackNameLower.includes('strings') ||
        trackNameLower.includes('choir')) {
      scores.harmony += weights.trackNameWeight * 0.83;
    }

    if (trackNameLower.includes('perc')) {
      scores.percussive += weights.trackNameWeight * 0.83;
      scores.drums += weights.trackNameWeight * 0.5;
    }

    // 6. Normaliser les scores négatifs
    for (const key in scores) {
      scores[key] = Math.max(0, scores[key]);
    }

    // Trouver le type avec le meilleur score
    let bestType = 'melody';
    let bestScore = 0;

    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    // Calculer la confiance (0-100)
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = totalScore > 0 ? Math.round((bestScore / totalScore) * 100) : 50;

    return {
      type: bestType,
      confidence: Math.min(100, confidence),
      scores
    };
  }

  /**
   * Calcule la note moyenne pondérée
   * @param {Object} noteDistribution - { note: count }
   * @returns {number}
   */
  getAverageNote(noteDistribution) {
    let totalWeighted = 0;
    let totalCount = 0;

    for (const [note, count] of Object.entries(noteDistribution)) {
      totalWeighted += parseInt(note) * count;
      totalCount += count;
    }

    return totalCount > 0 ? totalWeighted / totalCount : 60;
  }
}

export default ChannelAnalyzer;
