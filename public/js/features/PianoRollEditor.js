/**
 * PianoRollEditor — Reusable piano roll editor component.
 *
 * Encapsulates: the webaudio-pianoroll element, the minimap canvas, and the
 * editing toolbar (Mode / History / Edit / Grid / View groups).
 *
 * Consumers (LoopEditorModal, MidiEditorModal) instantiate this and use it as
 * an opaque editor. They keep ownership of meta state (loop name, tempo,
 * transport, output picker, keyboard panel, …).
 *
 * Public API:
 *   const ed = new PianoRollEditor(hostEl, {
 *       t,                            // i18n (key, params) => string
 *       initial: { sequence, ppq, tempo, bars, timeSigNum, timeSigDen,
 *                  noteMin, noteMax },
 *       showGroups: { mode, history, edit, grid, view },  // default all true
 *       multiChannel: false,
 *       actions: { undo, redo, copy, paste, selectAll,
 *                  deleteSelected, clearNotes,
 *                  quantizeSelection, applyVelocity },
 *       onSequenceChange,             // (seq) => void
 *       onPlayheadMove,               // (tick) => void
 *       getStatusEl                   // () => HTMLElement|null
 *   });
 *   ed.mount();
 *   ed.getSequence(); ed.setSequence(seq); ed.addNote(noteObj);
 *   ed.setRange({ tempo, bars, ppq, timeSigNum, timeSigDen, noteMin, noteMax });
 *   ed.setCursor(tick);
 *   ed.applyTheme(isDark);
 *   ed.setRecordingPlayhead(tickOrNull);  // null to clear
 *   ed.getPianoRollElement();
 *   ed.destroy();
 */
class PianoRollEditor {
    constructor(host, opts = {}) {
        this.host = host;
        this.t = opts.t || ((k) => k);
        this.showGroups = Object.assign(
            { mode: true, history: true, edit: true, grid: true, view: true },
            opts.showGroups || {}
        );
        this.multiChannel = !!opts.multiChannel;
        // When true: only render the editing toolbar (no piano-roll element,
        // no minimap). Every action MUST be provided via `opts.actions` —
        // useful to skin a host editor (e.g. MidiEditorModal) with the same
        // visual toolbar while keeping its own pianoroll plumbing untouched.
        this.toolbarOnly = !!opts.toolbarOnly;
        this.actions = opts.actions || null;
        // Optional: a <canvas> element living OUTSIDE the host (e.g. at the
        // top of the consumer modal) used as the minimap surface. When
        // provided, the editor does not render its own minimap canvas in
        // the shell and uses this one instead.
        this.externalMinimapEl = opts.externalMinimapEl || null;
        // When true, the minimap is purely informative — no scrub on click,
        // no keyboard navigation, no cursor that suggests interactivity.
        this.minimapReadOnly = !!opts.minimapReadOnly;
        this.onSequenceChange = opts.onSequenceChange || null;
        this.onPlayheadMove   = opts.onPlayheadMove   || null;
        this.getStatusEl      = opts.getStatusEl      || (() => null);

        const init = opts.initial || {};
        this.ppq         = init.ppq         ?? 480;
        this.tempo       = init.tempo       ?? 120;
        this.bars        = init.bars        ?? 2;
        this.timeSigNum  = init.timeSigNum  ?? 4;
        this.timeSigDen  = init.timeSigDen  ?? 4;
        this.noteMin     = init.noteMin     ?? 36;
        this.noteMax     = init.noteMax     ?? 84;
        this._sequence   = Array.isArray(init.sequence) ? init.sequence.slice() : [];

        this.pianoRoll = null;
        this._minimap  = null;
        this._minimapObserver = null;
        this._clipboard = [];
        this._recordingPlayheadTick = null;
        this._isRecording = false;
        this._wired = false;
    }

    // =====================================================================
    // LIFECYCLE
    // =====================================================================

    mount() {
        if (!this.host) return;
        this.host.classList.add('pre-host');
        if (this.toolbarOnly) {
            this.host.classList.add('pre-host--toolbar-only');
            this.host.innerHTML = `<div class="pre-toolbar">${this._renderToolbarGroups()}</div>`;
        } else {
            this.host.innerHTML = this._renderShell();
            this._initPianoRoll();
            this._initMinimap();
            this._attachResizeObserver();
        }
        this._attachEvents();
    }

