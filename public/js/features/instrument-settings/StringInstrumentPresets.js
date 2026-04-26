/**
 * StringInstrumentPresets
 * Liste de presets géométriques pour les instruments à cordes (cordes,
 * échelle en mm, frettes, mécanisme de main recommandé) utilisée par
 * l'onglet "Main" du modal Réglages d'instrument.
 *
 * Source de vérité : `shared/string-instrument-presets.json`. Ce fichier
 * miroir inline les données pour permettre un chargement synchrone côté
 * navigateur (pas de fetch nécessaire à l'ouverture du modal). Un test
 * Vitest doit s'assurer que les deux restent synchronisés.
 *
 * Exposé via `window.StringInstrumentPresets` :
 *   - PRESETS : tableau ordonné de presets
 *   - MECHANISMS : 3 mécanismes (string_sliding_fingers, fret_sliding_fingers, independent_fingers)
 *   - getPresetById(id)
 *   - getMechanismById(id)
 *   - filterPresetsByFamily(slug)
 *   - filterPresetsByGmProgram(gmProgram)
 *   - getDefaultPresetForGmProgram(gmProgram, channel)
 */
(function() {
    'use strict';

    const PRESETS = [
        { id: 'acoustic_guitar_nylon',  label: 'Guitare classique (nylon)',     family_slug: 'plucked_strings', gm_programs: [24],                     num_strings: 6,  scale_length_mm: 650,  num_frets: 19, default_mechanism: 'string_sliding_fingers' },
        { id: 'acoustic_guitar_steel',  label: 'Guitare acoustique (steel)',    family_slug: 'plucked_strings', gm_programs: [25],                     num_strings: 6,  scale_length_mm: 648,  num_frets: 20, default_mechanism: 'string_sliding_fingers' },
        { id: 'electric_guitar',        label: 'Guitare électrique',            family_slug: 'plucked_strings', gm_programs: [26, 27, 28, 29, 30, 31], num_strings: 6,  scale_length_mm: 648,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'electric_guitar_gibson', label: 'Guitare électrique (Gibson)',   family_slug: 'plucked_strings', gm_programs: [26, 27, 28, 29, 30, 31], num_strings: 6,  scale_length_mm: 628,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'guitar_baritone',        label: 'Guitare baryton',               family_slug: 'plucked_strings', gm_programs: [26, 27, 28, 29, 30, 31], num_strings: 6,  scale_length_mm: 686,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'guitar_7string',         label: 'Guitare 7 cordes',              family_slug: 'plucked_strings', gm_programs: [26, 27, 28, 29, 30, 31], num_strings: 7,  scale_length_mm: 648,  num_frets: 24, default_mechanism: 'string_sliding_fingers' },
        { id: 'guitar_12string',        label: 'Guitare 12 cordes',             family_slug: 'plucked_strings', gm_programs: [25],                     num_strings: 12, scale_length_mm: 648,  num_frets: 20, default_mechanism: 'string_sliding_fingers' },
        { id: 'bass_acoustic',          label: 'Basse acoustique',              family_slug: 'plucked_strings', gm_programs: [32],                     num_strings: 4,  scale_length_mm: 864,  num_frets: 20, default_mechanism: 'string_sliding_fingers' },
        { id: 'bass_long',              label: 'Basse électrique (long 34")',   family_slug: 'plucked_strings', gm_programs: [33, 34, 35, 36, 37, 38, 39], num_strings: 4, scale_length_mm: 864,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'bass_short',             label: 'Basse électrique (short 30")',  family_slug: 'plucked_strings', gm_programs: [33, 34, 35, 36, 37, 38, 39], num_strings: 4, scale_length_mm: 762,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'bass_5string',           label: 'Basse 5 cordes (35")',          family_slug: 'plucked_strings', gm_programs: [33, 34, 35, 36, 37, 38, 39], num_strings: 5, scale_length_mm: 889,  num_frets: 24, default_mechanism: 'string_sliding_fingers' },
        { id: 'harp',                   label: 'Harpe',                         family_slug: 'plucked_strings', gm_programs: [46],                     num_strings: 47, scale_length_mm: 1700, num_frets: 0,  default_mechanism: 'fret_sliding_fingers' },
        { id: 'sitar',                  label: 'Sitar',                         family_slug: 'plucked_strings', gm_programs: [104],                    num_strings: 7,  scale_length_mm: 870,  num_frets: 20, default_mechanism: 'string_sliding_fingers' },
        { id: 'banjo',                  label: 'Banjo (5 cordes)',              family_slug: 'plucked_strings', gm_programs: [105],                    num_strings: 5,  scale_length_mm: 660,  num_frets: 22, default_mechanism: 'string_sliding_fingers' },
        { id: 'shamisen',               label: 'Shamisen',                      family_slug: 'plucked_strings', gm_programs: [106],                    num_strings: 3,  scale_length_mm: 615,  num_frets: 0,  default_mechanism: 'string_sliding_fingers' },
        { id: 'koto',                   label: 'Koto',                          family_slug: 'plucked_strings', gm_programs: [107],                    num_strings: 13, scale_length_mm: 1820, num_frets: 0,  default_mechanism: 'fret_sliding_fingers' },
        { id: 'ukulele_soprano',        label: 'Ukulélé (soprano)',             family_slug: 'plucked_strings', gm_programs: [24, 25],                 num_strings: 4,  scale_length_mm: 350,  num_frets: 12, default_mechanism: 'string_sliding_fingers' },
        { id: 'ukulele_concert',        label: 'Ukulélé (concert)',             family_slug: 'plucked_strings', gm_programs: [24, 25],                 num_strings: 4,  scale_length_mm: 380,  num_frets: 15, default_mechanism: 'string_sliding_fingers' },
        { id: 'ukulele_tenor',          label: 'Ukulélé (tenor)',               family_slug: 'plucked_strings', gm_programs: [24, 25],                 num_strings: 4,  scale_length_mm: 430,  num_frets: 17, default_mechanism: 'string_sliding_fingers' },
        { id: 'ukulele_baritone',       label: 'Ukulélé (baritone)',            family_slug: 'plucked_strings', gm_programs: [24, 25],                 num_strings: 4,  scale_length_mm: 510,  num_frets: 18, default_mechanism: 'string_sliding_fingers' },
        { id: 'mandolin',               label: 'Mandoline',                     family_slug: 'plucked_strings', gm_programs: [25, 26],                 num_strings: 8,  scale_length_mm: 350,  num_frets: 20, default_mechanism: 'string_sliding_fingers' },
        { id: 'violin',                 label: 'Violon',                        family_slug: 'bowed_strings',   gm_programs: [40],                     num_strings: 4,  scale_length_mm: 328,  num_frets: 0,  default_mechanism: 'string_sliding_fingers' },
        { id: 'viola',                  label: 'Alto',                          family_slug: 'bowed_strings',   gm_programs: [41],                     num_strings: 4,  scale_length_mm: 380,  num_frets: 0,  default_mechanism: 'string_sliding_fingers' },
        { id: 'cello',                  label: 'Violoncelle',                   family_slug: 'bowed_strings',   gm_programs: [42],                     num_strings: 4,  scale_length_mm: 690,  num_frets: 0,  default_mechanism: 'string_sliding_fingers' },
        { id: 'contrabass',             label: 'Contrebasse',                   family_slug: 'bowed_strings',   gm_programs: [43],                     num_strings: 4,  scale_length_mm: 1050, num_frets: 0,  default_mechanism: 'string_sliding_fingers' },
        { id: 'fiddle',                 label: 'Fiddle (folk)',                 family_slug: 'bowed_strings',   gm_programs: [110],                    num_strings: 4,  scale_length_mm: 328,  num_frets: 0,  default_mechanism: 'string_sliding_fingers' }
    ];

    // Inline SVGs used as the picture on each mechanism card. Same
    // viewBox (120 × 80) so the cards stay aligned. Visual convention:
    //   - light beige rectangle = fretboard
    //   - 5 horizontal grey lines = strings (left = nut, right = bridge)
    //   - 4 vertical darker lines = frets
    //   - green semi-opaque rectangle = the hand
    //   - inside the hand:
    //       * horizontal bars in `string_sliding_fingers` = each finger
    //         slides along its string within the hand width.
    //       * vertical bars in `fret_sliding_fingers` = each finger
    //         slides between the strings at its fret offset.
    //       * 4 small dots in `independent_fingers` = a stylised hand
    //         on the fretboard, no directional hint (each finger moves
    //         in 2D independently).
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
            description: 'Chaque doigt est fixé à une corde et glisse le long de celle-ci sur la largeur de la main (plusieurs frettes accessibles par doigt).',
            svg: MECHANISM_SVG.string_sliding_fingers,
            v2: false
        },
        {
            id: 'fret_sliding_fingers',
            label: 'Doigts qui glissent entre les cordes',
            description: 'Chaque doigt est fixé à un offset de frette de la main et traverse les cordes pour sélectionner laquelle presser. Option « doigts à hauteur variable » pour 2 ou 3 doigts.',
            svg: MECHANISM_SVG.fret_sliding_fingers,
            v2: false
        },
        {
            id: 'independent_fingers',
            label: 'Doigts indépendants (humanoïde)',
            description: '4 doigts à 2 axes chacun (corde × frette). Permet barrés, accords arbitraires, jeu humain. Mécanisme prévu pour la V2 du projet.',
            svg: MECHANISM_SVG.independent_fingers,
            v2: true
        }
    ];

    function getPresetById(id) {
        return PRESETS.find(p => p.id === id) || null;
    }

    function getMechanismById(id) {
        return MECHANISMS.find(m => m.id === id) || null;
    }

    /**
     * All presets attached to a given family slug (e.g. 'plucked_strings').
     * Used by the modal to filter the dropdown to relevant entries only.
     */
    function filterPresetsByFamily(slug) {
        if (!slug) return [];
        return PRESETS.filter(p => p.family_slug === slug);
    }

    /**
     * All presets that mention `gmProgram` in their `gm_programs` list.
     * Order is preserved so the picker can highlight the canonical entry
     * first. Returns an empty array when nothing matches (caller can fall
     * back to filterPresetsByFamily).
     */
    function filterPresetsByGmProgram(gmProgram) {
        if (!Number.isFinite(gmProgram)) return [];
        return PRESETS.filter(p => Array.isArray(p.gm_programs) && p.gm_programs.includes(gmProgram));
    }

    /**
     * Best preset to seed an instrument's geometry when its identity
     * changes. Returns the first GM-program-matching preset, or null
     * when the program isn't a string instrument.
     *
     * Channel is accepted for parity with `InstrumentFamilies.getFamilyForProgram`
     * but currently unused — drum kits never resolve to a string preset.
     */
    function getDefaultPresetForGmProgram(gmProgram, _channel) {
        const matches = filterPresetsByGmProgram(gmProgram);
        return matches.length > 0 ? matches[0] : null;
    }

    const api = {
        PRESETS: PRESETS,
        MECHANISMS: MECHANISMS,
        getPresetById: getPresetById,
        getMechanismById: getMechanismById,
        filterPresetsByFamily: filterPresetsByFamily,
        filterPresetsByGmProgram: filterPresetsByGmProgram,
        getDefaultPresetForGmProgram: getDefaultPresetForGmProgram
    };

    if (typeof window !== 'undefined') window.StringInstrumentPresets = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
