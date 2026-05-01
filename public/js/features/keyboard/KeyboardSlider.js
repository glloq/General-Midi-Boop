// =============================================================================
// KeyboardSlider.js — Mixin : Mode A "Root Control" (Slider → chordRoot)
// =============================================================================
// Intégration du NoteSlider en mode A dans le fretboard view :
//   Slider position → rootClass → _setChordRootFromSlider() → voicing affiché
//
// Dépendances (chargées avant ce fichier) :
//   NoteEngine.js, VoicingEngine.js, NoteSlider.js, KeyboardChords.js
// =============================================================================
(function () {
    'use strict';

    const KeyboardSliderMixin = {};

    // ── Initialisation ────────────────────────────────────────────────────────

    /**
     * Initialise le slider de racine d'accord (Mode A) dans la zone dédiée
     * du fretboard. Doit être appelé après renderFretboard().
     *
     * - Plage : C4–B4 (48–59), chromatique → 12 positions = 12 classes de hauteur
     * - Glisser → rootClass mis à jour silencieusement (pas de strum)
     * - L'utilisateur déclenche le strum en appuyant sur un bouton d'accord
     */
    KeyboardSliderMixin.initNoteSliderModeA = function () {
        if (typeof NoteEngine === 'undefined' || typeof NoteSlider === 'undefined') {
            this.logger && this.logger.warn('[KeyboardSlider] NoteEngine ou NoteSlider non disponibles');
            return;
        }

        const container = document.getElementById('note-slider-area');
        if (!container) return;

        // Détruire une instance précédente si elle existe
        this.destroyNoteSlider();

        // ── NoteEngine : une octave chromatique (C4-B4) ──
        const engine = new NoteEngine();
        engine.setScale(0, 'chromatic');
        engine.setRange(48, 59); // C4 à B4

        // ── VoicingEngine : synchronisé avec le config instrument courant ──
        const cfg        = this.stringInstrumentConfig || {};
        const numStrings = Math.max(1, cfg.num_strings || 6);
        let tuning       = null;
        if (Array.isArray(cfg.tuning) && cfg.tuning.length === numStrings) {
            tuning = cfg.tuning;
        } else if (Array.isArray(cfg.tuning_midi) && cfg.tuning_midi.length === numStrings) {
            tuning = cfg.tuning_midi;
        }
        if (typeof VoicingEngine !== 'undefined') {
            this._voicingEngine = new VoicingEngine(tuning, numStrings);
        }

        // ── NoteSlider ──
        const slider = new NoteSlider(container, engine, {
            minNote: 48,
            maxNote: 59,
            mode: 'discrete',
            height: 52,
            labelFormat: this.noteLabelFormat || 'english',
        });

        // ── Câblage : notechange → rootClass ──
        slider.on('notechange', (note) => {
            const rootClass = note % 12;
            if (typeof this._setChordRootFromSlider === 'function') {
                this._setChordRootFromSlider(rootClass);
            }
        });

        this._noteSlider = slider;
        this._noteEngine = engine;
    };

    // ── Nettoyage ─────────────────────────────────────────────────────────────

    /**
     * Détruit le slider et libère les ressources associées.
     * Appelé automatiquement avant toute re-création et lors du changement de vue.
     */
    KeyboardSliderMixin.destroyNoteSlider = function () {
        if (this._noteSlider) {
            this._noteSlider.destroy();
            this._noteSlider = null;
        }
        this._noteEngine    = null;
        this._voicingEngine = null;
    };

    // ── Synchronisation notation ──────────────────────────────────────────────

    /**
     * Resynchronise le format de label du slider avec le format courant du modal.
     * Appeler après un changement de noteLabelFormat.
     */
    KeyboardSliderMixin.syncSliderLabelFormat = function () {
        if (this._noteSlider && typeof this._noteSlider.setLabelFormat === 'function') {
            this._noteSlider.setLabelFormat(this.noteLabelFormat || 'english');
        }
    };

    if (typeof window !== 'undefined') window.KeyboardSliderMixin = KeyboardSliderMixin;
})();