    _attachResizeObserver() {
        const wrap = this.host?.querySelector('#pre-pianoroll-wrap');
        if (!wrap || typeof ResizeObserver === 'undefined') return;
        let pendingW = 0, pendingH = 0;
        this._resizeObserver = new ResizeObserver(() => {
            if (!this.renderer?.isMounted()) return;
            const w = wrap.clientWidth  | 0;
            const h = wrap.clientHeight | 0;
            // Skip 0×0 (host hidden via display:none)
            if (!w || !h) return;
            // Skip no-op updates to avoid an infinite redraw loop
            if (w === pendingW && h === pendingH) return;
            pendingW = w; pendingH = h;
            this.renderer?.setSize(w, h);
            this.renderer?.redraw();
            this._syncMinimap();
        });
        this._resizeObserver.observe(wrap);
    }

    _renderToolbarGroups() {
        const sg = this.showGroups;
        return `
            ${sg.mode    ? this._renderGroupMode()    : ''}
            ${sg.history ? this._renderGroupHistory() : ''}
            ${sg.edit    ? this._renderGroupEdit()    : ''}
            ${sg.grid    ? this._renderGroupGrid()    : ''}
            <span class="lc-ctrl-spacer"></span>
            ${sg.view    ? this._renderGroupView()    : ''}
        `;
    }

    destroy() {
        if (this._minimapObserver) { this._minimapObserver.disconnect(); this._minimapObserver = null; }
        if (this._resizeObserver)  { this._resizeObserver.disconnect();  this._resizeObserver  = null; }
        if (this._viewportListener && this.renderer) {
            this.renderer.off('viewportchange', this._viewportListener);
            this._viewportListener = null;
        }
        this._minimap?.destroy?.();
        this._minimap  = null;
        if (this.renderer) {
            try { this.renderer.destroy(); } catch (_) { /* best-effort */ }
            this.renderer = null;
        }
        this.pianoRoll = null;
        if (this.host) {
            if (this._onClickBound)  this.host.removeEventListener('click',  this._onClickBound);
            if (this._onChangeBound) this.host.removeEventListener('change', this._onChangeBound);
            this._onClickBound = null;
            this._onChangeBound = null;
            this.host.classList.remove('pre-host');
            this.host.classList.remove('pre-host--toolbar-only');
            this.host.innerHTML = '';
        }
        this._wired = false;
    }

    // =====================================================================
    // PUBLIC ACCESSORS
    // =====================================================================

    getSequence() {
        return Array.isArray(this.renderer?.getSequence()) ? this.renderer?.getSequence() ?? [] : this._sequence;
    }

    setSequence(seq) {
        const next = Array.isArray(seq) ? seq.slice() : [];
        this._sequence = next;
        if (this.renderer?.isMounted()) {
            this.renderer?.setSequence(next);
            this.renderer?.redraw();
        }
        this._syncMinimap();
        this._emitChange();
    }

    addNote(noteObj) {
        if (!noteObj) return;
        const cur = this.getSequence();
        const next = Array.isArray(cur) ? [...cur, noteObj] : [noteObj];
        if (this.renderer?.isMounted()) {
            this.renderer?.setSequence(next);
            this.renderer?.redraw();
        }
        this._sequence = next;
        this._syncMinimap();
        this._emitChange();
    }

    setRange({ tempo, bars, ppq, timeSigNum, timeSigDen, noteMin, noteMax } = {}) {
        if (tempo       != null) this.tempo       = tempo;
        if (bars        != null) this.bars        = bars;
        if (ppq         != null) this.ppq         = ppq;
        if (timeSigNum  != null) this.timeSigNum  = timeSigNum;
        if (timeSigDen  != null) this.timeSigDen  = timeSigDen;
        if (noteMin     != null) this.noteMin     = noteMin;
        if (noteMax     != null) this.noteMax     = noteMax;
        this._refreshRange();
    }

    setCursor(tick) {
        if (!this.renderer?.isMounted()) return;
        this.renderer?.setCursor(Math.max(0, Math.min(this._totalTicks(), tick | 0)));
        this.renderer?.redrawMarker();
        this._syncMinimap();
    }

    setRecordingPlayhead(tickOrNull) {
        this._isRecording = tickOrNull != null;
        this._recordingPlayheadTick = tickOrNull;
        this._syncMinimap();
    }

