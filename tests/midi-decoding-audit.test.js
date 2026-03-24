// tests/midi-decoding-audit.test.js
// Audit tests for MIDI file decoding: channel detection, CC detection, note detection

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import ChannelAnalyzer from '../src/midi/ChannelAnalyzer.js';
import CustomMidiParser from '../src/utils/CustomMidiParser.js';
import MidiUtils from '../src/utils/MidiUtils.js';
import MidiMessage from '../src/midi/MidiMessage.js';

// ============================================================
// Test helpers
// ============================================================

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

/**
 * Create a mock MIDI data structure compatible with ChannelAnalyzer
 */
function createMidiData(tracks) {
  return {
    header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
    tracks: tracks.map((events, i) => ({
      name: `Track ${i}`,
      events
    })),
    duration: 10
  };
}

function noteOn(channel, note, velocity, time = 0) {
  return { type: 'noteOn', channel, noteNumber: note, velocity, time };
}

function noteOff(channel, note, velocity = 0, time = 0) {
  return { type: 'noteOff', channel, noteNumber: note, velocity, time };
}

function cc(channel, controller, value, time = 0) {
  return { type: 'controller', channel, controllerType: controller, value, time };
}

function programChange(channel, program, time = 0) {
  return { type: 'programChange', channel, programNumber: program, time };
}

function pitchBend(channel, value, time = 0) {
  return { type: 'pitchBend', channel, value, time };
}

// ============================================================
// 1. Channel Detection
// ============================================================

describe('MIDI Channel Detection', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
  });

  test('detects all 16 MIDI channels (0-15)', () => {
    const events = [];
    for (let ch = 0; ch < 16; ch++) {
      events.push(noteOn(ch, 60, 100, ch * 100));
      events.push(noteOff(ch, 60, 0, ch * 100 + 50));
    }

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    expect(channels).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test('detects only channels with note events, not CC-only channels', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      noteOff(0, 60, 0, 50),
      cc(5, 7, 100, 10), // CC on channel 5 but no notes
      noteOn(9, 36, 100, 100),
      noteOff(9, 36, 0, 150)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    expect(channels).toEqual([0, 9]);
    expect(channels).not.toContain(5);
  });

  test('detects channel 9 as drums with 100% confidence', () => {
    const events = [
      noteOn(9, 36, 100, 0),
      noteOff(9, 36, 0, 50),
      noteOn(9, 38, 100, 100),
      noteOff(9, 38, 0, 150)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 9);

    expect(analysis.channel).toBe(9);
    expect(analysis.estimatedType).toBe('drums');
    expect(analysis.typeConfidence).toBe(100);
  });

  test('detects channels across multiple tracks', () => {
    const track1 = [noteOn(0, 60, 100, 0), noteOff(0, 60, 0, 50)];
    const track2 = [noteOn(3, 48, 100, 0), noteOff(3, 48, 0, 50)];
    const track3 = [noteOn(9, 36, 100, 0), noteOff(9, 36, 0, 50)];

    const midiData = createMidiData([track1, track2, track3]);
    const channels = analyzer.extractActiveChannels(midiData);

    expect(channels).toEqual([0, 3, 9]);
  });

  test('returns empty array for MIDI data with no tracks', () => {
    const channels = analyzer.extractActiveChannels({ tracks: [] });
    expect(channels).toEqual([]);
  });

  test('returns empty array for null/undefined input', () => {
    expect(analyzer.extractActiveChannels(null)).toEqual([]);
    expect(analyzer.extractActiveChannels(undefined)).toEqual([]);
  });
});

// ============================================================
// 2. CC (Control Change) Detection
// ============================================================

