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
            this.fretboardLookahead = null;
            this._currentHandWindows = new Map(); // handId → anchor (semitones only)
            this._currentTick = 0;

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
            // The "Open editor" button is rendered conditionally (only
            // in frets mode AND when the editor module is loaded). Even
            // if the script load order changes, the lookup is lazy so a
            // missing module just hides the button instead of erroring.
            const showEditorBtn = this.mode === 'frets'
                && typeof window !== 'undefined'
                && typeof window.HandPositionEditorModal === 'function';
            const editorBtnHtml = showEditorBtn
                ? `<button class="hpp-open-editor" type="button"
                          title="${_t('handPositionEditor.openButtonTitle',
                                       'Éditer la position de main sur toute la durée')}">
                       ${_t('handPositionEditor.openButton', 'Éditeur')}
                   </button>`
                : '';
            header.innerHTML = `
                <strong style="font-size:13px;">${_t('handsPreview.title', 'Aperçu des mains')}</strong>
                <span style="flex:1;"></span>
                <span class="hpp-hint" style="font-size:11px;color:#6b7280;">${_t('handsPreview.transportHint', 'Lecture pilotée par le bouton Aperçu du canal et la minimap')}</span>
                <span style="display:inline-block;width:1px;height:18px;background:#d1d5db;margin:0 4px;"></span>
                ${editorBtnHtml}
                <button class="hpp-reset-overrides" type="button"
                        title="${_t('handsPreview.resetOverrides', 'Annuler les overrides')}">↺</button>
                <button class="hpp-save" type="button" disabled
                        title="${_t('handsPreview.saveClean', 'Aucune modification à sauvegarder')}">${_t('handsPreview.save', 'Enregistrer')}</button>
            `;
            this.container.appendChild(header);

            this._resetOverridesBtn = header.querySelector('.hpp-reset-overrides');
            this._saveBtn = header.querySelector('.hpp-save');
            this._openEditorBtn = header.querySelector('.hpp-open-editor');
            if (this._openEditorBtn) {
                this._openEditorBtn.addEventListener('click', () => this._openFullLengthEditor());
            }
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
            // Lookahead strip ABOVE the live fretboard — vertical
            // timeline (now at the bottom, +4s at the top). Shows
            // the planned hand band over the next few seconds.
            const handsArr = _hands(this.instrument);
            const fretting = handsArr.find(h => h && h.id === 'fretting') || handsArr[0] || {};
            const fbCommonOpts = {
                tuning: this.instrument?.tuning || [40, 45, 50, 55, 59, 64],
                numFrets: this.instrument?.num_frets || 24,
                scaleLengthMm: this.instrument?.scale_length_mm,
                handSpanMm: fretting.hand_span_mm,
                handSpanFrets: fretting.hand_span_frets || 4
            };
            if (typeof window !== 'undefined' && window.FretboardLookaheadStrip) {
                const strip = document.createElement('canvas');
                strip.className = 'hpp-fretboard-lookahead';
                strip.style.cssText = 'width:100%;height:140px;display:block;border:1px solid #e5e7eb;border-bottom:none;border-radius:4px 4px 0 0;background:#f5f7fb;';
                body.appendChild(strip);
                this.fretboardLookahead = new window.FretboardLookaheadStrip(strip, {
                    ...fbCommonOpts,
                    windowSeconds: 4
                });
            }

            const fbCanvas = document.createElement('canvas');
            fbCanvas.className = 'hpp-fretboard';
            const radius = this.fretboardLookahead ? '0 0 4px 4px' : '4px';
            fbCanvas.style.cssText = `width:100%;height:160px;display:block;border:1px solid #e5e7eb;border-radius:${radius};background:#f5f7fb;`;
            body.appendChild(fbCanvas);

            const PreviewClass = (typeof window !== 'undefined' && window.FretboardHandPreview)
                ? window.FretboardHandPreview
                : window.FretboardDiagram;
            // Drag the live band to repin the fretting hand at the
            // current playhead — same UX as the keyboard's onBandDrag,
            // ported in PR3. The callback is wired to `pinHandAnchor`
            // which the HandsPreviewPanel already exposes for keyboards
            // (line ~189 / `KeyboardPreview` setup).
            const frettingId = (handsArr.find(h => h && h.id === 'fretting') || handsArr[0])?.id || 'fretting';
            this.fretboard = new PreviewClass(fbCanvas, {
                ...fbCommonOpts,
                handId: frettingId,
                onBandDrag: (handId, newAnchor) => this.pinHandAnchor(handId, newAnchor)
            });
            // Initial paint so the empty board is visible before the
            // first engine event lands.
            this.fretboard.draw && this.fretboard.draw();
            if (this.fretboardLookahead) this.fretboardLookahead.draw();
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
                // Frets mode no longer uses `_currentHandWindows` —
                // the fretboard derives its band position from the
                // trajectory + playhead. Only the keyboard's
                // semitones path still relies on the per-hand anchor
                // map (`_refreshHandsView` semitones branch).
                if (this.mode === 'semitones') this._refreshHandsView();
            });
            this.engine.on('chord', (e) => {
                const { notes, unplayable } = e.detail;
                if (this.keyboard) {
                    this.keyboard.setActiveNotes(
                        notes.map(n => ({ midi: n.note, handId: n.handId || null }))
                    );
                    this.keyboard.setUnplayableNotes(unplayable.map(u => ({ note: u.note, hand: u.handId })));
                }
                if (this.lookahead) {
                    this.lookahead.setUnplayableNotes(unplayable.map(u => u.note));
                }
                if (this.fretboard) {
                    this.fretboard.setActivePositions(notes
                        .filter(n => Number.isFinite(n.fret) && Number.isFinite(n.string))
                        .map(n => ({ string: n.string, fret: n.fret, velocity: n.velocity || 100 })));
                    // Surface unplayable notes (`outside_window`,
                    // `too_many_fingers`) as a red overlay on the
                    // fretboard. Only entries with a defined string
                    // and fret reach the preview.
                    this.fretboard.setUnplayablePositions(unplayable
                        .filter(u => Number.isFinite(u.string) && Number.isFinite(u.fret)));
                    // Reachability drives the band colour. Red when
                    // the simulator says the chord can't be played
                    // at this position (`too_many_fingers` or
                    // `outside_window`); green otherwise. Speed
                    // infeasibility is signalled by the trajectory
                    // animation lag, NOT by the band colour.
                    const level =
                        unplayable.some(u => u.reason === 'too_many_fingers'
                                          || u.reason === 'outside_window')
                            ? 'infeasible' : 'ok';
                    this.fretboard.setLevel(level);
                }
                if (this.mode === 'semitones') this._refreshHandsView();
            });
            this.engine.on('tick', (e) => {
                this._currentTick = e.detail.currentTick;
                if (this.lookahead) this.lookahead.setCurrentTime(e.detail.currentSec);
                if (this.fretboard
                        && typeof this.fretboard.setCurrentTime === 'function') {
                    this.fretboard.setCurrentTime(e.detail.currentSec);
                }
                if (this.fretboardLookahead) {
                    this.fretboardLookahead.setCurrentTime(e.detail.currentSec);
                }
                if (typeof this.onSeek === 'function') {
                    this.onSeek(e.detail.currentTick, e.detail.totalTicks);
                }
            });
            this.engine.on('end', () => {
                if (this._playBtn) this._playBtn.disabled = false;
            });

            // Now that the timeline is precomputed, hand the
            // trajectories to the lookahead strip so the operator
            // sees where each hand will be over the next few seconds
            // (in addition to the falling notes).
            this._refreshHandTrajectories();
            // P.5.2 — for fretted instruments, push the trajectory
            // to the fretboard too so the band animation is driven
            // by the playhead instead of waiting for shift events
            // to land (which arrive AT the chord tick = too late).
            this._refreshFretboardTrajectory();
        }

        /** Push the engine's per-hand trajectories into the look-ahead
         *  strip. Re-called whenever overrides change so a fresh edit
         *  is reflected in the trajectory ribbons immediately. */
        _refreshHandTrajectories() {
            if (!this.lookahead || !this.engine) return;
            if (typeof this.engine.getHandTrajectories !== 'function') return;
            if (typeof this.lookahead.setHandTrajectories !== 'function') return;
            const trajectories = [];
            const handsArr = _hands(this.instrument);
            const byId = new Map(handsArr.map(h => [h.id, h]));
            const map = this.engine.getHandTrajectories();
            for (const [id, points] of map) {
                const handCfg = byId.get(id);
                if (!handCfg) continue;
                const span = handCfg.hand_span_semitones ?? handCfg.hand_span_frets ?? 14;
                trajectories.push({
                    id,
                    span,
                    color: _handColor(id),
                    points: points.slice()
                });
            }
            this.lookahead.setHandTrajectories(trajectories);
        }

        /** Push the engine's fretting-hand trajectory + tempo into
         *  BOTH the live fretboard and the lookahead strip above
         *  it. Re-called on override changes. */
        _refreshFretboardTrajectory() {
            if (this.mode !== 'frets' || !this.engine) return;
            if (typeof this.engine.getHandTrajectories !== 'function') return;
            const tps = (Number.isFinite(this.ticksPerBeat) && this.ticksPerBeat > 0
                    && Number.isFinite(this.bpm) && this.bpm > 0)
                ? this.ticksPerBeat * (this.bpm / 60) : null;
            const handsArr = _hands(this.instrument);
            const fretting = handsArr.find(h => h && h.id === 'fretting') || handsArr[0];
            const map = this.engine.getHandTrajectories();
            const points = fretting ? (map.get(fretting.id) || []) : [];

            if (this.fretboard) {
                if (tps != null && typeof this.fretboard.setTicksPerSec === 'function') {
                    this.fretboard.setTicksPerSec(tps);
                }
                if (typeof this.fretboard.setHandTrajectory === 'function') {
                    this.fretboard.setHandTrajectory(points);
                }
            }
            if (this.fretboardLookahead) {
                if (tps != null) this.fretboardLookahead.setTicksPerSec(tps);
                this.fretboardLookahead.setHandTrajectory(points);
            }
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
            }
            // Frets mode handles itself: position is derived from the
            // trajectory pushed in `_refreshFretboardTrajectory`,
            // colour is set by the chord handler via `setLevel`.
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
            this.engine?.dispose();
            this._wireEngine();
            // _wireEngine refreshes the trajectories at the end so
            // the lookahead reflects the new overrides immediately.
        }

        /**
         * Open the full-length editor modal. Forwards saveCtx
         * (fileId, deviceId, apiClient, audioPreview) so the modal can
         * persist overrides and reuse the page's synthesizer.
         */
        _openFullLengthEditor() {
            const Modal = window.HandPositionEditorModal;
            if (typeof Modal !== 'function') return;
            const ctx = this.opts.saveCtx || {};
            new Modal({
                fileId: ctx.fileId,
                channel: this.channel,
                deviceId: ctx.deviceId,
                midiData: this.opts.midiData || null,
                instrument: this.instrument,
                notes: this.notes,
                ticksPerBeat: this.ticksPerBeat,
                bpm: this.bpm,
                initialOverrides: this.overrides,
                apiClient: ctx.apiClient || null,
                // Reuse the host's AudioPreview so a single synthesizer
                // is shared across the page.
                audioPreview: ctx.audioPreview || null
            }).open();
        }

        destroy() {
            this.engine?.dispose();
            this.engine = null;
            if (this.keyboard) { this.keyboard.destroy(); this.keyboard = null; }
            if (this.lookahead) { this.lookahead.destroy(); this.lookahead = null; }
            if (this.fretboard) { this.fretboard.destroy?.(); this.fretboard = null; }
            if (this.fretboardLookahead) {
                this.fretboardLookahead.destroy?.();
                this.fretboardLookahead = null;
            }
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