    applyTheme(isDark) {
        const dark = (isDark == null) ? document.body.classList.contains('theme-dark') : !!isDark;
        if (!this.renderer?.isMounted()) return;
        this.renderer.setThemeColors(dark ? {
            colnote:     '#5b9bd5',
            colnotesel:  '#f5a623',
            colbg:       '#1a1a2e',
            colline:     '#333355',
            colrulerbg:  '#12122a',
            colrulerfg:  '#8888aa',
            colkeybg:    '#1e1e38',
            colkeyfg:    '#ccccee',
            colkeyblack: '#0d0d1a'
        } : {
            colnote:     '#4a90d9',
            colnotesel:  '#e8931a',
            colbg:       '#f8f9fa',
            colline:     '#dde0e6',
            colrulerbg:  '#eef0f4',
            colrulerfg:  '#666677',
            colkeybg:    '#f0f0f4',
            colkeyfg:    '#333344',
            colkeyblack: '#303040'
        });
        this.renderer?.redraw();
    }

    getPianoRollElement() { return this.pianoRoll; }

    /**
     * Recompute width/height from the current wrap size and redraw. Call this
     * after the host becomes visible (e.g. after a tab switch).
     */
    refit() {
        if (!this.renderer?.isMounted()) return;
        const wrap = this.host?.querySelector('#pre-pianoroll-wrap');
        if (!wrap) return;
        const w = wrap.clientWidth  || 900;
        const h = wrap.clientHeight || 200;
        this.renderer?.setSize(w, h);
        this.renderer?.redraw();
        this._syncMinimap();
    }

    // =====================================================================
    // PUBLIC ACTIONS — can be overridden via opts.actions
    // =====================================================================

    setMode(mode) {
        // Always update the aria-pressed state on the toolbar buttons so the
        // active mode is reflected visually, regardless of who owns the
        // underlying pianoroll.
        this._setAriaPressed('[data-pre-action="mode-view"]',   mode === 'view');
        this._setAriaPressed('[data-pre-action="mode-select"]', mode === 'select');
        this._setAriaPressed('[data-pre-action="mode-draw"]',   mode === 'dragpoly');
        if (this.actions?.setMode) return this.actions.setMode(mode);
        if (!this.renderer?.isMounted()) return;
        const prMode = mode === 'view' ? 'select' : mode;
        this.renderer?.setEditMode();
    }

    undo() {
        if (this.actions?.undo) return this.actions.undo();
        this.renderer?.undo();
        this._emitChange();
    }

    redo() {
        if (this.actions?.redo) return this.actions.redo();
        this.renderer?.redo();
        this._emitChange();
    }

    selectAll() {
        if (this.actions?.selectAll) return this.actions.selectAll();
        if (!this.renderer?.isMounted()) return;
        const seq = Array.isArray(this.renderer?.getSequence()) ? this.renderer?.getSequence() ?? [] : [];
        seq.forEach(n => { n.f = 1; });
        this.renderer?.setSequence(seq);
        this.renderer?.redraw();
    }

    copy() {
        if (this.actions?.copy) return this.actions.copy();
        if (!this.renderer?.isMounted()) return;
        if (true) {
            this._clipboard = this.renderer?.copySelection() ?? [];
        } else {
            this._clipboard = (this.renderer?.getSequence() ?? []).filter(n => n.f).map(n => ({ ...n }));
        }
        this._setStatus(this.t('loopEditor.notesCopied', { count: this._clipboard.length }));
    }

    paste() {
        if (this.actions?.paste) return this.actions.paste();
        if (!this.renderer?.isMounted() || !this._clipboard.length) return;
        const cursor = this.renderer?.getCursor() ?? 0;
        if (true) {
            this.renderer?.pasteNotes(this._clipboard, cursor);
        } else {
            const minT = Math.min(...this._clipboard.map(n => n.t));
            const pasted = this._clipboard.map(n => ({ ...n, t: n.t - minT + cursor }));
            this.renderer?.setSequence([...(this.renderer?.getSequence() ?? []), ...pasted]);
        }
        this.renderer?.redraw();
        this._syncMinimap();
        this._emitChange();
    }