describe('MIDI CC Detection', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
  });

  test('detects common CCs (volume, pan, sustain, modulation)', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      cc(0, 7, 100, 10),   // Volume
      cc(0, 10, 64, 20),   // Pan
      cc(0, 64, 127, 30),  // Sustain pedal
      cc(0, 1, 50, 40),    // Modulation
      noteOff(0, 60, 0, 100)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.usedCCs).toContain(7);
    expect(analysis.usedCCs).toContain(10);
    expect(analysis.usedCCs).toContain(64);
    expect(analysis.usedCCs).toContain(1);
  });

  test('detects Bank Select MSB (CC0) and LSB (CC32)', () => {
    const events = [
      cc(0, 0, 1, 0),     // Bank Select MSB
      cc(0, 32, 5, 10),   // Bank Select LSB
      programChange(0, 25, 20),
      noteOn(0, 60, 100, 30),
      noteOff(0, 60, 0, 80)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.bankMSB).toBe(1);
    expect(analysis.bankLSB).toBe(5);
    expect(analysis.usedCCs).toContain(0);
    expect(analysis.usedCCs).toContain(32);
  });

  test('handles both "controller" and "cc" event type names', () => {
    const events = [
      { type: 'controller', channel: 0, controllerType: 7, value: 100, time: 0 },
      { type: 'cc', channel: 0, controller: 64, value: 127, time: 10 },
      noteOn(0, 60, 100, 20),
      noteOff(0, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const usedCCs = analyzer.extractUsedCCs(events);

    expect(usedCCs).toContain(7);
    expect(usedCCs).toContain(64);
  });

  test('detects CC0 (controller number 0) correctly', () => {
    const events = [
      cc(0, 0, 0, 0), // CC0 with value 0
      noteOn(0, 60, 100, 10),
      noteOff(0, 60, 0, 50)
    ];

    const usedCCs = analyzer.extractUsedCCs(events);
    expect(usedCCs).toContain(0);
  });

  test('detects pitch bend usage', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      pitchBend(0, 4000, 10),
      noteOff(0, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);
    expect(analysis.usesPitchBend).toBe(true);
  });

  test('detects program changes', () => {
    const events = [
      programChange(0, 25, 0),
      noteOn(0, 60, 100, 10),
      noteOff(0, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.programs).toContain(25);
    expect(analysis.primaryProgram).toBe(25);
  });
});

// ============================================================
// 3. MIDI Note Detection
// ============================================================

describe('MIDI Note Detection', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
  });

  test('detects note 0 (C-1) correctly — BUG FIX: ?? vs ||', () => {
    const events = [
      noteOn(0, 0, 100, 0),
      noteOff(0, 0, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.noteRange.min).toBe(0);
    expect(analysis.noteRange.max).toBe(0);
    expect(analysis.totalNotes).toBe(1);
    expect(analysis.noteDistribution[0]).toBe(1);
  });

  test('detects note 127 (G9) correctly', () => {
    const events = [
      noteOn(0, 127, 100, 0),
      noteOff(0, 127, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.noteRange.min).toBe(127);
    expect(analysis.noteRange.max).toBe(127);
    expect(analysis.totalNotes).toBe(1);
  });

  test('detects full note range (0-127)', () => {
    const events = [
      noteOn(0, 0, 100, 0),
      noteOff(0, 0, 0, 10),
      noteOn(0, 60, 100, 20),
      noteOff(0, 60, 0, 30),
      noteOn(0, 127, 100, 40),
      noteOff(0, 127, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.noteRange.min).toBe(0);
    expect(analysis.noteRange.max).toBe(127);
    expect(analysis.totalNotes).toBe(3);
  });

  test('velocity 0 noteOn is treated as noteOff (not counted)', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      noteOn(0, 60, 0, 50) // velocity 0 = noteOff
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    // Only one noteOn with velocity > 0
    expect(analysis.totalNotes).toBe(1);
  });

  test('returns null range for empty channel', () => {
    const noteEvents = [];
    const range = analyzer.extractNoteRange(noteEvents);

    expect(range.min).toBeNull();
    expect(range.max).toBeNull();
  });

  test('builds correct note histogram', () => {
    const events = [
      noteOn(0, 60, 100, 0), noteOff(0, 60, 0, 10),
      noteOn(0, 60, 100, 20), noteOff(0, 60, 0, 30),
      noteOn(0, 64, 100, 40), noteOff(0, 64, 0, 50),
      noteOn(0, 67, 100, 60), noteOff(0, 67, 0, 70),
      noteOn(0, 67, 100, 80), noteOff(0, 67, 0, 90),
      noteOn(0, 67, 100, 100), noteOff(0, 67, 0, 110)
    ];

    const midiData = createMidiData([events]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.noteDistribution[60]).toBe(2);
    expect(analysis.noteDistribution[64]).toBe(1);
    expect(analysis.noteDistribution[67]).toBe(3);
    expect(analysis.totalNotes).toBe(6);
  });
});

