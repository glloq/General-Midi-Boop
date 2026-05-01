/**
 * @file KeyboardHandPositionEditorModal.js
 * @description Hand-position editor for keyboard-family instruments.
 *
 * Layout (top → bottom):
 *   - toolbar: play/pause/stop, mute, zoom, undo/redo, reset, save
 *   - vertical piano-roll: notes fall down toward the keyboard at the
 *     bottom; X = pitch (aligned with the keyboard), Y = time.
 *   - keyboard: small read-only piano with hand-position bands below
 *     the keys (one band per hand, h1..h4).
 *
 * Public API:
 *   new KeyboardHandPositionEditorModal({
 *     fileId, channel, deviceId, instrument,
 *     notes, ticksPerBeat, bpm, midiData,
 *     initialOverrides, apiClient, audioPreview
 *   }).open();
 */
(function() {
    'use strict';

    function _t(key, fallback) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    function _parseHandsCfg(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { return null; }
        }
        return cfg && Array.isArray(cfg.hands) ? cfg : null;
    }

    /** Per-hand colour palette — h1..h4 cycle through the same hues
     *  used by HandsPreviewPanel so the editor matches the channel
     *  preview. Legacy left/right keep their historical mapping. */
    const HAND_COLORS = {
        left: '#3b82f6', right: '#10b981', fretting: '#f59e0b',
        h1: '#3b82f6', h2: '#10b981', h3: '#f59e0b', h4: '#8b5cf6'
    };
    function _handColor(id) { return HAND_COLORS[id] || '#6b7280'; }

    /** Translucent fill of a hand colour for the roll-background lanes.
     *  Cached so the per-frame draw doesn't re-parse the hex on every
     *  segment. Alpha 0.18 is light enough that note rectangles drawn
     *  on top remain readable. */
    const _BAND_FILL_CACHE = new Map();
    function _bandFill(hex) {
        let v = _BAND_FILL_CACHE.get(hex);
        if (v) return v;
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') {
            v = 'rgba(107,114,128,0.18)';
        } else {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            v = `rgba(${r}, ${g}, ${b}, 0.18)`;
        }
        _BAND_FILL_CACHE.set(hex, v);
        return v;
    }

    class KeyboardHandPositionEditorModal extends window.BaseModal {
        constructor(opts = {}) {
            super({
                id: 'keyboard-hand-position-editor',
                size: 'full',
                // Title removed: the header is replaced by an inline
                // toolbar (see `_renderHeader`). Kept as empty string so
                // BaseModal's locale `update()` no-ops cleanly.
                title: '',
                // We render our own × button inside the toolbar; tell
                // BaseModal not to re-attach a click listener on a
                // matching `[data-action="close"]` (it would fire
                // alongside our delegated toolbar handler).
                showCloseButton: false,
                customClass: 'khpe-modal'
            });

            this.fileId = opts.fileId;
            this.channel = Number.isFinite(opts.channel) ? opts.channel : 0;
            this.deviceId = opts.deviceId;
            this.instrument = opts.instrument || null;
            this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
            this.ticksPerBeat = Number.isFinite(opts.ticksPerBeat) && opts.ticksPerBeat > 0
                ? opts.ticksPerBeat : 480;
            this.bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 120;
            this.ticksPerSec = this.ticksPerBeat * (this.bpm / 60);
            this.apiClient = opts.apiClient || null;
            this.audioPreview = opts.audioPreview || null;
            this.midiData = opts.midiData || null;

            this._totalTicks = this.notes.length
                ? Math.max(...this.notes.map(n => n.tick + (n.duration || 0))) : 0;
            this._totalSec = this._totalTicks / this.ticksPerSec;

            // Central state container. Owns hands, overrides,
            // displayed anchors, simulation timeline, problem list,
            // history. The modal stays in charge of the orchestration
            // (RAF loop, transport, view zoom) and reads the state
            // through `this.state`. Legacy field aliases below
            // (`overrides`, `_hands`, `_history`, `_displayedAnchor`,
            // `_handAnchorTimeline`, `_problems`, `_unplayableSet`)
            // are getters that delegate to the state, kept so the
            // editor's many read sites continue to work without
            // sweeping renames.
            this.state = new window.KeyboardHandPositionState({
                instrument: this.instrument,
                notes: this.notes,
                ticksPerSec: this.ticksPerSec,
                initialOverrides: opts.initialOverrides,
                onHistoryChange: () => this._refreshHistoryButtons()
            });

            // View / lookahead — the falling-note window above the
            // keyboard. The state isn't responsible for view zoom,
            // it only deals with hand positions.
            this._lookaheadSec = 4;
            this._currentSec = 0;
            this._noteHits = [];
            this._notePopover = null;
            this._mutedBeforePlay = null;

            // Trailing-edge debounce timer for `_rebuildProblems`.
            this._problemRebuildTimer = null;

            // Animation loop handle.
            this._animRaf = null;

            // Keyboard zoom: `_kbView` is the [lo, hi] pitch range
            // currently shown by the bottom keyboard + the roll axis.
            // Initialised to the full instrument range on open, then
            // narrowed by Ctrl+wheel or the mini-strip drag.
            this._kbView = null;
        }

        // ----------------------------------------------------------------
        //  Legacy field aliases — getter-only delegations to `this.state`
        //  so the modal's many read sites continue to work without
        //  changes. Writes go through state methods (`previewAnchor`,
        //  `commitAnchor`, `setNoteAssignment`, `undo` …).
        // ----------------------------------------------------------------

        get overrides()             { return this.state.overrides; }
        get _hands()                { return this.state.hands; }
        get _history()              { return this.state._history; }
        get _displayedAnchor()      { return this.state._displayedAnchors; }
        get _handAnchorTimeline()   { return this.state.simulationTimeline; }
        get _problems()             { return this.state.problems; }
        get _unplayableSet()        { return this.state.unplayableSet; }

        get isDirty() { return this.state.isDirty; }

        /** Override BaseModal's header so the modal's title bar IS
         *  the toolbar. We keep BaseModal's standard `data-action="close"`
         *  contract (the X button) so its core close handler still wires
         *  cleanly and our own toolbar dispatch (`_wireToolbar`) routes
         *  every other action via the same event delegate. */
        _renderHeader() {
            return `
                <div class="modal-header khpe-header">
                    <div class="khpe-toolbar">
                        <button type="button" data-action="play" title="${_t('keyboardHandEditor.play','Lecture')}">▶</button>
                        <button type="button" data-action="pause" disabled title="${_t('keyboardHandEditor.pause','Pause')}">⏸</button>
                        <button type="button" data-action="stop" disabled title="${_t('keyboardHandEditor.stop','Stop')}">⏹</button>
                        <button type="button" data-action="mute" title="${_t('keyboardHandEditor.mute','Couper le son')}" data-muted="0">🔊</button>
                        <span class="khpe-sep"></span>
                        <span class="khpe-group-label">${_t('keyboardHandEditor.timeZoom','Temps')}</span>
                        <button type="button" data-action="zoom-out" title="${_t('keyboardHandEditor.zoomOut','Dézoom')}">−</button>
                        <button type="button" data-action="zoom-in" title="${_t('keyboardHandEditor.zoomIn','Zoom')}">+</button>
                        <span class="khpe-sep"></span>
                        <span class="khpe-group-label">${_t('keyboardHandEditor.pitchZoom','Notes')}</span>
                        <button type="button" data-action="kb-zoom-out" title="${_t('keyboardHandEditor.kbZoomOut','Zoom arrière clavier')}">−</button>
                        <button type="button" data-action="kb-zoom-in" title="${_t('keyboardHandEditor.kbZoomIn','Zoom avant clavier')}">+</button>
                        <span class="khpe-sep"></span>
                        <button type="button" data-action="prev-problem" disabled title="${_t('keyboardHandEditor.prevProblem','Problème précédent')}">◄!</button>
                        <button type="button" data-action="next-problem" disabled title="${_t('keyboardHandEditor.nextProblem','Problème suivant')}">!►</button>
                        <span class="khpe-problem-count" data-role="problem-count"></span>
                        <span class="khpe-spacer"></span>
                        <span class="khpe-status" data-role="status"></span>
                        <button type="button" data-action="undo" disabled title="${_t('common.undo','Annuler')}">↶</button>
                        <button type="button" data-action="redo" disabled title="${_t('common.redo','Refaire')}">↷</button>
                        <button type="button" data-action="reset-overrides" title="${_t('keyboardHandEditor.reset','Tout réinitialiser')}">⟲</button>
                        <button type="button" data-action="save" disabled title="${_t('keyboardHandEditor.save','Enregistrer')}" class="khpe-save-btn">💾</button>
                        <span class="khpe-sep"></span>
                        <button type="button" class="modal-close" data-action="close" aria-label="${_t('common.close','Fermer')}">×</button>
                    </div>
                </div>
            `;
        }

        renderBody() {
            return `
                <div class="khpe-main">
                    <div class="khpe-minimap-host">
                        <canvas class="khpe-minimap-canvas"></canvas>
                    </div>
                    <div class="khpe-roll-host">
                        <canvas class="khpe-roll-canvas"></canvas>
                    </div>
                    <div class="khpe-kb-mini-host">
                        <canvas class="khpe-kb-mini-canvas"></canvas>
                    </div>
                    <div class="khpe-keyboard-host">
                        <canvas class="khpe-keyboard-canvas"></canvas>
                        <canvas class="khpe-fingers-overlay"></canvas>
                    </div>
                </div>
            `;
        }

        renderFooter() { return ''; }

        onOpen() {
            this.container?.classList.add('khpe-modal-overlay');
            this._injectStyles();
            this.rollCanvas = this.$('.khpe-roll-canvas');
            this.rollHost = this.$('.khpe-roll-host');
            this.keyboardCanvas = this.$('.khpe-keyboard-canvas');
            this.fingersCanvas = this.$('.khpe-fingers-overlay');
            this.kbMiniCanvas = this.$('.khpe-kb-mini-canvas');
            this.kbMiniHost = this.$('.khpe-kb-mini-host');
            this.minimapCanvas = this.$('.khpe-minimap-canvas');
            this.minimapHost = this.$('.khpe-minimap-host');
            this._mountKeyboard();
            this._mountFingersRenderer();
            this._wireToolbar();
            this._wireRollCanvas();
            this._wireMinimap();
            this._wireKbMini();
            this._wireResizeObserver();
            // Defer first draw so the layout has settled (clientWidth/Height
            // would otherwise read 0 inside the BaseModal mount handler).
            requestAnimationFrame(() => {
                this._rebuildProblems();
                this._pushActiveNotesToKeyboard();
                this._draw();
                this._drawMinimap();
                this._drawKbMini();
                this._pushFingersState();
            });
            this._refreshTransport();
        }

        // ----------------------------------------------------------------
        //  Feasibility simulation — pulls problems from HandPositionFeasibility
        // ----------------------------------------------------------------

        /**
         * Re-run the simulation against the current overrides + hand state
         * and rebuild the problem list. Cheap enough on typical channels;
         * we still debounce a little so a fast drag doesn't run it on
         * every mouse-move frame.
         * @private
         */
        _rebuildProblems() {
            // Trailing-edge debounce: every call resets the timer so the
            // last edit always wins. The earlier no-op-while-pending
            // pattern silently dropped intermediate edits in a fast
            // drag, leaving the problem list out of sync.
            if (this._problemRebuildTimer != null) {
                clearTimeout(this._problemRebuildTimer);
            }
            this._problemRebuildTimer = setTimeout(() => {
                this._problemRebuildTimer = null;
                this._runFeasibility();
                this._refreshProblemUI();
                this._ensureAnimLoop();
                this._draw();
                this._drawMinimap();
            }, 80);
        }

        /** Run the simulator on the current overrides + hand state and
         *  hand the raw event timeline to the state container. The
         *  state breaks it into per-hand trajectories, the unplayable
         *  set, and the problem list — the modal then refreshes the
         *  problem-counter UI from `state.problems`. */
        _runFeasibility() {
            const Feas = window.HandPositionFeasibility;
            if (!Feas || typeof Feas.simulateHandWindows !== 'function') return;
            const Shared = window.HandEditorShared;
            const overridesForSim = Shared.cloneOverrides(this.overrides) || Shared.emptyOverrides();
            let timeline;
            try {
                timeline = Feas.simulateHandWindows(this.notes, this.instrument, {
                    overrides: overridesForSim,
                    ticksPerBeat: this.ticksPerBeat,
                    bpm: this.bpm
                }) || [];
            } catch (e) {
                console.warn('[KeyboardHandPositionEditor] simulate failed:', e);
                timeline = [];
            }
            this.state.setSimulationResult(timeline);
        }

        /** Step lookup delegated to `state` — kept as a thin wrapper
         *  so the existing `_minimapSamplesFor` / `_laneSamplesFor`
         *  call sites continue to work without renames. */
        _targetAnchorAt(handId, atSec) {
            return this.state.targetAnchorAt(handId, atSec);
        }

        /** Animation step delegated to `state.step`. The modal still
         *  owns `_lookaheadSec` and `_currentSec` (view concerns) so
         *  it passes them in. */
        _stepAnchorAnimation(dtSec) {
            return this.state.step(dtSec, this._lookaheadSec, this._currentSec);
        }

        /**
         * Single RAF loop driving every animated piece — bands lerp,
         * roll redraw, minimap redraw — so they share a budget and stay
         * frame-aligned. Keeps spinning while:
         *   - bands are still moving toward their target, OR
         *   - audio is playing (roll needs to scroll between ticks).
         * Otherwise it stops; any UI event (drag, seek, rebuild,
         * progress) re-arms it via `_ensureAnimLoop()`.
         */
        _ensureAnimLoop() {
            if (this._animRaf != null) return;
            this._lastAnimTime = null;
            const tick = (now) => {
                this._animRaf = null;
                if (!this.isOpen) return;
                const dt = this._lastAnimTime != null
                    ? Math.min(0.1, (now - this._lastAnimTime) / 1000) : 0;
                this._lastAnimTime = now;

                // Interpolate the playhead between audio progress callbacks
                // so the roll scrolls smoothly even when the synth fires
                // onProgress at a low rate (~20-30 Hz). When paused/stopped
                // _audioPlayingSec is null and the playhead stays put.
                if (this._audioPlayingSec != null) {
                    this._currentSec = Math.min(this._totalSec,
                        this._audioPlayingSec + (now - this._audioPlayingWall) / 1000);
                }

                const moving = this._stepAnchorAnimation(dt);
                this.keyboard?.setHandBands(this._currentHandBands());
                this._pushActiveNotesToKeyboard();
                this._draw();
                this._drawMinimap();
                this._drawKbMini();
                this._pushFingersState();

                const playing = this._audioPlayingSec != null;
                if (moving || playing) this._animRaf = requestAnimationFrame(tick);
            };
            this._animRaf = requestAnimationFrame(tick);
        }

        _refreshProblemUI() {
            const total = this._problems?.length || 0;
            const prevBtn = this.$('[data-action="prev-problem"]');
            const nextBtn = this.$('[data-action="next-problem"]');
            const counter = this.$('[data-role="problem-count"]');
            if (prevBtn) prevBtn.disabled = total === 0;
            if (nextBtn) nextBtn.disabled = total === 0;
            if (counter) counter.textContent = total > 0 ? `${total}` : '';
        }

        _jumpToProblem(direction) {
            const list = this._problems || [];
            if (list.length === 0) return;
            const EPS = 0.05;
            let idx;
            if (direction > 0) {
                idx = list.findIndex(p => p.sec > this._currentSec + EPS);
                if (idx < 0) idx = 0; // wrap
            } else {
                idx = -1;
                for (let i = list.length - 1; i >= 0; i--) {
                    if (list[i].sec < this._currentSec - EPS) { idx = i; break; }
                }
                if (idx < 0) idx = list.length - 1; // wrap
            }
            this._currentSec = list[idx].sec;
            this._ensureAnimLoop();
            this._draw();
            this._drawMinimap();
        }

        _injectStyles() {
            if (document.getElementById('khpe-modal-styles')) return;
            const style = document.createElement('style');
            style.id = 'khpe-modal-styles';
            style.textContent = `
                .modal-overlay.khpe-modal-overlay {
                    /* Routing summary modal sits at 10005; stay above so
                       the editor isn't covered when opened from there. */
                    z-index: 10010 !important;
                }
                .khpe-modal .modal-dialog {
                    /* Almost full-page width but leaves a sliver of the
                       overlay visible on the sides so the operator
                       still feels they are "inside" a dialog rather
                       than on a brand-new page. */
                    width: 98vw !important;
                    height: 96vh !important;
                    max-width: 98vw !important;
                    max-height: 96vh !important;
                    margin: 2vh auto !important;
                    border-radius: 6px !important;
                    display: flex; flex-direction: column;
                    background: #fff;
                    overflow: hidden;
                }
                .khpe-modal .modal-body {
                    flex: 1; display: flex; flex-direction: column;
                    overflow: hidden; padding: 0; min-height: 0;
                }
                .khpe-modal .modal-footer { display: none; }
                /* Header IS the toolbar — no h2/title here. */
                .khpe-modal .khpe-header {
                    padding: 0; background: #f9fafb;
                    border-bottom: 1px solid #e5e7eb;
                }
                .khpe-toolbar {
                    display: flex; gap: 6px; align-items: center;
                    padding: 8px 10px; flex-wrap: wrap;
                }
                .khpe-toolbar button[data-action] {
                    padding: 4px 10px; border: 1px solid #d1d5db;
                    background: #fff; border-radius: 4px; cursor: pointer;
                    font-size: 14px; line-height: 1;
                }
                .khpe-toolbar button[data-action]:hover:not([disabled]) { background: #f3f4f6; }
                .khpe-toolbar button[data-action][disabled] { opacity: 0.45; cursor: not-allowed; }
                .khpe-toolbar button[data-action="save"] { font-size: 16px; padding: 4px 10px; }
                .khpe-toolbar button.modal-close {
                    margin-left: 4px; font-size: 18px; line-height: 1;
                    padding: 2px 10px; background: transparent; border: none;
                    cursor: pointer; color: #6b7280;
                }
                .khpe-toolbar button.modal-close:hover { color: #111827; }
                .khpe-toolbar .khpe-sep {
                    display: inline-block; width: 1px; height: 18px; background: #d1d5db;
                }
                .khpe-toolbar .khpe-spacer { flex: 1; }
                .khpe-toolbar .khpe-status { color: #6b7280; font-size: 12px; }
                .khpe-toolbar .khpe-group-label {
                    font-size: 11px; color: #6b7280; text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .khpe-toolbar .khpe-problem-count {
                    font-size: 12px; color: #b91c1c; font-weight: 600; min-width: 20px;
                }
                .khpe-main {
                    display: flex; flex-direction: column; flex: 1; min-height: 0;
                }
                .khpe-minimap-host {
                    position: relative; height: 54px; flex: none;
                    background: #1e293b; border-bottom: 1px solid #334155;
                }
                .khpe-minimap-canvas {
                    position: absolute; inset: 0; display: block; cursor: pointer;
                }
                .khpe-roll-host {
                    position: relative; flex: 1; background: #0f172a;
                    overflow: hidden; min-height: 200px;
                }
                .khpe-roll-host.is-panning { cursor: grabbing; }
                .khpe-roll-canvas { position: absolute; inset: 0; display: block; }
                .khpe-kb-mini-host {
                    background: #0f172a; height: 18px; flex: none;
                    border-top: 1px solid #334155; cursor: pointer; position: relative;
                }
                .khpe-kb-mini-canvas { display: block; width: 100%; height: 100%; }
                /* Keyboard preview area — purely informational, no
                   interaction (every edit happens on the roll above).
                   Tall enough to show keys, fingers and active-key
                   tinting clearly. */
                .khpe-keyboard-host {
                    position: relative; background: #1e293b; padding: 4px;
                    height: 120px; flex: none;
                    pointer-events: none;
                }
                .khpe-keyboard-canvas { display: block; width: 100%; height: 100%; }
                .khpe-fingers-overlay {
                    position: absolute; inset: 4px; pointer-events: none;
                }
            `;
            document.head.appendChild(style);
        }

        /** BaseModal's default `update()` re-renders body + footer
         *  HTML on every locale change, which would tear down our
         *  canvases and dangling-reference every cached widget. We
         *  override it to a no-op: this editor's strings are short
         *  static labels (toolbar tooltips) and the cost of rebuilding
         *  the entire piano-roll for them is not worth it. If real
         *  locale-aware label refresh becomes needed, rebuild only
         *  the toolbar in place rather than the whole body. */
        update() {}

        onClose() {
            if (this._problemRebuildTimer != null) {
                clearTimeout(this._problemRebuildTimer);
                this._problemRebuildTimer = null;
            }
            if (this._animRaf != null) {
                cancelAnimationFrame(this._animRaf);
                this._animRaf = null;
            }
            if (this._resizeRaf != null) {
                cancelAnimationFrame(this._resizeRaf);
                this._resizeRaf = null;
            }
            if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
            if (this.audioPreview?.isPlaying || this.audioPreview?.isPreviewing) {
                this.audioPreview.stop();
            }
            this._restoreMute();
            this._closeNotePopover();
            this.keyboard?.destroy?.();
            this.keyboard = null;
            this.fingersRenderer?.destroy?.();
            this.fingersRenderer = null;
        }

        close() {
            if (this._closing) return;
            if (!this.isOpen || this._closeConfirmed) {
                this._closeConfirmed = false;
                super.close();
                return;
            }
            if (!this.isDirty) {
                super.close();
                return;
            }
            this._closing = true;
            this._showDiscardConfirm().then((ok) => {
                this._closing = false;
                if (!ok) return;
                this._closeConfirmed = true;
                super.close();
            });
        }

        _showDiscardConfirm() {
            return window.HandEditorShared.showUnsavedChangesConfirm({
                titleKey: 'keyboardHandEditor.confirmDiscardTitle',
                titleFallback: 'Modifications non enregistrées',
                messageKey: 'keyboardHandEditor.confirmDiscard',
                messageFallback: 'Voulez-vous quitter sans sauvegarder ?',
                confirmKey: 'keyboardHandEditor.discardConfirmBtn',
                confirmFallback: 'Quitter sans sauvegarder',
                extraClass: 'khpe-discard-confirm'
            });
        }

        // ----------------------------------------------------------------
        //  Keyboard widget at the bottom (with draggable hand bands)
        // ----------------------------------------------------------------

        _mountKeyboard() {
            if (!this.keyboardCanvas) return;
            // The hand list (id, span, numFingers, color, initial
            // anchor) was built once by `KeyboardHandPositionState`
            // at construction. `_mountKeyboard` just picks the right
            // canvas widget for the layout and drives its band
            // setter — it never owns the hand definitions.
            const ext = this.state.range;
            // Pick the renderer based on the instrument's declared
            // layout. Piano-style instruments use the existing
            // KeyboardPreview (black + white keys); chromatic
            // instruments get a flat 'line of notes' rendering where
            // every semitone is the same width (xylophone, hangdrum,
            // marimba…). Each branch shares the band drag callback.
            this._destroyKeyboardWidget();
            const layout = this._keyboardLayoutType();
            if (layout === 'chromatic') {
                this.keyboard = this._buildChromaticKeyboard(ext);
            } else if (window.KeyboardPreview) {
                // Read-only widget: no `onBandDrag`, no `onKeyClick`.
                // Every position edit happens on the piano-roll above
                // (see `_wireRollCanvas`). The keyboard exists purely
                // to show where the hand currently sits and which keys
                // are pressed at the playhead.
                this.keyboard = new window.KeyboardPreview(this.keyboardCanvas, {
                    rangeMin: ext.lo,
                    rangeMax: ext.hi,
                    bandHeight: 22,
                    bandsOnSingleRow: true
                });
            }
            this.keyboard?.setHandBands(this._currentHandBands());
            requestAnimationFrame(() => {
                this._fitKeyboardCanvas();
                this.keyboard?.setHandBands(this._currentHandBands());
                this.keyboard?.draw();
            });
            // Wheel/drag interactions on the keyboard are intentionally
            // disabled — `.khpe-keyboard-host { pointer-events: none }`
            // already blocks them at the CSS layer; toolbar +/-, the
            // mini-strip and the roll handle every navigation gesture.
        }

        _destroyKeyboardWidget() {
            if (this.keyboard?.destroy) this.keyboard.destroy();
            this.keyboard = null;
        }

        /**
         * Build a minimal chromatic-line widget that mimics enough of
         * the KeyboardPreview public API (`setRange`, `setHandBands`,
         * `draw`, `destroy`) for the editor to drive it the same way.
         * Visual: every semitone is rendered as an identical rectangle
         * with a 1 px gap, tinted by hand-band overlay underneath. No
         * black/white distinction since chromatic instruments don't
         * have one (xylophone, hangdrum…).
         */
        _buildChromaticKeyboard(ext) {
            const canvas = this.keyboardCanvas;
            let rangeMin = ext.lo;
            let rangeMax = ext.hi;
            let bands = [];
            // midi → handId | null. Populated by setActiveNotes so
            // the chromatic widget can tint keys currently sounding
            // at the playhead, the same way KeyboardPreview does for
            // piano-style instruments.
            const activeNotes = new Map();

            const draw = () => {
                const dpr = window.devicePixelRatio || 1;
                const W = canvas.clientWidth;
                const H = canvas.clientHeight;
                if (W <= 0 || H <= 0) return;
                const wantW = W * dpr;
                const wantH = H * dpr;
                if (canvas.width !== wantW || canvas.height !== wantH) {
                    canvas.width = wantW;
                    canvas.height = wantH;
                }
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(0, 0, W, H);
                const bandH = 22;
                const keysH = H - bandH;
                const range = Math.max(1, rangeMax - rangeMin + 1);
                const pxPerNote = W / range;
                // Build a quick id → colour map so active keys can be
                // tinted with their assigned hand's colour (matches
                // KeyboardPreview's behaviour).
                const bandColorById = new Map();
                for (const b of bands) bandColorById.set(b.id, b.color);
                // Notes as identical cells. C of every octave gets a
                // brighter tint so the operator finds the octave
                // boundaries quickly. Active notes override the base
                // tint with the assigned hand's colour (or a generic
                // blue when no hand covers them).
                for (let m = rangeMin; m <= rangeMax; m++) {
                    const x = (m - rangeMin) * pxPerNote;
                    let fill;
                    if (activeNotes.has(m)) {
                        const hid = activeNotes.get(m);
                        fill = (hid && bandColorById.get(hid)) || '#3b82f6';
                    } else {
                        fill = (m % 12 === 0) ? '#f8fafc' : '#cbd5e1';
                    }
                    ctx.fillStyle = fill;
                    ctx.fillRect(x + 0.5, 0, Math.max(1, pxPerNote - 1), keysH);
                    if (m % 12 === 0 && pxPerNote > 18) {
                        ctx.fillStyle = activeNotes.has(m) ? '#f8fafc' : '#0f172a';
                        ctx.font = '10px sans-serif';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(`C${(m / 12) - 1}`, x + 3, keysH - 2);
                    }
                }
                // Hand bands flush against the bottom of the strip,
                // single row to match KeyboardPreview's bandsOnSingleRow.
                for (const b of bands) {
                    if (!Number.isFinite(b.low) || !Number.isFinite(b.high)) continue;
                    const lo = Math.max(rangeMin, b.low);
                    const hi = Math.min(rangeMax, b.high);
                    if (hi < lo) continue;
                    const x1 = (lo - rangeMin) * pxPerNote;
                    const x2 = (hi - rangeMin + 1) * pxPerNote;
                    ctx.fillStyle = _bandFill(b.color);
                    ctx.fillRect(x1, keysH, x2 - x1, bandH);
                    ctx.strokeStyle = b.color;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x1 + 0.5, keysH + 0.5, x2 - x1 - 1, bandH - 1);
                }
            };

            // The chromatic widget is purely informational — every
            // edit happens on the piano-roll above. Drag handlers are
            // therefore omitted; the canvas reacts only to the public
            // setters below.

            // Public x-mapping helpers — same shape as KeyboardPreview's
            // public counterparts so the fingers overlay can query
            // either widget without branching on instrument type. The
            // chromatic widget uses uniform key widths, so xOf is just
            // the proportional offset.
            const pxPerNote = () => {
                const W = canvas.clientWidth || 0;
                const range = Math.max(1, rangeMax - rangeMin + 1);
                return W / range;
            };
            return {
                setRange(min, max) { rangeMin = min; rangeMax = max; draw(); },
                setHandBands(b) { bands = Array.isArray(b) ? b : []; draw(); },
                /** Accept either `[midi, midi, …]` or `[{midi, handId}, …]`,
                 *  same shape as KeyboardPreview.setActiveNotes. */
                setActiveNotes(notes) {
                    activeNotes.clear();
                    if (Array.isArray(notes)) {
                        for (const e of notes) {
                            if (Number.isFinite(e)) activeNotes.set(e, null);
                            else if (e && Number.isFinite(e.midi)) {
                                activeNotes.set(e.midi, e.handId || null);
                            }
                        }
                    }
                    draw();
                },
                draw,
                /** Pixel x of the LEFT edge of `midi`'s key. Accepts
                 *  fractional MIDI values for smooth animation. */
                keyXAt(midi) {
                    if (!Number.isFinite(midi)) return 0;
                    return (midi - rangeMin) * pxPerNote();
                },
                /** Pixel width of the key at `midi` (uniform here). */
                keyWidth(/*midi*/) { return pxPerNote(); },
                destroy() { bands = []; activeNotes.clear(); }
            };
        }

        /** Resize the keyboard canvas backing store to match its CSS
         *  size (the parent has flex height). KeyboardPreview's geo
         *  cache keys off width/height so we wipe it on resize. */
        _fitKeyboardCanvas() {
            const c = this.keyboardCanvas;
            if (!c) return;
            const dpr = window.devicePixelRatio || 1;
            const w = c.clientWidth;
            const h = c.clientHeight;
            if (w <= 0 || h <= 0) return;
            c.width = w * dpr;
            c.height = h * dpr;
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // KeyboardPreview rebuilds its geo cache lazily — invalidate.
            if (this.keyboard) this.keyboard._geoCache = null;
        }

        /** Push the set of currently sounding semitones (= notes
         *  whose tick window contains the playhead) to the keyboard
         *  widget so its active-key tinting matches what the
         *  piano-roll's playhead is showing. KeyboardPreview honours
         *  per-key hand colouring when the entry carries `handId`. */
        _pushActiveNotesToKeyboard() {
            if (!this.keyboard || typeof this.keyboard.setActiveNotes !== 'function') return;
            const active = this._activeNotesAtPlayhead();
            if (active.size === 0) { this.keyboard.setActiveNotes([]); return; }
            // Tag each active midi with the hand whose [low, high]
            // window currently covers it so the keyboard widget can
            // tint the key in that hand's colour. Falls back to no
            // tag (=> generic active fill) when no hand covers the
            // note.
            const bands = this._currentHandBands();
            const out = [];
            for (const midi of active) {
                let handId = null;
                for (const b of bands) {
                    if (midi >= b.low && midi <= b.high) { handId = b.id; break; }
                }
                out.push({ midi, handId });
            }
            this.keyboard.setActiveNotes(out);
        }

        /** Bands rendered on the keyboard. Anchors are quantized to the
         *  nearest semitone before being handed to KeyboardPreview —
         *  its `_xOf(midi)` indexes a sparse integer array, so a
         *  fractional anchor (mid-lerp) used to land on `undefined`
         *  and the band would silently jump or disappear. The roll
         *  itself keeps the floating-point value for sub-semitone
         *  precision in the lane background. */
        _currentHandBands() {
            return this.state.currentBands();
        }

        // Hand-band repositioning lives on the piano-roll now: the
        // mousedown handler in `_wireRollCanvas` routes a drag inside
        // a band's reachable window to `_onHandBandDragLive` (live
        // visual update, no history) and `_commitHandBandDrag`
        // (persist + history) on mouseup.

        // ----------------------------------------------------------------
        //  Roll canvas — vertical piano-roll, notes fall toward the keyboard
        // ----------------------------------------------------------------

        /**
         * Pitch range covered by the on-screen keyboard and roll axis.
         * The instrument's `note_range_min`/`max` capabilities take
         * precedence so the operator sees ALL keys the device can
         * actually play, not just the notes present in the channel.
         * Falls back to the channel's note extrema (with 2-semitone
         * padding) when the instrument doesn't advertise a range.
         */
        _pitchExtent() {
            const lo = Number.isFinite(this.instrument?.note_range_min)
                ? this.instrument.note_range_min : null;
            const hi = Number.isFinite(this.instrument?.note_range_max)
                ? this.instrument.note_range_max : null;
            if (lo != null && hi != null && hi > lo) {
                return { lo: Math.max(0, lo), hi: Math.min(127, hi) };
            }
            if (this.notes.length === 0) return { lo: 21, hi: 108 };
            let mn = 127, mx = 0;
            for (const n of this.notes) {
                if (n.note < mn) mn = n.note;
                if (n.note > mx) mx = n.note;
            }
            return { lo: Math.max(0, mn - 2), hi: Math.min(127, mx + 2) };
        }

        /**
         * Visible pitch extent — the slice currently shown by the
         * keyboard + the piano-roll. Defaults to the full instrument
         * range (`_pitchExtent`) and narrows as the operator zooms in.
         * Always clamped within the full range to prevent the view
         * scrolling off the keyboard.
         */
        _visibleExtent() {
            const full = this._pitchExtent();
            if (!this._kbView) return full;
            const lo = Math.max(full.lo, Math.min(full.hi - 1, this._kbView.lo));
            const hi = Math.max(lo + 1, Math.min(full.hi, this._kbView.hi));
            return { lo, hi };
        }

        /** Apply a zoom factor centred on a pitch. `factor > 1` zooms in
         *  (smaller visible range), `factor < 1` zooms out. The new
         *  range is clamped to a minimum of 12 semitones so the keys
         *  stay legible, and to the full instrument range as the
         *  outer limit. */
        _zoomKeyboard(factor, centerPitch) {
            const full = this._pitchExtent();
            const cur = this._kbView || full;
            const span = cur.hi - cur.lo;
            const newSpan = Math.max(12, Math.min(full.hi - full.lo, span / factor));
            if (newSpan === span) return;
            const c = Number.isFinite(centerPitch) ? centerPitch : (cur.lo + span / 2);
            const t = (c - cur.lo) / span;
            let lo = Math.round(c - t * newSpan);
            let hi = Math.round(lo + newSpan);
            if (lo < full.lo) { hi += full.lo - lo; lo = full.lo; }
            if (hi > full.hi) { lo -= hi - full.hi; hi = full.hi; }
            lo = Math.max(full.lo, lo);
            hi = Math.min(full.hi, hi);
            this._kbView = { lo, hi };
            this.keyboard?.setRange(lo, hi);
            this.keyboard?.draw();
            this._draw();
            this._drawKbMini();
            this._pushFingersState();
        }

        /** Pan the keyboard view so its centre lands on `centerPitch`,
         *  preserving the current zoom level. Used by the mini-strip
         *  click handler. */
        _panKeyboard(centerPitch) {
            const full = this._pitchExtent();
            const cur = this._kbView || full;
            const span = cur.hi - cur.lo;
            let lo = Math.round(centerPitch - span / 2);
            let hi = lo + span;
            if (lo < full.lo) { hi += full.lo - lo; lo = full.lo; }
            if (hi > full.hi) { lo -= hi - full.hi; hi = full.hi; }
            this._kbView = { lo, hi };
            this.keyboard?.setRange(lo, hi);
            this.keyboard?.draw();
            this._draw();
            this._drawKbMini();
            this._pushFingersState();
        }

        _wireResizeObserver() {
            if (!this.rollHost || typeof ResizeObserver !== 'function') return;
            // Coalesce resize bursts into one RAF — a window-edge drag
            // fires `resize` per pixel; without batching we'd run 3 full
            // canvas redraws + a keyboard redraw per pixel.
            this._resizeObserver = new ResizeObserver(() => {
                if (this._resizeRaf != null) return;
                this._resizeRaf = requestAnimationFrame(() => {
                    this._resizeRaf = null;
                    if (!this.isOpen) return;
                    this._draw();
                    this._drawMinimap();
                    this._drawKbMini();
                    this._fitKeyboardCanvas();
                    this.keyboard?.draw();
                    this._pushFingersState();
                });
            });
            this._resizeObserver.observe(this.rollHost);
            const kbHost = this.$('.khpe-keyboard-host');
            if (kbHost) this._resizeObserver.observe(kbHost);
            if (this.minimapHost) this._resizeObserver.observe(this.minimapHost);
            if (this.kbMiniHost) this._resizeObserver.observe(this.kbMiniHost);
        }

        // ----------------------------------------------------------------
        //  Fingers overlay — delegated to KeyboardFingersRenderer.
        //  The modal owns no rendering logic for the bunch; it only
        //  pushes the renderer-relevant state through `_pushFingersState`
        //  on every change (RAF tick, drag, undo/redo, zoom, resize…).
        // ----------------------------------------------------------------

        /** Whether this instrument's hands_config explicitly sets the
         *  piano layout. Used both by `_mountKeyboard` (to pick
         *  KeyboardPreview vs the chromatic in-line widget) and by
         *  `_pushFingersState` (to pick the renderer's W/B-alternating
         *  vs uniform layout). Defaults to chromatic when absent so
         *  legacy rows keep their semantics. */
        _keyboardLayoutType() {
            const cfg = _parseHandsCfg(this.instrument);
            return cfg?.keyboard_type === 'piano' ? 'piano' : 'chromatic';
        }

        /** Set of MIDI notes currently sounding at `_currentSec` —
         *  delegated to `state.activeNotesAt`. Fed to the keyboard
         *  widget (key tinting) and to the fingers renderer
         *  (finger highlight). */
        _activeNotesAtPlayhead() {
            return this.state.activeNotesAt(this._currentSec);
        }

        /** Mount the fingers-overlay widget once on `onOpen`. Subsequent
         *  changes (keyboard widget swap, layout type change) are
         *  pushed through the widget's setters in `_pushFingersState`.
         *  No-op when `KeyboardFingersRenderer` isn't loaded so a
         *  partial deploy fails gracefully (the editor stays usable;
         *  only the overlay disappears).
         *  @private */
        _mountFingersRenderer() {
            if (!this.fingersCanvas) return;
            if (typeof window === 'undefined' || !window.KeyboardFingersRenderer) return;
            this.fingersRenderer = new window.KeyboardFingersRenderer(this.fingersCanvas, {
                bandHeight: 22
            });
        }

        /** Snapshot of the per-hand displayed anchor in a fresh Map,
         *  ready to hand to the fingers widget. Falls back to each
         *  hand's static anchor when the animation loop hasn't
         *  produced a value yet (early frames or hands the simulator
         *  never visited).
         *  @private */
        _displayedAnchorMapForRender() {
            const out = new Map();
            for (const hand of (this._hands || [])) {
                const a = this._displayedAnchor.has(hand.id)
                    ? this._displayedAnchor.get(hand.id) : hand.anchor;
                if (Number.isFinite(a)) out.set(hand.id, a);
            }
            return out;
        }

        /** Push every renderer input the fingers widget needs, then
         *  redraw. The widget reads ONLY what we hand it; we never
         *  expose `this._hands` or `this._displayedAnchor` directly,
         *  which keeps the renderer free of any modal coupling and
         *  trivially testable in isolation. */
        _pushFingersState() {
            const r = this.fingersRenderer;
            if (!r) return;
            r.setKeyboardWidget(this.keyboard || null);
            r.setLayout(this._keyboardLayoutType());
            r.setHands(this._hands || []);
            r.setAnchors(this._displayedAnchorMapForRender());
            r.setActiveNotes(this._activeNotesAtPlayhead());
            r.setVisibleExtent(this._visibleExtent());
            r.draw();
        }


        // ----------------------------------------------------------------
        //  Keyboard mini-strip — full instrument range with viewport rect
        // ----------------------------------------------------------------

        _wireKbMini() {
            if (!this.kbMiniCanvas) return;
            // Click + drag to pan: map x → pitch and centre the keyboard
            // view on it. We also accept a plain click for one-shot pan.
            const handle = (e) => {
                const rect = this.kbMiniCanvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                const full = this._pitchExtent();
                const pitch = full.lo + (x / rect.width) * (full.hi - full.lo);
                this._panKeyboard(pitch);
            };
            this.kbMiniCanvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                handle(e);
                // The move handler is bound on mousedown and removed
                // on mouseup, so it only fires while the button is
                // held — no need for an additional `_dragging` flag.
                const onMove = (ev) => handle(ev);
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        /** Paint the full keyboard range as a flat strip with a viewport
         *  rectangle marking `_kbView`. Octave separators help the
         *  operator find C-positions without rendering full keys. */
        _drawKbMini() {
            const c = this.kbMiniCanvas;
            const host = this.kbMiniHost;
            if (!c || !host) return;
            const dpr = window.devicePixelRatio || 1;
            const W = host.clientWidth;
            const H = host.clientHeight;
            if (W <= 0 || H <= 0) return;
            const wantW = W * dpr;
            const wantH = H * dpr;
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
                c.style.width = W + 'px';
                c.style.height = H + 'px';
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, W, H);

            const full = this._pitchExtent();
            const range = Math.max(1, full.hi - full.lo);
            const pxPerPitch = W / range;

            // Octave grid + C labels
            ctx.fillStyle = '#64748b';
            ctx.font = '9px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.strokeStyle = 'rgba(148,163,184,0.25)';
            for (let p = full.lo; p <= full.hi; p++) {
                if (p % 12 === 0) {
                    const x = (p - full.lo) * pxPerPitch + 0.5;
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, H);
                    ctx.stroke();
                    if (W > 200) ctx.fillText(`C${(p / 12) - 1}`, x + 2, H / 2);
                }
            }

            // Viewport rect (= live `_kbView`)
            const view = this._visibleExtent();
            const xLo = (view.lo - full.lo) * pxPerPitch;
            const xHi = (view.hi - full.lo) * pxPerPitch;
            ctx.fillStyle = 'rgba(248,250,252,0.12)';
            ctx.fillRect(xLo, 0, xHi - xLo, H);
            ctx.strokeStyle = 'rgba(248,250,252,0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(xLo + 0.5, 0.5, xHi - xLo - 1, H - 1);

            // Hand bands marker — translucent stripes so the operator
            // sees where the hands sit on the full keyboard at a glance.
            for (const hand of (this._hands || [])) {
                const a = this._displayedAnchor.has(hand.id)
                    ? this._displayedAnchor.get(hand.id) : hand.anchor;
                const x = (a - full.lo) * pxPerPitch;
                const w = hand.span * pxPerPitch;
                ctx.fillStyle = _bandFill(hand.color);
                ctx.fillRect(x, 0, w, H);
            }
        }

        /** Mousedown + drag on the minimap scrubs the timeline. The
         *  initial mousedown moves the playhead immediately (so a
         *  plain click still seeks), and any subsequent mousemove
         *  while the button is held keeps the playhead under the
         *  cursor. The piano-roll redraws on every step so the
         *  operator sees the whole frame slide in real time. */
        _wireMinimap() {
            if (!this.minimapCanvas) return;
            const seekFromEvent = (e) => {
                if (!this._totalSec) return;
                const rect = this.minimapCanvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                const sec = (x / rect.width) * this._totalSec;
                const next = Math.max(0, Math.min(this._totalSec, sec));
                if (next === this._currentSec) return;
                this._currentSec = next;
                this._ensureAnimLoop();
                this._draw();
                this._drawMinimap();
            };
            this.minimapCanvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                seekFromEvent(e);
                const onMove = (ev) => seekFromEvent(ev);
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        _drawMinimap() {
            const c = this.minimapCanvas;
            const host = this.minimapHost;
            if (!c || !host) return;
            const dpr = window.devicePixelRatio || 1;
            const W = host.clientWidth;
            const H = host.clientHeight;
            if (W <= 0 || H <= 0) return;
            const wantW = W * dpr;
            const wantH = H * dpr;
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
                c.style.width = W + 'px';
                c.style.height = H + 'px';
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, W, H);
            if (!this._totalSec) return;

            const ext = this._pitchExtent();
            const pitchRange = Math.max(1, ext.hi - ext.lo);
            const xPerSec = W / this._totalSec;

            // Note dots — one tiny rectangle per note, faint so the
            // hand-anchor bands stay readable on top.
            ctx.fillStyle = 'rgba(148,163,184,0.55)';
            for (const n of this.notes) {
                const sec = n.tick / this.ticksPerSec;
                const x = sec * xPerSec;
                const y = H - ((n.note - ext.lo) / pitchRange) * H;
                ctx.fillRect(x, y - 0.5, Math.max(1, xPerSec * (n.duration || 0) / this.ticksPerSec), 1.5);
            }

            // Hand-position bands — one translucent stripe per hand
            // showing where the hand sits at every moment of the
            // ENTIRE file. Stable spans render as filled rectangles
            // (anchor → anchor + span); moving spans (= simulator
            // shift events) render as parallelograms whose slope
            // matches the configured max hand-move speed. Source data
            // comes from `_handAnchorTimeline` — the same simulation
            // the piano-roll lanes use, so the minimap and the roll
            // agree by construction.
            const yOfPitch = (p) => H - ((p - ext.lo) / pitchRange) * H;
            for (const hand of (this._hands || [])) {
                const samples = this._minimapSamplesFor(hand);
                if (samples.length < 2) continue;
                const fill = _bandFill(hand.color);
                const infeasibleFill = 'rgba(220, 38, 38, 0.35)';
                for (let i = 0; i < samples.length - 1; i++) {
                    const cur = samples[i];
                    const next = samples[i + 1];
                    // Stable rectangle from cur.sec to the start of
                    // the next slide (or to next.sec when next isn't
                    // a shift). Width is the hand's span in pitch
                    // units → covers the whole reachable window.
                    const stableEndSec = Number.isFinite(next.fromSec) ? next.fromSec : next.sec;
                    if (stableEndSec > cur.sec) {
                        const x0 = cur.sec * xPerSec;
                        const x1 = stableEndSec * xPerSec;
                        const yTop = yOfPitch(cur.anchor + hand.span);
                        const yBot = yOfPitch(cur.anchor);
                        ctx.fillStyle = fill;
                        ctx.fillRect(x0, yTop, Math.max(1, x1 - x0), yBot - yTop);
                    }
                    // Slide parallelogram — only when next is a
                    // shift carrying explicit fromSec / fromAnchor.
                    if (Number.isFinite(next.fromSec) && Number.isFinite(next.fromAnchor)
                            && next.fromSec < next.sec) {
                        const xA = next.fromSec * xPerSec;
                        const xB = next.sec * xPerSec;
                        const yA1 = yOfPitch(next.fromAnchor + hand.span);
                        const yA2 = yOfPitch(next.fromAnchor);
                        const yB1 = yOfPitch(next.anchor + hand.span);
                        const yB2 = yOfPitch(next.anchor);
                        ctx.fillStyle = next.feasible === false ? infeasibleFill : fill;
                        ctx.beginPath();
                        ctx.moveTo(xA, yA1);
                        ctx.lineTo(xB, yB1);
                        ctx.lineTo(xB, yB2);
                        ctx.lineTo(xA, yA2);
                        ctx.closePath();
                        ctx.fill();
                        // Outline the slide leg so it stands out from
                        // surrounding stable spans. Dashed red when
                        // infeasible.
                        ctx.save();
                        if (next.feasible === false) {
                            ctx.strokeStyle = '#dc2626';
                            ctx.setLineDash([3, 2]);
                            ctx.lineWidth = 1;
                        } else {
                            ctx.strokeStyle = hand.color;
                            ctx.lineWidth = 0.75;
                        }
                        ctx.beginPath();
                        ctx.moveTo(xA, yA1);
                        ctx.lineTo(xB, yB1);
                        ctx.lineTo(xB, yB2);
                        ctx.lineTo(xA, yA2);
                        ctx.closePath();
                        ctx.stroke();
                        ctx.restore();
                    }
                }
                // Centerline through the band's anchor — the visual
                // continuity of the trajectory at a glance.
                ctx.strokeStyle = hand.color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = 0; i < samples.length; i++) {
                    const s = samples[i];
                    if (Number.isFinite(s.fromSec) && Number.isFinite(s.fromAnchor)) {
                        const xF = s.fromSec * xPerSec;
                        const yF = yOfPitch(s.fromAnchor + hand.span / 2);
                        ctx.lineTo(xF, yF);
                    }
                    const x = s.sec * xPerSec;
                    const y = yOfPitch(s.anchor + hand.span / 2);
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            // Problem markers — red triangle for unplayable chords,
            // amber for too-fast shifts. Drawn before the viewport rect
            // so the rect translucent fill desaturates them slightly
            // when they fall inside the current view (still readable).
            for (const p of (this._problems || [])) {
                const x = p.sec * xPerSec;
                ctx.fillStyle = p.kind === 'speed' ? '#f59e0b' : '#dc2626';
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x - 3, 6);
                ctx.lineTo(x + 3, 6);
                ctx.closePath();
                ctx.fill();
            }

            // Lookahead viewport rectangle (= the slice currently shown
            // in the piano-roll above).
            const vpX = this._currentSec * xPerSec;
            const vpW = Math.max(2, this._lookaheadSec * xPerSec);
            ctx.fillStyle = 'rgba(248,250,252,0.08)';
            ctx.fillRect(vpX, 0, vpW, H);
            ctx.strokeStyle = 'rgba(248,250,252,0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(vpX + 0.5, 0.5, vpW - 1, H - 1);

            // Playhead.
            ctx.strokeStyle = 'rgba(248,113,113,0.95)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(vpX + 0.5, 0);
            ctx.lineTo(vpX + 0.5, H);
            ctx.stroke();
        }

        /**
         * Build the per-hand sample list used by the minimap to
         * render hand-position bands across the WHOLE file. Pulls
         * straight from the simulator's `_handAnchorTimeline` (which
         * already includes every shift's fromSec/fromAnchor and
         * feasibility flag) so the minimap and the piano-roll lanes
         * agree by construction. Falls back to override-derived
         * samples when the simulation hasn't run yet (e.g. before
         * the first `_rebuildProblems()`).
         * @private
         */
        _minimapSamplesFor(hand) {
            const series = this._handAnchorTimeline?.get(hand.id);
            const total = this._totalSec || 0;
            if (Array.isArray(series) && series.length > 0) {
                const out = [];
                // Seed the first sample at sec=0 with the earliest
                // anchor — either the slide's fromAnchor (so the
                // pre-slide rectangle matches the initial anchor) or
                // the first chord's anchor when the timeline starts
                // with a chord event.
                const first = series[0];
                const seedAnchor = Number.isFinite(first.fromAnchor)
                    ? first.fromAnchor : first.anchor;
                out.push({ sec: 0, anchor: seedAnchor });
                for (const s of series) out.push(s);
                if (out[out.length - 1].sec < total) {
                    out.push({ sec: total, anchor: out[out.length - 1].anchor });
                }
                return out;
            }
            // No simulation data — fall back to user-pinned overrides
            // around the seed anchor. Same shape as the simulator
            // output so the minimap renderer doesn't need a branch.
            return this._anchorSamplesForHand(hand);
        }

        /**
         * Build a sorted list of `{sec, anchor}` samples for one hand by
         * walking the `hand_anchors` override entries (latest-wins per
         * tick). The current in-memory anchor seeds the start and end so
         * the trajectory has at least two points and renders as a flat
         * line when no override exists yet.
         * @private
         */
        _anchorSamplesForHand(hand) {
            const list = (this.overrides?.hand_anchors || [])
                .filter(a => a && a.handId === hand.id && Number.isFinite(a.tick) && Number.isFinite(a.anchor))
                .sort((a, b) => a.tick - b.tick);
            const out = [{ sec: 0, anchor: hand.anchor }];
            for (const a of list) {
                out.push({ sec: a.tick / this.ticksPerSec, anchor: a.anchor });
            }
            out.push({ sec: this._totalSec, anchor: list.length ? list[list.length - 1].anchor : hand.anchor });
            return out;
        }

        /**
         * Paint each hand's playable window across the visible time
         * slice as a translucent vertical lane in the roll background.
         * For every hand we walk the anchor timeline (`shift` and
         * `chord` events) — between two consecutive samples the anchor
         * is constant, so each segment is a coloured rectangle with
         * X = [hand.anchor, hand.anchor + span] and
         * Y = [seg.startSec, seg.endSec] mapped onto the lookahead
         * window. The current displayed anchor is used for the
         * boundary samples (start of view + extrapolation past the
         * last simulator event) so the lane visibly leaves from where
         * the live band sits.
         */
        _drawHandLanes(ctx, ext, pxPerPitch, startSec, lookaheadSec, H) {
            if (!Array.isArray(this._hands) || this._hands.length === 0) return;
            const endSec = startSec + lookaheadSec;
            const yOf = (sec) => H - ((sec - startSec) / lookaheadSec) * H;
            for (const hand of this._hands) {
                const samples = this._laneSamplesFor(hand, startSec, endSec);
                if (samples.length === 0) continue;
                const fill = _bandFill(hand.color);
                const infeasibleFill = 'rgba(220, 38, 38, 0.28)';
                const w = hand.span * pxPerPitch;
                for (let i = 0; i < samples.length - 1; i++) {
                    const cur = samples[i];
                    const next = samples[i + 1];
                    if (next.sec <= startSec || cur.sec >= endSec) continue;
                    // Stable segment between this sample and the start
                    // of the next shift (or the next sample if that
                    // sample isn't a shift). Drawn as a vertical
                    // rectangle — the anchor stays put while the hand
                    // plays the chords sitting on it.
                    const stableEndSec = Number.isFinite(next.fromSec) ? next.fromSec : next.sec;
                    if (stableEndSec > cur.sec) {
                        const a = Math.max(cur.sec, startSec);
                        const b = Math.min(stableEndSec, endSec);
                        if (b > a) {
                            ctx.fillStyle = fill;
                            const x = (cur.anchor - ext.lo) * pxPerPitch;
                            ctx.fillRect(x, yOf(b), w, yOf(a) - yOf(b));
                        }
                    }
                    // Sliding segment — only present when the next
                    // sample is a shift and carries explicit fromSec /
                    // fromAnchor. Drawn as a parallelogram interpolating
                    // both edges between (fromSec, fromAnchor) and
                    // (sec, toAnchor): the 4 vertices are
                    //   (fromSec, fromAnchor), (fromSec, fromAnchor+span),
                    //   (sec,     anchor+span), (sec,     anchor).
                    // The parallelogram's slope (Δanchor / Δsec) matches
                    // the configured max hand-move speed when the shift
                    // is feasible, or is steeper when infeasible — the
                    // operator can read the speed limit straight off
                    // the lane geometry.
                    if (Number.isFinite(next.fromSec) && Number.isFinite(next.fromAnchor)
                            && next.fromSec < next.sec) {
                        const a = Math.max(next.fromSec, startSec);
                        const b = Math.min(next.sec, endSec);
                        if (b > a) {
                            // Linear interpolation of the anchor at the
                            // clipped boundaries so a slide partially
                            // outside the viewport is rendered correctly.
                            const slope = (next.anchor - next.fromAnchor) / (next.sec - next.fromSec);
                            const aAnchor = next.fromAnchor + slope * (a - next.fromSec);
                            const bAnchor = next.fromAnchor + slope * (b - next.fromSec);
                            const xA = (aAnchor - ext.lo) * pxPerPitch;
                            const xB = (bAnchor - ext.lo) * pxPerPitch;
                            const yA = yOf(a);
                            const yB = yOf(b);
                            ctx.fillStyle = next.feasible === false ? infeasibleFill : fill;
                            ctx.beginPath();
                            ctx.moveTo(xA, yA);
                            ctx.lineTo(xA + w, yA);
                            ctx.lineTo(xB + w, yB);
                            ctx.lineTo(xB, yB);
                            ctx.closePath();
                            ctx.fill();
                            // Outline the parallelogram in the hand's
                            // color so the slide leg pops against the
                            // surrounding stable rectangles. Heavier
                            // stroke + dashed pattern when infeasible
                            // so it reads as a warning at a glance.
                            if (next.feasible === false) {
                                ctx.save();
                                ctx.strokeStyle = '#dc2626';
                                ctx.setLineDash([4, 3]);
                                ctx.lineWidth = 1.5;
                            } else {
                                ctx.strokeStyle = hand.color;
                                ctx.lineWidth = 1;
                            }
                            ctx.beginPath();
                            ctx.moveTo(xA, yA);
                            ctx.lineTo(xA + w, yA);
                            ctx.lineTo(xB + w, yB);
                            ctx.lineTo(xB, yB);
                            ctx.closePath();
                            ctx.stroke();
                            if (next.feasible === false) ctx.restore();
                        }
                    }
                }
            }
        }

        /** Build `[{sec, anchor}]` samples covering [startSec, endSec]
         *  from the simulation's per-hand timeline. The first sample
         *  is clamped to startSec carrying the most recent anchor,
         *  the last is clamped to endSec for the segment-pair walk. */
        _laneSamplesFor(hand, startSec, endSec) {
            const series = this._handAnchorTimeline?.get(hand.id) || [];
            const out = [];
            // Initial anchor at the start of the view: use the displayed
            // value if known so the lane visibly meets the live band.
            const first = this._displayedAnchor.has(hand.id)
                ? this._displayedAnchor.get(hand.id)
                : (this._targetAnchorAt(hand.id, startSec) ?? hand.anchor);
            out.push({ sec: startSec, anchor: first });
            for (const s of series) {
                // Slide may overlap the visible window even when the
                // shift's `sec` (= chord tick) falls past `endSec` —
                // include the entry whenever its slide leg crosses the
                // window, so a long shift drawn from `fromSec` inside
                // the view to `sec` outside still renders.
                const slideStart = Number.isFinite(s.fromSec) ? s.fromSec : s.sec;
                if (s.sec <= startSec) continue;
                if (slideStart >= endSec) break;
                out.push({
                    sec: s.sec,
                    anchor: s.anchor,
                    fromSec: s.fromSec,
                    fromAnchor: s.fromAnchor,
                    feasible: s.feasible !== false
                });
            }
            out.push({ sec: endSec, anchor: out[out.length - 1].anchor });
            return out;
        }

        _draw() {
            if (!this.rollCanvas || !this.rollHost) return;
            const dpr = window.devicePixelRatio || 1;
            const W = this.rollHost.clientWidth;
            const H = this.rollHost.clientHeight;
            if (W <= 0 || H <= 0) return;

            // Reallocating canvas.width/height invalidates the backing
            // store (forces a fresh GPU buffer + resets the context),
            // so only do it when the size actually changes. Without this
            // guard a 60 Hz redraw triggers ~120 buffer reallocs/second.
            const wantW = W * dpr;
            const wantH = H * dpr;
            if (this.rollCanvas.width !== wantW || this.rollCanvas.height !== wantH) {
                this.rollCanvas.width = wantW;
                this.rollCanvas.height = wantH;
                this.rollCanvas.style.width = W + 'px';
                this.rollCanvas.style.height = H + 'px';
            }
            const ctx = this.rollCanvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            // Roll axis follows the live keyboard view so zooming the
            // keyboard also zooms the falling-note column on the same
            // X mapping — operator never has to mentally remap.
            const ext = this._visibleExtent();
            // Same X-mapping as a piano: white-key uniform width, black
            // keys narrower. We reuse a simple linear pitch→x mapping
            // here (proportional to semitones) since the on-screen
            // keyboard is a separate widget below — the alignment is
            // close enough for a visualisation.
            const semitoneCount = ext.hi - ext.lo + 1;
            const pxPerPitch = W / semitoneCount;

            // Vertical layout: present is at y = H (just above the keyboard),
            // future is at y = 0 (top of the roll).
            const lookaheadSec = this._lookaheadSec;
            const startSec = this._currentSec;
            const endSec = startSec + lookaheadSec;

            // Light pitch grid lines (octaves).
            ctx.strokeStyle = 'rgba(148,163,184,0.15)';
            ctx.lineWidth = 1;
            for (let p = ext.lo; p <= ext.hi; p++) {
                if (p % 12 === 0) {
                    const x = (p - ext.lo) * pxPerPitch + 0.5;
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, H);
                    ctx.stroke();
                }
            }

            // Hand position lanes — one translucent stripe per hand
            // showing where the hand will be at every moment of the
            // visible window. Drawn under the notes (background) so the
            // operator can see at a glance which note is "covered" by
            // which hand and which falls outside any window. Anchor
            // segments come straight from the simulation timeline so a
            // shift event produces a visible step in the lane.
            this._drawHandLanes(ctx, ext, pxPerPitch, startSec, lookaheadSec, H);

            // Playhead line at the bottom of the roll (= present moment).
            ctx.strokeStyle = 'rgba(248,113,113,0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, H - 1);
            ctx.lineTo(W, H - 1);
            ctx.stroke();

            const assignments = this._currentAssignments();
            const hits = [];
            for (const n of this.notes) {
                const noteSec = n.tick / this.ticksPerSec;
                const dur = (n.duration || 0) / this.ticksPerSec;
                if (noteSec + dur < startSec) continue; // already past
                if (noteSec > endSec) continue;          // too far in future
                // Note rectangle: top = future side (smaller noteSec → higher y),
                // bottom = present side. We map [startSec, endSec] → [H, 0].
                const yBottom = H - ((noteSec - startSec) / lookaheadSec) * H;
                const yTop = H - ((noteSec + dur - startSec) / lookaheadSec) * H;
                const y = Math.max(0, yTop);
                const h = Math.min(H, yBottom) - y;
                if (h <= 0) continue;
                const x = (n.note - ext.lo) * pxPerPitch;
                const w = Math.max(2, pxPerPitch - 1);
                const handId = assignments.get(`${n.tick}:${n.note}`) || null;
                const isUnplayable = this._unplayableSet.has(`${n.tick}:${n.note}`);
                if (isUnplayable) {
                    // Red fill + thicker red border so unplayable notes
                    // pop visually even when assigned to a hand colour.
                    ctx.fillStyle = '#dc2626';
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeStyle = '#fecaca';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                    ctx.lineWidth = 1;
                } else {
                    ctx.fillStyle = handId ? _handColor(handId) : '#94a3b8';
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeStyle = 'rgba(15,23,42,0.6)';
                    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                }
                hits.push({ x, y, w, h, note: n });
            }
            this._noteHits = hits;
        }

        /** Map<"tick:note", handId> — delegated to state. */
        _currentAssignments() { return this.state.currentAssignments(); }

        // ----------------------------------------------------------------
        //  Interaction — note-click popover, wheel zoom
        // ----------------------------------------------------------------

        /**
         * Wire every gesture on the piano-roll:
         *
         * - `mousedown` → decide between three drags based on where the
         *   click landed:
         *     a. on a hand band → horizontal drag repins the hand
         *        anchor (X = pitch). The drag updates the live anchor
         *        every move and only commits / pushes history once on
         *        mouseup so the undo stack gets one entry per drag, not
         *        one per pixel.
         *     b. on a note      → preserved click-popover behaviour
         *        (see `_openNotePopover`).
         *     c. anywhere else  → vertical drag pans `_currentSec`
         *        (Y maps to time). Inverted: dragging upward moves the
         *        timeline forward (= the future approaches the
         *        keyboard).
         *
         * - `wheel`             → without modifier scrolls the timeline
         *                         (deltaY > 0 = forward); with `ctrlKey`
         *                         zooms the lookahead window.
         *
         * Click-vs-drag is disambiguated by a small movement threshold
         * (3 px). Below the threshold a mouseup on a note still opens
         * the popover, mirroring legacy behaviour.
         */
        _wireRollCanvas() {
            const HIT_BAND = 'band';
            const HIT_NOTE = 'note';
            const HIT_PAN  = 'pan';

            const localXY = (e) => {
                const rect = this.rollCanvas.getBoundingClientRect();
                return { x: e.clientX - rect.left, y: e.clientY - rect.top };
            };

            const hitTest = (x, y) => {
                const note = this._hitNote(x, y);
                if (note) return { kind: HIT_NOTE, note };
                const band = this._hitHandBand(x, y);
                if (band) return { kind: HIT_BAND, ...band };
                return { kind: HIT_PAN };
            };

            this.rollCanvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const { x, y } = localXY(e);
                const hit = hitTest(x, y);

                if (hit.kind === HIT_NOTE) {
                    // Defer to mouseup → click so a drag started ON a
                    // note doesn't open the popover. We track the
                    // initial pointer position and cancel the pending
                    // click if movement exceeds the threshold.
                    this._armPendingNoteClick(hit.note, e);
                    return;
                }

                e.preventDefault();
                this._closeNotePopover();

                if (hit.kind === HIT_BAND) this._startBandDrag(hit, x);
                else                       this._startTimePan(y);
            });

            // Click handler kept only for the deferred note popover.
            this.rollCanvas.addEventListener('click', (e) => {
                const pending = this._pendingNoteClick;
                this._pendingNoteClick = null;
                if (!pending) return;
                this._openNotePopover(pending.hit, e);
            });

            this.rollHost.addEventListener('wheel', (e) => {
                // Horizontal-only wheel events (touchpad sideways
                // scroll) carry deltaY === 0 and would otherwise be
                // consumed for nothing. Skip them so the browser can
                // fall back to its own behaviour.
                if (e.deltaY === 0) return;
                e.preventDefault();
                if (e.ctrlKey) {
                    const factor = e.deltaY < 0 ? 1.25 : 0.8;
                    this._lookaheadSec = Math.max(1, Math.min(30, this._lookaheadSec / factor));
                    this._redrawAll();
                    return;
                }
                // Wheel scrubs the timeline — one notch ≈ 10 % of the
                // visible window so a single scroll always moves the
                // playhead by a noticeable but predictable amount no
                // matter the zoom level.
                const step = (this._lookaheadSec || 4) * 0.1;
                this._currentSec = Math.max(0,
                    Math.min(this._totalSec || 0,
                        this._currentSec + Math.sign(e.deltaY) * step));
                this._ensureAnimLoop();
                this._draw();
                this._drawMinimap();
            }, { passive: false });
        }

        /** Drag-vs-click threshold (CSS pixels). Movement under this
         *  number of pixels still counts as a stationary click; above
         *  it cancels the pending note-popover and confirms the drag. */
        get _DRAG_THRESHOLD_PX() { return 3; }

        /** Arm a deferred note popover. Mouseup with movement under the
         *  threshold opens the popover; mouseup past the threshold (or
         *  any further mousedown) cancels it. Without this guard a
         *  user dragging across a note still got a popover on release. */
        _armPendingNoteClick(noteHit, downEvt) {
            this._pendingNoteClick = { hit: noteHit, evt: downEvt };
            const startX = downEvt.clientX;
            const startY = downEvt.clientY;
            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (dx * dx + dy * dy >= this._DRAG_THRESHOLD_PX * this._DRAG_THRESHOLD_PX) {
                    this._pendingNoteClick = null;
                    cleanup();
                }
            };
            const cleanup = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', cleanup);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', cleanup);
        }

        /** Hit-test the hand-position lanes drawn on the roll. Returns
         *  `{handId, anchorAtClick}` when the (x, y) point lies inside
         *  the band's reachable window at the corresponding time, or
         *  null otherwise. We use the EXACT same X mapping the renderer
         *  uses (`_visibleExtent` + uniform pxPerPitch) so what the
         *  operator sees == what they grab. The Y matters only for the
         *  drag's seed time; the click is "valid" anywhere inside the
         *  vertical lane.
         *  @private */
        _hitHandBand(x, y) {
            if (!this.rollHost || !Array.isArray(this._hands) || this._hands.length === 0) {
                return null;
            }
            const W = this.rollHost.clientWidth;
            const H = this.rollHost.clientHeight;
            if (W <= 0 || H <= 0) return null;
            const ext = this._visibleExtent();
            const pxPerPitch = W / Math.max(1, ext.hi - ext.lo + 1);
            // Y → time so we look up the right anchor for the row the
            // operator clicked on. Top of the roll = future, bottom = now.
            const tFromBottom = (H - y) / H;
            const seedSec = this._currentSec + tFromBottom * (this._lookaheadSec || 0);
            for (const hand of this._hands) {
                const anchor = this._anchorAtSec(hand, seedSec);
                if (!Number.isFinite(anchor)) continue;
                const xLeft  = (anchor - ext.lo) * pxPerPitch;
                const xRight = (anchor + hand.span - ext.lo + 1) * pxPerPitch;
                if (x >= xLeft && x <= xRight) {
                    // Pixel offset between the click and the band's
                    // left edge so the drag keeps the band visually
                    // pinned under the cursor.
                    const offsetPx = x - xLeft;
                    return { handId: hand.id, anchor, offsetPx, pxPerPitch, ext };
                }
            }
            return null;
        }

        /** Anchor of `hand` at time `sec`, prefering the simulator
         *  timeline (so a slide reflects in the lane), then falling
         *  back to the live in-memory anchor.
         *  @private */
        _anchorAtSec(hand, sec) {
            const t = this._targetAnchorAt(hand.id, sec);
            return Number.isFinite(t) ? t : hand.anchor;
        }

        _startBandDrag(hit, startX) {
            const threshold = this._DRAG_THRESHOLD_PX;
            const drag = {
                kind: 'band',
                handId: hit.handId,
                offsetPx: hit.offsetPx,
                pxPerPitch: hit.pxPerPitch,
                ext: hit.ext,
                started: false,
                startX
            };
            this._rollDrag = drag;
            const onMove = (ev) => {
                // Re-fetch the canvas rect every move: a window resize
                // or page scroll during the drag would otherwise leave
                // the band stuck to the old viewport position.
                const rect = this.rollCanvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
                if (!drag.started) {
                    if (Math.abs(x - drag.startX) < threshold) return;
                    drag.started = true;
                }
                const pitchAtLeftEdge = drag.ext.lo + (x - drag.offsetPx) / drag.pxPerPitch;
                this._onHandBandDragLive(drag.handId, Math.round(pitchAtLeftEdge));
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this._rollDrag = null;
                if (drag.started) {
                    // One history entry per completed drag — the live
                    // moves mutated `hand.anchor` in place; commit
                    // pushes the override + snapshot once.
                    this._commitHandBandDrag(drag.handId);
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        _startTimePan(startY) {
            const threshold = this._DRAG_THRESHOLD_PX;
            const drag = {
                kind: 'pan',
                startY,
                startSec: this._currentSec,
                H: this.rollHost.clientHeight,
                lookahead: this._lookaheadSec || 4,
                started: false
            };
            this._rollDrag = drag;
            const onMove = (ev) => {
                // Re-fetch the rect every move (window resize / scroll
                // during the drag would otherwise stale the geometry).
                const rect = this.rollCanvas.getBoundingClientRect();
                const y = ev.clientY - rect.top;
                if (!drag.started) {
                    if (Math.abs(y - drag.startY) < threshold) return;
                    drag.started = true;
                    this.rollHost?.classList.add('is-panning');
                }
                // Drag DOWN = travel back in time (the strip slides
                // toward you), drag UP = travel forward — feels like
                // grabbing the timeline strip itself.
                const deltaSec = ((y - drag.startY) / drag.H) * drag.lookahead * -1;
                const newSec = Math.max(0,
                    Math.min(this._totalSec || 0, drag.startSec + deltaSec));
                if (newSec !== this._currentSec) {
                    this._currentSec = newSec;
                    this._ensureAnimLoop();
                    this._draw();
                    this._drawMinimap();
                }
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this.rollHost?.classList.remove('is-panning');
                this._rollDrag = null;
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        /** Single redraw helper used by every "view-affecting" toolbar
         *  action (zoom in/out, kb-zoom, lookahead change). Calling
         *  this from one place keeps the four canvases (roll, minimap,
         *  kb-mini, fingers) in agreement after any view-state change. */
        _redrawAll() {
            this._draw();
            this._drawMinimap();
            this._drawKbMini();
            this._pushFingersState();
        }

        /** Live update during a band drag — clamps against neighbours
         *  AND against the instrument's playable range so a hand
         *  cannot be dragged beyond `note_range_min/max`. The
         *  previous version used the absolute MIDI bounds [0, 127],
         *  which let the rightmost hand glide off the visible
         *  keyboard (e.g. anchor 113 + span 14 = 127 on an 88-key
         *  piano whose `note_range_max` is 108). When that happened
         *  the fingers overlay's MIDI off-screen check (now in
         *  `KeyboardFingersRenderer`) skipped the hand and the user
         *  saw the band slip away with no fingers attached. Updates
         *  `_displayedAnchor` for an immediate visual effect; does
         *  NOT push history (commit handles that). */
        _onHandBandDragLive(handId, newAnchor) {
            const clamped = this.state.previewAnchor(handId, newAnchor);
            if (!Number.isFinite(clamped)) return;
            this.keyboard?.setHandBands(this._currentHandBands());
            this._draw();
            this._pushFingersState();
        }

        /** End-of-drag: persist the new anchor as a `hand_anchors`
         *  override entry at the current playhead via the state
         *  container, then refresh the problem list and redraw. */
        _commitHandBandDrag(handId) {
            const tick = Math.round(this._currentSec * this.ticksPerSec);
            const stored = this.state.commitAnchor(handId, tick);
            if (!Number.isFinite(stored)) return;
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
        }

        _hitNote(x, y) {
            const hits = this._noteHits || [];
            for (let i = hits.length - 1; i >= 0; i--) {
                const h = hits[i];
                if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
            }
            return null;
        }

        _openNotePopover(hit, evt) {
            this._closeNotePopover();
            const cfg = _parseHandsCfg(this.instrument);
            if (!cfg) return;
            const handIds = cfg.hands.map(h => h.id);
            const current = this._currentAssignments().get(`${hit.note.tick}:${hit.note.note}`);
            const popover = document.createElement('div');
            popover.className = 'khpe-note-popover';
            popover.style.cssText = `position:fixed;left:${(evt.clientX || 0) + 8}px;top:${(evt.clientY || 0) + 8}px;`
                + 'z-index:100002;background:#fff;border:1px solid #d1d5db;border-radius:6px;'
                + 'padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:12px;';
            popover.innerHTML = `
                <div style="margin-bottom:6px;font-weight:600;">${
                    _t('keyboardHandEditor.pickHand','Affecter à la main :')}</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    ${handIds.map(id => {
                        const isCur = id === current;
                        return `<button type="button" data-hand="${id}"
                            style="padding:4px 8px;border:1px solid ${_handColor(id)};
                                   background:${isCur ? _handColor(id) : '#fff'};
                                   color:${isCur ? '#fff' : _handColor(id)};
                                   border-radius:4px;cursor:pointer;font-weight:600;">
                            ${id}
                        </button>`;
                    }).join('')}
                </div>
                <button type="button" data-action="clear"
                    style="margin-top:6px;padding:4px 8px;border:1px solid #d1d5db;
                           background:#fff;border-radius:4px;cursor:pointer;width:100%;">
                    ${_t('keyboardHandEditor.clearAssignment','Réinitialiser ce choix')}
                </button>`;
            document.body.appendChild(popover);
            this._notePopover = popover;
            popover.addEventListener('click', (e) => {
                const handBtn = e.target.closest('[data-hand]');
                if (handBtn) {
                    this._pinNoteAssignment(hit.note.tick, hit.note.note, handBtn.dataset.hand);
                    this._closeNotePopover();
                    return;
                }
                if (e.target.matches('[data-action="clear"]')) {
                    this._clearNoteAssignment(hit.note.tick, hit.note.note);
                    this._closeNotePopover();
                }
            });
            this._popoverDeferTimer = setTimeout(() => {
                this._popoverDeferTimer = null;
                if (!this._notePopover) return;
                this._popoverDismissHandler = (ev) => {
                    if (this._notePopover && !this._notePopover.contains(ev.target)) {
                        this._closeNotePopover();
                    }
                };
                document.addEventListener('mousedown', this._popoverDismissHandler);
            }, 0);
        }

        _closeNotePopover() {
            if (this._popoverDeferTimer != null) {
                clearTimeout(this._popoverDeferTimer);
                this._popoverDeferTimer = null;
            }
            if (this._popoverDismissHandler) {
                document.removeEventListener('mousedown', this._popoverDismissHandler);
                this._popoverDismissHandler = null;
            }
            if (this._notePopover) {
                this._notePopover.remove();
                this._notePopover = null;
            }
        }

        _pinNoteAssignment(tick, note, handId) {
            this.state.setNoteAssignment(tick, note, handId);
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
        }

        _clearNoteAssignment(tick, note) {
            this.state.clearNoteAssignment(tick, note);
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
        }

        // ----------------------------------------------------------------
        //  Toolbar — transport, mute, history, save
        // ----------------------------------------------------------------

        _wireToolbar() {
            const root = this.dialog;
            if (!root) return;
            // Table-driven dispatch: each entry maps a button's
            // data-action attribute to the handler. Adding a new
            // toolbar button is now a one-line change in this map.
            const zoom = (factor) => {
                this._lookaheadSec = Math.min(30, Math.max(1, this._lookaheadSec * factor));
                this._redrawAll();
            };
            const reset = () => {
                // State drops every override, re-seeds the bands,
                // and pushes one history entry so the user can undo
                // the reset itself. The modal then refreshes the
                // dependent views.
                this.state.reset();
                this.keyboard?.setHandBands(this._currentHandBands());
                this._rebuildProblems();
                this._redrawAll();
            };
            // Pitch (horizontal) zoom centred on the keyboard view's
            // current centre — equivalent to the keyboard's old
            // mouse-wheel zoom but reachable from the toolbar so the
            // keyboard widget can stay non-interactive.
            const kbZoom = (factor) => {
                const view = this._visibleExtent();
                const center = (view.lo + view.hi) / 2;
                this._zoomKeyboard(factor, center);
            };
            const actions = {
                'close':            () => this.close(),
                'play':             () => this._play(),
                'pause':            () => this._pause(),
                'stop':             () => this._stop(),
                'mute':             (btn) => this._toggleMute(btn),
                'zoom-in':          () => zoom(1 / 1.25),
                'zoom-out':         () => zoom(1.25),
                'kb-zoom-in':       () => kbZoom(1.25),
                'kb-zoom-out':      () => kbZoom(1 / 1.25),
                'undo':             () => this._undo(),
                'redo':             () => this._redo(),
                'reset-overrides':  () => reset(),
                'prev-problem':     () => this._jumpToProblem(-1),
                'next-problem':     () => this._jumpToProblem(+1),
                'save':             () => this._save()
            };
            root.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn || btn.disabled) return;
                const handler = actions[btn.dataset.action];
                if (handler) handler(btn);
            });
        }

        // ----------------------------------------------------------------
        //  Transport — uses the host AudioPreview when available
        // ----------------------------------------------------------------

        async _play() {
            if (!this.audioPreview || !this.midiData) {
                this._setStatus(_t('keyboardHandEditor.noAudio','Aperçu audio indisponible.'));
                return;
            }
            try {
                this.audioPreview.onProgress = (tick, totalTicks, currentSec) => {
                    // Re-anchor the smooth-playhead interpolation to the
                    // freshly reported tick — the RAF loop then advances
                    // the playhead at frame rate until the next callback.
                    this._audioPlayingSec = currentSec || 0;
                    this._audioPlayingWall = performance.now();
                    this._ensureAnimLoop();
                };
                this.audioPreview.onPlaybackEnd = () => this._refreshTransport();
                const constraints = Number.isFinite(this.instrument?.gm_program)
                    ? { gmProgram: this.instrument.gm_program } : {};
                await this.audioPreview.previewSingleChannel(
                    this.midiData, this.channel, {}, constraints, 0, 0, true);
                this._refreshTransport();
            } catch (err) {
                console.error('[KeyboardHandPositionEditor] play failed:', err);
                this._setStatus(`${_t('keyboardHandEditor.playFailed','Lecture impossible')}: ${err.message || err}`);
            }
        }

        _pause() {
            this.audioPreview?.pause();
            // Freeze the smooth-playhead interpolator on the last reported
            // value; the RAF loop will see _audioPlayingSec === null and
            // stop spinning once the bands settle.
            this._audioPlayingSec = null;
            this._refreshTransport();
        }

        _stop() {
            this.audioPreview?.stop();
            this._audioPlayingSec = null;
            this._currentSec = 0;
            this._refreshTransport();
            this._ensureAnimLoop();
        }

        _toggleMute(btn) {
            const synth = this.audioPreview?.synthesizer;
            if (!synth || typeof synth.setMutedChannels !== 'function') return;
            const isMuted = btn.dataset.muted === '1';
            if (isMuted) {
                synth.setMutedChannels(this._mutedBeforePlay || []);
                btn.dataset.muted = '0';
                btn.textContent = '🔊';
            } else {
                this._mutedBeforePlay = synth.mutedChannels
                    ? Array.from(synth.mutedChannels) : [];
                synth.setMutedChannels([this.channel]);
                btn.dataset.muted = '1';
                btn.textContent = '🔇';
            }
        }

        /** Restore the previous mute set so leaving the editor doesn't
         *  poison the routing summary's preview state. */
        _restoreMute() {
            const synth = this.audioPreview?.synthesizer;
            if (!synth || typeof synth.setMutedChannels !== 'function') return;
            if (this._mutedBeforePlay != null) {
                synth.setMutedChannels(this._mutedBeforePlay);
                this._mutedBeforePlay = null;
            }
        }

        _refreshTransport() {
            const playBtn = this.$('[data-action="play"]');
            const pauseBtn = this.$('[data-action="pause"]');
            const stopBtn = this.$('[data-action="stop"]');
            const playing = !!this.audioPreview?.isPlaying;
            if (playBtn) playBtn.disabled = playing;
            if (pauseBtn) pauseBtn.disabled = !playing;
            if (stopBtn) stopBtn.disabled = !playing && !this.audioPreview?.isPreviewing;
        }

        // ----------------------------------------------------------------
        //  History + save — delegates to HandEditorShared.HistoryManager
        // ----------------------------------------------------------------

        _pushHistory() { this.state.pushHistory(); }

        _undo() {
            if (this.state.undo()) this._afterHistoryStep();
        }

        _redo() {
            if (this.state.redo()) this._afterHistoryStep();
        }

        _afterHistoryStep() {
            // The state already re-seeded the band anchors and the
            // displayed values; the modal just needs to refresh the
            // dependent views (problems, keyboard bands, fingers,
            // roll, minimap) for the new override snapshot.
            this.keyboard?.setHandBands(this._currentHandBands());
            this._rebuildProblems();
            this._redrawAll();
        }

        /** Re-seed all hand anchors + displayed positions from the
         *  current override set. Thin wrapper kept for back-compat
         *  with internal call sites; the actual logic lives in
         *  `KeyboardHandPositionState.reseedAnchors`. */
        _reseedAnchorsFromOverrides() {
            this.state.reseedAnchors();
            this.keyboard?.setHandBands(this._currentHandBands());
        }

        _refreshHistoryButtons() {
            const undoBtn = this.$('[data-action="undo"]');
            const redoBtn = this.$('[data-action="redo"]');
            const saveBtn = this.$('[data-action="save"]');
            if (undoBtn) undoBtn.disabled = !this._history.canUndo;
            if (redoBtn) redoBtn.disabled = !this._history.canRedo;
            if (saveBtn) saveBtn.disabled = !this.isDirty;
        }

        async _save() {
            if (!this.apiClient || typeof this.apiClient.sendCommand !== 'function') {
                this._setStatus(_t('keyboardHandEditor.noBackend','API non câblée.'));
                return;
            }
            try {
                await this.apiClient.sendCommand('routing_save_hand_overrides', {
                    fileId: this.fileId, channel: this.channel,
                    deviceId: this.deviceId, overrides: this.overrides
                });
                this.state.markSaved();
                this._setStatus(_t('keyboardHandEditor.saved','Enregistré.'));
            } catch (err) {
                console.error('[KeyboardHandPositionEditor] save failed:', err);
                this._setStatus(`${_t('keyboardHandEditor.saveFailed','Sauvegarde impossible')}: ${err.message || err}`);
            }
        }

        _setStatus(msg) {
            const el = this.$('[data-role="status"]');
            if (el) el.textContent = msg;
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardHandPositionEditorModal = KeyboardHandPositionEditorModal;
    }
})();
