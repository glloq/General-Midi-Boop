// src/midi/InstrumentMatcher.js

import MidiUtils from '../utils/MidiUtils.js';
import ScoringConfig from './ScoringConfig.js';
import DrumNoteMapper from './DrumNoteMapper.js';

/**
 * InstrumentMatcher - Calcule la compatibilité entre canaux MIDI et instruments
 *
 * Utilise un système de scoring multi-critères (0-100) basé sur :
 * - Match du programme MIDI (GM)
 * - Compatibilité de plage de notes
 * - Polyphonie suffisante
 * - Contrôleurs MIDI supportés
 * - Type d'instrument
 * - Mapping intelligent des percussions (via DrumNoteMapper)
 */
class InstrumentMatcher {
  constructor(logger, config = null) {
    this.logger = logger;
    this.config = config || ScoringConfig;
    this.drumMapper = new DrumNoteMapper(logger);

    // Catégories General MIDI
    this.GM_CATEGORIES = {
      piano: Array.from({ length: 8 }, (_, i) => i),                    // 0-7
      chromatic: Array.from({ length: 8 }, (_, i) => 8 + i),           // 8-15
      organ: Array.from({ length: 8 }, (_, i) => 16 + i),              // 16-23
      guitar: Array.from({ length: 8 }, (_, i) => 24 + i),             // 24-31
      bass: Array.from({ length: 8 }, (_, i) => 32 + i),               // 32-39
      strings: Array.from({ length: 8 }, (_, i) => 40 + i),            // 40-47
      ensemble: Array.from({ length: 8 }, (_, i) => 48 + i),           // 48-55
      brass: Array.from({ length: 8 }, (_, i) => 56 + i),              // 56-63
      reed: Array.from({ length: 8 }, (_, i) => 64 + i),               // 64-71
      pipe: Array.from({ length: 8 }, (_, i) => 72 + i),               // 72-79
      synth_lead: Array.from({ length: 8 }, (_, i) => 80 + i),         // 80-87
      synth_pad: Array.from({ length: 8 }, (_, i) => 88 + i),          // 88-95
      synth_effects: Array.from({ length: 8 }, (_, i) => 96 + i),      // 96-103
      ethnic: Array.from({ length: 8 }, (_, i) => 104 + i),            // 104-111
      percussive: Array.from({ length: 8 }, (_, i) => 112 + i),        // 112-119
      sound_effects: Array.from({ length: 8 }, (_, i) => 120 + i)      // 120-127
    };
  }

