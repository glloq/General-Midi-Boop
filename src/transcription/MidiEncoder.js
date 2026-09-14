/**
 * @file src/transcription/MidiEncoder.js
 * @description Turns a cleaned {@link TranscriptionResultShape} into a
 * Standard MIDI File (§14/§15/§16) — the last step before the bytes are
 * handed to `FileManager.handleUpload()` like any other upload.
 *
 * Decisions worth knowing:
 *
 *  - **Only the channels that are needed.** Sixteen MIDI channels is a
 *    protocol limit, not a target: a piano transcription produces a
 *    one-channel file (§15).
 *  - **Channel 10 is percussion, and only percussion.** Melodic tracks skip
 *    it; a drum track always gets it.
 *  - **No invented tempo.** An engine that detected no tempo produces a file
 *    with no Set Tempo event; every player then applies the SMF default of
 *    120 BPM, which is honest, whereas writing `120` would claim a detection
 *    that never happened.
 *  - **No invented program.** `gmProgram: null` means no Program Change is
 *    written, and GMB's own auto-assignment decides what plays the track.
 *  - **Expression is opt-in and bounded.** Pitch bend and CC11 are only
 *    written from curves the engine actually produced, after simplification,
 *    and with an explicit RPN pitch-bend range so the numbers mean something.
 */
import { writeMidi } from 'midi-file';
import { EVENT_ORDER_PRIORITY, MIDI_CC } from '../core/constants.js';
import { GM_DRUM_CHANNEL, mapDrumNote } from './gm/DrumMapper.js';
import { resolveInstrumentClass, isDrumLabel } from './gm/InstrumentClassMap.js';
import { TranscriptionError, TRANSCRIPTION_REASONS } from './TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** GMB's own default resolution — matches what FileManager stores for uploads. */
export const DEFAULT_PPQ = 480;

/** Melodic channels, in allocation order. 9 (channel 10) is reserved. */
export const MELODIC_CHANNELS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);

/** Microseconds per minute, for the Set Tempo conversion. */
const MICROSECONDS_PER_MINUTE = 60_000_000;

/** Bound the output: a runaway curve must not produce a 100 MB file. */
export const ENCODER_LIMITS = Object.freeze({
  MAX_EVENTS: 400000,
  MAX_BEND_POINTS_PER_NOTE: 64,
  MAX_EXPRESSION_POINTS_PER_NOTE: 32
});

/**
 * Converts seconds to ticks across a tempo map. Integrates piecewise, so a
 * file with tempo changes keeps its timing instead of drifting.
 */
export class TempoTimeline {
  /**
   * @param {Array<{time:number,bpm:number}>} tempoMap - Times in seconds.
   * @param {number} ppq
   */
  constructor(tempoMap, ppq) {
    this.ppq = ppq;
    const entries = Array.isArray(tempoMap) ? [...tempoMap].sort((a, b) => a.time - b.time) : [];
    // The SMF default applies until the first detected tempo.
    this.segments = [];
    let previousTime = 0;
    let previousTicks = 0;
    let bpm = entries.length > 0 && entries[0].time <= 0 ? entries[0].bpm : 120;

    for (const entry of entries) {
      if (entry.time <= previousTime) {
        bpm = entry.bpm;
        continue;
      }
      this.segments.push({ startTime: previousTime, startTicks: previousTicks, bpm });
      previousTicks += ((entry.time - previousTime) * bpm * ppq) / 60;
      previousTime = entry.time;
      bpm = entry.bpm;
    }
    this.segments.push({ startTime: previousTime, startTicks: previousTicks, bpm });
  }

  /**
   * @param {number} seconds
   * @returns {number} Absolute tick, rounded.
   */
  toTicks(seconds) {
    const time = seconds > 0 ? seconds : 0;
    let segment = this.segments[0];
    for (const candidate of this.segments) {
      if (candidate.startTime <= time) segment = candidate;
      else break;
    }
    return Math.round(
      segment.startTicks + ((time - segment.startTime) * segment.bpm * this.ppq) / 60
    );
  }
}