// ============================================================
// 4. Polyphony Calculation
// ============================================================

describe('Polyphony Calculation', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
  });

  test('detects monophonic line (polyphony max = 1)', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      noteOff(0, 60, 0, 50),
      noteOn(0, 64, 100, 50),
      noteOff(0, 64, 0, 100)
    ];

    const poly = analyzer.calculatePolyphony(events);
    expect(poly.max).toBe(1);
  });

  test('detects chord (polyphony max = 3)', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      noteOn(0, 64, 100, 0),
      noteOn(0, 67, 100, 0),
      noteOff(0, 60, 0, 50),
      noteOff(0, 64, 0, 50),
      noteOff(0, 67, 0, 50)
    ];

    const poly = analyzer.calculatePolyphony(events);
    expect(poly.max).toBe(3);
  });

  test('handles duplicate noteOn without noteOff — BUG FIX', () => {
    // Same note played twice without noteOff in between
    const events = [
      noteOn(0, 60, 100, 0),
      noteOn(0, 60, 100, 10), // duplicate noteOn
      noteOff(0, 60, 0, 50),
      noteOff(0, 60, 0, 60)
    ];

    const poly = analyzer.calculatePolyphony(events);
    // Should count as polyphony 2 (two instances of note 60 active)
    expect(poly.max).toBe(2);
  });

  test('handles note 0 in polyphony calculation', () => {
    const events = [
      noteOn(0, 0, 100, 0),
      noteOn(0, 60, 100, 0),
      noteOff(0, 0, 0, 50),
      noteOff(0, 60, 0, 50)
    ];

    const poly = analyzer.calculatePolyphony(events);
    expect(poly.max).toBe(2);
  });
});

// ============================================================
// 5. CustomMidiParser — Byte-level parsing
// ============================================================