  /**
   * Calcule la compatibilité entre un canal et un instrument
   * @param {ChannelAnalysis} channelAnalysis
   * @param {Object} instrument - Instrument avec capabilities
   * @returns {CompatibilityScore}
   */
  calculateCompatibility(channelAnalysis, instrument) {
    let score = 0;
    const issues = [];
    const info = [];

    // 1. Match du programme MIDI (+30 points max)
    const programScore = this.scoreProgramMatch(
      channelAnalysis.primaryProgram,
      instrument.gm_program,
      { channelBankMSB: channelAnalysis.bankMSB, channelBankLSB: channelAnalysis.bankLSB,
        instrumentBankMSB: instrument.bank_msb, instrumentBankLSB: instrument.bank_lsb }
    );
    score += programScore.score;
    if (programScore.info) info.push(programScore.info);

    // 2. Compatibilité de notes (+25 points max)
    let parsedSelectedNotes = null;
    if (instrument.selected_notes) {
      try {
        parsedSelectedNotes = typeof instrument.selected_notes === 'string'
          ? JSON.parse(instrument.selected_notes) : instrument.selected_notes;
      } catch (e) {
        this.logger.warn(`Failed to parse selected_notes for ${instrument.device_id}`);
      }
    }
    const noteScore = this.scoreNoteCompatibility(
      channelAnalysis.noteRange,
      {
        min: instrument.note_range_min,
        max: instrument.note_range_max,
        mode: instrument.note_selection_mode || 'range',
        selected: parsedSelectedNotes
      },
      channelAnalysis // Pass full analysis for intelligent drum mapping
    );
    score += noteScore.score;
    // noteScore may return issue (singular object) or issues (array) depending on path
    if (noteScore.issue) issues.push(noteScore.issue);
    if (noteScore.issues) {
      for (const iss of noteScore.issues) {
        issues.push(iss);
      }
    }
    if (noteScore.info) info.push(noteScore.info);

    // Store drum mapping report if available
    if (noteScore.drumMappingReport) {
      info.push(`Drum mapping: ${noteScore.drumMappingReport.summary.qualityScore}/100 quality`);
    }

    // 3. Polyphonie (+15 points max)
    const instrumentPolyphony = instrument.polyphony || 16;
    const polyphonyIsDefault = !instrument.polyphony;
    const polyScore = this.scorePolyphony(
      channelAnalysis.polyphony.max,
      instrumentPolyphony,
      polyphonyIsDefault
    );
    score += polyScore.score;
    if (polyScore.issue) issues.push(polyScore.issue);
    if (polyScore.info) info.push(polyScore.info);

    // 4. Contrôleurs MIDI (+15 points max)
    let parsedCCs = null;
    if (instrument.supported_ccs) {
      try {
        parsedCCs = typeof instrument.supported_ccs === 'string'
          ? JSON.parse(instrument.supported_ccs) : instrument.supported_ccs;
      } catch (e) {
        this.logger.warn(`Failed to parse supported_ccs for ${instrument.device_id}`);
      }
    }
    const ccScore = this.scoreCCSupport(
      channelAnalysis.usedCCs,
      parsedCCs
    );
    score += ccScore.score;
    if (ccScore.issue) issues.push(ccScore.issue);
    if (ccScore.info) info.push(ccScore.info);

    // 5. Type d'instrument (+10 points max)
    const typeScore = this.scoreInstrumentType(
      channelAnalysis.estimatedType,
      this.getInstrumentType(instrument)
    );
    score += typeScore.score;
    if (typeScore.info) info.push(typeScore.info);

    // 6. Systeme percussion canal 9 (MIDI channel 10)
    const isDrumChannel = channelAnalysis.channel === 9;
    const isDrums = this.isDrumsInstrument(instrument);
    let percussionPenalty = 0;
    let percussionIncompatible = false;

    if (isDrumChannel) {
      if (isDrums) {
        // Canal drums + instrument drums = gros bonus
        percussionPenalty = this.config.getPercussionValue('drumChannelDrumBonus');
        info.push('MIDI channel 10 (drums) + drum instrument match');
      } else {
        // Canal drums + instrument NON drums = penalite + incompatible
        percussionPenalty = this.config.getPercussionValue('drumChannelNonDrumPenalty');
        percussionIncompatible = true;
        issues.push({
          type: 'error',
          message: 'Non-drum instrument assigned to drum channel (ch.10)'
        });
        info.push('Non-drum instrument on drum channel 10');
      }
    } else {
      // Canal non-drums + instrument drum-only = penalite
      if (isDrums && instrument.note_selection_mode === 'discrete') {
        percussionPenalty = this.config.getPercussionValue('nonDrumChannelDrumPenalty');
        issues.push({
          type: 'warning',
          message: 'Drum-only instrument assigned to non-drum channel'
        });
        info.push('Drum-only instrument on melodic channel');
      }
    }

    // 7. Re-ponderation pour canal drums
    if (isDrumChannel) {
      const std = this.config.weights;
      const drum = this.config.percussion.drumChannelWeights;
      // Normaliser chaque sous-score par rapport au poids standard, puis re-ponderer avec les poids drums
      score = (std.programMatch > 0 ? (programScore.score / std.programMatch) * drum.programMatch : 0)
            + (std.noteRange > 0 ? (noteScore.score / std.noteRange) * drum.noteRange : 0)
            + (std.polyphony > 0 ? (polyScore.score / std.polyphony) * drum.polyphony : 0)
            + (std.ccSupport > 0 ? (ccScore.score / std.ccSupport) * drum.ccSupport : 0)
            + (std.instrumentType > 0 ? (typeScore.score / std.instrumentType) * drum.instrumentType : 0);
    }

    // Appliquer penalite/bonus percussion
    score += percussionPenalty;

    // Compatibilite = notes ET polyphonie ET percussion doivent etre compatibles
    const isCompatible = noteScore.compatible !== false && polyScore.compatible !== false && !percussionIncompatible;

    return {
      score: Math.min(100, Math.max(0, Math.round(score))),
      compatible: isCompatible,
      transposition: noteScore.transposition || null,
      noteRemapping: noteScore.noteRemapping || null,
      issues,
      info
    };
  }

