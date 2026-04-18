/**
 * @file src/midi/routing/ChannelAnalyzer.js
 * @description Pure-data MIDI channel profiler. Walks every event in a
 * file and produces a per-channel summary used by {@link AutoAssigner}
 * and {@link InstrumentMatcher}:
 *   - Note range (min / max)
 *   - Note distribution (histogram per pitch class)
 *   - Polyphony (max simultaneous, average)
 *   - MIDI controllers used (CC numbers + frequency)
 *   - Primary GM program (most common Program Change)
 *   - Estimated instrument type via {@link InstrumentTypeConfig}
 *
 * Stateless besides the injected {@link ScoringConfig}; safe to share.
 */

import ScoringConfig from '../adaptation/ScoringConfig.js';
import InstrumentTypeConfig from '../adaptation/InstrumentTypeConfig.js';

class ChannelAnalyzer {
  constructor(logger, config = null) {
    this.logger = logger;
    this.config = config || ScoringConfig;
  }

  /**
   * Analyzes all active channels in a MIDI file
   * @param {Object} midiData - Parsed MIDI file
   * @returns {Array<ChannelAnalysis>}
   */
  analyzeAllChannels(midiData) {
    const activeChannels = this.extractActiveChannels(midiData);
    return activeChannels.map(channel => this.analyzeChannel(midiData, channel));
  }

  /**
   * Extracts active channel numbers (those containing notes)
   * @param {Object} midiData - Parsed MIDI file
   * @returns {Array<number>} - Active channels (0-15)
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
   * Analyzes a specific MIDI channel
   * @param {Object} midiData - Parsed MIDI file
   * @param {number} channel - Channel to analyze (0-15)
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

    // Enrich with hierarchical category from GM program
    const hierarchicalCategory = primaryProgram !== null
      ? InstrumentTypeConfig.detectTypeFromProgram(primaryProgram)
      : { type: 'unknown', subtype: null };

    // Timing analysis: inter-note intervals for speed capability scoring
    const timingAnalysis = this.calculateTimingAnalysis(noteEvents, midiData);

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
      // Hierarchical category detected from GM program
      estimatedCategory: hierarchicalCategory.type,
      estimatedSubtype: hierarchicalCategory.subtype,
      noteEvents, // Include note events for intelligent drum mapping
      timingAnalysis // Inter-note timing statistics for speed capability scoring
    };
  }

  /**
   * Retrieves all events for a specific channel
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

      // Accumulate deltaTime into absolute ticks per track
      let absoluteTick = 0;
      for (const event of track.events) {
        absoluteTick += event.deltaTime || 0;
        if (event.channel === channel) {
          events.push({ ...event, absoluteTick });
        }
      }
    }

    // Sort by absolute tick position (correct ordering across multiple tracks)
    events.sort((a, b) => a.absoluteTick - b.absoluteTick);

    return events;
  }

  /**
   * Extracts the used note range
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

    // If no notes found, return null to indicate an empty channel
    if (min > max) {
      return { min: null, max: null };
    }

    return { min, max };
  }

  /**
   * Builds a histogram of used notes
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
   * Counts the total number of notes
   * @param {Array<Object>} noteEvents
   * @returns {number}
   */
  countNotes(noteEvents) {
    return noteEvents.filter(e => e.type === 'noteOn' && e.velocity > 0).length;
  }

