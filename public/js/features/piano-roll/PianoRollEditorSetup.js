/**
 * PianoRollEditorSetup — toolbar HTML + piano-roll/minimap init/refresh
 * for PianoRollEditor. Extracted per audit §1.3 (god-class split).
 *
 * Owns:
 *   - `renderShell()` / `renderToolbarGroups()` / `renderGroupMode()` /
 *     `renderGroupHistory()` / `renderGroupEdit()` / `renderGroupGrid()` /
 *     `renderGroupView()` — pure HTML template fragments for the toolbar.
 *   - `initPianoRoll()` — picks the renderer (legacy adapter / V2 canvas),
 *     mounts it, wires `change` / `selectionchange` / `viewportchange` listeners.
 *   - `initMinimap()` — bootstraps the per-editor minimap canvas
 *     (external or internal element).
 *   - `syncMinimap()` / `refreshRange()` — push current sequence + viewport
 *     into the minimap, recompute xrange when bars/timeSig/tempo change.
 *   - `totalTicks()` / `centeredYOffset()` — derived computations.
 *
 * Accessed via `pianoRollEditor.setup`. PianoRollEditor keeps thin
 * delegates so existing call sites (mount(), refit(), setRange(),
 * applyTheme()) are unchanged.
 */
class PianoRollEditorSetup {
    /** @param {PianoRollEditor} parent */
    constructor(parent) {
        this.parent = parent;
    }

    renderToolbarGroups() {
        const sg = this.parent.showGroups;
        return `
            ${sg.mode    ? this.renderGroupMode()    : ''}
            ${sg.history ? this.renderGroupHistory() : ''}
            ${sg.edit    ? this.renderGroupEdit()    : ''}
            ${sg.grid    ? this.renderGroupGrid()    : ''}
            <span class="lc-ctrl-spacer"></span>
            ${sg.view    ? this.renderGroupView()    : ''}
        `;
    }

    renderShell() {
        const minimapHtml = this.parent.externalMinimapEl ? '' : `
        <canvas class="lc-minimap" id="pre-minimap"
                role="slider" tabindex="0"
                aria-label="${this.parent.t('loopEditor.minimapAria')}"></canvas>`;
        return `
        <div class="pre-toolbar">${this.renderToolbarGroups()}</div>
        <div class="lc-pianoroll-area" id="pre-pianoroll-area">
            <div class="lc-pianoroll-wrap" id="pre-pianoroll-wrap"></div>
        </div>
        ${minimapHtml}
        `;
    }

    renderGroupMode() {
        return `
        <div class="le-group le-group-mode">
            <span class="le-group-label">${this.parent.t('loopEditor.groupMode')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-view"   title="${this.parent.t('loopCreator.modeView')} (V)"   aria-pressed="false">👁</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-select" title="${this.parent.t('loopCreator.modeSelect')} (S)" aria-pressed="false">◻</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="mode-draw"   title="${this.parent.t('loopCreator.modeDraw')} (D)"   aria-pressed="true">✏️</button>
            </div>
        </div>`;
    }

    renderGroupHistory() {
        return `
        <div class="le-group le-group-history">
            <span class="le-group-label">${this.parent.t('loopEditor.groupHistory')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="undo" title="${this.parent.t('loopCreator.undo')} (⌘Z)">↶</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="redo" title="${this.parent.t('loopCreator.redo')} (⌘⇧Z)">↷</button>
            </div>
        </div>`;
    }

    renderGroupEdit() {
        return `
        <div class="le-group le-group-edit">
            <span class="le-group-label">${this.parent.t('loopEditor.groupEdit')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="select-all"      title="${this.parent.t('loopCreator.selectAll')} (⌘A)">▣</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="copy-notes"      title="${this.parent.t('loopCreator.copy')} (⌘C)">📋</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="paste-notes"     title="${this.parent.t('loopCreator.paste')} (⌘V)">📄</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="delete-selected" title="${this.parent.t('loopCreator.deleteSelected')} (⌫)">🗑</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="clear-notes"     title="${this.parent.t('loopCreator.clearNotes')}">⊠</button>
            </div>
            <span class="lc-unit" title="${this.parent.t('loopEditor.velocityHint')}">v</span>
            <input type="number" data-pre-field="pre-velocity" class="lc-spin-input lc-spin-input--sm"
                value="100" min="1" max="127" step="1" title="${this.parent.t('loopEditor.velocityHint')}" />
            <button class="lc-btn lc-btn-icon" data-pre-action="apply-velocity" title="${this.parent.t('loopEditor.applyVelocity')}">→v</button>
        </div>`;
    }