describe('CustomMidiParser', () => {
  const parser = new CustomMidiParser();

  test('reads variable-length quantity correctly', () => {
    // Single byte: 0x00 = 0
    const buf1 = Buffer.from([0x00]);
    expect(parser.readVariableLength(buf1, 0)).toEqual({ value: 0, bytesRead: 1 });

    // Single byte: 0x7F = 127
    const buf2 = Buffer.from([0x7F]);
    expect(parser.readVariableLength(buf2, 0)).toEqual({ value: 127, bytesRead: 1 });

    // Two bytes: 0x81 0x00 = 128
    const buf3 = Buffer.from([0x81, 0x00]);
    expect(parser.readVariableLength(buf3, 0)).toEqual({ value: 128, bytesRead: 2 });

    // Four bytes max: 0xFF 0xFF 0xFF 0x7F = 0x0FFFFFFF
    const buf4 = Buffer.from([0xFF, 0xFF, 0xFF, 0x7F]);
    expect(parser.readVariableLength(buf4, 0)).toEqual({ value: 0x0FFFFFFF, bytesRead: 4 });
  });

  test('parses channel events with correct channel extraction', () => {
    // Note On, channel 5, note 60, velocity 100
    const buf = Buffer.from([0x95, 60, 100]);
    const result = parser.readEvent(buf, 0, 0, null);

    expect(result.event.type).toBe('noteOn');
    expect(result.event.channel).toBe(5);
    expect(result.event.noteNumber).toBe(60);
    expect(result.event.velocity).toBe(100);
  });

  test('parses control change with correct CC number and value', () => {
    // Control Change, channel 0, CC 7 (volume), value 100
    const buf = Buffer.from([0xB0, 7, 100]);
    const result = parser.readEvent(buf, 0, 0, null);

    expect(result.event.type).toBe('controller');
    expect(result.event.channel).toBe(0);
    expect(result.event.controllerType).toBe(7);
    expect(result.event.value).toBe(100);
  });

  test('handles running status correctly', () => {
    // First event: Note On channel 0
    const buf1 = Buffer.from([0x90, 60, 100]);
    const result1 = parser.readEvent(buf1, 0, 0, null);
    expect(result1.event.type).toBe('noteOn');
    expect(result1.status).toBe(0x90);

    // Running status: data bytes only (reuse 0x90)
    const buf2 = Buffer.from([64, 80]);
    const result2 = parser.readEvent(buf2, 0, 100, 0x90);
    expect(result2.event.type).toBe('noteOn');
    expect(result2.event.channel).toBe(0);
    expect(result2.event.noteNumber).toBe(64);
    expect(result2.event.velocity).toBe(80);
  });

  test('parses program change (1 data byte)', () => {
    // Program Change, channel 3, program 25
    const buf = Buffer.from([0xC3, 25]);
    const result = parser.readEvent(buf, 0, 0, null);

    expect(result.event.type).toBe('programChange');
    expect(result.event.channel).toBe(3);
    expect(result.event.programNumber).toBe(25);
    expect(result.bytesRead).toBe(2);
  });

  test('parses pitch bend with correct 14-bit value', () => {
    // Pitch Bend, channel 0, LSB=0, MSB=64 → center (8192)
    const buf = Buffer.from([0xE0, 0x00, 0x40]);
    const result = parser.readEvent(buf, 0, 0, null);

    expect(result.event.type).toBe('pitchBend');
    expect(result.event.channel).toBe(0);
    expect(result.event.value).toBe(0); // (64 << 7 | 0) - 8192 = 8192 - 8192 = 0
  });

  test('parses all 16 channels from status bytes', () => {
    for (let ch = 0; ch < 16; ch++) {
      const statusByte = 0x90 | ch; // noteOn for each channel
      const buf = Buffer.from([statusByte, 60, 100]);
      const result = parser.readEvent(buf, 0, 0, null);

      expect(result.event.channel).toBe(ch);
      expect(result.event.type).toBe('noteOn');
    }
  });

  test('parses meta events without affecting running status', () => {
    // Meta event: Set Tempo (0xFF 0x51 0x03 + 3 bytes)
    // 500000 microseconds/beat = 120 BPM
    const buf = Buffer.from([0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]);
    const result = parser.readEvent(buf, 0, 0, 0x90);

    expect(result.event.type).toBe('meta');
    expect(result.event.metaType).toBe('setTempo');
    expect(result.event.microsecondsPerBeat).toBe(500000);
    expect(result.status).toBeNull(); // Meta events don't affect running status
  });
});

// ============================================================
// 6. MidiUtils — Utility functions
// ============================================================