  /**
   * Calculates maximum and average polyphony
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
   * Analyzes time intervals between consecutive notes.
   * Returns timing statistics for evaluating speed capabilities.
   * @param {Array<Object>} noteEvents - Note events (with absoluteTick)
   * @param {Object} midiData - MIDI data for tempo/tick conversion
   * @returns {Object} - { minInterval, p5Interval, p10Interval, avgInterval } in ms
   */
  calculateTimingAnalysis(noteEvents, midiData) {
    const ticksPerBeat = midiData?.header?.ticksPerBeat || 480;
    const tempo = midiData?.tempo || 120;
    const msPerTick = (60000 / tempo) / ticksPerBeat;

    // Collect noteOn events with absolute ticks
    const noteOns = noteEvents
      .filter(e => e.type === 'noteOn' && (e.velocity ?? 0) > 0 && e.absoluteTick != null)
      .sort((a, b) => a.absoluteTick - b.absoluteTick);

    if (noteOns.length < 2) {
      return { minInterval: Infinity, p5Interval: Infinity, p10Interval: Infinity, avgInterval: Infinity };
    }

    // Calculate intervals between consecutive noteOn events (in ms)
    const intervals = [];
    for (let i = 1; i < noteOns.length; i++) {
      const deltaTicks = noteOns[i].absoluteTick - noteOns[i - 1].absoluteTick;
      if (deltaTicks > 0) {
        intervals.push(deltaTicks * msPerTick);
      }
    }

    if (intervals.length === 0) {
      return { minInterval: Infinity, p5Interval: Infinity, p10Interval: Infinity, avgInterval: Infinity };
    }

    // Sort for percentile calculations
    intervals.sort((a, b) => a - b);

    const minInterval = intervals[0];
    const p5Index = Math.max(0, Math.floor(intervals.length * 0.05));
    const p10Index = Math.max(0, Math.floor(intervals.length * 0.10));
    const p5Interval = intervals[p5Index];
    const p10Interval = intervals[p10Index];
    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;

    return {
      minInterval: Math.round(minInterval),
      p5Interval: Math.round(p5Interval),
      p10Interval: Math.round(p10Interval),
      avgInterval: Math.round(avgInterval)
    };
  }

  /**
   * Extracts the list of used MIDI controllers
   * @param {Array<Object>} events
   * @returns {Array<number>} - Used CC numbers
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
   * Checks if pitch bend is used
   * @param {Array<Object>} events
   * @returns {boolean}
   */
  hasPitchBend(events) {
    return events.some(e => e.type === 'pitchBend' || e.type === 'pitchbend');
  }

  /**
   * Extracts all program changes
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
   * Extracts Bank Select MSB (CC0) and LSB (CC32) values
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
   * Determines the primary MIDI program (most used or first)
   * @param {Array<number>} programs
   * @returns {number|null}
   */
  getPrimaryProgram(programs) {
    if (programs.length === 0) {
      return null;
    }

    // Count occurrences
    const counts = {};
    for (const prog of programs) {
      counts[prog] = (counts[prog] || 0) + 1;
    }

    // Find the most frequent
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
   * Retrieves the track names associated with this channel
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

      // Check if this track contains events for this channel
      const hasChannel = track.events.some(e => e.channel === channel);

      if (hasChannel && track.name) {
        names.push(track.name);
      }
    }

