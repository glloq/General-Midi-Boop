/**
 * @file src/api/commands/MidiCommands.js
 * @description WebSocket commands that emit raw MIDI to a device or
 * trigger panic / clock-toggle actions. Sits directly on top of
 * `DeviceManager#sendMessage` — no routing, no playback context.
 *
 * Registered commands:
 *   - `midi_send`            — generic MIDI message dispatch
 *   - `midi_send_note`       — note on (with optional auto-noteOff)
 *   - `midi_send_cc`         — control change
 *   - `midi_send_pitchbend`  — pitch bend
 *   - `midi_panic`           — All Sound Off + All Notes Off across 16 ch
 *   - `midi_all_notes_off`   — All Notes Off across 16 ch
 *   - `midi_reset`           — placeholder for System Reset
 *   - `midi_clock_toggle`    — start/stop the MIDI clock generator
 */
import JsonValidator from '../../utils/JsonValidator.js';
import { ValidationError } from '../../core/errors/index.js';

/**
 * Standard MIDI Channel Mode CC numbers used by panic / silence helpers.
 * @see https://midi.org/expanded-midi-1-0-messages-list
 */
const MIDI_CC = {
  ALL_SOUND_OFF: 120,
  ALL_NOTES_OFF: 123
};

/**
 * Generic MIDI dispatch. Validates the message body via
 * `JsonValidator.validateMidiMessage` then forwards it to the
 * DeviceManager.
 *
 * @param {Object} app
 * @param {Object} data - MIDI message (`{deviceId, type, channel, ...}`).
 * @returns {Promise<{success:boolean}>}
 * @throws {ValidationError}
 */
async function midiSend(app, data) {
  const validation = JsonValidator.validateMidiMessage(data);
  if (!validation.valid) {
    throw new ValidationError(`Invalid MIDI message: ${validation.errors.join(', ')}`);
  }

  const success = app.deviceManager.sendMessage(
    data.deviceId,
    data.type,
    data
  );
  return { success: success };
}

/**
 * Send a note. When `velocity === 0` a noteOff is emitted instead
 * (standard MIDI convention). When `duration` is provided, an automatic
 * noteOff is scheduled — useful for programmatic playback but
 * intentionally NOT used by the interactive keyboard which sends
 * explicit noteOff on key release.
 *
 * @param {Object} app
 * @param {{deviceId:string, channel:number, note:number,
 *   velocity:number, duration?:number}} data - `duration` in ms.
 * @returns {Promise<{success:true}>}
 */
async function midiSendNote(app, data) {
  if (data.velocity === 0) {
    app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
      channel: data.channel,
      note: data.note,
      velocity: 0
    });
    return { success: true };
  }

  app.deviceManager.sendMessage(data.deviceId, 'noteon', {
    channel: data.channel,
    note: data.note,
    velocity: data.velocity
  });

  // Only auto-send noteOff when duration is explicitly provided
  // (for programmatic playback, not interactive keyboard)
  if (data.duration) {
    setTimeout(() => {
      app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
        channel: data.channel,
        note: data.note,
        velocity: 0
      });
    }, data.duration);
  }

  return { success: true };
}

/**
 * @param {Object} app
 * @param {{deviceId:string, channel:number, controller:number, value:number}} data
 * @returns {Promise<{success:true}>}
 */
async function midiSendCc(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'cc', {
    channel: data.channel,
    controller: data.controller,
    value: data.value
  });
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{deviceId:string, channel:number, value:number}} data - `value`
 *   may be either centered (-8192..8191) or raw 14-bit (0..16383); the
 *   transport layer normalises both formats.
 * @returns {Promise<{success:true}>}
 */
async function midiSendPitchbend(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'pitchbend', {
    channel: data.channel,
    value: data.value
  });
  return { success: true };
}

/**
 * MIDI Panic: send All Sound Off + All Notes Off on every channel.
 * Useful when stuck notes occur after a crashed sequence or device
 * disconnect.
 *
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true}>}
 */
async function midiPanic(app, data) {
  for (let channel = 0; channel < 16; channel++) {
    app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: channel,
      controller: MIDI_CC.ALL_SOUND_OFF,
      value: 0
    });
    app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: channel,
      controller: MIDI_CC.ALL_NOTES_OFF,
      value: 0
    });
  }
  return { success: true };
}

/**
 * Send All Notes Off across every channel — gentler than panic; lets
 * sustained notes fade naturally on synths that respect note-off envelopes.
 *
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true}>}
 */
async function midiAllNotesOff(app, data) {
  for (let channel = 0; channel < 16; channel++) {
    app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: channel,
      controller: MIDI_CC.ALL_NOTES_OFF,
      value: 0
    });
  }
  return { success: true };
}

/**
 * Placeholder for MIDI System Reset (0xFF). Currently a no-op.
 * TODO: emit System Reset on the targeted device once the transports
 * support raw realtime bytes.
 *
 * @returns {Promise<{success:true}>}
 */
async function midiReset(_app, _data) {
  return { success: true };
}

/**
 * Enable or disable the master MIDI Clock generator.
 *
 * @param {Object} app
 * @param {{enabled:boolean}} data
 * @returns {{success:boolean, enabled?:boolean, message?:string}} `success:false`
 *   when the clock generator is not loaded (missing optional dep).
 * @throws {ValidationError}
 */
function midiClockToggle(app, data) {
  if (data.enabled === undefined) {
    throw new ValidationError('enabled is required', 'enabled');
  }

  if (!app.midiClockGenerator) {
    return { success: false, message: 'MIDI Clock generator not available' };
  }

  app.midiClockGenerator.setEnabled(data.enabled);
  return { success: true, enabled: data.enabled };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('midi_send', (data) => midiSend(app, data));
  registry.register('midi_send_note', (data) => midiSendNote(app, data));
  registry.register('midi_send_cc', (data) => midiSendCc(app, data));
  registry.register('midi_send_pitchbend', (data) => midiSendPitchbend(app, data));
  registry.register('midi_panic', (data) => midiPanic(app, data));
  registry.register('midi_all_notes_off', (data) => midiAllNotesOff(app, data));
  registry.register('midi_reset', (data) => midiReset(app, data));
  registry.register('midi_clock_toggle', (data) => midiClockToggle(app, data));
}