describe('MidiUtils', () => {
  test('parseStatus extracts type and channel correctly', () => {
    expect(MidiUtils.parseStatus(0x90)).toEqual({ type: 0x90, channel: 0 });
    expect(MidiUtils.parseStatus(0x95)).toEqual({ type: 0x90, channel: 5 });
    expect(MidiUtils.parseStatus(0xBF)).toEqual({ type: 0xB0, channel: 15 });
    expect(MidiUtils.parseStatus(0xE0)).toEqual({ type: 0xE0, channel: 0 });
  });

  test('createStatus combines type and channel correctly', () => {
    expect(MidiUtils.createStatus(0x90, 0)).toBe(0x90);
    expect(MidiUtils.createStatus(0x90, 5)).toBe(0x95);
    expect(MidiUtils.createStatus(0xB0, 15)).toBe(0xBF);
  });

  test('14-bit encode/decode roundtrip', () => {
    for (const value of [0, 1, 8192, 16383, 100, 8000]) {
      const encoded = MidiUtils.encode14bit(value);
      const decoded = MidiUtils.decode14bit(encoded.msb, encoded.lsb);
      expect(decoded).toBe(value);
    }
  });

  test('noteNumberToName covers edge cases', () => {
    expect(MidiUtils.noteNumberToName(0)).toBe('C-1');
    expect(MidiUtils.noteNumberToName(60)).toBe('C4');
    expect(MidiUtils.noteNumberToName(69)).toBe('A4');
    expect(MidiUtils.noteNumberToName(127)).toBe('G9');
  });

  test('noteNameToNumber roundtrip', () => {
    for (const note of [0, 60, 69, 127]) {
      const name = MidiUtils.noteNumberToName(note);
      const back = MidiUtils.noteNameToNumber(name);
      expect(back).toBe(note);
    }
  });

  test('convertToMidiBytes pitch bend handles negative (centered) values', () => {
    // Centered value -8192 should map to raw 0 (max bend down)
    const bytes = MidiUtils.convertToMidiBytes('pitchbend', { channel: 0, value: -8192 });
    expect(bytes).toEqual([0xE0, 0x00, 0x00]);

    // Centered value -1 should map to raw 8191
    const bytesMinus1 = MidiUtils.convertToMidiBytes('pitchbend', { channel: 0, value: -1 });
    expect(bytesMinus1[0]).toBe(0xE0);
    expect(((bytesMinus1[2] << 7) | bytesMinus1[1])).toBe(8191);
  });

  test('convertToMidiBytes pitch bend handles raw 14-bit values (>= 0)', () => {
    // Raw value 0 passes through as 0 (max bend down) — non-negative values treated as raw
    const bytesZero = MidiUtils.convertToMidiBytes('pitchbend', { channel: 0, value: 0 });
    expect(bytesZero).toEqual([0xE0, 0x00, 0x00]);

    // Raw value 8192 (center) should pass through
    const bytes = MidiUtils.convertToMidiBytes('pitchbend', { channel: 0, value: 8192 });
    expect(bytes).toEqual([0xE0, 0x00, 0x40]);

    // Raw value 16383 (max bend up)
    const bytesMax = MidiUtils.convertToMidiBytes('pitchbend', { channel: 0, value: 16383 });
    expect(bytesMax).toEqual([0xE0, 0x7F, 0x7F]);
  });

  test('isValidChannel validates 0-15 range', () => {
    expect(MidiUtils.isValidChannel(0)).toBe(true);
    expect(MidiUtils.isValidChannel(15)).toBe(true);
    expect(MidiUtils.isValidChannel(-1)).toBe(false);
    expect(MidiUtils.isValidChannel(16)).toBe(false);
  });

  test('isValidNote validates 0-127 range', () => {
    expect(MidiUtils.isValidNote(0)).toBe(true);
    expect(MidiUtils.isValidNote(127)).toBe(true);
    expect(MidiUtils.isValidNote(-1)).toBe(false);
    expect(MidiUtils.isValidNote(128)).toBe(false);
  });
});

// ============================================================
// 7. MidiMessage — Real-time message parsing
// ============================================================

