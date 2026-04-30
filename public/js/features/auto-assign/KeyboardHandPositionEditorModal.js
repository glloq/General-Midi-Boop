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
            this._pxPerSec = 120;
            // Lookahead window (seconds) shown above the keyboard. We only
            // draw notes whose start time is within `[currentSec, currentSec + lookaheadSec]`.
            this._lookaheadSec = 4;
            this._currentSec = 0;
            this._noteHits = [];
            this._notePopover = null;
            this._mutedBeforePlay = null;
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
                    <span style="flex:1"></span>
                    <span class="khpe-status" data-role="status" style="color:#6b7280;font-size:12px;"></span>
                    <button type="button" data-action="undo" disabled>↶</button>
                    <button type="button" data-action="redo" disabled>↷</button>
                    <button type="button" data-action="reset-overrides">⟲</button>
                    <button type="button" data-action="save" disabled>${_t('keyboardHandEditor.save','Enregistrer')}</button>
                </div>
                <div class="khpe-main" style="display:flex;flex-direction:column;flex:1;min-height:0;">
                    <div class="khpe-roll-host" style="position:relative;flex:1;background:#0f172a;overflow:hidden;">
                        <canvas class="khpe-roll-canvas" style="position:absolute;inset:0;display:block;"></canvas>
                    </div>
                    <div class="khpe-keyboard-host" style="background:#1e293b;padding:6px;height:140px;flex:none;">
                        <canvas class="khpe-keyboard-canvas" style="display:block;width:100%;height:100%;"></canvas>
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
            this._mountKeyboard();
            this._wireToolbar();
            this._wireRollCanvas();
            this._wireResizeObserver();
            // Defer first draw so the layout has settled (clientWidth/Height
            // would otherwise read 0 inside the BaseModal mount handler).
            requestAnimationFrame(() => this._draw());
            this._refreshTransport();
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
                    width: 100vw; height: 100vh;
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
            if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
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
            if (!this.isOpen) { super.close(); return; }
            if (this.isDirty) {
                if (!window.confirm(_t('keyboardHandEditor.confirmDiscard',
                        'Modifications non enregistrées. Quitter sans sauvegarder ?'))) return;
            }
            super.close();
        }

        // ----------------------------------------------------------------
        //  Keyboard widget at the bottom (with draggable hand bands)
        // ----------------------------------------------------------------

        _mountKeyboard() {
            if (!window.KeyboardPreview || !this.keyboardCanvas) return;
            const ext = this._pitchExtent();
            // Per-hand state: anchor (lowest playable note) is the
            // operator-controlled value; span is read from hands_config.
            // Anchors initialise from `hand_anchors` overrides at the
            // current playhead, falling back to a deterministic seed
            // (low pitch, mid pitch, ...) so 1- and 4-hand keyboards
            // both render with non-overlapping bands at startup.
            const cfg = _parseHandsCfg(this.instrument);
            this._hands = (cfg?.hands || []).map((h, i) => {
                const span = Number.isFinite(h.hand_span_semitones) ? h.hand_span_semitones : 14;
                const seedAnchor = ext.lo + Math.round(((i + 0.5) / Math.max(1, cfg.hands.length))
                    * (ext.hi - ext.lo - span));
                const id = h.id || `h${i + 1}`;
                const overrideAnchor = this._latestAnchorOverride(id);
                return {
                    id,
                    span,
                    anchor: Number.isFinite(overrideAnchor) ? overrideAnchor : seedAnchor,
                    color: _handColor(id)
                };
            });
            this.keyboard = new window.KeyboardPreview(this.keyboardCanvas, {
                rangeMin: ext.lo,
                rangeMax: ext.hi,
                bandHeight: 18,
                onBandDrag: (handId, newAnchor) => this._onHandBandDrag(handId, newAnchor)
            });
            this.keyboard.setHandBands(this._currentHandBands());
            // Force one canvas re-fit + draw on the next frame so the
            // KeyboardPreview's geometry cache picks up the actual host
            // size rather than the 0×0 it sees during initial mount.
            requestAnimationFrame(() => {
                this._fitKeyboardCanvas();
                this.keyboard.setHandBands(this._currentHandBands());
                this.keyboard.draw();
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

        _currentHandBands() {
            return (this._hands || []).map(h => ({
                id: h.id, low: h.anchor, high: h.anchor + h.span, color: h.color
            }));
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
         *  playhead, and redraw both the keyboard and the piano-roll. */
        _onHandBandDrag(handId, newAnchor) {
            const hand = (this._hands || []).find(h => h.id === handId);
            if (!hand) return;
            hand.anchor = newAnchor;
            if (!Array.isArray(this.overrides.hand_anchors)) {
                this.overrides.hand_anchors = [];
            }
            const tick = Math.round(this._currentSec * this.ticksPerSec);
            const list = this.overrides.hand_anchors;
            // Replace the entry at the same tick / hand or append.
            const idx = list.findIndex(a => a?.handId === handId && a?.tick === tick);
            const entry = { tick, handId, anchor: newAnchor };
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            this._pushHistory();
            this.keyboard?.setHandBands(this._currentHandBands());
            this._draw();
        }

        // ----------------------------------------------------------------
        //  Roll canvas — vertical piano-roll, notes fall toward the keyboard
        // ----------------------------------------------------------------

        _pitchExtent() {
            if (this.notes.length === 0) return { lo: 21, hi: 108 };
            let lo = 127, hi = 0;
            for (const n of this.notes) {
                if (n.note < lo) lo = n.note;
                if (n.note > hi) hi = n.note;
            }
            return { lo: Math.max(0, lo - 2), hi: Math.min(127, hi + 2) };
        }

        _wireResizeObserver() {
            if (!this.rollHost || typeof ResizeObserver !== 'function') return;
            this._resizeObserver = new ResizeObserver(() => {
                this._draw();
                this._fitKeyboardCanvas();
                this.keyboard?.draw();
            });
            this._resizeObserver.observe(this.rollHost);
            const kbHost = this.$('.khpe-keyboard-host');
            if (kbHost) this._resizeObserver.observe(kbHost);
        }

        _draw() {
            if (!this.rollCanvas || !this.rollHost) return;
            const dpr = window.devicePixelRatio || 1;
            const W = this.rollHost.clientWidth;
            const H = this.rollHost.clientHeight;
            if (W <= 0 || H <= 0) return;

            this.rollCanvas.width = W * dpr;
            this.rollCanvas.height = H * dpr;
            this.rollCanvas.style.width = W + 'px';
            this.rollCanvas.style.height = H + 'px';
            const ctx = this.rollCanvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            const ext = this._pitchExtent();
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
                ctx.fillStyle = handId ? _handColor(handId) : '#94a3b8';
                ctx.fillRect(x, y, w, h);
                ctx.strokeStyle = 'rgba(15,23,42,0.6)';
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
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
            this._draw();
        }

        _clearNoteAssignment(tick, note) {
            const list = this.overrides?.note_assignments;
            if (!Array.isArray(list)) return;
            const idx = list.findIndex(a => a.tick === tick && a.note === note);
            if (idx < 0) return;
            list.splice(idx, 1);
            this._pushHistory();
            this._draw();
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
                        this._draw(); return;
                    case 'zoom-out':
                        this._lookaheadSec = Math.min(30, this._lookaheadSec * 1.25);
                        this._draw(); return;
                    case 'undo': this._undo(); return;
                    case 'redo': this._redo(); return;
                    case 'reset-overrides':
                        this.overrides = { hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1 };
                        this._pushHistory(); this._draw(); return;
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
                    this._currentSec = currentSec || 0;
                    this._draw();
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
            this._refreshTransport();
        }

        _stop() {
            this.audioPreview?.stop();
            this._currentSec = 0;
            this._refreshTransport();
            this._draw();
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
            this._draw();
            this._refreshButtons();
        }

        _redo() {
            if (this._historyIndex >= this._history.length - 1) return;
            this._historyIndex++;
            this.overrides = this._cloneOverrides(this._history[this._historyIndex]);
            this._draw();
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
