// ============================================================================
// KeyboardWind.js — Mixin: Wind instrument controls (articulation + range)
// ============================================================================
(function () {
    'use strict';

    const KeyboardWindMixin = {};

    // Articulation definitions matching WindArticulationPanel presets
    const WIND_ARTICULATIONS = {
        normal:   { velocityFactor: 1.0 },
        legato:   { velocityFactor: 1.0 },
        staccato: { velocityFactor: 0.9, staccato: true },
        accent:   { velocityFactor: 1.2 },
    };

    // Max duration for staccato auto-stop (ms)
    const STACCATO_MAX_MS = 120;

    // ── Panel lifecycle ───────────────────────────────────────────────────────

    KeyboardWindMixin._initWindPanel = function () {
        const panel = document.getElementById('wind-instrument-panel');
        if (!panel) return;
        panel.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-art]');
            if (btn) this._setWindArticulation(btn.dataset.art);
        });
    };

    KeyboardWindMixin._showWindControls = function (preset) {
        this.windPreset = preset || null;

        const panel = document.getElementById('wind-instrument-panel');
        if (!panel) return;
        panel.classList.remove('hidden');

        const nameEl = document.getElementById('wind-instrument-name');
        if (nameEl && preset) nameEl.textContent = preset.name || '';

        const rangeEl = document.getElementById('wind-range-display');
        if (rangeEl && preset) {
            const rMin = this.getNoteLabel(preset.rangeMin);
            const rMax = this.getNoteLabel(preset.rangeMax);
            const cMin = this.getNoteLabel(preset.comfortMin);
            const cMax = this.getNoteLabel(preset.comfortMax);
            rangeEl.innerHTML = `<span class="wind-range-full">${rMin}–${rMax}</span>`
                + `<span class="wind-range-sep"> · </span>`
                + `<span class="wind-range-comfort" title="Comfort zone">${cMin}–${cMax}</span>`;
        }

        this._setWindArticulation(this.currentArticulation);
    };

    KeyboardWindMixin._hideWindControls = function () {
        this._clearWindComfortZone();
        this._cancelStaccatoTimers();
        this.windPreset = null;
        const panel = document.getElementById('wind-instrument-panel');
        if (panel) panel.classList.add('hidden');
    };

    // ── Articulation management ───────────────────────────────────────────────

    KeyboardWindMixin._setWindArticulation = function (artName) {
        if (!WIND_ARTICULATIONS[artName]) artName = 'normal';
        this.currentArticulation = artName;
        const panel = document.getElementById('wind-instrument-panel');
        if (!panel) return;
        panel.querySelectorAll('[data-art]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.art === artName);
        });
    };

    // ── Comfort zone highlighting ─────────────────────────────────────────────

    KeyboardWindMixin._applyWindComfortZone = function () {
        this._clearWindComfortZone();
        if (!this.windPreset) return;
        const { rangeMin, rangeMax, comfortMin, comfortMax } = this.windPreset;
        const strip = document.getElementById('piano-slider-strip');
        if (!strip) return;
        strip.querySelectorAll('.piano-slider-key').forEach(key => {
            const note = parseInt(key.dataset.note, 10);
            if (note < rangeMin || note > rangeMax) {
                key.classList.add('wind-out-of-range');
            } else if (note >= comfortMin && note <= comfortMax) {
                key.classList.add('wind-comfort-zone');
            }
        });
    };

    KeyboardWindMixin._clearWindComfortZone = function () {
        const strip = document.getElementById('piano-slider-strip');
        if (!strip) return;
        strip.querySelectorAll('.piano-slider-key.wind-comfort-zone, .piano-slider-key.wind-out-of-range')
            .forEach(k => k.classList.remove('wind-comfort-zone', 'wind-out-of-range'));
    };

    // ── Staccato timer management ─────────────────────────────────────────────

    KeyboardWindMixin._cancelStaccatoTimers = function () {
        if (!this._staccatoTimers) return;
        this._staccatoTimers.forEach(id => clearTimeout(id));
        this._staccatoTimers.clear();
    };

    // ── Piano-slider toggle visibility override ───────────────────────────────
    // Extend the base rule: wind instruments can use piano-slider even without
    // pitch_bend_enabled (they use equal-width chromatic layout for range display).

    KeyboardWindMixin._updatePianoSliderGroupVisibility = function () {
        const group = document.getElementById('keyboard-piano-slider-group');
        if (!group) return;
        const isPianoFamily = this.viewMode === 'piano' || this.viewMode === 'piano-slider';
        const caps = this.selectedDeviceCapabilities;
        const pitchBendEnabled = !!(caps && caps.pitch_bend_enabled);
        const show = isPianoFamily && (pitchBendEnabled || !!this.windPreset);
        group.classList.toggle('hidden', !show);
        if (!show && this.viewMode === 'piano-slider') {
            this.setViewMode('piano');
        }
    };

    // ── playNote override — apply articulation velocity factor ────────────────

    KeyboardWindMixin.playNote = function (note) {
        const orig = this._windOrigPlayNote;
        if (!this.windPreset) {
            orig.call(this, note);
            return;
        }

        if (note < 0 || note > 127) return;

        const art = WIND_ARTICULATIONS[this.currentArticulation] || WIND_ARTICULATIONS.normal;
        const savedVelocity = this.velocity;
        this.velocity = Math.min(127, Math.round(savedVelocity * art.velocityFactor));
        orig.call(this, note);
        this.velocity = savedVelocity;

        // Staccato: schedule automatic note-off after STACCATO_MAX_MS
        if (art.staccato) {
            if (!this._staccatoTimers) this._staccatoTimers = new Map();
            if (this._staccatoTimers.has(note)) clearTimeout(this._staccatoTimers.get(note));
            const timer = setTimeout(() => {
                if (this.activeNotes && this.activeNotes.has(note)) this.stopNote(note);
                if (this._staccatoTimers) this._staccatoTimers.delete(note);
            }, STACCATO_MAX_MS);
            this._staccatoTimers.set(note, timer);
        }
    };

    if (typeof window !== 'undefined') window.KeyboardWindMixin = KeyboardWindMixin;
})();
