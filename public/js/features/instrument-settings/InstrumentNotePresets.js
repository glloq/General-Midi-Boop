// ============================================================================
// Fichier: public/js/features/instrument-settings/InstrumentNotePresets.js
// Description: Presets « Notes & accords » par famille GM, exposés en haut de
//   l'onglet Notes & Capacités. Un preset configure la plage de notes jouables
//   et la polyphonie (= capacité d'accords). Pour les vents (GM 56-79) les
//   plages proviennent de WindInstrumentDatabase. La batterie (garde son
//   propre sélecteur de kits) et les synthés sont exclus.
// ============================================================================

(function() {
    'use strict';

    // Presets génériques par famille. Plages MIDI (0-127), polyphonie 1 =
    // monophonique, N = accords possibles.
    const FAMILY_PRESETS = {
        keyboards: [
            { id: 'kb_full88',  label: 'Clavier complet 88 (A0–C8)', note_range_min: 21, note_range_max: 108, polyphony: 10 },
            { id: 'kb_melody',  label: 'Mélodie main droite',         note_range_min: 60, note_range_max: 96,  polyphony: 1  },
            { id: 'kb_chords',  label: 'Accompagnement accords',      note_range_min: 48, note_range_max: 84,  polyphony: 6  },
            { id: 'kb_bass',    label: 'Basse main gauche',           note_range_min: 28, note_range_max: 55,  polyphony: 2  },
        ],
        organs: [
            { id: 'org_std',    label: 'Plage standard',  note_range_min: 36, note_range_max: 96, polyphony: 8 },
            { id: 'org_high',   label: 'Manuel aigu',     note_range_min: 60, note_range_max: 96, polyphony: 6 },
            { id: 'org_pedal',  label: 'Pédalier basse',  note_range_min: 24, note_range_max: 48, polyphony: 1 },
        ],
        chromatic_percussion: [
            { id: 'cp_std',     label: 'Plage standard',  note_range_min: 53, note_range_max: 89, polyphony: 4 },
            { id: 'cp_high',    label: 'Aigu',            note_range_min: 72, note_range_max: 96, polyphony: 2 },
            { id: 'cp_mono',    label: 'Mélodie solo',    note_range_min: 60, note_range_max: 96, polyphony: 1 },
        ],
        ensembles: [
            { id: 'ens_full',   label: 'Section complète', note_range_min: 28, note_range_max: 100, polyphony: 12 },
            { id: 'ens_high',   label: 'Pupitre aigu',     note_range_min: 60, note_range_max: 96,  polyphony: 8  },
            { id: 'ens_low',    label: 'Pupitre grave',    note_range_min: 28, note_range_max: 60,  polyphony: 6  },
        ],
        plucked_strings: [
            { id: 'pl_guitar',  label: 'Guitare standard (E2–E6)', note_range_min: 40, note_range_max: 88, polyphony: 6 },
            { id: 'pl_bass',    label: 'Basse (E1–G4)',            note_range_min: 28, note_range_max: 67, polyphony: 4 },
            { id: 'pl_lead',    label: 'Solo monophonique',        note_range_min: 52, note_range_max: 88, polyphony: 1 },
        ],
        bowed_strings: [
            { id: 'bw_violin',  label: 'Violon (G3–E7)',  note_range_min: 55, note_range_max: 100, polyphony: 2 },
            { id: 'bw_cello',   label: 'Violoncelle (C2–C6)', note_range_min: 36, note_range_max: 84, polyphony: 2 },
            { id: 'bw_mono',    label: 'Solo monophonique', note_range_min: 48, note_range_max: 96, polyphony: 1 },
        ],
        // Anches non couvertes par WindInstrumentDatabase (accordéon 21,
        // harmonica 22, bandonéon 23, cornemuse 109, etc.) → presets génériques.
        reeds: [
            { id: 'rd_std',     label: 'Plage standard', note_range_min: 50, note_range_max: 88, polyphony: 1 },
            { id: 'rd_full',    label: 'Tessiture large', note_range_min: 43, note_range_max: 96, polyphony: 1 },
        ],
        brass: [
            { id: 'br_std',     label: 'Plage standard', note_range_min: 40, note_range_max: 84, polyphony: 1 },
            { id: 'br_section', label: 'Section cuivres', note_range_min: 40, note_range_max: 84, polyphony: 4 },
        ],
        winds: [
            { id: 'wd_std',     label: 'Plage standard', note_range_min: 60, note_range_max: 96, polyphony: 1 },
        ],
    };

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

    // Presets dérivés de WindInstrumentDatabase pour les GM 56-79 (un par
    // instrument : tessiture complète + tessiture confortable, monophonique).
    function windPresets(gmProgram) {
        const DB = window.WindInstrumentDatabase;
        const wp = DB && DB.PRESETS ? DB.PRESETS[gmProgram] : null;
        if (!wp) return null;
        const out = [];
        if (Number.isFinite(wp.rangeMin) && Number.isFinite(wp.rangeMax)) {
            out.push(withDefaults({
                id: 'wind_full', label: `${wp.name} — tessiture complète`,
                note_range_min: wp.rangeMin, note_range_max: wp.rangeMax, polyphony: 1,
            }));
        }
        if (Number.isFinite(wp.comfortMin) && Number.isFinite(wp.comfortMax)) {
            out.push(withDefaults({
                id: 'wind_comfort', label: `${wp.name} — tessiture confortable`,
                note_range_min: wp.comfortMin, note_range_max: wp.comfortMax, polyphony: 1,
            }));
        }
        return out.length ? out : null;
    }

    function getFamilySlug(gmProgram, channel) {
        const fam = window.InstrumentFamilies
            && window.InstrumentFamilies.getFamilyForProgram
            ? window.InstrumentFamilies.getFamilyForProgram(gmProgram, channel)
            : null;
        return fam ? fam.slug : null;
    }

    // API publique : liste des presets applicables pour l'instrument courant.
    // Retourne [] si aucun preset (batterie, synthés, famille inconnue).
    function getPresets(gmProgram, channel, familySlug) {
        // Batterie : sélecteur de kits dédié, pas de preset de plage ici.
        if (channel === 9) return [];
        if (gmProgram == null) return [];

        const slug = familySlug || getFamilySlug(gmProgram, channel);
        if (!slug || slug === 'synths' || slug === 'drum_kits') return [];

        // Vents GM 56-79 : plages réelles depuis WindInstrumentDatabase.
        if (gmProgram >= 56 && gmProgram <= 79) {
            const wp = windPresets(gmProgram);
            if (wp) return wp;
        }

        const list = FAMILY_PRESETS[slug];
        return Array.isArray(list) ? list.map(withDefaults) : [];
    }

    window.InstrumentNotePresets = { getPresets };
})();
