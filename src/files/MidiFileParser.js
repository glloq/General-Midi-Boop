/**
 * @file src/files/MidiFileParser.js
 * @description Header / metadata extraction helpers used by
 * {@link FileManager} during upload. Extracts:
 *   - File-level metadata (track count, duration, tempo, ppq).
 *   - Per-channel summary (note range, polyphony, primary GM program).
 *   - Aggregate instrument metadata for the FileFilter UI
 *     (`has_drums`, `has_melody`, `has_bass`, distinct GM categories).
 *
 * Stateless — every method takes the parsed `midi-file` AST as input
 * and returns plain values.
 */

import { parseMidi } from 'midi-file';
import ChannelAnalyzer from '../midi/routing/ChannelAnalyzer.js';
import MidiUtils from '../utils/MidiUtils.js';

class MidiFileParser {
  /**
   * @param {Object} logger - Logger instance
   */
  constructor(logger) {
    this.logger = logger;
    this.channelAnalyzer = new ChannelAnalyzer(logger);
  }

  /**
   * Parse and validate a MIDI buffer.
   * @param {Buffer} buffer - Raw MIDI file data
   * @returns {Object} Parsed MIDI object
   * @throws {Error} If the buffer is not valid MIDI
   */
  parse(buffer) {
    try {
      return parseMidi(buffer);
    } catch (error) {
      throw new Error(`Invalid MIDI file: ${error.message}`);
    }
  }

  /**
   * Extract tempo and duration metadata from a parsed MIDI object.
   * @param {Object} midi - Parsed MIDI object
   * @returns {{ tempo: number, duration: number, totalTicks: number }}
   */
  extractMetadata(midi) {
    // Detect SMPTE timing (negative ticksPerBeat indicates SMPTE format)
    const rawTicksPerBeat = midi.header.ticksPerBeat;
    if (rawTicksPerBeat != null && rawTicksPerBeat < 0) {
      this.logger.warn(`SMPTE timing detected (ticksPerBeat=${rawTicksPerBeat}), using heuristic PPQ=480`);
    }
    const ppq = (rawTicksPerBeat > 0) ? rawTicksPerBeat : 480;
    if (!isFinite(ppq)) {
      this.logger.warn(`Invalid PPQ value ${ppq}, using default 480`);
      return { tempo: 120, duration: 0, totalTicks: 0 };
    }

    // Log Format 2 warning (independent tracks merged by channel)
    if (midi.header.format === 2) {
      this.logger.warn('MIDI Format 2 detected: independent tracks will be merged by channel');
    }

    let firstTempo = 120; // Default BPM
    let totalTicks = 0;

    // Collect all tempo events with absolute tick positions
    const tempoEvents = [];
    for (const track of midi.tracks) {
      let trackTicks = 0;
      for (const event of track) {
        trackTicks += event.deltaTime;
        if (event.type === 'setTempo') {
          if (firstTempo === 120 && tempoEvents.length === 0) {
            firstTempo = 60000000 / event.microsecondsPerBeat;
          }
          tempoEvents.push({
            tick: trackTicks,
            microsecondsPerBeat: event.microsecondsPerBeat
          });
        }
      }
    }
    tempoEvents.sort((a, b) => a.tick - b.tick);

    // Deduplicate tempo events at same tick (common in multi-track DAW exports)
    const dedupedTempoEvents = [];
    for (const te of tempoEvents) {
      const last = dedupedTempoEvents[dedupedTempoEvents.length - 1];
      if (!last || last.tick !== te.tick || last.microsecondsPerBeat !== te.microsecondsPerBeat) {
        dedupedTempoEvents.push(te);
      }
    }

    // Calculate total ticks across all tracks
    midi.tracks.forEach(track => {
      let trackTicks = 0;
      track.forEach(event => {
        trackTicks += event.deltaTime;
      });
      totalTicks = Math.max(totalTicks, trackTicks);
    });

    // Calculate duration using tempo map (handles multi-tempo files)
    let duration;
    if (dedupedTempoEvents.length <= 1) {
      const tempo = dedupedTempoEvents.length === 1
        ? 60000000 / dedupedTempoEvents[0].microsecondsPerBeat
        : 120;
      const beatsPerSecond = tempo / 60;
      const ticksPerSecond = beatsPerSecond * ppq;
      duration = totalTicks / ticksPerSecond;
    } else {
      let cumulativeSeconds = 0;
      let lastTick = 0;
      let currentMicrosPerBeat = dedupedTempoEvents[0].microsecondsPerBeat;

      for (let i = 1; i < dedupedTempoEvents.length; i++) {
        const deltaTicks = dedupedTempoEvents[i].tick - lastTick;
        cumulativeSeconds += (deltaTicks * currentMicrosPerBeat) / (ppq * 1000000);
        lastTick = dedupedTempoEvents[i].tick;
        currentMicrosPerBeat = dedupedTempoEvents[i].microsecondsPerBeat;
      }
      const remainingTicks = totalTicks - lastTick;
      cumulativeSeconds += (remainingTicks * currentMicrosPerBeat) / (ppq * 1000000);
      duration = cumulativeSeconds;
    }

    return {
      tempo: isFinite(firstTempo) ? firstTempo : 120,
      duration: isFinite(duration) ? duration : 0,
      totalTicks: totalTicks
    };
  }