  /**
   * Score du match de programme MIDI (with optional Bank Select support)
   * @param {number|null} channelProgram
   * @param {number|null} instrumentProgram
   * @param {Object} [bankInfo] - { channelBankMSB, channelBankLSB, instrumentBankMSB, instrumentBankLSB }
   * @returns {Object} - { score, info }
   */
  scoreProgramMatch(channelProgram, instrumentProgram, bankInfo = {}) {
    const maxScore = this.config.getWeight('programMatch'); // 30

    // Gestion differenciee des cas ou l'un ou les deux programmes sont absents
    const channelHasProgram = channelProgram !== null && channelProgram !== undefined;
    const instrumentHasProgram = instrumentProgram !== null && instrumentProgram !== undefined;

    if (!channelHasProgram && !instrumentHasProgram) {
      // Aucun des deux n'a de programme : neutre
      return { score: Math.round(maxScore * 0.5), info: 'No program data on either side' };
    }
    if (!channelHasProgram) {
      // Canal sans programme, instrument configure : modere
      return { score: Math.round(maxScore * 0.33), info: 'No program in MIDI channel' };
    }
    if (!instrumentHasProgram) {
      // Canal a un programme, instrument non configure : faible (non confirmable)
      return { score: Math.round(maxScore * 0.17), info: 'No GM program configured on instrument' };
    }

    // Match exact (program)
    if (channelProgram === instrumentProgram) {
      const programName = MidiUtils.getGMInstrumentName(channelProgram);

      // Check Bank Select match for extra precision
      const bankMatch = this.checkBankMatch(bankInfo);
      if (bankMatch === 'exact') {
        return {
          score: this.config.getBonus('perfectProgramMatch'),
          info: `Perfect program+bank match: ${programName} (${channelProgram}, Bank ${bankInfo.channelBankMSB || 0}/${bankInfo.channelBankLSB || 0})`
        };
      }

      return {
        score: this.config.getBonus('perfectProgramMatch'),
        info: `Perfect program match: ${programName} (${channelProgram})`
      };
    }

    // Même catégorie
    const channelCategory = this.getProgramCategory(channelProgram);
    const instrumentCategory = this.getProgramCategory(instrumentProgram);

    if (channelCategory === instrumentCategory) {
      return {
        score: this.config.getBonus('sameCategoryMatch'),
        info: `Same GM category: ${channelCategory}`
      };
    }

    return { score: 0 };
  }

  /**
   * Check Bank Select MSB/LSB match
   * @param {Object} bankInfo
   * @returns {string} 'exact', 'partial', or 'none'
   */
  checkBankMatch(bankInfo) {
    if (!bankInfo) return 'none';

    const { channelBankMSB, channelBankLSB, instrumentBankMSB, instrumentBankLSB } = bankInfo;

    // If neither side has bank info, it's a non-issue
    if ((channelBankMSB === null || channelBankMSB === undefined) &&
        (instrumentBankMSB === null || instrumentBankMSB === undefined)) {
      return 'none';
    }

    const msbMatch = (channelBankMSB || 0) === (instrumentBankMSB || 0);
    const lsbMatch = (channelBankLSB || 0) === (instrumentBankLSB || 0);

    if (msbMatch && lsbMatch) return 'exact';
    if (msbMatch) return 'partial';
    return 'none';
  }

