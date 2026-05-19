/**
 * @file src/files/JsonMidiConverter.js
 * @description Bidirectional MIDI ↔ JSON converter built on
 * `midi-file`. Used by the editor (raw bytes → editor JSON; editor
 * JSON → bytes) and by the analysis commands (parse stored BLOB → JSON
 * before scoring / auto-assignment).
 *
 * Stateless — safe to share across requests via the
 * {@link getMidiConverter} cache.
 */
import { parseMidi, writeMidi } from 'midi-file';

class JsonMidiConverter {
  /** @param {Object} logger */
  constructor(logger) {
    this.logger = logger;
  }

  /** Convert MIDI binary buffer to JSON object. */
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
          index,
          name: this.extractTrackName(track),
          events: track.map((event) => this.eventToJson(event))
        }))
      };
    } catch (error) {
      this.logger.error(`MIDI to JSON conversion failed: ${error.message}`);
      throw error;
    }
  }

  /** Convert JSON object to MIDI binary buffer. */
  jsonToMidi(json) {
    try {
      const midi = {
        header: {
          format: json.header.format || 1,
          numTracks: json.header.numTracks || json.tracks.length,
          ticksPerBeat: json.header.ticksPerBeat || 480
        },
        tracks: json.tracks.map((track) => track.events.map((event) => ({ ...event })))
      };
      return Buffer.from(writeMidi(midi));
    } catch (error) {
      this.logger.error(`JSON to MIDI conversion failed: ${error.message}`);
      throw error;
    }
  }

  /** Convert a MIDI event to a plain JSON object. */
  eventToJson(event) {
    const json = {
      deltaTime: event.deltaTime,
      type: event.type
    };
    for (const key in event) {
      if (key !== 'deltaTime' && key !== 'type') {
        json[key] = event[key];
      }
    }
    return json;
  }

  /** Extract a track's name, or 'Unnamed Track'. */
  extractTrackName(track) {
    const nameEvent = track.find((e) => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }
}

export default JsonMidiConverter;
