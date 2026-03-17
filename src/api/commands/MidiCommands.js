// src/api/commands/MidiCommands.js
import JsonValidator from '../../utils/JsonValidator.js';

// MIDI CC constants
const MIDI_CC = {
  ALL_SOUND_OFF: 120,
  ALL_NOTES_OFF: 123
};

async function midiSend(app, data) {
  const validation = JsonValidator.validateMidiMessage(data);
  if (!validation.valid) {
    throw new Error(`Invalid MIDI message: ${validation.errors.join(', ')}`);
  }

  const success = app.deviceManager.sendMessage(
    data.deviceId,
    data.type,
    data
  );
  return { success: success };
}

async function midiSendNote(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'noteon', {
    channel: data.channel,
    note: data.note,
    velocity: data.velocity
  });

  // Send noteOff after duration (default 500ms)
  const duration = data.duration || 500;
  setTimeout(() => {
    app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
      channel: data.channel,
      note: data.note,
      velocity: 0
    });
  }, duration);

  return { success: true };
}

async function midiSendCc(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'cc', {
    channel: data.channel,
    controller: data.controller,
    value: data.value
  });
  return { success: true };
}

async function midiSendProgram(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'program', {
    channel: data.channel,
    number: data.program
  });
  return { success: true };
}

async function midiSendPitchbend(app, data) {
  app.deviceManager.sendMessage(data.deviceId, 'pitchbend', {
    channel: data.channel,
    value: data.value
  });
  return { success: true };
}

async function midiPanic(app, data) {
  // Send all notes off + reset controllers on all channels
  for (let channel = 0; channel < 16; channel++) {
    app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: channel,
      controller: MIDI_CC.ALL_SOUND_OFF, // All Sound Off
      value: 0
    });
    app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: channel,
      controller: MIDI_CC.ALL_NOTES_OFF, // All Notes Off
      value: 0
    });
  }
  return { success: true };
}

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

async function midiReset(app, data) {
  // Send System Reset
  return { success: true };
}

export function register(registry, app) {
  registry.register('midi_send', (data) => midiSend(app, data));
  registry.register('midi_send_note', (data) => midiSendNote(app, data));
  registry.register('midi_send_cc', (data) => midiSendCc(app, data));
  registry.register('midi_send_program', (data) => midiSendProgram(app, data));
  registry.register('midi_send_pitchbend', (data) => midiSendPitchbend(app, data));
  registry.register('midi_panic', (data) => midiPanic(app, data));
  registry.register('midi_all_notes_off', (data) => midiAllNotesOff(app, data));
  registry.register('midi_reset', (data) => midiReset(app, data));
}