  /**
   * Détermine la catégorie GM d'un programme
   * @param {number} program
   * @returns {string|null}
   */
  getProgramCategory(program) {
    for (const [category, programs] of Object.entries(this.GM_CATEGORIES)) {
      if (programs.includes(program)) {
        return category;
      }
    }
    return null;
  }

  /**
   * Score de compatibilité de notes avec transposition par octaves
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max, mode, selected }
   * @param {Object} channelAnalysis - Optional full channel analysis for intelligent drum mapping
   * @returns {Object}
   */
  scoreNoteCompatibility(channelRange, instrumentCaps, channelAnalysis = null) {
    // Canal sans notes (plage null) = score neutre, compatible par defaut
    if (channelRange.min === null || channelRange.max === null) {
      return {
        compatible: true,
        score: Math.round(this.config.getWeight('noteRange') * 0.5),
        info: 'No notes in MIDI channel (empty channel)'
      };
    }

    const span = channelRange.max - channelRange.min;

    // Mode discrete (drums/pads)
    if (instrumentCaps.mode === 'discrete') {
      return this.scoreDiscreteNotes(channelRange, instrumentCaps.selected, channelAnalysis);
    }

    // Si l'instrument n'a pas de plage définie (non configuré, score neutre)
    if (instrumentCaps.min === null || instrumentCaps.max === null) {
      return {
        compatible: true,
        score: Math.round(this.config.getWeight('noteRange') * 0.5),
        info: 'Instrument note range not configured (accepts all)'
      };
    }

    const instSpan = instrumentCaps.max - instrumentCaps.min;

    // Le span du canal est trop large pour l'instrument
    if (span > instSpan) {
      return {
        compatible: false,
        score: 0,
        issue: {
          type: 'error',
          message: `Note span too wide (${span} vs ${instSpan} semitones)`
        }
      };
    }

    // Calculer transposition optimale par octaves
    const transposition = this.calculateOctaveShift(channelRange, instrumentCaps);

    if (!transposition.compatible) {
      return {
        compatible: false,
        score: 0,
        issue: {
          type: 'error',
          message: transposition.reason
        }
      };
    }

    // Score basé sur la transposition (use config bonuses/penalties)
    const perfectNoteScore = this.config.getBonus('perfectNoteRange');
    const transpositionPenalty = this.config.getPenalty('transpositionPerOctave');
    let score = perfectNoteScore;
    let info = null;

    if (transposition.octaves === 0) {
      score = perfectNoteScore;
      info = 'Perfect note range fit (no transposition)';
    } else {
      score = Math.max(0, (perfectNoteScore - 5) - Math.abs(transposition.octaves) * transpositionPenalty);
      const direction = transposition.octaves > 0 ? 'up' : 'down';
      info = `Transposition: ${Math.abs(transposition.octaves)} octave(s) ${direction}`;
    }

    // Calculer l'octave wrapping pour les notes qui dépassent
    const wrapping = this.calculateOctaveWrapping(channelRange, instrumentCaps, transposition.semitones);

    return {
      compatible: true,
      score,
      transposition: {
        semitones: transposition.semitones,
        octaves: transposition.octaves
      },
      octaveWrapping: wrapping.mapping,
      octaveWrappingEnabled: wrapping.hasWrapping,
      octaveWrappingInfo: wrapping.info,
      info
    };
  }

  /**
   * Calcule le décalage d'octave optimal
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @returns {Object}
   */
  calculateOctaveShift(channelRange, instrumentCaps) {
    // Calculer les centres
    const channelCenter = (channelRange.min + channelRange.max) / 2;
    const instCenter = (instrumentCaps.min + instrumentCaps.max) / 2;

    // Différence en semitones
    const rawShift = instCenter - channelCenter;

    // Arrondir au multiple de 12 le plus proche
    const octaves = Math.round(rawShift / 12);
    const semitones = octaves * 12;

    // Vérifier si toutes les notes rentrent après transposition
    const newMin = channelRange.min + semitones;
    const newMax = channelRange.max + semitones;

    if (newMin >= instrumentCaps.min && newMax <= instrumentCaps.max) {
      return {
        compatible: true,
        semitones,
        octaves
      };
    }

    // Essayer ±1 octave
    for (const offset of [-1, 1]) {
      const altOctaves = octaves + offset;
      const altSemitones = altOctaves * 12;
      const altMin = channelRange.min + altSemitones;
      const altMax = channelRange.max + altSemitones;

      if (altMin >= instrumentCaps.min && altMax <= instrumentCaps.max) {
        return {
          compatible: true,
          semitones: altSemitones,
          octaves: altOctaves
        };
      }
    }

    return {
      compatible: false,
      reason: 'No octave shift fits all notes in instrument range'
    };
  }

