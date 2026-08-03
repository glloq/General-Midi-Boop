/**
 * InstrumentPresets — single, unified instrument-preset catalogue.
 *
 * ONE list of real, common instruments. Each entry binds a GM program
 * range to a realistic playable note range, a chord capacity (polyphony)
 * and, when relevant, family-specific config. String entries carry full
 * geometry (num_strings, scale_length_mm, num_frets, default_mechanism,
 * standard tuning[] low→high MIDI, fretless) so a single click sets
 * notes / strings / tuning / polyphony coherently. Harmonica entries
 * carry harmonica_config { type, key }.
 *
 * Source of truth: `shared/instrument-presets.json`. This file mirrors
 * that data inline so the modal loads synchronously (no fetch). A Vitest
 * test (instrument-presets-sync.test.js) asserts the two stay in sync.
 *
 * Exposed via `window.InstrumentPresets`:
 *   - PRESETS                              ordered raw catalogue
 *   - MECHANISMS / getMechanismById(id)    string-hand mechanisms (+ SVG)
 *   - getPresetById(id)
 *   - getPresetsForProgram(gmProgram, ch)  list for the Notes & Capacités
 *                                          single selector (normalised)
 *   - filterStringPresetsByGmProgram(gm)   flattened string entries (incl.
 *   - filterStringPresetsByFamily(slug)    tuning) for the Strings dropdown
 */
