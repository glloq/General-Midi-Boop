// ============================================================================
// File: public/js/features/midi-editor/MidiEditorMidiWriter.js
// Description: Serialize the in-memory sequence + meta-events into a raw
//   .mid binary blob — extracted from MidiEditorFileOps per audit §1.3
//   (god-class split).
//
// One method: `convertSequenceToMidi()` — variable-length quantity
// encoding, per-track delta-time computation, meta-event headers
// (time signature, key signature, tempo, end-of-track), note-on /
// note-off pairs, CC and pitch-bend events. Returns a `Uint8Array`
// ready to download or hand off to the WS save endpoint.
//
// Accessed via `modal.fileOps.midiWriter`. MidiEditorFileOps keeps a
// thin `convertSequenceToMidi()` delegate so internal callers
// (saveMidiFile, saveAsFile) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorMidiWriter {
    /** @param {MidiEditorFileOps} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    convertSequenceToMidi() {
      // Use fullSequence which holds every up-to-date note
      const fullSequenceToSave = this.modal.fullSequence;

      if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
        this.modal.log('warn', 'No sequence to convert');
        return null;
      }

      const ticksPerBeat = this.modal.midiData?.header?.ticksPerBeat || 480;

      this.modal.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

      // Clamp MIDI values to their valid ranges and count any corrections for the log.
      // The MIDI standard enforces 7-bit values (0-127) for note/velocity/CC,
      // 4-bit (0-15) for channel, and 14-bit signed (-8192..8191) for pitch bend.
      const clampStats = { note: 0, channel: 0, velocity: 0, cc: 0, pitchBend: 0, ticks: 0 };
      const clamp = (value, min, max, kind) => {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          clampStats[kind]++;
          return min;
        }
        if (n < min) {
          clampStats[kind]++;
          return min;
        }
        if (n > max) {
          clampStats[kind]++;
          return max;
        }
        // Round to an integer: every clamped field (note/channel/velocity/cc/
        // pitchbend/ticks/gate) must be integral or VLQ/byte encoding produces an
        // invalid .mid — and the server now rejects non-integer events outright,
        // so a fractional value would otherwise fail the save (audit D MN1).
        return Math.round(n);
      };

      // Convert the sequence into MIDI events
      const events = [];

      // Add tempo events (full tempo map or global tempo)
      if (this.modal.tempoEvents && this.modal.tempoEvents.length > 0) {
        this.modal.tempoEvents.forEach((tempoEvent) => {
          // Preserve the exact source µs/beat for an untouched tempo (its stored
          // value still round-trips to the same integer BPM); only recompute
          // from BPM when the tempo was actually edited. Without this, a file
          // authored at e.g. 100.5 BPM drifts to 100.0 on every save, even when
          // the user edited an unrelated channel (audit D MD1).
          const srcUs = tempoEvent.microsecondsPerBeat;
          const usPerBeat =
            Number.isFinite(srcUs) && srcUs > 0 && Math.round(60000000 / srcUs) === tempoEvent.tempo
              ? Math.round(srcUs)
              : Math.round(60000000 / tempoEvent.tempo);
          events.push({
            absoluteTime: tempoEvent.ticks,
            type: 'setTempo',
            microsecondsPerBeat: usPerBeat
          });
        });
        this.modal.log(
          'debug',
          `Added ${this.modal.tempoEvents.length} tempo events from tempo map`
        );
      } else {
        // Fallback: tempo global unique
        const tempo = this.modal.tempo || 120;
        const microsecondsPerBeat = Math.round(60000000 / tempo);
        events.push({
          absoluteTime: 0,
          type: 'setTempo',
          microsecondsPerBeat: microsecondsPerBeat
        });
        this.modal.log(
          'debug',
          `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} μs/beat)`
        );
      }

      // Determine which channels are in use and their programs
      const usedChannels = new Map(); // canal -> program
      fullSequenceToSave.forEach((note) => {
        const channel = note.c !== undefined ? note.c : 0;
        if (!usedChannels.has(channel)) {
          // Trouver l'instrument pour ce canal
          const channelInfo = this.modal.channels.find((ch) => ch.channel === channel);
          const program = channelInfo ? channelInfo.program : this.modal.selectedInstrument || 0;
          usedChannels.set(channel, program);
        }
      });

      // Add programChange events at tick 0 for each channel
      usedChannels.forEach((program, channel) => {
        if (channel !== 9) {
          // Canal 10 (index 9) est pour drums, pas de programChange
          events.push({
            absoluteTime: 0,
            type: 'programChange',
            channel: channel,
            programNumber: program
          });
          this.modal.log(
            'debug',
            `Added programChange for channel ${channel}: ${this.modal.getInstrumentName(program)}`
          );
        }
      });

      // Add note events
      fullSequenceToSave.forEach((note) => {
        const tick = clamp(note.t, 0, Number.MAX_SAFE_INTEGER, 'ticks');
        const noteNumber = clamp(note.n, 0, 127, 'note');
        const gate = Math.max(1, clamp(note.g, 1, Number.MAX_SAFE_INTEGER, 'ticks'));
        const channel = clamp(note.c !== undefined ? note.c : 0, 0, 15, 'channel');
        const velocity = clamp(note.v || 100, 1, 127, 'velocity');

        // Note On
        events.push({
          absoluteTime: tick,
          type: 'noteOn',
          channel: channel,
          noteNumber: noteNumber,
          velocity: velocity
        });

        // Note Off
        events.push({
          absoluteTime: tick + gate,
          type: 'noteOff',
          channel: channel,
          noteNumber: noteNumber,
          velocity: 0
        });
      });

      // Add CC and pitch-bend events
      if (this.modal.ccEvents && this.modal.ccEvents.length > 0) {
        this.modal.log(
          'info',
          `Adding ${this.modal.ccEvents.length} CC/pitchbend events to MIDI file`
        );

        let ccCount = 0,
          pbCount = 0,
          atCount = 0;
        this.modal.ccEvents.forEach((ccEvent) => {
          const ccTick = clamp(
            ccEvent.ticks ?? ccEvent.tick ?? 0,
            0,
            Number.MAX_SAFE_INTEGER,
            'ticks'
          );
          const ccChannel = clamp(ccEvent.channel, 0, 15, 'channel');
          // Translate the editor type (cc1, cc2, cc5, cc7, cc10, cc11, cc74) into a controller number
          if (ccEvent.type.startsWith('cc')) {
            // Extract the numeric type (cc1 -> 1, cc7 -> 7, etc.)
            const controllerNumber = parseInt(ccEvent.type.replace('cc', ''));
            events.push({
              absoluteTime: ccTick,
              type: 'controller',
              channel: ccChannel,
              controllerType: controllerNumber,
              value: clamp(ccEvent.value, 0, 127, 'cc')
            });
            ccCount++;
          } else if (ccEvent.type === 'pitchbend') {
            events.push({
              absoluteTime: ccTick,
              type: 'pitchBend',
              channel: ccChannel,
              value: clamp(ccEvent.value, -8192, 8191, 'pitchBend')
            });
            pbCount++;
          } else if (ccEvent.type === 'aftertouch') {
            events.push({
              absoluteTime: ccTick,
              type: 'channelAftertouch',
              channel: ccChannel,
              amount: clamp(ccEvent.value, 0, 127, 'cc')
            });
            atCount++;
          } else if (ccEvent.type === 'polyAftertouch') {
            // The midi-file writer's type is 'noteAftertouch' with fields
            // {noteNumber, amount}. Emitting 'polyAftertouch'/'pressure' made
            // writeMidi throw ("Unrecognized event type"), so ANY file that used
            // poly key-pressure was permanently un-saveable through the editor —
            // even with no edits (audit D C1).
            events.push({
              absoluteTime: ccTick,
              type: 'noteAftertouch',
              channel: ccChannel,
              noteNumber: clamp(ccEvent.note ?? ccEvent.noteNumber ?? 0, 0, 127, 'note'),
              amount: clamp(ccEvent.value, 0, 127, 'cc')
            });
            atCount++;
          }
        });

        this.modal.log(
          'info',
          `Converted to MIDI: ${ccCount} CC, ${pbCount} pitchbend, ${atCount} aftertouch events`
        );
      } else {
        this.modal.log('warn', 'No CC/Pitchbend events to save');
      }

      // Trier par temps absolu
      events.sort((a, b) => a.absoluteTime - b.absoluteTime);

      // Convertir temps absolu en deltaTime
      let lastTime = 0;
      const trackEvents = events.map((event) => {
        const deltaTime = event.absoluteTime - lastTime;
        lastTime = event.absoluteTime;

        const trackEvent = {
          deltaTime: deltaTime,
          type: event.type,
          channel: event.channel
        };

        // Add event-type-specific fields
        if (event.type === 'programChange') {
          trackEvent.programNumber = event.programNumber;
        } else if (event.type === 'noteOn' || event.type === 'noteOff') {
          trackEvent.noteNumber = event.noteNumber;
          trackEvent.velocity = event.velocity;
        } else if (event.type === 'controller') {
          trackEvent.controllerType = event.controllerType;
          trackEvent.value = event.value;
        } else if (event.type === 'pitchBend') {
          trackEvent.value = event.value;
        } else if (event.type === 'channelAftertouch') {
          // Must forward `amount`; without it writeMidi writes undefined→0, so
          // every channel-pressure value was silently zeroed on save (audit D M1).
          trackEvent.amount = event.amount;
        } else if (event.type === 'noteAftertouch') {
          trackEvent.noteNumber = event.noteNumber;
          trackEvent.amount = event.amount;
        } else if (event.type === 'setTempo') {
          trackEvent.microsecondsPerBeat = event.microsecondsPerBeat;
          // setTempo events have no channel
          delete trackEvent.channel;
        }

        return trackEvent;
      });

      // Ajouter End of Track
      trackEvents.push({
        deltaTime: 0,
        type: 'endOfTrack'
      });

      // Structure MIDI compatible avec midi-file
      // Report any clamped values so data corruption shows up in the log instead of silently
      const totalClamped = Object.values(clampStats).reduce((a, b) => a + b, 0);
      if (totalClamped > 0) {
        this.modal.log(
          'warn',
          `Clamped ${totalClamped} out-of-range MIDI values: ${JSON.stringify(clampStats)}`
        );
      }

      return {
        header: {
          format: this.modal.midiData?.header?.format || 1,
          numTracks: 1,
          ticksPerBeat: ticksPerBeat
        },
        tracks: [trackEvents]
      };
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorMidiWriter = MidiEditorMidiWriter;
  }
})();