  /**
   * Calcule l'octave wrapping pour les notes hors de la plage de l'instrument
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @param {number} baseSemitones - Transposition de base déjà appliquée
   * @returns {Object} - { hasWrapping: boolean, mapping: Object, info: string }
   */
  calculateOctaveWrapping(channelRange, instrumentCaps, baseSemitones) {
    const mapping = {};
    let wrappedUp = 0;
    let wrappedDown = 0;

    for (let note = channelRange.min; note <= channelRange.max; note++) {
      const transposedNote = note + baseSemitones;

      if (transposedNote < instrumentCaps.min) {
        const wrappedNote = transposedNote + 12;
        if (wrappedNote >= instrumentCaps.min && wrappedNote <= instrumentCaps.max) {
          mapping[transposedNote] = wrappedNote;
          wrappedUp++;
        }
      } else if (transposedNote > instrumentCaps.max) {
        const wrappedNote = transposedNote - 12;
        if (wrappedNote >= instrumentCaps.min && wrappedNote <= instrumentCaps.max) {
          mapping[transposedNote] = wrappedNote;
          wrappedDown++;
        }
      }
    }

    const hasWrapping = wrappedUp > 0 || wrappedDown > 0;
    let info = '';

    if (hasWrapping) {
      const parts = [];
      if (wrappedUp > 0) parts.push(`${wrappedUp} note(s) wrapped up`);
      if (wrappedDown > 0) parts.push(`${wrappedDown} note(s) wrapped down`);
      info = `Octave wrapping available: ${parts.join(', ')}`;
    }

    return {
      hasWrapping,
      mapping: Object.keys(mapping).length > 0 ? mapping : null,
      info
    };
  }

  /**
   * Score pour instruments à notes discrètes (drums)
   * Uses intelligent DrumNoteMapper for channel 9 (drums)
   * @param {Object} channelRange
   * @param {Array<number>|null} selectedNotes
   * @param {Object} channelAnalysis - Optional, provides note events for intelligent mapping
   * @returns {Object}
   */
  scoreDiscreteNotes(channelRange, selectedNotes, channelAnalysis = null) {
    if (!selectedNotes || selectedNotes.length === 0) {
      // Discrete mode with no selected notes = unconfigured instrument
      // Return low neutral score instead of falling back to range-based (which gives free points)
      return {
        compatible: false,
        score: Math.round(this.config.getWeight('noteRange') * 0.2),
        issue: {
          type: 'warning',
          message: 'Discrete mode but no selected notes defined'
        }
      };
    }

    // Use intelligent DrumNoteMapper for drums (channel 9)
    if (channelAnalysis && channelAnalysis.channel === 9 && channelAnalysis.noteEvents) {
      return this.scoreDiscreteDrumsIntelligent(channelAnalysis, selectedNotes);
    }

    // Fallback: simple closest-note mapping for non-drums discrete instruments
    // Utiliser les notes reellement presentes si disponibles, sinon la plage
    let channelNotes;
    if (channelAnalysis && channelAnalysis.noteDistribution && Object.keys(channelAnalysis.noteDistribution).length > 0) {
      channelNotes = Object.keys(channelAnalysis.noteDistribution).map(Number).sort((a, b) => a - b);
    } else {
      channelNotes = [];
      for (let note = channelRange.min; note <= channelRange.max; note++) {
        channelNotes.push(note);
      }
    }

    const supportedCount = channelNotes.filter(n => selectedNotes.includes(n)).length;
    const supportRatio = supportedCount / channelNotes.length;

    if (supportRatio === 0) {
      return {
        compatible: false,
        score: 0,
        issue: {
          type: 'error',
          message: 'No channel notes are supported by instrument'
        }
      };
    }

    // Créer mapping pour notes non supportées (vers note la plus proche)
    const noteRemapping = {};
    for (const note of channelNotes) {
      if (!selectedNotes.includes(note)) {
        const closest = this.findClosestNote(note, selectedNotes);
        if (closest !== null) {
          noteRemapping[note] = closest;
        }
      }
    }

    const score = Math.round(25 * supportRatio);
    const info = `${Math.round(supportRatio * 100)}% of notes supported`;

    return {
      compatible: true,
      score,
      noteRemapping: Object.keys(noteRemapping).length > 0 ? noteRemapping : null,
      info
    };
  }