/** Encodes a transcription result as a Standard MIDI File. */
export class MidiEncoder {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger]
   */
  constructor(deps = {}) {
    this.logger = deps.logger || NULL_LOGGER;
  }

  /**
   * @param {Object} result - Normalised (ideally post-processed) result.
   * @param {Object} [options]
   * @param {number} [options.ppq=480]
   * @param {boolean} [options.emitPitchBend=true] - Honoured only for tracks
   *   whose notes carry a pitch curve.
   * @param {boolean} [options.emitExpression=true] - CC11 from amplitude.
   * @param {number} [options.pitchBendRange=2] - Semitones; written as RPN 0
   *   so a receiver interprets the bends the same way we did.
   * @param {?string} [options.trackNamePrefix]
   * @returns {{buffer: Buffer, stats: Object, channelMap: Object[]}}
   * @throws {TranscriptionError} `MIDI_GENERATION_FAILED`.
   */
  encode(result, options = {}) {
    const {
      ppq = DEFAULT_PPQ,
      emitPitchBend = true,
      emitExpression = true,
      pitchBendRange = 2
    } = options;

    const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
    if (tracks.length === 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.MIDI_GENERATION_FAILED,
        'Nothing was detected in this audio — no MIDI file to create',
        {}
      );
    }

    const timeline = new TempoTimeline(result.tempoMap, ppq);
    const stats = {
      tracks: 0,
      notes: 0,
      pitchBendEvents: 0,
      expressionEvents: 0,
      unmappedDrumNotes: 0,
      channelsUsed: 0,
      reusedChannels: 0
    };
    const channelMap = [];

    const midiTracks = [this._buildConductorTrack(result, timeline)];
    let melodicIndex = 0;

    for (const track of tracks) {
      const isDrums = track.instrument.isDrums || isDrumLabel(track.instrument.family);
      let channel;
      if (isDrums) {
        channel = GM_DRUM_CHANNEL;
      } else {
        channel = MELODIC_CHANNELS[melodicIndex % MELODIC_CHANNELS.length];
        // More instruments than channels: reuse rather than drop music, and
        // say so — the operator can split the file in the editor afterwards.
        if (melodicIndex >= MELODIC_CHANNELS.length) stats.reusedChannels++;
        melodicIndex++;
      }

      const program = isDrums ? null : resolveProgram(track);
      const built = this._buildTrack(track, {
        channel,
        program,
        isDrums,
        timeline,
        emitPitchBend,
        emitExpression,
        pitchBendRange,
        stats
      });

      midiTracks.push(built.events);
      channelMap.push({
        trackId: track.id,
        channel,
        program,
        isDrums,
        noteCount: built.noteCount,
        label: track.instrument.label || track.instrument.family || null
      });
      stats.tracks++;
      stats.notes += built.noteCount;
    }

    stats.channelsUsed = new Set(channelMap.map((c) => c.channel)).size;

    const totalEvents = midiTracks.reduce((sum, t) => sum + t.length, 0);
    if (totalEvents > ENCODER_LIMITS.MAX_EVENTS) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.MIDI_GENERATION_FAILED,
        `The transcription produced ${totalEvents} MIDI events, past the ${ENCODER_LIMITS.MAX_EVENTS} limit`,
        { events: totalEvents, limit: ENCODER_LIMITS.MAX_EVENTS }
      );
    }

    let buffer;
    try {
      buffer = Buffer.from(
        writeMidi({
          header: { format: 1, numTracks: midiTracks.length, ticksPerBeat: ppq },
          tracks: midiTracks
        })
      );
    } catch (error) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.MIDI_GENERATION_FAILED,
        `Could not write the MIDI file: ${error.message ?? error}`,
        {},
        { cause: error instanceof Error ? error : undefined }
      );
    }

    this.logger.info(
      `MidiEncoder: ${stats.tracks} tracks / ${stats.notes} notes → ${buffer.length} bytes ` +
        `(${stats.channelsUsed} channel(s), ${stats.pitchBendEvents} bends, ${stats.expressionEvents} CC11)`
    );

    return { buffer, stats, channelMap };
  }

  /**
   * Track 0: the conductor track — name and tempo changes only, per the
   * Format 1 convention GMB's parser expects.
   *
   * @param {Object} result
   * @param {TempoTimeline} timeline
   * @returns {Object[]}
   * @private
   */
  _buildConductorTrack(result, timeline) {
    const absolute = [];
    const name = result?.source?.filename
      ? `Transcription of ${result.source.filename}`
      : 'Transcription';
    absolute.push({ tick: 0, order: 2, event: { type: 'trackName', text: name } });

    for (const entry of result.tempoMap || []) {
      absolute.push({
        tick: timeline.toTicks(entry.time),
        order: EVENT_ORDER_PRIORITY.setTempo,
        event: {
          type: 'setTempo',
          microsecondsPerBeat: Math.round(MICROSECONDS_PER_MINUTE / entry.bpm)
        }
      });
    }

    for (const signature of result.timeSignatures || []) {
      absolute.push({
        tick: timeline.toTicks(signature.time),
        order: 1,
        event: {
          type: 'timeSignature',
          numerator: signature.numerator,
          denominator: signature.denominator,
          metronome: 24,
          thirtyseconds: 8
        }
      });
    }

    return toDeltaEvents(absolute);
  }

  /**
   * One instrument track: name, program, optional RPN, notes and expression.
   *
   * @param {Object} track
   * @param {Object} context
   * @returns {{events: Object[], noteCount: number}}
   * @private
   */
  _buildTrack(track, context) {
    const {
      channel,
      program,
      isDrums,
      timeline,
      emitPitchBend,
      emitExpression,
      pitchBendRange,
      stats
    } = context;
    const absolute = [];
    const label = track.instrument.label || track.instrument.family || track.id;
    absolute.push({ tick: 0, order: 2, event: { type: 'trackName', text: String(label) } });

    if (program !== null && program !== undefined) {
      absolute.push({
        tick: 0,
        order: EVENT_ORDER_PRIORITY.programChange,
        event: { type: 'programChange', channel, programNumber: program }
      });
    }

    const trackHasCurves = track.notes.some((n) => n.expression?.pitchCurve?.length > 0);
    const wantsBend = emitPitchBend && !isDrums && trackHasCurves;
    if (wantsBend) {
      // RPN 0 = pitch bend sensitivity. Without it, ±2 semitones is only a
      // convention and a receiver is free to use ±12.
      for (const event of rpnPitchBendRange(channel, pitchBendRange)) {
        absolute.push({ tick: 0, order: EVENT_ORDER_PRIORITY.controller, event });
      }
    }

    let noteCount = 0;
    for (const note of track.notes) {
      let noteNumber = note.pitch;
      if (isDrums) {
        const mapped = mapDrumNote(note, { trackLabel: label });
        if (mapped.note === null) {
          // An unmapped hit is dropped rather than played as an arbitrary
          // percussion sound — a wrong cymbal is worse than a missing one.
          stats.unmappedDrumNotes++;
          continue;
        }
        noteNumber = mapped.note;
      }

      const startTick = timeline.toTicks(note.start);
      let endTick = timeline.toTicks(note.end);
      if (endTick <= startTick) endTick = startTick + 1;

      absolute.push({
        tick: startTick,
        order: EVENT_ORDER_PRIORITY.noteOn,
        event: { type: 'noteOn', channel, noteNumber, velocity: note.velocity }
      });
      absolute.push({
        tick: endTick,
        order: EVENT_ORDER_PRIORITY.noteOff,
        event: { type: 'noteOff', channel, noteNumber, velocity: 0 }
      });
      noteCount++;

      if (wantsBend && note.expression?.pitchCurve?.length > 0) {
        const points = note.expression.pitchCurve.slice(0, ENCODER_LIMITS.MAX_BEND_POINTS_PER_NOTE);
        for (const point of points) {
          absolute.push({
            tick: timeline.toTicks(point.t),
            order: EVENT_ORDER_PRIORITY.pitchBend,
            event: {
              type: 'pitchBend',
              channel,
              value: semitonesToBend(point.value, pitchBendRange)
            }
          });
          stats.pitchBendEvents++;
        }
        // Leave the channel centred: a residual bend would detune every
        // later note on this channel.
        absolute.push({
          tick: endTick,
          order: EVENT_ORDER_PRIORITY.pitchBend,
          event: { type: 'pitchBend', channel, value: 0 }
        });
        stats.pitchBendEvents++;
      }

      if (emitExpression && note.expression?.amplitudeCurve?.length > 0) {
        const points = note.expression.amplitudeCurve.slice(
          0,
          ENCODER_LIMITS.MAX_EXPRESSION_POINTS_PER_NOTE
        );
        for (const point of points) {
          absolute.push({
            tick: timeline.toTicks(point.t),
            order: EVENT_ORDER_PRIORITY.controller,
            event: {
              type: 'controller',
              channel,
              controllerType: MIDI_CC.EXPRESSION,
              value: Math.max(0, Math.min(127, Math.round(point.value * 127)))
            }
          });
          stats.expressionEvents++;
        }
      }
    }

    return { events: toDeltaEvents(absolute), noteCount };
  }
}

