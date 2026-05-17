// ============================================================================
// Fichier: public/js/features/instrument-settings/HarmonicaPresets.js
// Description: Presets « Preset de l'instrument » spécifiques à l'harmonica
//   (GM 22). Chaque preset configure d'un clic la plage de notes (= nombre de
//   trous), la polyphonie (toujours 1, l'harmonica est monophonique) ET le
//   harmonica_config { type, key } consommé par HarmonicaView / la
//   restriction du clavier piano. La forme est compatible avec
//   ISMListeners._wireNotePresetListener (mêmes clés que InstrumentNotePresets
//   + un harmonica_config additionnel).
//
// Registres choisis pour coller aux vrais instruments :
//   - Diatonique Richter, 10 trous : la plage couvre exactement les 10 trous
//     (souffler hole-1 → souffler hole-10 = 36 demi-tons). Les tonalités
//     usuellement accordées une octave plus bas (Sol, La, Si♭) sont placées
//     dans cette octave grave.
//   - Chromatique solo : Do 12 trous (Do4..Do7, 3 octaves) et Do 16 trous
//     (Do3..Do7, 4 octaves).
// ============================================================================

(function() {
    'use strict';

    // note_range_min = hauteur réelle du souffler trou 1 ; +36 = souffler
    // trou 10 (les 10 trous Richter tiennent dans 36 demi-tons).
    const DIATONIC = [
        { key: 'C',  label: 'Do',  min: 60 },
        { key: 'G',  label: 'Sol', min: 55 },
        { key: 'A',  label: 'La',  min: 57 },
        { key: 'D',  label: 'Ré',  min: 62 },
        { key: 'F',  label: 'Fa',  min: 65 },
        { key: 'A#', label: 'Si♭', min: 58 },
        { key: 'E',  label: 'Mi',  min: 64 },
        { key: 'D#', label: 'Mi♭', min: 63 },
    ];

    const CHROMATIC = [
        { id: 'harmo_chromatic_c_12', label: 'Chromatique — Do (12 trous)',
          min: 60, max: 96 },
        { id: 'harmo_chromatic_c_16', label: 'Chromatique — Do (16 trous)',
          min: 48, max: 96 },
    ];

    function diatonicPreset(d) {
        const slug = d.key.toLowerCase().replace('#', 's');
        return {
            id: `harmo_diatonic_${slug}`,
            label: `Diatonique — ${d.label} (10 trous)`,
            note_selection_mode: 'range',
            octave_mode: 'chromatic',
            note_range_min: d.min,
            note_range_max: d.min + 36,
            polyphony: 1,
            harmonica_config: { type: 'diatonic', key: d.key },
        };
    }

    function chromaticPreset(c) {
        return {
            id: c.id,
            label: c.label,
            note_selection_mode: 'range',
            octave_mode: 'chromatic',
            note_range_min: c.min,
            note_range_max: c.max,
            polyphony: 1,
            harmonica_config: { type: 'chromatic', key: 'C' },
        };
    }

    // Liste ordonnée (diatoniques courants puis chromatiques). Indépendante
    // du programme : seul l'harmonica (GM 22) y a accès, via la délégation
    // depuis InstrumentNotePresets.getPresets.
    function getPresets() {
        return DIATONIC.map(diatonicPreset)
            .concat(CHROMATIC.map(chromaticPreset));
    }

    window.HarmonicaPresets = { getPresets: getPresets };
})();
