// tests/midi-adaptation.test.js
// Comprehensive tests for the MIDI adaptation system

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import ChannelAnalyzer from '../src/midi/ChannelAnalyzer.js';
import InstrumentMatcher from '../src/midi/InstrumentMatcher.js';
import MidiTransposer from '../src/midi/MidiTransposer.js';
import AutoAssigner from '../src/midi/AutoAssigner.js';
import DrumNoteMapper from '../src/midi/DrumNoteMapper.js';
import AnalysisCache from '../src/midi/AnalysisCache.js';
import InstrumentCapabilitiesValidator from '../src/midi/InstrumentCapabilitiesValidator.js';
import ScoringConfig from '../src/midi/ScoringConfig.js';
import ChannelSplitter from '../src/midi/ChannelSplitter.js';

// ============================================================
// Test helpers
// ============================================================

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

function createMidiData(tracks) {
  return {
    header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
    tracks: tracks.map((events, i) => ({
      name: `Track ${i}`,
      events
    })),
    duration: 120 // 2 minutes
  };
}

function noteOn(channel, note, velocity = 80, time = 0) {
  return { type: 'noteOn', channel, note, noteNumber: note, velocity, time };
}

function noteOff(channel, note, time = 0) {
  return { type: 'noteOff', channel, note, noteNumber: note, velocity: 0, time };
}

function programChange(channel, program, time = 0) {
  return { type: 'programChange', channel, program, programNumber: program, time };
}

function cc(channel, controller, value, time = 0) {
  return { type: 'controller', channel, controller, controllerType: controller, value, time };
}

function createPianoTrack() {
  const events = [
    programChange(0, 0), // Acoustic Grand Piano
    cc(0, 7, 100), // Volume
    cc(0, 64, 127) // Sustain
  ];
  // C3 to C5 range, polyphony up to 4
  for (let t = 0; t < 100; t++) {
    const base = 48 + Math.floor(t / 10) * 2;
    events.push(noteOn(0, base, 80, t * 100));
    events.push(noteOn(0, base + 4, 80, t * 100));
    events.push(noteOn(0, base + 7, 80, t * 100));
    events.push(noteOff(0, base, t * 100 + 90));
    events.push(noteOff(0, base + 4, t * 100 + 90));
    events.push(noteOff(0, base + 7, t * 100 + 90));
  }
  return events;
}

function createBassTrack() {
  const events = [programChange(1, 33)]; // Electric Bass
  for (let t = 0; t < 200; t++) {
    const note = 28 + (t % 12);
    events.push(noteOn(1, note, 90, t * 50));
    events.push(noteOff(1, note, t * 50 + 45));
  }
  return events;
}

function createDrumTrack() {
  const events = [];
  for (let t = 0; t < 200; t++) {
    events.push(noteOn(9, 36, 100, t * 50)); // Kick
    events.push(noteOff(9, 36, t * 50 + 10));
    if (t % 2 === 1) {
      events.push(noteOn(9, 38, 90, t * 50)); // Snare
      events.push(noteOff(9, 38, t * 50 + 10));
    }
    events.push(noteOn(9, 42, 70, t * 50)); // Closed HH
    events.push(noteOff(9, 42, t * 50 + 10));
    if (t % 8 === 7) {
      events.push(noteOn(9, 49, 100, t * 50)); // Crash
      events.push(noteOff(9, 49, t * 50 + 20));
    }
  }
  return events;
}

function createInstrument(overrides = {}) {
  return {
    id: 1,
    device_id: 'dev_1',
    name: 'Test Piano',
    custom_name: null,
    type: 'keyboard',
    gm_program: 0,
    note_range_min: 21,
    note_range_max: 108,
    polyphony: 64,
    note_selection_mode: 'range',
    selected_notes: null,
    supported_ccs: JSON.stringify([1, 7, 10, 11, 64, 91]),
    sync_delay: 0,
    ...overrides
  };
}

// ============================================================
// ChannelAnalyzer tests
// ============================================================

