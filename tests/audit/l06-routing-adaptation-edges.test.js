/**
 * @file tests/audit/l06-routing-adaptation-edges.test.js
 * @description Lot L06 — cas limites §G (routage), §H (adaptation),
 * §I (familles d'instruments) et §J (mains / faisabilité) que l'audit du
 * 2026-08-22 laissait explicitement `NOT TESTED` :
 *
 *   G02 : aucun candidat · plusieurs candidats à égalité · instrument absent
 *   G03 : conflit de canal (deux canaux, un seul instrument)
 *   H01 : fichier entièrement hors plage · instrument à UNE seule note ·
 *         plage plus étroite qu'une octave
 *   H03 : parité de la victime de polyphonie live ↔ offline
 *   H02 : gamme vide (plage trop étroite pour la gamme)
 *   I07 : famille « vents » — la monophonie n'est tenue par PERSONNE
 *   J05 : `independent_fingers` — honnêteté de l'auto-déclaration EXPERIMENTAL
 */
import { describe, test, expect } from '@jest/globals';
import AutoAssigner from '../../src/midi/adaptation/AutoAssigner.js';
import MidiTransposer from '../../src/midi/adaptation/MidiTransposer.js';
import InstrumentMatcher from '../../src/midi/adaptation/InstrumentMatcher.js';
import HandPositionPlanner from '../../src/midi/adaptation/HandPositionPlanner.js';
import InstrumentCapabilitiesValidator from '../../src/midi/adaptation/InstrumentCapabilitiesValidator.js';
import InstrumentTypeConfig from '../../src/midi/adaptation/InstrumentTypeConfig.js';
import {
  foldIntoRange,
  clampNote,
  selectPolyphonyVictim,
  NoteGate
} from '../../src/midi/adaptation/NoteEnforcement.js';
import { scaleNotes } from '../../src/midi/adaptation/ScaleSnapper.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function analysis({ channel = 0, min = 60, max = 72, program = 0, poly = 1 } = {}) {
  return {
    channel,
    primaryProgram: program,
    bankMSB: null,
    bankLSB: null,
    noteRange: { min, max },
    polyphony: { max: poly, avg: poly },
    usedCCs: [],
    estimatedType: 'keyboard',
    typeConfidence: 1,
    typeScores: {},
    estimatedCategory: null,
    estimatedSubtype: null,
    timingAnalysis: null,
    totalNotes: 100
  };
}

function option(id, score, extra = {}) {
  return {
    instrument: {
      id,
      device_id: id,
      channel: 0,
      name: id,
      custom_name: null,
      gm_program: 0,
      note_range_min: 21,
      note_range_max: 108,
      note_selection_mode: 'range',
      polyphony: 16,
      sync_delay: 0,
      supported_ccs: null,
      instrument_type: 'keyboard',
      ...extra
    },
    compatibility: {
      score,
      transposition: 0,
      noteRemapping: null,
      issues: [],
      info: []
    }
  };
}

// ---------------------------------------------------------------------------
// §G — routage / auto-assignation
// ---------------------------------------------------------------------------

describe('L06 · §G02 — auto-assignation : branches non testées', () => {
  const assigner = () =>
    new AutoAssigner({ getInstrumentsWithCapabilities: () => [] }, silentLogger);

  test('aucun candidat sur un canal → le canal est auto-skippé, pas assigné', () => {
    const res = assigner().selectBestAssignments({ 3: [] }, [analysis({ channel: 3 })]);
    expect(res[3]).toBeUndefined();
    expect(res._autoSkipped).toContain(3);
  });

  test('plusieurs candidats STRICTEMENT à égalité → départage déterministe et stable', () => {
    // Le tri est `b.score - a.score` sur un tri stable (ES2019) : à score égal,
    // l'ordre d'entrée l'emporte — et l'ordre d'entrée vient du SQL
    // `ORDER BY name, custom_name`. C'est déterministe mais IMPLICITE.
    const opts = [option('alpha', 80), option('beta', 80), option('gamma', 80)];
    const a = assigner();
    const first = a.selectBestAssignments({ 0: opts }, [analysis()]);
    const second = a.selectBestAssignments({ 0: [...opts] }, [analysis()]);
    expect(first[0].instrumentId).toBe('alpha');
    expect(second[0].instrumentId).toBe('alpha');
  });

  test('instrument absent de la liste disponible → il ne peut jamais être choisi', () => {
    const res = assigner().selectBestAssignments({ 0: [option('present', 70)] }, [analysis()]);
    expect(res[0].instrumentId).toBe('present');
  });
});

