/**
 * @file tests/transcription/gm-mapping.test.js
 * @description The two label tables of §15/§16. The single most important
 * property of both: an unknown label resolves to NOTHING, never to a
 * plausible default — GMB's own adaptation layer handles "unknown" better
 * than a confident wrong answer.
 */
import { describe, test, expect } from '@jest/globals';
import {
  resolveInstrumentClass,
  normalizeLabel,
  isDrumLabel,
  INSTRUMENT_CLASS_TO_PROGRAM
} from '../../src/transcription/gm/InstrumentClassMap.js';
import {
  resolveDrumLabel,
  mapDrumNote,
  isGmDrumNote,
  normalizeDrumLabel,
  DRUM_LABEL_TO_NOTE,
  GM_DRUM_CHANNEL,
  GM_DRUM_NOTE_MIN,
  GM_DRUM_NOTE_MAX
} from '../../src/transcription/gm/DrumMapper.js';
import { getFamilyForProgram } from '../../src/midi/gm/InstrumentFamilies.js';

describe('label normalisation', () => {
  test('strips the decorations engines add', () => {
    expect(normalizeLabel('Track 3 - Electric_Piano (solo)')).toBe('electric piano');
    expect(normalizeLabel('ACOUSTIC-GUITAR')).toBe('acoustic guitar');
    expect(normalizeLabel('  Violin  ')).toBe('violin');
    expect(normalizeLabel(42)).toBe('');
    expect(normalizeLabel(null)).toBe('');
  });
});

describe('instrument class → GM program', () => {
  test('resolves the labels engines actually emit', () => {
    expect(resolveInstrumentClass('piano').program).toBe(0);
    expect(resolveInstrumentClass('Electric Bass').program).toBe(33);
    expect(resolveInstrumentClass('VOICE').program).toBe(53);
    expect(resolveInstrumentClass('cello').program).toBe(42);
    expect(resolveInstrumentClass('Alto Sax').program).toBe(65);
  });

  test('an unknown label resolves to null — no plausible-looking piano', () => {
    expect(resolveInstrumentClass('theremin-ish thing')).toBeNull();
    expect(resolveInstrumentClass('')).toBeNull();
    expect(resolveInstrumentClass(null)).toBeNull();
    expect(resolveInstrumentClass('unknown')).toBeNull();
  });

  test('falls back to keywords, most specific first', () => {
    expect(resolveInstrumentClass('lead electric guitar solo')).toMatchObject({
      program: 27,
      matchedBy: 'keyword:electric guitar'
    });
    // "electric bass" must not be shadowed by the bare "bass" keyword.
    expect(resolveInstrumentClass('muted bass line').program).toBe(33);
    expect(resolveInstrumentClass('some strings here').program).toBe(48);
  });

  test('tolerates singular/plural drift', () => {
    expect(resolveInstrumentClass('vocals').program).toBe(53);
    expect(resolveInstrumentClass('string').program).toBe(48);
  });

  test('percussion is never given a melodic program', () => {
    for (const label of ['drums', 'Drum Kit', 'percussion', 'kick']) {
      expect(resolveInstrumentClass(label)).toBeNull();
    }
  });

  test('every program in the table is a valid GM program in a known family', () => {
    for (const [label, program] of Object.entries(INSTRUMENT_CLASS_TO_PROGRAM)) {
      expect(Number.isInteger(program)).toBe(true);
      expect(program).toBeGreaterThanOrEqual(0);
      expect(program).toBeLessThanOrEqual(127);
      expect(getFamilyForProgram(program, null)).not.toBeNull();
      expect(label).toBe(label.toLowerCase());
    }
  });

  test('reports the GMB family slug, reusing the shared taxonomy', () => {
    expect(resolveInstrumentClass('violin').familySlug).toBe('bowed_strings');
    expect(resolveInstrumentClass('piano').familySlug).toBe('keyboards');
  });
});

describe('drum label detection', () => {
  test('recognises percussion labels', () => {
    for (const label of ['drums', 'Drum Kit', 'DRUMSET'.toLowerCase(), 'percussion', 'beats']) {
      expect(isDrumLabel(label)).toBe(true);
    }
  });

  test('does not mistake a melodic instrument for a drum', () => {
    for (const label of ['trombone', 'tom waits tribute band'.replace('tom ', ''), 'piano']) {
      expect(isDrumLabel(label)).toBe(false);
    }
  });
});

describe('drum label → GM note', () => {
  test('maps the standard kit', () => {
    expect(resolveDrumLabel('kick').note).toBe(36);
    expect(resolveDrumLabel('Snare').note).toBe(38);
    expect(resolveDrumLabel('closed hi-hat').note).toBe(42);
    expect(resolveDrumLabel('open hihat').note).toBe(46);
    expect(resolveDrumLabel('crash').note).toBe(49);
    expect(resolveDrumLabel('ride cymbal').note).toBe(51);
    expect(resolveDrumLabel('clap').note).toBe(39);
    expect(resolveDrumLabel('floor tom').note).toBe(43);
  });

  test('an unknown percussion label resolves to null', () => {
    expect(resolveDrumLabel('spoons')).toBeNull();
    expect(resolveDrumLabel('')).toBeNull();
    expect(resolveDrumLabel(undefined)).toBeNull();
  });

  test('every note in the table is inside the GM percussion range', () => {
    for (const note of Object.values(DRUM_LABEL_TO_NOTE)) {
      expect(isGmDrumNote(note)).toBe(true);
    }
    expect(GM_DRUM_CHANNEL).toBe(9);
    expect(isGmDrumNote(GM_DRUM_NOTE_MIN)).toBe(true);
    expect(isGmDrumNote(GM_DRUM_NOTE_MAX)).toBe(true);
    expect(isGmDrumNote(34)).toBe(false);
    expect(isGmDrumNote(82)).toBe(false);
  });

  test('normalises punctuation the way the melodic table does', () => {
    expect(normalizeDrumLabel('Closed_Hi-Hat (soft)')).toBe('closed hi hat');
  });
});

describe('mapDrumNote resolution order', () => {
  test('the hit label wins over everything', () => {
    expect(mapDrumNote({ pitch: 60, label: 'snare' }, { trackLabel: 'kick' })).toEqual({
      note: 38,
      matchedBy: 'label:exact'
    });
  });

  test('falls back to the track label', () => {
    expect(mapDrumNote({ pitch: 7 }, { trackLabel: 'Kick drum' })).toEqual({
      note: 36,
      matchedBy: 'track:exact'
    });
  });

  test('then to a pitch that is already GM percussion', () => {
    expect(mapDrumNote({ pitch: 42 }, { trackLabel: 'Percussion' })).toEqual({
      note: 42,
      matchedBy: 'pitch'
    });
  });

  test('and reports "unmapped" rather than inventing a hit', () => {
    expect(mapDrumNote({ pitch: 3 }, {})).toEqual({ note: null, matchedBy: 'unmapped' });
    expect(mapDrumNote(null, {})).toEqual({ note: null, matchedBy: 'unmapped' });
  });

  test('accepts the `drum` spelling some engines use', () => {
    expect(mapDrumNote({ pitch: 0, drum: 'cowbell' }).note).toBe(56);
  });
});