(function () {
  'use strict';

  const PRESETS = [
    {
      id: 'piano_acoustic_88',
      label: 'Piano à queue (88 touches)',
      family_slug: 'keyboards',
      gm_programs: [0, 1, 2, 3],
      note_range_min: 21,
      note_range_max: 108,
      polyphony: 16
    },
    {
      id: 'piano_electric_73',
      label: 'Piano électrique (73 touches)',
      family_slug: 'keyboards',
      gm_programs: [4, 5],
      note_range_min: 28,
      note_range_max: 100,
      polyphony: 16
    },
    {
      id: 'harpsichord',
      label: 'Clavecin',
      family_slug: 'keyboards',
      gm_programs: [6],
      note_range_min: 29,
      note_range_max: 89,
      polyphony: 8
    },
    {
      id: 'clavinet',
      label: 'Clavinet',
      family_slug: 'keyboards',
      gm_programs: [7],
      note_range_min: 28,
      note_range_max: 88,
      polyphony: 8
    },
    {
      id: 'organ_hammond',
      label: 'Orgue Hammond (61 touches)',
      family_slug: 'keyboards',
      gm_programs: [16, 17, 18],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 16
    },
    {
      id: 'organ_church',
      label: "Orgue d'église",
      family_slug: 'keyboards',
      gm_programs: [19],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 16
    },
    {
      id: 'reed_organ',
      label: 'Harmonium',
      family_slug: 'keyboards',
      gm_programs: [20],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 16
    },

    {
      id: 'celesta',
      label: 'Célesta (5 octaves)',
      family_slug: 'chromatic_percussion',
      gm_programs: [8],
      note_range_min: 60,
      note_range_max: 108,
      polyphony: 8
    },
    {
      id: 'glockenspiel',
      label: 'Glockenspiel (2,5 octaves)',
      family_slug: 'chromatic_percussion',
      gm_programs: [9],
      note_range_min: 79,
      note_range_max: 108,
      polyphony: 4
    },
    {
      id: 'music_box',
      label: 'Boîte à musique',
      family_slug: 'chromatic_percussion',
      gm_programs: [10],
      note_range_min: 72,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'vibraphone',
      label: 'Vibraphone (3 octaves)',
      family_slug: 'chromatic_percussion',
      gm_programs: [11],
      note_range_min: 53,
      note_range_max: 89,
      polyphony: 6
    },
    {
      id: 'marimba',
      label: 'Marimba (4,3 octaves)',
      family_slug: 'chromatic_percussion',
      gm_programs: [12],
      note_range_min: 45,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'xylophone',
      label: 'Xylophone (3,5 octaves)',
      family_slug: 'chromatic_percussion',
      gm_programs: [13],
      note_range_min: 65,
      note_range_max: 108,
      polyphony: 4
    },
    {
      id: 'tubular_bells',
      label: 'Cloches tubulaires',
      family_slug: 'chromatic_percussion',
      gm_programs: [14],
      note_range_min: 60,
      note_range_max: 89,
      polyphony: 8
    },
    {
      id: 'dulcimer',
      label: 'Cymbalum / dulcimer',
      family_slug: 'chromatic_percussion',
      gm_programs: [15],
      note_range_min: 48,
      note_range_max: 84,
      polyphony: 4
    },
    {
      id: 'timpani',
      label: 'Timbales (4 fûts)',
      family_slug: 'chromatic_percussion',
      gm_programs: [47],
      note_range_min: 36,
      note_range_max: 57,
      polyphony: 2
    },
    {
      id: 'kalimba',
      label: 'Kalimba (lamellophone)',
      family_slug: 'chromatic_percussion',
      gm_programs: [108],
      note_range_min: 53,
      note_range_max: 84,
      polyphony: 4
    },
    {
      id: 'agogo_bells',
      label: 'Cloches agogô / clochettes',
      family_slug: 'chromatic_percussion',
      gm_programs: [112, 113],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'steel_drums',
      label: 'Steel drum',
      family_slug: 'chromatic_percussion',
      gm_programs: [114],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 2
    },
    {
      id: 'woodblock',
      label: 'Woodblock / claves',
      family_slug: 'chromatic_percussion',
      gm_programs: [115],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 2
    },
    {
      id: 'taiko',
      label: 'Taiko',
      family_slug: 'chromatic_percussion',
      gm_programs: [116],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'melodic_tom',
      label: 'Tom mélodique',
      family_slug: 'chromatic_percussion',
      gm_programs: [117],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'synth_drum',
      label: 'Synth drum',
      family_slug: 'chromatic_percussion',
      gm_programs: [118],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 4
    },
    {
      id: 'reverse_cymbal',
      label: 'Cymbale inversée',
      family_slug: 'chromatic_percussion',
      gm_programs: [119],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 4
    },

    {
      id: 'acoustic_guitar_nylon',
      label: 'Guitare classique (nylon)',
      family_slug: 'plucked_strings',
      gm_programs: [24],
      note_range_min: 40,
      note_range_max: 84,
      polyphony: 6,
      string_geometry: {
        num_strings: 6,
        scale_length_mm: 650,
        num_frets: 19,
        default_mechanism: 'string_sliding_fingers',
        tuning: [40, 45, 50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'acoustic_guitar_steel',
      label: 'Guitare acoustique (steel)',
      family_slug: 'plucked_strings',
      gm_programs: [25],
      note_range_min: 40,
      note_range_max: 84,
      polyphony: 6,
      string_geometry: {
        num_strings: 6,
        scale_length_mm: 648,
        num_frets: 20,
        default_mechanism: 'string_sliding_fingers',
        tuning: [40, 45, 50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'electric_guitar',
      label: 'Guitare électrique',
      family_slug: 'plucked_strings',
      gm_programs: [26, 27, 28, 29, 30, 31],
      note_range_min: 40,
      note_range_max: 86,
      polyphony: 6,
      string_geometry: {
        num_strings: 6,
        scale_length_mm: 648,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [40, 45, 50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'electric_guitar_gibson',
      label: 'Guitare électrique (Gibson)',
      family_slug: 'plucked_strings',
      gm_programs: [26, 27, 28, 29, 30, 31],
      note_range_min: 40,
      note_range_max: 86,
      polyphony: 6,
      string_geometry: {
        num_strings: 6,
        scale_length_mm: 628,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [40, 45, 50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'guitar_baritone',
      label: 'Guitare baryton',
      family_slug: 'plucked_strings',
      gm_programs: [26, 27, 28, 29, 30, 31],
      note_range_min: 35,
      note_range_max: 81,
      polyphony: 6,
      string_geometry: {
        num_strings: 6,
        scale_length_mm: 686,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [35, 40, 45, 50, 54, 59],
        fretless: false
      }
    },
    {
      id: 'guitar_7string',
      label: 'Guitare 7 cordes',
      family_slug: 'plucked_strings',
      gm_programs: [26, 27, 28, 29, 30, 31],
      note_range_min: 35,
      note_range_max: 86,
      polyphony: 7,
      string_geometry: {
        num_strings: 7,
        scale_length_mm: 648,
        num_frets: 24,
        default_mechanism: 'string_sliding_fingers',
        tuning: [35, 40, 45, 50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'guitar_12string',
      label: 'Guitare 12 cordes',
      family_slug: 'plucked_strings',
      gm_programs: [25],
      note_range_min: 40,
      note_range_max: 88,
      polyphony: 6,
      string_geometry: {
        num_strings: 12,
        scale_length_mm: 648,
        num_frets: 20,
        default_mechanism: 'string_sliding_fingers',
        tuning: [40, 52, 45, 57, 50, 62, 55, 67, 59, 59, 64, 64],
        fretless: false
      }
    },
    {
      id: 'bass_acoustic',
      label: 'Basse acoustique',
      family_slug: 'plucked_strings',
      gm_programs: [32],
      note_range_min: 28,
      note_range_max: 63,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 864,
        num_frets: 20,
        default_mechanism: 'string_sliding_fingers',
        tuning: [28, 33, 38, 43],
        fretless: false
      }
    },
    {
      id: 'bass_long',
      label: 'Basse électrique (long 34")',
      family_slug: 'plucked_strings',
      gm_programs: [33, 34, 35, 36, 37, 38, 39],
      note_range_min: 28,
      note_range_max: 65,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 864,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [28, 33, 38, 43],
        fretless: false
      }
    },
    {
      id: 'bass_short',
      label: 'Basse électrique (short 30")',
      family_slug: 'plucked_strings',
      gm_programs: [33, 34, 35, 36, 37, 38, 39],
      note_range_min: 28,
      note_range_max: 65,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 762,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [28, 33, 38, 43],
        fretless: false
      }
    },
    {
      id: 'bass_5string',
      label: 'Basse 5 cordes (35")',
      family_slug: 'plucked_strings',
      gm_programs: [33, 34, 35, 36, 37, 38, 39],
      note_range_min: 23,
      note_range_max: 67,
      polyphony: 5,
      string_geometry: {
        num_strings: 5,
        scale_length_mm: 889,
        num_frets: 24,
        default_mechanism: 'string_sliding_fingers',
        tuning: [23, 28, 33, 38, 43],
        fretless: false
      }
    },
    {
      id: 'harp',
      label: 'Harpe',
      family_slug: 'plucked_strings',
      gm_programs: [46],
      note_range_min: 24,
      note_range_max: 103,
      polyphony: 8,
      string_geometry: {
        num_strings: 47,
        scale_length_mm: 1700,
        num_frets: 0,
        default_mechanism: 'fret_sliding_fingers'
      }
    },
    {
      id: 'sitar',
      label: 'Sitar',
      family_slug: 'plucked_strings',
      gm_programs: [104],
      note_range_min: 48,
      note_range_max: 84,
      polyphony: 6,
      string_geometry: {
        num_strings: 7,
        scale_length_mm: 870,
        num_frets: 20,
        default_mechanism: 'string_sliding_fingers'
      }
    },
    {
      id: 'banjo',
      label: 'Banjo (5 cordes)',
      family_slug: 'plucked_strings',
      gm_programs: [105],
      note_range_min: 50,
      note_range_max: 86,
      polyphony: 5,
      string_geometry: {
        num_strings: 5,
        scale_length_mm: 660,
        num_frets: 22,
        default_mechanism: 'string_sliding_fingers',
        tuning: [67, 50, 55, 59, 62],
        fretless: false
      }
    },
    {
      id: 'shamisen',
      label: 'Shamisen',
      family_slug: 'plucked_strings',
      gm_programs: [106],
      note_range_min: 50,
      note_range_max: 79,
      polyphony: 3,
      string_geometry: {
        num_strings: 3,
        scale_length_mm: 615,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers'
      }
    },
    {
      id: 'koto',
      label: 'Koto',
      family_slug: 'plucked_strings',
      gm_programs: [107],
      note_range_min: 43,
      note_range_max: 84,
      polyphony: 8,
      string_geometry: {
        num_strings: 13,
        scale_length_mm: 1820,
        num_frets: 0,
        default_mechanism: 'fret_sliding_fingers'
      }
    },
    {
      id: 'ukulele_soprano',
      label: 'Ukulélé (soprano)',
      family_slug: 'plucked_strings',
      gm_programs: [24, 25],
      note_range_min: 60,
      note_range_max: 88,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 350,
        num_frets: 12,
        default_mechanism: 'string_sliding_fingers',
        tuning: [67, 60, 64, 69],
        fretless: false
      }
    },
    {
      id: 'ukulele_concert',
      label: 'Ukulélé (concert)',
      family_slug: 'plucked_strings',
      gm_programs: [24, 25],
      note_range_min: 60,
      note_range_max: 88,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 380,
        num_frets: 15,
        default_mechanism: 'string_sliding_fingers',
        tuning: [67, 60, 64, 69],
        fretless: false
      }
    },
    {
      id: 'ukulele_tenor',
      label: 'Ukulélé (tenor)',
      family_slug: 'plucked_strings',
      gm_programs: [24, 25],
      note_range_min: 55,
      note_range_max: 88,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 430,
        num_frets: 17,
        default_mechanism: 'string_sliding_fingers',
        tuning: [67, 60, 64, 69],
        fretless: false
      }
    },
    {
      id: 'ukulele_baritone',
      label: 'Ukulélé (baritone)',
      family_slug: 'plucked_strings',
      gm_programs: [24, 25],
      note_range_min: 50,
      note_range_max: 83,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 510,
        num_frets: 18,
        default_mechanism: 'string_sliding_fingers',
        tuning: [50, 55, 59, 64],
        fretless: false
      }
    },
    {
      id: 'mandolin',
      label: 'Mandoline',
      family_slug: 'plucked_strings',
      gm_programs: [25, 26],
      note_range_min: 55,
      note_range_max: 96,
      polyphony: 6,
      string_geometry: {
        num_strings: 8,
        scale_length_mm: 350,
        num_frets: 20,
        default_mechanism: 'string_sliding_fingers',
        tuning: [55, 55, 62, 62, 69, 69, 76, 76],
        fretless: false
      }
    },

    {
      id: 'violin',
      label: 'Violon',
      family_slug: 'bowed_strings',
      gm_programs: [40],
      note_range_min: 55,
      note_range_max: 103,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 328,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers',
        tuning: [55, 62, 69, 76],
        fretless: true
      }
    },
    {
      id: 'viola',
      label: 'Alto',
      family_slug: 'bowed_strings',
      gm_programs: [41],
      note_range_min: 48,
      note_range_max: 91,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 380,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers',
        tuning: [48, 55, 62, 69],
        fretless: true
      }
    },
    {
      id: 'cello',
      label: 'Violoncelle',
      family_slug: 'bowed_strings',
      gm_programs: [42],
      note_range_min: 36,
      note_range_max: 84,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 690,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers',
        tuning: [36, 43, 50, 57],
        fretless: true
      }
    },
    {
      id: 'contrabass',
      label: 'Contrebasse',
      family_slug: 'bowed_strings',
      gm_programs: [43],
      note_range_min: 28,
      note_range_max: 60,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 1050,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers',
        tuning: [28, 33, 38, 43],
        fretless: true
      }
    },
    {
      id: 'string_section_bowed',
      label: 'Section de cordes (trémolo / pizzicato)',
      family_slug: 'bowed_strings',
      gm_programs: [44, 45],
      note_range_min: 28,
      note_range_max: 100,
      polyphony: 8
    },
    {
      id: 'fiddle',
      label: 'Fiddle (folk)',
      family_slug: 'bowed_strings',
      gm_programs: [110],
      note_range_min: 55,
      note_range_max: 103,
      polyphony: 4,
      string_geometry: {
        num_strings: 4,
        scale_length_mm: 328,
        num_frets: 0,
        default_mechanism: 'string_sliding_fingers',
        tuning: [55, 62, 69, 76],
        fretless: true
      }
    },

    {
      id: 'string_ensemble',
      label: 'Ensemble à cordes',
      family_slug: 'ensembles',
      gm_programs: [48, 49, 50, 51],
      note_range_min: 28,
      note_range_max: 100,
      polyphony: 16
    },
    {
      id: 'choir',
      label: 'Chœur (voix)',
      family_slug: 'ensembles',
      gm_programs: [52, 53, 54],
      note_range_min: 40,
      note_range_max: 84,
      polyphony: 16
    },
    {
      id: 'orchestra_hit',
      label: 'Orchestra hit',
      family_slug: 'ensembles',
      gm_programs: [55],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 1
    },

    {
      id: 'trumpet',
      label: 'Trompette en Si♭',
      family_slug: 'brass',
      gm_programs: [56, 59],
      note_range_min: 52,
      note_range_max: 84,
      polyphony: 1
    },
    {
      id: 'trombone',
      label: 'Trombone ténor',
      family_slug: 'brass',
      gm_programs: [57],
      note_range_min: 40,
      note_range_max: 72,
      polyphony: 1
    },
    {
      id: 'tuba',
      label: 'Tuba',
      family_slug: 'brass',
      gm_programs: [58],
      note_range_min: 28,
      note_range_max: 58,
      polyphony: 1
    },
    {
      id: 'french_horn',
      label: "Cor d'harmonie en Fa",
      family_slug: 'brass',
      gm_programs: [60],
      note_range_min: 34,
      note_range_max: 77,
      polyphony: 1
    },
    {
      id: 'brass_section',
      label: 'Section de cuivres',
      family_slug: 'brass',
      gm_programs: [61, 62, 63],
      note_range_min: 40,
      note_range_max: 84,
      polyphony: 8
    },

    {
      id: 'accordion',
      label: 'Accordéon',
      family_slug: 'reeds',
      gm_programs: [21, 23],
      note_range_min: 41,
      note_range_max: 96,
      polyphony: 8
    },
    {
      id: 'harmo_diatonic_c',
      label: 'Harmonica diatonique — Do (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 60,
      note_range_max: 96,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'C' }
    },
    {
      id: 'harmo_diatonic_g',
      label: 'Harmonica diatonique — Sol (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 55,
      note_range_max: 91,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'G' }
    },
    {
      id: 'harmo_diatonic_a',
      label: 'Harmonica diatonique — La (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 57,
      note_range_max: 93,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'A' }
    },
    {
      id: 'harmo_diatonic_d',
      label: 'Harmonica diatonique — Ré (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 62,
      note_range_max: 98,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'D' }
    },
    {
      id: 'harmo_diatonic_f',
      label: 'Harmonica diatonique — Fa (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 65,
      note_range_max: 101,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'F' }
    },
    {
      id: 'harmo_diatonic_as',
      label: 'Harmonica diatonique — Si♭ (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 58,
      note_range_max: 94,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'A#' }
    },
    {
      id: 'harmo_diatonic_e',
      label: 'Harmonica diatonique — Mi (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 64,
      note_range_max: 100,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'E' }
    },
    {
      id: 'harmo_diatonic_ds',
      label: 'Harmonica diatonique — Mi♭ (10 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 63,
      note_range_max: 99,
      polyphony: 1,
      harmonica_config: { type: 'diatonic', key: 'D#' }
    },
    {
      id: 'harmo_chromatic_c_12',
      label: 'Harmonica chromatique — Do (12 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 60,
      note_range_max: 96,
      polyphony: 1,
      harmonica_config: { type: 'chromatic', key: 'C' }
    },
    {
      id: 'harmo_chromatic_c_16',
      label: 'Harmonica chromatique — Do (16 trous)',
      family_slug: 'reeds',
      gm_programs: [22],
      note_range_min: 48,
      note_range_max: 96,
      polyphony: 1,
      harmonica_config: { type: 'chromatic', key: 'C' }
    },
    {
      id: 'soprano_sax',
      label: 'Saxophone soprano',
      family_slug: 'reeds',
      gm_programs: [64],
      note_range_min: 56,
      note_range_max: 87,
      polyphony: 1
    },
    {
      id: 'alto_sax',
      label: 'Saxophone alto',
      family_slug: 'reeds',
      gm_programs: [65],
      note_range_min: 49,
      note_range_max: 80,
      polyphony: 1
    },
    {
      id: 'tenor_sax',
      label: 'Saxophone ténor',
      family_slug: 'reeds',
      gm_programs: [66],
      note_range_min: 44,
      note_range_max: 75,
      polyphony: 1
    },
    {
      id: 'baritone_sax',
      label: 'Saxophone baryton',
      family_slug: 'reeds',
      gm_programs: [67],
      note_range_min: 36,
      note_range_max: 68,
      polyphony: 1
    },
    {
      id: 'oboe',
      label: 'Hautbois',
      family_slug: 'reeds',
      gm_programs: [68],
      note_range_min: 58,
      note_range_max: 91,
      polyphony: 1
    },
    {
      id: 'english_horn',
      label: 'Cor anglais',
      family_slug: 'reeds',
      gm_programs: [69],
      note_range_min: 52,
      note_range_max: 81,
      polyphony: 1
    },
    {
      id: 'bassoon',
      label: 'Basson',
      family_slug: 'reeds',
      gm_programs: [70],
      note_range_min: 34,
      note_range_max: 72,
      polyphony: 1
    },
    {
      id: 'clarinet',
      label: 'Clarinette en Si♭',
      family_slug: 'reeds',
      gm_programs: [71],
      note_range_min: 50,
      note_range_max: 91,
      polyphony: 1
    },
    {
      id: 'bagpipe',
      label: 'Cornemuse',
      family_slug: 'reeds',
      gm_programs: [109],
      note_range_min: 62,
      note_range_max: 86,
      polyphony: 1
    },
    {
      id: 'shanai',
      label: 'Shehnai / bombarde',
      family_slug: 'reeds',
      gm_programs: [111],
      note_range_min: 62,
      note_range_max: 86,
      polyphony: 1
    },

    {
      id: 'piccolo',
      label: 'Piccolo',
      family_slug: 'winds',
      gm_programs: [72],
      note_range_min: 74,
      note_range_max: 108,
      polyphony: 1
    },
    {
      id: 'flute',
      label: 'Flûte traversière',
      family_slug: 'winds',
      gm_programs: [73],
      note_range_min: 60,
      note_range_max: 96,
      polyphony: 1
    },
    {
      id: 'recorder',
      label: 'Flûte à bec',
      family_slug: 'winds',
      gm_programs: [74],
      note_range_min: 60,
      note_range_max: 86,
      polyphony: 1
    },
    {
      id: 'pan_flute',
      label: 'Flûte de pan',
      family_slug: 'winds',
      gm_programs: [75],
      note_range_min: 60,
      note_range_max: 84,
      polyphony: 1
    },
    {
      id: 'blown_bottle',
      label: 'Bouteille soufflée',
      family_slug: 'winds',
      gm_programs: [76],
      note_range_min: 60,
      note_range_max: 84,
      polyphony: 1
    },
    {
      id: 'shakuhachi',
      label: 'Shakuhachi',
      family_slug: 'winds',
      gm_programs: [77],
      note_range_min: 55,
      note_range_max: 84,
      polyphony: 1
    },
    {
      id: 'whistle',
      label: 'Sifflet',
      family_slug: 'winds',
      gm_programs: [78],
      note_range_min: 60,
      note_range_max: 96,
      polyphony: 1
    },
    {
      id: 'ocarina',
      label: 'Ocarina',
      family_slug: 'winds',
      gm_programs: [79],
      note_range_min: 60,
      note_range_max: 84,
      polyphony: 1
    },

    {
      id: 'synth_lead',
      label: 'Synthé lead (solo)',
      family_slug: 'synths',
      gm_programs: [80, 81, 82, 83, 84, 85, 86, 87],
      note_range_min: 48,
      note_range_max: 91,
      polyphony: 1
    },
    {
      id: 'synth_pad',
      label: 'Synthé nappe (pad)',
      family_slug: 'synths',
      gm_programs: [88, 89, 90, 91, 92, 93, 94, 95],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 8
    },
    {
      id: 'synth_fx',
      label: 'Synthé FX / texture',
      family_slug: 'synths',
      gm_programs: [96, 97, 98, 99, 100, 101, 102, 103],
      note_range_min: 36,
      note_range_max: 96,
      polyphony: 4
    }
  ];

  // Inline SVGs used as the picture on each mechanism card. Same
  // viewBox (120 × 80) so the cards stay aligned.
  const MECHANISM_SVG = {
    string_sliding_fingers: `
            <svg viewBox="0 0 120 80" class="ism-mech-svg" aria-hidden="true">
                <rect x="5" y="10" width="110" height="60" fill="#f5e6c8" stroke="#8b6f47" stroke-width="1"/>
                <line x1="5" y1="22" x2="115" y2="22" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="34" x2="115" y2="34" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="46" x2="115" y2="46" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="58" x2="115" y2="58" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="28" y1="10" x2="28" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="51" y1="10" x2="51" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="74" y1="10" x2="74" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="97" y1="10" x2="97" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <rect x="40" y="13" width="50" height="54" fill="#22c55e" fill-opacity="0.28" stroke="#16a34a" stroke-width="1.5" rx="3"/>
                <line x1="46" y1="22" x2="84" y2="22" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="46" y1="34" x2="84" y2="34" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="46" y1="46" x2="84" y2="46" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="46" y1="58" x2="84" y2="58" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `,
    fret_sliding_fingers: `
            <svg viewBox="0 0 120 80" class="ism-mech-svg" aria-hidden="true">
                <rect x="5" y="10" width="110" height="60" fill="#f5e6c8" stroke="#8b6f47" stroke-width="1"/>
                <line x1="5" y1="22" x2="115" y2="22" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="34" x2="115" y2="34" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="46" x2="115" y2="46" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="58" x2="115" y2="58" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="28" y1="10" x2="28" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="51" y1="10" x2="51" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="74" y1="10" x2="74" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="97" y1="10" x2="97" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <rect x="40" y="13" width="50" height="54" fill="#22c55e" fill-opacity="0.28" stroke="#16a34a" stroke-width="1.5" rx="3"/>
                <line x1="51" y1="17" x2="51" y2="63" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="63" y1="17" x2="63" y2="63" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="74" y1="17" x2="74" y2="63" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
                <line x1="86" y1="17" x2="86" y2="63" stroke="#15803d" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `,
    independent_fingers: `
            <svg viewBox="0 0 120 80" class="ism-mech-svg" aria-hidden="true">
                <rect x="5" y="10" width="110" height="60" fill="#f5e6c8" stroke="#8b6f47" stroke-width="1"/>
                <line x1="5" y1="22" x2="115" y2="22" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="34" x2="115" y2="34" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="46" x2="115" y2="46" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="5" y1="58" x2="115" y2="58" stroke="#8b8b8b" stroke-width="0.7"/>
                <line x1="28" y1="10" x2="28" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="51" y1="10" x2="51" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="74" y1="10" x2="74" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="97" y1="10" x2="97" y2="70" stroke="#5a4a32" stroke-width="0.8"/>
                <line x1="58" y1="10" x2="32" y2="55" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round"/>
                <line x1="60" y1="10" x2="52" y2="60" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round"/>
                <line x1="62" y1="10" x2="72" y2="60" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round"/>
                <line x1="64" y1="10" x2="92" y2="55" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="32" cy="55" r="3" fill="#15803d"/>
                <circle cx="52" cy="60" r="3" fill="#15803d"/>
                <circle cx="72" cy="60" r="3" fill="#15803d"/>
                <circle cx="92" cy="55" r="3" fill="#15803d"/>
            </svg>
        `
  };

  const MECHANISMS = [
    {
      id: 'string_sliding_fingers',
      label: 'Doigts qui glissent le long des cordes',
      description:
        'Chaque doigt est fixé à une corde et glisse le long de celle-ci sur la largeur de la main (plusieurs frettes accessibles par doigt).',
      svg: MECHANISM_SVG.string_sliding_fingers,
      v2: false
    },
    {
      id: 'fret_sliding_fingers',
      label: 'Doigts qui glissent entre les cordes',
      description:
        "Chaque doigt est fixé à un offset de frette de la main et traverse les cordes pour sélectionner laquelle presser. Option 'doigts à hauteur variable' pour 2 ou 3 doigts.",
      svg: MECHANISM_SVG.fret_sliding_fingers,
      v2: false
    },
    {
      id: 'independent_fingers',
      label: 'Doigts indépendants (humanoïde)',
      description:
        '4 doigts à 2 axes chacun (corde × frette). Permet barrés, accords arbitraires, jeu humain. Mécanisme prévu pour la V2 du projet.',
      svg: MECHANISM_SVG.independent_fingers,
      v2: true
    }
  ];

  function getPresetById(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  function getMechanismById(id) {
    return MECHANISMS.find((m) => m.id === id) || null;
  }

  // Shape consumed by ISMListeners._wireNotePresetListener: range +
  // polyphony + octave, plus the optional family-specific blocks the
  // listener knows how to apply (harmonica tuning, full string geometry).
  function normalize(p) {
    const out = {
      id: p.id,
      label: p.label,
      note_selection_mode: 'range',
      octave_mode: p.octave_mode || 'chromatic',
      note_range_min: p.note_range_min,
      note_range_max: p.note_range_max,
      polyphony: p.polyphony
    };
    if (p.harmonica_config) out.harmonica_config = p.harmonica_config;
    if (p.string_geometry) out.string_geometry = p.string_geometry;
    return out;
  }

  // Single preset list for the Notes & Capacités selector. Presets are
  // bound explicitly by GM program; drums keep their own dedicated kit
  // selector and SFX programs (120-127) have no realistic instrument, so
  // both yield [] (the preset block is then hidden).
  function getPresetsForProgram(gmProgram, channel) {
    if (channel === 9) return [];
    if (gmProgram == null) return [];
    return PRESETS.filter((p) => p.gm_programs.indexOf(gmProgram) !== -1).map(normalize);
  }

  // Flatten a string-geometry preset to the flat shape the Strings
  // sub-section dropdown expects (num_strings/scale_length_mm/num_frets/
  // default_mechanism + standard tuning[] + fretless flag).
  function flattenString(p) {
    const sg = p.string_geometry;
    return {
      id: p.id,
      label: p.label,
      family_slug: p.family_slug,
      gm_programs: p.gm_programs,
      num_strings: sg.num_strings,
      scale_length_mm: sg.scale_length_mm,
      num_frets: sg.num_frets,
      default_mechanism: sg.default_mechanism,
      tuning: Array.isArray(sg.tuning) ? sg.tuning.slice() : null,
      fretless: !!sg.fretless
    };
  }

  function filterStringPresetsByGmProgram(gmProgram) {
    if (!Number.isFinite(gmProgram)) return [];
    return PRESETS.filter((p) => p.string_geometry && p.gm_programs.indexOf(gmProgram) !== -1).map(
      flattenString
    );
  }

  function filterStringPresetsByFamily(slug) {
    if (!slug) return [];
    return PRESETS.filter((p) => p.string_geometry && p.family_slug === slug).map(flattenString);
  }

  const api = {
    PRESETS: PRESETS,
    MECHANISMS: MECHANISMS,
    getPresetById: getPresetById,
    getMechanismById: getMechanismById,
    getPresetsForProgram: getPresetsForProgram,
    filterStringPresetsByGmProgram: filterStringPresetsByGmProgram,
    filterStringPresetsByFamily: filterStringPresetsByFamily
  };

  if (typeof window !== 'undefined') window.InstrumentPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
