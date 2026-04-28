/**
 * InstrumentFamilies
 * Taxonomie par famille physique d'instruments, utilisée par le sélecteur
 * d'identité du modal Réglages d'instrument. 13 familles qui regroupent les
 * 128 programmes GM (0-127) + la dimension orthogonale "drum_kits" (canal 10).
 *
 * Chaque programme 0-127 appartient à exactement une famille mélodique.
 * La famille `drum_kits` regroupe les 9 kits GM et force le canal à 9.
 *
 * Exposé via `window.InstrumentFamilies` :
 *   - FAMILIES            : tableau ordonné des 13 familles
 *   - getFamilyBySlug(slug)
 *   - getFamilyForProgram(program, channel) → family | null
 *   - getAllFamilies()
 *   - isDrumFamily(slug)
 *   - resolveInstrumentIcon({ gmProgram, channel }) → { svgUrl, emoji, name, slug }
 *   - programSlug(program) → string | null   (nom canonique du SVG)
 *   - GM_DRUM_KITS_LIST   : kits GM (référence locale dédupliquée)
 */
(function() {
    'use strict';

    // ===== 11 FAMILIES (display order) =====
    const FAMILIES = [
        { slug: 'keyboards',            labelKey: 'instrumentFamilies.keyboards',           emoji: '🎹',  programs: [0,1,2,3,4,5,6,7] },
        { slug: 'chromatic_percussion', labelKey: 'instrumentFamilies.chromaticPercussion', emoji: '🔔',  programs: [8,9,10,11,12,13,14,15, 47, 108, 112,113,114,115,116,117,118,119] },
        { slug: 'organs',               labelKey: 'instrumentFamilies.organs',              emoji: '⛪',  programs: [16,17,18,19,20] },
        { slug: 'plucked_strings',      labelKey: 'instrumentFamilies.pluckedStrings',      emoji: '🎸',
          programs: [24,25,26,27,28,29,30,31, 32,33,34,35,36,37,38,39, 46, 104,105,106,107] },
        { slug: 'bowed_strings',        labelKey: 'instrumentFamilies.bowedStrings',        emoji: '🎻',  programs: [40,41,42,43,44,45, 110] },
        { slug: 'ensembles',            labelKey: 'instrumentFamilies.ensembles',           emoji: '🎼',  programs: [48,49,50,51,52,53,54,55] },
        { slug: 'brass',                labelKey: 'instrumentFamilies.brass',               emoji: '🎺',  programs: [56,57,58,59,60,61,62,63] },
        { slug: 'reeds',                labelKey: 'instrumentFamilies.reeds',               emoji: '🎷',
          programs: [21,22,23, 64,65,66,67,68,69,70,71, 109,111] },
        { slug: 'winds',                labelKey: 'instrumentFamilies.winds',               emoji: '🪈',  programs: [72,73,74,75,76,77,78,79] },
        { slug: 'synths',               labelKey: 'instrumentFamilies.synths',              emoji: '🎛️',
          programs: [80,81,82,83,84,85,86,87, 88,89,90,91,92,93,94,95, 96,97,98,99,100,101,102,103, 120,121,122,123,124,125,126,127] },
        { slug: 'drum_kits',            labelKey: 'instrumentFamilies.drumKits',            emoji: '🥁',  programs: 'drumKits', isDrumKits: true, forceChannel: 9 }
    ];

    // Reverse lookup program → family slug (built once, drum_kits excluded)
    const PROGRAM_TO_FAMILY = new Map();
    for (const fam of FAMILIES) {
        if (fam.isDrumKits) continue;
        for (const p of fam.programs) PROGRAM_TO_FAMILY.set(p, fam.slug);
    }

    // Integrity check: every GM program 0-127 maps to exactly one family
    if (typeof console !== 'undefined' && console.warn) {
        for (let p = 0; p < 128; p++) {
            if (!PROGRAM_TO_FAMILY.has(p)) {
                console.warn('[InstrumentFamilies] GM program without family:', p);
            }
        }
    }

    // ===== SVG SLUG MAPPING =====
    // Canonical slug for each GM program, matching files in the SVG library
    // (/assets/instruments/<slug>.svg). Programs without a drawn SVG map to null
    // so the resolver can skip the HTTP request and go straight to the emoji
    // fallback. Keys are GM program numbers 0-127.
    const PROGRAM_TO_SLUG = {
        0: 'acoustic_grand', 2: 'electric_grand',
        4: 'electric_piano_1', 5: 'electric_piano_2',
        6: 'harpsichord', 7: 'clavinet',
        8: 'celesta', 9: 'glockenspiel', 10: 'music_box',
        11: 'vibraphone', 12: 'marimba', 13: 'xylophone',
        14: 'tubular_bells', 15: 'dulcimer',
        16: 'drawbar', 19: 'church_organ', 20: 'reed_organ',
        21: 'accordion', 22: 'harmonica', 23: 'tango_accordion',
        24: 'nylon', 25: 'steel', 26: 'jazz', 27: 'clean',
        28: 'muted', 29: 'overdrive', 30: 'distortion', 31: 'harmonics',
        32: 'acoustic', 33: 'finger',
        40: 'violin', 42: 'cello', 43: 'contrabass',
        46: 'harp', 47: 'timpani',
        48: 'string_ensemble_1', 52: 'choir_aahs',
        56: 'trumpet', 57: 'trombone', 58: 'tuba', 60: 'french_horn',
        64: 'soprano_sax', 65: 'alto_sax', 66: 'tenor_sax',
        68: 'oboe', 70: 'bassoon', 71: 'clarinet',
        73: 'flute', 74: 'recorder', 75: 'pan_flute',
        76: 'bottle', 77: 'shakuhachi', 78: 'whistle', 79: 'ocarina',
        104: 'sitar', 105: 'banjo', 106: 'shamisen', 107: 'koto',
        108: 'kalimba', 109: 'bagpipe', 111: 'shanai',
        112: 'tinkle_bell', 113: 'agogo', 114: 'steel_drums',
        115: 'woodblock', 116: 'taiko', 117: 'melodic_tom',
        119: 'reverse_cymbal'
    };

    // Drum kit list (mirror of window.GM_DRUM_KITS defined in index.html; kept
    // locally so this module is self-sufficient if loaded before index.html body)
    const GM_DRUM_KITS_LIST = [
        { program: 0,  name: 'Standard Kit' },
        { program: 8,  name: 'Room Kit' },
        { program: 16, name: 'Power Kit' },
        { program: 24, name: 'Electronic Kit' },
        { program: 25, name: 'TR-808 Kit' },
        { program: 32, name: 'Jazz Kit' },
        { program: 40, name: 'Brush Kit' },
        { program: 48, name: 'Orchestra Kit' },
        { program: 56, name: 'SFX Kit' }
    ];

    // ===== HELPERS =====

    function getFamilyBySlug(slug) {
        for (const f of FAMILIES) if (f.slug === slug) return f;
        return null;
    }

    function getFamilyForProgram(program, channel) {
        if (channel === 9) return getFamilyBySlug('drum_kits');
        if (program === null || program === undefined) return null;
        if (program >= 128) return getFamilyBySlug('drum_kits'); // encoded drum kit
        const slug = PROGRAM_TO_FAMILY.get(program);
        return slug ? getFamilyBySlug(slug) : null;
    }

    function getAllFamilies() { return FAMILIES.slice(); }

    function isDrumFamily(slug) {
        const f = getFamilyBySlug(slug);
        return !!(f && f.isDrumKits);
    }

    function programSlug(program) {
        if (program === null || program === undefined) return null;
        return PROGRAM_TO_SLUG[program] || null;
    }

    /**
     * Resolve the icon surface for an instrument slot.
     * - For a drum kit: slug is `drum_kit_<program>`, svgUrl only if asset exists.
     * - For a melodic program: slug from PROGRAM_TO_SLUG, svgUrl if slug non-null.
     * - Without program: returns a family-level icon (emoji only).
     *
     * `svgUrl` may still 404 if the asset is not deployed yet; consumers should
     * use an `<img onerror>` fallback to the emoji. When `slug` is null, the
     * caller should render the emoji directly without ever requesting an SVG.
     */
    function resolveInstrumentIcon(opts) {
        const gmProgram = opts && opts.gmProgram != null ? opts.gmProgram : null;
        const channel = opts && opts.channel != null ? opts.channel : null;
        const family = getFamilyForProgram(gmProgram, channel);
        const familyEmoji = family ? family.emoji : '🎵';

        // Drum kit slot
        if (family && family.isDrumKits) {
            // Program is either raw (0, 8, 16…) or encoded (128+raw). Normalize.
            let kitProgram = gmProgram;
            if (kitProgram != null && kitProgram >= 128) kitProgram = kitProgram - 128;
            const slug = kitProgram != null ? ('drum_kit_' + kitProgram) : null;
            const name = kitProgram != null
                ? _lookupDrumKitName(kitProgram)
                : null;
            return {
                svgUrl: slug ? ('/assets/instruments/' + slug + '.svg') : null,
                emoji: familyEmoji,
                name: name,
                slug: slug,
                family: family
            };
        }

        // Melodic program
        const slug = programSlug(gmProgram);
        const name = gmProgram != null && typeof window !== 'undefined' && typeof window.getGMInstrumentName === 'function'
            ? window.getGMInstrumentName(gmProgram)
            : null;

        return {
            svgUrl: slug ? ('/assets/instruments/' + slug + '.svg') : null,
            emoji: familyEmoji,
            name: name,
            slug: slug,
            family: family
        };
    }

    function _lookupDrumKitName(program) {
        const kit = GM_DRUM_KITS_LIST.find(function(k) { return k.program === program; });
        if (!kit) return null;
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const key = 'instruments.drumKits.' + program;
            const t = window.i18n.t(key);
            if (t && t !== key) return t;
        }
        return kit.name;
    }

    /**
     * URL for a family-level icon (/assets/instruments/family_<slug>.svg).
     * Not guaranteed to exist yet — callers must handle the onerror fallback.
     */
    function familyIconUrl(slug) {
        return '/assets/instruments/family_' + slug + '.svg';
    }

    const api = {
        FAMILIES: FAMILIES,
        PROGRAM_TO_SLUG: PROGRAM_TO_SLUG,
        GM_DRUM_KITS_LIST: GM_DRUM_KITS_LIST,
        getFamilyBySlug: getFamilyBySlug,
        getFamilyForProgram: getFamilyForProgram,
        getAllFamilies: getAllFamilies,
        isDrumFamily: isDrumFamily,
        programSlug: programSlug,
        resolveInstrumentIcon: resolveInstrumentIcon,
        familyIconUrl: familyIconUrl
    };

    if (typeof window !== 'undefined') window.InstrumentFamilies = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