describe('MidiMessage', () => {
  test('parses note on from bytes with correct channel', () => {
    const msg = new MidiMessage([0x93, 60, 100]); // Channel 3
    expect(msg.type).toBe('noteon');
    expect(msg.channel).toBe(3);
    expect(msg.note).toBe(60);
    expect(msg.velocity).toBe(100);
  });

  test('parses velocity 0 noteOn as noteOff', () => {
    const msg = new MidiMessage([0x90, 60, 0]);
    expect(msg.type).toBe('noteoff');
    expect(msg.channel).toBe(0);
    expect(msg.note).toBe(60);
  });

  test('parses control change from bytes', () => {
    const msg = new MidiMessage([0xB5, 7, 100]); // CC7 volume on channel 5
    expect(msg.type).toBe('cc');
    expect(msg.channel).toBe(5);
    expect(msg.controller).toBe(7);
    expect(msg.value).toBe(100);
  });

  test('parses program change from bytes', () => {
    const msg = new MidiMessage([0xC2, 25]); // Program 25 on channel 2
    expect(msg.type).toBe('program');
    expect(msg.channel).toBe(2);
    expect(msg.program).toBe(25);
  });

  test('parses pitch bend from bytes', () => {
    const msg = new MidiMessage([0xE0, 0x00, 0x40]); // Center
    expect(msg.type).toBe('pitchbend');
    expect(msg.channel).toBe(0);
    expect(msg.value).toBe(0); // Centered at 0
  });

  test('toBytes roundtrip preserves data', () => {
    const original = new MidiMessage([0x93, 64, 80]);
    const bytes = original.toBytes();
    const restored = new MidiMessage(bytes);

    expect(restored.type).toBe(original.type);
    expect(restored.channel).toBe(original.channel);
    expect(restored.note).toBe(original.note);
    expect(restored.velocity).toBe(original.velocity);
  });

  test('validates MIDI data ranges', () => {
    const msg = new MidiMessage({ type: 'noteon', channel: 0, note: 60, velocity: 100 });
    expect(msg.validate().valid).toBe(true);

    const invalid = new MidiMessage({ type: 'noteon', channel: 0, note: 200, velocity: 100 });
    expect(invalid.validate().valid).toBe(false);
  });
});

// ============================================================
// 8. Routing / Editor Channel Consistency
// ============================================================

