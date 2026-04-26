/**
 * @file src/midi/adaptation/MidiAdaptationService.js
 * @description Thin façade grouping the two MIDI-adaptation
 * collaborators ({@link MidiTransposer}, {@link AutoAssigner}) behind a
 * single object so callers can be wired with one DI key (P0-1.6, see
 * ADR-001 §Phase 1).
 *
 * Mostly delegates verbatim. The exception is `adaptAndOptimize`,
 * which runs a hand-position feasibility dry-run (B.5) and proposes
 * non-destructive remediations (transpose, split) the caller can apply
 * if desired. Capo suggestions were removed in 2026-04 along with the
 * rest of the capo feature; transposition (octave shifts) covers the
 * same use case without altering the instrument hardware state.
 */
import MidiTransposer from './MidiTransposer.js';
import InstrumentMatcher from './InstrumentMatcher.js';

export default class MidiAdaptationService {
  /**
   * @param {Object} logger
   * @param {Object} autoAssigner - Pre-built AutoAssigner singleton.
   */
  constructor(logger, autoAssigner) {
    this.logger = logger;
    this.transposer = new MidiTransposer(logger);
    this.autoAssigner = autoAssigner;
    this._matcher = new InstrumentMatcher(logger);
  }

  /**
   * @param {Object} midiData
   * @param {Object<number, number>} transpositions - channel → semitones.
   * @returns {Object} Updated MIDI data.
   */
  transposeChannels(midiData, transpositions) {
    return this.transposer.transposeChannels(midiData, transpositions);
  }

  /**
   * Force every note on a channel into the `[min, max]` range.
   *
   * @param {Object} midiData
   * @param {number} channel
   * @param {number} min - Inclusive lower MIDI note.
   * @param {number} max - Inclusive upper MIDI note.
   * @returns {Object}
   */
  compressChannel(midiData, channel, min, max) {
    return this.transposer.compressChannel(midiData, channel, min, max);
  }

  /**
   * Split a channel's notes into multiple sub-channels using the given
   * segment specifications.
   *
   * @param {Object} midiData
   * @param {number} channel
   * @param {Object[]} segments
   * @returns {Object}
   */
  splitChannelInFile(midiData, channel, segments) {
    return this.transposer.splitChannelInFile(midiData, channel, segments);
  }

  /**
   * @param {Object} midiData
   * @returns {number[]} Channels (0-15) carrying no note events.
   */
  findFreeChannels(midiData) {
    return this.transposer.findFreeChannels(midiData);
  }

  /**
   * @param {Object} midiData
   * @param {number} channel
   * @param {(string|number)} fileId
   * @returns {Object} Analysis result from the auto-assigner.
   */
  analyzeChannel(midiData, channel, fileId) {
    return this.autoAssigner.analyzeChannel(midiData, channel, fileId);
  }

  /**
   * @param {Object} midiData
   * @param {Object} options
   * @returns {Promise<Object>} Suggestion list keyed by channel.
   */
  async generateSuggestions(midiData, options) {
    return this.autoAssigner.generateSuggestions(midiData, options);
  }

  /**
   * Hand-position dry-run + non-destructive remediation suggestions.
   * For each channel routed to a hands_config-equipped instrument we
   * classify feasibility (matcher heuristic from A.1) and, when the
   * level is `warning` or `infeasible`, search a small set of
   * candidate fixes — octave transpositions — for one that would lift
   * the level back to `ok`. Output is purely advisory: the caller
   * decides whether to apply.
   *
   * @param {Object} midiData
   * @param {Object<number|string, {instrument:Object}>} channelToInstrument
   *   Map from channel to the routed instrument record. The
   *   instrument must carry the same fields the matcher already
   *   reads (hands_config, scale_length_mm, note_range_min/max,
   *   polyphony…).
   * @returns {Object<string, {
   *   level:string, summary:Object,
   *   recommendations:Array<Object>
   * }>}
   */
  adaptAndOptimize(midiData, channelToInstrument) {
    const out = {};
    if (!midiData || !channelToInstrument) return out;

    for (const [channelKey, entry] of Object.entries(channelToInstrument)) {
      const channel = parseInt(channelKey, 10);
      if (!Number.isFinite(channel)) continue;
      const instrument = entry?.instrument || entry;
      if (!instrument) continue;

      let analysis;
      try {
        analysis = this.analyzeChannel(midiData, channel);
      } catch (e) {
        this.logger?.warn?.(`adaptAndOptimize: analyzeChannel(${channel}) failed: ${e.message}`);
        continue;
      }
      if (!analysis) continue;

      const baseline = this._matcher._scoreHandPositionFeasibility(analysis, instrument);
      const recommendations = (baseline.level === 'warning' || baseline.level === 'infeasible')
        ? this._buildRecommendations(analysis, instrument, baseline)
        : [];

      out[channel] = {
        level: baseline.level,
        summary: baseline.summary,
        message: baseline.issue?.message || baseline.info || null,
        recommendations
      };
    }

    return out;
  }

