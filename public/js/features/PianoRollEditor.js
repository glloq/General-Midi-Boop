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
        this.actions = opts.actions || null;
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
        this.host.innerHTML = this._renderShell();
        this._initPianoRoll();
        this._initMinimap();
        this._attachEvents();
    }

    destroy() {
        if (this._minimapObserver) { this._minimapObserver.disconnect(); this._minimapObserver = null; }
        this._minimap?.destroy?.();
        this._minimap  = null;
        this.pianoRoll = null;
        if (this.host) {
            this.host.classList.remove('pre-host');
            this.host.innerHTML = '';
        }
    }

    // =====================================================================
    // PUBLIC ACCESSORS
    // =====================================================================

    getSequence() {
        return Array.isArray(this.pianoRoll?.sequence) ? this.pianoRoll.sequence : this._sequence;
    }

    setSequence(seq) {
        const next = Array.isArray(seq) ? seq.slice() : [];
        this._sequence = next;
        if (this.pianoRoll) {
            this.pianoRoll.sequence = next;
            this.pianoRoll.redraw?.();
        }
        this._syncMinimap();
        this._emitChange();
    }

    addNote(noteObj) {
        if (!noteObj) return;
        const cur = this.getSequence();
        const next = Array.isArray(cur) ? [...cur, noteObj] : [noteObj];
        if (this.pianoRoll) {
            this.pianoRoll.sequence = next;
            this.pianoRoll.redraw?.();
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
        if (!this.pianoRoll) return;
        this.pianoRoll.cursor = Math.max(0, Math.min(this._totalTicks(), tick | 0));
        this.pianoRoll.redrawMarker?.();
        this._syncMinimap();
    }

    setRecordingPlayhead(tickOrNull) {
        this._isRecording = tickOrNull != null;
        this._recordingPlayheadTick = tickOrNull;
        this._syncMinimap();
    }

    applyTheme(isDark) {
        const dark = (isDark == null) ? document.body.classList.contains('theme-dark') : !!isDark;
        if (!this.pianoRoll) return;
        this.pianoRoll.setAttribute('colnote',     dark ? '#5b9bd5' : '#4a90d9');
        this.pianoRoll.setAttribute('colnotesel',  dark ? '#f5a623' : '#e8931a');
        this.pianoRoll.setAttribute('colbg',       dark ? '#1a1a2e' : '#f8f9fa');
        this.pianoRoll.setAttribute('colline',     dark ? '#333355' : '#dde0e6');
        this.pianoRoll.setAttribute('colrulerbg',  dark ? '#12122a' : '#eef0f4');
        this.pianoRoll.setAttribute('colrulerfg',  dark ? '#8888aa' : '#666677');
        this.pianoRoll.setAttribute('colkeybg',    dark ? '#1e1e38' : '#f0f0f4');
        this.pianoRoll.setAttribute('colkeyfg',    dark ? '#ccccee' : '#333344');
        this.pianoRoll.setAttribute('colkeyblack', dark ? '#0d0d1a' : '#303040');
        this.pianoRoll.redraw?.();
    }

    getPianoRollElement() { return this.pianoRoll; }

    /**
     * Recompute width/height from the current wrap size and redraw. Call this
     * after the host becomes visible (e.g. after a tab switch).
     */
    refit() {
        if (!this.pianoRoll) return;
        const wrap = this.host?.querySelector('#pre-pianoroll-wrap');
        if (!wrap) return;
        const w = wrap.clientWidth  || 900;
        const h = wrap.clientHeight || 200;
        this.pianoRoll.setAttribute('width',  w.toString());
        this.pianoRoll.setAttribute('height', h.toString());
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    // =====================================================================
    // PUBLIC ACTIONS — can be overridden via opts.actions
    // =====================================================================

    setMode(mode) {
        if (!this.pianoRoll) return;
        const prMode = mode === 'view' ? 'select' : mode;
        this.pianoRoll.setAttribute('editmode', prMode);
        this._setAriaPressed('[data-pre-action="mode-view"]',   mode === 'view');
        this._setAriaPressed('[data-pre-action="mode-select"]', mode === 'select');
        this._setAriaPressed('[data-pre-action="mode-draw"]',   mode === 'dragpoly');
    }

    undo() {
        if (this.actions?.undo) return this.actions.undo();
        this.pianoRoll?.undo?.();
        this._emitChange();
    }

    redo() {
        if (this.actions?.redo) return this.actions.redo();
        this.pianoRoll?.redo?.();
        this._emitChange();
    }

    selectAll() {
        if (this.actions?.selectAll) return this.actions.selectAll();
        if (!this.pianoRoll) return;
        const seq = Array.isArray(this.pianoRoll.sequence) ? this.pianoRoll.sequence : [];
        seq.forEach(n => { n.f = 1; });
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
    }

    copy() {
        if (this.actions?.copy) return this.actions.copy();
        if (!this.pianoRoll) return;
        if (typeof this.pianoRoll.copySelection === 'function') {
            this._clipboard = this.pianoRoll.copySelection() ?? [];
        } else {
            this._clipboard = (this.pianoRoll.sequence || []).filter(n => n.f).map(n => ({ ...n }));
        }
        this._setStatus(this.t('loopEditor.notesCopied', { count: this._clipboard.length }));
    }

    paste() {
        if (this.actions?.paste) return this.actions.paste();
        if (!this.pianoRoll || !this._clipboard.length) return;
        const cursor = this.pianoRoll.cursor ?? 0;
        if (typeof this.pianoRoll.pasteNotes === 'function') {
            this.pianoRoll.pasteNotes(this._clipboard, cursor);
        } else {
            const minT = Math.min(...this._clipboard.map(n => n.t));
            const pasted = this._clipboard.map(n => ({ ...n, t: n.t - minT + cursor }));
            this.pianoRoll.sequence = [...(this.pianoRoll.sequence || []), ...pasted];
        }
        this.pianoRoll.redraw?.();
        this._syncMinimap();
        this._emitChange();
    }

    deleteSelected() {
        if (this.actions?.deleteSelected) return this.actions.deleteSelected();
        if (!this.pianoRoll) return;
        this.pianoRoll.sequence = (this.pianoRoll.sequence || []).filter(n => !n.f);
        this.pianoRoll.redraw?.();
        this._syncMinimap();
        this._emitChange();
    }

    clearNotes() {
        if (this.actions?.clearNotes) return this.actions.clearNotes();
        if (this.pianoRoll) { this.pianoRoll.sequence = []; this.pianoRoll.redraw?.(); }
        this._sequence = [];
        this._syncMinimap();
        this._emitChange();
    }

    quantizeSelection() {
        if (this.actions?.quantizeSelection) return this.actions.quantizeSelection();
        if (!this.pianoRoll) return;
        const q = parseInt(this._fieldVal('pre-quantize') ?? 0);
        if (!q || q <= 0) {
            this._setStatus(this.t('loopEditor.quantizeNoGrid'));
            return;
        }
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        const selected = seq.filter(n => n.f);
        const target = selected.length ? selected : seq;
        let count = 0;
        for (const note of target) {
            const before = note.t;
            note.t = Math.round(note.t / q) * q;
            note.g = Math.max(q, Math.round((note.g || note.l || 120) / q) * q);
            if (note.t !== before) count++;
        }
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._syncMinimap();
        this._setStatus(this.t('loopEditor.quantizedNotes', { count }));
        this._emitChange();
    }

    applyVelocityToSelection() {
        if (this.actions?.applyVelocity) return this.actions.applyVelocity();
        if (!this.pianoRoll) return;
        const raw = parseInt(this._fieldVal('pre-velocity') ?? 100);
        const v = Math.max(1, Math.min(127, isNaN(raw) ? 100 : raw));
        const seq = Array.isArray(this.pianoRoll.sequence) ? [...this.pianoRoll.sequence] : [];
        const selected = seq.filter(n => n.f);
        const target = selected.length ? selected : seq;
        if (!target.length) {
            this._setStatus(this.t('loopEditor.velocityNoNotes'));
            return;
        }
        for (const note of target) note.v = v;
        this.pianoRoll.sequence = seq;
        this.pianoRoll.redraw?.();
        this._syncMinimap();
        this._setStatus(this.t('loopEditor.velocityApplied', { count: target.length, velocity: v }));
        this._emitChange();
    }

    zoomH(factor) {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        const cur   = parseFloat(this.pianoRoll.getAttribute('xrange') || total);
        const next  = Math.max(Math.ceil(total / 32), Math.min(total, Math.round(cur * factor)));
        this.pianoRoll.setAttribute('xrange', next.toString());
        this.pianoRoll.redraw?.();
        this._syncMinimap();
    }

    zoomV(factor) {
        if (!this.pianoRoll) return;
        const cur  = parseFloat(this.pianoRoll.getAttribute('yrange') || 36);
        const next = Math.max(6, Math.min(128, Math.round(cur * factor)));
        this.pianoRoll.setAttribute('yrange', next.toString());
        this.pianoRoll.redraw?.();
    }

    // =====================================================================
    // INTERNAL — RENDER
    // =====================================================================

    _renderShell() {
        const sg = this.showGroups;
        return `
        <div class="pre-toolbar">
            ${sg.mode    ? this._renderGroupMode()    : ''}
            ${sg.history ? this._renderGroupHistory() : ''}
            ${sg.edit    ? this._renderGroupEdit()    : ''}
            ${sg.grid    ? this._renderGroupGrid()    : ''}
            <span class="lc-ctrl-spacer"></span>
            ${sg.view    ? this._renderGroupView()    : ''}
        </div>
        <div class="lc-pianoroll-area" id="pre-pianoroll-area">
            <div class="lc-pianoroll-wrap" id="pre-pianoroll-wrap"></div>
        </div>
        <canvas class="lc-minimap" id="pre-minimap"
                role="slider" tabindex="0"
                aria-label="${this.t('loopEditor.minimapAria')}"></canvas>
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
        if (!customElements?.get?.('webaudio-pianoroll')) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }
        this.pianoRoll = document.createElement('webaudio-pianoroll');
        const total = this._totalTicks();
        const noteSpan0 = this.noteMax - this.noteMin;
        const yrange0   = Math.min(noteSpan0 + 1, 36);
        const yoffset0  = this._centeredYOffset(this.noteMin, this.noteMax, yrange0);
        this.pianoRoll.setAttribute('width',     container.clientWidth  || 900);
        this.pianoRoll.setAttribute('height',    container.clientHeight || 200);
        this.pianoRoll.setAttribute('editmode',  'dragpoly');
        this.pianoRoll.setAttribute('xrange',    total.toString());
        this.pianoRoll.setAttribute('yrange',    yrange0.toString());
        this.pianoRoll.setAttribute('yoffset',   yoffset0.toString());
        this.pianoRoll.setAttribute('wheelzoom', '1');
        this.pianoRoll.setAttribute('xscroll',   '1');
        this.pianoRoll.setAttribute('yscroll',   '1');
        this.pianoRoll.setAttribute('xruler',    '1');
        this.pianoRoll.setAttribute('cursor',    '0');
        this.pianoRoll.setAttribute('markstart', '0');
        this.pianoRoll.setAttribute('markend',   total.toString());
        this.pianoRoll.setAttribute('snap',      '120');
        this.pianoRoll.setAttribute('timebase',  this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',     this.tempo.toString());
        this.pianoRoll.setAttribute('colcursor', 'rgba(0,0,0,0)');
        this.pianoRoll.setAttribute('colmark',   'rgba(0,0,0,0)');
        if (this.multiChannel) this.pianoRoll.setAttribute('colorize', '1');
        this.applyTheme(document.body.classList.contains('theme-dark'));
        container.appendChild(this.pianoRoll);
        this.pianoRoll.sequence = this._sequence;
        this.pianoRoll.redraw?.();
    }

    _initMinimap() {
        const canvas = this.host.querySelector('#pre-minimap');
        if (!canvas || typeof window.LoopCreatorMinimap !== 'function') return;
        this._minimap = new window.LoopCreatorMinimap(canvas, {
            ppq:        this.ppq,
            timeSigNum: this.timeSigNum,
            bars:       this.bars,
            noteMin:    this.noteMin,
            noteMax:    this.noteMax,
            onSeek: (newOffset) => {
                if (!this.pianoRoll) return;
                this.pianoRoll.setAttribute('xoffset', newOffset.toString());
                this.pianoRoll.redraw?.();
                this._syncMinimap();
            }
        });
        if (this.pianoRoll) {
            this._minimapObserver = new MutationObserver(() => this._syncMinimap());
            this._minimapObserver.observe(this.pianoRoll, {
                attributes: true, attributeFilter: ['xoffset', 'xrange']
            });
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
        const xoff   = parseFloat(this.pianoRoll?.getAttribute?.('xoffset') || 0);
        const xrange = parseFloat(this.pianoRoll?.getAttribute?.('xrange')  || total) || total;
        m.setConfig({ ppq: this.ppq, timeSigNum: this.timeSigNum, bars: this.bars, noteMin: this.noteMin, noteMax: this.noteMax });
        m.setNotes(this.pianoRoll?.sequence ?? []);
        m.setViewport(xoff, xrange);
        if (this._isRecording && this._recordingPlayheadTick != null) {
            m.setPlayhead(Math.min(total, this._recordingPlayheadTick | 0), true);
        } else {
            m.setPlayhead(this.pianoRoll?.cursor ?? 0, false);
        }
    }

    _refreshRange() {
        if (!this.pianoRoll) return;
        const total = this._totalTicks();
        this.pianoRoll.setAttribute('xrange',   total.toString());
        this.pianoRoll.setAttribute('markend',  total.toString());
        this.pianoRoll.setAttribute('timebase', this.ppq.toString());
        this.pianoRoll.setAttribute('tempo',    this.tempo.toString());
        const noteSpan = this.noteMax - this.noteMin;
        const yrange   = Math.min(noteSpan + 1, 36);
        const yoffset  = this._centeredYOffset(this.noteMin, this.noteMax, yrange);
        this.pianoRoll.setAttribute('yrange',  yrange.toString());
        this.pianoRoll.setAttribute('yoffset', yoffset.toString());
        this.pianoRoll.redraw?.();
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
        this.host.addEventListener('click',  (e) => this._onClick(e));
        this.host.addEventListener('change', (e) => this._onChange(e));
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
        if (f === 'pre-snap' && this.pianoRoll) {
            this.pianoRoll.snap = parseInt(e.target.value);
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
