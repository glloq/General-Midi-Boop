/**
 * @file HandsPreviewPanel.js
 * @description Orchestrator for the per-channel hand-position
 * preview embedded in the RoutingSummaryPage detail panel
 * (Feature E). Picks the right layout (keyboard / fretboard) based
 * on the routed instrument's hands_config mode, instantiates the
 * right widgets, and wires the HandSimulationEngine events to them.
 *
 * Public API:
 *   const panel = new HandsPreviewPanel(container, {
 *     channel,           // number, source MIDI channel
 *     notes,             // [{tick, note, fret?, string?, channel?}]
 *     instrument,        // {hands_config, scale_length_mm?, …}
 *     ticksPerBeat,      // from midiData.header
 *     bpm,               // float
 *     overrides,         // optional starter overrides (E.6.1 shape)
 *     onSeek,            // optional callback when minimap or play
 *                        //   advances the playhead — the parent
 *                        //   page can mirror the position into its
 *                        //   own minimap.
 *   });
 *   panel.play();  panel.pause();  panel.reset();
 *   panel.setOverrides(o);
 *   panel.destroy();
 */
(function() {
    'use strict';

    function _resolveMode(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; }
        }
        if (!cfg || cfg.enabled === false) return 'unknown';
        return cfg.mode === 'frets' ? 'frets' : 'semitones';
    }

    function _hands(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { return []; }
        }
        return Array.isArray(cfg?.hands) ? cfg.hands : [];
    }

    /** Pick a colour per hand id — left=blue, right=green, fretting=amber. */
    function _handColor(id) {
        if (id === 'left') return '#3b82f6';
        if (id === 'right') return '#10b981';
        if (id === 'fretting') return '#f59e0b';
        return '#6b7280';
    }

    function _t(key, fallback) {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    class HandsPreviewPanel {
        constructor(container, opts = {}) {
            this.container = container;
            this.opts = opts;
            this.channel = Number.isFinite(opts.channel) ? opts.channel : 0;
            this.instrument = opts.instrument || null;
            this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
            this.ticksPerBeat = Number.isFinite(opts.ticksPerBeat) && opts.ticksPerBeat > 0 ? opts.ticksPerBeat : 480;
            this.bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 120;
            this.overrides = opts.overrides || null;
            this.onSeek = opts.onSeek || null;

            this.mode = _resolveMode(this.instrument);
            this.engine = null;
            this.keyboard = null;
            this.lookahead = null;
            this.fretboard = null;
            this._currentHandWindows = new Map(); // handId → anchor

            this._render();
            this._wireEngine();
        }

        // -----------------------------------------------------------------
        //  Rendering
        // -----------------------------------------------------------------

        _render() {
            if (!this.container) return;
            this.container.innerHTML = '';
            this.container.classList.add('hands-preview-panel');

            const header = document.createElement('div');
            header.className = 'hpp-header';
            header.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;';
            // Transport (play/pause/seek) is intentionally NOT in the
            // panel header — the operator drives playback from the
            // existing per-channel preview button (or "Preview all")
            // and the minimap; the page calls `setCurrentTime` on us
            // every progress callback so the visualization stays in
            // sync with whatever's actually being played.
            header.innerHTML = `
                <strong style="font-size:13px;">${_t('handsPreview.title', 'Aperçu des mains')}</strong>
                <span style="flex:1;"></span>
                <span class="hpp-hint" style="font-size:11px;color:#6b7280;">${_t('handsPreview.transportHint', 'Lecture pilotée par le bouton Aperçu du canal et la minimap')}</span>
                <span style="display:inline-block;width:1px;height:18px;background:#d1d5db;margin:0 4px;"></span>
                <button class="hpp-reset-overrides" type="button"
                        title="${_t('handsPreview.resetOverrides', 'Annuler les overrides')}">↺</button>
                <button class="hpp-save" type="button" disabled
                        title="${_t('handsPreview.saveClean', 'Aucune modification à sauvegarder')}">${_t('handsPreview.save', 'Enregistrer')}</button>
            `;
            this.container.appendChild(header);

            this._resetOverridesBtn = header.querySelector('.hpp-reset-overrides');
            this._saveBtn = header.querySelector('.hpp-save');
            this._resetOverridesBtn.addEventListener('click', () => this.resetOverrides());
            this._saveBtn.addEventListener('click', () => {
                this.saveOverrides()
                    .then(() => this._refreshSaveButton())
                    .catch(err => {
                        // Stay non-blocking: log + restore the dirty
                        // state so the operator can retry.
                        console.error('[HandsPreviewPanel] saveOverrides failed:', err);
                        this._dirty = true;
                        this._refreshSaveButton();
                    });
            });

            const body = document.createElement('div');
            body.className = 'hpp-body';
            body.style.cssText = 'padding:8px;';
            this.container.appendChild(body);

            if (this.mode === 'unknown') {
                body.innerHTML = `
                    <p style="color:#6b7280;font-size:12px;text-align:center;padding:16px;">
                        ${_t('handsPreview.noHandsConfig',
                             'Aucune configuration des mains pour cet instrument — la pré-visualisation est désactivée.')}
                    </p>
                `;
                return;
            }

            if (this.mode === 'semitones') {
                this._renderKeyboardLayout(body);
            } else {
                this._renderFretsLayout(body);
            }
        }

        _renderKeyboardLayout(body) {
            // 1. Vertical look-ahead strip — notes fall toward the
            // keyboard below. Taller than the old horizontal bar so
            // the operator has time to read the next bars (≈ 4 s of
            // music spread vertically).
            const lookCanvas = document.createElement('canvas');
            lookCanvas.className = 'hpp-lookahead';
            lookCanvas.style.cssText = 'width:100%;height:140px;display:block;border:1px solid #e5e7eb;border-bottom:none;border-radius:4px 4px 0 0;';
            body.appendChild(lookCanvas);

            // 2. Keyboard widget directly below the strip — same x
            // axis (we share rangeMin/rangeMax) so each note column
            // aligns with the key it will play.
            const kbCanvas = document.createElement('canvas');
            kbCanvas.className = 'hpp-keyboard';
            kbCanvas.style.cssText = 'width:100%;height:120px;display:block;border:1px solid #e5e7eb;border-radius:0 0 4px 4px;';
            body.appendChild(kbCanvas);

            const rangeMin = Number.isFinite(this.instrument?.note_range_min) ? this.instrument.note_range_min : 21;
            const rangeMax = Number.isFinite(this.instrument?.note_range_max) ? this.instrument.note_range_max : 108;

            const ticksPerSecond = this.ticksPerBeat * (this.bpm / 60);
            this.lookahead = new window.HandsLookaheadStrip(lookCanvas, {
                notes: this.notes,
                ticksPerSecond,
                rangeMin, rangeMax,
                windowSeconds: 4
            });
            this.keyboard = new window.KeyboardPreview(kbCanvas, {
                rangeMin, rangeMax,
                bandHeight: 8,
                onKeyClick: (midi) => this._onKeyClick(midi),
                // Drag a hand band to repin its anchor at the
                // current playhead. The simulator picks up the new
                // override on the very next chord.
                onBandDrag: (handId, newAnchor) => this.pinHandAnchor(handId, newAnchor)
            });
            // Initial paint with empty bands.
            this.keyboard.draw();
            this.lookahead.draw();
        }

        _renderFretsLayout(body) {
            const fbCanvas = document.createElement('canvas');
            fbCanvas.className = 'hpp-fretboard';
            fbCanvas.style.cssText = 'width:100%;height:200px;display:block;border:1px solid #e5e7eb;border-radius:4px;';
            body.appendChild(fbCanvas);

            const cfg = {
                tuning: this.instrument?.tuning || [40, 45, 50, 55, 59, 64],
                num_frets: this.instrument?.num_frets || 24,
                is_fretless: !!this.instrument?.is_fretless,
                capo_fret: this.instrument?.capo_fret || 0
            };
            this.fretboard = new window.FretboardDiagram(fbCanvas, cfg);
            // FretboardDiagram already supports setHandWindow + setActivePositions.
        }

        // -----------------------------------------------------------------
        //  Engine wiring
        // -----------------------------------------------------------------

        _wireEngine() {
            if (this.mode === 'unknown') return;
            if (!window.HandSimulationEngine) return;
            this.engine = new window.HandSimulationEngine({
                notes: this.notes,
                instrument: this.instrument,
                ticksPerBeat: this.ticksPerBeat,
                bpm: this.bpm,
                overrides: this.overrides
            });

            this.engine.on('shift', (e) => {
                const { handId, toAnchor } = e.detail;
                this._currentHandWindows.set(handId, toAnchor);
                this._refreshHandsView();
            });
            this.engine.on('chord', (e) => {
                const { notes, unplayable } = e.detail;
                if (this.keyboard) {
                    this.keyboard.setActiveNotes(notes.map(n => n.note));
                    this.keyboard.setUnplayableNotes(unplayable.map(u => ({ note: u.note, hand: u.handId })));
                }
                if (this.lookahead) {
                    this.lookahead.setUnplayableNotes(unplayable.map(u => u.note));
                }
                if (this.fretboard) {
                    this.fretboard.setActivePositions(notes
                        .filter(n => Number.isFinite(n.fret) && Number.isFinite(n.string))
                        .map(n => ({ string: n.string, fret: n.fret, velocity: n.velocity || 100 })));
                }
            });
            this.engine.on('tick', (e) => {
                if (this.lookahead) this.lookahead.setCurrentTime(e.detail.currentSec);
                if (typeof this.onSeek === 'function') {
                    this.onSeek(e.detail.currentTick, e.detail.totalTicks);
                }
            });
            this.engine.on('end', () => {
                if (this._playBtn) this._playBtn.disabled = false;
            });
        }

        // -----------------------------------------------------------------
        //  Edit mode (E.6.8)
        // -----------------------------------------------------------------

        /**
         * Toggle a note's "disabled" state at the current playhead
         * tick. Updates the in-memory overrides + flags the panel as
         * dirty so the Save button signals an unsaved edit.
         */
        toggleDisabledNote(midi) {
            if (!Number.isFinite(midi)) return;
            const tick = this.engine?.currentTick() || 0;
            this.overrides = this.overrides || { hand_anchors: [], disabled_notes: [], version: 1 };
            if (!Array.isArray(this.overrides.disabled_notes)) this.overrides.disabled_notes = [];
            const idx = this.overrides.disabled_notes
                .findIndex(n => n.tick === tick && n.note === midi);
            if (idx >= 0) {
                this.overrides.disabled_notes.splice(idx, 1);
            } else {
                this.overrides.disabled_notes.push({ tick, note: midi, reason: 'user' });
            }
            this._markDirty();
            // Re-arm the engine so the next chord at this tick honours
            // the new disabled list. setOverrides is a full rebuild
            // which is overkill but cheap on a single channel.
            this.setOverrides(this.overrides);
        }

        /**
         * Pin a hand's anchor at the current tick. Used by the future
         * drag interaction (and exposed via the public API so tests
         * can drive it without simulating a drag gesture).
         */
        pinHandAnchor(handId, anchor) {
            if (!handId || !Number.isFinite(anchor)) return;
            const tick = this.engine?.currentTick() || 0;
            this.overrides = this.overrides || { hand_anchors: [], disabled_notes: [], version: 1 };
            if (!Array.isArray(this.overrides.hand_anchors)) this.overrides.hand_anchors = [];
            const idx = this.overrides.hand_anchors
                .findIndex(a => a.tick === tick && a.handId === handId);
            const entry = { tick, handId, anchor };
            if (idx >= 0) this.overrides.hand_anchors[idx] = entry;
            else this.overrides.hand_anchors.push(entry);
            this._markDirty();
            this.setOverrides(this.overrides);
        }

        /** Reset overrides + revert UI back to the planner defaults. */
        resetOverrides() {
            this.overrides = null;
            this._dirty = false;
            this._refreshSaveButton();
            this.setOverrides(null);
        }

        /**
         * Persist the current overrides via the routing_save_hand_overrides
         * WS command. The caller (RoutingSummaryPage) provides the API
         * client + routing identifiers via opts.saveCtx.
         *
         * @returns {Promise<{updated:number}>}
         */
        async saveOverrides() {
            const ctx = this.opts.saveCtx;
            const apiClient = ctx?.apiClient;
            if (!apiClient || typeof apiClient.sendCommand !== 'function') {
                throw new Error('saveOverrides: apiClient is not wired');
            }
            if (ctx.fileId == null || ctx.deviceId == null || !Number.isFinite(this.channel)) {
                throw new Error('saveOverrides: missing fileId / channel / deviceId');
            }
            const res = await apiClient.sendCommand('routing_save_hand_overrides', {
                fileId: ctx.fileId,
                channel: this.channel,
                deviceId: ctx.deviceId,
                overrides: this.overrides
            });
            this._dirty = false;
            this._refreshSaveButton();
            return res || { updated: 0 };
        }

        _markDirty() {
            this._dirty = true;
            this._refreshSaveButton();
        }

        _refreshSaveButton() {
            if (!this._saveBtn) return;
            this._saveBtn.disabled = !this._dirty;
            this._saveBtn.title = this._dirty
                ? _t('handsPreview.saveDirty', 'Modifications non sauvegardées')
                : _t('handsPreview.saveClean', 'Aucune modification à sauvegarder');
        }

        _refreshHandsView() {
            const hands = _hands(this.instrument);
            if (this.mode === 'semitones' && this.keyboard) {
                const bands = hands.map(h => {
                    const anchor = this._currentHandWindows.get(h.id);
                    if (!Number.isFinite(anchor)) return null;
                    const span = h.hand_span_semitones ?? 14;
                    return { id: h.id, low: anchor, high: anchor + span, color: _handColor(h.id) };
                }).filter(Boolean);
                this.keyboard.setHandBands(bands);
            } else if (this.mode === 'frets' && this.fretboard) {
                const fretting = hands.find(h => h && h.id === 'fretting') || hands[0];
                const anchor = this._currentHandWindows.get(fretting?.id);
                if (Number.isFinite(anchor) && Number.isFinite(fretting?.hand_span_frets)) {
                    this.fretboard.setHandWindow({
                        anchorFret: anchor,
                        spanFrets: fretting.hand_span_frets,
                        level: 'ok'
                    });
                }
            }
        }

        _onKeyClick(midi) {
            // E.6.8 — clicking a key toggles the note's "disabled"
            // state at the current playhead. Bypassed when the host
            // page wants to handle the click itself (rare; kept for
            // power-user customization).
            if (typeof this.opts.onKeyClick === 'function') {
                if (this.opts.onKeyClick(midi) === false) return;
            }
            this.toggleDisabledNote(midi);
        }

        // -----------------------------------------------------------------
        //  External transport (driven by RoutingSummaryPage's preview
        //  callbacks + minimap, NOT by panel-local buttons).
        // -----------------------------------------------------------------

        /**
         * Drive the visualization to `currentSec`. The host (e.g.
         * audio preview onProgress) calls this on every tick so the
         * keyboard / fretboard / look-ahead stay in sync. Forward
         * jumps emit chord/shift events, backward jumps fast-forward
         * silently to keep hand-state consistent.
         */
        setCurrentTime(currentSec) {
            this.engine?.advanceToSec(Number.isFinite(currentSec) ? currentSec : 0);
            // The lookahead listens to its own setCurrentTime via the
            // engine's tick event; nothing else to do here.
        }

        /** Force an immediate jump back to tick 0 (used when the
         *  preview is stopped externally so the next play starts
         *  from a clean state). */
        reset() {
            this.engine?.reset();
            this._currentHandWindows.clear();
            if (this.keyboard) {
                this.keyboard.setActiveNotes([]);
                this.keyboard.setUnplayableNotes([]);
                this.keyboard.setHandBands([]);
            }
            if (this.lookahead) this.lookahead.setCurrentTime(0);
            if (this.fretboard) {
                this.fretboard.setActivePositions([]);
                this.fretboard.setHandWindow(null);
            }
        }

        /** Direct seek (in ticks). Used by the minimap callback. */
        seek(tick) {
            this.engine?.seek(tick);
        }

        setOverrides(overrides) {
            this.overrides = overrides || null;
            // Rebuild the engine so the new overrides take effect.
            const wasPlaying = this.engine?.isPlaying;
            this.engine?.dispose();
            this._wireEngine();
            if (wasPlaying) this.play();
        }

        destroy() {
            this.engine?.dispose();
            this.engine = null;
            if (this.keyboard) { this.keyboard.destroy(); this.keyboard = null; }
            if (this.lookahead) { this.lookahead.destroy(); this.lookahead = null; }
            if (this.fretboard) { this.fretboard.destroy?.(); this.fretboard = null; }
            if (this.container) this.container.innerHTML = '';
        }
    }

    if (typeof window !== 'undefined') {
        window.HandsPreviewPanel = HandsPreviewPanel;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HandsPreviewPanel;
    }
})();