  /**
   * Build remediation suggestions for a sub-optimal feasibility result.
   * Each recommendation is a `{type, params, projectedLevel, rationale}`
   * shape so the caller can render and apply it independently.
   * @private
   */
  _buildRecommendations(analysis, instrument, baseline) {
    const recs = [];
    const order = { unknown: 0, ok: 3, warning: 2, infeasible: 1 };
    const isImprovement = (newLevel) => order[newLevel] > order[baseline.level];

    // Transposition candidates: ±12 / ±24 semitones (octave shifts) keep
    // the music intelligible while moving the channel into a more
    // comfortable region of the instrument's range. We only try octave
    // shifts because partial transpositions usually require user
    // taste choices the dry-run can't make.
    const candidates = [-24, -12, 12, 24];
    for (const semitones of candidates) {
      const shifted = this._shiftAnalysis(analysis, semitones);
      if (!shifted) continue;
      const r = this._matcher._scoreHandPositionFeasibility(shifted, instrument);
      if (isImprovement(r.level)) {
        recs.push({
          type: 'transpose',
          params: { semitones },
          projectedLevel: r.level,
          rationale: `Transpose ${semitones > 0 ? '+' : ''}${semitones} semitones (${semitones / 12 > 0 ? '+' : ''}${semitones / 12} octave${Math.abs(semitones) === 12 ? '' : 's'}) lifts feasibility ${baseline.level} → ${r.level}.`
        });
      }
    }

    // (Capo suggestions removed — see file header. Octave transposes
    // above already cover the "shift the comfortable zone" use case
    // without altering instrument hardware state.)

    // Split: when polyphony exceeds the hand's finger budget, no
    // single-instrument transpose can recover. Surface a flag
    // so the caller can decide whether to invoke a multi-instrument
    // split (B.7 ambitious feature).
    if (baseline.level === 'infeasible' && baseline.summary?.polyphonyMax != null) {
      const limit = baseline.summary.maxFingers ?? baseline.summary.totalFingers;
      if (Number.isFinite(limit) && baseline.summary.polyphonyMax > limit) {
        recs.push({
          type: 'split',
          params: { reason: 'polyphony_exceeds_fingers', polyphony: baseline.summary.polyphonyMax, limit },
          projectedLevel: 'requires-second-instrument',
          rationale: `Polyphony ${baseline.summary.polyphonyMax} exceeds finger budget ${limit}; consider splitting onto a second instrument.`
        });
      }
    }

    return recs;
  }

  /**
   * Shift the analysis pitch range by `semitones` and return a copy.
   * Polyphony is invariant under pitch shift so we keep the original
   * value. Returns null when the analysis lacks a usable noteRange.
   * @private
   */
  _shiftAnalysis(analysis, semitones) {
    if (!analysis?.noteRange || analysis.noteRange.min == null || analysis.noteRange.max == null) {
      return null;
    }
    const min = analysis.noteRange.min + semitones;
    const max = analysis.noteRange.max + semitones;
    return {
      ...analysis,
      noteRange: { min: Math.max(0, min), max: Math.min(127, max) }
    };
  }
}
