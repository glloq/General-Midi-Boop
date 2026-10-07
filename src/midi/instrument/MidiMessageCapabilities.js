/**
 * @file src/midi/instrument/MidiMessageCapabilities.js
 * @description Normalises the MIDI messages that a GMB v2 instrument actually
 * consumes at runtime. This is intentionally stricter than a parser inventory:
 * a firmware recognising an opcode but doing nothing with it must not advertise
 * that message as supported.
 *
 * Contract:
 *   - true  = the active runtime configuration has a real musical/safety effect
 *   - false = explicitly unsupported / no-op
 *   - absent = unknown (legacy descriptor); GMB must stay permissive
 *
 * The optional descriptor `messages` object is authoritative when present.
 * Older descriptors are upgraded conservatively from `notes` and `expression`.
 */

export const MIDI_MESSAGE_CAPABILITY_KEYS = Object.freeze([
  'note_on',
  'note_off',
  'control_change',
  'program_change',
  'pitch_bend',
  'channel_aftertouch',
  'poly_aftertouch',
  'clock',
  'start',
  'continue',
  'stop',
  'system_reset'
]);

const MIDI_MESSAGE_CAPABILITY_KEY_SET = new Set(MIDI_MESSAGE_CAPABILITY_KEYS);

/**
 * Validate the optional `messages` block on one descriptor instrument.
 * Unknown keys are tolerated for protocol forward-compatibility; known keys
 * must be booleans so `false` cannot be confused with missing/unknown.
 *
 * @param {Object} inst
 * @returns {string[]} errors relative to the instrument
 */
export function validateMidiMessageCapabilities(inst) {
  const messages = inst?.messages;
  if (messages == null) return [];
  if (typeof messages !== 'object' || Array.isArray(messages)) {
    return ['messages must be an object'];
  }

  const errors = [];
  for (const [key, value] of Object.entries(messages)) {
    if (MIDI_MESSAGE_CAPABILITY_KEY_SET.has(key) && typeof value !== 'boolean') {
      errors.push(`messages.${key} must be a boolean`);
    }
  }
  return errors;
}

/**
 * Derive a normalised support object from one v2 descriptor instrument.
 * Explicit `messages.*` values win. Missing values may be inferred from the
 * existing v2 fields, but are NEVER defaulted to false.
 *
 * Extra non-message properties are included because they are needed by the
 * host when deciding how to expose/play expressive data:
 *   - velocity
 *   - pitch_bend_range_semitones
 *
 * @param {Object} inst
 * @returns {Object|null}
 */
export function deriveMidiMessageSupport(inst) {
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) return null;

  const explicit =
    inst.messages && typeof inst.messages === 'object' && !Array.isArray(inst.messages)
      ? inst.messages
      : {};
  const expression =
    inst.expression && typeof inst.expression === 'object' && !Array.isArray(inst.expression)
      ? inst.expression
      : {};

  const out = {};

  for (const key of MIDI_MESSAGE_CAPABILITY_KEYS) {
    if (typeof explicit[key] === 'boolean') out[key] = explicit[key];
  }

  // Legacy-v2 derivation. Presence of a notes declaration means the instrument
  // is defining playable notes, therefore Note On/Off are safe to infer.
  if (out.note_on === undefined && inst.notes && typeof inst.notes === 'object') {
    out.note_on = true;
  }
  if (out.note_off === undefined && inst.notes && typeof inst.notes === 'object') {
    out.note_off = true;
  }

  // An explicit CC list is a declaration of semantic CC handling. An empty list
  // therefore means no musical CC support; absent list remains unknown.
  if (out.control_change === undefined && Array.isArray(expression.cc)) {
    out.control_change = expression.cc.length > 0;
  }

  const pitchBend = expression.pitch_bend;
  if (
    out.pitch_bend === undefined &&
    pitchBend &&
    typeof pitchBend === 'object' &&
    typeof pitchBend.supported === 'boolean'
  ) {
    out.pitch_bend = pitchBend.supported;
  }
  if (
    out.channel_aftertouch === undefined &&
    typeof expression.channel_aftertouch === 'boolean'
  ) {
    out.channel_aftertouch = expression.channel_aftertouch;
  }
  if (out.poly_aftertouch === undefined && typeof expression.poly_aftertouch === 'boolean') {
    out.poly_aftertouch = expression.poly_aftertouch;
  }

  if (typeof expression.velocity === 'boolean') out.velocity = expression.velocity;
  if (
    pitchBend &&
    typeof pitchBend === 'object' &&
    Number.isFinite(pitchBend.range_semitones) &&
    pitchBend.range_semitones >= 0
  ) {
    out.pitch_bend_range_semitones = pitchBend.range_semitones;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Runtime query with backward-compatible semantics.
 * Only an explicit `false` suppresses a message. Unknown/legacy data remains
 * allowed so upgrading GMB cannot silently break older instruments.
 *
 * @param {Object|null|undefined} support
 * @param {string} messageType
 * @returns {boolean}
 */
export function allowsMidiMessage(support, messageType) {
  if (!support || typeof support !== 'object') return true;
  return support[messageType] !== false;
}
