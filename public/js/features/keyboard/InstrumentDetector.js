// =============================================================================
// InstrumentDetector.js — Pure module: map instrument capabilities → view kind.
// =============================================================================
// Replaces the inline switch in KeyboardModal.getInstrumentViewInfo().
// Sans dépendance DOM. Tested in tests/frontend/keyboard/.
//
// detect(caps) → { viewKind, options, canFretboard, isBowed, isDrum,
//                  isWind, windPreset, instrumentType, instrumentSubtype,
//                  gmProgram }
//
// viewKind ∈ { 'piano' (default) | 'fretboard' | 'drumpad' |
//              'piano-slider' (wind) | 'keyboard-list' }
// =============================================================================
(function () {
    'use strict';

    // Drum-like type aliases that have been shipped historically. The schema
    // does not normalise these, so we accept all known spellings.
    const DRUM_LIKE_TYPES = new Set([
        'drum', 'drums', 'drumkit', 'drum_kit', 'percussion', 'percussive'
    ]);

    // Bowed string GM programs (mechanical equivalent uses a continuous bow
    // rather than discrete plucks). Triggers the bow bar in the fretboard view.
    const BOWED_GM = new Set([40, 41, 42, 43, 44, 45, 110]);

    // Plucked-string GM programs that don't fall into the contiguous range
    // 24..47 (those are detected by range).
    const EXTRA_FRETBOARD_GM = new Set([104, 105, 106, 107, 110]);

    /**
     * Pure detection function. Takes the resolved capabilities object
     * (typically built by the backend instrument_capabilities query) plus
     * a selectedDevice fallback for channel/program, plus optional
     * stringInstrumentConfig (set manually by the user) and a windDb
     * reference. Returns a fully-resolved view info bag.
     *
     * @param {Object} ctx
     * @param {Object} [ctx.capabilities]
     *   Resolved instrument_capabilities row (instrument_type, channel,
     *   gm_program, instrument_subtype, …).
     * @param {Object} [ctx.selectedDevice]
     *   Fallback for channel/gm_program when capabilities is incomplete.
     * @param {Object} [ctx.stringInstrumentConfig]
     *   When set, force fretboard regardless of GM detection.
     * @param {{ isWindInstrument: Function, getPresetByProgram: Function }} [ctx.windDb]
     *   Wind instrument database (injected). Falls back to global
     *   WindInstrumentDatabase if present.
     */
    function detect(ctx = {}) {
        const caps          = ctx.capabilities || null;
        const selectedDevice= ctx.selectedDevice || null;
        const stringCfg     = ctx.stringInstrumentConfig || null;
        const windDb        = ctx.windDb
            || (typeof window !== 'undefined' ? window.WindInstrumentDatabase : null);

        const type = (caps && caps.instrument_type) || 'unknown';
        const subtype = (caps && caps.instrument_subtype) || '';

        const channel = caps && caps.channel !== undefined
            ? caps.channel
            : (selectedDevice && selectedDevice.channel !== undefined ? selectedDevice.channel : null);

        const gmProgram = (caps && caps.gm_program) ?? (selectedDevice && selectedDevice.gm_program);

        // Drum: explicit drum-like type, channel 9, or GM ≥ 128
        const isDrum = (typeof type === 'string' && DRUM_LIKE_TYPES.has(type.toLowerCase()))
            || channel === 9
            || (gmProgram !== undefined && gmProgram !== null && gmProgram >= 128);

        // String: explicit "string" type, an active stringInstrumentConfig,
        // or a GM program in the guitar/bass/orchestral/ethnic-strings ranges.
        // GM 46 (Orchestral Harp) is *excluded* here so a plain harp gets
        // its dedicated vertical-string HarpView instead of the fretboard.
        // An explicit instrument_type='string' or a manual stringCfg still
        // forces fretboard below (escape hatch preserved).
        const stringByGm = !isDrum
            && gmProgram !== undefined && gmProgram !== null
            && (((gmProgram >= 24 && gmProgram <= 47) && gmProgram !== 46)
                || EXTRA_FRETBOARD_GM.has(gmProgram));

        const canFretboard = type === 'string' || !!stringCfg || stringByGm;

        const isBowed = canFretboard
            && gmProgram !== undefined && gmProgram !== null
            && BOWED_GM.has(gmProgram);

        // Wind: GM programs 56-79 (brass, reeds, pipe) — only when not drum/string
        const isWind = !!(!isDrum && !canFretboard
            && gmProgram !== undefined && gmProgram !== null
            && windDb && typeof windDb.isWindInstrument === 'function'
            && windDb.isWindInstrument(gmProgram));

        const windPreset = isWind && windDb && typeof windDb.getPresetByProgram === 'function'
            ? windDb.getPresetByProgram(gmProgram)
            : null;

        // Harmonica (GM 22): a free-reed instrument with blow/draw holes —
        // neither a drum, a fretted/bowed string, nor a (wind-DB) wind
        // instrument. Gets its own dedicated blow/draw hole layout.
        const isHarmonica = !isDrum && !canFretboard && !isWind
            && gmProgram === 22;

        // Harp (GM 46): vertical strings plucked individually, glissando by
        // horizontal drag. Excluded from the fretboard range above so a
        // plain harp lands here (unless forced to string/fretboard).
        const isHarp = !isDrum && !canFretboard && !isWind
            && gmProgram === 46;

        // Resolve viewKind from boolean flags (default: piano).
        let viewKind = 'piano';
        if (isDrum)            viewKind = 'drumpad';
        else if (canFretboard) viewKind = 'fretboard';
        else if (isWind)       viewKind = 'piano-slider';
        else if (isHarmonica)  viewKind = 'harmonica';
        else if (isHarp)       viewKind = 'harp';

        return {
            viewKind,
            options: { isBowed, windPreset },
            canFretboard,
            isBowed,
            isDrum,
            isWind,
            isHarmonica,
            isHarp,
            windPreset,
            instrumentType: type,
            instrumentSubtype: subtype,
            gmProgram
        };
    }

    const InstrumentDetector = Object.freeze({
        detect,
        // Exposed for tests / debugging.
        _DRUM_LIKE_TYPES: DRUM_LIKE_TYPES,
        _BOWED_GM: BOWED_GM,
        _EXTRA_FRETBOARD_GM: EXTRA_FRETBOARD_GM
    });

    if (typeof window !== 'undefined') window.InstrumentDetector = InstrumentDetector;
    if (typeof module !== 'undefined') module.exports = InstrumentDetector;
})();