  /**
   * Intelligent drum note scoring using DrumNoteMapper
   * @param {Object} channelAnalysis
   * @param {Array<number>} selectedNotes
   * @returns {Object}
   */
  scoreDiscreteDrumsIntelligent(channelAnalysis, selectedNotes) {
    try {
      // Classify MIDI drum notes
      const midiNotes = this.drumMapper.classifyDrumNotes(channelAnalysis.noteEvents || []);

      // Generate intelligent mapping
      const mappingResult = this.drumMapper.generateMapping(midiNotes, selectedNotes, {
        allowSubstitution: true,
        allowSharing: true,
        allowOmission: true,
        preserveEssentials: true
      });

      const { mapping, quality, substitutions, omissions } = mappingResult;

      // Convert quality score (0-100) to compatibility score (0-25)
      // Quality 100 → score 25, Quality 50 → score 12.5
      const score = Math.round((quality.score / 100) * 25);

      // Build info messages
      const info = [];
      info.push(`Intelligent drum mapping: ${quality.score}/100 quality`);
      info.push(`${quality.mappedCount}/${quality.totalCount} notes mapped`);
      if (quality.essentialScore < 100) {
        info.push(`Essential preservation: ${quality.essentialScore}%`);
      }
      if (substitutions.length > 0) {
        info.push(`${substitutions.length} intelligent substitutions`);
      }
      if (omissions.length > 0) {
        info.push(`${omissions.length} notes omitted`);
      }

      // Build issues
      const issues = [];
      if (quality.score < 50) {
        issues.push({
          type: 'warning',
          message: `Low drum mapping quality (${quality.score}/100). Many notes will be substituted or omitted.`
        });
      }
      if (quality.essentialScore < 75) {
        issues.push({
          type: 'warning',
          message: `Some essential drum elements (kick/snare/hi-hat) may be missing or substituted.`
        });
      }

      this.logger.info(`[DrumMapping] Quality: ${quality.score}/100, Score: ${score}/25, Mapped: ${quality.mappedCount}/${quality.totalCount}`);

      return {
        compatible: quality.score >= 30, // Minimum 30% quality to be compatible
        score,
        noteRemapping: Object.keys(mapping).length > 0 ? mapping : null,
        drumMappingQuality: quality,
        drumMappingReport: this.drumMapper.getMappingReport(mappingResult),
        info: info.join(', '),
        issues: issues.length > 0 ? issues : undefined
      };
    } catch (error) {
      this.logger.error(`[DrumMapping] Error: ${error.message}`);
      // Fallback securise: valider noteRange avant de passer au scoring simple
      const fallbackRange = channelAnalysis && channelAnalysis.noteRange &&
        channelAnalysis.noteRange.min !== null && channelAnalysis.noteRange.max !== null
        ? channelAnalysis.noteRange
        : { min: 0, max: 127 };
      return this.scoreDiscreteNotes(fallbackRange, selectedNotes, null);
    }
  }

