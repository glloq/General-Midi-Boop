/**
 * @file tests/audit/l06-capability-matrix.test.js
 * @description Lot L06 — preuves exécutables de la MATRICE DE COMPLÉTUDE DES
 * CAPACITÉS (`docs/audit/2026-09-07/06_ROUTING_ADAPTATION.md`).
 *
 * Pour chaque colonne de capacité, la question est : est-elle **écrite**,
 * **validée**, **lue par le moteur**, **testée** ? Une case
 * « écrite + validée + jamais lue » est une **capacité morte** : l'utilisateur
 * configure quelque chose qui n'a aucun effet sur la sortie.
 *
 * Ce fichier contient deux natures de test, explicitement étiquetées :
 *   - `[VIVANT]`  la capacité est lue et a un effet observable → régression
 *                 si l'effet disparaît.
 *   - `[MORTE]`   la capacité n'a AUCUN effet aujourd'hui. Le test **fige le
 *                 constat** (test de caractérisation) : il devient rouge le
 *                 jour où quelqu'un câble la capacité — c'est alors le test
 *                 qu'il faut inverser, pas le code.
 *
 * Base SQLite jetable : construite en mémoire depuis `migrations/`, jamais
 * `./data/gmboop.db`.
 */
import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import PlaybackScheduler from '../../src/midi/playback/PlaybackScheduler.js';
import InstrumentMatcher from '../../src/midi/adaptation/InstrumentMatcher.js';
import InstrumentTypeConfig from '../../src/midi/adaptation/InstrumentTypeConfig.js';
import TablatureConverter from '../../src/midi/adaptation/TablatureConverter.js';
import { selectVoiceProgram } from '../../src/midi/adaptation/VoiceSelector.js';
import { SCALE_INTERVALS } from '../../src/midi/adaptation/ScaleSnapper.js';
import { DEVICE_MSG_TYPES } from '../../src/core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** Fresh in-memory database with every migration applied, in numeric order. */
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const dir = path.join(ROOT, 'migrations');
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return db;
}

function seedInstrument(db, overrides = {}) {
  db.prepare("INSERT OR IGNORE INTO devices (id,name,type) VALUES ('d1','D1','output')").run();
  const cols = {
    id: 'd1_0',
    device_id: 'd1',
    channel: 0,
    name: 'Test',
    ...overrides
  };
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO instruments_latency (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...keys.map((k) => cols[k]));
  return cols.id;
}

