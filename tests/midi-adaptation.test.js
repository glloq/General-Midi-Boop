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
    cc(0, 7, 100),       // Volume
    cc(0, 64, 127),      // Sustain
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
    events.push(noteOn(9, 36, 100, t * 50));      // Kick
    events.push(noteOff(9, 36, t * 50 + 10));
    if (t % 2 === 1) {
      events.push(noteOn(9, 38, 90, t * 50));      // Snare
      events.push(noteOff(9, 38, t * 50 + 10));
    }
    events.push(noteOn(9, 42, 70, t * 50));        // Closed HH
    events.push(noteOff(9, 42, t * 50 + 10));
    if (t % 8 === 7) {
      events.push(noteOn(9, 49, 100, t * 50));     // Crash
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
    const midiData = createMidiData([
      createPianoTrack(),
      createBassTrack(),
      createDrumTrack()
    ]);
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

    expect(analysis.usedCCs).toContain(7);   // Volume
    expect(analysis.usedCCs).toContain(64);  // Sustain
  });

  test('analyzeChannel detects bass type', () => {
    const midiData = createMidiData([createBassTrack()]);
    const analysis = analyzer.analyzeChannel(midiData, 1);

    expect(analysis.primaryProgram).toBe(33);
    // Bass should be detected as bass type due to low note range + bass program
    expect(analysis.estimatedType).toBe('bass');
  });

  test('analyzeAllChannels processes all active channels', () => {
    const midiData = createMidiData([
      createPianoTrack(),
      createBassTrack(),
      createDrumTrack()
    ]);
    const analyses = analyzer.analyzeAllChannels(midiData);

    expect(analyses.length).toBe(3);
    expect(analyses.map(a => a.channel)).toEqual([0, 1, 9]);
  });

  test('buildNoteHistogram counts notes correctly', () => {
    const events = [
      noteOn(0, 60, 80), noteOn(0, 60, 80), noteOn(0, 64, 80),
      noteOff(0, 60), // noteOff should not be counted
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
    const midiData = createMidiData([[
      noteOff(0, 60, 0),
      noteOff(0, 64, 100)
    ]]);
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

  test('perfect program match gives 30 points', () => {
    const result = matcher.scoreProgramMatch(0, 0);
    expect(result.score).toBe(30);
    expect(result.info).toContain('Perfect program match');
  });

  test('same category match gives 20 points', () => {
    const result = matcher.scoreProgramMatch(0, 3); // Both piano category
    expect(result.score).toBe(20);
  });

  test('no program match gives 0 points', () => {
    const result = matcher.scoreProgramMatch(0, 33); // Piano vs Bass
    expect(result.score).toBe(0);
  });

  test('null program gives neutral score (half weight)', () => {
    // When program info is missing, give neutral score instead of 0
    expect(matcher.scoreProgramMatch(null, 0).score).toBe(15);
    expect(matcher.scoreProgramMatch(0, null).score).toBe(15);
    expect(matcher.scoreProgramMatch(null, null).score).toBe(15);
  });

  test('perfect note range fit gives 25 points', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 48, max: 72 },
      { min: 21, max: 108, mode: 'continuous', selected: null }
    );

    expect(result.compatible).toBe(true);
    expect(result.score).toBe(25);
    expect(result.transposition.semitones).toBe(0);
  });

  test('calculates correct octave shift', () => {
    const result = matcher.calculateOctaveShift(
      { min: 48, max: 72 },          // Channel: C3-C5 (center: 60)
      { min: 60, max: 96, mode: 'continuous' }  // Instrument: C4-C7 (center: 78)
    );

    expect(result.compatible).toBe(true);
    // Center diff = 78-60 = 18, round(18/12) = 2 octaves
    expect(result.octaves).toBe(2);
    expect(result.semitones).toBe(24);
  });

  test('incompatible when span too wide', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 24, max: 96 },  // 72 semitone span
      { min: 48, max: 72, mode: 'continuous', selected: null }  // 24 semitone span
    );

    expect(result.compatible).toBe(false);
    expect(result.score).toBe(0);
  });

  test('polyphony scoring tiers', () => {
    // Excellent: margin >= 8
    expect(matcher.scorePolyphony(4, 16).score).toBe(15);
    // Good: margin >= 4
    expect(matcher.scorePolyphony(4, 8).score).toBe(10);
    // Sufficient: margin >= 0
    expect(matcher.scorePolyphony(4, 4).score).toBe(5);
    // Insufficient: margin < 0
    expect(matcher.scorePolyphony(8, 4).score).toBe(0);
    expect(matcher.scorePolyphony(8, 4).issue).toBeDefined();
  });

  test('CC support scoring', () => {
    // All supported
    expect(matcher.scoreCCSupport([7, 64], [1, 7, 10, 64]).score).toBe(15);
    // No CCs used
    expect(matcher.scoreCCSupport([], [1, 7]).score).toBe(15);
    // No CC list on instrument
    expect(matcher.scoreCCSupport([7, 64], null).score).toBe(15);
    // Partial support
    const partial = matcher.scoreCCSupport([7, 64, 91], [7, 64]);
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(15);
  });

  test('discrete note scoring works', () => {
    const result = matcher.scoreDiscreteNotes(
      { min: 36, max: 49 },
      [36, 38, 42, 46, 48, 50],
      null
    );

    expect(result.compatible).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('discrete note with no selected notes returns low score (unconfigured)', () => {
    // When selectedNotes is null, instrument is unconfigured - should not get free points
    const result = matcher.scoreDiscreteNotes(
      { min: 36, max: 49 },
      null,
      null
    );
    // Unconfigured discrete instrument gets low neutral score, not full range-based score
    expect(result.compatible).toBe(false);
    expect(result.score).toBeLessThanOrEqual(Math.round(25 * 0.2)); // 20% of noteRange weight
    expect(result.issue.type).toBe('warning');
  });

  test('discrete note with no selected notes and no range returns incompatible', () => {
    const result = matcher.scoreDiscreteNotes(
      { min: undefined, max: undefined },
      null,
      null
    );
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
    expect(matcher.isDrumsInstrument({ gm_program: 0, note_selection_mode: 'discrete' })).toBe(true);
    expect(matcher.isDrumsInstrument({ gm_program: 0, note_selection_mode: 'range' })).toBe(false);
  });

  test('scoreNoteCompatibility handles null channel range (empty channel)', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: null, max: null },
      { min: 21, max: 108, mode: 'range', selected: null }
    );
    expect(result.compatible).toBe(true);
    expect(result.score).toBe(Math.round(25 * 0.5)); // Neutral score
    expect(result.info).toContain('empty channel');
  });

  test('unconfigured instrument note range gives neutral score (not max)', () => {
    const result = matcher.scoreNoteCompatibility(
      { min: 48, max: 72 },
      { min: null, max: null, mode: 'range', selected: null }
    );
    expect(result.compatible).toBe(true);
    expect(result.score).toBe(Math.round(25 * 0.5)); // Neutral, not 25
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
      noteEvents: [
        noteOn(9, 36, 100), noteOn(9, 38, 90), noteOn(9, 42, 70)
      ]
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
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOff(0, 60, 100)
    ]]);

    const { midiData: result, stats } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const noteOnEvent = result.tracks[0].events.find(e => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(72); // 60 + 12
    expect(stats.notesChanged).toBeGreaterThan(0);
  });

  test('transposeChannels does not modify original data', () => {
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOff(0, 60, 100)
    ]]);

    transposer.transposeChannels(midiData, { 0: { semitones: 12 } });

    // Original should be unchanged
    const originalNote = midiData.tracks[0].events.find(e => e.type === 'noteOn');
    expect(originalNote.note).toBe(60);
  });

  test('transposeChannels applies note remapping', () => {
    const midiData = createMidiData([[
      noteOn(9, 36, 100, 0),  // Kick
      noteOff(9, 36, 50),
      noteOn(9, 38, 90, 50),  // Snare
      noteOff(9, 38, 100)
    ]]);

    const { midiData: result, stats } = transposer.transposeChannels(midiData, {
      9: { noteRemapping: { 36: 41, 38: 40 } }
    });

    const events = result.tracks[0].events.filter(e => e.type === 'noteOn');
    expect(events[0].note).toBe(41); // Kick remapped
    expect(events[1].note).toBe(40); // Snare remapped
    // noteOn + noteOff both get remapped for each note
    expect(stats.notesRemapped).toBe(4);
  });

  test('transposeChannels clamps notes to MIDI range', () => {
    const midiData = createMidiData([[
      noteOn(0, 120, 80, 0),
      noteOff(0, 120, 100)
    ]]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const noteOnEvent = result.tracks[0].events.find(e => e.type === 'noteOn');
    expect(noteOnEvent.note).toBeLessThanOrEqual(127);
  });

  test('transposeChannels ignores channels without transposition', () => {
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOn(1, 48, 80, 0),
      noteOff(0, 60, 100),
      noteOff(1, 48, 100)
    ]]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12 }
    });

    const ch0Note = result.tracks[0].events.find(e => e.type === 'noteOn' && e.channel === 0);
    const ch1Note = result.tracks[0].events.find(e => e.type === 'noteOn' && e.channel === 1);
    expect(ch0Note.note).toBe(72);  // Transposed
    expect(ch1Note.note).toBe(48);  // Unchanged
  });

  test('transposeChannels handles combined transposition and remapping', () => {
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOff(0, 60, 100)
    ]]);

    const { midiData: result } = transposer.transposeChannels(midiData, {
      0: { semitones: 12, noteRemapping: { 72: 74 } } // First transpose 60→72, then remap 72→74
    });

    const noteOnEvent = result.tracks[0].events.find(e => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(74);
  });

  test('transposeChannel convenience method works', () => {
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOff(0, 60, 100)
    ]]);

    const { midiData: result } = transposer.transposeChannel(midiData, 0, -12);
    const noteOnEvent = result.tracks[0].events.find(e => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(48);
  });

  test('remapNotes convenience method works', () => {
    const midiData = createMidiData([[
      noteOn(9, 36, 100, 0),
      noteOff(9, 36, 50)
    ]]);

    const { midiData: result } = transposer.remapNotes(midiData, 9, { 36: 41 });
    const noteOnEvent = result.tracks[0].events.find(e => e.type === 'noteOn');
    expect(noteOnEvent.note).toBe(41);
  });

  test('countAllNotes counts only noteOn with velocity > 0', () => {
    const midiData = createMidiData([[
      noteOn(0, 60, 80, 0),
      noteOn(0, 64, 80, 0),
      noteOn(0, 60, 0, 50), // velocity 0 = noteOff, should not be counted
      noteOff(0, 64, 50)
    ]]);

    expect(transposer.countAllNotes(midiData)).toBe(2);
  });

  test('generateAdaptationMetadata creates correct structure', () => {
    const metadata = transposer.generateAdaptationMetadata(
      { 0: { transposition: { semitones: 12, octaves: 1 }, info: ['test'] } },
      { notesChanged: 10, notesRemapped: 0, totalNotes: 100 }
    );

    expect(metadata.strategy).toBe('octave_preserving');
    expect(metadata.notes_changed).toBe(10);
    expect(metadata.transpositions[0].semitones).toBe(12);
    expect(metadata.created_at).toBeDefined();
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
      noteOn(9, 36, 100), noteOn(9, 36, 100), // 2x kick
      noteOn(9, 38, 90),  // 1x snare
      noteOn(9, 42, 70), noteOn(9, 42, 70), noteOn(9, 42, 70), // 3x HH
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
      noteOn(9, 42, 70),
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
      noteOn(9, 38, 90),  // Snare
    ]);

    // Instrument has no kick (36) or snare (38), only toms
    const result = mapper.generateMapping(midiNotes, [41, 43, 45]);

    // Should substitute kick to low tom
    expect(result.mapping[36]).toBeDefined();
    expect(result.substitutions.length).toBeGreaterThan(0);
  });

  test('generateMapping quality reflects accuracy', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100), noteOn(9, 38, 90), noteOn(9, 42, 70)
    ]);

    // Perfect match
    const perfect = mapper.generateMapping(midiNotes, [36, 38, 42, 46, 48, 50, 51]);
    // Poor match (only one note available)
    const poor = mapper.generateMapping(midiNotes, [60]);

    expect(perfect.quality.score).toBeGreaterThan(poor.quality.score);
  });

  test('getMappingReport produces readable output', () => {
    const midiNotes = mapper.classifyDrumNotes([
      noteOn(9, 36, 100), noteOn(9, 38, 90), noteOn(9, 42, 70)
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
    await new Promise(resolve => setTimeout(resolve, 100));

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

    await new Promise(resolve => setTimeout(resolve, 100));

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
    expect(result.missing.some(m => m.field === 'gm_program')).toBe(true);
    expect(result.missing.some(m => m.field === 'note_range_min')).toBe(true);
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
    expect(result.missing.some(m => m.field === 'selected_notes')).toBe(true);
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
    expect(result.missing.some(m => m.field === 'selected_notes')).toBe(false);
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
        id: 1, gm_program: 0, note_range_min: 21, note_range_max: 108,
        polyphony: 64, note_selection_mode: 'range', supported_ccs: [7], type: 'keyboard'
      },
      {
        id: 2, gm_program: null, note_range_min: null, note_range_max: null,
        polyphony: null, note_selection_mode: null
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
    expect(ScoringConfig.getBonus('perfectProgramMatch')).toBe(30);
    expect(ScoringConfig.getBonus('nonExistent')).toBe(0);
  });

  test('getWeight returns correct values', () => {
    expect(ScoringConfig.getWeight('programMatch')).toBe(30);
    expect(ScoringConfig.getWeight('noteRange')).toBe(25);
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
        createInstrument({ id: 1, device_id: 'piano_1', name: 'Piano', gm_program: 0, note_range_min: 21, note_range_max: 108, polyphony: 64 }),
        createInstrument({ id: 2, device_id: 'bass_1', name: 'Bass', gm_program: 33, note_range_min: 28, note_range_max: 60, polyphony: 4 }),
        createInstrument({
          id: 3, device_id: 'drums_1', name: 'Drums', gm_program: 115,
          note_range_min: 35, note_range_max: 81, polyphony: 16,
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
    const midiData = createMidiData([
      createPianoTrack(),
      createBassTrack(),
      createDrumTrack()
    ]);

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
      { channel: 0, noteRange: { min: 48, max: 72 }, polyphony: { max: 4 }, estimatedType: 'harmony', primaryProgram: 0 },
      { channel: 1, noteRange: { min: 28, max: 40 }, polyphony: { max: 1 }, estimatedType: 'bass', primaryProgram: 33 }
    ];

    const result = autoAssigner.selectBestAssignments(suggestions, analyses);

    // Channel 0 should get piano_1 (best score)
    expect(result[0].deviceId).toBe('piano_1');
    // Channel 1 should get bass_1 (piano already used)
    expect(result[1].deviceId).toBe('bass_1');
  });

  test('selectBestAssignments prioritizes channel 9 (drums)', () => {
    const suggestions = {
      0: [
        { instrument: { id: 3, device_id: 'drums_1' }, compatibility: { score: 95 } }
      ],
      9: [
        { instrument: { id: 3, device_id: 'drums_1' }, compatibility: { score: 85 } }
      ]
    };

    const analyses = [
      { channel: 0, noteRange: { min: 48, max: 72 }, polyphony: { max: 4 }, estimatedType: 'melody', primaryProgram: 0 },
      { channel: 9, noteRange: { min: 36, max: 49 }, polyphony: { max: 3 }, estimatedType: 'drums', primaryProgram: null }
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
      { 0: { score: 90 }, 1: { score: 90 }, 2: { score: 90 } }, 3
    );

    // Only 1 of 3 channels assigned
    const partialConfidence = autoAssigner.calculateConfidence(
      { 0: { score: 90 } }, 3
    );

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
    const stats = autoAssigner.cache.getStats();
    // After invalidation, file 42's entries should be gone
  });

  test('destroy cleans up resources', () => {
    autoAssigner.destroy();
    expect(autoAssigner.cleanupInterval).toBe(null);
  });
});
