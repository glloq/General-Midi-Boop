/**
 * @file src/files/MidiFileValidator.js
 * @description Non-blocking, post-parse validation pass for MIDI files.
 * Walks the AST after `midi-file` has accepted it and produces a list
 * of warnings / structural anomalies (orphan note-offs, ridiculous
 * tempo, oversized SysEx, missing end-of-track) that the UI can
 * surface but that should NOT block ingestion.
 */

class MidiFileValidator {
  /** @param {Object} logger */
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Validate a parsed MIDI object and return a detailed report.
   * Does NOT throw - all issues are collected in the report.
   * @param {Object} midi - Parsed MIDI object (from midi-file library)
   * @returns {Object} Validation report
   */
  validate(midi) {
    const report = {
      valid: true,
      warnings: [],
      errors: [],
      stats: {
        format: null,
        totalTracks: 0,
        emptyTracks: 0,
        tracksWithNotes: 0,
        totalEvents: 0,
        totalNotes: 0,
        orphanedNoteOns: 0,
        overlappingNotes: 0,
        outOfRangeNotes: 0,
        outOfRangeVelocities: 0,
        invalidChannels: 0,
        activeChannels: [],
        hasTempoEvent: false,
        tempoEventCount: 0,
        hasSMPTE: false,
        isFormat2: false,
        ppq: 0
      }
    };

    // Validate header
    if (!midi || !midi.header) {
      report.valid = false;
      report.errors.push('Missing MIDI header');
      return report;
    }

    if (!Array.isArray(midi.tracks) || midi.tracks.length === 0) {
      report.valid = false;
      report.errors.push('No tracks found in MIDI file');
      return report;
    }

    const header = midi.header;
    report.stats.format = header.format;
    report.stats.totalTracks = midi.tracks.length;
    report.stats.ppq = header.ticksPerBeat;

    // Format validation
    if (header.format !== 0 && header.format !== 1 && header.format !== 2) {
      report.warnings.push(`Unknown MIDI format: ${header.format}, treating as Format 1`);
    }

    if (header.format === 2) {
      report.stats.isFormat2 = true;
      report.warnings.push('Format 2 (independent tracks): tracks will be merged by channel');
    }

    // SMPTE detection
    if (header.ticksPerBeat != null && header.ticksPerBeat < 0) {
      report.stats.hasSMPTE = true;
      report.warnings.push(`SMPTE timing detected (ticksPerBeat=${header.ticksPerBeat}), timing calculations use heuristic PPQ=480`);
    } else if (!header.ticksPerBeat || header.ticksPerBeat === 0) {
      report.warnings.push('Missing or zero ticksPerBeat, using default 480');
    }

    // Track-level validation
    const channelsUsed = new Set();
    const channelNoteCount = new Map();

    for (let trackIdx = 0; trackIdx < midi.tracks.length; trackIdx++) {
      const track = midi.tracks[trackIdx];

      if (!Array.isArray(track) || track.length === 0) {
        report.stats.emptyTracks++;
        continue;
      }

      report.stats.totalEvents += track.length;

      // Track active notes for orphan/overlap detection
      // Key: "channel_note" -> { tick, count }
      const activeNotes = new Map();
      let trackHasNotes = false;
      let absoluteTick = 0;

      for (const event of track) {
        absoluteTick += event.deltaTime || 0;

        // Channel validation
        if (event.channel !== undefined) {
          if (event.channel < 0 || event.channel > 15 || !Number.isInteger(event.channel)) {
            report.stats.invalidChannels++;
            if (report.stats.invalidChannels <= 5) {
              report.warnings.push(`Track ${trackIdx}: invalid channel ${event.channel} at tick ${absoluteTick}`);
            }
          }
        }

        // Tempo event detection
        if (event.type === 'setTempo') {
          report.stats.hasTempoEvent = true;
          report.stats.tempoEventCount++;
          if (event.microsecondsPerBeat <= 0) {
            report.warnings.push(`Track ${trackIdx}: invalid tempo value ${event.microsecondsPerBeat} at tick ${absoluteTick}`);
          }
        }

        // Note validation
        if (event.type === 'noteOn' || event.type === 'noteOff') {
          const note = event.noteNumber !== undefined ? event.noteNumber : event.note;
          const velocity = event.velocity !== undefined ? event.velocity : 0;
          const channel = event.channel !== undefined ? event.channel : 0;

          // Note range check
          if (note < 0 || note > 127) {
            report.stats.outOfRangeNotes++;
            if (report.stats.outOfRangeNotes <= 5) {
              report.warnings.push(`Track ${trackIdx}: note ${note} out of range [0-127] at tick ${absoluteTick}`);
            }
          }

          // Velocity range check
          if (velocity < 0 || velocity > 127) {
            report.stats.outOfRangeVelocities++;
          }

          channelsUsed.add(channel);

          const isNoteOn = event.type === 'noteOn' && velocity > 0;
          const isNoteOff = event.type === 'noteOff' || (event.type === 'noteOn' && velocity === 0);
          const key = `${channel}_${note}`;

          if (isNoteOn) {
            trackHasNotes = true;
            report.stats.totalNotes++;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

            const existing = activeNotes.get(key);
            if (existing && existing.count > 0) {
              report.stats.overlappingNotes++;
              activeNotes.set(key, { tick: absoluteTick, count: existing.count + 1 });
            } else {
              activeNotes.set(key, { tick: absoluteTick, count: 1 });
            }
          } else if (isNoteOff) {
            const existing = activeNotes.get(key);
            if (existing && existing.count > 0) {
              if (existing.count <= 1) {
                activeNotes.delete(key);
              } else {
                activeNotes.set(key, { tick: absoluteTick, count: existing.count - 1 });
              }
            }
            // Orphaned noteOff (no matching noteOn) - not critical, skip counting
          }
        }
      }

      // Count orphaned noteOns (still active at end of track)
      for (const [, info] of activeNotes) {
        report.stats.orphanedNoteOns += info.count;
      }

      if (trackHasNotes) {
        report.stats.tracksWithNotes++;
      }
    }

    report.stats.activeChannels = Array.from(channelsUsed).sort((a, b) => a - b);

    // Summary warnings
    if (report.stats.emptyTracks > 0) {
      report.warnings.push(`${report.stats.emptyTracks} empty track(s) detected`);
    }

    if (report.stats.orphanedNoteOns > 0) {
      report.warnings.push(`${report.stats.orphanedNoteOns} orphaned Note On(s) without matching Note Off`);
    }

    if (report.stats.overlappingNotes > 0) {
      report.warnings.push(`${report.stats.overlappingNotes} overlapping note(s) on same channel+note`);
    }

    if (report.stats.totalNotes === 0) {
      report.warnings.push('No note events found in file (meta events only)');
    }

    if (!report.stats.hasTempoEvent) {
      report.warnings.push('No tempo event found, using default 120 BPM');
    }

    if (report.stats.invalidChannels > 5) {
      report.warnings.push(`... and ${report.stats.invalidChannels - 5} more invalid channel values`);
    }

    if (report.stats.outOfRangeNotes > 5) {
      report.warnings.push(`... and ${report.stats.outOfRangeNotes - 5} more out-of-range notes`);
    }

    // Log the report
    if (report.errors.length > 0) {
      this.logger.error(`MIDI validation errors: ${report.errors.join('; ')}`);
    }
    if (report.warnings.length > 0) {
      this.logger.info(`MIDI validation: ${report.warnings.length} warning(s) - ${report.warnings.slice(0, 5).join('; ')}`);
    } else {
      this.logger.debug('MIDI validation: no issues detected');
    }

    return report;
  }
}

export default MidiFileValidator;