    return names;
  }

  /**
   * Calculates note density (notes/second)
   * @param {Array<Object>} noteEvents
   * @param {number} duration - Duration in seconds
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
   * Estimates the instrument type based on characteristics (improved version)
   * @param {Object} analysis
   * @returns {Object} - { type: string, confidence: number, scores: Object }
   */
  estimateInstrumentType(analysis) {
    const { channel, noteRange, noteDistribution, polyphony, primaryProgram, density, trackNames } = analysis;

    // Use ScoringConfig thresholds and weights
    const thresholds = this.config.typeThresholds;
    const weights = this.config.typeDetection;

    // Scores for each type (0-100)
    const scores = {
      drums: 0,
      percussive: 0,
      bass: 0,
      melody: 0,
      harmony: 0
    };

    // Channel 9 (MIDI 10) = always drums with 100% confidence
    if (channel === 9) {
      return {
        type: 'drums',
        confidence: 100,
        scores: { drums: 100, percussive: 0, bass: 0, melody: 0, harmony: 0 }
      };
    }

    // 1. MIDI program analysis (strong indicator, weight: programWeight)
    if (primaryProgram !== null) {
      if (primaryProgram >= 112 && primaryProgram <= 119) {
        scores.percussive += weights.programWeight;
        scores.drums += weights.programWeight * 0.75;
      } else if (primaryProgram >= 32 && primaryProgram <= 39) {
        scores.bass += weights.programWeight;
      } else if (primaryProgram >= 0 && primaryProgram <= 7) {
        scores.harmony += weights.programWeight * 0.875;
        scores.melody += weights.programWeight * 0.375;
      } else if (primaryProgram >= 8 && primaryProgram <= 15) {
        // Chromatic percussion (celesta, glockenspiel, vibraphone, xylophone…)
        scores.melody += weights.programWeight * 0.5;
        scores.harmony += weights.programWeight * 0.5;
      } else if (primaryProgram >= 16 && primaryProgram <= 23) {
        // Organ
        scores.harmony += weights.programWeight * 0.875;
        scores.melody += weights.programWeight * 0.375;
      } else if (primaryProgram >= 24 && primaryProgram <= 31) {
        // Guitar (nylon, steel, jazz, clean, overdrive, distortion, harmonics)
        scores.melody += weights.programWeight * 0.75;
        scores.harmony += weights.programWeight * 0.5;
      } else if (primaryProgram >= 40 && primaryProgram <= 55) {
        scores.harmony += weights.programWeight;
      } else if (primaryProgram >= 56 && primaryProgram <= 79) {
        scores.melody += weights.programWeight * 0.75;
        scores.harmony += weights.programWeight * 0.5;
      } else if (primaryProgram >= 80 && primaryProgram <= 103) {
        scores.melody += weights.programWeight * 0.875;
        scores.harmony += weights.programWeight * 0.375;
      } else if (primaryProgram >= 104 && primaryProgram <= 111) {
        // Ethnic instruments (sitar, banjo, shamisen, koto, kalimba…)
        scores.melody += weights.programWeight * 0.75;
        scores.harmony += weights.programWeight * 0.375;
      }
    }

    // 2. Note range analysis (weight: rangeWeight)
    const avgNote = this.getAverageNote(noteDistribution);
    const span = noteRange.max - noteRange.min;

    // Very low notes = bass
    if (avgNote < thresholds.lowNote) {
      scores.bass += weights.rangeWeight;
    } else if (avgNote >= thresholds.lowNote && avgNote < 72) {
      scores.melody += weights.rangeWeight * 0.6;
      scores.harmony += weights.rangeWeight * 0.4;
    } else {
      scores.melody += weights.rangeWeight * 0.8;
    }

    // Narrow range in low notes = drums
    const drumRange = thresholds.drumNoteRange;
    if (noteRange.min >= drumRange.min && noteRange.max <= drumRange.max && span < drumRange.span) {
      scores.drums += weights.rangeWeight * 0.8;
      scores.percussive += weights.rangeWeight * 0.6;
    }

    // Wide range = harmony/piano
    if (span >= thresholds.wideSpan) {
      scores.harmony += weights.rangeWeight * 0.8;
    } else if (span <= thresholds.narrowSpan) {
      scores.drums += weights.rangeWeight * 0.4;
      scores.percussive += weights.rangeWeight * 0.4;
    }

    // 3. Polyphony analysis (weight: polyphonyWeight)
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

    // Low average polyphony with high max = drums (overlapping notes)
    if (polyphony.max >= 3 && polyphony.avg < 1.5) {
      scores.drums += weights.polyphonyWeight * 0.75;
      scores.percussive += weights.polyphonyWeight * 0.5;
    }

    // 4. Rhythmic density analysis (weight: densityWeight)
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

    // 5. Track name analysis (weight: trackNameWeight)
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

    // 6. Normalize negative scores
    for (const key in scores) {
      scores[key] = Math.max(0, scores[key]);
    }

    // Find the type with the best score
    let bestType = 'melody';
    let bestScore = 0;

    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    // Calculate confidence (0-100)
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = totalScore > 0 ? Math.round((bestScore / totalScore) * 100) : 50;

    return {
      type: bestType,
      confidence: Math.min(100, confidence),
      scores
    };
  }

  /**
   * Calculates the weighted average note
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
