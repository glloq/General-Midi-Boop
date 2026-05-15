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

        // Harp (GM 46): dedicated vertical-string view. MUST precede the
        // fretboard 24-47 range rule since 46 ∈ [24,47] (first match wins).
        .addRule(c => c && c.gm_program === 46, 'harp')

        // Fretboard: guitar/bass/orchestral strings + ethnic plucked + bowed
        .addRule(inRange(24, 47), 'fretboard')
        .addRule(isOneOf(new Set([104, 105, 106, 107, 110])), 'fretboard')
        .addRule(c => c && c.instrument_type === 'string', 'fretboard')

        // Harmonica: dedicated blow/draw hole layout (GM 22)
        .addRule(c => c && c.gm_program === 22, 'harmonica')

        // Wind: piano + slider for brass/reeds/pipe (GM 56-79)
        .addRule(inRange(56, 79), 'piano-slider', { wind: true });

    // Catch-all is implicit: registry.resolve() falls back to 'piano'.
})();
