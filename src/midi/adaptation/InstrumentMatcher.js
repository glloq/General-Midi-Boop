/**
 * @file src/midi/adaptation/InstrumentMatcher.js
 * @description Heuristic engine that scores how well a registered
 * instrument can play a given MIDI channel. Used by the auto-assigner
 * UI to rank suggestions and by the routing-status filter to decide
 * which files are "playable" with the currently connected hardware.
 *
 * Weighting constants live in {@link ScoringConfig}; tweaking them
 * changes the rankings without touching the scoring logic. Drum
 * channels are routed through {@link DrumNoteMapper} which has its own
 * General MIDI percussion mapping table.
 *
 * The file is large (~1200 LOC) — only public entry points carry full
 * JSDoc; internal scoring helpers are documented with one-liners.
 */

import MidiUtils from '../../utils/MidiUtils.js';
import ScoringConfig from './ScoringConfig.js';
import DrumNoteMapper from './DrumNoteMapper.js';
import InstrumentTypeConfig from './InstrumentTypeConfig.js';
import InstrumentFamilies from '../gm/InstrumentFamilies.js';
import { safeJsonParse } from '../../utils/JsonParser.js';

/**
 * Multi-criteria channel ↔ instrument compatibility scorer (0-100).
 * Stateless besides the pluggable {@link ScoringConfig}; safe to share
 * one instance across the application.
 */
class InstrumentMatcher {
  constructor(logger, config = null) {
    this.logger = logger;
    this.config = config || ScoringConfig;
    this.drumMapper = new DrumNoteMapper(logger);
  }

