/**
 * Ma-est-tro - Centralized Constants
 * Single source of truth for all magic numbers and enums
 */

// ============================================
// MIDI MESSAGE TYPES
// ============================================
const MIDI_STATUS = {
  NOTE_OFF: 0x80,
  NOTE_ON: 0x90,
  POLY_AFTERTOUCH: 0xA0,
  CONTROL_CHANGE: 0xB0,
  PROGRAM_CHANGE: 0xC0,
  CHANNEL_AFTERTOUCH: 0xD0,
  PITCH_BEND: 0xE0,
  SYSTEM: 0xF0
};

const MIDI_SYSTEM_MESSAGES = {
  MTC_QUARTER_FRAME: 0xF1,
  SONG_POSITION: 0xF2,
  SONG_SELECT: 0xF3,
  TUNE_REQUEST: 0xF6,
  TIMING_CLOCK: 0xF8,
  START: 0xFA,
  CONTINUE: 0xFB,
  STOP: 0xFC,
  ACTIVE_SENSING: 0xFE,
  SYSTEM_RESET: 0xFF
};

// Bytes per system message (for serial parsing)
const SYSTEM_MESSAGE_LENGTH = {
  0xF1: 2, 0xF2: 3, 0xF3: 2,
  0xF6: 1, 0xF8: 1, 0xFA: 1, 0xFB: 1, 0xFC: 1, 0xFE: 1, 0xFF: 1
};

// ============================================
// MIDI CC NUMBERS
// ============================================
const MIDI_CC = {
  BANK_SELECT: 0,
  MODULATION: 1,
  BREATH: 2,
  FOOT: 4,
  PORTAMENTO_TIME: 5,
  DATA_ENTRY_MSB: 6,
  VOLUME: 7,
  BALANCE: 8,
  PAN: 10,
  EXPRESSION: 11,
  EFFECT_1: 12,
  EFFECT_2: 13,
  // String instrument control (acoustic instrument automation)
  STRING_SELECT: 20,     // CC20: select string number (1-6)
  FRET_SELECT: 21,       // CC21: select fret position (0-36)
  BANK_SELECT_LSB: 32,
  SUSTAIN_PEDAL: 64,
  PORTAMENTO: 65,
  SOSTENUTO: 66,
  SOFT_PEDAL: 67,
  LEGATO: 68,
  HOLD_2: 69,
  SOUND_CONTROLLER_1: 70,
  SOUND_CONTROLLER_2: 71,
  SOUND_CONTROLLER_3: 72,
  SOUND_CONTROLLER_4: 73,
  SOUND_CONTROLLER_5: 74,
  SOUND_CONTROLLER_6: 75,
  SOUND_CONTROLLER_7: 76,
  SOUND_CONTROLLER_8: 77,
  SOUND_CONTROLLER_9: 78,
  SOUND_CONTROLLER_10: 79,
  REVERB_DEPTH: 91,
  TREMOLO_DEPTH: 92,
  CHORUS_DEPTH: 93,
  DETUNE_DEPTH: 94,
  PHASER_DEPTH: 95,
  ALL_SOUND_OFF: 120,
  RESET_ALL_CONTROLLERS: 121,
  LOCAL_CONTROL: 122,
  ALL_NOTES_OFF: 123,
  OMNI_MODE_OFF: 124,
  OMNI_MODE_ON: 125,
  MONO_MODE_ON: 126,
  POLY_MODE_ON: 127
};

// ============================================
// MIDI NOTE RANGE
// ============================================
const MIDI_NOTE = {
  MIN: 0,
  MAX: 127,
  MIDDLE_C: 60,
  NOTE_NAMES: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
};

// ============================================
// DEVICE STATUS
// ============================================
const DEVICE_STATUS = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2
};

// ============================================
// TIMING CONSTANTS
// ============================================
const TIMING = {
  // Playback
  SCHEDULER_TICK_MS: 10,
  LOOKAHEAD_SECONDS: 0.1,
  MICROSECONDS_PER_MINUTE: 60000000,

  // Latency
  MAX_COMPENSATION_MS: 5000,

  // Device management
  PORT_RELEASE_DELAY_MS: 250,

  // WebSocket
  HEARTBEAT_INTERVAL_MS: 30000,

  // Serial MIDI
  MIDI_BAUD_RATE: 31250,
  HOT_PLUG_CHECK_INTERVAL_MS: 3000,
  PORT_OPEN_TIMEOUT_MS: 10000,

  // Bluetooth
  BLE_CONNECT_TIMEOUT_MS: 20000,

  // Network RTP
  RTP_CONNECT_TIMEOUT_MS: 10000,

  // Audio calibration
  CALIBRATION_CHECK_INTERVAL_MS: 10
};

// ============================================
// CALIBRATION CONSTANTS
// ============================================
const CALIBRATION = {
  TEST_NOTE: 60,       // Middle C
  TEST_VELOCITY: 64,
  TEST_CHANNEL: 0,
  TIMEOUT_MS: 5000,
  NOTE_DURATION_MS: 50,
  PAUSE_BETWEEN_MS: 100,
  RECALIBRATION_DAYS: 7
};

// ============================================
// SIZE LIMITS
// ============================================
const LIMITS = {
  MAX_MIDI_FILE_SIZE: 50 * 1024 * 1024,   // 50 MB
  MAX_SYSEX_BUFFER_SIZE: 65536,            // 64 KB
  MAX_UNDO_HISTORY: 100,
  MAX_EDITOR_HISTORY: 50
};

// ============================================
// EVENT NAMES
// ============================================
const EVENTS = {
  MIDI_MESSAGE: 'midi_message',
  DEVICE_CONNECTED: 'device_connected',
  DEVICE_DISCONNECTED: 'device_disconnected',
  MIDI_ROUTED: 'midi_routed',
  FILE_UPLOADED: 'file_uploaded',
  PLAYBACK_STARTED: 'playback_started',
  PLAYBACK_STOPPED: 'playback_stopped',
  INSTRUMENT_SETTINGS_CHANGED: 'instrument_settings_changed',
  ERROR: 'error'
};

module.exports = {
  MIDI_STATUS,
  MIDI_SYSTEM_MESSAGES,
  SYSTEM_MESSAGE_LENGTH,
  MIDI_CC,
  MIDI_NOTE,
  DEVICE_STATUS,
  TIMING,
  CALIBRATION,
  LIMITS,
  EVENTS
};
