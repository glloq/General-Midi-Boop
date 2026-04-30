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
                title: _t('keyboardHandEditor.title', 'Édition position de main (clavier)'),
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

            this.overrides = this._cloneOverrides(opts.initialOverrides) || {
                hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1
            };
            this._history = [this._cloneOverrides(this.overrides)];
            this._historyIndex = 0;
            this._savedIndex = 0;
            this._maxHistory = 50;

            // Pixels per second on the falling-note axis. Larger = notes
            // span more vertical space (zoom-in).
            // Lookahead window (seconds) shown above the keyboard. We only
            // draw notes whose start time is within `[currentSec, currentSec + lookaheadSec]`.
            this._lookaheadSec = 4;
            this._currentSec = 0;
            this._noteHits = [];
            this._notePopover = null;
            this._mutedBeforePlay = null;

            // Problem tracking — populated by `_rebuildProblems()` whenever
            // the overrides or the hand state change.
            this._problems = [];          // [{sec, kind:'chord'|'speed', message}]
            this._unplayableSet = new Set(); // "tick:note"
            this._problemRebuildTimer = null;

            // Animated band positions. `_displayedAnchor[handId]` lerps
            // toward `_targetAnchorAt(currentSec)` so the bands glide
            // smoothly toward their next position rather than snapping.
            // `_handAnchorTimeline[handId] = [{sec, anchor}]` is the
            // per-hand trajectory derived from the simulation timeline.
            this._handAnchorTimeline = new Map();
            this._displayedAnchor = new Map();
            this._animRaf = null;

            // Keyboard zoom: `_kbView` is the [lo, hi] pitch range
            // currently shown by the bottom keyboard + the roll axis.
            // Initialised to the full instrument range on open, then
            // narrowed by Ctrl+wheel or the mini-strip drag. The
            // mini-strip itself always shows the full range with a
            // viewport rectangle marking the live `_kbView`.
            this._kbView = null;
        }

        get isDirty() { return this._historyIndex !== this._savedIndex; }

        renderBody() {
            return `
                <div class="khpe-toolbar" style="display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid #e5e7eb;background:#fff;">
                    <button type="button" data-action="play" title="${_t('keyboardHandEditor.play','Lecture')}">▶</button>
                    <button type="button" data-action="pause" disabled title="${_t('keyboardHandEditor.pause','Pause')}">⏸</button>
                    <button type="button" data-action="stop" disabled title="${_t('keyboardHandEditor.stop','Stop')}">⏹</button>
                    <button type="button" data-action="mute" title="${_t('keyboardHandEditor.mute','Couper le son')}" data-muted="0">🔊</button>
                    <span style="display:inline-block;width:1px;height:18px;background:#d1d5db;"></span>
                    <button type="button" data-action="zoom-out" title="${_t('keyboardHandEditor.zoomOut','Dézoom')}">−</button>
                    <button type="button" data-action="zoom-in" title="${_t('keyboardHandEditor.zoomIn','Zoom')}">+</button>
                    <span style="display:inline-block;width:1px;height:18px;background:#d1d5db;"></span>
                    <button type="button" data-action="prev-problem" disabled title="${_t('keyboardHandEditor.prevProblem','Problème précédent')}">◄!</button>
                    <button type="button" data-action="next-problem" disabled title="${_t('keyboardHandEditor.nextProblem','Problème suivant')}">!►</button>
                    <span class="khpe-problem-count" data-role="problem-count" style="font-size:12px;color:#b91c1c;font-weight:600;min-width:20px;"></span>
                    <span style="flex:1"></span>
                    <span class="khpe-status" data-role="status" style="color:#6b7280;font-size:12px;"></span>
                    <button type="button" data-action="undo" disabled>↶</button>
                    <button type="button" data-action="redo" disabled>↷</button>
                    <button type="button" data-action="reset-overrides">⟲</button>
                    <button type="button" data-action="save" disabled>${_t('keyboardHandEditor.save','Enregistrer')}</button>
                </div>
                <div class="khpe-main" style="display:flex;flex-direction:column;flex:1;min-height:0;">
                    <div class="khpe-minimap-host" style="position:relative;height:54px;flex:none;background:#1e293b;border-bottom:1px solid #334155;">
                        <canvas class="khpe-minimap-canvas" style="position:absolute;inset:0;display:block;cursor:crosshair;"></canvas>
                    </div>
                    <div class="khpe-roll-host" style="position:relative;flex:1;background:#0f172a;overflow:hidden;">
                        <canvas class="khpe-roll-canvas" style="position:absolute;inset:0;display:block;"></canvas>
                    </div>
                    <div class="khpe-kb-mini-host" style="background:#0f172a;height:22px;flex:none;border-top:1px solid #334155;cursor:pointer;position:relative;">
                        <canvas class="khpe-kb-mini-canvas" style="display:block;width:100%;height:100%;"></canvas>
                    </div>
                    <div class="khpe-keyboard-host" style="position:relative;background:#1e293b;padding:6px;height:140px;flex:none;">
                        <canvas class="khpe-keyboard-canvas" style="display:block;width:100%;height:100%;"></canvas>
                        <canvas class="khpe-fingers-overlay" style="position:absolute;inset:6px;pointer-events:none;"></canvas>
                    </div>
                </div>
                <div class="khpe-hint" style="padding:6px 10px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;background:#fff;">
                    ${_t('keyboardHandEditor.hint',
                         'Les notes descendent vers le clavier. Cliquez sur une note pour la réaffecter à une main différente.')}
                </div>
            `;
        }

        renderFooter() {
            return `<button type="button" class="btn" data-action="close">${_t('common.close','Fermer')}</button>`;
        }

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
            this._wireToolbar();
            this._wireRollCanvas();
            this._wireMinimap();
            this._wireKbMini();
            this._wireResizeObserver();
            // Defer first draw so the layout has settled (clientWidth/Height
            // would otherwise read 0 inside the BaseModal mount handler).
            requestAnimationFrame(() => {
                this._rebuildProblems();
                this._draw();
                this._drawMinimap();
                this._drawKbMini();
                this._drawFingers();
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

        _runFeasibility() {
            const Feas = window.HandPositionFeasibility;
            if (!Feas || typeof Feas.simulateHandWindows !== 'function') return;
            // Reflect the current operator-tweaked anchors so the
            // simulator's per-tick window logic agrees with the bands
            // the user sees on the keyboard.
            const overridesForSim = this._cloneOverrides(this.overrides) || {
                hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1
            };
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
            const problems = [];
            const unplayable = new Set();
            const tps = this.ticksPerSec;
            for (const ev of timeline) {
                if (ev.type === 'chord' && Array.isArray(ev.unplayable) && ev.unplayable.length > 0) {
                    problems.push({ sec: ev.tick / tps, kind: 'chord' });
                    for (const u of ev.unplayable) {
                        if (Number.isFinite(u.note)) unplayable.add(`${ev.tick}:${u.note}`);
                    }
                } else if (ev.type === 'shift' && ev.motion && ev.motion.feasible === false) {
                    problems.push({ sec: ev.tick / tps, kind: 'speed' });
                }
            }
            problems.sort((a, b) => a.sec - b.sec);
            this._problems = problems;
            this._unplayableSet = unplayable;
            this._buildHandAnchorTimeline(timeline);
        }

        /** Per-hand `[{sec, anchor, fromSec?, fromAnchor?}]` series.
         *  `fromSec` and `fromAnchor` are populated for `shift` events:
         *  they describe the moving leg of the trajectory — the hand
         *  travelled from `fromAnchor` at `fromSec` to `anchor` at
         *  `sec`. Without them we'd only know the destination and the
         *  background lane would render as a step instead of the
         *  diagonal slide a real hand performs. */
        _buildHandAnchorTimeline(timeline) {
            const tps = this.ticksPerSec;
            const seriesBy = new Map();
            const ensure = (id) => {
                if (!seriesBy.has(id)) seriesBy.set(id, []);
                return seriesBy.get(id);
            };
            for (const ev of timeline || []) {
                if (ev.type === 'shift' && ev.handId && Number.isFinite(ev.toAnchor)) {
                    // The simulator's motion.availableSec carries how
                    // long the hand had since its previous release. We
                    // use it to back-date the start of the shift so the
                    // background lane renders the actual slide instead
                    // of a teleport. Falls back to motion.requiredSec
                    // (the minimum travel time given the configured
                    // hand_move speed) when the simulator didn't have
                    // tempo info, and to a small default when neither
                    // is finite (first shift, hand at rest).
                    const sec = ev.tick / tps;
                    let dur = Number.NaN;
                    if (ev.motion) {
                        if (Number.isFinite(ev.motion.availableSec)) dur = ev.motion.availableSec;
                        else if (Number.isFinite(ev.motion.requiredSec)) dur = ev.motion.requiredSec;
                    }
                    if (!Number.isFinite(dur) || dur <= 0) dur = 0.15; // sensible fallback
                    ensure(ev.handId).push({
                        sec,
                        anchor: ev.toAnchor,
                        fromSec: Math.max(0, sec - dur),
                        fromAnchor: Number.isFinite(ev.fromAnchor) ? ev.fromAnchor : ev.toAnchor
                    });
                } else if (ev.type === 'chord' && Array.isArray(ev.notes)) {
                    const lowestByHand = new Map();
                    for (const n of ev.notes) {
                        if (!n.handId || !Number.isFinite(n.note)) continue;
                        const cur = lowestByHand.get(n.handId);
                        if (cur == null || n.note < cur) lowestByHand.set(n.handId, n.note);
                    }
                    for (const [id, lo] of lowestByHand) {
                        ensure(id).push({ sec: ev.tick / tps, anchor: lo });
                    }
                }
            }
            for (const arr of seriesBy.values()) arr.sort((a, b) => a.sec - b.sec);
            this._handAnchorTimeline = seriesBy;
        }

        /** Step lookup: latest `{sec, anchor}` whose sec ≤ `atSec`. */
        _targetAnchorAt(handId, atSec) {
            const series = this._handAnchorTimeline?.get(handId);
            if (!series || series.length === 0) {
                const hand = (this._hands || []).find(h => h.id === handId);
                return hand ? hand.anchor : null;
            }
            // Binary-ish scan — series is small (one entry per chord/shift).
            let best = series[0].anchor;
            for (const s of series) {
                if (s.sec > atSec) break;
                best = s.anchor;
            }
            return best;
        }

        /** Interpolation step: pull `_displayedAnchor[id]` toward the
         *  target anchor at the current playhead. Decay is computed from
         *  the wall-clock delta so the animation stays cross-monitor
         *  consistent (a 144 Hz screen does not run 2× faster than 60 Hz).
         *  Returns true when at least one band is still moving so the
         *  caller can keep the RAF loop running. */
        _stepAnchorAnimation(dtSec) {
            if (!Array.isArray(this._hands) || this._hands.length === 0) return false;
            // Look slightly AHEAD of the playhead so the hands anticipate
            // upcoming notes (matches a real player who looks ahead at the
            // score) — half the lookahead window is a good visual default.
            const lookSec = this._currentSec + (this._lookaheadSec || 4) * 0.5;
            // Critically-damped exponential ease. `1 - e^(-k·dt)` produces
            // a half-life of ln(2)/k seconds (here ~85 ms) regardless of
            // the frame rate.
            const k = 8;
            const blend = 1 - Math.exp(-k * Math.max(0, dtSec));
            let stillMoving = false;
            for (const hand of this._hands) {
                const target = this._targetAnchorAt(hand.id, lookSec);
                if (!Number.isFinite(target)) continue;
                const cur = this._displayedAnchor.get(hand.id);
                const start = Number.isFinite(cur) ? cur : hand.anchor;
                const gap = target - start;
                if (Math.abs(gap) < 0.05) {
                    this._displayedAnchor.set(hand.id, target);
                    continue;
                }
                this._displayedAnchor.set(hand.id, start + gap * blend);
                stillMoving = true;
            }
            return stillMoving;
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
                this._draw();
                this._drawMinimap();
                this._drawKbMini();
                this._drawFingers();

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
                    /* Override .modal-dialog defaults (max-width:800px,
                       border-radius, margin auto) so the editor uses the
                       full viewport — multi-hand keyboards need the
                       horizontal real estate. */
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: 100vw !important;
                    max-height: 100vh !important;
                    margin: 0 !important;
                    border-radius: 0 !important;
                    display: flex; flex-direction: column;
                    background: #fff;
                }
                .khpe-modal .modal-body {
                    flex: 1; display: flex; flex-direction: column;
                    overflow: hidden; padding: 0; min-height: 0;
                }
                .khpe-toolbar button[data-action] {
                    padding: 4px 10px; border: 1px solid #d1d5db;
                    background: #fff; border-radius: 4px; cursor: pointer;
                    font-size: 14px;
                }
                .khpe-toolbar button[data-action]:hover:not([disabled]) { background: #f3f4f6; }
                .khpe-toolbar button[data-action][disabled] { opacity: 0.45; cursor: not-allowed; }
                .khpe-roll-host { min-height: 200px; }
            `;
            document.head.appendChild(style);
        }

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

        /** Project-styled confirmation modal (mirrors the strings editor
         *  pattern). Reuses `.confirm-modal-overlay` CSS from editor.css
         *  so the look matches the rest of the app. Resolves to true
         *  when the operator confirms the discard, false otherwise.
         *  Esc cancels, Enter confirms. */
        _showDiscardConfirm() {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'confirm-modal-overlay khpe-discard-confirm';
                overlay.innerHTML = `
                    <div class="confirm-modal" role="dialog" aria-modal="true">
                        <div class="confirm-modal-header">
                            <span class="confirm-modal-icon">⚠️</span>
                            <h3 class="confirm-modal-title">${
                                _t('keyboardHandEditor.confirmDiscardTitle',
                                   'Modifications non enregistrées')}</h3>
                        </div>
                        <div class="confirm-modal-body">
                            <p class="confirm-modal-message">${
                                _t('keyboardHandEditor.confirmDiscard',
                                   'Voulez-vous quitter sans sauvegarder ?')}</p>
                        </div>
                        <div class="confirm-modal-footer">
                            <button class="confirm-modal-btn cancel" data-action="cancel">${
                                _t('common.cancel', 'Annuler')}</button>
                            <button class="confirm-modal-btn danger" data-action="confirm">${
                                _t('keyboardHandEditor.discardConfirmBtn',
                                   'Quitter sans sauvegarder')}</button>
                        </div>
                    </div>
                `;
                // Editor sits at 10010; confirm dialog must beat it.
                overlay.style.zIndex = '10025';
                document.body.appendChild(overlay);

                const close = (result) => {
                    overlay.removeEventListener('click', onClick);
                    document.removeEventListener('keydown', onKey);
                    overlay.classList.remove('visible');
                    setTimeout(() => {
                        if (overlay.parentNode) overlay.remove();
                        resolve(result);
                    }, 200);
                };
                const onClick = (e) => {
                    if (e.target === overlay) { close(false); return; }
                    const btn = e.target.closest('.confirm-modal-btn');
                    if (!btn) return;
                    close(btn.dataset.action === 'confirm');
                };
                const onKey = (e) => {
                    if (e.key === 'Escape') close(false);
                    else if (e.key === 'Enter') close(true);
                };
                overlay.addEventListener('click', onClick);
                document.addEventListener('keydown', onKey);
                requestAnimationFrame(() => overlay.classList.add('visible'));
                setTimeout(() => {
                    overlay.querySelector('.confirm-modal-btn.cancel')?.focus();
                }, 50);
            });
        }

        // ----------------------------------------------------------------
        //  Keyboard widget at the bottom (with draggable hand bands)
        // ----------------------------------------------------------------

        _mountKeyboard() {
            if (!this.keyboardCanvas) return;
            const ext = this._pitchExtent();
            // Per-hand state: anchor (lowest playable note) is the
            // operator-controlled value; span is read from hands_config.
            // Anchors initialise from `hand_anchors` overrides at the
            // current playhead, falling back to a deterministic seed
            // (low pitch, mid pitch, ...) so 1- and 4-hand keyboards
            // both render with non-overlapping bands at startup.
            const cfg = _parseHandsCfg(this.instrument);
            this._hands = (cfg?.hands || []).map((h, i) => {
                let span;
                if (Number.isFinite(h.hand_span_semitones)) {
                    span = h.hand_span_semitones;
                } else if (Number.isFinite(h.num_fingers)) {
                    span = Math.max(1, h.num_fingers - 1);
                } else {
                    span = 4;
                }
                const numFingers = Number.isFinite(h.num_fingers)
                    ? h.num_fingers : span + 1;
                const seedAnchor = ext.lo + Math.round(((i + 0.5) / Math.max(1, cfg.hands.length))
                    * (ext.hi - ext.lo - span));
                const id = h.id || `h${i + 1}`;
                const overrideAnchor = this._latestAnchorOverride(id);
                return {
                    id,
                    span,
                    numFingers,
                    anchor: Number.isFinite(overrideAnchor) ? overrideAnchor : seedAnchor,
                    color: _handColor(id)
                };
            });
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
                this.keyboard = new window.KeyboardPreview(this.keyboardCanvas, {
                    rangeMin: ext.lo,
                    rangeMax: ext.hi,
                    bandHeight: 22,
                    bandsOnSingleRow: true,
                    onBandDrag: (handId, newAnchor) => this._onHandBandDrag(handId, newAnchor)
                });
            }
            this.keyboard?.setHandBands(this._currentHandBands());
            requestAnimationFrame(() => {
                this._fitKeyboardCanvas();
                this.keyboard?.setHandBands(this._currentHandBands());
                this.keyboard?.draw();
            });

            // Wheel on the keyboard zooms the visible range. Centre on
            // the cursor so zooming-in into a specific octave keeps
            // that octave under the mouse, like a map app.
            this.keyboardCanvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = this.keyboardCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const view = this._visibleExtent();
                const center = view.lo + (x / rect.width) * (view.hi - view.lo);
                const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
                this._zoomKeyboard(factor, center);
            }, { passive: false });
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
            const self = this;
            let rangeMin = ext.lo;
            let rangeMax = ext.hi;
            let bands = [];
            let drag = null;

            const noteAtX = (x, w) => {
                const range = Math.max(1, rangeMax - rangeMin + 1);
                const pxPerNote = w / range;
                if (pxPerNote <= 0) return null;
                return rangeMin + Math.floor(x / pxPerNote);
            };

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
                // Notes as identical cells. C of every octave gets a
                // brighter tint so the operator finds the octave
                // boundaries quickly.
                for (let m = rangeMin; m <= rangeMax; m++) {
                    const x = (m - rangeMin) * pxPerNote;
                    ctx.fillStyle = (m % 12 === 0) ? '#f8fafc' : '#cbd5e1';
                    ctx.fillRect(x + 0.5, 0, Math.max(1, pxPerNote - 1), keysH);
                    if (m % 12 === 0 && pxPerNote > 18) {
                        ctx.fillStyle = '#0f172a';
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

            // Drag a band to repin its anchor — same UX as KeyboardPreview.
            const onMouseDown = (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const W = rect.width, H = rect.height;
                const bandH = 22;
                if (y < H - bandH) return; // not in band area
                const note = noteAtX(x, W);
                if (note == null) return;
                // Find the band whose [low, high] contains the click.
                for (let i = 0; i < bands.length; i++) {
                    const b = bands[i];
                    if (note >= b.low && note <= b.high) {
                        drag = { bandIdx: i, span: b.high - b.low, offset: note - b.low };
                        break;
                    }
                }
            };
            const onMouseMove = (e) => {
                if (!drag) return;
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const note = noteAtX(x, rect.width);
                if (note == null) return;
                const newAnchor = note - drag.offset;
                self._onHandBandDrag(bands[drag.bandIdx].id, newAnchor);
            };
            const onMouseUp = () => { drag = null; };
            canvas.addEventListener('mousedown', onMouseDown);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);

            return {
                setRange(min, max) { rangeMin = min; rangeMax = max; draw(); },
                setHandBands(b) { bands = Array.isArray(b) ? b : []; draw(); },
                draw,
                destroy() {
                    canvas.removeEventListener('mousedown', onMouseDown);
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    drag = null;
                    bands = [];
                }
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

        /** Bands rendered on the keyboard. Anchors are quantized to the
         *  nearest semitone before being handed to KeyboardPreview —
         *  its `_xOf(midi)` indexes a sparse integer array, so a
         *  fractional anchor (mid-lerp) used to land on `undefined`
         *  and the band would silently jump or disappear. The roll
         *  itself keeps the floating-point value for sub-semitone
         *  precision in the lane background. */
        _currentHandBands() {
            return (this._hands || []).map(h => {
                const a = this._displayedAnchor.has(h.id)
                    ? this._displayedAnchor.get(h.id)
                    : h.anchor;
                const aInt = Math.round(a);
                return { id: h.id, low: aInt, high: aInt + h.span, color: h.color };
            });
        }

        /** Look up the most recent hand_anchors override for `handId`
         *  (the entry with the largest tick ≤ current playhead). */
        _latestAnchorOverride(handId) {
            const list = this.overrides?.hand_anchors;
            if (!Array.isArray(list)) return null;
            let best = null;
            const currentTick = this._currentSec * this.ticksPerSec;
            for (const a of list) {
                if (a?.handId !== handId || !Number.isFinite(a.tick)) continue;
                if (a.tick > currentTick) continue;
                if (!best || a.tick > best.tick) best = a;
            }
            return best ? best.anchor : null;
        }

        /** User dragged a hand band on the keyboard. Update the in-memory
         *  state, push a `hand_anchors` override entry at the current
         *  playhead, and redraw both the keyboard and the piano-roll.
         *
         *  Single-axis constraint: hands share one physical axis on the
         *  keyboard so they cannot cross each other and must not overlap.
         *  We clamp the new anchor against the immediate neighbours
         *  (`h_{i-1}.anchor + h_{i-1}.span` from below, `h_{i+1}.anchor − span`
         *  from above) so a drag that would invert the order or collide
         *  produces a snug-against-neighbour position instead. */
        _onHandBandDrag(handId, newAnchor) {
            const idx = (this._hands || []).findIndex(h => h.id === handId);
            if (idx < 0) return;
            const hand = this._hands[idx];
            const prev = idx > 0 ? this._hands[idx - 1] : null;
            const next = idx < this._hands.length - 1 ? this._hands[idx + 1] : null;
            const minAnchor = prev ? prev.anchor + prev.span : 0;
            const maxAnchor = next ? next.anchor - hand.span : 127 - hand.span;
            const clamped = Math.max(minAnchor, Math.min(maxAnchor, newAnchor));
            hand.anchor = clamped;
            if (!Array.isArray(this.overrides.hand_anchors)) {
                this.overrides.hand_anchors = [];
            }
            const tick = Math.round(this._currentSec * this.ticksPerSec);
            const list = this.overrides.hand_anchors;
            // Replace the entry at the same tick / hand or append.
            const i = list.findIndex(a => a?.handId === handId && a?.tick === tick);
            const entry = { tick, handId, anchor: clamped };
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            this._pushHistory();
            this.keyboard?.setHandBands(this._currentHandBands());
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
        }

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
                    this._drawFingers();
                });
            });
            this._resizeObserver.observe(this.rollHost);
            const kbHost = this.$('.khpe-keyboard-host');
            if (kbHost) this._resizeObserver.observe(kbHost);
            if (this.minimapHost) this._resizeObserver.observe(this.minimapHost);
            if (this.kbMiniHost) this._resizeObserver.observe(this.kbMiniHost);
        }

        // ----------------------------------------------------------------
        //  Minimap — file overview, viewport rect, hand-anchor trajectories
        // ----------------------------------------------------------------

        // ----------------------------------------------------------------
        //  Fingers overlay — vertical bars from the hand band down to
        //  each playable key, coloured grey when the finger is lifted
        //  and blue when it currently presses a sounding note.
        // ----------------------------------------------------------------

        /** Whether this instrument's hands_config explicitly sets the
         *  piano layout. Used to decide whether to drop a finger on
         *  every semitone (chromatic) or one per key (piano = white +
         *  black). Defaults to chromatic when absent so legacy rows
         *  keep their semantics. */
        _keyboardLayoutType() {
            const cfg = _parseHandsCfg(this.instrument);
            return cfg?.keyboard_type === 'piano' ? 'piano' : 'chromatic';
        }

        /** Set of MIDI notes currently sounding at `_currentSec` —
         *  rebuilt every frame because the playhead moves. We keep it
         *  cheap by short-circuiting the duration check on negative
         *  results. */
        _activeNotesAtPlayhead() {
            const out = new Set();
            const t = this._currentSec * this.ticksPerSec;
            for (const n of this.notes) {
                if (n.tick > t) continue;
                const dur = Number.isFinite(n.duration) ? n.duration : 0;
                if (n.tick + dur > t) out.add(n.note);
            }
            return out;
        }

        /** Paint the fingers overlay. Each hand drops one rectangle per
         *  playable key inside its window. For chromatic instruments
         *  every semitone gets one rectangle. For piano instruments we
         *  drop one rectangle on every white key AND one on every black
         *  key so all 12 chromatic positions are individually
         *  highlightable. The rectangle is ~⅓ as wide as the underlying
         *  key so the operator sees both the finger AND the key — the
         *  finger origin sits flush against the band on the keyboard,
         *  the tip stops short of the key's bottom. */
        _drawFingers() {
            const c = this.fingersCanvas;
            const host = c?.parentElement;
            if (!c || !host) return;
            const dpr = window.devicePixelRatio || 1;
            const W = c.clientWidth;
            const H = c.clientHeight;
            if (W <= 0 || H <= 0) return;
            const wantW = W * dpr;
            const wantH = H * dpr;
            if (c.width !== wantW || c.height !== wantH) {
                c.width = wantW;
                c.height = wantH;
            }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            if (!Array.isArray(this._hands) || this._hands.length === 0) return;

            const view = this._visibleExtent();
            const pxPerPitch = W / Math.max(1, view.hi - view.lo + 1);
            const layout = this._keyboardLayoutType();
            const active = this._activeNotesAtPlayhead();
            // Geometry: bands sit at the bottom of the keyboard widget
            // (single-row layout, height ~22px per the constructor). The
            // overlay covers the same area, so:
            //   handY  = H - bandH   (top of the band = where fingers hang from)
            //   tipY   = ~ keyMidH   (just inside the keyboard body)
            const bandH = 22;
            const handY = Math.max(0, H - bandH);
            const tipY = handY * 0.55; // tip stops in the upper-half of the keyboard area
            for (const hand of this._hands) {
                const a = this._displayedAnchor.has(hand.id)
                    ? this._displayedAnchor.get(hand.id) : hand.anchor;
                const aInt = Math.round(a);
                const stop = aInt + hand.span;
                ctx.fillStyle = '#1e3a8a';   // pressed (blue)
                const liftedFill = '#94a3b8'; // lifted (grey)
                for (let m = Math.max(view.lo, aInt); m <= Math.min(view.hi, stop); m++) {
                    if (layout === 'piano') {
                        // Piano: every chromatic position is a finger
                        // slot — same as chromatic. The visual gain
                        // comes from the underlying keyboard (already
                        // black/white) showing through, not from the
                        // finger spacing itself.
                    }
                    const isPressed = active.has(m);
                    const x = (m - view.lo) * pxPerPitch;
                    // Finger rectangle: ~⅓ of the key width, centred on
                    // the key so it doesn't visually steal the whole
                    // key and the operator still reads the keyboard
                    // underneath.
                    const fingerW = Math.max(2, pxPerPitch * 0.33);
                    const fx = x + (pxPerPitch - fingerW) / 2;
                    ctx.fillStyle = isPressed ? '#3b82f6' : liftedFill;
                    ctx.fillRect(fx, tipY, fingerW, handY - tipY);
                    // Hand-coloured cap at the top so the operator can
                    // tell which hand owns the finger at a glance.
                    ctx.fillStyle = hand.color;
                    ctx.fillRect(fx, handY - 3, fingerW, 3);
                }
            }
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
                handle(e);
                this._kbMiniDragging = true;
                const onMove = (ev) => { if (this._kbMiniDragging) handle(ev); };
                const onUp = () => {
                    this._kbMiniDragging = false;
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

        _wireMinimap() {
            if (!this.minimapCanvas) return;
            this.minimapCanvas.addEventListener('click', (e) => {
                if (!this._totalSec) return;
                const rect = this.minimapCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const sec = (x / rect.width) * this._totalSec;
                this._currentSec = Math.max(0, Math.min(this._totalSec, sec));
                this._ensureAnimLoop();
                this._draw();
                this._drawMinimap();
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
            // hand-anchor lines stay readable on top.
            ctx.fillStyle = 'rgba(148,163,184,0.55)';
            for (const n of this.notes) {
                const sec = n.tick / this.ticksPerSec;
                const x = sec * xPerSec;
                const y = H - ((n.note - ext.lo) / pitchRange) * H;
                ctx.fillRect(x, y - 0.5, Math.max(1, xPerSec * (n.duration || 0) / this.ticksPerSec), 1.5);
            }

            // Hand-anchor trajectories. We sample each hand's anchor at
            // every override tick (sorted), with the seed/current value
            // filling the gaps before the first override and after the
            // last one. Drawn as a thicker coloured line so it dominates
            // the note dots.
            for (const hand of (this._hands || [])) {
                const samples = this._anchorSamplesForHand(hand);
                if (samples.length === 0) continue;
                ctx.strokeStyle = hand.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (let i = 0; i < samples.length; i++) {
                    const s = samples[i];
                    const x = s.sec * xPerSec;
                    const y = H - ((s.anchor - ext.lo) / pitchRange) * H;
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
                ctx.fillStyle = fill;
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
                    if (Number.isFinite(next.fromSec) && Number.isFinite(next.fromAnchor)) {
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
                            ctx.beginPath();
                            ctx.moveTo(xA, yA);
                            ctx.lineTo(xA + w, yA);
                            ctx.lineTo(xB + w, yB);
                            ctx.lineTo(xB, yB);
                            ctx.closePath();
                            ctx.fill();
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
                if (s.sec <= startSec) continue;
                if (s.sec >= endSec) break;
                out.push({ sec: s.sec, anchor: s.anchor });
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

        /** Map<"tick:note", handId> from current overrides. */
        _currentAssignments() {
            const out = new Map();
            const list = this.overrides?.note_assignments || [];
            for (const a of list) {
                if (a && a.handId) out.set(`${a.tick}:${a.note}`, a.handId);
            }
            return out;
        }

        // ----------------------------------------------------------------
        //  Interaction — note-click popover, wheel zoom
        // ----------------------------------------------------------------

        _wireRollCanvas() {
            this.rollCanvas.addEventListener('click', (e) => {
                const rect = this.rollCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const hit = this._hitNote(x, y);
                if (!hit) { this._closeNotePopover(); return; }
                this._openNotePopover(hit, e);
            });
            this.rollHost.addEventListener('wheel', (e) => {
                if (e.ctrlKey) {
                    e.preventDefault();
                    const factor = e.deltaY < 0 ? 1.25 : 0.8;
                    this._lookaheadSec = Math.max(1, Math.min(30, this._lookaheadSec / factor));
                    this._draw();
                }
            }, { passive: false });
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
            if (!Array.isArray(this.overrides.note_assignments)) {
                this.overrides.note_assignments = [];
            }
            const list = this.overrides.note_assignments;
            const idx = list.findIndex(a => a.tick === tick && a.note === note);
            const entry = { tick, note, handId };
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            this._pushHistory();
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
        }

        _clearNoteAssignment(tick, note) {
            const list = this.overrides?.note_assignments;
            if (!Array.isArray(list)) return;
            const idx = list.findIndex(a => a.tick === tick && a.note === note);
            if (idx < 0) return;
            list.splice(idx, 1);
            this._pushHistory();
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
            root.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn || btn.disabled) return;
                switch (btn.dataset.action) {
                    case 'close': this.close(); return;
                    case 'play': this._play(); return;
                    case 'pause': this._pause(); return;
                    case 'stop': this._stop(); return;
                    case 'mute': this._toggleMute(btn); return;
                    case 'zoom-in':
                        this._lookaheadSec = Math.max(1, this._lookaheadSec / 1.25);
                        this._draw(); this._drawMinimap(); return;
                    case 'zoom-out':
                        this._lookaheadSec = Math.min(30, this._lookaheadSec * 1.25);
                        this._draw(); this._drawMinimap(); return;
                    case 'undo': this._undo(); return;
                    case 'redo': this._redo(); return;
                    case 'reset-overrides':
                        this.overrides = { hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1 };
                        this._pushHistory();
                        this._rebuildProblems();
                        this._draw(); this._drawMinimap(); return;
                    case 'prev-problem': this._jumpToProblem(-1); return;
                    case 'next-problem': this._jumpToProblem(+1); return;
                    case 'save': this._save(); return;
                }
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
        //  History + save
        // ----------------------------------------------------------------

        _cloneOverrides(o) { return o ? JSON.parse(JSON.stringify(o)) : null; }

        _pushHistory() {
            this._history = this._history.slice(0, this._historyIndex + 1);
            this._history.push(this._cloneOverrides(this.overrides));
            if (this._history.length > this._maxHistory) {
                this._history.shift();
                this._savedIndex = Math.max(0, this._savedIndex - 1);
            } else {
                this._historyIndex++;
            }
            this._refreshButtons();
        }

        _undo() {
            if (this._historyIndex <= 0) return;
            this._historyIndex--;
            this.overrides = this._cloneOverrides(this._history[this._historyIndex]);
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
            this._refreshButtons();
        }

        _redo() {
            if (this._historyIndex >= this._history.length - 1) return;
            this._historyIndex++;
            this.overrides = this._cloneOverrides(this._history[this._historyIndex]);
            this._rebuildProblems();
            this._draw();
            this._drawMinimap();
            this._refreshButtons();
        }

        _refreshButtons() {
            const undoBtn = this.$('[data-action="undo"]');
            const redoBtn = this.$('[data-action="redo"]');
            const saveBtn = this.$('[data-action="save"]');
            if (undoBtn) undoBtn.disabled = this._historyIndex <= 0;
            if (redoBtn) redoBtn.disabled = this._historyIndex >= this._history.length - 1;
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
                this._savedIndex = this._historyIndex;
                this._refreshButtons();
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
