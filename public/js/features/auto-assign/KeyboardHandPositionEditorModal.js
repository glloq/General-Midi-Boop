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
            // CSS lives in `public/styles/keyboard-hand-position-editor.css`
            // (loaded once globally). The overlay class hook is kept
            // so the stylesheet can hoist the editor above its caller
            // (the routing-summary modal).
            this.container?.classList.add('khpe-modal-overlay');
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
            this._mountRollRenderer();
            this._mountMinimapRenderer();
            this._wireToolbar();
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
         *  so the minimap (and any future renderer that needs the
         *  simulator-target anchor) keeps a stable call shape. */
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
            this._didLogFingerInputs = false;
            this.rollRenderer?.destroy?.();
            this.rollRenderer = null;
            this.minimapRenderer?.destroy?.();
            this.minimapRenderer = null;
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
                // (see `KeyboardRollRenderer`). The keyboard exists
                // purely to show where the hand currently sits and
                // which keys
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

        /** Instantiate the chromatic preview widget for the bottom
         *  strip. The widget exposes the same surface as
         *  `KeyboardPreview` (setRange, setHandBands, setActiveNotes,
         *  keyXAt, keyWidth, draw, destroy) so the rest of the modal
         *  drives it without branching on instrument type. */
        _buildChromaticKeyboard(ext) {
            if (typeof window === 'undefined' || !window.KeyboardChromaticPreview) {
                return null;
            }
            return new window.KeyboardChromaticPreview(this.keyboardCanvas, {
                rangeMin: ext.lo,
                rangeMax: ext.hi,
                bandHeight: 22
            });
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
        // `KeyboardRollRenderer` mousedown handler routes a drag
        // inside a band's reachable window to `_onHandBandDragLive`
        // (live visual update, no history) and `_commitHandBandDrag`
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
            // Diagnostic log: fires once per modal-open so the
            // operator can copy the console line into a bug report
            // when fingers go missing for a specific hand. Cheap
            // (one console.info), gated by `_didLogFingerInputs` so
            // it doesn't spam the log on every RAF tick.
            if (!this._didLogFingerInputs && (this._hands || []).length > 0) {
                this._didLogFingerInputs = true;
                const handsDigest = (this._hands || []).map(h => ({
                    id: h.id, span: h.span, numFingers: h.numFingers,
                    color: h.color, anchor: h.anchor
                }));
                const anchorMap = this._displayedAnchorMapForRender();
                const anchorEntries = Array.from(anchorMap.entries());
                const view = this._visibleExtent();
                console.info('[KeyboardHandPositionEditor] fingers inputs',
                    { layout: this._keyboardLayoutType(),
                      hands: handsDigest,
                      anchors: anchorEntries,
                      visibleExtent: view,
                      keyboard: this.keyboard ? 'wired' : 'missing' });
            }
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

        // ----------------------------------------------------------------
        //  Minimap widget — `KeyboardMinimapRenderer` owns the canvas
        //  and the scrub interaction; the modal mounts it once on
        //  `onOpen` and pushes inputs through `_pushMinimapState` on
        //  every state change (problems, simulation timeline, hands,
        //  playhead, lookahead).
        // ----------------------------------------------------------------

        _mountMinimapRenderer() {
            if (!this.minimapCanvas || !this.minimapHost) return;
            if (typeof window === 'undefined' || !window.KeyboardMinimapRenderer) return;
            this.minimapRenderer = new window.KeyboardMinimapRenderer(
                this.minimapCanvas, this.minimapHost,
                {
                    ticksPerSec: this.ticksPerSec,
                    totalSec: this._totalSec,
                    onSeek: (sec) => this._seekTo(sec),
                    getDisplayedAnchor: (handId) => this.state.getDisplayedAnchor(handId)
                }
            );
        }

        /** Push every minimap-relevant input from the state and ask
         *  for a redraw. Same single-point-of-push contract as the
         *  fingers and roll renderers. */
        _pushMinimapState() {
            const m = this.minimapRenderer;
            if (!m) return;
            m.setNotes(this.notes);
            m.setHands(this.state.hands);
            m.setHandsTimeline(this.state.simulationTimeline);
            m.setOverrideAnchors(this.overrides && this.overrides.hand_anchors);
            m.setProblems(this.state.problems);
            m.setRange(this._pitchExtent());
            m.setPlayhead(this._currentSec);
            m.setLookahead(this._lookaheadSec);
            m.setTotalSec(this._totalSec);
            m.draw();
        }

        /** Back-compat alias — many call sites still call
         *  `_drawMinimap()` directly. Routes through
         *  `_pushMinimapState`. */
        _drawMinimap() { this._pushMinimapState(); }

        // ----------------------------------------------------------------
        //  Piano-roll widget — `KeyboardRollRenderer` owns the canvas,
        //  the hit-test, the drag/pan/wheel pipeline, and the lane
        //  geometry. The modal mounts it once on `onOpen`, bridges the
        //  user gestures back through callbacks, and pushes inputs on
        //  every state change via `_pushRollState`.
        // ----------------------------------------------------------------

        /** Instantiate the piano-roll widget. No-op when the renderer
         *  script failed to load — the editor still opens with an
         *  empty roll area, the rest of the modal stays usable. */
        _mountRollRenderer() {
            if (!this.rollCanvas || !this.rollHost) return;
            if (typeof window === 'undefined' || !window.KeyboardRollRenderer) return;
            this.rollRenderer = new window.KeyboardRollRenderer(
                this.rollCanvas, this.rollHost,
                {
                    ticksPerSec: this.ticksPerSec,
                    totalSec: this._totalSec,
                    onNoteClick: (note, evt) => this._openNotePopover({ note }, evt),
                    onBandDragMove: (handId, anchor) => this._onHandBandDragLive(handId, anchor),
                    onBandDragEnd: (handId) => this._commitHandBandDrag(handId),
                    onSeek: (sec) => this._seekTo(sec),
                    onZoom: (factor) => this._zoomLookahead(factor),
                    getAnchorAt: (handId, sec) => this.state.targetAnchorAt(handId, sec),
                    getDisplayedAnchor: (handId) => this.state.getDisplayedAnchor(handId)
                }
            );
        }

        /** Push every roll-relevant input the renderer needs and
         *  redraw. The renderer reads only what we hand it; it never
         *  reaches into the modal or the state for any field. */
        _pushRollState() {
            const r = this.rollRenderer;
            if (!r) return;
            r.setNotes(this.notes);
            r.setHands(this.state.hands);
            r.setHandsTimeline(this.state.simulationTimeline);
            r.setNoteAssignments(this.state.currentAssignments());
            r.setUnplayable(this.state.unplayableSet);
            r.setVisibleExtent(this._visibleExtent());
            r.setLookahead(this._lookaheadSec);
            r.setPlayhead(this._currentSec);
            r.setTotalSec(this._totalSec);
            r.draw();
        }

        /** Back-compat alias — many call sites still call `_draw()`
         *  directly. Routes through `_pushRollState` which actually
         *  drives the renderer. */
        _draw() { this._pushRollState(); }

        /** Wheel / pan target. The renderer hands us a pre-clamped
         *  value; we re-clamp + restart the anim loop defensively. */
        _seekTo(sec) {
            const next = Math.max(0, Math.min(this._totalSec || 0, sec));
            if (next === this._currentSec) return;
            this._currentSec = next;
            this._ensureAnimLoop();
            this._draw();
            this._drawMinimap();
        }

        /** Ctrl+wheel zoom factor on the lookahead window. Larger
         *  factor = zoom in (smaller window, denser notes). */
        _zoomLookahead(factor) {
            const next = Math.max(1, Math.min(30, this._lookaheadSec / factor));
            if (next === this._lookaheadSec) return;
            this._lookaheadSec = next;
            this._redrawAll();
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