    renderGroupGrid() {
        return `
        <div class="le-group le-group-grid">
            <span class="le-group-label">${this.parent.t('loopEditor.groupGrid')}</span>
            <select data-pre-field="pre-snap" class="lc-select lc-select-xs" title="${this.parent.t('loopCreator.snap')}">
                <option value="480">1/1</option><option value="240">1/2</option>
                <option value="120" selected>1/4</option><option value="60">1/8</option>
                <option value="30">1/16</option>
            </select>
            <select data-pre-field="pre-quantize" class="lc-select lc-select-xs" title="${this.parent.t('loopCreator.quantize')}">
                <option value="0">Q —</option>
                <option value="480">Q 1/1</option><option value="240">Q 1/2</option>
                <option value="120" selected>Q 1/4</option><option value="60">Q 1/8</option>
                <option value="30">Q 1/16</option>
            </select>
            <button class="lc-btn lc-btn-icon" data-pre-action="quantize-selection" title="${this.parent.t('loopEditor.quantizeSelection')}">⊞</button>
        </div>`;
    }

    renderGroupView() {
        return `
        <div class="le-group le-group-view">
            <span class="le-group-label">${this.parent.t('loopEditor.groupView')}</span>
            <div class="lc-btn-group">
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-h-out" title="${this.parent.t('loopEditor.zoomHOut')}">−H</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-h-in"  title="${this.parent.t('loopEditor.zoomHIn')}">+H</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-v-out" title="${this.parent.t('loopEditor.zoomVOut')}">−V</button>
                <button class="lc-btn lc-btn-icon" data-pre-action="zoom-v-in"  title="${this.parent.t('loopEditor.zoomVIn')}">+V</button>
            </div>
        </div>`;
    }

    // =====================================================================
    // INTERNAL — PIANO ROLL INIT
    // =====================================================================

    initPianoRoll() {
        const container = this.parent.host.querySelector('#pre-pianoroll-wrap');
        if (!container) return;

        // Piano roll renderer abstraction (audit §1.1). V1
        // (webaudio-pianoroll) is being removed — the Canvas renderer is
        // now forced here too (this loop-editor path previously still
        // defaulted to V1). The legacy adapter fallback below is kept only
        // as a rollback safety net until V1 is physically deleted (Phase E).
        // The invariant `this.parent.pianoRoll === this.parent.renderer.getElement()`
        // is maintained so any external consumer of getPianoRollElement()
        // keeps working unchanged.
        const useV2 = true;
        const Impl = (useV2 && typeof CanvasPianoRollRenderer !== 'undefined')
            ? CanvasPianoRollRenderer
            : (typeof WebaudioPianorollAdapter !== 'undefined' ? WebaudioPianorollAdapter : null);
        if (!Impl) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.parent.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }
        if (Impl === WebaudioPianorollAdapter && !customElements?.get?.('webaudio-pianoroll')) {
            container.innerHTML = `<div class="lc-pianoroll-error">${this.parent.t('loopCreator.pianoRollUnavailable')}</div>`;
            return;
        }

        const total = this.totalTicks();
        const noteSpan0 = this.parent.noteMax - this.parent.noteMin;
        const yrange0   = Math.min(noteSpan0 + 1, 36);
        const yoffset0  = this.centeredYOffset(this.parent.noteMin, this.parent.noteMax, yrange0);

