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
 *   - `midi_reset`           — System Reset to one device or all outputs
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

  const success = app.deviceManager.sendMessage(data.deviceId, data.type, data);
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
 *   is centered (-8192..8191, center 0) when <= 8191, else raw 14-bit
 *   (0..16383). Normalised HERE to an unambiguous raw 14-bit `value14` so the
 *   transport layer never has to guess (audit — the old pass-through of a
 *   bare `value` mis-encoded on some transports).
 * @returns {Promise<{success:true}>}
 */
async function midiSendPitchbend(app, data) {
  const v = data.value;
  const value14 = v > 8191 ? v : v + 8192; // >8191 already raw; else centered→raw
  app.deviceManager.sendMessage(data.deviceId, 'pitchbend', {
    channel: data.channel,
    value14: Math.max(0, Math.min(16383, value14))
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
/**
 * Send one or more Channel Mode CCs on every one of the 16 MIDI
 * channels. Controllers are emitted in order per channel (preserving the
 * exact on-wire sequence the panic/silence helpers always produced).
 */
function _ccAllChannels(app, deviceId, controllers) {
  for (let channel = 0; channel < 16; channel++) {
    for (const controller of controllers) {
      app.deviceManager.sendMessage(deviceId, 'cc', { channel, controller, value: 0 });
    }
  }
}

async function midiPanic(app, data) {
  _ccAllChannels(app, data.deviceId, [MIDI_CC.ALL_SOUND_OFF, MIDI_CC.ALL_NOTES_OFF]);
  // Panic is the stuck-note escape hatch: also clear the live route-through
  // note-gate so a phantom voice (from a lost note-off) can't keep gating or
  // stranding notes after the hardware has been silenced (audit fix).
  app.midiRouter?.resetNoteGate?.();
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
  _ccAllChannels(app, data.deviceId, [MIDI_CC.ALL_NOTES_OFF]);
  app.midiRouter?.resetNoteGate?.();
  return { success: true };
}

/**
 * Emit MIDI System Reset (status byte `0xFF`) to the target device.
 * When `deviceId` is omitted, the reset is broadcast to every open
 * output so a one-click "reset everything" workflow is possible.
 *
 * @param {Object} app
 * @param {{deviceId?:string}} data
 * @returns {Promise<{success:boolean, targets:number}>}
 */
async function midiReset(app, data) {
  // A System Reset returns the device(s) to power-on state; drop stale live
  // note-gate voice counts so they don't gate/strand subsequent notes.
  app.midiRouter?.resetNoteGate?.();
  if (data && data.deviceId) {
    const ok = app.deviceManager.sendMessage(data.deviceId, 'reset', {});
    return { success: ok, targets: ok ? 1 : 0 };
  }

  // Broadcast to every connected output device.
  let sent = 0;
  const devices = app.deviceManager.getDeviceList();
  for (const device of devices) {
    if (device.output && device.enabled !== false) {
      if (app.deviceManager.sendMessage(device.id, 'reset', {})) sent++;
    }
  }
  return { success: true, targets: sent };
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