/**
 * Resolve the GM program for a melodic track: the engine's own answer wins,
 * then the label table, then nothing (§15 — no invented precision).
 *
 * @param {Object} track
 * @returns {?number}
 */
export function resolveProgram(track) {
  if (track.instrument.gmProgram !== null && track.instrument.gmProgram !== undefined) {
    return track.instrument.gmProgram;
  }
  const resolved =
    resolveInstrumentClass(track.instrument.label) ||
    resolveInstrumentClass(track.instrument.family);
  return resolved ? resolved.program : null;
}

/**
 * The four controller events that set the pitch-bend range via RPN 0.
 * @param {number} channel
 * @param {number} semitones
 * @returns {Object[]}
 */
export function rpnPitchBendRange(channel, semitones) {
  const range = Math.max(1, Math.min(24, Math.round(semitones)));
  return [
    { type: 'controller', channel, controllerType: 101, value: 0 }, // RPN MSB
    { type: 'controller', channel, controllerType: 100, value: 0 }, // RPN LSB
    { type: 'controller', channel, controllerType: 6, value: range }, // Data MSB
    { type: 'controller', channel, controllerType: 38, value: 0 } // Data LSB
  ];
}

/**
 * Semitone offset → 14-bit pitch bend value, as `midi-file` wants it
 * (signed, -8192..8191, centre 0).
 *
 * @param {number} semitones
 * @param {number} range - Bend range in semitones.
 * @returns {number}
 */
export function semitonesToBend(semitones, range) {
  const clamped = Math.max(-range, Math.min(range, semitones));
  const value = Math.round((clamped / range) * 8191);
  return Math.max(-8192, Math.min(8191, value));
}

/**
 * Sort absolute-tick events and convert them to the delta-time list
 * `midi-file` writes. Ties are broken by the project's canonical event
 * priority (`EVENT_ORDER_PRIORITY`) so state changes land before the notes
 * that depend on them, and a Note Off precedes a Note On of the same pitch.
 *
 * @param {Array<{tick:number, order:number, event:Object}>} absolute
 * @returns {Object[]} Events with `deltaTime`, ending with `endOfTrack`.
 */
export function toDeltaEvents(absolute) {
  const sorted = [...absolute].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const events = [];
  let previousTick = 0;
  for (const entry of sorted) {
    events.push({ ...entry.event, deltaTime: entry.tick - previousTick });
    previousTick = entry.tick;
  }
  events.push({ type: 'endOfTrack', deltaTime: 0 });
  return events;
}

export default MidiEncoder;
