/**
 * @file src/api/commands/schemas/midi.schemas.js
 * @description Declarative validation schemas for the raw MIDI dispatch
 * commands (ROADMAP_DI_2026-05-21 reco #2 — closing the 16% schema
 * coverage gap on commands that accept structured channel/note/CC
 * payloads).
 *
 * Bornes alignées sur la spec MIDI 1.0 :
 *   - channel       : 0..15  (4 bits)
 *   - note          : 0..127 (7 bits)
 *   - velocity      : 0..127 (7 bits)
 *   - controller    : 0..127 (7 bits)
 *   - cc value      : 0..127 (7 bits)
 *   - pitchbend     : -8192..8191 (centered) OR 0..16383 (raw 14-bit);
 *                     handler normalises both.
 *
 * `midi_send` keeps a permissive shape — `JsonValidator.validateMidiMessage`
 * already enforces type-aware MIDI semantics inside the handler. The
 * schema here only checks the envelope (`deviceId`, `type`) so an obviously
 * malformed payload is rejected before the type-aware validator runs.
 *
 * See `src/api/commands/MidiCommands.js`.
 */

export const midi_send = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1 },
    // `type` is intentionally kept loose here — JsonValidator.validateMidiMessage
    // (called by the handler) enforces the type-aware ranges for note/cc/etc.
    type: { type: 'string', required: true, minLength: 1 },
    channel: { type: 'integer', min: 0, max: 15 }
  }
};

export const midi_send_note = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1 },
    channel: { type: 'integer', required: true, min: 0, max: 15 },
    note: { type: 'integer', required: true, min: 0, max: 127 },
    velocity: { type: 'integer', required: true, min: 0, max: 127 },
    duration: { type: 'number', min: 0 }
  }
};

export const midi_send_cc = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1 },
    channel: { type: 'integer', required: true, min: 0, max: 15 },
    controller: { type: 'integer', required: true, min: 0, max: 127 },
    value: { type: 'integer', required: true, min: 0, max: 127 }
  }
};

export const midi_send_pitchbend = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1 },
    channel: { type: 'integer', required: true, min: 0, max: 15 },
    value: { type: 'integer', required: true, min: -8192, max: 16383 }
  }
};

const requireDeviceId = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1 }
  }
};

export const midi_panic = requireDeviceId;
export const midi_all_notes_off = requireDeviceId;

// midi_reset accepts an optional deviceId (broadcast when absent).
export const midi_reset = {
  fields: {
    deviceId: { type: 'string', minLength: 1 }
  }
};

export const midi_clock_toggle = {
  fields: {
    enabled: { type: 'boolean', required: true }
  }
};

const schemas = {
  midi_send,
  midi_send_note,
  midi_send_cc,
  midi_send_pitchbend,
  midi_panic,
  midi_all_notes_off,
  midi_reset,
  midi_clock_toggle
};

export default schemas;
