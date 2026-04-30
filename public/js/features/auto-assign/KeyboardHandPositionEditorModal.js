/**
 * @file KeyboardHandPositionEditorModal.js
 * @description Full-length hand-position editor for keyboard-family
 * instruments (semitones mode). Mirrors HandPositionEditorModal (frets)
 * but renders a piano-roll style timeline (X = time, Y = MIDI pitch).
 *
 * Notes are coloured per hand. Clicking a note opens a popover where the
 * operator can reassign it to a different hand id (h1..h4); the override
 * is pushed to `note_assignments` and persisted via the same
 * `routing_save_hand_overrides` command used by the strings editor.
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

    /** Same per-hand colour palette as HandsPreviewPanel. */
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

            this._pxPerSec = 80;
            this._scrollSec = 0;
            this._notePopover = null;
        }

        get isDirty() { return this._historyIndex !== this._savedIndex; }

        renderBody() {
            return `
                <div class="khpe-toolbar" style="display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid #e5e7eb;">
                    <button type="button" data-action="zoom-out" title="${_t('keyboardHandEditor.zoomOut','Dézoom')}">−</button>
                    <button type="button" data-action="zoom-in" title="${_t('keyboardHandEditor.zoomIn','Zoom')}">+</button>
                    <span style="flex:1"></span>
                    <span class="khpe-status" data-role="status" style="color:#6b7280;font-size:12px;"></span>
                    <button type="button" data-action="undo" disabled>↶</button>
                    <button type="button" data-action="redo" disabled>↷</button>
                    <button type="button" data-action="reset-overrides">⟲ ${_t('keyboardHandEditor.reset','Réinitialiser')}</button>
                    <button type="button" data-action="save" disabled>${_t('keyboardHandEditor.save','Enregistrer')}</button>
                </div>
                <div class="khpe-canvas-host" style="position:relative;flex:1;overflow:auto;background:#f9fafb;">
                    <canvas class="khpe-canvas" style="display:block;"></canvas>
                </div>
                <div class="khpe-hint" style="padding:8px;color:#6b7280;font-size:12px;">
                    ${_t('keyboardHandEditor.hint',
                         'Cliquez sur une note pour réaffecter à une main différente. Molette = défilement, Ctrl+molette = zoom.')}
                </div>
            `;
        }

        renderFooter() {
            return `<button type="button" class="btn" data-action="close">${_t('common.close','Fermer')}</button>`;
        }

        onOpen() {
            this.container?.classList.add('khpe-modal-overlay');
            this.canvas = this.$('.khpe-canvas');
            this.host = this.$('.khpe-canvas-host');
            this._wireToolbar();
            this._wireCanvas();
            this._draw();
        }

        onClose() {
            this._closeNotePopover();
            if (this._keyHandler) {
                document.removeEventListener('keydown', this._keyHandler);
                this._keyHandler = null;
            }
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
        //  Drawing — pitch on Y, time on X
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

        _draw() {
            if (!this.canvas) return;
            const dpr = window.devicePixelRatio || 1;
            const ext = this._pitchExtent();
            const pxPerPitch = 8;
            const heightPx = (ext.hi - ext.lo + 1) * pxPerPitch + 30;
            const widthPx = Math.max(800, Math.ceil(this._totalSec * this._pxPerSec) + 60);
            this.canvas.style.width = widthPx + 'px';
            this.canvas.style.height = heightPx + 'px';
            this.canvas.width = widthPx * dpr;
            this.canvas.height = heightPx * dpr;
            const ctx = this.canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, widthPx, heightPx);

            // Pitch grid (octave lines)
            ctx.strokeStyle = '#e5e7eb';
            ctx.lineWidth = 1;
            for (let p = ext.lo; p <= ext.hi; p++) {
                if (p % 12 === 0) {
                    const y = (ext.hi - p) * pxPerPitch + 0.5;
                    ctx.beginPath();
                    ctx.moveTo(0, y);
                    ctx.lineTo(widthPx, y);
                    ctx.stroke();
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '10px sans-serif';
                    ctx.textBaseline = 'top';
                    ctx.fillText(`C${(p / 12) - 1}`, 4, y + 1);
                }
            }

            // Note rectangles (coloured per hand)
            const assignments = this._currentAssignments();
            const noteHits = [];
            for (const n of this.notes) {
                const x = (n.tick / this.ticksPerSec) * this._pxPerSec;
                const w = Math.max(2, ((n.duration || 0) / this.ticksPerSec) * this._pxPerSec);
                const y = (ext.hi - n.note) * pxPerPitch + 1;
                const h = pxPerPitch - 2;
                const handId = assignments.get(`${n.tick}:${n.note}`) || null;
                ctx.fillStyle = handId ? _handColor(handId) : '#9ca3af';
                ctx.fillRect(x, y, w, h);
                ctx.strokeStyle = 'rgba(0,0,0,0.2)';
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                noteHits.push({ x, y, w, h, note: n });
            }
            this._noteHits = noteHits;
        }

        /**
         * Build a Map<"tick:note", handId> using the current
         * `note_assignments` overrides; notes without an explicit
         * assignment get null so they are drawn in grey.
         */
        _currentAssignments() {
            const out = new Map();
            const list = this.overrides?.note_assignments || [];
            for (const a of list) {
                if (a && a.handId) out.set(`${a.tick}:${a.note}`, a.handId);
            }
            return out;
        }

        // ----------------------------------------------------------------
        //  Interaction
        // ----------------------------------------------------------------

        _wireCanvas() {
            this.canvas.addEventListener('click', (e) => {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const hit = this._hitNote(x, y);
                if (!hit) { this._closeNotePopover(); return; }
                this._openNotePopover(hit, e);
            });
            this.host.addEventListener('wheel', (e) => {
                if (e.ctrlKey) {
                    e.preventDefault();
                    const factor = e.deltaY < 0 ? 1.25 : 0.8;
                    this._pxPerSec = Math.max(20, Math.min(800, this._pxPerSec * factor));
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
                + 'z-index:100000;background:#fff;border:1px solid #d1d5db;border-radius:6px;'
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

        _wireToolbar() {
            const root = this.dialog;
            if (!root) return;
            root.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn || btn.disabled) return;
                switch (btn.dataset.action) {
                    case 'close': this.close(); return;
                    case 'zoom-in': this._pxPerSec = Math.min(800, this._pxPerSec * 1.25); this._draw(); return;
                    case 'zoom-out': this._pxPerSec = Math.max(20, this._pxPerSec / 1.25); this._draw(); return;
                    case 'undo': this._undo(); return;
                    case 'redo': this._redo(); return;
                    case 'reset-overrides':
                        this.overrides = { hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1 };
                        this._pushHistory(); this._draw(); return;
                    case 'save': this._save(); return;
                }
            });
        }

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