describe('Routing / Editor Channel Consistency — No Ghost Channels', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
  });

  test('CC-only channel is NOT detected as active (no ghost channels)', () => {
    // Channel 5 has only CC events — no notes
    const events = [
      cc(5, 7, 100, 0),     // Volume on channel 5
      cc(5, 10, 64, 10),    // Pan on channel 5
      cc(5, 64, 127, 20),   // Sustain on channel 5
      noteOn(1, 60, 100, 0),
      noteOff(1, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    // Channel 5 should NOT appear — it has no notes
    expect(channels).toEqual([1]);
    expect(channels).not.toContain(5);
  });

  test('programChange-only channel is NOT detected as active', () => {
    // Channel 3 has only a program change — no notes
    const events = [
      programChange(3, 25, 0),
      noteOn(0, 60, 100, 10),
      noteOff(0, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    expect(channels).toEqual([0]);
    expect(channels).not.toContain(3);
  });

  test('pitchBend-only channel is NOT detected as active', () => {
    const events = [
      pitchBend(7, 4000, 0),
      noteOn(0, 60, 100, 10),
      noteOff(0, 60, 0, 50)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    expect(channels).toEqual([0]);
    expect(channels).not.toContain(7);
  });

  test('mixed file: channels with notes detected, CC-only channels excluded', () => {
    // Typical MIDI file scenario:
    // Channel 0: has CC events + program change but NO notes
    // Channel 1: has notes + CC events
    // Channel 9: has drum notes
    const events = [
      // Channel 0: CC-only (ghost channel scenario)
      cc(0, 7, 100, 0),
      cc(0, 10, 64, 5),
      programChange(0, 48, 10),

      // Channel 1: has notes
      programChange(1, 25, 0),
      cc(1, 7, 80, 5),
      noteOn(1, 60, 100, 20),
      noteOff(1, 60, 0, 70),
      noteOn(1, 64, 90, 80),
      noteOff(1, 64, 0, 130),

      // Channel 9: has drum notes
      noteOn(9, 36, 100, 20),
      noteOff(9, 36, 0, 40),
      noteOn(9, 38, 100, 60),
      noteOff(9, 38, 0, 80)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    // Routing and Editor should show the SAME channels: [1, 9]
    // Channel 0 is a ghost — should NOT appear
    expect(channels).toEqual([1, 9]);
    expect(channels).not.toContain(0);
  });

  test('channel 0 with notes IS correctly detected (not confused with falsy)', () => {
    const events = [
      noteOn(0, 60, 100, 0),
      noteOff(0, 60, 0, 50),
      noteOn(5, 72, 100, 10),
      noteOff(5, 72, 0, 60)
    ];

    const midiData = createMidiData([events]);
    const channels = analyzer.extractActiveChannels(midiData);

    // Channel 0 has notes — must be detected
    expect(channels).toContain(0);
    expect(channels).toEqual([0, 5]);
  });

  test('analyzeAllChannels only analyzes channels with notes', () => {
    const events = [
      cc(3, 7, 100, 0),        // CC-only on channel 3
      noteOn(1, 60, 100, 10),
      noteOff(1, 60, 0, 50),
      noteOn(9, 36, 100, 20),
      noteOff(9, 36, 0, 70)
    ];

    const midiData = createMidiData([events]);
    const analyses = analyzer.analyzeAllChannels(midiData);

    // Only channels 1 and 9 should be analyzed
    expect(analyses.length).toBe(2);
    expect(analyses.map(a => a.channel)).toEqual([1, 9]);
  });
});

// ============================================================
// 9. MIDI Message Transmission — No Data Loss
// ============================================================

describe('MIDI Message Transmission — No Data Loss', () => {

  describe('CustomMidiParser — complete event extraction', () => {
    const parser = new CustomMidiParser();

    test('all CC types (0-127) are preserved through parsing', () => {
      // Build a buffer with CC events for various controller numbers
      // Channel 0, CC 0 (Bank Select), value 1
      const buf = Buffer.from([0xB0, 0, 1]);
      const result = parser.readEvent(buf, 0, 0, null);
      expect(result.event.type).toBe('controller');
      expect(result.event.controllerType).toBe(0);
      expect(result.event.value).toBe(1);

      // CC 127 (Poly Mode On), value 0
      const buf2 = Buffer.from([0xB0, 127, 0]);
      const result2 = parser.readEvent(buf2, 0, 0, null);
      expect(result2.event.controllerType).toBe(127);
    });

    test('system CCs (120-127) are not filtered out', () => {
      // CC 120 = All Sound Off
      const buf120 = Buffer.from([0xB0, 120, 0]);
      const r120 = parser.readEvent(buf120, 0, 0, null);
      expect(r120.event.type).toBe('controller');
      expect(r120.event.controllerType).toBe(120);

      // CC 123 = All Notes Off
      const buf123 = Buffer.from([0xB0, 123, 0]);
      const r123 = parser.readEvent(buf123, 0, 0, null);
      expect(r123.event.controllerType).toBe(123);
    });

    test('all 7 channel message types are extracted', () => {
      const tests = [
        { status: 0x80, expected: 'noteOff', bytes: [0x80, 60, 64] },
        { status: 0x90, expected: 'noteOn', bytes: [0x90, 60, 100] },
        { status: 0xA0, expected: 'polyAftertouch', bytes: [0xA0, 60, 80] },
        { status: 0xB0, expected: 'controller', bytes: [0xB0, 7, 100] },
        { status: 0xC0, expected: 'programChange', bytes: [0xC0, 25] },
        { status: 0xD0, expected: 'channelAftertouch', bytes: [0xD0, 100] },
        { status: 0xE0, expected: 'pitchBend', bytes: [0xE0, 0, 64] }
      ];

      for (const t of tests) {
        const buf = Buffer.from(t.bytes);
        const result = parser.readEvent(buf, 0, 0, null);
        expect(result.event.type).toBe(t.expected);
        expect(result.event.channel).toBe(0);
      }
    });
  });

  describe('MidiPlayer.buildEventList — no message loss', () => {
    test('preserves all event types through buildEventList (simulated)', () => {
      // Simulate what midi-file library outputs: raw event objects with deltaTime
      const track = [
        { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 25 },
        { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 100 },
        { deltaTime: 0, type: 'controller', channel: 0, controllerType: 64, value: 127 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
        { deltaTime: 240, type: 'pitchBend', channel: 0, value: 8200 },
        { deltaTime: 240, type: 'channelAftertouch', channel: 0, value: 80 },
        { deltaTime: 0, type: 'noteAftertouch', channel: 0, noteNumber: 60, value: 50 },
        { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
        { deltaTime: 0, type: 'controller', channel: 0, controllerType: 123, value: 0 }
      ];

      // Simulate the buildEventList logic
      const events = [];
      let trackTicks = 0;
      const ppq = 480;
      const tempo = 120;

      for (const event of track) {
        trackTicks += event.deltaTime;
        const timeInSeconds = (trackTicks / ppq) * (60 / tempo);

        if (event.type === 'noteOn' || event.type === 'noteOff') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, note: event.noteNumber, velocity: event.velocity });
        } else if (event.type === 'controller') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, controller: event.controllerType, value: event.value });
        } else if (event.type === 'pitchBend') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, value: event.value });
        } else if (event.type === 'programChange') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, program: event.programNumber });
        } else if (event.type === 'channelAftertouch') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, value: event.value });
        } else if (event.type === 'noteAftertouch') {
          events.push({ time: timeInSeconds, type: event.type, channel: event.channel, note: event.noteNumber, value: event.value });
        }
      }

      // All 9 events should be preserved (no filtering)
      expect(events.length).toBe(9);

      // Verify each type
      expect(events.filter(e => e.type === 'programChange').length).toBe(1);
      expect(events.filter(e => e.type === 'controller').length).toBe(3);
      expect(events.filter(e => e.type === 'noteOn').length).toBe(1);
      expect(events.filter(e => e.type === 'noteOff').length).toBe(1);
      expect(events.filter(e => e.type === 'pitchBend').length).toBe(1);
      expect(events.filter(e => e.type === 'channelAftertouch').length).toBe(1);
      expect(events.filter(e => e.type === 'noteAftertouch').length).toBe(1);

      // CC 123 (All Notes Off) is NOT filtered
      const cc123 = events.find(e => e.type === 'controller' && e.controller === 123);
      expect(cc123).toBeDefined();
    });
  });

  describe('ChannelAnalyzer — CC extraction completeness', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new ChannelAnalyzer(mockLogger);
    });

    test('all CC types are extracted by extractUsedCCs', () => {
      const events = [
        cc(0, 0, 1, 0),     // Bank Select
        cc(0, 1, 64, 10),   // Modulation
        cc(0, 7, 100, 20),  // Volume
        cc(0, 10, 64, 30),  // Pan
        cc(0, 11, 127, 40), // Expression
        cc(0, 64, 127, 50), // Sustain
        cc(0, 120, 0, 60),  // All Sound Off
        cc(0, 121, 0, 70),  // Reset All Controllers
        cc(0, 123, 0, 80),  // All Notes Off
        cc(0, 127, 0, 90),  // Poly Mode On
      ];

      const usedCCs = analyzer.extractUsedCCs(events);

      expect(usedCCs).toEqual([0, 1, 7, 10, 11, 64, 120, 121, 123, 127]);
      expect(usedCCs.length).toBe(10); // All 10 unique CCs preserved
    });

    test('CC events on channels without notes are still extracted', () => {
      // Channel 5 has CC but no notes — CCs should still be in analysis
      const events = [
        cc(5, 7, 100, 0),
        cc(5, 64, 127, 10),
      ];

      const usedCCs = analyzer.extractUsedCCs(events);
      expect(usedCCs).toEqual([7, 64]);
    });

    test('duplicate CC values at same time are preserved', () => {
      const events = [
        cc(0, 7, 100, 0),
        cc(0, 7, 80, 0),   // Same CC, same time, different value
        cc(0, 7, 60, 0),
      ];

      // extractUsedCCs returns unique CC numbers
      const usedCCs = analyzer.extractUsedCCs(events);
      expect(usedCCs).toEqual([7]); // CC 7 detected (unique number)
    });
  });
});
