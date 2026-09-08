/**
 * @file src/midi/messages/SilenceSequence.js
 * @description **Single source of truth for every "make it stop" burst** the
 * product emits — the operator panic button, the gentler all-notes-off, the
 * silence sent to a port that is about to be closed, and the one sent to a
 * device that just came back from a hot-unplug.
 *
 * Why one module instead of a helper per call site (audit L03 §3, L04 §G04):
 * the transport-parity matrix found five places where the *same* musical
 * intent produced different bytes depending on which transport it went
 * through. A panic that differs between USB and BLE is a panic you cannot
 * trust on stage. Every caller therefore builds its burst here, and the four
 * transports encode the resulting `('cc', {channel, controller, value})`
 * tuples through their existing shared encoders (`MidiUtils.convertToMidiBytes`
 * for BLE / serial / RTP, `DeviceManager._sendToOutput` for USB), so the wire
 * bytes are identical by construction rather than by four parallel edits.
 *
 * ### The panic order — 120, then 121, then 123
 *
 * `PANIC_CONTROLLERS` is deliberately ordered, and the order is the fix for
 * F-45, not a detail:
 *
 * 1. **CC 120 — All Sound Off.** Kills the oscillators immediately, ignoring
 *    release envelopes and the damper pedal. On an instrument that implements
 *    it, nothing else is needed.
 * 2. **CC 121 — Reset All Controllers.** Unlatches the *sustain pedal*
 *    (CC 64), sostenuto, modulation and pitch bend. This is the message the
 *    old panic never sent.
 * 3. **CC 123 — All Notes Off.** Releases the held notes.
 *
 * 121 comes **before** 123 on purpose. MIDI 1.0 defines All Notes Off as
 * ignored (or, on the kinder implementations, deferred) for as long as the
 * damper pedal is held: with a latched CC 64, a 123 sent first is a no-op, and
 * a 121 sent afterwards only unlatches a pedal whose note-offs were already
 * thrown away. Sending 121 first guarantees 123 is honoured. The failure this
 * closes is the common one for the DIY / microcontroller instruments this
 * project targets: firmwares that implement 123 but not 120, where the whole
 * panic was a no-op exactly when it was needed (audit L03 F-45).
 *
 * All three controllers are `>= 120`, which is what the `DeviceManager` rate
 * limiter and the serial write queue key their priority exemptions on — so a
 * panic burst is never partially dropped under load. That is also why an
 * explicit `CC 64 = 0` is **not** part of the sequence: CC 64 is ordinary
 * traffic for both exemptions and would be the one message the limiter drops.
 * 121 is the standard, exempt way to release the pedal.
 */
import { MIDI_CC, DEVICE_MSG_TYPES } from '../../core/constants.js';

/** MIDI 1.0 has 16 channels; a panic must cover every one of them. */
export const MIDI_CHANNEL_COUNT = 16;

/**
 * The full panic sequence, per channel, in emission order.
 * @type {ReadonlyArray<number>}
 */
export const PANIC_CONTROLLERS = Object.freeze([
  MIDI_CC.ALL_SOUND_OFF, // 120
  MIDI_CC.RESET_ALL_CONTROLLERS, // 121
  MIDI_CC.ALL_NOTES_OFF // 123
]);

/**
 * The gentle variant: release the notes, let the envelopes run, touch no
 * controller state.
 * @type {ReadonlyArray<number>}
 */
export const ALL_NOTES_OFF_CONTROLLERS = Object.freeze([MIDI_CC.ALL_NOTES_OFF]);

/**
 * Build a silencing burst as canonical `DeviceManager.sendMessage` arguments.
 * Channel-major ordering (all controllers of channel 0, then channel 1, …) so
 * a device that only listens on one channel is silenced by the first three
 * messages rather than the last three.
 *
 * @param {ReadonlyArray<number>} [controllers=PANIC_CONTROLLERS]
 * @param {number} [channels=MIDI_CHANNEL_COUNT]
 * @returns {Array<{type:string, data:{channel:number, controller:number, value:number}}>}
 */
export function buildSilenceSequence(
  controllers = PANIC_CONTROLLERS,
  channels = MIDI_CHANNEL_COUNT
) {
  const sequence = [];
  for (let channel = 0; channel < channels; channel++) {
    for (const controller of controllers) {
      sequence.push({
        type: DEVICE_MSG_TYPES.CC,
        data: { channel, controller, value: 0 }
      });
    }
  }
  return sequence;
}

/**
 * The same burst as raw MIDI bytes (`Bn cc 00` per message), for the
 * transports that write a byte stream directly (serial UART) and for the
 * parity assertions that compare the four transports byte for byte.
 *
 * @param {ReadonlyArray<number>} [controllers=PANIC_CONTROLLERS]
 * @param {number} [channels=MIDI_CHANNEL_COUNT]
 * @returns {number[]} Flat byte stream.
 */
export function silenceSequenceBytes(
  controllers = PANIC_CONTROLLERS,
  channels = MIDI_CHANNEL_COUNT
) {
  const bytes = [];
  for (const { data } of buildSilenceSequence(controllers, channels)) {
    bytes.push(0xb0 | (data.channel & 0x0f), data.controller & 0x7f, 0x00);
  }
  return bytes;
}

export default {
  MIDI_CHANNEL_COUNT,
  PANIC_CONTROLLERS,
  ALL_NOTES_OFF_CONTROLLERS,
  buildSilenceSequence,
  silenceSequenceBytes
};