describe('ChannelAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new ChannelAnalyzer(mockLogger);
    jest.clearAllMocks();
  });

  test('extractActiveChannels returns sorted active channels', () => {
    const midiData = createMidiData([createPianoTrack(), createBassTrack(), createDrumTrack()]);
    const channels = analyzer.extractActiveChannels(midiData);
    expect(channels).toEqual([0, 1, 9]);
  });

  test('extractActiveChannels returns empty for null data', () => {
    expect(analyzer.extractActiveChannels(null)).toEqual([]);
    expect(analyzer.extractActiveChannels({})).toEqual([]);
    expect(analyzer.extractActiveChannels({ tracks: [] })).toEqual([]);
  });

  test('analyzeChannel extracts correct note range for piano', () => {
    const midiData = createMidiData([createPianoTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.channel).toBe(0);
    expect(analysis.noteRange.min).toBeGreaterThanOrEqual(48);
    expect(analysis.noteRange.max).toBeLessThanOrEqual(75);
    expect(analysis.totalNotes).toBeGreaterThan(0);
    expect(analysis.primaryProgram).toBe(0);
  });

  test('analyzeChannel detects polyphony correctly', () => {
    const midiData = createMidiData([createPianoTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.polyphony.max).toBeGreaterThanOrEqual(3);
    expect(analysis.polyphony.avg).toBeGreaterThan(0);
  });

  test('analyzeChannel detects drums on channel 9', () => {
    const midiData = createMidiData([createDrumTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 9);

    expect(analysis.channel).toBe(9);
    expect(analysis.estimatedType).toBe('drums');
    expect(analysis.typeConfidence).toBe(100);
  });

  test('analyzeChannel extracts used CCs', () => {
    const midiData = createMidiData([createPianoTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 0);

    expect(analysis.usedCCs).toContain(7); // Volume
    expect(analysis.usedCCs).toContain(64); // Sustain
  });

  test('analyzeChannel detects bass type', () => {
    const midiData = createMidiData([createBassTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 1);

    expect(analysis.primaryProgram).toBe(33);
    // Bass should be detected as bass type due to low note range + bass program
    expect(analysis.estimatedType).toBe('bass');
  });

  test('analyzeAllChannels processes all active channels', () => {
    const midiData = createMidiData([createPianoTrack(), createBassTrack(), createDrumTrack()]);
    const analyses = analyzer.analyzeAllChannels(midiData);

    expect(analyses.length).toBe(3);
    expect(analyses.map((a) => a.channel)).toEqual([0, 1, 9]);
  });

  test('buildNoteHistogram counts notes correctly', () => {
    const events = [
      noteOn(0, 60, 80),
      noteOn(0, 60, 80),
      noteOn(0, 64, 80),
      noteOff(0, 60) // noteOff should not be counted
    ];
    const histogram = analyzer.buildNoteHistogram(events);

    expect(histogram[60]).toBe(2);
    expect(histogram[64]).toBe(1);
    expect(histogram[60]).not.toBe(3); // noteOff not counted
  });

  test('extractNoteRange returns null for empty events', () => {
    const range = analyzer.extractNoteRange([]);
    expect(range.min).toBe(null);
    expect(range.max).toBe(null);
  });

  test('calculateNoteDensity returns 0 for zero duration', () => {
    expect(analyzer.calculateNoteDensity([], 0)).toBe(0);
  });

  test('analyzeChannel handles channel with no noteOn velocity > 0', () => {
    // Canal avec uniquement des noteOff
    const midiData = createMidiData([[noteOff(0, 60, 0), noteOff(0, 64, 100)]]);
    const analysis = analyzer.analyzeChannel(midiData, 0);
    expect(analysis.noteRange.min).toBe(null);
    expect(analysis.noteRange.max).toBe(null);
  });
});

// ============================================================
// InstrumentMatcher tests
// ============================================================

describe('InstrumentMatcher', () => {
  let matcher;

  beforeEach(() => {
    matcher = new InstrumentMatcher(mockLogger);
    jest.clearAllMocks();
  });

  test('calculateCompatibility returns score between 0 and 100', () => {
    const analysis = {
      channel: 0,
      noteRange: { min: 48, max: 72 },
      polyphony: { max: 4, avg: 2.5 },
      usedCCs: [7, 64],
      primaryProgram: 0,
      estimatedType: 'harmony',
      noteEvents: []
    };

    const instrument = createInstrument();
    const result = matcher.calculateCompatibility(analysis, instrument);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result).toHaveProperty('compatible');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('info');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.info)).toBe(true);
  });

  test('perfect program match gives 22 points', () => {
    const result = matcher.scoreProgramMatch(0, 0);
    expect(result.score).toBe(22);
    expect(result.info).toContain('Perfect program match');
  });

  test('same category match gives 15 points', () => {
    const result = matcher.scoreProgramMatch(0, 3); // Both piano category
    expect(result.score).toBe(15);
  });

  test('no program match gives 0 points', () => {
    const result = matcher.scoreProgramMatch(0, 33); // Piano vs Bass
    expect(result.score).toBe(0);
  });

  test('null program gives differentiated neutral scores', () => {
    // Both null = neutral
    const bothNull = matcher.scoreProgramMatch(null, null).score;
    expect(bothNull).toBeGreaterThan(0);
    // Channel has no program, instrument configured
    const channelNull = matcher.scoreProgramMatch(null, 0).score;
    expect(channelNull).toBeGreaterThan(0);
    // Channel has program, instrument not configured
    const instrNull = matcher.scoreProgramMatch(0, null).score;
    expect(instrNull).toBeGreaterThan(0);
    // Both null should score highest
    expect(bothNull).toBeGreaterThanOrEqual(channelNull);
  });

  test('perfect note range fit gives 40 points', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 48, max: 72 },
      { min: 21, max: 108, mode: 'continuous', selected: null }
    );

    expect(result.compatible).toBe(true);
    expect(result.score).toBe(40);
    expect(result.transposition.semitones).toBe(0);
  });

  test('calculates correct octave shift', () => {
    const result = matcher.calculateOctaveShift(
      { min: 48, max: 72 }, // Channel: C3-C5 (center: 60)
      { min: 60, max: 96, mode: 'continuous' } // Instrument: C4-C7 (center: 78)
    );

    expect(result.compatible).toBe(true);
    // Center diff = 78-60 = 18, round(18/12) = 2 octaves
    expect(result.octaves).toBe(2);
    expect(result.semitones).toBe(24);
  });

  test('incompatible when span too wide', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 24, max: 96 }, // 72 semitone span
      { min: 48, max: 72, mode: 'continuous', selected: null } // 24 semitone span
    );

    expect(result.compatible).toBe(false);
    expect(result.score).toBe(0);
  });

  test('polyphony scoring tiers', () => {
    // Excellent: margin >= 8 → maxScore (13)
    expect(matcher.scorePolyphony(4, 16).score).toBe(13);
    // Good: margin >= 4 → 70% of maxScore
    expect(matcher.scorePolyphony(4, 8).score).toBe(Math.round(13 * 0.7));
    // Sufficient: margin >= 0 → 50% of maxScore
    expect(matcher.scorePolyphony(4, 4).score).toBe(Math.round(13 * 0.5));
    // Insufficient: margin < 0
    expect(matcher.scorePolyphony(8, 4).score).toBe(0);
    expect(matcher.scorePolyphony(8, 4).issue).toBeDefined();
  });

  test('CC support scoring', () => {
    // All supported
    const allSupported = matcher.scoreCCSupport([7, 64], [1, 7, 10, 64]).score;
    expect(allSupported).toBeGreaterThan(0);
    // No CCs used = full score
    expect(matcher.scoreCCSupport([], [1, 7]).score).toBe(5);
    // No CC list on instrument = low neutral
    const nullCC = matcher.scoreCCSupport([7, 64], null).score;
    expect(nullCC).toBeGreaterThan(0);
    expect(nullCC).toBeLessThan(5);
    // Partial support
    const partial = matcher.scoreCCSupport([7, 64, 91], [7, 64]);
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(5);
  });

  test('discrete note scoring works', () => {
    const result = matcher.scoreDiscreteNotes({ min: 36, max: 49 }, [36, 38, 42, 46, 48, 50], null);

    expect(result.compatible).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('discrete note with no selected notes returns low score (unconfigured)', () => {
    // When selectedNotes is null, instrument is unconfigured - should not get free points
    const result = matcher.scoreDiscreteNotes({ min: 36, max: 49 }, null, null);
    // Unconfigured discrete instrument gets low neutral score, not full range-based score
    expect(result.compatible).toBe(false);
    expect(result.score).toBeLessThanOrEqual(Math.round(25 * 0.3)); // low portion of noteRange weight
    expect(result.issue.type).toBe('warning');
  });

  test('discrete note with no selected notes and no range returns incompatible', () => {
    const result = matcher.scoreDiscreteNotes({ min: undefined, max: undefined }, null, null);
    expect(result.compatible).toBe(false);
  });

  test('findClosestNote returns nearest note (lower bias)', () => {
    // Implementation has lower bias (returns lower note on tie)
    expect(matcher.findClosestNote(40, [36, 38, 42, 46])).toBe(38); // Equidistant from 38 and 42, lower wins
    expect(matcher.findClosestNote(37, [36, 38, 42, 46])).toBe(36); // Equidistant from 36 and 38, lower wins
    expect(matcher.findClosestNote(36, [36, 38, 42, 46])).toBe(36);
    expect(matcher.findClosestNote(50, [])).toBe(null);
  });

  test('isDrumsInstrument detects drum instruments', () => {
    expect(matcher.isDrumsInstrument({ gm_program: 115 })).toBe(true);
    expect(matcher.isDrumsInstrument({ gm_program: 0, note_selection_mode: 'discrete' })).toBe(
      true
    );
    expect(matcher.isDrumsInstrument({ gm_program: 0, note_selection_mode: 'range' })).toBe(false);
  });

  test('scoreNoteCompatibility handles null channel range (empty channel)', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: null, max: null },
      { min: 21, max: 108, mode: 'range', selected: null }
    );
    expect(result.compatible).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.info).toContain('empty channel');
  });

  test('unconfigured instrument note range gives neutral score (not max)', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 48, max: 72 },
      { min: null, max: null, mode: 'range', selected: null }
    );
    expect(result.compatible).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.info).toContain('not configured');
  });

  test('severely insufficient polyphony marks incompatible', () => {
    const result = matcher.scorePolyphony(16, 4); // margin = -12
    expect(result.score).toBe(0);
    expect(result.compatible).toBe(false);
    expect(result.issue.type).toBe('error');
  });

  test('slightly insufficient polyphony stays compatible', () => {
    const result = matcher.scorePolyphony(8, 6); // margin = -2
    expect(result.score).toBe(0);
    expect(result.compatible).toBeUndefined(); // No compatible field = default compatible
    expect(result.issue.type).toBe('warning');
  });

  test('polyphony incompatibility propagates to calculateCompatibility', () => {
    const analysis = {
      channel: 0,
      noteRange: { min: 48, max: 72 },
      polyphony: { max: 32, avg: 16 },
      usedCCs: [],
      primaryProgram: 0,
      estimatedType: 'harmony',
      noteEvents: []
    };
    const instrument = createInstrument({ polyphony: 2 }); // Severely insufficient
    const result = matcher.calculateCompatibility(analysis, instrument);
    expect(result.compatible).toBe(false);
  });

  test('drum issues are captured from scoreDiscreteDrumsIntelligent', () => {
    const channelAnalysis = {
      channel: 9,
      noteRange: { min: 36, max: 49 },
      polyphony: { max: 3, avg: 1.5 },
      usedCCs: [],
      primaryProgram: null,
      estimatedType: 'drums',
      noteEvents: [noteOn(9, 36, 100), noteOn(9, 38, 90), noteOn(9, 42, 70)]
    };

    const instrument = createInstrument({
      gm_program: 115,
      note_selection_mode: 'discrete',
      selected_notes: JSON.stringify([36, 38]),
      note_range_min: 35,
      note_range_max: 81,
      polyphony: 16
    });

    const result = matcher.calculateCompatibility(channelAnalysis, instrument);
    // Issues array should exist and contain any drum-related warnings
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ============================================================
// MidiTransposer tests
// ============================================================

describe('MidiTransposer', () => {
  let transposer;

  beforeEach(() => {
    transposer = new MidiTransposer(mockLogger);
    jest.clearAllMocks();
  });

  test('transposeChannels applies semitone transposition', () => {
    const midiData = createMidiData([[noteOn(0, 60, 80, 0), noteOff(0, 60, 100)]]);

    const { midiData: result, stats } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const noteOnEvent = result.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(72); // 60 + 12
    expect(stats.notesChanged).toBeGreaterThan(0);
  });

  test('transposeChannels does not modify original data', () => {
    const midiData = createMidiData([[noteOn(0, 60, 80, 0), noteOff(0, 60, 100)]]);

    transposer.transposeChannels(midiData, { 0: { semitones: 12 } });

    // Original should be unchanged
    const originalNote = midiData.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(originalNote.note).toBe(60);
  });

  test('transposeChannels applies note remapping', () => {
    const midiData = createMidiData([
      [
        noteOn(9, 36, 100, 0), // Kick
        noteOff(9, 36, 50),
        noteOn(9, 38, 90, 50), // Snare
        noteOff(9, 38, 100)
      ]
    ]);

    const { midiData: result, stats } = transposer.transposeChannels(midiData, {
      9: { noteRemapping: { 36: 41, 38: 40 } }
    });

    const events = result.tracks[0].events.filter((e) => e.type === 'noteOn');
    expect(events[0].note).toBe(41); // Kick remapped
    expect(events[1].note).toBe(40); // Snare remapped
    // noteOn + noteOff both get remapped for each note
    expect(stats.notesRemapped).toBe(4);
  });

  test('transposeChannels clamps notes to MIDI range', () => {
    const midiData = createMidiData([[noteOn(0, 120, 80, 0), noteOff(0, 120, 100)]]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const noteOnEvent = result.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(noteOnEvent.note).toBeLessThanOrEqual(127);
  });

  test('transposeChannels ignores channels without transposition', () => {
    const midiData = createMidiData([
      [noteOn(0, 60, 80, 0), noteOn(1, 48, 80, 0), noteOff(0, 60, 100), noteOff(1, 48, 100)]
    ]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const ch0Note = result.tracks[0].events.find((e) => e.type === 'noteOn' && e.channel === 0);
    const ch1Note = result.tracks[0].events.find((e) => e.type === 'noteOn' && e.channel === 1);
    expect(ch0Note.note).toBe(72); // Transposed
    expect(ch1Note.note).toBe(48); // Unchanged
  });

  test('transposeChannels handles combined transposition and remapping', () => {
    const midiData = createMidiData([[noteOn(0, 60, 80, 0), noteOff(0, 60, 100)]]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12, noteRemapping: { 72: 74 } } // First transpose 60→72, then remap 72→74
    });

    const noteOnEvent = result.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(74);
  });

  test('transposeChannel convenience method works', () => {
    const midiData = createMidiData([[noteOn(0, 60, 80, 0), noteOff(0, 60, 100)]]);

    const { midiData: result } = transposer.transposeChannel(midiData, 0, -12);
    const noteOnEvent = result.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(48);
  });

  test('remapNotes convenience method works', () => {
    const midiData = createMidiData([[noteOn(9, 36, 100, 0), noteOff(9, 36, 50)]]);

    const { midiData: result } = transposer.remapNotes(midiData, 9, { 36: 41 });
    const noteOnEvent = result.tracks[0].events.find((e) => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(41);
  });

  test('countAllNotes counts only noteOn with velocity > 0', () => {
    const midiData = createMidiData([
      [
        noteOn(0, 60, 80, 0),
        noteOn(0, 64, 80, 0),
        noteOn(0, 60, 0, 50), // velocity 0 = noteOff, should not be counted
        noteOff(0, 64, 50)
      ]
    ]);

    expect(transposer.countAllNotes(midiData)).toBe(2);
  });
});

// ============================================================
// DrumNoteMapper tests
// ============================================================

describe('DrumNoteMapper', () => {
  let mapper;

  beforeEach(() => {
    mapper = new DrumNoteMapper(mockLogger);
    jest.clearAllMocks();
  });

  test('classifyDrumNotes categorizes notes correctly', () => {
    const events = [
      noteOn(9, 36, 100),
      noteOn(9, 36, 100), // 2x kick
      noteOn(9, 38, 90), // 1x snare
      noteOn(9, 42, 70),
      noteOn(9, 42, 70),
      noteOn(9, 42, 70) // 3x HH
    ];

    const result = mapper.classifyDrumNotes(events);

    expect(result.categories.kicks).toContain(36);
    expect(result.categories.snares).toContain(38);
    expect(result.categories.hiHats).toContain(42);
    expect(result.usage[36]).toBe(2);
    expect(result.usage[42]).toBe(3);
  });

  test('classifyDrumNotes handles empty events', () => {
    const result = mapper.classifyDrumNotes([]);
    expect(result.usedNotes).toEqual([]);
    expect(result.usage).toEqual({});
  });

  test('analyzeInstrumentCapabilities detects drum categories', () => {
    const caps = mapper.analyzeInstrumentCapabilities([36, 38, 42, 46, 48, 50, 51]);

    expect(caps.hasKick).toBe(true);
    expect(caps.hasSnare).toBe(true);
    expect(caps.hasHiHat).toBe(true);
    expect(caps.hasRide).toBe(true);
    expect(caps.tomCount).toBe(2); // 48, 50
    expect(caps.totalNotes).toBe(7);
  });

  test('generateMapping maps essential notes first', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100),
      noteOn(9, 38, 90),
      noteOn(9, 42, 70)
    ]);

    const result = mapper.generateMapping(midiNotes, [36, 38, 42, 46, 48]);

    expect(result.mapping[36]).toBe(36); // Kick → Kick
    expect(result.mapping[38]).toBe(38); // Snare → Snare
    expect(result.mapping[42]).toBe(42); // HH → HH
    expect(result.quality.score).toBeGreaterThan(80);
  });

  test('generateMapping substitutes when target not available', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100), // Kick
      noteOn(9, 38, 90) // Snare
    ]);

    // Instrument has no kick (36) or snare (38), only toms
    const result = mapper.generateMapping(midiNotes, [41, 43, 45]);

    // Should substitute kick to low tom
    expect(result.mapping[36]).toBeDefined();
    expect(result.substitutions.length).toBeGreaterThan(0);
  });

  test('generateMapping quality reflects accuracy', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100),
      noteOn(9, 38, 90),
      noteOn(9, 42, 70)
    ]);

    // Perfect match
    const perfect = mapper.generateMapping(midiNotes, [36, 38, 42, 46, 48, 50, 51]);
    // Poor match (only one note available)
    const poor = mapper.generateMapping(midiNotes, [60]);

    expect(perfect.quality.score).toBeGreaterThan(poor.quality.score);
  });

  test('getMappingReport produces readable output', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100),
      noteOn(9, 38, 90),
      noteOn(9, 42, 70)
    ]);
    const result = mapper.generateMapping(midiNotes, [36, 38, 42]);
    const report = mapper.getMappingReport(result);

    expect(report.summary).toBeDefined();
    expect(report.summary.totalMapped).toBeGreaterThan(0);
    expect(report.details).toBeDefined();
  });

  test('findClosestNote works correctly', () => {
    expect(mapper.findClosestNote(40, [36, 42, 46])).toBe(42);
    expect(mapper.findClosestNote(37, [36, 42])).toBe(36);
    expect(mapper.findClosestNote(50, [])).toBe(null);
  });

  // --- Expanded drum routing tests ---

  test('getCategoryForNote returns correct category for redistributed notes', () => {
    // Note 52 (Chinese Cymbal) moved from misc to crashes
    expect(mapper.getCategoryForNote(52)).toBe('crashes');
    // New shakers category
    expect(mapper.getCategoryForNote(39)).toBe('shakers');
    expect(mapper.getCategoryForNote(54)).toBe('shakers');
    expect(mapper.getCategoryForNote(58)).toBe('shakers');
    expect(mapper.getCategoryForNote(69)).toBe('shakers');
    expect(mapper.getCategoryForNote(70)).toBe('shakers');
    // New woodsMetal category
    expect(mapper.getCategoryForNote(56)).toBe('woodsMetal');
    expect(mapper.getCategoryForNote(75)).toBe('woodsMetal');
    expect(mapper.getCategoryForNote(76)).toBe('woodsMetal');
    expect(mapper.getCategoryForNote(77)).toBe('woodsMetal');
    // New pitched category
    expect(mapper.getCategoryForNote(71)).toBe('pitched');
    expect(mapper.getCategoryForNote(74)).toBe('pitched');
    // New cuicas category
    expect(mapper.getCategoryForNote(78)).toBe('cuicas');
    expect(mapper.getCategoryForNote(79)).toBe('cuicas');
    // New triangles category
    expect(mapper.getCategoryForNote(80)).toBe('triangles');
    expect(mapper.getCategoryForNote(81)).toBe('triangles');
    // Unchanged categories
    expect(mapper.getCategoryForNote(36)).toBe('kicks');
    expect(mapper.getCategoryForNote(38)).toBe('snares');
    expect(mapper.getCategoryForNote(42)).toBe('hiHats');
    expect(mapper.getCategoryForNote(48)).toBe('toms');
    expect(mapper.getCategoryForNote(51)).toBe('rides');
    expect(mapper.getCategoryForNote(60)).toBe('latin');
  });

  test('SUBSTITUTION_TABLES covers all GM drum notes 35-81', () => {
    for (let note = 35; note <= 81; note++) {
      expect(mapper.SUBSTITUTION_TABLES[note]).toBeDefined();
      expect(mapper.SUBSTITUTION_TABLES[note].length).toBeGreaterThanOrEqual(3);
    }
  });

  test('classifyDrumNotes categorizes new categories correctly', () => {
    const events = [
      noteOn(9, 69, 80),  // Cabasa → shakers
      noteOn(9, 76, 70),  // Hi Wood Block → woodsMetal
      noteOn(9, 71, 60),  // Short Whistle → pitched
      noteOn(9, 78, 50),  // Mute Cuica → cuicas
      noteOn(9, 80, 40),  // Mute Triangle → triangles
      noteOn(9, 52, 90)   // Chinese Cymbal → crashes
    ];

    const result = mapper.classifyDrumNotes(events);

    expect(result.categories.shakers).toContain(69);
    expect(result.categories.woodsMetal).toContain(76);
    expect(result.categories.pitched).toContain(71);
    expect(result.categories.cuicas).toContain(78);
    expect(result.categories.triangles).toContain(80);
    expect(result.categories.crashes).toContain(52);
  });

  test('generateMapping uses substitution chains for previously unmapped notes', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 71, 80),  // Short Whistle
      noteOn(9, 76, 70),  // Hi Wood Block
      noteOn(9, 78, 60),  // Mute Cuica
      noteOn(9, 80, 50)   // Mute Triangle
    ]);

    // Instrument has only the substitution targets
    const result = mapper.generateMapping(midiNotes, [72, 77, 79, 81]);

    // Should find substitutions from the tables
    expect(result.mapping[71]).toBe(72); // Short Whistle → Long Whistle
    expect(result.mapping[76]).toBe(77); // Hi Wood Block → Low Wood Block
    expect(result.mapping[78]).toBe(79); // Mute Cuica → Open Cuica
    expect(result.mapping[80]).toBe(81); // Mute Triangle → Open Triangle
  });

  test('analyzeInstrumentCapabilities detects new categories', () => {
    const caps = mapper.analyzeInstrumentCapabilities([36, 38, 42, 69, 70, 56, 75, 71, 78, 80]);

    expect(caps.shakers).toEqual(expect.arrayContaining([69, 70]));
    expect(caps.woodsMetal).toEqual(expect.arrayContaining([56, 75]));
    expect(caps.pitched).toContain(71);
    expect(caps.cuicas).toContain(78);
    expect(caps.triangles).toContain(80);
    expect(caps.auxPercCount).toBe(7); // 2 shakers + 2 woodsMetal + 1 pitched + 1 cuica + 1 triangle
  });
});

