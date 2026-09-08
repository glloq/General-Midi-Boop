/**
 * @file tests/audit/r15-dead-capabilities.test.js
 * @description Vague 3 — R14 / R15. Preuves exécutables des décisions prises
 * sur la liste CLOSE des capacités mortes de
 * `docs/audit/2026-09-07/06_ROUTING_ADAPTATION.md` §4.
 * Compte rendu : `docs/audit/2026-09-07/WAVE3_R14_R15.md`.
 *
 * Trois natures de test, étiquetées :
 *   - `[CÂBLÉE]` la capacité a désormais un consommateur — régression si
 *               l'effet disparaît.
 *   - `[RETIRÉE]` la surface utilisateur a été supprimée : le test empêche
 *               qu'elle revienne par mégarde (le capo, notamment, est une
 *               décision produit, pas un manque à combler).
 *   - `[ASSUMÉE]` la capacité reste volontairement invisible du moteur
 *               (arbitrage T1.3) : le test fige l'arbitrage et lui donne la
 *               couverture qui manquait à F-74.
 *
 * Base SQLite jetable, construite en mémoire depuis `migrations/`.
 */
import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import StringInstrumentDatabase from '../../src/persistence/tables/StringInstrumentDatabase.js';
import { descriptorToStringConfig } from '../../src/midi/instrument/DescriptorProtocol.js';
import * as stringSchemas from '../../src/api/commands/schemas/string_instrument.schemas.js';

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
  db.prepare("INSERT OR IGNORE INTO devices (id,name,type) VALUES ('d1','D1','output')").run();
  return db;
}

/** Concatenated .js sources under a directory (static evidence). */
function readTree(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readTree(full);
    else if (entry.name.endsWith('.js')) out += fs.readFileSync(full, 'utf8');
  }
  return out;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Source with every comment stripped — a mention in prose is not a wiring. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// =====================================================================