  /**
   * Calculates compatibility between a channel and an instrument
   * @param {ChannelAnalysis} channelAnalysis
   * @param {Object} instrument - Instrument with capabilities
   * @returns {CompatibilityScore}
   */
  calculateCompatibility(channelAnalysis, instrument) {
    let score = 0;
    const issues = [];
    const info = [];

    // 1. MIDI program match (+22 points max)
    const programScore = this.scoreProgramMatch(
      channelAnalysis.primaryProgram,
      instrument.gm_program,
      {
        channelBankMSB: channelAnalysis.bankMSB,
        channelBankLSB: channelAnalysis.bankLSB,
        instrumentBankMSB: instrument.bank_msb,
        instrumentBankLSB: instrument.bank_lsb
      }
    );
    score += programScore.score;
    if (programScore.info) info.push(programScore.info);

    // 1b. Physical-taxonomy family match (v7 InstrumentFamilies bonus).
    // Complements the GM-category bonus above: fires only when the two
    // programs share the physical family (e.g. nylon guitar ↔ sitar,
    // both plucked_strings) but come from different GM categories, so
    // we don't double-count with `sameCategoryMatch`.
    const familyScore = this.scorePhysicalFamilyMatch(
      channelAnalysis.primaryProgram,
      channelAnalysis.channel,
      instrument.gm_program,
      instrument.channel
    );
    score += familyScore.score;
    if (familyScore.info) info.push(familyScore.info);

    // 2. Note compatibility (+40 points max).
    // Use a unique sentinel so we can distinguish a genuine JSON parse
    // failure (warn-worthy) from the legitimate `"null"` literal —
    // `safeJsonParse` only returns `fallback` on a thrown parse error.
    const _PARSE_FAIL = Symbol('parse-fail');
    const _raw = safeJsonParse(instrument.selected_notes, _PARSE_FAIL);
    if (_raw === _PARSE_FAIL) {
      this.logger.warn(`Failed to parse selected_notes for ${instrument.device_id}`);
    }
    const parsedSelectedNotes = _raw === _PARSE_FAIL ? null : _raw;
    const noteScore = this.scoreNoteCompatibility(
      channelAnalysis.noteRange,
      {
        min: instrument.note_range_min,
        max: instrument.note_range_max,
        mode: instrument.note_selection_mode || 'range',
        selected: parsedSelectedNotes
      },
      channelAnalysis, // Pass full analysis for intelligent drum mapping
      instrument.instrument_subtype || null // Pass subtype for transposing instruments
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

    // 3. Polyphony (+13 points max)
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

    // 4. MIDI controllers (+5 points max)
    let parsedCCs = null;
    if (instrument.supported_ccs) {
      try {
        parsedCCs =
          typeof instrument.supported_ccs === 'string'
            ? JSON.parse(instrument.supported_ccs)
            : instrument.supported_ccs;
      } catch (e) {
        this.logger.warn(`Failed to parse supported_ccs for ${instrument.device_id}`);
      }
    }
    const ccScore = this.scoreCCSupport(channelAnalysis.usedCCs, parsedCCs);
    score += ccScore.score;
    if (ccScore.issue) issues.push(ccScore.issue);
    if (ccScore.info) info.push(ccScore.info);

    // 5. Instrument type (+20 points max)
    const channelTypeInfo = {
      type: channelAnalysis.estimatedType,
      category: channelAnalysis.estimatedCategory || null,
      categorySubtype: channelAnalysis.estimatedSubtype || null
    };
    const instrumentTypeInfo = this.getInstrumentType(instrument);
    const typeScore = this.scoreInstrumentType(channelTypeInfo, instrumentTypeInfo);
    score += typeScore.score;
    if (typeScore.info) info.push(typeScore.info);

    // 6. Percussion system for channel 9 (MIDI channel 10)
    const isDrumChannel = channelAnalysis.channel === 9;
    const isDrums = this.isDrumsInstrument(instrument);
    let percussionPenalty = 0;
    let percussionIncompatible = false;

    if (isDrumChannel) {
      if (isDrums) {
        // Drums channel + drums instrument = big bonus
        percussionPenalty = this.config.getPercussionValue('drumChannelDrumBonus');
        info.push('MIDI channel 10 (drums) + drum instrument match');
      } else {
        // Drums channel + NON-drums instrument = penalty + incompatible
        percussionPenalty = this.config.getPercussionValue('drumChannelNonDrumPenalty');
        percussionIncompatible = true;
        issues.push({
          type: 'error',
          message: 'Non-drum instrument assigned to drum channel (ch.10)'
        });
        info.push('Non-drum instrument on drum channel 10');
      }
    } else {
      // Non-drums channel + drum-only instrument = penalty
      if (isDrums && instrument.note_selection_mode === 'discrete') {
        percussionPenalty = this.config.getPercussionValue('nonDrumChannelDrumPenalty');
        issues.push({
          type: 'warning',
          message: 'Drum-only instrument assigned to non-drum channel'
        });
        info.push('Drum-only instrument on melodic channel');
      }
    }

    // 7. Re-weighting for drums channel.
    // Normalize each sub-score relative to standard weights, then re-weight
    // with drum weights. The unrounded reweighted values feed `score`; the
    // same values rounded feed `scoreBreakdown` (computed in step 9) so the
    // displayed breakdown matches the final score.
    const std = this.config.weights;
    const drum = this.config.percussion.drumChannelWeights;
    // Guard against division by zero: if standard weight is 0, the sub-score contribution is 0
    const reweight = (subScore, stdWeight, drumWeight) =>
      stdWeight > 0 ? (subScore / stdWeight) * drumWeight : 0;
    const drumReweighted = isDrumChannel
      ? {
          program: reweight(programScore.score, std.programMatch, drum.programMatch),
          noteRange: reweight(noteScore.score, std.noteRange, drum.noteRange),
          polyphony: reweight(polyScore.score, std.polyphony, drum.polyphony),
          ccSupport: reweight(ccScore.score, std.ccSupport, drum.ccSupport),
          instrumentType: reweight(typeScore.score, std.instrumentType, drum.instrumentType)
        }
      : null;

    if (isDrumChannel) {
      score =
        drumReweighted.program +
        drumReweighted.noteRange +
        drumReweighted.polyphony +
        drumReweighted.ccSupport +
        drumReweighted.instrumentType;
      // Ensure score is finite (NaN guard)
      if (!isFinite(score)) score = 0;
    }

    // 8. Timing / playback speed penalty
    const timingResult = this.scoreTimingCompatibility(
      channelAnalysis.timingAnalysis,
      instrument.min_note_interval
    );
    score += timingResult.penalty;
    if (timingResult.issue) issues.push(timingResult.issue);
    if (timingResult.info) info.push(timingResult.info);

    // Apply percussion penalty/bonus
    score += percussionPenalty;

    // Compatible = notes AND polyphony AND percussion must all be compatible
    const isCompatible =
      noteScore.compatible !== false && polyScore.compatible !== false && !percussionIncompatible;

    // Build score breakdown for UI detail display
    // For drum channels, show reweighted scores to match the final score
    let scoreBreakdown;
    if (isDrumChannel) {
      scoreBreakdown = {
        program: { score: Math.round(drumReweighted.program), max: drum.programMatch },
        noteRange: { score: Math.round(drumReweighted.noteRange), max: drum.noteRange },
        polyphony: { score: Math.round(drumReweighted.polyphony), max: drum.polyphony },
        ccSupport: { score: Math.round(drumReweighted.ccSupport), max: drum.ccSupport },
        instrumentType: {
          score: Math.round(drumReweighted.instrumentType),
          max: drum.instrumentType
        },
        percussion: {
          score: Math.round(percussionPenalty),
          max: this.config.getPercussionValue('drumChannelDrumBonus')
        },
        timing: { score: Math.round(timingResult.penalty), max: 0 }
      };
    } else {
      scoreBreakdown = {
        program: {
          score: Math.round(programScore.score),
          max: this.config.getWeight('programMatch')
        },
        noteRange: { score: Math.round(noteScore.score), max: this.config.getWeight('noteRange') },
        polyphony: { score: Math.round(polyScore.score), max: this.config.getWeight('polyphony') },
        ccSupport: { score: Math.round(ccScore.score), max: this.config.getWeight('ccSupport') },
        instrumentType: {
          score: Math.round(typeScore.score),
          max: this.config.getWeight('instrumentType')
        },
        percussion: { score: 0, max: 0 },
        timing: { score: Math.round(timingResult.penalty), max: 0 }
      };
    }

    // Hand-position feasibility heuristic + scoring contribution.
    // A.1 produced the structured payload from the aggregated analysis
    // (pitch range + polyphony); A.2 turns the level into a bonus or
    // penalty applied to the matcher's main score so the auto-assigner
    // prefers instruments whose mechanical hand can comfortably play
    // the channel. The contribution is gated on
    // ScoringConfig.handPosition.enabled, so an operator can revert
    // to the pre-feature ranking by toggling the flag.
    const handPositionFeasibility = this._scoreHandPositionFeasibility(channelAnalysis, instrument);
    const handDelta = this.config.getHandPositionDelta
      ? this.config.getHandPositionDelta(handPositionFeasibility.level)
      : 0;
    if (handDelta !== 0) score += handDelta;
    if (handPositionFeasibility.info) info.push(handPositionFeasibility.info);
    if (handPositionFeasibility.issue) issues.push(handPositionFeasibility.issue);

    return {
      score: Math.min(100, Math.max(0, Math.round(score))),
      compatible: isCompatible,
      handPositionFeasibility,
      transposition: noteScore.transposition || null,
      noteRemapping: noteScore.noteRemapping || null,
      octaveWrapping: noteScore.octaveWrapping || null,
      octaveWrappingEnabled: noteScore.octaveWrappingEnabled || false,
      octaveWrappingInfo: noteScore.octaveWrappingInfo || null,
      scoreBreakdown,
      drumMappingQuality: noteScore.drumMappingQuality || null,
      issues,
      info
    };
  }

  /**
   * MIDI program match score (with optional Bank Select support)
   * @param {number|null} channelProgram
   * @param {number|null} instrumentProgram
   * @param {Object} [bankInfo] - { channelBankMSB, channelBankLSB, instrumentBankMSB, instrumentBankLSB }
   * @returns {Object} - { score, info }
   */
  scoreProgramMatch(channelProgram, instrumentProgram, bankInfo = {}) {
    const maxScore = this.config.getWeight('programMatch'); // 22

    // Handle cases where one or both programs are absent differently
    const channelHasProgram = channelProgram !== null && channelProgram !== undefined;
    const instrumentHasProgram = instrumentProgram !== null && instrumentProgram !== undefined;

    if (!channelHasProgram && !instrumentHasProgram) {
      // Neither has a program: neutral
      return { score: Math.round(maxScore * 0.5), info: 'No program data on either side' };
    }
    if (!channelHasProgram) {
      // Channel without program, instrument configured: moderate
      return { score: Math.round(maxScore * 0.33), info: 'No program in MIDI channel' };
    }
    if (!instrumentHasProgram) {
      // Channel has a program, instrument not configured: weak (cannot confirm)
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

    // Same category
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
   * Physical-family bonus using the v7 `InstrumentFamilies` taxonomy
   * (13 families driven by actuator/physical type rather than GM slot
   * number). Complements {@link scoreProgramCompatibility}'s same-GM-
   * category bonus.
   *
   * Fires only when:
   *   - both programs resolve to a family
   *   - the two programs share the same physical family
   *   - but are in DIFFERENT GM categories (otherwise
   *     `sameCategoryMatch` already awards the match and we'd
   *     double-count).
   *
   * Examples that trigger the bonus:
   *   - nylon guitar (24, guitar cat) ↔ sitar (104, ethnic cat)      → plucked_strings
   *   - violin (40, strings cat) ↔ fiddle (110, ethnic cat)          → bowed_strings
   *   - accordion (21, organ cat) ↔ clarinet (71, reed cat)          → reeds
   *
   * @param {number|null|undefined} channelProgram
   * @param {number|null|undefined} channelChannel
   * @param {number|null|undefined} instrumentProgram
   * @param {number|null|undefined} instrumentChannel
   * @returns {{score:number, info:string|null}}
   */
  scorePhysicalFamilyMatch(channelProgram, channelChannel, instrumentProgram, instrumentChannel) {
    if (channelProgram == null || instrumentProgram == null) {
      return { score: 0, info: null };
    }
    // Perfect program match is already rewarded by perfectProgramMatch
    if (channelProgram === instrumentProgram) {
      return { score: 0, info: null };
    }

    const chanFam = InstrumentFamilies.getFamilyForProgram(channelProgram, channelChannel);
    const instFam = InstrumentFamilies.getFamilyForProgram(instrumentProgram, instrumentChannel);
    if (!chanFam || !instFam) return { score: 0, info: null };
    if (chanFam.slug !== instFam.slug) return { score: 0, info: null };

    // Avoid double-counting the same signal as sameCategoryMatch.
    // Both programs in the same GM category (8-program block) are already
    // rewarded by scoreProgramCompatibility.
    const chanGmCat = Math.floor(channelProgram / 8);
    const instGmCat = Math.floor(instrumentProgram / 8);
    if (chanGmCat === instGmCat) return { score: 0, info: null };

    return {
      score: this.config.getBonus('samePhysicalFamilyMatch'),
      info: `Same physical family: ${chanFam.slug}`
    };
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
    if (
      (channelBankMSB === null || channelBankMSB === undefined) &&
      (instrumentBankMSB === null || instrumentBankMSB === undefined)
    ) {
      return 'none';
    }

    const msbMatch = (channelBankMSB || 0) === (instrumentBankMSB || 0);
    const lsbMatch = (channelBankLSB || 0) === (instrumentBankLSB || 0);

    if (msbMatch && lsbMatch) return 'exact';
    if (msbMatch) return 'partial';
    return 'none';
  }

  /**
   * Determines the GM category slug of a program. Thin wrapper around
   * {@link MidiUtils.getGMCategorySlug} kept for callers that read the
   * matcher's interface — the slug list lives there.
   * @param {number} program
   * @returns {string|null}
   */
  getProgramCategory(program) {
    return MidiUtils.getGMCategorySlug(program);
  }

  /**
   * Note compatibility score with octave and non-octave transposition
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max, mode, selected }
   * @param {Object} channelAnalysis - Optional full channel analysis for intelligent drum mapping
   * @param {string|null} instrumentSubtype - Optional subtype for transposing instrument offsets
   * @returns {Object}
   */
  scoreNoteCompatibility(
    channelRange,
    instrumentCaps,
    channelAnalysis = null,
    instrumentSubtype = null
  ) {
    // Channel without notes (null range) = neutral score, compatible by default
    if (channelRange.min === null || channelRange.max === null) {
      return {
        compatible: true,
        score: Math.round(this.config.getWeight('noteRange') * 0.5),
        info: 'No notes in MIDI channel (empty channel)'
      };
    }

    const span = channelRange.max - channelRange.min;

    // Discrete mode (drums/pads)
    if (instrumentCaps.mode === 'discrete') {
      return this.scoreDiscreteNotes(channelRange, instrumentCaps.selected, channelAnalysis);
    }

    // If the instrument has no defined range (not configured, neutral score)
    if (instrumentCaps.min === null || instrumentCaps.max === null) {
      return {
        compatible: true,
        score: Math.round(this.config.getWeight('noteRange') * 0.5),
        info: 'Instrument note range not configured (accepts all)'
      };
    }

    const instSpan = instrumentCaps.max - instrumentCaps.min;

    // The channel span is too wide to fit the instrument even after an octave
    // shift. Rather than reject a capable instrument outright, score it as
    // "playable with octave wrapping" (partial, by the fraction of notes that
    // land in range after a best-effort shift + wrap). Being below the
    // acceptable threshold, the channel also becomes a split candidate, so the
    // assigner can prefer a multi-instrument split (audit P1-10 / P2-4).
    if (span > instSpan) {
      return this._scoreBestEffortWrapping(channelRange, instrumentCaps, channelAnalysis);
    }

    // Calculate optimal octave transposition
    let transposition = this.calculateOctaveShift(channelRange, instrumentCaps);

    // If octave shift fails, try transposition offsets for transposing instruments
    if (!transposition.compatible && instrumentSubtype) {
      const offsets = InstrumentTypeConfig.getTransposingOffsets(instrumentSubtype);
      if (offsets) {
        transposition = this.calculateTransposingShift(channelRange, instrumentCaps, offsets);
      }
    }

    if (!transposition.compatible) {
      // No octave (or transposing-instrument) shift fits every note. Fall back
      // to a best-effort center shift + octave wrapping and score by playable
      // ratio, so the instrument stays assignable and split-eligible instead of
      // being discarded (audit P1-10 / P2-4).
      return this._scoreBestEffortWrapping(channelRange, instrumentCaps, channelAnalysis);
    }

    // Score based on transposition (use config bonuses/penalties)
    const perfectNoteScore = this.config.getBonus('perfectNoteRange');
    const transpositionPenalty = this.config.getPenalty('transpositionPerOctave');
    let score = perfectNoteScore;
    let info = null;

    if (transposition.semitones === 0) {
      score = perfectNoteScore;
      info = 'Perfect note range fit (no transposition)';
    } else if (transposition.transposingOffset != null) {
      // Non-octave transposition (transposing instrument like Bb trumpet, Eb sax...)
      // Slightly higher penalty than pure octave: +1 extra point penalty
      const approxOctaves = Math.abs(Math.round(transposition.semitones / 12));
      score = Math.max(0, perfectNoteScore - 6 - approxOctaves * transpositionPenalty);
      const direction = transposition.semitones > 0 ? 'up' : 'down';
      info = `Transposing instrument: ${Math.abs(transposition.semitones)} semitone(s) ${direction}`;
    } else {
      score = Math.max(
        0,
        perfectNoteScore - 5 - Math.abs(transposition.octaves) * transpositionPenalty
      );
      const direction = transposition.octaves > 0 ? 'up' : 'down';
      info = `Transposition: ${Math.abs(transposition.octaves)} octave(s) ${direction}`;
    }

    // Calculate octave wrapping for notes that exceed the range
    const wrapping = this.calculateOctaveWrapping(
      channelRange,
      instrumentCaps,
      transposition.semitones
    );

    // Playability factor: what % of channel notes are actually playable after transposition?
    const issues = [];
    if (
      channelAnalysis?.noteDistribution &&
      Object.keys(channelAnalysis.noteDistribution).length > 0
    ) {
      const usedNotes = Object.keys(channelAnalysis.noteDistribution).map(Number);
      const playableCount = usedNotes.filter((n) => {
        const shifted = n + transposition.semitones;
        // Note is playable if within range, or if wrapping is available
        if (shifted >= instrumentCaps.min && shifted <= instrumentCaps.max) return true;
        if (wrapping.mapping && wrapping.mapping[shifted] !== undefined) return true;
        return false;
      }).length;
      const playableRatio = usedNotes.length > 0 ? playableCount / usedNotes.length : 1;
      if (playableRatio < 1.0) {
        score = Math.round(score * playableRatio);
        info += ` (${Math.round(playableRatio * 100)}% playable)`;
        if (playableRatio < 0.5) {
          issues.push({
            type: 'warning',
            message: `Only ${Math.round(playableRatio * 100)}% of notes playable (${playableCount}/${usedNotes.length})`
          });
        }
      }
    }

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
      info,
      issues: issues.length > 0 ? issues : undefined
    };
  }

  /**
   * Best-effort note-range score for a channel that does NOT fully fit the
   * instrument (span too wide, or no octave/transposing shift aligns the
   * ranges). Applies a center-point octave shift, octave-wraps the notes still
   * out of range (the same fold the playback engine performs), and scores by
   * the fraction of notes that end up playable — so a capable instrument is
   * offered "playable with adaptation" instead of being scored 0/incompatible
   * (audit P1-10). Also populates the previously-dead octaveWrapping payload
   * (audit P2-4). The low resulting score keeps the channel below the split
   * threshold so a multi-instrument split is proposed and can be preferred.
   *
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @param {?Object} channelAnalysis - provides noteDistribution for the ratio.
   * @returns {Object} Same shape as the compatible branch of scoreNoteCompatibility.
   * @private
   */
  _scoreBestEffortWrapping(channelRange, instrumentCaps, channelAnalysis) {
    const channelCenter = (channelRange.min + channelRange.max) / 2;
    const instCenter = (instrumentCaps.min + instrumentCaps.max) / 2;
    const octaves = Math.round((instCenter - channelCenter) / 12);
    const semitones = octaves * 12;

    const wrapping = this.calculateOctaveWrapping(channelRange, instrumentCaps, semitones);

    // Fraction of the channel's notes that land in range after the shift, or
    // that octave-wrapping can fold back in. Prefer the actual used-note
    // histogram; fall back to the full contiguous range.
    let usedNotes;
    if (
      channelAnalysis?.noteDistribution &&
      Object.keys(channelAnalysis.noteDistribution).length > 0
    ) {
      usedNotes = Object.keys(channelAnalysis.noteDistribution).map(Number);
    } else {
      usedNotes = [];
      for (let n = channelRange.min; n <= channelRange.max; n++) usedNotes.push(n);
    }
    const playableCount = usedNotes.filter((n) => {
      const shifted = n + semitones;
      if (shifted >= instrumentCaps.min && shifted <= instrumentCaps.max) return true;
      return !!(wrapping.mapping && wrapping.mapping[shifted] !== undefined);
    }).length;
    const playableRatio = usedNotes.length > 0 ? playableCount / usedNotes.length : 0;

    const perfectNoteScore = this.config.getBonus('perfectNoteRange');
    const transpositionPenalty = this.config.getPenalty('transpositionPerOctave');
    // Octave wrapping is inherently lossy — it folds octaves together, collapsing
    // distinct pitches to unisons and flattening contour — so a best-effort wrap
    // must score strictly BELOW any clean fit. The compatible paths subtract a
    // 5 (octave) / 6 (transposing) base; best-effort subtracts more (WRAP_PENALTY)
    // before scaling by the playable fraction, so a faithful transpose always
    // out-ranks a lossy wrap for the same channel (audit review: score inflation).
    const WRAP_PENALTY = 10;
    const shiftedBase = Math.max(
      0,
      perfectNoteScore - WRAP_PENALTY - Math.abs(octaves) * transpositionPenalty
    );
    const score = Math.round(shiftedBase * playableRatio);
    const pct = Math.round(playableRatio * 100);

    return {
      // Not compatible when nothing is playable even after wrapping.
      compatible: playableRatio > 0,
      score,
      transposition: { semitones, octaves },
      octaveWrapping: wrapping.mapping,
      octaveWrappingEnabled: wrapping.hasWrapping,
      octaveWrappingInfo: wrapping.info,
      info: `Playable with octave wrapping (${pct}% of notes playable after adaptation)`,
      issues: [
        {
          type: playableRatio < 0.75 ? 'warning' : 'info',
          message: `Channel exceeds the instrument range — ${pct}% of notes playable after octave wrapping; a split may preserve more.`
        }
      ]
    };
  }

  /**
   * Calculates the optimal octave shift
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @returns {Object}
   */
  calculateOctaveShift(channelRange, instrumentCaps) {
    // If channel range already fits within instrument range, no transposition needed
    if (channelRange.min >= instrumentCaps.min && channelRange.max <= instrumentCaps.max) {
      return { compatible: true, semitones: 0, octaves: 0 };
    }

    // Calculate centers
    const channelCenter = (channelRange.min + channelRange.max) / 2;
    const instCenter = (instrumentCaps.min + instrumentCaps.max) / 2;

    // Difference in semitones
    const rawShift = instCenter - channelCenter;

    // Round to the nearest multiple of 12
    const octaves = Math.round(rawShift / 12);
    const semitones = octaves * 12;

    // Check if all notes fit after transposition
    const newMin = channelRange.min + semitones;
    const newMax = channelRange.max + semitones;

    if (newMin >= instrumentCaps.min && newMax <= instrumentCaps.max) {
      return {
        compatible: true,
        semitones,
        octaves
      };
    }

    // Try +-1 octave
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
   * Calculates a non-octave transposition shift for transposing instruments.
   * Tests each candidate offset combined with octave shifts (0, +-12).
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @param {number[]} offsets - Candidate transpositions in semitones
   * @returns {Object} - { compatible, semitones, octaves, transposingOffset }
   */
  calculateTransposingShift(channelRange, instrumentCaps, offsets) {
    for (const offset of offsets) {
      // Try the offset combined with octave adjustments: 0, -12, +12, -24, +24
      for (const octaveShift of [0, -12, 12, -24, 24]) {
        const testSemitones = offset + octaveShift;
        const newMin = channelRange.min + testSemitones;
        const newMax = channelRange.max + testSemitones;

        if (newMin >= instrumentCaps.min && newMax <= instrumentCaps.max) {
          return {
            compatible: true,
            semitones: testSemitones,
            octaves: Math.round(testSemitones / 12), // approximate octave equivalent
            transposingOffset: offset // track that this is a non-octave transposition
          };
        }
      }
    }

    return {
      compatible: false,
      reason: 'No transposing shift fits all notes in instrument range'
    };
  }

  /**
   * Calculates octave wrapping for notes outside the instrument's range
   * @param {Object} channelRange - { min, max }
   * @param {Object} instrumentCaps - { min, max }
   * @param {number} baseSemitones - Base transposition already applied
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
   * Score for discrete-note instruments (drums)
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
      const drumFallback = this.config.routing?.drumFallback || null;
      const hasDepthLimits = drumFallback && Object.keys(drumFallback).length > 0;
      return this.scoreDiscreteDrumsIntelligent(
        channelAnalysis,
        selectedNotes,
        hasDepthLimits ? drumFallback : null
      );
    }

    // Fallback: simple closest-note mapping for non-drums discrete instruments
    // Use actually present notes if available, otherwise use the range
    let channelNotes;
    if (
      channelAnalysis &&
      channelAnalysis.noteDistribution &&
      Object.keys(channelAnalysis.noteDistribution).length > 0
    ) {
      channelNotes = Object.keys(channelAnalysis.noteDistribution)
        .map(Number)
        .sort((a, b) => a - b);
    } else {
      channelNotes = [];
      for (let note = channelRange.min; note <= channelRange.max; note++) {
        channelNotes.push(note);
      }
    }

    const supportedCount = channelNotes.filter((n) => selectedNotes.includes(n)).length;
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

    // Create mapping for unsupported notes (to closest note)
    const noteRemapping = {};
    for (const note of channelNotes) {
      if (!selectedNotes.includes(note)) {
        const closest = this.findClosestNote(note, selectedNotes);
        if (closest !== null) {
          noteRemapping[note] = closest;
        }
      }
    }

    const score = Math.round(this.config.getWeight('noteRange') * supportRatio);
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
  scoreDiscreteDrumsIntelligent(channelAnalysis, selectedNotes, categoryDepthLimits) {
    try {
      // Classify MIDI drum notes
      const midiNotes = this.drumMapper.classifyDrumNotes(channelAnalysis.noteEvents || []);

      // Generate intelligent mapping with optional per-category depth limits
      const mappingResult = this.drumMapper.generateMapping(midiNotes, selectedNotes, {
        allowSubstitution: true,
        allowSharing: true,
        allowOmission: true,
        categoryDepthLimits: categoryDepthLimits || null
      });

      const { mapping, quality, substitutions, omissions } = mappingResult;

      // Convert quality score (0-100) to compatibility score using full noteRange weight
      // Quality 100 → score 40, Quality 50 → score 20
      const score = Math.round((quality.score / 100) * this.config.getWeight('noteRange'));

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

      this.logger.info(
        `[DrumMapping] Quality: ${quality.score}/100, Score: ${score}/${this.config.getWeight('noteRange')}, Mapped: ${quality.mappedCount}/${quality.totalCount}`
      );

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
      // Safe fallback: validate noteRange before falling back to simple scoring
      const fallbackRange =
        channelAnalysis &&
        channelAnalysis.noteRange &&
        channelAnalysis.noteRange.min !== null &&
        channelAnalysis.noteRange.max !== null
          ? channelAnalysis.noteRange
          : { min: 0, max: 127 };
      return this.scoreDiscreteNotes(fallbackRange, selectedNotes, null);
    }
  }

  /**
   * Finds the closest note in a list
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
   * Polyphony score
   * @param {number} channelMaxPoly
   * @param {number} instrumentPoly
   * @param {boolean} isDefault - true if polyphony is not configured (default 16)
   * @returns {Object}
   */
  scorePolyphony(channelMaxPoly, instrumentPoly, isDefault = false) {
    const maxScore = this.config.getWeight('polyphony'); // 13
    const margin = instrumentPoly - channelMaxPoly;

    // Polyphony not configured: reduced score (70%) since unverified
    if (isDefault && margin >= 0) {
      return {
        score: Math.round(maxScore * 0.7),
        info: `Polyphony not configured (default ${instrumentPoly}), assumed sufficient for ${channelMaxPoly} needed`
      };
    }

    if (margin >= 8) {
      return {
        score: maxScore,
        info: `Excellent polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= 4) {
      return {
        score: Math.round(maxScore * 0.7),
        info: `Good polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= 0) {
      return {
        score: Math.round(maxScore * 0.5),
        info: `Sufficient polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
      };
    } else if (margin >= -4) {
      // Slightly insufficient: warning but not incompatible
      return {
        score: 0,
        issue: {
          type: 'warning',
          message: `Insufficient polyphony (${instrumentPoly} available, ${channelMaxPoly} needed)`
        }
      };
    } else {
      // Severely insufficient: incompatible
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
   * MIDI controller support score
   * @param {Array<number>} channelCCs
   * @param {Array<number>|null} instrumentCCs
   * @returns {Object}
   */
  scoreCCSupport(channelCCs, instrumentCCs) {
    const ccWeight = this.config.getWeight('ccSupport'); // 5
    if (channelCCs.length === 0) {
      return { score: ccWeight, info: 'No CCs used by channel' };
    }

    // If the instrument has no configured CC list: neutral score (not full)
    if (!instrumentCCs || instrumentCCs.length === 0) {
      return {
        score: Math.round(ccWeight * 0.53),
        info: 'Instrument CC support unknown (not configured)'
      };
    }

    // Count how many CCs are supported
    const supportedCount = channelCCs.filter((cc) => instrumentCCs.includes(cc)).length;
    const supportRatio = supportedCount / channelCCs.length;

    const score = Math.round(ccWeight * supportRatio);

    if (supportRatio === 1) {
      return {
        score,
        info: `All ${channelCCs.length} CCs supported`
      };
    } else if (supportRatio >= 0.5) {
      const unsupported = channelCCs.filter((cc) => !instrumentCCs.includes(cc));
      return {
        score,
        issue: {
          type: 'info',
          message: `Some CCs not supported: ${unsupported.join(', ')}`
        }
      };
    } else {
      const unsupported = channelCCs.filter((cc) => !instrumentCCs.includes(cc));
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
   * Instrument type score
   * @param {Object|string} channelType - { type, confidence, scores } or string
   * @param {string} instrumentType - 'melody', 'harmony', 'bass', 'percussive', 'unknown'
   * @returns {Object}
   */
  scoreInstrumentType(channelType, instrumentType) {
    const maxScore = this.config.getWeight('instrumentType'); // 20

    // Extract hierarchical type info
    const channelTypeInfo = typeof channelType === 'object' ? channelType : { type: channelType };
    const channelCategory = channelTypeInfo.category || null; // ex: 'guitar'
    const channelSubtype = channelTypeInfo.categorySubtype || null; // ex: 'nylon'
    const channelGenericType = channelTypeInfo.type || null; // ex: 'melody', 'bass'

    const instrumentTypeInfo =
      typeof instrumentType === 'object' ? instrumentType : { type: instrumentType };
    const instCategory = instrumentTypeInfo.category || null;
    const instSubtype = instrumentTypeInfo.subtype || null;
    const instGenericType = instrumentTypeInfo.type || null;

    // If both have a hierarchical category, use hierarchical scoring
    if (
      channelCategory &&
      instCategory &&
      channelCategory !== 'unknown' &&
      instCategory !== 'unknown'
    ) {
      return this.scoreHierarchicalType(
        channelCategory,
        channelSubtype,
        instCategory,
        instSubtype,
        maxScore
      );
    }

    // Fallback: at least one side has no hierarchical category
    // Use generic matching (legacy). Prefer the heuristic generic type over a
    // literal 'unknown' category — a channel with no Program Change still has a
    // detected `type` (e.g. 'bass'), and using 'unknown' here discarded it and
    // collapsed the score to neutral (audit P2-6).
    const channelTypeStr =
      channelCategory && channelCategory !== 'unknown' ? channelCategory : channelGenericType;
    const instTypeStr = instCategory && instCategory !== 'unknown' ? instCategory : instGenericType;

    if (
      !channelTypeStr ||
      channelTypeStr === 'unknown' ||
      !instTypeStr ||
      instTypeStr === 'unknown'
    ) {
      return { score: Math.round(maxScore * 0.5), info: 'Instrument type not determined' };
    }

    // Legacy mapping for compatibility
    const typeMapping = {
      piano: ['melody', 'harmony'],
      strings: ['melody', 'harmony'],
      organ: ['harmony', 'melody'],
      lead: ['melody'],
      pad: ['harmony', 'melody'],
      brass: ['melody', 'harmony'],
      percussive: ['percussive'],
      drums: ['percussive'],
      bass: ['bass', 'melody']
    };

    const acceptableTypes = typeMapping[channelTypeStr];
    if (!acceptableTypes) {
      // The legacy map is keyed by category-ish names and has no `melody` /
      // `harmony` key; a channel whose only signal is a generic `melody`/
      // `harmony` type (e.g. no Program Change) is therefore undeterminable
      // here — return neutral rather than a false 0 mismatch (audit review:
      // the P2-6 fix must not regress melody/harmony below the old neutral).
      return { score: Math.round(maxScore * 0.5), info: 'Instrument type not determined' };
    }
    if (acceptableTypes.includes(instTypeStr)) {
      const index = acceptableTypes.indexOf(instTypeStr);
      const score = index === 0 ? Math.round(maxScore * 0.5) : Math.round(maxScore * 0.35);
      return {
        score,
        info: `Legacy type match: ${channelTypeStr} → ${instTypeStr}`
      };
    }

    return { score: 0 };
  }

  /**
   * Timing / playback speed compatibility score.
   * Compares inter-note intervals of the channel with the instrument's min_note_interval.
   * Returns a penalty (negative value) if notes are too fast.
   * @param {Object|null} timingAnalysis - { minInterval, p5Interval, p10Interval, avgInterval } in ms
   * @param {number|null} instrumentMinInterval - Minimum interval in ms the instrument can handle
   * @returns {Object} - { penalty, issue, info }
   */
  scoreTimingCompatibility(timingAnalysis, instrumentMinInterval) {
    // No timing data or no instrument constraint: no penalty
    if (!timingAnalysis || !instrumentMinInterval) {
      return { penalty: 0, issue: null, info: null };
    }

    const timingConfig = this.config.timing || {};
    const p5 = timingAnalysis.p5Interval;
    const p10 = timingAnalysis.p10Interval;

    if (p5 !== undefined && p5 < instrumentMinInterval) {
      // 5% of notes are faster than instrument can handle = severe
      return {
        penalty: timingConfig.tooFastPenalty || -10,
        issue: {
          type: 'warning',
          message: `Notes too fast for instrument (${p5}ms vs min ${instrumentMinInterval}ms)`
        },
        info: `Speed: p5=${p5}ms < min ${instrumentMinInterval}ms`
      };
    }

    if (p10 !== undefined && p10 < instrumentMinInterval) {
      // 10% of notes are moderately fast
      return {
        penalty: timingConfig.moderatelyFastPenalty || -5,
        issue: {
          type: 'info',
          message: `Some notes may be too fast (${p10}ms vs min ${instrumentMinInterval}ms)`
        },
        info: `Speed: p10=${p10}ms < min ${instrumentMinInterval}ms`
      };
    }

    return { penalty: 0, issue: null, info: null };
  }

  /**
   * Hierarchical scoring based on InstrumentTypeConfig
   * @param {string} channelCategory - Channel category (e.g. 'guitar')
   * @param {string|null} channelSubtype - Channel subtype (e.g. 'nylon')
   * @param {string} instCategory - Instrument category
   * @param {string|null} instSubtype - Instrument subtype
   * @param {number} maxScore - Max score (20)
   * @returns {Object}
   */
  scoreHierarchicalType(channelCategory, channelSubtype, instCategory, instSubtype, maxScore) {
    // 1. Exact category match
    if (channelCategory === instCategory) {
      // Base: exact category match = maxScore - subtypeBonus headroom
      const subtypeBonus = this.config.getBonus('subtypeMatch'); // 5
      let score = maxScore - subtypeBonus; // 15/20 for category only
      let info = `Exact type match: ${channelCategory}`;

      // Subtype bonus if both are defined and identical -> full maxScore
      if (channelSubtype && instSubtype && channelSubtype === instSubtype) {
        score = maxScore; // 20/20 for category + subtype
        info = `Perfect type+subtype match: ${channelCategory}/${channelSubtype}`;
      }

      return { score, info };
    }

    // 2. Same family (e.g. reed <-> pipe -> winds)
    if (InstrumentTypeConfig.areSameFamily(channelCategory, instCategory)) {
      return {
        score: this.config.getBonus('sameFamilyMatch'), // 12
        info: `Same family match: ${channelCategory} ↔ ${instCategory}`
      };
    }

    // 3. Compatible types but not the same family -> low score
    return { score: 0 };
  }

  /**
   * Heuristic feasibility scoring for the instrument's mechanical hand.
   * Runs without per-note timing (which would require a full planner
   * dry-run) by reasoning on the aggregated `channelAnalysis`:
   *
   *  - polyphony.max compared against the per-mode capacity
   *    (sum of `hand_span_semitones` across hands for keyboards;
   *    `max_fingers` or `num_strings` proxy for frets mode).
   *  - pitch span (noteRange.max − noteRange.min) compared against the
   *    span the hand(s) can cover without a shift.
   *
   * Returns a structured payload — A.2 turns `qualityScore` into a
   * weighted bonus/penalty, C.3 renders the badge. When the instrument
   * has no `hands_config` (or is disabled, or the analysis is
   * incomplete), the helper returns `level: 'unknown'` with no info /
   * issue so the matcher's existing behaviour is unchanged.
   *
   * @param {Object} channelAnalysis
   * @param {Object} instrument - Capabilities row including hands_config.
   * @returns {{
   *   level: 'unknown'|'ok'|'warning'|'infeasible',
   *   qualityScore: number,
   *   summary: Object,
   *   info: ?string,
   *   issue: ?{type:string, message:string}
   * }}
   */
  _scoreHandPositionFeasibility(channelAnalysis, instrument) {
    const unknown = { level: 'unknown', qualityScore: 0, summary: {}, info: null, issue: null };

    if (!instrument) return unknown;
    let hands = instrument.hands_config;
    if (typeof hands === 'string') {
      try {
        hands = JSON.parse(hands);
      } catch (_) {
        return unknown;
      }
    }
    if (!hands || hands.enabled === false) return unknown;
    if (!Array.isArray(hands.hands) || hands.hands.length === 0) return unknown;

    const polyphonyMax = channelAnalysis?.polyphony?.max ?? null;
    const noteRange = channelAnalysis?.noteRange ?? null;
    const rangeSpan =
      noteRange && noteRange.min != null && noteRange.max != null
        ? noteRange.max - noteRange.min
        : null;

    const mode = hands.mode === 'frets' ? 'frets' : 'semitones';
    const summary = { mode };
    let level = 'ok';
    let info = null;
    let issue = null;
    let qualityScore = 100;

    if (mode === 'frets') {
      const fretting = hands.hands.find((h) => h && h.id === 'fretting') || hands.hands[0];
      // Polyphony capacity: `max_fingers` when set, else `num_fingers` — the
      // validator requires `num_fingers` for `fret_sliding_fingers` mechanisms
      // and leaves `max_fingers` optional, so keying only on max_fingers gave a
      // false "feasible" for those effectors (audit P2-7).
      const maxFingers =
        Number.isFinite(fretting?.max_fingers) && fretting.max_fingers > 0
          ? fretting.max_fingers
          : Number.isFinite(fretting?.num_fingers) && fretting.num_fingers > 0
            ? fretting.num_fingers
            : null;
      let handSpanFrets =
        Number.isFinite(fretting?.hand_span_frets) && fretting.hand_span_frets > 0
          ? fretting.hand_span_frets
          : null;
      // The canonical/recommended config expresses reach as `hand_span_mm`, not
      // `hand_span_frets`. Convert it so the shift heuristic below isn't
      // silently skipped — leaving feasibility falsely "ok" for the common case
      // (audit P2-7 #2). The mm→fret map is non-linear; use the reach measured
      // from the nut (position 0, where frets are widest → fewest frets → the
      // conservative estimate): frets = -12·log2(1 − hand_span_mm/scale_length).
      // Use the instrument's real scale length when known (joined from
      // string_instruments), else a standard 648 mm guitar scale.
      if (
        handSpanFrets == null &&
        Number.isFinite(fretting?.hand_span_mm) &&
        fretting.hand_span_mm > 0
      ) {
        const scaleMm =
          Number.isFinite(instrument.scale_length_mm) && instrument.scale_length_mm > 0
            ? instrument.scale_length_mm
            : 648;
        const ratio = fretting.hand_span_mm / scaleMm;
        handSpanFrets = ratio >= 1 ? 24 : Math.max(1, Math.round(-12 * Math.log2(1 - ratio)));
        summary.handSpanFromMm = true;
      }
      summary.maxFingers = maxFingers;
      summary.handSpanFrets = handSpanFrets;
      summary.polyphonyMax = polyphonyMax;
      summary.pitchSpan = rangeSpan;

      // Polyphony cap: open strings don't consume a finger but we have
      // no way to know the fingering distribution at scoring time. The
      // safe bound is "polyphony ≤ max_fingers" — over that, the
      // converter will start dropping notes (B.1).
      if (maxFingers != null && polyphonyMax != null && polyphonyMax > maxFingers) {
        const excess = polyphonyMax - maxFingers;
        level = 'infeasible';
        qualityScore = Math.max(0, 60 - excess * 20);
        issue = {
          type: 'warning',
          message: `Hand has ${maxFingers} finger(s) but the channel needs ${polyphonyMax} simultaneous notes — some notes will drop.`
        };
        info = `Hand-position: polyphony ${polyphonyMax} > max_fingers ${maxFingers}`;
      } else if (handSpanFrets != null && rangeSpan != null && rangeSpan > handSpanFrets * 3) {
        // Pitch range much wider than what the hand reaches without
        // shift → many shifts will be needed. Heuristic threshold: if
        // the channel covers more than 3 hand-spans, the planner will
        // produce frequent move_too_fast warnings.
        level = 'warning';
        qualityScore = 70;
        info = `Hand-position: pitch span ${rangeSpan} ≫ hand_span_frets ${handSpanFrets} (frequent shifts)`;
      } else {
        info = `Hand-position: ok (mode=frets)`;
      }
    } else {
      // Semitones mode: capacity is the sum of hand_span_semitones over
      // all hands (typically 2 × 14 = 28 semitones reachable without
      // crossing hands). Polyphony cap is sum of polyphony per hand,
      // which we approximate as 5 fingers × hands.length.
      const totalSpan = hands.hands.reduce(
        (s, h) => s + (Number.isFinite(h?.hand_span_semitones) ? h.hand_span_semitones : 14),
        0
      );
      // Sum the per-hand finger count (`num_fingers`, fallback 5) instead of a
      // hardcoded 5/hand, so a 2-hand × 3-finger robot is bounded at 6, not 10
      // (audit P2-7). The validator documents num_fingers as the polyphony bound.
      const totalFingers = hands.hands.reduce(
        (s, h) => s + (Number.isFinite(h?.num_fingers) && h.num_fingers > 0 ? h.num_fingers : 5),
        0
      );
      summary.totalSpanSemitones = totalSpan;
      summary.totalFingers = totalFingers;
      summary.polyphonyMax = polyphonyMax;
      summary.pitchSpan = rangeSpan;

      if (polyphonyMax != null && polyphonyMax > totalFingers) {
        level = 'infeasible';
        qualityScore = Math.max(0, 60 - (polyphonyMax - totalFingers) * 15);
        issue = {
          type: 'warning',
          message: `Channel polyphony ${polyphonyMax} exceeds available fingers (${totalFingers}).`
        };
        info = `Hand-position: polyphony ${polyphonyMax} > fingers ${totalFingers}`;
      } else if (rangeSpan != null && rangeSpan > totalSpan * 2) {
        level = 'warning';
        qualityScore = 70;
        info = `Hand-position: pitch span ${rangeSpan} > 2 × total hand span ${totalSpan} (frequent shifts)`;
      } else {
        info = `Hand-position: ok (mode=semitones)`;
      }
    }

    return { level, qualityScore, summary, info, issue };
  }

  /**
   * Determines the type of an instrument (hierarchical + generic)
   * @param {Object} instrument
   * @returns {{ type: string, category: string|null, subtype: string|null }}
   */
  getInstrumentType(instrument) {
    // Priority 1: use the hierarchical type stored in DB
    if (instrument.instrument_type && instrument.instrument_type !== 'unknown') {
      return {
        type: this.getGenericType(instrument.instrument_type),
        category: instrument.instrument_type,
        subtype: instrument.instrument_subtype || null
      };
    }

    // Priority 2: detect from GM program
    const program = instrument.gm_program;
    if (program !== null && program !== undefined) {
      const detected = InstrumentTypeConfig.detectTypeFromProgram(program);
      if (detected.type !== 'unknown') {
        return {
          type: this.getGenericType(detected.type),
          category: detected.type,
          subtype: detected.subtype
        };
      }
    }

    // Priority 3: inference from name
    if (program === null || program === undefined) {
      const inferred = this.inferTypeFromName(instrument);
      if (inferred !== 'unknown') return { type: inferred, category: null, subtype: null };

      if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
        const avgNote = (instrument.note_range_min + instrument.note_range_max) / 2;
        if (avgNote < 48) return { type: 'bass', category: 'bass', subtype: null };
      }

      if (instrument.note_selection_mode === 'discrete') {
        return { type: 'percussive', category: 'drums', subtype: null };
      }

      return { type: 'unknown', category: null, subtype: null };
    }

    // Fallback by GM program (legacy)
    if (program >= 112 && program <= 119)
      return { type: 'percussive', category: 'drums', subtype: null };
    if (program >= 32 && program <= 39) return { type: 'bass', category: 'bass', subtype: null };
    if ((program >= 0 && program <= 7) || (program >= 40 && program <= 55)) {
      return { type: 'harmony', category: null, subtype: null };
    }

    if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
      const avgNote = (instrument.note_range_min + instrument.note_range_max) / 2;
      if (avgNote < 48) return { type: 'bass', category: 'bass', subtype: null };
    }

    return { type: 'melody', category: null, subtype: null };
  }

  /**
   * Converts a hierarchical category to a generic type
   * @param {string} category - e.g. 'guitar', 'brass', 'piano'
   * @returns {string} - 'melody', 'harmony', 'bass', 'percussive', 'unknown'
   */
  getGenericType(category) {
    const mapping = {
      piano: 'harmony',
      chromatic_percussion: 'percussive',
      organ: 'harmony',
      guitar: 'melody',
      bass: 'bass',
      strings: 'melody',
      ensemble: 'harmony',
      brass: 'melody',
      reed: 'melody',
      pipe: 'melody',
      synth_lead: 'melody',
      synth_pad: 'harmony',
      synth_effects: 'melody',
      ethnic: 'melody',
      drums: 'percussive',
      sound_effects: 'percussive'
    };
    return mapping[category] || 'unknown';
  }

  /**
   * Infers the instrument type from its name
   * @param {Object} instrument
   * @returns {string} - 'percussive', 'bass', 'harmony', 'melody', or 'unknown'
   */
  inferTypeFromName(instrument) {
    const name = (instrument.name || instrument.custom_name || '').toLowerCase();
    if (!name) return 'unknown';

    const keywords = {
      percussive: [
        'drum',
        'perc',
        'kit',
        'cymbal',
        'snare',
        'kick',
        'tom',
        'hi-hat',
        'hihat',
        'cajon'
      ],
      bass: ['bass', 'sub'],
      harmony: ['piano', 'keys', 'keyboard', 'organ', 'strings', 'pad', 'chord', 'harp'],
      melody: ['lead', 'synth', 'flute', 'trumpet', 'sax', 'violin', 'guitar', 'clarinet', 'oboe']
    };

    for (const [type, words] of Object.entries(keywords)) {
      if (words.some((w) => name.includes(w))) return type;
    }
    return 'unknown';
  }

  /**
   * Checks if an instrument is of type drums
   * @param {Object} instrument
   * @returns {boolean}
   */
  isDrumsInstrument(instrument) {
    const program = instrument.gm_program;
    // Keep this predicate aligned with AutoAssigner.isDrumInstrument: a kit
    // configured `instrument_type='drums'` (or bound to GM channel 9) must be
    // recognised as drums even without discrete mode or a 112-119 program,
    // otherwise the assigner offers it for the drum channel while the matcher
    // scores it ~0 and flags it incompatible (audit P2-5).
    return (
      instrument.instrument_type === 'drums' ||
      instrument.note_selection_mode === 'discrete' ||
      instrument.channel === 9 ||
      (program >= 112 && program <= 119)
    );
  }
}

export default InstrumentMatcher;