        this.parent.renderer = new Impl({
            container,
            width:  container.clientWidth  || 900,
            height: container.clientHeight || 200,
            ppq:    this.parent.ppq,
            tempo:  this.parent.tempo,
            mode:   'dragpoly'
        });
        this.parent.renderer.mount();
        // Reproduce the legacy attribute init sequence via the chainable
        // renderer API. Adapter forwards to setAttribute on the element;
        // CanvasPianoRollRenderer applies them to its own state.
        this.parent.renderer
            .setXRange(total).setYRange(yrange0).setYOffset(yoffset0)
            .setMarkers(0, total)
            .setCursor(0)
            .beginBatchUpdate()
                .setTimebase(this.parent.ppq)
                .setTempo(this.parent.tempo)
                .setSnap(120)
            .endBatchUpdate();
        if (typeof this.parent.renderer.setAttribute === 'function') {
            // Legacy webaudio-pianoroll knobs that don't map to a contract
            // method — apply via the adapter's raw setAttribute escape hatch.
            // CanvasPianoRollRenderer ignores these (no-ops).
            this.parent.renderer.setAttribute('wheelzoom', '1');
            this.parent.renderer.setAttribute('xscroll',   '1');
            this.parent.renderer.setAttribute('yscroll',   '1');
            this.parent.renderer.setAttribute('xruler',    '1');
            this.parent.renderer.setAttribute('colcursor', 'rgba(0,0,0,0)');
            this.parent.renderer.setAttribute('colmark',   'rgba(0,0,0,0)');
            if (this.parent.multiChannel) this.parent.renderer.setAttribute('colorize', '1');
        }
        this.parent.applyTheme(document.body.classList.contains('theme-dark'));
        if (typeof this.parent.renderer.attachToContainer === 'function') {
            this.parent.renderer.attachToContainer();
        }
        this.parent.pianoRoll = this.parent.renderer.getElement();
        this.parent.renderer.setSequence(this.parent._sequence).redraw();
    }

    initMinimap() {
        const canvas = this.parent.externalMinimapEl || this.parent.host.querySelector('#pre-minimap');
        if (!canvas || typeof window.LoopCreatorMinimap !== 'function') return;
        const seekHandler = this.parent.minimapReadOnly ? null : (newOffset) => {
            if (!this.parent.renderer?.isMounted()) return;
            this.parent.renderer?.setXOffset(newOffset);
            this.parent.renderer?.redraw();
            this.syncMinimap();
        };
        this.parent._minimap = new window.LoopCreatorMinimap(canvas, {
            ppq:        this.parent.ppq,
            timeSigNum: this.parent.timeSigNum,
            bars:       this.parent.bars,
            noteMin:    this.parent.noteMin,
            noteMax:    this.parent.noteMax,
            onSeek:     seekHandler
        });
        if (this.parent.minimapReadOnly) {
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
        if (this.parent.renderer?.isMounted()) {
            this.parent._viewportListener = () => this.syncMinimap();
            this.parent.renderer.on('viewportchange', this.parent._viewportListener);
        }
        const wrap = this.parent.host.querySelector('#pre-pianoroll-wrap');
        if (wrap) {
            wrap.addEventListener('wheel', () => requestAnimationFrame(() => this.syncMinimap()), { passive: true });
        }
        this.syncMinimap();
    }

    syncMinimap() {
        const m = this.parent._minimap;
        if (!m) return;
        const total  = this.totalTicks();
        const xoff   = parseFloat(this.parent.renderer?.getXOffset() ?? 0);
        const xrange = parseFloat(this.parent.renderer?.getXRange() ?? total) || total;
        m.setConfig({ ppq: this.parent.ppq, timeSigNum: this.parent.timeSigNum, bars: this.parent.bars, noteMin: this.parent.noteMin, noteMax: this.parent.noteMax });
        m.setNotes(this.parent.renderer?.getSequence() ?? []);
        m.setViewport(xoff, xrange);
        if (this.parent._isRecording && this.parent._recordingPlayheadTick != null) {
            m.setPlayhead(Math.min(total, this.parent._recordingPlayheadTick | 0), true);
        } else {
            m.setPlayhead(this.parent.renderer?.getCursor() ?? 0, false);
        }
    }

    refreshRange() {
        if (!this.parent.renderer?.isMounted()) return;
        const total = this.totalTicks();
        this.parent.renderer
            ?.setXRange(total)
             .setMarkers(0, total)
             .setTimebase(this.parent.ppq)
             .setTempo(this.parent.tempo);
        const noteSpan = this.parent.noteMax - this.parent.noteMin;
        const yrange   = Math.min(noteSpan + 1, 36);
        const yoffset  = this.centeredYOffset(this.parent.noteMin, this.parent.noteMax, yrange);
        this.parent.renderer
            ?.setYRange(yrange)
             .setYOffset(yoffset)
             .redraw();
        this.syncMinimap();
    }

    totalTicks() {
        return this.parent.ppq * this.parent.timeSigNum * this.parent.bars;
    }

    centeredYOffset(noteMin, noteMax, yrange) {
        const center = (noteMin + noteMax) / 2;
        return Math.max(0, Math.min(127 - yrange, Math.round(center - yrange / 2)));
    }
}

if (typeof window !== 'undefined') {
    window.PianoRollEditorSetup = PianoRollEditorSetup;
}
