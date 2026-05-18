// ============================================================================
// Fichier: public/js/features/instrument-settings/InstrumentNotePresets.js
// Description: Presets « Notes & accords » dérivés des capacités réelles de
//   l'instrument GM sélectionné (window.GmInstrumentCapabilities). Un preset
//   configure la plage de notes jouables et la polyphonie (= capacité
//   d'accords). La batterie (sélecteur de kits dédié), les synthés et les
//   familles inconnues n'ont pas de preset ici.
// ============================================================================

(function() {
    'use strict';

    function withDefaults(p) {
        return {
            id: p.id,
            label: p.label,
            note_selection_mode: 'range',
            octave_mode: 'chromatic',
            note_range_min: p.note_range_min,
            note_range_max: p.note_range_max,
            polyphony: p.polyphony,
        };
    }

    function getFamilySlug(gmProgram, channel) {
        const fam = window.InstrumentFamilies
            && window.InstrumentFamilies.getFamilyForProgram
            ? window.InstrumentFamilies.getFamilyForProgram(gmProgram, channel)
            : null;
        return fam ? fam.slug : null;
    }

    // API publique : liste des presets applicables pour l'instrument courant.
    // Retourne [] si aucun preset (batterie, synthés, famille inconnue, ou
    // capacités introuvables). La forme de chaque preset reste celle attendue
    // par ISMListeners._wireNotePresetListener.
    function getPresets(gmProgram, channel, familySlug) {
        // Batterie : sélecteur de kits dédié, pas de preset de plage ici.
        if (channel === 9) return [];
        if (gmProgram == null) return [];

        // Harmonica (GM 22) : presets dédiés (diatonique/chromatique +
        // tonalité) qui remplacent les presets génériques de tessiture —
        // « tessiture complète » n'a aucun sens sur un vrai harmonica.
        if (gmProgram === 22 && window.HarmonicaPresets) {
            return window.HarmonicaPresets.getPresets();
        }

        const slug = familySlug || getFamilySlug(gmProgram, channel);
        if (!slug || slug === 'synths' || slug === 'drum_kits') return [];

        const caps = window.GmInstrumentCapabilities;
        const cap = caps && caps.get ? caps.get(gmProgram) : null;
        if (!cap) return [];

        const mid = Math.round((cap.comfortMin + cap.comfortMax) / 2);
        const out = [];

        // Tessiture complète : tout ce que l'instrument peut physiquement jouer.
        out.push(withDefaults({
            id: 'cap_full',
            label: 'Tessiture complète',
            note_range_min: cap.rangeMin,
            note_range_max: cap.rangeMax,
            polyphony: cap.polyphony,
        }));

        // Tessiture confortable : registre usuel (omis si identique au complet).
        if (cap.comfortMin !== cap.rangeMin || cap.comfortMax !== cap.rangeMax) {
            out.push(withDefaults({
                id: 'cap_comfort',
                label: 'Tessiture confortable',
                note_range_min: cap.comfortMin,
                note_range_max: cap.comfortMax,
                polyphony: cap.polyphony,
            }));
        }

        // Mélodie solo : moitié haute du registre confortable, monophonique.
        out.push(withDefaults({
            id: 'cap_melody',
            label: 'Mélodie (solo)',
            note_range_min: mid,
            note_range_max: cap.comfortMax,
            polyphony: 1,
        }));

        // Accords / accompagnement : registre médian, polyphonie de
        // l'instrument — uniquement pour les instruments polyphoniques.
        if (!cap.monophonic) {
            out.push(withDefaults({
                id: 'cap_chords',
                label: 'Accords / accompagnement',
                note_range_min: cap.comfortMin,
                note_range_max: mid,
                polyphony: cap.polyphony,
            }));
        }

        // Basse : partie grave, pour les instruments qui descendent bas.
        if (cap.comfortMin <= 48) {
            out.push(withDefaults({
                id: 'cap_bass',
                label: 'Basse',
                note_range_min: cap.rangeMin,
                note_range_max: mid,
                polyphony: Math.min(cap.polyphony, 2),
            }));
        }

        return out;
    }

    window.InstrumentNotePresets = { getPresets: getPresets };
})();
