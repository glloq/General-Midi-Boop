/**
 * @file src/midi/adaptation/MidiAdaptationService.js
 * @description Thin façade grouping the two MIDI-adaptation
 * collaborators ({@link MidiTransposer}, {@link AutoAssigner}) behind a
 * single object so callers can be wired with one DI key (P0-1.6, see
 * ADR-001 §Phase 1).
 *
 * No business logic lives here — every method delegates verbatim.
 */
import MidiTransposer from './MidiTransposer.js';

export default class MidiAdaptationService {
  /**
   * @param {Object} logger
   * @param {Object} autoAssigner - Pre-built AutoAssigner singleton.
   */
  constructor(logger, autoAssigner) {
    this.logger = logger;
    this.transposer = new MidiTransposer(logger);
    this.autoAssigner = autoAssigner;
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
}
