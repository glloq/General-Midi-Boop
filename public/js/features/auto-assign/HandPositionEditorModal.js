/**
 * @file HandPositionEditorModal.js
 * @description Full-length tablature & hand-position editor (PR4
 * scaffolding). Extends BaseModal in 'full' size and stitches three
 * widgets together:
 *   - a sticky FretboardHandPreview at the top (live snapshot of the
 *     current playhead — same widget used in HandsPreviewPanel),
 *   - a FretboardTimelineRenderer below it (the whole file scrollable
 *     in time, virtualised),
 *   - a toolbar (zoom in/out, scroll buttons, close).
 *
 * No audio playback yet (PR5) and no per-note edition (PR6); the
 * scaffolding only enables navigation + visualisation. The drag-to-pin
 * already shipped in PR3 stays available on the sticky preview.
 *
 * Public API:
 *   const modal = new HandPositionEditorModal({
 *     fileId, channel, deviceId, midiData, instrument, hands_config,
 *     initialOverrides, apiClient
 *   });
 *   modal.open();
 *   modal.close();
 */
(function() {
    'use strict';

    function _t(key, fallback) {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    function _hands(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { return []; }
        }
        return Array.isArray(cfg?.hands) ? cfg.hands : [];
    }

    /**
     * Walk the parsed MIDI tracks once to extract `[{tick, note,
     * duration, channel}]` for the requested channel. Mirrors
     * `RoutingSummaryPage._getChannelNotesForPreview` so the editor
     * is self-contained and can be opened from anywhere later.
     */
    function _extractChannelNotes(midiData, channel) {
        const out = [];
        const tracks = midiData?.tracks || [];
        for (const track of tracks) {
            let tick = 0;
            const pending = new Map();
            for (const ev of (track.events || track)) {
                tick += ev.deltaTime || 0;
                const evCh = ev.channel ?? 0;
                if (evCh !== channel) continue;
                const noteNumber = ev.note ?? ev.noteNumber;
                if (!Number.isFinite(noteNumber)) continue;
                if (ev.type === 'noteOn' && (ev.velocity ?? 0) > 0) {
                    const idx = out.length;
                    out.push({ tick, note: noteNumber, channel, duration: 0 });
                    pending.set(noteNumber, idx);
                } else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && (ev.velocity ?? 0) === 0)) {
                    if (pending.has(noteNumber)) {
                        const idx = pending.get(noteNumber);
                        out[idx].duration = Math.max(0, tick - out[idx].tick);
                        pending.delete(noteNumber);
                    }
                }
            }
        }
        out.sort((a, b) => a.tick - b.tick);
        return out;
    }

    function _estimateBpm(midiData) {
        const tracks = midiData?.tracks || [];
        for (const track of tracks) {
            for (const ev of (track.events || track)) {
                if (ev.type === 'setTempo' && Number.isFinite(ev.microsecondsPerBeat)) {
                    return 60_000_000 / ev.microsecondsPerBeat;
                }
            }
        }
        return 120;
    }

    class HandPositionEditorModal extends window.BaseModal {
        constructor(opts = {}) {
            super({
                id: 'hand-position-editor',
                size: 'full',
                title: _t('handPositionEditor.title', 'Édition position de main'),
                customClass: 'hpe-modal'
            });

            this.fileId = opts.fileId;
            this.channel = Number.isFinite(opts.channel) ? opts.channel : 0;
            this.deviceId = opts.deviceId;
            this.midiData = opts.midiData || null;
            this.instrument = opts.instrument || null;
            this.handsConfig = opts.hands_config || this.instrument?.hands_config || null;
            this.initialOverrides = opts.initialOverrides || null;
            this.apiClient = opts.apiClient || null;

            this.notes = this.midiData
                ? _extractChannelNotes(this.midiData, this.channel) : [];
            this.ticksPerBeat = this.midiData?.header?.ticksPerBeat
                || this.midiData?.ticksPerBeat || 480;
            this.bpm = _estimateBpm(this.midiData);
            this.ticksPerSec = this.ticksPerBeat * (this.bpm / 60);

            this.engine = null;
            this.sticky = null;       // FretboardHandPreview
            this.timeline = null;     // FretboardTimelineRenderer

            this._totalTicks = this.notes.length
                ? Math.max(...this.notes.map(n => n.tick + (n.duration || 0))) : 0;
            this._totalSec = this._totalTicks / this.ticksPerSec;

            this._tickHandler = null;
            this._chordHandler = null;

            // PR5 — embedded audio preview, follow-the-playhead toggle,
            // history stack for undo/redo, dirty flag for the Save button.
            this.audioPreview = opts.audioPreview || null;
            this._followPlayhead = true;
            this._playState = 'stopped'; // 'stopped' | 'playing' | 'paused'
            this._history = [this._cloneOverrides(this.initialOverrides)];
            this._historyIndex = 0;
            this._dirty = false;
            this._maxHistory = 50;
        }

        renderBody() {
            return `
                <div class="hpe-toolbar">
                    <button type="button" data-action="play"
                            title="${_t('handPositionEditor.play', 'Lecture')}">▶</button>
                    <button type="button" data-action="pause" disabled
                            title="${_t('handPositionEditor.pause', 'Pause')}">⏸</button>
                    <button type="button" data-action="stop" disabled
                            title="${_t('handPositionEditor.stop', 'Stop')}">⏹</button>
                    <span class="hpe-sep"></span>
                    <button type="button" data-action="zoom-out"
                            title="${_t('handPositionEditor.zoomOut', 'Dézoom')}">−</button>
                    <button type="button" data-action="zoom-in"
                            title="${_t('handPositionEditor.zoomIn', 'Zoom')}">+</button>
                    <button type="button" data-action="reset-scroll"
                            title="${_t('handPositionEditor.gotoStart', 'Retour au début')}">⏮</button>
                    <label class="hpe-follow"
                           title="${_t('handPositionEditor.followTitle', 'Suivre le curseur de lecture')}">
                        <input type="checkbox" data-role="follow" checked />
                        ${_t('handPositionEditor.follow', 'Suivre')}
                    </label>
                    <span class="hpe-spacer"></span>
                    <span class="hpe-time" data-role="time">0:00 / 0:00</span>
                    <span class="hpe-sep"></span>
                    <button type="button" data-action="undo" disabled
                            title="${_t('handPositionEditor.undo', 'Annuler (Ctrl+Z)')}">↶</button>
                    <button type="button" data-action="redo" disabled
                            title="${_t('handPositionEditor.redo', 'Rétablir (Ctrl+Y)')}">↷</button>
                    <button type="button" data-action="reset-overrides"
                            title="${_t('handPositionEditor.resetOverrides', 'Tout réinitialiser')}">⟲</button>
                    <button type="button" data-action="save" disabled
                            title="${_t('handPositionEditor.saveClean', 'Aucune modification')}">${_t('handPositionEditor.save', 'Enregistrer')}</button>
                </div>
                <div class="hpe-sticky-host"></div>
                <div class="hpe-timeline-host"></div>
                <div class="hpe-status" data-role="status"></div>
                <div class="hpe-hint">
                    ${_t('handPositionEditor.hint',
                         'Faites défiler la timeline. Glissez la bande de la main sur l’aperçu en haut pour épingler une nouvelle position.')}
                </div>
            `;
        }

        renderFooter() {
            return `
                <button type="button" class="btn" data-action="close">
                    ${_t('common.close', 'Fermer')}
                </button>
            `;
        }

        onOpen() {
            // Inject minimal styles once. Avoids a build-time CSS dep
            // for this PR; later PRs can move this into a stylesheet.
            this._injectStyles();
            this._mountSticky();
            this._mountTimeline();
            this._wireToolbar();
            // Defer the engine build to a second rAF so the modal's
            // shell paints first. simulateHandWindows() inside the
            // engine constructor can take 100-300 ms on dense channels
            // — we don't want that to block the open animation.
            const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
                ? window.requestAnimationFrame.bind(window)
                : (cb) => setTimeout(cb, 16);
            this._setStatus(_t('handPositionEditor.preparing', 'Préparation de la timeline…'));
            raf(() => raf(() => {
                if (!this.isOpen) return; // closed before we got around to it
                try {
                    this._wireEngine();
                    this._setStatus('');
                } catch (e) {
                    console.error('[HandPositionEditor] engine setup failed:', e);
                    this._setStatus(`${_t('handPositionEditor.engineFailed',
                        'Impossible de préparer la simulation')}: ${e.message || e}`, 'err');
                }
            }));
            this._refreshTimeDisplay();
        }

        onClose() {
            if (this._tickHandler && this.engine) this.engine.removeEventListener('tick', this._tickHandler);
            if (this._chordHandler && this.engine) this.engine.removeEventListener('chord', this._chordHandler);
            this._tickHandler = null;
            this._chordHandler = null;
            if (this.engine?.dispose) try { this.engine.dispose(); } catch (_) {}
            this.engine = null;
            if (this.sticky?.destroy) try { this.sticky.destroy(); } catch (_) {}
            this.sticky = null;
            if (this.timeline?.destroy) try { this.timeline.destroy(); } catch (_) {}
            this.timeline = null;
            // Stop any in-flight playback we initiated. The host's
            // AudioPreview instance is shared with the routing summary
            // page, so we never destroy it ourselves — just stop.
            if (this.audioPreview && (this.audioPreview.isPlaying || this.audioPreview.isPreviewing)) {
                try { this.audioPreview.stop(); } catch (_) {}
            }
            if (this._keyHandler) {
                document.removeEventListener('keydown', this._keyHandler);
                this._keyHandler = null;
            }
            this._closeNotePopover();
        }

        // ----------------------------------------------------------------
        //  Mount helpers
        // ----------------------------------------------------------------

        _mountSticky() {
            const host = this.$('.hpe-sticky-host');
            if (!host || !window.FretboardHandPreview) return;
            const canvas = document.createElement('canvas');
            canvas.className = 'hpe-sticky-canvas';
            canvas.style.cssText = 'width:100%;height:170px;display:block;';
            host.appendChild(canvas);

            const handsArr = _hands(this.instrument);
            const fretting = handsArr.find(h => h && h.id === 'fretting') || handsArr[0] || {};
            this.sticky = new window.FretboardHandPreview(canvas, {
                tuning: this.instrument?.tuning || [40, 45, 50, 55, 59, 64],
                numFrets: this.instrument?.num_frets || 24,
                scaleLengthMm: this.instrument?.scale_length_mm,
                handSpanMm: fretting.hand_span_mm,
                handSpanFrets: fretting.hand_span_frets || 4,
                handId: fretting.id || 'fretting',
                onBandDrag: (handId, anchor) => this._onStickyBandDrag(handId, anchor)
            });
            this.sticky.draw && this.sticky.draw();
        }

        _mountTimeline() {
            const host = this.$('.hpe-timeline-host');
            if (!host || !window.FretboardTimelineRenderer) return;
            const canvas = document.createElement('canvas');
            canvas.className = 'hpe-timeline-canvas';
            canvas.style.cssText = 'width:100%;height:100%;display:block;';
            host.appendChild(canvas);

            const handsArr = _hands(this.instrument);
            const fretting = handsArr.find(h => h && h.id === 'fretting') || handsArr[0] || {};
            this.timeline = new window.FretboardTimelineRenderer(canvas, {
                tuning: this.instrument?.tuning || [40, 45, 50, 55, 59, 64],
                numFrets: this.instrument?.num_frets || 24,
                scaleLengthMm: this.instrument?.scale_length_mm,
                handSpanMm: fretting.hand_span_mm,
                handSpanFrets: fretting.hand_span_frets || 4,
                ticksPerSec: this.ticksPerSec,
                totalSec: this._totalSec,
                onSeek: (sec) => this._seekToSec(sec),
                onNoteClick: (hit, evt) => this._openNoteEditPopover(hit, evt)
            });
            this.timeline.draw();
        }

        /**
         * PR6 — open a small popover with the alternative (string,
         * fret) candidates for the clicked note. Picking one pushes a
         * `note_assignments` entry into the overrides and rebuilds the
         * engine so the change is reflected immediately on the manche
         * + the audio simulation.
         */
        _openNoteEditPopover(hit, evt) {
            this._closeNotePopover();
            if (!window.HandPositionFeasibility?.findStringCandidates) return;
            const candidates = window.HandPositionFeasibility
                .findStringCandidates(hit.note, this.instrument);
            if (!candidates.length) return;

            const popover = document.createElement('div');
            popover.className = 'hpe-note-popover';
            const title = _t('handPositionEditor.pickString',
                'Choisir une corde pour cette note :');
            const chipsHtml = candidates.map(c => {
                const isCurrent = c.string === hit.string && c.fret === hit.fret;
                return `<button type="button" class="hpe-chip${isCurrent ? ' hpe-chip-active' : ''}"
                              data-string="${c.string}" data-fret="${c.fret}">
                          ${_t('handPositionEditor.string', 'Corde')} ${c.string} · ${_t('handPositionEditor.fret', 'frette')} ${c.fret}
                      </button>`;
            }).join('');
            popover.innerHTML = `
                <div class="hpe-popover-title">${title}</div>
                <div class="hpe-popover-chips">${chipsHtml}</div>
                <button type="button" class="hpe-popover-clear" data-action="clear">
                    ${_t('handPositionEditor.clearAssignment', 'Réinitialiser ce choix')}
                </button>
            `;
            const x = (evt?.clientX || 0) + 8;
            const y = (evt?.clientY || 0) + 8;
            popover.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:100000;`;
            document.body.appendChild(popover);
            this._notePopover = popover;

            popover.addEventListener('click', (e) => {
                const chip = e.target.closest('.hpe-chip');
                if (chip) {
                    const string = parseInt(chip.dataset.string, 10);
                    const fret = parseInt(chip.dataset.fret, 10);
                    this._pinNoteAssignment(hit.tick, hit.note, string, fret);
                    this._closeNotePopover();
                    return;
                }
                if (e.target.matches('[data-action="clear"]')) {
                    this._clearNoteAssignment(hit.tick, hit.note);
                    this._closeNotePopover();
                }
            });
            // Click anywhere else closes the popover. Defer the listener
            // attach to the next tick so the click that opened the
            // popover doesn't immediately close it.
            setTimeout(() => {
                this._popoverDismissHandler = (e) => {
                    if (!this._notePopover) return;
                    if (this._notePopover.contains(e.target)) return;
                    this._closeNotePopover();
                };
                document.addEventListener('mousedown', this._popoverDismissHandler);
            }, 0);
        }

        _closeNotePopover() {
            if (this._popoverDismissHandler) {
                document.removeEventListener('mousedown', this._popoverDismissHandler);
                this._popoverDismissHandler = null;
            }
            if (this._notePopover) {
                this._notePopover.remove();
                this._notePopover = null;
            }
        }

        _pinNoteAssignment(tick, note, string, fret) {
            this.initialOverrides = this.initialOverrides
                || { hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1 };
            if (!Array.isArray(this.initialOverrides.note_assignments)) {
                this.initialOverrides.note_assignments = [];
            }
            const list = this.initialOverrides.note_assignments;
            const idx = list.findIndex(a => a.tick === tick && a.note === note);
            const entry = { tick, note, string, fret };
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            this._pushHistory();
            this._rebuildEngineKeepingPlayhead();
        }

        _clearNoteAssignment(tick, note) {
            const list = this.initialOverrides?.note_assignments;
            if (!Array.isArray(list)) return;
            const idx = list.findIndex(a => a.tick === tick && a.note === note);
            if (idx < 0) return;
            list.splice(idx, 1);
            this._pushHistory();
            this._rebuildEngineKeepingPlayhead();
        }

        _wireToolbar() {
            const root = this.dialog;
            if (!root) return;
            root.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn || btn.disabled) return;
                const action = btn.dataset.action;
                switch (action) {
                    case 'close': this.close(); return;
                    case 'zoom-in':
                        this.timeline?.setPxPerSec(this.timeline.pxPerSec * 1.25);
                        return;
                    case 'zoom-out':
                        this.timeline?.setPxPerSec(this.timeline.pxPerSec / 1.25);
                        return;
                    case 'reset-scroll':
                        this.timeline?.setScrollSec(0);
                        this._seekToSec(0);
                        return;
                    case 'play': this._play(); return;
                    case 'pause': this._pause(); return;
                    case 'stop': this._stop(); return;
                    case 'undo': this._undo(); return;
                    case 'redo': this._redo(); return;
                    case 'reset-overrides': this._resetOverrides(); return;
                    case 'save': this._save(); return;
                }
            });
            // Follow toggle.
            root.addEventListener('change', (e) => {
                if (e.target?.dataset?.role === 'follow') {
                    this._followPlayhead = !!e.target.checked;
                }
            });
            // Keyboard shortcuts. Bound on document so the modal's focus
            // trap can keep doing its job — we only react when the
            // editor is open AND the focused element isn't a text input
            // (so typing in a future search box doesn't fire shortcuts).
            this._keyHandler = (e) => {
                if (!this.isOpen) return;
                const tag = (e.target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                if (e.key === ' ') {
                    e.preventDefault();
                    this._playState === 'playing' ? this._pause() : this._play();
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    this._undo();
                } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
                    e.preventDefault();
                    this._redo();
                } else if (e.key === '+') {
                    this.timeline?.setPxPerSec(this.timeline.pxPerSec * 1.25);
                } else if (e.key === '-') {
                    this.timeline?.setPxPerSec(this.timeline.pxPerSec / 1.25);
                } else if (e.key === 'Home') {
                    this._seekToSec(0);
                    this.timeline?.setScrollSec(0);
                } else if (e.key === 'End') {
                    this._seekToSec(this._totalSec);
                }
            };
            document.addEventListener('keydown', this._keyHandler);
        }

        // ----------------------------------------------------------------
        //  Audio preview wiring
        // ----------------------------------------------------------------

        async _play() {
            if (!this.audioPreview || !window.AudioPreview) {
                this._setStatus(_t('handPositionEditor.noAudio',
                    'Aperçu audio indisponible.'));
                return;
            }
            if (!this.midiData) return;
            try {
                this._setStatus('');
                this.audioPreview.onProgress = (currentTick, totalTicks, currentSec) => {
                    this._onAudioProgress(currentSec);
                };
                this.audioPreview.onPlaybackEnd = () => this._onAudioEnd();
                const startSec = this.engine?.currentSec ? this.engine.currentSec() : 0;
                await this.audioPreview.previewSingleChannel(
                    this.midiData,
                    this.channel,
                    {},               // transposition — preview as authored
                    {},               // instrument constraints — open
                    startSec,
                    0,                // duration ignored when fullFile=true
                    true              // fullFile
                );
                this._playState = 'playing';
                this._refreshTransport();
            } catch (err) {
                console.error('[HandPositionEditor] play failed:', err);
                this._setStatus(`${_t('handPositionEditor.playFailed', 'Lecture impossible')}: ${err.message || err}`);
            }
        }

        _pause() {
            if (!this.audioPreview) return;
            try { this.audioPreview.pause(); } catch (_) {}
            this._playState = 'paused';
            this._refreshTransport();
        }

        _stop() {
            if (!this.audioPreview) return;
            try { this.audioPreview.stop(); } catch (_) {}
            this._playState = 'stopped';
            this._refreshTransport();
        }

        _onAudioProgress(currentSec) {
            if (this.engine?.advanceToSec) this.engine.advanceToSec(currentSec);
            // The engine emits a 'tick' event which is already wired to
            // the sticky preview + timeline playhead update in PR4.
            this._maybeFollowPlayhead(currentSec);
        }

        _onAudioEnd() {
            this._playState = 'stopped';
            this._refreshTransport();
        }

        _maybeFollowPlayhead(currentSec) {
            if (!this._followPlayhead || !this.timeline) return;
            const viewportSec = this.timeline._viewportSec();
            const top = this.timeline.scrollSec;
            const bot = top + viewportSec;
            // Re-center when the playhead leaves the comfortable middle
            // band ([20%, 80%] of the viewport) — avoids twitchy resets
            // for tiny sub-pixel updates.
            if (currentSec < top + viewportSec * 0.2 || currentSec > top + viewportSec * 0.8) {
                this.timeline.setScrollSec(currentSec - viewportSec * 0.4);
            }
        }

        _refreshTransport() {
            const playBtn = this.$('[data-action="play"]');
            const pauseBtn = this.$('[data-action="pause"]');
            const stopBtn = this.$('[data-action="stop"]');
            const playing = this._playState === 'playing';
            const paused = this._playState === 'paused';
            if (playBtn) playBtn.disabled = playing;
            if (pauseBtn) pauseBtn.disabled = !playing;
            if (stopBtn) stopBtn.disabled = !(playing || paused);
        }

        // ----------------------------------------------------------------
        //  History (undo / redo) + save
        // ----------------------------------------------------------------

        _cloneOverrides(o) {
            if (!o) return null;
            try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; }
        }

        _pushHistory() {
            // Drop any redo branch beyond the current index, append the
            // new snapshot, cap the stack at _maxHistory.
            this._history = this._history.slice(0, this._historyIndex + 1);
            this._history.push(this._cloneOverrides(this.initialOverrides));
            if (this._history.length > this._maxHistory) {
                this._history.shift();
            } else {
                this._historyIndex++;
            }
            this._dirty = true;
            this._refreshHistoryButtons();
        }

        _undo() {
            if (this._historyIndex <= 0) return;
            this._historyIndex--;
            this.initialOverrides = this._cloneOverrides(this._history[this._historyIndex]);
            this._dirty = this._historyIndex !== 0;
            this._rebuildEngineKeepingPlayhead();
            this._refreshHistoryButtons();
        }

        _redo() {
            if (this._historyIndex >= this._history.length - 1) return;
            this._historyIndex++;
            this.initialOverrides = this._cloneOverrides(this._history[this._historyIndex]);
            this._dirty = this._historyIndex !== 0;
            this._rebuildEngineKeepingPlayhead();
            this._refreshHistoryButtons();
        }

        _resetOverrides() {
            // Clear all overrides + push a snapshot so the operator can
            // undo back to whatever they had before. No confirmation
            // dialog yet — that's a polish item for PR7.
            this.initialOverrides = { hand_anchors: [], disabled_notes: [], version: 1 };
            this._pushHistory();
            this._rebuildEngineKeepingPlayhead();
        }

        async _save() {
            const apiClient = this.apiClient;
            if (!apiClient || typeof apiClient.sendCommand !== 'function') {
                this._setStatus(_t('handPositionEditor.noBackend',
                    'Sauvegarde impossible : API non câblée.'));
                return;
            }
            if (this.fileId == null || this.deviceId == null) {
                this._setStatus(_t('handPositionEditor.missingCtx',
                    'Sauvegarde impossible : contexte de routage manquant.'));
                return;
            }
            try {
                await apiClient.sendCommand('routing_save_hand_overrides', {
                    fileId: this.fileId,
                    channel: this.channel,
                    deviceId: this.deviceId,
                    overrides: this.initialOverrides
                });
                this._dirty = false;
                this._refreshHistoryButtons();
                this._setStatus(_t('handPositionEditor.saved', 'Modifications enregistrées.'), 'ok');
            } catch (err) {
                console.error('[HandPositionEditor] save failed:', err);
                this._setStatus(`${_t('handPositionEditor.saveFailed', 'Sauvegarde échouée')}: ${err.message || err}`, 'err');
            }
        }

        _refreshHistoryButtons() {
            const undoBtn = this.$('[data-action="undo"]');
            const redoBtn = this.$('[data-action="redo"]');
            const saveBtn = this.$('[data-action="save"]');
            if (undoBtn) undoBtn.disabled = this._historyIndex <= 0;
            if (redoBtn) redoBtn.disabled = this._historyIndex >= this._history.length - 1;
            if (saveBtn) {
                saveBtn.disabled = !this._dirty;
                saveBtn.title = this._dirty
                    ? _t('handPositionEditor.saveDirty', 'Modifications non enregistrées')
                    : _t('handPositionEditor.saveClean', 'Aucune modification');
            }
        }

        _setStatus(msg, level = '') {
            const el = this.$('[data-role="status"]');
            if (!el) return;
            el.textContent = msg || '';
            el.dataset.level = level;
        }

        _rebuildEngineKeepingPlayhead() {
            if (!this.engine) return;
            const sec = this.engine.currentSec ? this.engine.currentSec() : 0;
            try { this.engine.dispose(); } catch (_) {}
            if (this._tickHandler) this.engine?.removeEventListener?.('tick', this._tickHandler);
            if (this._chordHandler) this.engine?.removeEventListener?.('chord', this._chordHandler);
            this.engine = null;
            this._wireEngine();
            if (this.engine?.advanceToSec) this.engine.advanceToSec(sec);
        }

        _wireEngine() {
            if (!window.HandSimulationEngine) return;
            this.engine = new window.HandSimulationEngine({
                notes: this.notes,
                instrument: this.instrument,
                ticksPerBeat: this.ticksPerBeat,
                bpm: this.bpm,
                overrides: this.initialOverrides
            });

            // Push the precomputed timeline + trajectory into the
            // timeline renderer so it can virtualise its draw.
            this.timeline?.setTimeline(this.engine._timeline || []);
            const trajectories = this.engine.getHandTrajectories
                ? this.engine.getHandTrajectories() : new Map();
            const handsArr = _hands(this.instrument);
            const fretting = handsArr.find(h => h && h.id === 'fretting') || handsArr[0];
            const traj = (fretting && trajectories.get && trajectories.get(fretting.id)) || [];
            this.timeline?.setTrajectory(traj);
            // Push the same trajectory into the sticky aperçu so its
            // band animates with the playhead just like the existing
            // HandsPreviewPanel does.
            if (this.sticky?.setTicksPerSec) this.sticky.setTicksPerSec(this.ticksPerSec);
            if (this.sticky?.setHandTrajectory) this.sticky.setHandTrajectory(traj);

            this._chordHandler = (e) => {
                const detail = e.detail || {};
                if (this.sticky?.setActivePositions) {
                    this.sticky.setActivePositions((detail.notes || [])
                        .filter(n => Number.isFinite(n.fret) && Number.isFinite(n.string))
                        .map(n => ({ string: n.string, fret: n.fret, velocity: n.velocity || 100 })));
                }
                if (this.sticky?.setUnplayablePositions) {
                    this.sticky.setUnplayablePositions((detail.unplayable || [])
                        .filter(u => Number.isFinite(u.string) && Number.isFinite(u.fret)));
                }
                if (this.sticky?.setLevel) {
                    const infeasible = (detail.unplayable || []).some(u =>
                        u.reason === 'too_many_fingers' || u.reason === 'outside_window');
                    this.sticky.setLevel(infeasible ? 'infeasible' : 'ok');
                }
            };
            this._tickHandler = (e) => {
                const detail = e.detail || {};
                if (this.sticky?.setCurrentTime) this.sticky.setCurrentTime(detail.currentSec);
                if (this.timeline?.setPlayhead) this.timeline.setPlayhead(detail.currentSec);
                this._refreshTimeDisplay(detail.currentSec);
            };
            this.engine.addEventListener('chord', this._chordHandler);
            this.engine.addEventListener('tick', this._tickHandler);
            // Force a tick at 0 so the sticky paints initial state.
            if (this.engine.advanceToSec) this.engine.advanceToSec(0);
        }

        _onStickyBandDrag(handId, anchor) {
            // Persist via the same path HandsPreviewPanel.pinHandAnchor
            // uses: append a {tick, handId, anchor} entry at the current
            // playhead and rebuild the engine so the trajectory follows.
            if (!this.engine) return;
            this.initialOverrides = this.initialOverrides
                || { hand_anchors: [], disabled_notes: [], version: 1 };
            if (!Array.isArray(this.initialOverrides.hand_anchors)) {
                this.initialOverrides.hand_anchors = [];
            }
            const tick = Math.round(this.engine.currentTick ? this.engine.currentTick() : 0);
            const idx = this.initialOverrides.hand_anchors.findIndex(
                a => a.tick === tick && a.handId === handId);
            const entry = { tick, handId, anchor };
            if (idx >= 0) this.initialOverrides.hand_anchors[idx] = entry;
            else this.initialOverrides.hand_anchors.push(entry);
            // Push history snapshot so the operator can undo this pin
            // (PR5). The mutation already happened above; the snapshot
            // captures the post-mutation state.
            this._pushHistory();
            this._rebuildEngineKeepingPlayhead();
        }

        _seekToSec(sec) {
            if (this.engine?.advanceToSec) this.engine.advanceToSec(sec);
            this.timeline?.setPlayhead(sec);
        }

        _refreshTimeDisplay(currentSec = 0) {
            const el = this.$('[data-role="time"]');
            if (!el) return;
            const fmt = (s) => {
                const v = Math.max(0, s || 0);
                const m = Math.floor(v / 60);
                const r = Math.floor(v - m * 60);
                return `${m}:${String(r).padStart(2, '0')}`;
            };
            el.textContent = `${fmt(currentSec)} / ${fmt(this._totalSec)}`;
        }

        _injectStyles() {
            if (document.getElementById('hpe-modal-styles')) return;
            const style = document.createElement('style');
            style.id = 'hpe-modal-styles';
            style.textContent = `
                .hpe-modal .modal-dialog {
                    width: 100vw; height: 100vh;
                    display: flex; flex-direction: column;
                    background: #fff;
                }
                .hpe-modal .modal-body {
                    flex: 1; display: flex; flex-direction: column;
                    overflow: hidden;
                }
                .hpe-toolbar {
                    display: flex; align-items: center;
                    gap: 8px; padding: 6px 10px;
                    border-bottom: 1px solid #e5e7eb;
                    background: #f9fafb;
                }
                .hpe-toolbar button[data-action] {
                    padding: 4px 10px; border: 1px solid #d1d5db;
                    background: #fff; border-radius: 4px; cursor: pointer;
                    font-size: 14px;
                }
                .hpe-toolbar button[data-action]:hover:not([disabled]) { background: #f3f4f6; }
                .hpe-toolbar button[data-action][disabled] {
                    opacity: 0.45; cursor: not-allowed;
                }
                .hpe-spacer { flex: 1; }
                .hpe-sep { width: 1px; height: 18px; background: #d1d5db; margin: 0 4px; }
                .hpe-follow {
                    display: inline-flex; align-items: center; gap: 4px;
                    font-size: 12px; color: #374151; cursor: pointer;
                }
                .hpe-time { font-variant-numeric: tabular-nums; color: #374151; font-size: 12px; }
                .hpe-status {
                    padding: 4px 10px; font-size: 12px;
                    color: #374151; min-height: 20px;
                    border-top: 1px solid #e5e7eb; background: #fff;
                }
                .hpe-status[data-level="ok"] { color: #047857; }
                .hpe-status[data-level="err"] { color: #b91c1c; }
                .hpe-note-popover {
                    background: #fff; border: 1px solid #d1d5db;
                    border-radius: 6px; padding: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    font-size: 12px; max-width: 240px;
                }
                .hpe-popover-title { color: #374151; margin-bottom: 6px; }
                .hpe-popover-chips {
                    display: flex; flex-wrap: wrap; gap: 4px;
                    margin-bottom: 6px;
                }
                .hpe-chip {
                    border: 1px solid #d1d5db; background: #f9fafb;
                    border-radius: 4px; padding: 3px 8px; cursor: pointer;
                    font-size: 11px;
                }
                .hpe-chip:hover { background: #e5e7eb; }
                .hpe-chip.hpe-chip-active {
                    background: #2563eb; color: #fff; border-color: #2563eb;
                }
                .hpe-popover-clear {
                    border: none; background: transparent;
                    color: #6b7280; font-size: 11px; cursor: pointer;
                    text-decoration: underline; padding: 0;
                }
                .hpe-popover-clear:hover { color: #b91c1c; }
                .hpe-sticky-host {
                    border-bottom: 1px solid #e5e7eb;
                    background: #f5f7fb;
                }
                .hpe-timeline-host {
                    flex: 1; min-height: 240px;
                    overflow: hidden; background: #f5f7fb;
                }
                .hpe-hint {
                    padding: 6px 10px; font-size: 11px; color: #6b7280;
                    border-top: 1px solid #e5e7eb; background: #f9fafb;
                }
            `;
            document.head.appendChild(style);
        }
    }

    if (typeof window !== 'undefined') {
        window.HandPositionEditorModal = HandPositionEditorModal;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HandPositionEditorModal;
    }
})();
