// src/storage/JsonMidiConverter.js
import { parseMidi, writeMidi } from 'midi-file';

class JsonMidiConverter {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Convert MIDI binary buffer to JSON object
   */
  midiToJson(buffer) {
    try {
      const midi = parseMidi(buffer);
      
      return {
        header: {
          format: midi.header.format,
          numTracks: midi.header.numTracks,
          ticksPerBeat: midi.header.ticksPerBeat
        },
        tracks: midi.tracks.map((track, index) => ({
          index: index,
          name: this.extractTrackName(track),
          events: track.map(event => this.eventToJson(event))
        }))
      };
    } catch (error) {
      this.logger.error(`MIDI to JSON conversion failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert JSON object to MIDI binary buffer
   */
  jsonToMidi(json) {
    try {
      const midi = {
        header: {
          format: json.header.format || 1,
          numTracks: json.header.numTracks || json.tracks.length,
          ticksPerBeat: json.header.ticksPerBeat || 480
        },
        tracks: json.tracks.map(track => 
          track.events.map(event => this.jsonToEvent(event))
        )
      };

      const buffer = writeMidi(midi);
      return Buffer.from(buffer);
    } catch (error) {
      this.logger.error(`JSON to MIDI conversion failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert base64 MIDI to JSON
   */
  base64ToJson(base64String) {
    try {
      const buffer = Buffer.from(base64String, 'base64');
      return this.midiToJson(buffer);
    } catch (error) {
      this.logger.error(`Base64 to JSON conversion failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert JSON to base64 MIDI
   */
  jsonToBase64(json) {
    try {
      const buffer = this.jsonToMidi(json);
      return buffer.toString('base64');
    } catch (error) {
      this.logger.error(`JSON to Base64 conversion failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert MIDI event to JSON object
   */
  eventToJson(event) {
    const json = {
      deltaTime: event.deltaTime,
      type: event.type
    };

    // Copy all event properties
    for (const key in event) {
      if (key !== 'deltaTime' && key !== 'type') {
        json[key] = event[key];
      }
    }

    return json;
  }

  /**
   * Convert JSON object to MIDI event
   */
  jsonToEvent(json) {
    return { ...json };
  }

  /**
   * Extract track name from events
   */
  extractTrackName(track) {
    const nameEvent = track.find(e => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }

  /**
   * Get MIDI metadata
   */
  getMidiMetadata(buffer) {
    try {
      const midi = parseMidi(buffer);
      
      let tempo = 120;
      let timeSignature = { numerator: 4, denominator: 4 };
      let keySignature = { key: 0, scale: 0 };
      
      // Extract from first track
      if (midi.tracks.length > 0) {
        for (const event of midi.tracks[0]) {
          if (event.type === 'setTempo') {
            tempo = 60000000 / event.microsecondsPerBeat;
          } else if (event.type === 'timeSignature') {
            timeSignature = {
              numerator: event.numerator,
              denominator: event.denominator,
              metronome: event.metronome,
              thirtyseconds: event.thirtyseconds
            };
          } else if (event.type === 'keySignature') {
            keySignature = {
              key: event.key,
              scale: event.scale
            };
          }
        }
      }

      return {
        format: midi.header.format,
        numTracks: midi.header.numTracks,
        ticksPerBeat: midi.header.ticksPerBeat,
        tempo: tempo,
        timeSignature: timeSignature,
        keySignature: keySignature
      };
    } catch (error) {
      this.logger.error(`Get MIDI metadata failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Calculate MIDI duration in seconds
   */
  calculateDuration(buffer) {
    try {
      const midi = parseMidi(buffer);
      const ppq = midi.header.ticksPerBeat || 480;

      // Collect all tempo events with absolute tick positions
      const tempoEvents = [];
      for (const track of midi.tracks) {
        let trackTicks = 0;
        for (const event of track) {
          trackTicks += event.deltaTime;
          if (event.type === 'setTempo') {
            tempoEvents.push({
              tick: trackTicks,
              microsecondsPerBeat: event.microsecondsPerBeat
            });
          }
        }
      }
      tempoEvents.sort((a, b) => a.tick - b.tick);

      // Calculate total ticks across all tracks
      let maxTicks = 0;
      midi.tracks.forEach(track => {
        let trackTicks = 0;
        track.forEach(event => {
          trackTicks += event.deltaTime;
        });
        maxTicks = Math.max(maxTicks, trackTicks);
      });

      if (tempoEvents.length <= 1) {
        // Single tempo: simple calculation
        const tempo = tempoEvents.length === 1
          ? 60000000 / tempoEvents[0].microsecondsPerBeat
          : 120;
        const beatsPerSecond = tempo / 60;
        const ticksPerSecond = beatsPerSecond * ppq;
        return maxTicks / ticksPerSecond;
      }

      // Multi-tempo: walk through tempo changes
      let cumulativeSeconds = 0;
      let lastTick = 0;
      let currentMicrosPerBeat = tempoEvents[0].microsecondsPerBeat;

      for (let i = 1; i < tempoEvents.length; i++) {
        const deltaTicks = tempoEvents[i].tick - lastTick;
        cumulativeSeconds += (deltaTicks * currentMicrosPerBeat) / (ppq * 1000000);
        lastTick = tempoEvents[i].tick;
        currentMicrosPerBeat = tempoEvents[i].microsecondsPerBeat;
      }
      // Add remaining ticks after last tempo change
      const remainingTicks = maxTicks - lastTick;
      cumulativeSeconds += (remainingTicks * currentMicrosPerBeat) / (ppq * 1000000);

      return cumulativeSeconds;
    } catch (error) {
      this.logger.error(`Calculate duration failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validate MIDI buffer
   */
  validateMidi(buffer) {
    try {
      parseMidi(buffer);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Extract note events from MIDI
   */
  extractNotes(buffer) {
    try {
      const midi = parseMidi(buffer);
      const notes = [];

      midi.tracks.forEach((track, trackIndex) => {
        let absoluteTime = 0;
        
        track.forEach(event => {
          absoluteTime += event.deltaTime;
          
          if (event.type === 'noteOn' && event.velocity > 0) {
            notes.push({
              track: trackIndex,
              time: absoluteTime,
              note: event.noteNumber,
              velocity: event.velocity,
              channel: event.channel
            });
          }
        });
      });

      return notes;
    } catch (error) {
      this.logger.error(`Extract notes failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get track statistics
   */
  getTrackStats(buffer) {
    try {
      const midi = parseMidi(buffer);
      
      return midi.tracks.map((track, index) => {
        const stats = {
          index: index,
          name: this.extractTrackName(track),
          events: track.length,
          noteOns: 0,
          noteOffs: 0,
          controlChanges: 0,
          programChanges: 0
        };

        track.forEach(event => {
          if (event.type === 'noteOn') stats.noteOns++;
          else if (event.type === 'noteOff') stats.noteOffs++;
          else if (event.type === 'controller') stats.controlChanges++;
          else if (event.type === 'programChange') stats.programChanges++;
        });

        return stats;
      });
    } catch (error) {
      this.logger.error(`Get track stats failed: ${error.message}`);
      throw error;
    }
  }
}

export default JsonMidiConverter;