describe('L06 · §G03 — conflit de canal : deux canaux pour un seul instrument', () => {
  test('le second canal partage l’instrument et subit la pénalité de partage', () => {
    const a = new AutoAssigner({ getInstrumentsWithCapabilities: () => [] }, silentLogger);
    const only = option('solo', 90);
    const res = a.selectBestAssignments({ 0: [only], 1: [option('solo', 85)] }, [
      analysis({ channel: 0 }),
      analysis({ channel: 1 })
    ]);
    const assigned = [res[0], res[1]];
    // Les deux canaux sont servis, un seul en exclusivité.
    expect(assigned.every((x) => x && x.instrumentId === 'solo')).toBe(true);
    expect(assigned.filter((x) => x.shared === true)).toHaveLength(1);
    const shared = assigned.find((x) => x.shared);
    expect(shared.score).toBeLessThan(shared.scoreBeforePenalty);
    expect(shared.sharedWith.length).toBeGreaterThan(0);
    expect(res._autoSkipped).toEqual([]);
  });

  test('le canal 9 (batterie) est toujours servi en premier', () => {
    const a = new AutoAssigner({ getInstrumentsWithCapabilities: () => [] }, silentLogger);
    const res = a.selectBestAssignments({ 0: [option('kit', 95)], 9: [option('kit', 60)] }, [
      analysis({ channel: 0 }),
      analysis({ channel: 9 })
    ]);
    // Malgré son score inférieur, le canal 9 obtient l'instrument en exclusivité.
    expect(res[9].shared).toBe(false);
    expect(res[0].shared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §H — adaptation
// ---------------------------------------------------------------------------

describe('L06 · §H01 — repli de plage : cas limites', () => {
  const transposer = new MidiTransposer(silentLogger);

  test('instrument à UNE seule note : tout le fichier converge sur cette note', () => {
    for (const n of [0, 30, 59, 60, 61, 90, 127]) {
      expect(foldIntoRange(n, 60, 60)).toBe(60);
      expect(transposer.compressNoteToRange(n, 60, 60)).toBe(60);
    }
  });

  test('fichier entièrement hors plage : aucune note ne sort de la fenêtre', () => {
    // Plage grave d'un instrument mécanique, fichier écrit deux octaves plus haut.
    for (let n = 96; n <= 120; n++) {
      const runtime = foldIntoRange(n, 36, 48);
      const offline = transposer.compressNoteToRange(n, 36, 48);
      expect(runtime).toBeGreaterThanOrEqual(36);
      expect(runtime).toBeLessThanOrEqual(48);
      expect(offline).toBe(runtime); // parité live ↔ baké
    }
  });

  test('plage plus étroite qu’une octave : parité live ↔ offline sur les 128 notes', () => {
    for (let n = 0; n <= 127; n++) {
      expect(foldIntoRange(n, 60, 66)).toBe(transposer.compressNoteToRange(n, 60, 66));
    }
  });

  test('plage mal configurée (min > max) : la note est laissée intacte, pas de boucle infinie', () => {
    expect(foldIntoRange(64, 80, 40)).toBe(64);
  });
});

describe('L06 · §H02 — gamme : cas limites', () => {
  test('gamme vide (plage trop étroite pour contenir un degré) → la note est conservée', () => {
    // Do# à Ré# ne contient aucun degré de la pentatonique de Do.
    expect(scaleNotes(61, 63, 'pentatonic', 0)).toEqual([62]);
    const empty = scaleNotes(61, 61, 'pentatonic', 0);
    expect(empty).toEqual([]);
    // clampNote ne doit alors RIEN changer (garde `inScale.length > 0`).
    expect(
      clampNote(61, {
        noteRangeMin: 61,
        noteRangeMax: 61,
        octaveMode: 'pentatonic',
        scaleRoot: 0,
        selectedNotes: null
      })
    ).toBe(61);
  });

  test('selected_notes entièrement hors de la plage déclarée → repli sans échappée', () => {
    const out = clampNote(70, {
      noteRangeMin: 60,
      noteRangeMax: 66,
      selectedNotes: [100, 101]
    });
    expect(out).toBeGreaterThanOrEqual(60);
    expect(out).toBeLessThanOrEqual(66);
  });
});

describe('L06 · §H03 — réduction de polyphonie : parité live ↔ offline', () => {
  test('la victime est la voix médiane des deux côtés (politique keep-outer)', () => {
    const sounding = [48, 55, 60, 64, 67];
    expect(selectPolyphonyVictim(sounding)).toBe(60);
    // Même politique côté offline : `MidiTransposer.transposeChannels` trie les
    // voix actives et retire `sorted[floor(len/2)]`.
    const sorted = [...sounding].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBe(selectPolyphonyVictim(sounding));
  });

  test('au plafond, la note entrante médiane est simplement bloquée', () => {
    const gate = new NoteGate();
    const c = { polyphony: 2, minNoteInterval: null };
    expect(gate.noteOn('d', 0, 40, c, 0).gate).toBe(false);
    expect(gate.noteOn('d', 0, 80, c, 1).gate).toBe(false);
    // 60 est la médiane de [40,60,80] → elle est la victime, donc bloquée.
    const third = gate.noteOn('d', 0, 60, c, 2);
    expect(third.gate).toBe(true);
    expect(third.evictNote).toBeNull();
  });

  test('au plafond, une note extrême évince la voix médiane déjà tenue', () => {
    const gate = new NoteGate();
    const c = { polyphony: 2, minNoteInterval: null };
    gate.noteOn('d', 0, 60, c, 0);
    gate.noteOn('d', 0, 64, c, 1);
    const third = gate.noteOn('d', 0, 90, c, 2); // médiane de [60,64,90] = 64
    expect(third.gate).toBe(false);
    expect(third.evictNote).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// §I — familles d'instruments
// ---------------------------------------------------------------------------

describe('L06 · §I07 — famille « vents » : la monophonie n’est tenue par personne', () => {
  test('la taxonomie connaît bien la famille des vents', () => {
    expect(InstrumentTypeConfig.families.winds).toEqual(
      expect.arrayContaining(['brass', 'reed', 'pipe'])
    );
    expect(InstrumentTypeConfig.detectTypeFromProgram(73).type).toBe('pipe'); // flûte
    expect(InstrumentTypeConfig.detectTypeFromProgram(56).type).toBe('brass'); // trompette
  });

  test('un instrument à vent sans polyphony explicite laisse passer un accord entier', () => {
    // Le moteur ne connaît que `instruments_latency.polyphony`. Rien ne dérive
    // la monophonie de la famille ni de `gm-instrument-capabilities.json`.
    const gate = new NoteGate();
    const fluteWithoutExplicitPolyphony = { polyphony: null, minNoteInterval: null };
    const chord = [60, 64, 67, 72];
    for (const n of chord) {
      expect(gate.noteOn('flute', 0, n, fluteWithoutExplicitPolyphony, 0).gate).toBe(false);
    }
    // Avec polyphony=1 saisi À LA MAIN, la contrainte s'applique enfin.
    const mono = new NoteGate();
    const monoC = { polyphony: 1, minNoteInterval: null };
    expect(mono.noteOn('flute', 0, 60, monoC, 0).gate).toBe(false);
    expect(mono.noteOn('flute', 0, 64, monoC, 1).gate).toBe(true);
  });

  test('le scoring pénalise déjà un canal polyphonique sur un instrument monophonique', () => {
    const matcher = new InstrumentMatcher(silentLogger);
    const inst = {
      device_id: 'w',
      channel: 0,
      gm_program: 73,
      polyphony: 1,
      note_range_min: 60,
      note_range_max: 96,
      note_selection_mode: 'range',
      selected_notes: null,
      supported_ccs: null
    };
    const mono = matcher.calculateCompatibility(analysis({ program: 73, poly: 1 }), inst).score;
    const poly = matcher.calculateCompatibility(analysis({ program: 73, poly: 6 }), inst).score;
    expect(poly).toBeLessThan(mono);
  });
});

// ---------------------------------------------------------------------------
// §J — mains / faisabilité
// ---------------------------------------------------------------------------

describe('L06 · §J05 — independent_fingers : auto-déclaration EXPERIMENTAL honnête', () => {
  test('le planner refuse de planifier le mécanisme V2', () => {
    expect(
      () =>
        new HandPositionPlanner(
          { mode: 'frets', mechanism: 'independent_fingers', hands: [] },
          { unit: 'frets' }
        )
    ).toThrow(/reserved for V2/);
  });

  test('le validateur rejette les deux stubs V2 (frets et semitones)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const base = {
      gm_program: 24,
      polyphony: 6,
      note_selection_mode: 'range',
      note_range_min: 40,
      note_range_max: 88
    };
    const frets = v.validateInstrument({
      ...base,
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'independent_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(frets.isValid).toBe(false);
    expect(
      frets.missing.some((m) => m.field === 'hands_config.mechanism' && /V2/.test(m.reason || ''))
    ).toBe(true);

    const semis = v.validateInstrument({
      ...base,
      hands_config: {
        enabled: true,
        mode: 'semitones',
        mechanism: 'independent_fingers_5',
        hand_move_semitones_per_sec: 12,
        hands: [{ id: 'left', cc_position_number: 22, hand_span_semitones: 12 }]
      }
    });
    expect(semis.isValid).toBe(false);
    expect(
      semis.missing.some((m) => m.field === 'hands_config.mechanism' && /V2/.test(m.reason || ''))
    ).toBe(true);
  });

  test('un mécanisme V1 valide, lui, passe (le refus est bien ciblé)', () => {
    const v = new InstrumentCapabilitiesValidator();
    const ok = v.validateInstrument({
      gm_program: 24,
      polyphony: 6,
      note_selection_mode: 'range',
      note_range_min: 40,
      note_range_max: 88,
      hands_config: {
        enabled: true,
        mode: 'frets',
        mechanism: 'string_sliding_fingers',
        hand_move_mm_per_sec: 250,
        hands: [{ id: 'fretting', cc_position_number: 22, hand_span_mm: 80 }]
      }
    });
    expect(ok.isValid).toBe(true);
  });
});