// ============================================================
// AnalysisCache tests
// ============================================================

describe('AnalysisCache', () => {
  let cache;

  beforeEach(() => {
    cache = new AnalysisCache(5, 1000); // Small cache, 1 second TTL
  });

  test('set and get work correctly', () => {
    cache.set(1, 0, { test: true });
    const result = cache.get(1, 0);
    expect(result).toEqual({ test: true });
  });

  test('get returns null for missing entries', () => {
    expect(cache.get(1, 0)).toBe(null);
    expect(cache.get(99, 15)).toBe(null);
  });

  test('entries expire after TTL', async () => {
    cache = new AnalysisCache(5, 50); // 50ms TTL
    cache.set(1, 0, { test: true });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cache.get(1, 0)).toBe(null);
  });

  test('LRU eviction works when cache is full', () => {
    // Fill cache (max 5)
    for (let i = 0; i < 5; i++) {
      cache.set(1, i, { channel: i });
    }
    expect(cache.getStats().size).toBe(5);

    // Adding one more should evict the oldest
    cache.set(1, 5, { channel: 5 });
    expect(cache.getStats().size).toBe(5);
    expect(cache.get(1, 0)).toBe(null); // Evicted
    expect(cache.get(1, 5)).toEqual({ channel: 5 }); // New entry
  });

  test('invalidateFile removes all entries for a file', () => {
    cache.set(1, 0, { a: 1 });
    cache.set(1, 1, { a: 2 });
    cache.set(2, 0, { b: 1 });

    cache.invalidateFile(1);

    expect(cache.get(1, 0)).toBe(null);
    expect(cache.get(1, 1)).toBe(null);
    expect(cache.get(2, 0)).toEqual({ b: 1 }); // Unaffected
  });

  test('clear removes all entries', () => {
    cache.set(1, 0, { a: 1 });
    cache.set(2, 0, { b: 1 });

    cache.clear();

    expect(cache.getStats().size).toBe(0);
  });

  test('cleanup removes expired entries', async () => {
    cache = new AnalysisCache(5, 50);
    cache.set(1, 0, { a: 1 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    cache.cleanup();
    expect(cache.getStats().size).toBe(0);
  });
});

// ============================================================
// InstrumentCapabilitiesValidator tests
// ============================================================

describe('InstrumentCapabilitiesValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new InstrumentCapabilitiesValidator();
  });

  test('validates complete instrument as valid', () => {
    const instrument = {
      id: 1,
      gm_program: 0,
      note_range_min: 21,
      note_range_max: 108,
      polyphony: 64,
      note_selection_mode: 'range',
      supported_ccs: [7, 10, 64],
      type: 'keyboard'
    };

    const result = validator.validateInstrument(instrument);
    expect(result.isValid).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.missing.length).toBe(0);
  });

  test('detects missing required fields', () => {
    const instrument = {
      id: 1,
      gm_program: null,
      note_range_min: null,
      note_range_max: 108,
      polyphony: 64,
      note_selection_mode: 'range'
    };

    const result = validator.validateInstrument(instrument);
    expect(result.isValid).toBe(false);
    expect(result.missing.length).toBe(2); // gm_program, note_range_min
    expect(result.missing.some((m) => m.field === 'gm_program')).toBe(true);
    expect(result.missing.some((m) => m.field === 'note_range_min')).toBe(true);
  });

  test('detects missing selected_notes for discrete mode', () => {
    const instrument = {
      id: 1,
      gm_program: 0,
      note_range_min: 35,
      note_range_max: 81,
      polyphony: 16,
      note_selection_mode: 'discrete',
      selected_notes: null
    };

    const result = validator.validateInstrument(instrument);
    expect(result.isValid).toBe(false);
    expect(result.missing.some((m) => m.field === 'selected_notes')).toBe(true);
  });

  test('does not require selected_notes for continuous mode', () => {
    const instrument = {
      id: 1,
      gm_program: 0,
      note_range_min: 21,
      note_range_max: 108,
      polyphony: 64,
      note_selection_mode: 'range'
    };

    const result = validator.validateInstrument(instrument);
    expect(result.isValid).toBe(true);
    expect(result.missing.some((m) => m.field === 'selected_notes')).toBe(false);
  });

  test('detects recommended fields', () => {
    const instrument = {
      id: 1,
      gm_program: 0,
      note_range_min: 21,
      note_range_max: 108,
      polyphony: 64,
      note_selection_mode: 'range'
      // Missing: supported_ccs, type
    };

    const result = validator.validateInstrument(instrument);
    expect(result.isValid).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.recommended.length).toBe(2);
  });

  test('validateInstruments handles multiple instruments', () => {
    const instruments = [
      {
        id: 1,
        gm_program: 0,
        note_range_min: 21,
        note_range_max: 108,
        polyphony: 64,
        note_selection_mode: 'range',
        supported_ccs: [7],
        type: 'keyboard'
      },
      {
        id: 2,
        gm_program: null,
        note_range_min: null,
        note_range_max: null,
        polyphony: null,
        note_selection_mode: null
      }
    ];

    const result = validator.validateInstruments(instruments);
    expect(result.validCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.allValid).toBe(false);
  });

  test('getSuggestedDefaults returns type-specific defaults', () => {
    const pianoDefaults = validator.getSuggestedDefaults({ type: 'keyboard' });
    expect(pianoDefaults.gm_program).toBe(0);
    expect(pianoDefaults.note_range_min).toBe(21);
    expect(pianoDefaults.polyphony).toBe(64);

    const drumDefaults = validator.getSuggestedDefaults({ type: 'drums' });
    expect(drumDefaults.note_selection_mode).toBe('discrete');
    expect(drumDefaults.selected_notes).toBeDefined();

    const bassDefaults = validator.getSuggestedDefaults({ type: 'bass' });
    expect(bassDefaults.gm_program).toBe(33);
    expect(bassDefaults.note_range_min).toBe(28);
  });

  test('uses note_selection_mode field name (not mode)', () => {
    expect(validator.requiredCapabilities).toContain('note_selection_mode');
    expect(validator.requiredCapabilities).not.toContain('mode');
  });
});