/** Read every .js file under a directory, concatenated (for static evidence). */
function readTree(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readTree(full);
    else if (entry.name.endsWith('.js')) out += fs.readFileSync(full, 'utf8');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Vérité au niveau base — la contrainte CHECK et les colonnes non gardées
// ---------------------------------------------------------------------------

describe('L06 · §T1.8 — contrainte CHECK sur capabilities_source (base réelle)', () => {
  test('les 34 migrations s’appliquent sur une base vierge', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('instruments_latency');
    expect(tables).toContain('instrument_voices');
    expect(tables).toContain('string_instruments');
    db.close();
  });

  test("capabilities_source='descriptor' est REJETÉ aujourd'hui (blocage T1.8 confirmé)", () => {
    const db = freshDb();
    seedInstrument(db);
    expect(() =>
      db
        .prepare("UPDATE instruments_latency SET capabilities_source='descriptor' WHERE id='d1_0'")
        .run()
    ).toThrow(/CHECK constraint failed: capabilities_source/);
    db.close();
  });

  test("les trois valeurs autorisées passent ('manual','sysex','auto')", () => {
    const db = freshDb();
    seedInstrument(db);
    for (const v of ['manual', 'sysex', 'auto']) {
      expect(() =>
        db.prepare('UPDATE instruments_latency SET capabilities_source=? WHERE id=?').run(v, 'd1_0')
      ).not.toThrow();
    }
    db.close();
  });

  test('[TROU DE VALIDATION] octave_mode n’a AUCUNE contrainte : une valeur inconnue est acceptée', () => {
    const db = freshDb();
    seedInstrument(db, { octave_mode: 'banana' });
    expect(
      db.prepare("SELECT octave_mode o FROM instruments_latency WHERE id='d1_0'").get().o
    ).toBe('banana');
    db.close();
  });

  test('[TROU DE VALIDATION] scale_root n’a AUCUNE contrainte 0-11 : 999 est accepté', () => {
    const db = freshDb();
    seedInstrument(db, { scale_root: 999 });
    expect(db.prepare("SELECT scale_root s FROM instruments_latency WHERE id='d1_0'").get().s).toBe(
      999
    );
    db.close();
  });

  test('[TROU DE VALIDATION] descriptor_json accepte du JSON invalide (pas de json_valid)', () => {
    const db = freshDb();
    seedInstrument(db, { descriptor_json: '{not json' });
    expect(
      db.prepare("SELECT descriptor_json j FROM instruments_latency WHERE id='d1_0'").get().j
    ).toBe('{not json');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Capacités MORTES — aucun effet sur la sortie
// ---------------------------------------------------------------------------

describe('L06 · capacités MORTES (caractérisation : à inverser le jour du câblage)', () => {
  test('[MORTE] descriptor_json / descriptor_revision : colonnes jamais écrites ni lues', () => {
    // Migration 033 crée les colonnes ; aucun code de src/ ne les nomme, donc
    // le cache de descripteur ne survit pas au redémarrage (reste T1.8).
    const src = readTree(path.join(ROOT, 'src'));
    expect(src.includes('descriptor_json')).toBe(false);
    expect(src.includes('descriptor_revision')).toBe(false);
    // Mais elles existent bien en base :
    const db = freshDb();
    const cols = db
      .prepare('PRAGMA table_info(instruments_latency)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('descriptor_json');
    expect(cols).toContain('descriptor_revision');
    db.close();
  });

  test('[MORTE] pitch_bend_enabled : le scheduler transmet le pitch-bend même à 0', () => {
    // La colonne pilote uniquement la molette de la vue clavier (frontend).
    // Le moteur ne la lit nulle part : un fichier contenant du pitch-bend
    // l'envoie à un instrument qui déclare ne pas le gérer.
    const app = {
      logger: silentLogger,
      database: null,
      eventBus: { on: () => {} },
      wsServer: { broadcast: jest.fn() },
      deviceManager: { sendMessage: jest.fn(() => true) }
    };
    const scheduler = new PlaybackScheduler(app);
    scheduler._snapshot = {
      getTimingConstraints: () => ({
        minNoteInterval: null,
        minNoteDuration: null,
        polyphony: null,
        noteRangeMin: null,
        noteRangeMax: null,
        selectedNotes: null,
        supportedCcs: null,
        handCcs: null,
        // il n'existe aucun champ `pitchBendEnabled` dans les contraintes :
        // la capacité n'est même pas exposée au moteur.
        pitchBendEnabled: 0
      }),
      isStringCCAllowed: () => false
    };
    scheduler.sendEvent(
      { type: 'pitchBend', channel: 0, value: 4096 },
      {
        playing: true,
        channelRouting: new Map(),
        channelTransposition: new Map(),
        channelNoteRemapping: new Map(),
        mutedChannels: new Set(),
        disconnectedPolicy: 'skip'
      },
      () => ({ device: 'robot', targetChannel: 0 }),
      {}
    );
    const sent = app.deviceManager.sendMessage.mock.calls.some(
      (c) => c[1] === DEVICE_MSG_TYPES.PITCH_BEND
    );
    expect(sent).toBe(true); // ← capacité morte : aucun filtrage
  });

  test('[MORTE] capo_fret : le TablatureConverter ignore le capo (choix assumé 2026-04)', () => {
    const withCapo = new TablatureConverter({
      tuning: [40, 45, 50, 55, 59, 64],
      num_strings: 6,
      num_frets: 24,
      is_fretless: false,
      capo_fret: 5
    });
    const withoutCapo = new TablatureConverter({
      tuning: [40, 45, 50, 55, 59, 64],
      num_strings: 6,
      num_frets: 24,
      is_fretless: false,
      capo_fret: 0
    });
    // Le "tuning effectif" reste l'accordage brut : aucun décalage appliqué.
    expect(withCapo.effectiveTuning).toEqual([40, 45, 50, 55, 59, 64]);
    expect(withCapo.effectiveTuning).toEqual(withoutCapo.effectiveTuning);
    expect(withCapo.stringRanges).toEqual(withoutCapo.stringRanges);
  });

  test('[MORTE] instrument_voices : min_note_interval / supported_ccs / octave_mode par voix ignorés', () => {
    // VoiceSelector — le SEUL consommateur moteur des voix — ne lit que
    // gm_program / note_selection_mode / note_range_* / selected_notes.
    // Les autres colonnes par voix (migrations 003/005/032) sont écrites,
    // validées (MidiListParser), et jamais relues.
    const voices = [
      {
        gm_program: 42,
        note_selection_mode: 'range',
        note_range_min: 40,
        note_range_max: 60,
        min_note_interval: 500, // ignoré
        min_note_duration: 500, // ignoré
        supported_ccs: [1, 7], // ignoré
        octave_mode: 'pentatonic', // ignoré
        scale_root: 3 // ignoré
      }
    ];
    // Une note hors gamme pentatonique de la voix est quand même réclamée
    // par cette voix : la gamme par voix n'entre pas dans la décision.
    expect(selectVoiceProgram({ note: 41, primaryProgram: 0, voices, sharesNotes: false })).toBe(
      42
    );
    // Le source du sélecteur ne mentionne aucune de ces colonnes.
    const src = fs.readFileSync(path.join(ROOT, 'src/midi/adaptation/VoiceSelector.js'), 'utf8');
    for (const col of [
      'min_note_interval',
      'min_note_duration',
      'supported_ccs',
      'octave_mode',
      'scale_root'
    ]) {
      expect(src.includes(col)).toBe(false);
    }
  });

  test('[MORTE] shared/gm-instrument-capabilities.json : plages et monophonie jamais lues par le moteur', () => {
    const caps = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'shared/gm-instrument-capabilities.json'), 'utf8')
    );
    // La donnée existe et dit clairement qu'une flûte est monophonique…
    expect(caps['73'].monophonic).toBe(true);
    expect(caps['73'].polyphony).toBe(1);
    // …mais le seul accesseur (`getGmDefaultPolyphony`) n'a AUCUN appelant
    // dans src/, et `monophonic` / `rangeMin` / `comfortMin` n'y sont jamais
    // référencés : rien ne tient une famille à vent monophonique par défaut.
    const src = readTree(path.join(ROOT, 'src'));
    const callers = src.split('getGmDefaultPolyphony').length - 1;
    expect(callers).toBe(1); // uniquement la définition elle-même
    // `monophonic` n'apparaît dans src/ que dans des commentaires, jamais
    // comme accès de propriété (`.monophonic` / `['monophonic']`).
    expect(/\.monophonic\b|\['monophonic'\]/.test(src)).toBe(false);
    expect(/\.comfortMin\b|\.comfortMax\b/.test(src)).toBe(false);
    // L'accesseur, lui, fonctionne — c'est bien un consommateur qui manque.
    expect(InstrumentTypeConfig.getGmDefaultPolyphony(73)).toBe(1);
  });

  test('[MORTE côté moteur] cordes : slider / système coulissant / archet non lus par src/midi', () => {
    // Ces colonnes (migrations 012, 013, 021) pilotent uniquement les vues
    // clavier virtuelles. Aucun chemin d'adaptation ou de playback ne les lit.
    const midi = readTree(path.join(ROOT, 'src/midi'));
    for (const col of [
      'string_slider_enabled',
      'string_sliding_system_enabled',
      'cc_bow_direction_number',
      'cc_bow_down_value',
      'cc_bow_up_value'
    ]) {
      expect(midi.includes(col)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Capacités VIVANTES — l'effet doit rester observable
// ---------------------------------------------------------------------------

describe('L06 · capacités VIVANTES (garde-fous de régression)', () => {
  test('[VIVANT] les tables d’intervalles backend et frontend restent identiques', () => {
    // ScaleSnapper duplique volontairement `InstrumentSettingsModal.OCTAVE_MODES`.
    // Une dérive silencieuse ferait diverger le "materialize" du frontend et le
    // snap du moteur pour le même instrument.
    const front = fs.readFileSync(
      path.join(ROOT, 'public/js/features/InstrumentSettingsModal.js'),
      'utf8'
    );
    const block = front.slice(front.indexOf('static OCTAVE_MODES'));
    const parseIntervals = (mode) => {
      const at = block.indexOf(`${mode}:`);
      const start = block.indexOf('intervals:', at);
      const open = block.indexOf('[', start);
      const close = block.indexOf(']', open);
      return JSON.parse(block.slice(open, close + 1));
    };
    for (const mode of ['chromatic', 'diatonic', 'pentatonic']) {
      expect(parseIntervals(mode)).toEqual(SCALE_INTERVALS[mode]);
    }
    // Et aucune des deux ne connaît de mode supplémentaire.
    expect(Object.keys(SCALE_INTERVALS).sort()).toEqual(
      ['chromatic', 'diatonic', 'pentatonic'].sort()
    );
  });

  test('[TROU] un octave_mode inconnu désactive silencieusement le snap de gamme', () => {
    // Conséquence directe du trou de validation ci-dessus : « pentatonique »
    // mal orthographié = instrument chromatique, sans le moindre avertissement.
    const app = {
      logger: silentLogger,
      database: null,
      eventBus: { on: () => {} },
      wsServer: { broadcast: jest.fn() },
      deviceManager: { sendMessage: jest.fn(() => true) }
    };
    const scheduler = new PlaybackScheduler(app);
    scheduler._snapshot = {
      getTimingConstraints: () => ({
        minNoteInterval: null,
        minNoteDuration: null,
        polyphony: null,
        noteRangeMin: 60,
        noteRangeMax: 72,
        selectedNotes: null,
        octaveMode: 'pentatonik', // faute de frappe
        scaleRoot: 0,
        supportedCcs: null,
        handCcs: null
      }),
      isStringCCAllowed: () => false
    };
    scheduler.sendEvent(
      { type: 'noteOn', channel: 0, note: 61, velocity: 100 },
      {
        playing: true,
        channelRouting: new Map(),
        channelTransposition: new Map(),
        channelNoteRemapping: new Map(),
        mutedChannels: new Set(),
        disconnectedPolicy: 'skip'
      },
      () => ({ device: 'robot', targetChannel: 0 }),
      {}
    );
    const call = app.deviceManager.sendMessage.mock.calls.find((c) => c[1] === 'noteon');
    expect(call[2].note).toBe(61); // aucune correction : la gamme est ignorée
  });

  test('[TROU] le scoring d’auto-assignation est aveugle à octave_mode en mode range', () => {
    // getInstrumentsWithCapabilities() ne projette ni octave_mode ni scale_root :
    // un instrument pentatonique en mode `range` est noté comme s'il pouvait
    // jouer les 12 demi-tons. Le score est identique avec et sans la gamme.
    const matcher = new InstrumentMatcher(silentLogger);
    const analysis = {
      channel: 0,
      primaryProgram: 0,
      bankMSB: null,
      bankLSB: null,
      noteRange: { min: 60, max: 72 },
      polyphony: { max: 1, avg: 1 },
      usedCCs: [],
      estimatedType: 'keyboard',
      typeConfidence: 1,
      typeScores: {},
      estimatedCategory: null,
      estimatedSubtype: null,
      timingAnalysis: null,
      totalNotes: 100
    };
    const chromatic = {
      device_id: 'i1',
      channel: 0,
      gm_program: 0,
      polyphony: 8,
      note_range_min: 60,
      note_range_max: 72,
      note_selection_mode: 'range',
      selected_notes: null,
      supported_ccs: null
    };
    const pentatonic = { ...chromatic, octave_mode: 'pentatonic', scale_root: 0 };
    expect(matcher.calculateCompatibility(analysis, pentatonic).score).toBe(
      matcher.calculateCompatibility(analysis, chromatic).score
    );
    // Alors qu'en mode `discrete` la restriction EST vue et fait chuter le score.
    const discrete = {
      ...chromatic,
      note_selection_mode: 'discrete',
      selected_notes: JSON.stringify([60, 62, 64, 67, 69, 72])
    };
    expect(matcher.calculateCompatibility(analysis, discrete).score).toBeLessThan(
      matcher.calculateCompatibility(analysis, chromatic).score
    );
  });
});