    deleteSelected() {
        if (this.actions?.deleteSelected) return this.actions.deleteSelected();
        if (!this.renderer?.isMounted()) return;
        this.renderer?.setSequence((this.renderer?.getSequence() ?? []).filter(n => !n.f));
        this.renderer?.redraw();
        this._syncMinimap();
        this._emitChange();
    }

    clearNotes() {
        if (this.actions?.clearNotes) return this.actions.clearNotes();
        if (this.renderer?.isMounted()) { this.renderer?.setSequence([]); this.renderer?.redraw(); }
        this._sequence = [];
        this._syncMinimap();
        this._emitChange();
    }

    quantizeSelection() {
        if (this.actions?.quantizeSelection) return this.actions.quantizeSelection();
        if (!this.renderer?.isMounted()) return;
        const q = parseInt(this._fieldVal('pre-quantize') ?? 0);
        if (!q || q <= 0) {
            this._setStatus(this.t('loopEditor.quantizeNoGrid'));
            return;
        }
        const seq = Array.isArray(this.renderer?.getSequence()) ? [...this.renderer?.getSequence() ?? []] : [];
        const selected = seq.filter(n => n.f);
        const target = selected.length ? selected : seq;
        let count = 0;
        for (const note of target) {
            const before = note.t;
            note.t = Math.round(note.t / q) * q;
            note.g = Math.max(q, Math.round((note.g || note.l || 120) / q) * q);
            if (note.t !== before) count++;
        }
        this.renderer?.setSequence(seq);
        this.renderer?.redraw();
        this._syncMinimap();
        this._setStatus(this.t('loopEditor.quantizedNotes', { count }));
        this._emitChange();
    }

    applyVelocityToSelection() {
        if (this.actions?.applyVelocity) return this.actions.applyVelocity();
        if (!this.renderer?.isMounted()) return;
        const raw = parseInt(this._fieldVal('pre-velocity') ?? 100);
        const v = Math.max(1, Math.min(127, isNaN(raw) ? 100 : raw));
        const seq = Array.isArray(this.renderer?.getSequence()) ? [...this.renderer?.getSequence() ?? []] : [];
        const selected = seq.filter(n => n.f);
        const target = selected.length ? selected : seq;
        if (!target.length) {
            this._setStatus(this.t('loopEditor.velocityNoNotes'));
            return;
        }
        for (const note of target) note.v = v;
        this.renderer?.setSequence(seq);
        this.renderer?.redraw();
        this._syncMinimap();
        this._setStatus(this.t('loopEditor.velocityApplied', { count: target.length, velocity: v }));
        this._emitChange();
    }

    zoomH(factor) {
        if (this.actions?.zoomH) return this.actions.zoomH(factor);
        if (!this.renderer?.isMounted()) return;
        const total = this._totalTicks();
        const cur   = parseFloat(this.renderer?.getXRange() ?? total);
        const next  = Math.max(Math.ceil(total / 32), Math.min(total, Math.round(cur * factor)));
        this.renderer?.setXRange(next);
        this.renderer?.redraw();
        this._syncMinimap();
    }

    zoomV(factor) {
        if (this.actions?.zoomV) return this.actions.zoomV(factor);
        if (!this.renderer?.isMounted()) return;
        const cur  = parseFloat(this.renderer?.getYRange() ?? 36);
        const next = Math.max(6, Math.min(128, Math.round(cur * factor)));
        this.renderer?.setYRange(next);
        this.renderer?.redraw();
    }

    // =====================================================================
    // INTERNAL — RENDER
    // =====================================================================

    _renderShell() {
        const minimapHtml = this.externalMinimapEl ? '' : `
        <canvas class="lc-minimap" id="pre-minimap"
                role="slider" tabindex="0"
                aria-label="${this.t('loopEditor.minimapAria')}"></canvas>`;
        return `
        <div class="pre-toolbar">${this._renderToolbarGroups()}</div>
        <div class="lc-pianoroll-area" id="pre-pianoroll-area">
            <div class="lc-pianoroll-wrap" id="pre-pianoroll-wrap"></div>
        </div>
        ${minimapHtml}
        `;
    }