  /**
   * Trouve la note la plus proche dans une liste
   * @param {number} targetNote
   * @param {Array<number>} availableNotes
   * @returns {number|null}
   */
  findClosestNote(targetNote, availableNotes) {
    if (availableNotes.length === 0) return null;

    let closest = availableNotes[0];
    let minDistance = Math.abs(targetNote - closest);

    for (const note of availableNotes) {
      const distance = Math.abs(targetNote - note);
      if (distance < minDistance) {
        minDistance = distance;
        closest = note;
      }
    }

    return closest;
  }

  /**
   * Score de polyphonie
   * @param {number} channelMaxPoly
   * @param {number} instrumentPoly
   * @param {boolean} isDefault - true si polyphonie non configuree (defaut 16)
   * @returns {Object}
   */
  scorePolyphony(channelMaxPoly, instrumentPoly, isDefault = false) {
    const margin = instrumentPoly - channelMaxPoly;

    // Polyphonie non configuree : plafonner a 10/15 meme si marge excellente
    if (isDefault && margin >= 0) {
      return {
        score: 10,
        info: `Polyphony not configured (default ${instrumentPoly}), likely sufficient for ${channelMaxPoly} needed`
      };
    }

    if (margin >= 8) {
      return {
        score: 15,
        info: `Excellent polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= 4) {
      return {
        score: 10,
        info: `Good polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= 0) {
      return {
        score: 5,
        info: `Sufficient polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= -4) {
      // Legèrement insuffisant: warning mais pas incompatible
      return {
        score: 0,
        issue: {
          type: 'warning',
          message: `Insufficient polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
        }
      };
    } else {
      // Sévèrement insuffisant: incompatible
      return {
        score: 0,
        compatible: false,
        issue: {
          type: 'error',
          message: `Severely insufficient polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
        }
      };
    }
  }

  /**
   * Score du support des contrôleurs MIDI
   * @param {Array<number>} channelCCs
   * @param {Array<number>|null} instrumentCCs
   * @returns {Object}
   */
  scoreCCSupport(channelCCs, instrumentCCs) {
    if (channelCCs.length === 0) {
      return { score: 15, info: 'No CCs used by channel' };
    }

    // Si l'instrument n'a pas de liste de CCs configuree : score neutre (pas plein)
    if (!instrumentCCs || instrumentCCs.length === 0) {
      const ccWeight = this.config.getWeight('ccSupport'); // 15
      return { score: Math.round(ccWeight * 0.53), info: 'Instrument CC support unknown (not configured)' };
    }

    // Compter combien de CCs sont supportés
    const supportedCount = channelCCs.filter(cc => instrumentCCs.includes(cc)).length;
    const supportRatio = supportedCount / channelCCs.length;

    const score = Math.round(15 * supportRatio);

    if (supportRatio === 1) {
      return {
        score,
        info: `All ${channelCCs.length} CCs supported`
      };
    } else if (supportRatio >= 0.5) {
      const unsupported = channelCCs.filter(cc => !instrumentCCs.includes(cc));
      return {
        score,
        issue: {
          type: 'info',
          message: `Some CCs not supported: ${unsupported.join(', ')}`
        }
      };
    } else {
      const unsupported = channelCCs.filter(cc => !instrumentCCs.includes(cc));
      return {
        score,
        issue: {
          type: 'warning',
          message: `Many CCs not supported: ${unsupported.join(', ')}`
        }
      };
    }
  }

  /**
   * Score du type d'instrument
   * @param {Object|string} channelType - { type, confidence, scores } ou string
   * @param {string} instrumentType - 'melody', 'harmony', 'bass', 'percussive', 'unknown'
   * @returns {Object}
   */
  scoreInstrumentType(channelType, instrumentType) {
    const maxScore = this.config.getWeight('instrumentType'); // 10

    // Extraire le type depuis l'objet si nécessaire
    const channelTypeStr = channelType?.type || channelType;

    // If either type is unknown, give neutral score (not penalizing)
    if (!channelTypeStr || channelTypeStr === 'unknown' || !instrumentType || instrumentType === 'unknown') {
      return { score: Math.round(maxScore * 0.5), info: 'Instrument type not determined' };
    }

    // Mapping des types détaillés (ChannelAnalyzer) vers types génériques (getInstrumentType)
    const typeMapping = {
      // Types détectés par ChannelAnalyzer → Types génériques acceptés
      'piano': ['melody', 'harmony'],
      'strings': ['melody', 'harmony'],
      'organ': ['harmony', 'melody'],
      'lead': ['melody'],
      'pad': ['harmony', 'melody'],
      'brass': ['melody', 'harmony'],
      'percussive': ['percussive'],
      'drums': ['percussive'],
      'bass': ['bass', 'melody']
    };

    // Vérifier si le type de l'instrument est acceptable pour ce canal
    const acceptableTypes = typeMapping[channelTypeStr];

    if (acceptableTypes && acceptableTypes.includes(instrumentType)) {
      // Score basé sur la position dans la liste (premier = meilleur)
      const index = acceptableTypes.indexOf(instrumentType);
      const baseScore = 10;
      const score = index === 0 ? baseScore : Math.max(5, baseScore - index * 2);

      return {
        score,
        info: `Instrument type ${index === 0 ? 'perfect' : 'acceptable'} match: ${channelTypeStr} → ${instrumentType}`
      };
    }

    // Fallback: anciennes combinaisons acceptables pour types génériques
    const acceptableCombos = {
      'melody': ['harmony', 'bass'],
      'harmony': ['melody'],
      'bass': ['melody']
    };

    if (acceptableCombos[channelTypeStr]?.includes(instrumentType)) {
      return { score: 5 };
    }

    return { score: 0 };
  }

  /**
   * Détermine le type d'un instrument
   * @param {Object} instrument
   * @returns {string}
   */
  getInstrumentType(instrument) {
    const program = instrument.gm_program;

    if (program === null || program === undefined) {
      // Pas de programme GM : tenter inference par le nom
      const inferred = this.inferTypeFromName(instrument);
      if (inferred !== 'unknown') return inferred;

      // Fallback : analyser note_range si disponible
      if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
        const avgNote = (instrument.note_range_min + instrument.note_range_max) / 2;
        if (avgNote < 48) return 'bass';
      }

      // Mode discrete sans programme = probablement percussif
      if (instrument.note_selection_mode === 'discrete') return 'percussive';

      return 'unknown';
    }

    if (program >= 112 && program <= 119) return 'percussive';
    if (program >= 32 && program <= 39) return 'bass';
    if ((program >= 0 && program <= 7) || (program >= 40 && program <= 55)) return 'harmony';

    // Analyser note_range si disponible
    if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
      const avgNote = (instrument.note_range_min + instrument.note_range_max) / 2;
      if (avgNote < 48) return 'bass';
    }

    return 'melody';
  }

  /**
   * Infere le type d'instrument a partir de son nom
   * @param {Object} instrument
   * @returns {string} - 'percussive', 'bass', 'harmony', 'melody', ou 'unknown'
   */
  inferTypeFromName(instrument) {
    const name = (instrument.name || instrument.custom_name || '').toLowerCase();
    if (!name) return 'unknown';

    const keywords = {
      percussive: ['drum', 'perc', 'kit', 'cymbal', 'snare', 'kick', 'tom', 'hi-hat', 'hihat', 'cajon'],
      bass: ['bass', 'sub'],
      harmony: ['piano', 'keys', 'keyboard', 'organ', 'strings', 'pad', 'chord', 'harp'],
      melody: ['lead', 'synth', 'flute', 'trumpet', 'sax', 'violin', 'guitar', 'clarinet', 'oboe']
    };

    for (const [type, words] of Object.entries(keywords)) {
      if (words.some(w => name.includes(w))) return type;
    }
    return 'unknown';
  }

  /**
   * Vérifie si un instrument est de type drums
   * @param {Object} instrument
   * @returns {boolean}
   */
  isDrumsInstrument(instrument) {
    const program = instrument.gm_program;
    return (program >= 112 && program <= 119) ||
           instrument.note_selection_mode === 'discrete';
  }
}

export default InstrumentMatcher;