  /**
   * Extract instrument metadata for filtering.
   * Analyzes MIDI channels to determine instrument types, note ranges, etc.
   * @param {Object} midi - Parsed MIDI file
   * @returns {{ fileMetadata: Object, channelDetails: Array }}
   */
  extractInstrumentMetadata(midi) {
    try {
      // Convert to format expected by ChannelAnalyzer
      const midiData = this.convertMidiToJSON(midi);

      // Analyze all channels
      const channelAnalyses = this.channelAnalyzer.analyzeAllChannels(midiData);

      // Extract instrument types (both broad categories and GM categories)
      const instrumentTypes = new Set();
      const channelDetails = [];
      let hasDrums = false;
      let hasMelody = false;
      let hasBass = false;
      let noteMin = 127;
      let noteMax = 0;

      for (const analysis of channelAnalyses) {
        if (analysis.estimatedType) {
          const typeMapping = {
            'drums': 'Drums',
            'percussive': 'Percussion',
            'bass': 'Bass',
            'melody': 'Melody',
            'harmony': 'Harmony'
          };

          const friendlyType = typeMapping[analysis.estimatedType] || analysis.estimatedType;
          instrumentTypes.add(friendlyType);

          if (analysis.estimatedType === 'drums') hasDrums = true;
          if (analysis.estimatedType === 'melody') hasMelody = true;
          if (analysis.estimatedType === 'bass') hasBass = true;
        }

        // Resolve GM instrument name and category from primary program
        let gmInstrumentName = null;
        let gmCategory = null;

        if (analysis.channel === 9) {
          gmInstrumentName = 'Drums';
          gmCategory = 'Percussive';
          instrumentTypes.add('Drums');
          instrumentTypes.add('Percussive');
        } else {
          const program = (analysis.primaryProgram !== null && analysis.primaryProgram !== undefined)
            ? analysis.primaryProgram
            : 0;
          gmInstrumentName = MidiUtils.getGMInstrumentName(program);
          gmCategory = MidiUtils.getGMCategory(program);
          if (gmCategory) {
            instrumentTypes.add(gmCategory);
          }
        }

        const resolvedProgram = (analysis.channel === 9)
          ? analysis.primaryProgram
          : (analysis.primaryProgram !== null && analysis.primaryProgram !== undefined)
            ? analysis.primaryProgram
            : 0;

        channelDetails.push({
          channel: analysis.channel,
          primaryProgram: resolvedProgram,
          gmInstrumentName,
          gmCategory,
          estimatedType: analysis.estimatedType,
          typeConfidence: analysis.typeConfidence || 0,
          noteRangeMin: analysis.noteRange ? analysis.noteRange.min : null,
          noteRangeMax: analysis.noteRange ? analysis.noteRange.max : null,
          totalNotes: analysis.totalNotes || 0,
          polyphonyMax: analysis.polyphony ? analysis.polyphony.max : 0,
          polyphonyAvg: analysis.polyphony ? analysis.polyphony.avg : 0,
          density: analysis.density || 0,
          trackNames: analysis.trackNames || []
        });

        if (analysis.noteRange && analysis.noteRange.min !== null && analysis.noteRange.max !== null) {
          noteMin = Math.min(noteMin, analysis.noteRange.min);
          noteMax = Math.max(noteMax, analysis.noteRange.max);
        }
      }

      return {
        fileMetadata: {
          instrument_types: JSON.stringify(Array.from(instrumentTypes)),
          channel_count: channelAnalyses.length,
          note_range_min: noteMin < 127 ? noteMin : null,
          note_range_max: noteMax > 0 ? noteMax : null,
          has_drums: hasDrums ? 1 : 0,
          has_melody: hasMelody ? 1 : 0,
          has_bass: hasBass ? 1 : 0
        },
        channelDetails
      };
    } catch (error) {
      this.logger.error(`Failed to extract instrument metadata: ${error.message}`, error.stack);

      return {
        fileMetadata: {
          instrument_types: '[]',
          channel_count: 0,
          note_range_min: null,
          note_range_max: null,
          has_drums: 0,
          has_melody: 0,
          has_bass: 0
        },
        channelDetails: []
      };
    }
  }

  /**
   * Convert a parsed MIDI object to a clean JSON representation.
   * @param {Object} midi - Parsed MIDI object
   * @returns {Object} JSON-friendly MIDI representation
   */
  convertMidiToJSON(midi) {
    // Log channel statistics for debugging
    const channelCounts = new Map();
    midi.tracks.forEach((track, _trackIdx) => {
      track.forEach(event => {
        if (event.channel !== undefined) {
          channelCounts.set(event.channel, (channelCounts.get(event.channel) || 0) + 1);
        }
      });
    });

    if (channelCounts.size > 0) {
      this.logger.info(`MIDI channels detected during parsing: [${Array.from(channelCounts.keys()).sort((a,b) => a-b).join(', ')}]`);
    } else {
      this.logger.warn('No MIDI channels detected during parsing! This may indicate a problem.');
    }

    return {
      header: {
        format: midi.header.format,
        numTracks: midi.header.numTracks,
        ticksPerBeat: midi.header.ticksPerBeat
      },
      tracks: midi.tracks.map((track, index) => {
        return {
          index: index,
          name: this.extractTrackName(track),
          events: track.map(event => {
            const cleanEvent = {
              deltaTime: event.deltaTime || 0,
              type: event.type
            };

            for (const key in event) {
              if (key !== 'deltaTime' && key !== 'type') {
                cleanEvent[key] = event[key];
              }
            }

            return cleanEvent;
          })
        };
      })
    };
  }

  /**
   * Extract track name from a track's events.
   * @param {Array} track - Array of MIDI events
   * @returns {string} Track name or 'Unnamed Track'
   */
  extractTrackName(track) {
    const nameEvent = track.find(e => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }
}

export default MidiFileParser;