    _renderGroupMode() {
        return `
        <div class="le-group le-group-mode">
            <span class="le-group-label">${this.t('loopEditor.groupMode')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-view"   title="${this.t('loopCreator.modeView')} (V)"   aria-pressed="false">👁</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-select" title="${this.t('loopCreator.modeSelect')} (S)" aria-pressed="false">◻</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-draw"   title="${this.t('loopCreator.modeDraw')} (D)"   aria-pressed="true">✏️</button>
            </div>
        </div>`;
    }

    _renderGroupHistory() {
        return `
        <div class="le-group le-group-history">
            <span class="le-group-label">${this.t('loopEditor.groupHistory')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="undo" title="${this.t('loopCreator.undo')} (⌘Z)">↶</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="redo" title="${this.t('loopCreator.redo')} (⌘⇧Z)">↷</button>
            </div>
        </div>`;
    }

    _renderGroupEdit() {
        return `
        <div class="le-group le-group-edit">
            <span class="le-group-label">${this.t('loopEditor.groupEdit')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="select-all"      title="${this.t('loopCreator.selectAll')} (⌘A)">▣</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="copy-notes"      title="${this.t('loopCreator.copy')} (⌘C)">📋</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="paste-notes"     title="${this.t('loopCreator.paste')} (⌘V)">📄</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="delete-selected" title="${this.t('loopCreator.deleteSelected')} (⌫)">🗑</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="clear-notes"     title="${this.t('loopCreator.clearNotes')}">⊠</button>
            </div>
            <span class="lc-unit" title="${this.t('loopEditor.velocityHint')}">v</span>
            <input type="number" data-pre-field="pre-velocity" class="lc-spin-input lc-spin-input--sm"
                value="100" min="1" max="127" step="1" title="${this.t('loopEditor.velocityHint')}" />
            <button class="lc-btn lc-btn-icon" data-pre-action="apply-velocity" title="${this.t('loopEditor.applyVelocity')}">→v</button>
        </div>`;
    }

    _renderGroupGrid() {
        return `
        <div class="le-group le-group-grid">
            <span class="le-group-label">${this.t('loopEditor.groupGrid')}</span>
            <select data-pre-field="pre-snap" class="lc-select lc-select-xs" title="${this.t('loopCreator.snap')}">
                <option value="480">1/1</option><option value="240">1/2</option>
                <option value="120" selected>1/4</option><option value="60">1/8</option>
                <option value="30">1/16</option>
            </select>
            <select data-pre-field="pre-quantize" class="lc-select lc-select-xs" title="${this.t('loopCreator.quantize')}">
                <option value="0">Q —</option>
                <option value="480">Q 1/1</option><option value="240">Q 1/2</option>
                <option value="120" selected>Q 1/4</option><option value="60">Q 1/8</option>
                <option value="30">Q 1/16</option>
            </select>
            <button class="lc-btn lc-btn-icon" data-pre-action="quantize-selection" title="${this.t('loopEditor.quantizeSelection')}">⊞</button>
        </div>`;
    }

    _renderGroupView() {
        return `
        <div class="le-group le-group-view">
            <span class="le-group-label">${this.t('loopEditor.groupView')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-h-out" title="${this.t('loopEditor.zoomHOut')}">−H</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-h-in"  title="${this.t('loopEditor.zoomHIn')}">+H</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-v-out" title="${this.t('loopEditor.zoomVOut')}">−V</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-v-in"  title="${this.t('loopEditor.zoomVIn')}">+V</button>
            </div>
        </div>`;
    }

    // =====================================================================
    // INTERNAL — PIANO ROLL INIT
    // =====================================================================