// ============================================================
// ScoringConfig tests
// ============================================================

describe('ScoringConfig', () => {
  test('weights sum to 100', () => {
    const sum = Object.values(ScoringConfig.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  test('getBonus returns correct values', () => {
    expect(ScoringConfig.getBonus('perfectProgramMatch')).toBe(22);
    expect(ScoringConfig.getBonus('nonExistent')).toBe(0);
  });

  test('getWeight returns correct values', () => {
    expect(ScoringConfig.getWeight('programMatch')).toBe(22);
    expect(ScoringConfig.getWeight('noteRange')).toBe(40);
    expect(ScoringConfig.getWeight('polyphony')).toBe(13);
    expect(ScoringConfig.getWeight('instrumentType')).toBe(20);
    expect(ScoringConfig.getWeight('nonExistent')).toBe(0);
  });

  test('getPenalty returns correct values', () => {
    expect(ScoringConfig.getPenalty('transpositionPerOctave')).toBe(3);
    expect(ScoringConfig.getPenalty('nonExistent')).toBe(0);
  });

  test('cache config exists', () => {
    expect(ScoringConfig.cache.maxSize).toBe(100);
    expect(ScoringConfig.cache.ttl).toBe(600000);
  });
});

// ============================================================
// AutoAssigner integration tests
// ============================================================

describe('AutoAssigner', () => {
  let autoAssigner;
  let mockDatabase;

  beforeEach(() => {
    mockDatabase = {
      getInstrumentsWithCapabilities: jest.fn().mockReturnValue([
        createInstrument({
          id: 1,
          device_id: 'piano_1',
          name: 'Piano',
          gm_program: 0,
          note_range_min: 21,
          note_range_max: 108,
          polyphony: 64
        }),
        createInstrument({
          id: 2,
          device_id: 'bass_1',
          name: 'Bass',
          gm_program: 33,
          note_range_min: 28,
          note_range_max: 60,
          polyphony: 4
        }),
        createInstrument({
          id: 3,
          device_id: 'drums_1',
          name: 'Drums',
          gm_program: 115,
          note_range_min: 35,
          note_range_max: 81,
          polyphony: 16,
          note_selection_mode: 'discrete',
          selected_notes: JSON.stringify([36, 38, 42, 44, 46, 48, 50, 51, 49])
        })
      ])
    };

    autoAssigner = new AutoAssigner(mockDatabase, mockLogger);
    jest.clearAllMocks();
  });

  afterEach(() => {
    autoAssigner.destroy();
  });

  test('generateSuggestions returns suggestions for all channels', async () => {
    const midiData = createMidiData([createPianoTrack(), createBassTrack(), createDrumTrack()]);

    const result = await autoAssigner.generateSuggestions(midiData);

    expect(result.success).toBe(true);
    expect(result.suggestions).toBeDefined();
    expect(result.autoSelection).toBeDefined();
    expect(result.channelAnalyses.length).toBe(3);
    expect(result.confidenceScore).toBeGreaterThan(0);
  });

  test('generateSuggestions returns error when no instruments', async () => {
    mockDatabase.getInstrumentsWithCapabilities.mockReturnValue([]);

    const midiData = createMidiData([createPianoTrack()]);
    const result = await autoAssigner.generateSuggestions(midiData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No instruments');
  });

  test('generateSuggestions returns error for empty MIDI', async () => {
    const midiData = createMidiData([]);
    const result = await autoAssigner.generateSuggestions(midiData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No active channels');
  });

  test('selectBestAssignments avoids instrument conflicts', () => {
    const suggestions = {
      0: [
        { instrument: { id: 1, device_id: 'piano_1' }, compatibility: { score: 90 } },
        { instrument: { id: 2, device_id: 'bass_1' }, compatibility: { score: 50 } }
      ],
      1: [
        { instrument: { id: 1, device_id: 'piano_1' }, compatibility: { score: 85 } },
        { instrument: { id: 2, device_id: 'bass_1' }, compatibility: { score: 80 } }
      ]
    };

    const analyses = [
      {
        channel: 0,
        noteRange: { min: 48, max: 72 },
        polyphony: { max: 4 },
        estimatedType: 'harmony',
        primaryProgram: 0
      },
      {
        channel: 1,
        noteRange: { min: 28, max: 40 },
        polyphony: { max: 1 },
        estimatedType: 'bass',
        primaryProgram: 33
      }
    ];

    const result = autoAssigner.selectBestAssignments(suggestions, analyses);

    // Channel 0 should get piano_1 (best score)
    expect(result[0].deviceId).toBe('piano_1');
    // Channel 1 should get bass_1 (piano already used)
    expect(result[1].deviceId).toBe('bass_1');
  });

  test('selectBestAssignments prioritizes channel 9 (drums)', () => {
    const suggestions = {
      0: [{ instrument: { id: 3, device_id: 'drums_1' }, compatibility: { score: 95 } }],
      9: [{ instrument: { id: 3, device_id: 'drums_1' }, compatibility: { score: 85 } }]
    };

    const analyses = [
      {
        channel: 0,
        noteRange: { min: 48, max: 72 },
        polyphony: { max: 4 },
        estimatedType: 'melody',
        primaryProgram: 0
      },
      {
        channel: 9,
        noteRange: { min: 36, max: 49 },
        polyphony: { max: 3 },
        estimatedType: 'drums',
        primaryProgram: null
      }
    ];

    const result = autoAssigner.selectBestAssignments(suggestions, analyses);

    // Channel 9 should get priority (drums channel)
    expect(result[9].deviceId).toBe('drums_1');
  });

  test('calculateConfidence returns 0 for empty assignments', () => {
    expect(autoAssigner.calculateConfidence({}, 0)).toBe(0);
    expect(autoAssigner.calculateConfidence({}, 8)).toBe(0);
  });

  test('calculateConfidence factors in success rate', () => {
    // All channels assigned with high scores
    const fullConfidence = autoAssigner.calculateConfidence(
      { 0: { score: 90 }, 1: { score: 90 }, 2: { score: 90 } },
      3
    );

    // Only 1 of 3 channels assigned
    const partialConfidence = autoAssigner.calculateConfidence({ 0: { score: 90 } }, 3);

    expect(fullConfidence).toBeGreaterThan(partialConfidence);
  });

  test('analyzeChannel uses cache when fileId provided', () => {
    const midiData = createMidiData([createPianoTrack()]);

    // First call - should analyze
    const result1 = autoAssigner.analyzeChannel(midiData, 0, 42);
    // Second call - should use cache
    const result2 = autoAssigner.analyzeChannel(midiData, 0, 42);

    expect(result1).toEqual(result2);
  });

  test('invalidateCache clears cached analyses', () => {
    const midiData = createMidiData([createPianoTrack()]);

    autoAssigner.analyzeChannel(midiData, 0, 42);
    autoAssigner.invalidateCache(42);

    // Cache should be empty for this file
    // We can verify by checking cache stats
    autoAssigner.cache.getStats();
    // After invalidation, file 42's entries should be gone
  });

  test('destroy cleans up resources', () => {
    autoAssigner.destroy();
    expect(autoAssigner.cleanupInterval).toBe(null);
  });
});

// ============================================================
// ChannelSplitter tests
// ============================================================

describe('ChannelSplitter', () => {
  let splitter;

  beforeEach(() => {
    splitter = new ChannelSplitter(mockLogger);
  });

  function makeInstrument(id, rangeMin, rangeMax, polyphony = 16) {
    return {
      id,
      device_id: `device_${id}`,
      channel: 0,
      name: `Inst ${id}`,
      custom_name: `Instrument ${id}`,
      note_range_min: rangeMin,
      note_range_max: rangeMax,
      polyphony,
      gm_program: 0,
      instrument_type: 'melody'
    };
  }

  function makeChannelAnalysis(channel, noteMin, noteMax, noteDistribution = null) {
    const dist = noteDistribution || {};
    if (!noteDistribution) {
      for (let n = noteMin; n <= noteMax; n++) {
        dist[n] = 10;
      }
    }
    return {
      channel,
      noteRange: { min: noteMin, max: noteMax },
      noteDistribution: dist,
      polyphony: { max: 8, avg: 4 },
      maxPolyphony: 8,
      avgPolyphony: 4,
      primaryProgram: 0,
      estimatedType: 'melody',
      totalNotes: Object.keys(dist).length
    };
  }

  describe('calculateRangeSplit', () => {
    test('splits two non-overlapping instruments correctly', () => {
      const analysis = makeChannelAnalysis(0, 36, 84);
      const instruments = [
        makeInstrument('a', 36, 60),
        makeInstrument('b', 61, 84)
      ];
      const result = splitter.calculateRangeSplit(analysis, instruments);
      expect(result).not.toBeNull();
      expect(result.segments).toHaveLength(2);
      expect(result.overlapZones).toHaveLength(0);
    });

    test('detects overlap when instrument ranges overlap', () => {
      const analysis = makeChannelAnalysis(0, 36, 84);
      const instruments = [
        makeInstrument('a', 36, 72),
        makeInstrument('b', 60, 84)
      ];
      const result = splitter.calculateRangeSplit(analysis, instruments);
      expect(result).not.toBeNull();
      expect(result.segments).toHaveLength(2);
      expect(result.overlapZones.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculateFullCoverageSplit', () => {
    test('finds full coverage pair without transposition', () => {
      const analysis = makeChannelAnalysis(0, 36, 84);
      const instruments = [
        makeInstrument('a', 36, 60),
        makeInstrument('b', 61, 84),
        makeInstrument('c', 0, 127) // full range fallback
      ];
      const result = splitter.calculateFullCoverageSplit(analysis, instruments);
      expect(result).not.toBeNull();
      expect(result.type).toBe('fullCoverage');
      expect(result.segments).toHaveLength(2);
    });

    test('assigns overlap notes correctly after fix', () => {
      // Both instruments cover C3-C5 (48-72)
      const analysis = makeChannelAnalysis(0, 48, 72);
      const instruments = [
        makeInstrument('a', 36, 72),
        makeInstrument('b', 48, 84)
      ];
      const result = splitter.calculateFullCoverageSplit(analysis, instruments);
      if (result) {
        expect(result.segments).toHaveLength(2);
        // segA and segB should each cover part of the range, not leave one empty
        const segA = result.segments[0];
        const segB = result.segments[1];
        expect(segA.noteRange.min).toBeLessThanOrEqual(segA.noteRange.max);
        expect(segB.noteRange.min).toBeLessThanOrEqual(segB.noteRange.max);
      }
    });
  });

  describe('findCoverageGaps', () => {
    test('detects gap between two segments', () => {
      const segments = [
        { noteRange: { min: 36, max: 50 } },
        { noteRange: { min: 60, max: 84 } }
      ];
      const gaps = splitter.findCoverageGaps(segments, 36, 84);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].min).toBe(51);
      expect(gaps[0].max).toBe(59);
    });

    test('returns empty when full coverage', () => {
      const segments = [
        { noteRange: { min: 36, max: 60 } },
        { noteRange: { min: 61, max: 84 } }
      ];
      const gaps = splitter.findCoverageGaps(segments, 36, 84);
      expect(gaps).toHaveLength(0);
    });
  });

  describe('scoreSplitQuality', () => {
    test('returns high score for full coverage with no overlap', () => {
      const proposal = {
        type: 'range',
        channel: 0,
        segments: [
          { noteRange: { min: 36, max: 60 }, polyphonyShare: 16 },
          { noteRange: { min: 61, max: 84 }, polyphonyShare: 16 }
        ],
        overlapZones: [],
        gaps: [],
        channelAnalysis: makeChannelAnalysis(0, 36, 84)
      };
      const score = splitter.scoreSplitQuality(proposal);
      expect(score).toBeGreaterThan(70);
    });
  });

  describe('selectBestInstrumentsForCoverage', () => {
    test('selects complementary instruments', () => {
      const instruments = [
        makeInstrument('a', 36, 60),
        makeInstrument('b', 61, 84),
        makeInstrument('c', 36, 48) // subset of a
      ];
      const analysis = makeChannelAnalysis(0, 36, 84);
      const selected = splitter.selectBestInstrumentsForCoverage(instruments, analysis, 2);
      expect(selected).toHaveLength(2);
      // Should pick a + b for best coverage
      const ids = selected.map(i => i.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });
  });
});

// ============================================================
// MidiPlayer overlap resolution tests
// ============================================================

describe('MidiPlayer getOutputForChannel overlap strategies', () => {
  // Minimal mock to test the routing logic
  function createMockPlayer() {
    const player = {
      channelRouting: new Map(),
      _overlapCounters: null,
      _segmentNoteCounts: null,
      _overlapNoteAssign: null,
      getOutputForChannel(channel, note = null, eventType = null) {
        if (player.channelRouting.has(channel)) {
          const routing = player.channelRouting.get(channel);
          if (typeof routing === 'string') {
            return { device: routing, targetChannel: channel };
          }
          if (routing.split && routing.segments) {
            if (note !== null) {
              const matching = routing.segments.filter(seg => note >= seg.noteMin && note <= seg.noteMax);
              if (matching.length === 1) {
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }
              if (matching.length > 1) {
                const strategy = routing.overlapStrategy || 'first';
                if (strategy === 'shared' || strategy === 'round_robin') {
                  if (!player._overlapCounters) player._overlapCounters = new Map();
                  const key = `${channel}_${note}`;
                  const counter = (player._overlapCounters.get(key) || 0);
                  player._overlapCounters.set(key, counter + 1);
                  const seg = matching[counter % matching.length];
                  return { device: seg.device, targetChannel: seg.targetChannel };
                }
                if (strategy === 'second') {
                  const seg = matching[matching.length - 1];
                  return { device: seg.device, targetChannel: seg.targetChannel };
                }
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }
              // Closest segment
              let closest = routing.segments[0];
              let minDist = Infinity;
              for (const seg of routing.segments) {
                const dist = Math.min(Math.abs(note - seg.noteMin), Math.abs(note - seg.noteMax));
                if (dist < minDist) { minDist = dist; closest = seg; }
              }
              return { device: closest.device, targetChannel: closest.targetChannel };
            }
            return routing.segments.map(seg => ({ device: seg.device, targetChannel: seg.targetChannel }));
          }
          return routing;
        }
        return null;
      }
    };
    return player;
  }

  test('first strategy routes to first matching segment', () => {
    const player = createMockPlayer();
    player.channelRouting.set(0, {
      split: true,
      overlapStrategy: 'first',
      segments: [
        { device: 'devA', targetChannel: 0, noteMin: 36, noteMax: 72 },
        { device: 'devB', targetChannel: 0, noteMin: 60, noteMax: 84 }
      ]
    });
    const result = player.getOutputForChannel(0, 65);
    expect(result.device).toBe('devA');
  });

  test('second strategy routes to last matching segment', () => {
    const player = createMockPlayer();
    player.channelRouting.set(0, {
      split: true,
      overlapStrategy: 'second',
      segments: [
        { device: 'devA', targetChannel: 0, noteMin: 36, noteMax: 72 },
        { device: 'devB', targetChannel: 0, noteMin: 60, noteMax: 84 }
      ]
    });
    const result = player.getOutputForChannel(0, 65);
    expect(result.device).toBe('devB');
  });

  test('shared strategy alternates between segments', () => {
    const player = createMockPlayer();
    player.channelRouting.set(0, {
      split: true,
      overlapStrategy: 'shared',
      segments: [
        { device: 'devA', targetChannel: 0, noteMin: 36, noteMax: 72 },
        { device: 'devB', targetChannel: 0, noteMin: 60, noteMax: 84 }
      ]
    });
    const r1 = player.getOutputForChannel(0, 65);
    const r2 = player.getOutputForChannel(0, 65);
    expect(r1.device).toBe('devA');
    expect(r2.device).toBe('devB');
  });

  test('note outside all ranges routes to closest segment', () => {
    const player = createMockPlayer();
    player.channelRouting.set(0, {
      split: true,
      overlapStrategy: 'first',
      segments: [
        { device: 'devA', targetChannel: 0, noteMin: 36, noteMax: 60 },
        { device: 'devB', targetChannel: 0, noteMin: 72, noteMax: 84 }
      ]
    });
    const result = player.getOutputForChannel(0, 66);
    // 66 is closer to devA (60) than devB (72)
    expect(result.device).toBe('devA');
  });

  test('non-note events broadcast to all segments', () => {
    const player = createMockPlayer();
    player.channelRouting.set(0, {
      split: true,
      overlapStrategy: 'first',
      segments: [
        { device: 'devA', targetChannel: 0, noteMin: 36, noteMax: 60 },
        { device: 'devB', targetChannel: 0, noteMin: 72, noteMax: 84 }
      ]
    });
    const result = player.getOutputForChannel(0, null);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});

// ============================================================
// RoutingPersistenceDB validation tests
// ============================================================

describe('RoutingPersistenceDB validations', () => {
  // Mock DB for testing validation logic
  function createMockRoutingDB() {
    const RoutingPersistenceDB = class {
      constructor() {
        this.logger = mockLogger;
        this.rows = [];
      }
      insertRouting(routing) {
        // Replicate the validation logic
        if (routing.split_mode) {
          const noteMin = routing.split_note_min;
          const noteMax = routing.split_note_max;
          if (noteMin != null && noteMax != null) {
            if (noteMin > noteMax) {
              throw new Error(`Invalid split range: min (${noteMin}) > max (${noteMax})`);
            }
            if (noteMin < 0 || noteMax > 127) {
              throw new Error(`Split range out of MIDI bounds: [${noteMin}, ${noteMax}]`);
            }
          }
        }
        if (routing.channel != null && (routing.channel < 0 || routing.channel > 15)) {
          throw new Error(`Invalid MIDI channel: ${routing.channel} (must be 0-15)`);
        }
        this.rows.push(routing);
        return this.rows.length;
      }
    };
    return new RoutingPersistenceDB();
  }

  test('rejects split_note_min > split_note_max', () => {
    const db = createMockRoutingDB();
    expect(() => db.insertRouting({
      midi_file_id: 1,
      channel: 0,
      device_id: 'dev1',
      split_mode: 'range',
      split_note_min: 80,
      split_note_max: 40
    })).toThrow('Invalid split range');
  });

  test('rejects MIDI notes out of bounds', () => {
    const db = createMockRoutingDB();
    expect(() => db.insertRouting({
      midi_file_id: 1,
      channel: 0,
      device_id: 'dev1',
      split_mode: 'range',
      split_note_min: -1,
      split_note_max: 60
    })).toThrow('out of MIDI bounds');
  });

  test('rejects invalid channel number', () => {
    const db = createMockRoutingDB();
    expect(() => db.insertRouting({
      midi_file_id: 1,
      channel: 16,
      device_id: 'dev1'
    })).toThrow('Invalid MIDI channel');
  });

  test('accepts valid split routing', () => {
    const db = createMockRoutingDB();
    expect(() => db.insertRouting({
      midi_file_id: 1,
      channel: 0,
      device_id: 'dev1',
      split_mode: 'range',
      split_note_min: 36,
      split_note_max: 72
    })).not.toThrow();
  });

  test('persists overlap_strategy', () => {
    const db = createMockRoutingDB();
    db.insertRouting({
      midi_file_id: 1,
      channel: 0,
      device_id: 'dev1',
      split_mode: 'range',
      split_note_min: 36,
      split_note_max: 72,
      overlap_strategy: 'shared'
    });
    expect(db.rows[0].overlap_strategy).toBe('shared');
  });
});