// R14 — `is_fretless` : capacité VIVANTE que l'UI détruisait (F-140, P1)
// =====================================================================
describe('R14 · [CÂBLÉE] is_fretless', () => {
  test('les trois consommateurs moteur existent toujours (sinon la correction est vaine)', () => {
    expect(read('src/midi/adaptation/TablatureConverter.js')).toMatch(/is_fretless|isFretless/);
    expect(read('src/midi/playback/MidiPlayer.js')).toMatch(/is_fretless/);
    expect(read('src/midi/instrument/CapabilityResolver.js')).toMatch(/is_fretless/);
  });

  test("le modal n'écrit plus 0 en dur : ISMSave lit la case puis la config", () => {
    const src = stripComments(read('public/js/features/instrument-settings/ISMSave.js'));
    expect(src).not.toMatch(/is_fretless:\s*0\s*,/);
    expect(src).toMatch(/#ismIsFretless/);
    expect(src).toMatch(/stringInstrumentConfig\?\.is_fretless/);
  });

  test('la case existe dans la sous-section Cordes et est câblée à la config', () => {
    expect(read('public/js/features/instrument-settings/ISMSections.js')).toMatch(
      /id="ismIsFretless"/
    );
    expect(read('public/js/features/instrument-settings/ISMListeners.js')).toMatch(
      /#ismIsFretless/
    );
  });

  test('aller-retour base réelle : un violon fretless reste fretless après réécriture', () => {
    const db = freshDb();
    const sidb = new StringInstrumentDatabase(db, silentLogger);
    sidb.createStringInstrument({
      device_id: 'd1',
      channel: 0,
      instrument_name: 'Violin',
      num_strings: 4,
      num_frets: 0,
      tuning: [55, 62, 69, 76],
      is_fretless: true
    });
    expect(sidb.getStringInstrument('d1', 0).is_fretless).toBe(true);

    // Le second appel est l'UPSERT que déclenche chaque enregistrement du
    // modal. Avant R14 il arrivait avec `is_fretless: 0` et détruisait la
    // valeur ; il porte désormais la valeur réelle.
    sidb.createStringInstrument({
      device_id: 'd1',
      channel: 0,
      instrument_name: 'Violin',
      num_strings: 4,
      num_frets: 0,
      tuning: [55, 62, 69, 76],
      is_fretless: true
    });
    expect(sidb.getStringInstrument('d1', 0).is_fretless).toBe(true);
    db.close();
  });
});

// =====================================================================
// R15 — Classe C : `capo_fret`, surface RETIRÉE (décision produit)
// =====================================================================
describe('R15 · [RETIRÉE] capo_fret — le capo est abandonné', () => {
  test("aucun writer : ni la commande, ni la couche SQL, ni l'UI ne l'envoient", () => {
    for (const rel of [
      'src/api/commands/StringInstrumentCommands.js',
      'src/api/commands/InstrumentSettingsCommands.js',
      'public/js/features/instrument-settings/ISMSave.js',
      'public/js/features/instrument-settings/ISMListeners.js',
      'public/js/features/InstrumentCapabilitiesModal.js'
    ]) {
      expect(stripComments(read(rel))).not.toMatch(/capo_fret/);
    }
    // La couche SQL ne nomme plus la colonne du tout (INSERT, ON CONFLICT,
    // UPDATE partiel, validateur et projection de lecture).
    expect(stripComments(read('src/persistence/tables/StringInstrumentDatabase.js'))).not.toMatch(
      /capo_fret/
    );
  });

  test('le schéma WS ne valide plus capo_fret (aucun writer ne le lit)', () => {
    expect(
      stripComments(read('src/api/commands/schemas/string_instrument.schemas.js'))
    ).not.toMatch(/capo_fret/);
  });

  test('un capo_fret entrant est ignoré, pas persisté', () => {
    const db = freshDb();
    const sidb = new StringInstrumentDatabase(db, silentLogger);
    const id = sidb.createStringInstrument({
      device_id: 'd1',
      channel: 0,
      instrument_name: 'Guitar',
      num_strings: 6,
      tuning: [40, 45, 50, 55, 59, 64],
      capo_fret: 5 // vestige d'un client ancien
    });
    expect(db.prepare('SELECT capo_fret FROM string_instruments WHERE id = ?').get(id)).toEqual({
      capo_fret: 0
    });
    sidb.updateStringInstrument(id, { capo_fret: 7, num_frets: 22 });
    const row = db
      .prepare('SELECT capo_fret, num_frets FROM string_instruments WHERE id = ?')
      .get(id);
    expect(row).toEqual({ capo_fret: 0, num_frets: 22 });
    // Et la valeur ne remonte plus dans la config lue.
    expect(sidb.getStringInstrument('d1', 0)).not.toHaveProperty('capo_fret');
    db.close();
  });

  test('le descripteur v2 ne mappe plus physical.capo (F-72 refermé)', () => {
    const cfg = descriptorToStringConfig({
      family: 'strings',
      tuning: [40, 45, 50, 55, 59, 64],
      capo: 3
    });
    expect(cfg).not.toHaveProperty('capo_fret');
    expect(cfg).toEqual({ tuning: [40, 45, 50, 55, 59, 64] });
  });

  test('la colonne survit volontairement, documentée comme abandonnée', () => {
    // On ne la supprime PAS : un rebuild de table pour une colonne inerte
    // n'en vaut pas le risque. Le SQL de suppression est écrit, non appliqué,
    // dans le compte rendu.
    const db = freshDb();
    const cols = db.prepare('PRAGMA table_info(string_instruments)').all();
    expect(cols.map((c) => c.name)).toContain('capo_fret');
    db.close();
    const doc = read('src/persistence/tables/StringInstrumentDatabase.js');
    expect(doc).toMatch(/ABANDONED COLUMN/);
    expect(doc).toMatch(/capo_fret/);
  });

  test('le simulateur de main applique exactement la même frette que le moteur', () => {
    const src = stripComments(read('public/js/features/auto-assign/HandPositionFeasibility.js'));
    expect(src).not.toMatch(/capo/i);
  });

  test('les 3 clés i18n orphelines ont disparu des 28 locales', () => {
    const dir = path.join(ROOT, 'public/locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(28);
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(d.stringInstrument?.capoFret).toBeUndefined();
      expect(d.stringInstrument?.noCapo).toBeUndefined();
      expect(d.tablature?.capo).toBeUndefined();
      // `stringInstrument.isFretless` est au contraire une clé VIVANTE : elle
      // libelle la case ajoutée par R14.
      expect(typeof d.stringInstrument?.isFretless).toBe('string');
      // Et le texte d'aide ne promet plus « capo inclus ».
      expect(d.instrumentSettings.handsFretsCcPositionHint).not.toMatch(
        /capo|kapo|capot|cejilla|каподастр|カポ|카포|变调夹|ক্যাপো|καπό/i
      );
    }
  });
});

// =====================================================================
// R15 — Classe B : moteur aveugle PAR CONCEPTION (T1.3) — F-74
// =====================================================================
describe('R15 · [ASSUMÉE] Classe B — réglages de vue et de jeu live', () => {
  const midiSrc = stripComments(readTree(path.join(ROOT, 'src/midi')));
  // Les consommateurs vivent dans le clavier virtuel : les vues dédiées
  // (`keyboard/views/`) et le modal qui les alimente.
  const frontSrc =
    readTree(path.join(ROOT, 'public/js/features/keyboard')) +
    read('public/js/features/KeyboardModal.js');

  const CLASS_B = [
    'bagpipe_config',
    'accordion_config',
    'harmonica_config',
    'string_slider_enabled',
    'string_sliding_system_enabled',
    'cc_bow_direction_number',
    'cc_bow_down_value',
    'cc_bow_up_value'
  ];

  test.each(CLASS_B)('%s reste invisible du moteur MIDI (arbitrage T1.3, pas un défaut)', (col) => {
    expect(midiSrc).not.toMatch(new RegExp(col));
  });

  test('…mais chacune a bien un consommateur côté vues clavier / jeu live', () => {
    // Les trois configs par instrument pilotent les vues dédiées.
    expect(frontSrc).toMatch(/bagpipe_config|bagpipeConfig/);
    expect(frontSrc).toMatch(/accordion_config|accordionConfig/);
    expect(frontSrc).toMatch(/harmonica_config|harmonicaConfig/);
    // Glissière et archet sont des gestes de jeu, lus par le clavier virtuel.
    expect(frontSrc).toMatch(/string_sliding_system_enabled/);
    expect(frontSrc).toMatch(/string_slider_enabled/);
    expect(frontSrc).toMatch(/cc_bow_direction_number/);
    expect(frontSrc).toMatch(/cc_bow_down_value/);
    expect(frontSrc).toMatch(/cc_bow_up_value/);
  });

  test('les 5 colonnes cordes de Classe B survivent à un aller-retour base', () => {
    // F-74 : « leur seul défaut est de n'avoir aucun test ». Voici la
    // couverture de persistance qui manquait.
    const db = freshDb();
    const sidb = new StringInstrumentDatabase(db, silentLogger);
    sidb.createStringInstrument({
      device_id: 'd1',
      channel: 0,
      instrument_name: 'Cello',
      num_strings: 4,
      tuning: [36, 43, 50, 57],
      string_slider_enabled: true,
      string_sliding_system_enabled: true,
      cc_bow_direction_number: 22,
      cc_bow_down_value: 10,
      cc_bow_up_value: 110
    });
    const cfg = sidb.getStringInstrument('d1', 0);
    expect(cfg.string_slider_enabled).toBe(true);
    expect(cfg.string_sliding_system_enabled).toBe(true);
    expect(cfg.cc_bow_direction_number).toBe(22);
    expect(cfg.cc_bow_down_value).toBe(10);
    expect(cfg.cc_bow_up_value).toBe(110);
    db.close();
  });
});

// =====================================================================
// R15 — F-73 : la donnée de référence GM cesse d'être morte
// =====================================================================
describe('R15 · [CÂBLÉE] shared/gm-instrument-capabilities.json (F-73)', () => {
  const gm = JSON.parse(read('shared/gm-instrument-capabilities.json'));

  test('la référence couvre les 128 programmes avec polyphonie et monophonie', () => {
    expect(Object.keys(gm)).toHaveLength(128);
    expect(gm['73']).toMatchObject({ polyphony: 1, monophonic: true }); // Flûte
    expect(gm['56']).toMatchObject({ polyphony: 1, monophonic: true }); // Trompette
    expect(gm['0']).toMatchObject({ polyphony: 16, monophonic: false }); // Piano
  });

  test('elle a désormais un consommateur : le défaut de polyphonie du modal', () => {
    const sections = read('public/js/features/instrument-settings/ISMSections.js');
    const save = read('public/js/features/instrument-settings/ISMSave.js');
    expect(sections).toMatch(/_gmDefaultPolyphony/);
    expect(sections).toMatch(/GmInstrumentCapabilities/);
    expect(sections).toMatch(/entry\.monophonic/);
    expect(save).toMatch(/_gmDefaultPolyphony/);
  });

  test('le miroir navigateur reste synchrone avec le JSON partagé', () => {
    // Le miroir est la source que lit `_gmDefaultPolyphony` : s'il dérive,
    // le défaut de polyphonie devient faux sans que rien ne le signale.
    const mirror = read('public/js/features/GmInstrumentCapabilities.js');
    for (const p of ['0', '40', '56', '73', '127']) {
      const entry = gm[p];
      const block = new RegExp(
        `\\b${p}:\\s*\\{[^}]*polyphony:\\s*${entry.polyphony}[^}]*monophonic:\\s*${entry.monophonic}`,
        's'
      );
      expect(mirror).toMatch(block);
    }
  });

  test('tous les programmes monophoniques déclarent polyphony = 1', () => {
    const wrong = Object.entries(gm)
      .filter(([, v]) => v.monophonic && v.polyphony !== 1)
      .map(([k]) => k);
    expect(wrong).toEqual([]);
  });
});

// =====================================================================
// R15 — capacités hors périmètre de ce lot : le constat reste figé
// =====================================================================
describe('R15 · [HORS PÉRIMÈTRE] capacités encore mortes après ce lot', () => {
  // Ces tests sont des tests de CARACTÉRISATION : ils deviennent rouges le
  // jour où quelqu'un câble la capacité — c'est alors le test qu'il faut
  // inverser, pas le code. Voir §« Reste à faire » du compte rendu.
  test('[MORTE] descriptor_json / descriptor_revision : toujours aucun writer', () => {
    const src = stripComments(readTree(path.join(ROOT, 'src')));
    expect(src).not.toMatch(/descriptor_json/);
    expect(src).not.toMatch(/descriptor_revision/);
  });

  test("[MORTE] behavior_mode : écrit et relu par la persistance, par personne d'autre", () => {
    const persistence = read('src/persistence/tables/RoutingPersistenceDB.js');
    expect(persistence).toMatch(/behavior_mode/);
    expect(stripComments(readTree(path.join(ROOT, 'public/js')))).not.toMatch(/behavior_mode/);
  });

  test('[MORTE] pitch_bend_enabled : le moteur MIDI reste aveugle', () => {
    expect(stripComments(readTree(path.join(ROOT, 'src/midi')))).not.toMatch(/pitch_bend_enabled/);
  });

  test('[MORTE] instrument_voices : les 5 colonnes par voix restent absentes du VoiceSelector', () => {
    // Écrites par ISMSave + InstrumentVoiceCommands, validées, jamais lues.
    const selector = stripComments(read('src/midi/adaptation/VoiceSelector.js'));
    for (const col of [
      'min_note_interval',
      'min_note_duration',
      'supported_ccs',
      'octave_mode',
      'scale_root'
    ]) {
      expect(selector).not.toMatch(new RegExp(col));
    }
    // …alors que le modal les écrit bel et bien, par voix.
    const save = read('public/js/features/instrument-settings/ISMSave.js');
    expect(save).toMatch(/min_note_interval: v\.min_note_interval/);
    expect(save).toMatch(/octave_mode: v\.octave_mode/);
  });

  test("[MORTE] capabilities_source='sysex' : autorisé par le CHECK, produit par personne", () => {
    const db = freshDb();
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='instruments_latency'")
      .get().sql;
    expect(sql).toMatch(/'sysex'/);
    db.close();
    const writers = stripComments(readTree(path.join(ROOT, 'src')));
    expect(writers).not.toMatch(/capabilities_source:\s*'sysex'/);
    expect(writers).not.toMatch(/capabilities_source\s*=\s*'sysex'/);
  });
});

// =====================================================================
// Garde-fou de contrat : le schéma continue d'accepter les payloads légitimes
// =====================================================================
describe('R15 · le retrait de capo_fret ne casse pas le contrat WS', () => {
  test('un client ancien qui envoie encore capo_fret est accepté (champ ignoré)', () => {
    const errors = stringSchemas.string_instrument_update.custom({
      id: 7,
      capo_fret: 2,
      is_fretless: false
    });
    expect(errors).toEqual([]);
  });

  test('is_fretless reste validé', () => {
    expect(stringSchemas.string_instrument_update.custom({ id: 7, is_fretless: 'oui' })).toEqual([
      'is_fretless must be a boolean'
    ]);
  });
});