    _initPianoRoll() {
        const container = this.host.querySelector('#pre-pianoroll-wrap');
        if (!container) return;

        // Piano roll renderer abstraction (audit §1.1). Choose the
        // implementation based on the same flag used by MidiEditorModal:
        //   - Default: WebaudioPianorollAdapter (third-party lib).
        //   - Opt-in: CanvasPianoRollRenderer (Canvas maison).
        // The invariant `this.pianoRoll === this.renderer.getElement()`
        // is maintained so any external consumer of getPianoRollElement()
        // keeps working unchanged.
        const useV2 = (() => {
            try {
                const qs = new URLSearchParams(window.location.search);
                if (qs.get('pianoRollV2') === '1') return true;
                if (localStorage.getItem('gmboop_piano_roll_v2') === '1') return true;
            } catch (_) { /* best-effort */ }
            return false;
        })();
        const Impl = (useV2 && typeof CanvasPianoRollRenderer !== 'undefined')
            ? CanvasPianoRollRenderer
            : (typeof WebaudioPianorollAdapter !== 'undefined' ? WebaudioPianorollAdapter : null);
        if (!Impl) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }
        if (Impl === WebaudioPianorollAdapter && !customElements?.get?.('webaudio-pianoroll')) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }

        const total = this._totalTicks();
        const noteSpan0 = this.noteMax - this.noteMin;
        const yrange0   = Math.min(noteSpan0 + 1, 36);
        const yoffset0  = this._centeredYOffset(this.noteMin, this.noteMax, yrange0);

        this.renderer = new Impl({
            container,
            width:  container.clientWidth  || 900,
            height: container.clientHeight || 200,
            ppq:    this.ppq,
            tempo:  this.tempo,
            mode:   'dragpoly'
        });
        this.renderer.mount();
        // Reproduce the legacy attribute init sequence via the chainable
        // renderer API. Adapter forwards to setAttribute on the element;
        // CanvasPianoRollRenderer applies them to its own state.
        this.renderer
            .setXRange(total).setYRange(yrange0).setYOffset(yoffset0)
            .setMarkers(0, total)
            .setCursor(0)
            .beginBatchUpdate()
                .setTimebase(this.ppq)
                .setTempo(this.tempo)
                .setSnap(120)
            .endBatchUpdate();
        if (typeof this.renderer.setAttribute === 'function') {
            // Legacy webaudio-pianoroll knobs that don't map to a contract
            // method — apply via the adapter's raw setAttribute escape hatch.
            // CanvasPianoRollRenderer ignores these (no-ops).
            this.renderer.setAttribute('wheelzoom', '1');
            this.renderer.setAttribute('xscroll',   '1');
            this.renderer.setAttribute('yscroll',   '1');
            this.renderer.setAttribute('xruler',    '1');
            this.renderer.setAttribute('colcursor', 'rgba(0,0,0,0)');
            this.renderer.setAttribute('colmark',   'rgba(0,0,0,0)');
            if (this.multiChannel) this.renderer.setAttribute('colorize', '1');
        }
        this.applyTheme(document.body.classList.contains('theme-dark'));
        if (typeof this.renderer.attachToContainer === 'function') {
            this.renderer.attachToContainer();
        }
        this.pianoRoll = this.renderer.getElement();
        this.renderer.setSequence(this._sequence).redraw();
    }

    _initMinimap() {
        const canvas = this.externalMinimapEl || this.host.querySelector('#pre-minimap');
        if (!canvas || typeof window.LoopCreatorMinimap !== 'function') return;
        const seekHandler = this.minimapReadOnly ? null : (newOffset) => {
            if (!this.renderer?.isMounted()) return;
            this.renderer?.setXOffset(newOffset);
            this.renderer?.redraw();
            this._syncMinimap();
        };
        this._minimap = new window.LoopCreatorMinimap(canvas, {
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            bars:       this.bars,
            noteMin:    this.noteMin,
            noteMax:    this.noteMax,
            onSeek:     seekHandler
        });
        if (this.minimapReadOnly) {
            // Block both pointer and keyboard interaction so the canvas
            // behaves as a pure visualiser.
            canvas.style.cursor = 'default';
            canvas.style.pointerEvents = 'none';
            canvas.removeAttribute('tabindex');
            canvas.removeAttribute('role');
        }
        // Sync minimap on viewport changes. Previously this was a
        // MutationObserver watching xoffset/xrange attributes on the
        // `<webaudio-pianoroll>` element — works only with that legacy
        // impl. Audit §1.1 : route via the renderer's `viewportchange`
        // event which both adapters emit.
        if (this.renderer?.isMounted()) {
            this._viewportListener = () => this._syncMinimap();
            this.renderer.on('viewportchange', this._viewportListener);
        }
        const wrap = this.host.querySelector('#pre-pianoroll-wrap');
        if (wrap) {
            wrap.addEventListener('wheel', () => requestAnimationFrame(() => this._syncMinimap()), { passive: true });
        }
        this._syncMinimap();
    }

    _syncMinimap() {
        const m = this._minimap;
        if (!m) return;
        const total  = this._totalTicks();
        const xoff   = parseFloat(this.renderer?.getXOffset() ?? 0);
        const xrange = parseFloat(this.renderer?.getXRange() ?? total) || total;
        m.setConfig({ ppq: this.ppq, timeSigNum: this.timeSigNum, bars: this.bars, noteMin: this.noteMin, noteMax: this.noteMax });
        m.setNotes(this.renderer?.getSequence() ?? []);
        m.setViewport(xoff, xrange);
        if (this._isRecording && this._recordingPlayheadTick != null) {
            m.setPlayhead(Math.min(total, this._recordingPlayheadTick | 0), true);
        } else {
            m.setPlayhead(this.renderer?.getCursor() ?? 0, false);
        }
    }

    _refreshRange() {
        if (!this.renderer?.isMounted()) return;
        const total = this._totalTicks();
        this.renderer
            ?.setXRange(total)
             .setMarkers(0, total)
             .setTimebase(this.ppq)
             .setTempo(this.tempo);
        const noteSpan = this.noteMax - this.noteMin;
        const yrange   = Math.min(noteSpan + 1, 36);
        const yoffset  = this._centeredYOffset(this.noteMin, this.noteMax, yrange);
        this.renderer
            ?.setYRange(yrange)
             .setYOffset(yoffset)
             .redraw();
        this._syncMinimap();
    }

    _totalTicks() {
        return this.ppq * this.timeSigNum * this.bars;
    }

    _centeredYOffset(noteMin, noteMax, yrange) {
        const center = (noteMin + noteMax) / 2;
        return Math.max(0, Math.min(127 - yrange, Math.round(center - yrange / 2)));
    }

    // =====================================================================
    // INTERNAL — EVENTS
    // =====================================================================

    _attachEvents() {
        if (this._wired) return;
        this._wired = true;
        // Store bound refs so destroy() can detach. The host element survives
        // mount/destroy cycles in some consumers, so anonymous handlers would
        // accumulate (one set per cycle) and keep references to the destroyed
        // editor instance alive.
        this._onClickBound  = (e) => this._onClick(e);
        this._onChangeBound = (e) => this._onChange(e);
        this.host.addEventListener('click',  this._onClickBound);
        this.host.addEventListener('change', this._onChangeBound);
    }

    _onClick(e) {
        const btn = e.target.closest('[data-pre-action]');
        if (!btn) return;
        switch (btn.dataset.preAction) {
            case 'mode-view':         this.setMode('view'); break;
            case 'mode-select':       this.setMode('select'); break;
            case 'mode-draw':         this.setMode('dragpoly'); break;
            case 'undo':              this.undo(); break;
            case 'redo':              this.redo(); break;
            case 'select-all':        this.selectAll(); break;
            case 'copy-notes':        this.copy(); break;
            case 'paste-notes':       this.paste(); break;
            case 'delete-selected':   this.deleteSelected(); break;
            case 'clear-notes':       this.clearNotes(); break;
            case 'quantize-selection':this.quantizeSelection(); break;
            case 'apply-velocity':    this.applyVelocityToSelection(); break;
            case 'zoom-h-out':        this.zoomH(2.0); break;
            case 'zoom-h-in':         this.zoomH(0.5); break;
            case 'zoom-v-out':        this.zoomV(1.5); break;
            case 'zoom-v-in':         this.zoomV(0.75); break;
        }
    }

    _onChange(e) {
        const f = e.target.dataset?.preField;
        if (f === 'pre-snap') {
            const v = parseInt(e.target.value);
            if (this.actions?.setSnap) this.actions.setSnap(v);
            else if (this.renderer?.isMounted()) this.renderer?.setSnap(v);
        }
    }

    _setAriaPressed(selector, pressed) {
        const el = this.host?.querySelector(selector);
        if (el) el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }

    _fieldVal(name) {
        return this.host?.querySelector(`[data-pre-field="${name}"]`)?.value;
    }

    _setStatus(msg) {
        const el = (typeof this.getStatusEl === 'function') ? this.getStatusEl() : null;
        if (el) el.textContent = msg;
    }

    _emitChange() {
        this._sequence = this.getSequence();
        if (this.onSequenceChange) this.onSequenceChange(this._sequence);
    }
}

if (typeof window !== 'undefined') window.PianoRollEditor = PianoRollEditor;
if (typeof module !== 'undefined' && module.exports) module.exports = PianoRollEditor;
