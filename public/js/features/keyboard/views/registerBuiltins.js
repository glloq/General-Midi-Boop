// =============================================================================
// registerBuiltins.js — Register the 5 built-in views + detection rules.
// =============================================================================
// Loaded AFTER the individual view classes (Piano/Fretboard/DrumPad/
// PianoSlider/List) so that `window.<NameView>` exists. The registry itself
// (`window.instrumentViews`) is loaded earlier.
//
// Adding a new instrument-specific view = 1 fichier + 2 lignes ici.
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    const registry = window.instrumentViews;
    if (!registry) {
        console.warn('[registerBuiltins] instrumentViews registry missing');
        return;
    }

    // ── Register classes ──────────────────────────────────────────────────────
    // Each *View module exposes its class as `window.<NameView>` once loaded.
    // Phase D will populate these classes; until then the modal still uses
    // the legacy mixin code paths. Skip silently when the class is absent
    // so we can land the wiring before the implementations.
    function safeRegister(ClassRef) {
        if (typeof ClassRef === 'function') registry.register(ClassRef);
    }
    safeRegister(window.PianoView);
    safeRegister(window.PianoSliderView);
    safeRegister(window.FretboardView);
    safeRegister(window.DrumPadView);
    safeRegister(window.ListView);
    safeRegister(window.HarmonicaView);
    safeRegister(window.HarpView);
    safeRegister(window.AccordionView);
    safeRegister(window.MalletView);
    safeRegister(window.MusicBoxView);
    safeRegister(window.KalimbaView);
    safeRegister(window.BagpipeView);
    safeRegister(window.SteelDrumView);
    safeRegister(window.ThereminView);
    safeRegister(window.PercussionPadView);

    // ── Detection rules (first match wins) ────────────────────────────────────
    // These mirror the historical getInstrumentViewInfo() logic, now driven
    // by data instead of an inline switch. Easy to add a new instrument:
    //   registry.addRule(c => c.gm_program === 21, 'accordion');

    const DRUM_TYPES = new Set([
        'drum', 'drums', 'drumkit', 'drum_kit', 'percussion', 'percussive'
    ]);
    const inRange = (lo, hi) => (c) =>
        c && c.gm_program !== undefined && c.gm_program !== null
        && c.gm_program >= lo && c.gm_program <= hi;
    const isOneOf = (set) => (c) =>
        c && c.gm_program !== undefined && c.gm_program !== null
        && set.has(c.gm_program);

    registry
        // Drumpad: channel 9 or drum type or program ≥ 128
        .addRule(c => c && c.channel === 9, 'drumpad')
        .addRule(c => c && typeof c.instrument_type === 'string'
            && DRUM_TYPES.has(c.instrument_type.toLowerCase()), 'drumpad')
        .addRule(c => c && c.gm_program !== undefined && c.gm_program !== null
            && c.gm_program >= 128, 'drumpad')

        // Theremin: explicit custom type (no GM patch). First so an
        // instrument_type='theremin' always wins.
        .addRule(c => c && typeof c.instrument_type === 'string'
            && c.instrument_type.toLowerCase() === 'theremin', 'theremin')

        // Harp (GM 46): dedicated vertical-string view. MUST precede the
        // fretboard 24-47 range rule since 46 ∈ [24,47] (first match wins).
        .addRule(c => c && c.gm_program === 46, 'harp')

        // Other dedicated layouts (GM disjoint from fretboard/wind ranges).
        .addRule(c => c && (c.gm_program === 21 || c.gm_program === 23), 'accordion')
        // Tuned mallet/percussion bars. GM 47 (Timpani) ∈ [24,47] so this
        // MUST precede the fretboard range rule below (first match wins;
        // same precedent as the harp GM 46 rule above).
        .addRule(inRange(12, 15), 'mallet')
        // Glockenspiel (9) + Vibraphone (11) only. Celesta (8) and
        // Timpani (47) stay on the standard piano keyboard (user spec);
        // Music Box (10) has its own dedicated view.
        .addRule(isOneOf(new Set([9, 11])), 'mallet')
        .addRule(c => c && c.gm_program === 10, 'music-box')
        .addRule(c => c && c.gm_program === 108, 'kalimba')
        .addRule(c => c && c.gm_program === 109, 'bagpipe')
        .addRule(c => c && c.gm_program === 114, 'steel-drum')
        // Trigger-pad grid: non-melodic percussion + sound effects. After
        // steel-drum (114 keeps its dedicated view); 120-127 precede the
        // fretboard range rule (disjoint, but kept here for clarity).
        .addRule(isOneOf(new Set([112, 113, 115, 116, 117, 118, 119])), 'perc-pad')
        .addRule(inRange(120, 127), 'perc-pad')

        // Fretboard: guitar/bass/orchestral strings (24-45) + ethnic
        // plucked + bowed. 46 (Harp) handled by its rule above; 47
        // (Timpani) intentionally NOT here so it falls back to piano.
        .addRule(inRange(24, 45), 'fretboard')
        .addRule(isOneOf(new Set([104, 105, 106, 107, 110])), 'fretboard')
        .addRule(c => c && c.instrument_type === 'string', 'fretboard')

        // Harmonica: dedicated blow/draw hole layout (GM 22)
        .addRule(c => c && c.gm_program === 22, 'harmonica')

        // Wind: piano + slider for brass/reeds/pipe (GM 56-79)
        .addRule(inRange(56, 79), 'piano-slider', { wind: true })
        // Shanai (GM 111): double-reed aerophone, non-contiguous with the
        // 56-79 wind range. Disjoint from every rule above so order is free.
        .addRule(c => c && c.gm_program === 111, 'piano-slider', { wind: true });

    // Catch-all is implicit: registry.resolve() falls back to 'piano'.
})();
