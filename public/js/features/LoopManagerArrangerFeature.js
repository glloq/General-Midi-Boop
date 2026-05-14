/**
 * LoopManagerArrangerFeature — Arranger tab of LoopManagerModal.
 *
 * Audit §6.6 — fifth and largest slice of the LoopCreatorModal god-class.
 * Extracts the Arranger tab in its entirety: arrangement CRUD,
 * undo/redo, timeline + tracks + blocks rendering, track ops, block
 * ops (drag, paste, dup, delete, change reps), playback (with
 * count-in + playbar RAF), and the document-scoped drag handlers
 * for block resize.
 *
 * Extraction strategy: **state stays on the modal** (different from
 * Keyboard/Library/Live/Pad). The feature contains methods only; every
 * `this.X` accessing modal state has been translated to `this.modal.X`.
 * Cross-method calls between Arranger methods stay as `this.method()`.
 * Documented in AUDIT_LOOP_ARRANGER_SPLIT.md (commit 59fe2fc).
 *
 * `_renderPlaybar` and `_fetchLoopData` remain on the modal because
 * they are cross-cutting (`_renderPlaybar` reads Pad/Live/Arranger
 * playheads; `_fetchLoopData` is the shared loop cache).
 */
(function () {
    'use strict';

    const ARRANGER_HISTORY_LIMIT = 50;

    class LoopManagerArrangerFeature {
        /** @param {LoopManagerModal} modal */
        constructor(modal) {
            this.modal = modal;
            // Sub-features extracted per audit §1.3:
            this.view = typeof LoopManagerArrangerView !== 'undefined'
                ? new LoopManagerArrangerView(this)
                : null;
            this.ops = typeof LoopManagerArrangerOps !== 'undefined'
                ? new LoopManagerArrangerOps(this)
                : null;
        }

    async _initArrangerSynth() {
        if (!this.modal._arrangerSynth) this.modal._arrangerSynth = await LoopUtils.createSynth({ initialProgram: 0 });
    }

    async _initArrangerTab() {
        await this.modal._loadLibrary();
        // Nettoyage one-shot des arrangements vides (sans block) accumulés
        // par l'ancien auto-create. Ne supprime que les arrangements créés
        // avant cette session et qui n'ont jamais reçu de block.
        await this._purgeEmptyArrangements();
        await this._loadArrangements();
        if (this.modal.currentArrangementId) {
            const ok = await this._loadArrangementById(this.modal.currentArrangementId);
            if (!ok) {
                // L'arrangement précédemment ouvert a pu être purgé ou
                // supprimé entre-temps — fallback sur l'empty state.
                this.modal.currentArrangementId = null;
                this._renderArrangerEmptyState();
            }
        } else {
            // Pas d'auto-create : on affiche un empty state avec un CTA
            // dans la track area. L'utilisateur clique « + Nouvel
            // arrangement » pour créer (cf. _newArrangementConfirm).
            this._renderArrangerEmptyState();
        }
    }

    /**
     * Affiche un empty state dans la zone tracks quand aucun arrangement
     * n'est sélectionné. Évite la création automatique de fichiers
     * fantômes à chaque ouverture de la modale.
     */
    _renderArrangerEmptyState() {
        const tracksEl = this.modal.$('#la-tracks');
        const rulerEl  = this.modal.$('#la-ruler');
        if (rulerEl)  rulerEl.innerHTML  = '';
        if (tracksEl) tracksEl.innerHTML = `
            <div class="la-empty-state">
                <p>${this.modal.t('loopManager.arrangerEmptyState') || 'No arrangement selected.'}</p>
                <button class="lc-btn lc-btn-primary" data-action="arr-new">
                    + ${this.modal.t('loopCreator.newArrangement')}
                </button>
            </div>`;
        // Vider l'overlay playbar + désactiver le play
        this.modal.tracks = [];
        this.modal.blocks = [];
    }

    /**
     * Supprime les arrangements existants qui n'ont aucun block et ne
     * sont pas l'arrangement actuel. Best-effort : les erreurs sont
     * journalisées mais n'interrompent pas le flux.
     */
    async _purgeEmptyArrangements() {
        try {
            const r = await this.modal.api.sendCommand('arrangement_list');
            const arrs = r.arrangements || [];
            for (const arr of arrs) {
                if (arr.id === this.modal.currentArrangementId) continue;
                try {
                    const detail = await this.modal.api.sendCommand('arrangement_get', { arrangementId: arr.id });
                    if ((detail.blocks || []).length === 0) {
                        await this.modal.api.sendCommand('arrangement_delete', { arrangementId: arr.id });
                    }
                } catch (e) {
                    // Continue avec les autres arrangements en cas d'erreur ponctuelle.
                }
            }
        } catch (err) {
            LoopUtils.handleError(err, 'arr.purgeEmpty');
        }
    }

    async _loadArrangements() {
        try {
            const r = await this.modal.api.sendCommand('arrangement_list');
            this._renderArrList(r.arrangements || []);
        } catch (err) {
            LoopUtils.handleError(err, 'arr.list');
        }
    }

    _renderArrList(arrs) {
        const el = this.modal.$('#la-arr-list');
        if (!el) return;
        if (!arrs.length) { el.innerHTML = `<div class="lc-empty">${this.modal.t('loopCreator.arrangementsEmpty')}</div>`; return; }
        el.innerHTML = arrs.map(a => `
            <div class="la-arr-item${a.id===this.modal.currentArrangementId ? ' la-arr-item--active':''}"
                data-arr-id="${a.id}" role="button" tabindex="0">
                <span class="la-arr-name">${this.modal.escape(a.name)}</span>
                <span class="la-arr-meta">${a.global_tempo} BPM · ${a.total_bars} ${this.modal.t('loopCreator.barsUnit')}</span>
                <button class="lc-card-btn" data-arr-action="duplicate" data-arr-id="${a.id}"
                    title="${this.modal.t('loopManager.duplicateArrangement')}">⎘</button>
                <button class="lc-card-btn lc-card-btn--danger" data-arr-action="delete" data-arr-id="${a.id}"
                    title="${this.modal.t('loopManager.deleteArrangement')}">🗑</button>
            </div>`).join('');
        if (!el.dataset.lcWired) {
            el.dataset.lcWired = '1';
            el.addEventListener('click', async (e) => {
                const del = e.target.closest('[data-arr-action="delete"]');
                if (del) {
                    const id = parseInt(del.dataset.arrId);
                    const item = el.querySelector(`[data-arr-id="${id}"] .la-arr-name`);
                    const name = item?.textContent || '';
                    const ok = await LoopUtils.confirm(
                        this.modal.t('loopManager.confirmDeleteArrangement', { name }),
                        { icon: '🗑️', danger: true }
                    );
                    if (ok) this._deleteArrangement(id);
                    return;
                }
                const dup = e.target.closest('[data-arr-action="duplicate"]');
                if (dup) {
                    e.stopPropagation();
                    this._duplicateArrangement(parseInt(dup.dataset.arrId));
                    return;
                }
                const item = e.target.closest('[data-arr-id]');
                if (item) this._requestLoadArrangement(parseInt(item.dataset.arrId));
            });
        }
    }

    async _newArrangementConfirm() {
        const hasContent = (this.modal.blocks?.length || 0) > 0 || (this.modal.tracks?.length || 0) > 0;
        if (hasContent && this.modal._arrDirty) {
            const ok = await LoopUtils.confirm(this.modal.t('loopManager.confirmNewArrangement'),
                { icon: '⚠️', danger: true });
            if (!ok) return;
        }
        this._newArrangement();
    }

    async _requestLoadArrangement(id) {
        if (id === this.modal.currentArrangementId) return;
        if (this.modal._arrDirty) {
            const ok = await LoopUtils.confirm(this.modal.t('loopManager.confirmSwitchArrangement'),
                { icon: '⚠️', danger: true });
            if (!ok) return;
        }
        this._loadArrangementById(id);
    }

    async _newArrangement() {
        try {
            const r = await this.modal.api.sendCommand('arrangement_create', {
                name: this.modal.t('loopCreator.untitledArrangement'),
                global_tempo: this.modal.arrangementTempo, total_bars: this.modal.arrangementBars
            });
            this.modal.currentArrangementId = r.arrangementId;
            await this._loadArrangementById(r.arrangementId);
            await this._loadArrangements();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.new', {
                toast: this.modal.t('loopManager.errCreateArrangement')
            });
        }
    }

    async _loadArrangementById(id) {
        try {
            const r = await this.modal.api.sendCommand('arrangement_get', { arrangementId: id });
            const { arrangement, tracks, blocks } = r;
            this.modal.currentArrangementId = arrangement.id;
            this.modal.arrangementName  = arrangement.name;
            this.modal.arrangementTempo = arrangement.global_tempo;
            this.modal.arrangementBars  = arrangement.total_bars;
            this.modal.tracks = tracks;
            this.modal.blocks = blocks;
            this._resetArrHistory();
            this.modal._selectedBlocks.clear();
            const f = (id, v) => { const el = this.modal.$(id); if (el) el.value = v; };
            f('#la-name-input', arrangement.name);
            f('#la-tempo',      arrangement.global_tempo);
            f('#la-bars',       arrangement.total_bars);
            this.modal._trackMute.clear();
            this.modal._trackSolo.clear();
            this.modal._arrangerStartBar = 0;
            this._renderTimeline();
            this._loadArrangements();   // refresh full list so other items remain visible
            return true;
        } catch (err) {
            LoopUtils.handleError(err, 'arr.load', {
                toast: this.modal.t('loopManager.errLoadArrangement')
            });
            return false;
        }
    }

    // =========================================================
    // ARRANGER — UNDO/REDO HISTORY (T3)
    // =========================================================

    // Delegates to view sub-feature (extracted per audit §1.3)
    _snapshotArr()                      { return this.view?._snapshotArr(); }
    _resetArrHistory()                  { return this.view?._resetArrHistory(); }
    _pushArrHistory()                   { return this.view?._pushArrHistory(); }
    _arrUndo()                          { return this.view?._arrUndo(); }
    _arrRedo()                          { return this.view?._arrRedo(); }
    _restoreArrSnapshot(snap)           { return this.view?._restoreArrSnapshot(snap); }
    _markArrDirty(dirty)                { return this.view?._markArrDirty(dirty); }
    _refreshUndoButtons()               { return this.view?._refreshUndoButtons(); }
    _renderPalette()                    { return this.view?._renderPalette(); }
    _renderTimeline()                   { return this.view?._renderTimeline(); }
    _renderMinimap()                    { return this.view?._renderMinimap(); }
    _renderRuler()                      { return this.view?._renderRuler(); }
    _renderArrangerStartMarker()        { return this.view?._renderArrangerStartMarker(); }
    _renderTracks()                     { return this.view?._renderTracks(); }
    _buildTrackEl(track)                { return this.view?._buildTrackEl(track); }
    _isTrackAudible(trackId)            { return this.view?._isTrackAudible(trackId) ?? true; }
    _toggleTrackMute(trackId)           { return this.view?._toggleTrackMute(trackId); }
    _toggleTrackSolo(trackId)           { return this.view?._toggleTrackSolo(trackId); }
    _buildCells(trackId, BAR_W)         { return this.view?._buildCells(trackId, BAR_W); }
    _toggleBlockSelection(blockId, additive) { return this.view?._toggleBlockSelection(blockId, additive); }
    _clearBlockSelection()              { return this.view?._clearBlockSelection(); }
    _refreshBlockSelectionUI()          { return this.view?._refreshBlockSelectionUI(); }
    async _deleteSelectedBlocks()       { return this.view?._deleteSelectedBlocks(); }
    _copySelectedBlocks()               { return this.view?._copySelectedBlocks(); }
    async _pasteBlocks(targetTrackId, targetBar) { return this.view?._pasteBlocks(targetTrackId, targetBar); }
    async _duplicateSelectedBlocks()    { return this.view?._duplicateSelectedBlocks(); }
    _nextFreeBar(trackId)               { return this.view?._nextFreeBar(trackId) ?? 0; }

    _barWidth() {
        const wrap = this.modal.$('#la-timeline-wrap');
        const available = (wrap?.clientWidth || 800) - 140;
        const base = Math.max(24, Math.min(60, Math.floor(available / this.modal.arrangementBars)));
        const zoomed = Math.round(base * (this.modal._arrangerZoom || 1));
        return Math.max(12, Math.min(240, zoomed));
    }

    _arrZoom(factor) {
        const next = Math.max(0.25, Math.min(8, (this.modal._arrangerZoom || 1) * factor));
        if (next === this.modal._arrangerZoom) return;
        this.modal._arrangerZoom = next;
        this._renderTimeline();
    }

    _arrZoomReset() {
        if (this.modal._arrangerZoom === 1 && this.modal._arrangerZoomV === 1) return;
        this.modal._arrangerZoom  = 1;
        this.modal._arrangerZoomV = 1;
        this._renderTimeline();
    }

    _arrZoomV(factor) {
        const next = Math.max(0.6, Math.min(3, (this.modal._arrangerZoomV || 1) * factor));
        if (next === this.modal._arrangerZoomV) return;
        this.modal._arrangerZoomV = next;
        this._renderTracks();
    }

    _trackHeight() {
        return Math.round(50 * (this.modal._arrangerZoomV || 1));
    }

    _toggleLoopPlayback() {
        this.modal._arrangerLoop = !this.modal._arrangerLoop;
        const btn = this.modal.$('#la-loop-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', this.modal._arrangerLoop ? 'true' : 'false');
            btn.classList.toggle('lc-btn-icon--active', this.modal._arrangerLoop);
        }
    }

    _toggleCountIn() {
        this.modal._arrangerCountIn = !this.modal._arrangerCountIn;
        const btn = this.modal.$('#la-countin-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', this.modal._arrangerCountIn ? 'true' : 'false');
            btn.classList.toggle('lc-btn-icon--active', this.modal._arrangerCountIn);
        }
    }

    _barFromX(offsetX, barW) {
        return Math.max(0, Math.min(this.modal.arrangementBars - 1, Math.floor(offsetX / barW)));
    }

    _showDropPreview(cells, bar, barW) {
        this._hideDropPreview();
        const info     = this.modal._dragInfo || {};
        const widthBars = Math.max(1, (info.loopBars || 1) * (info.reps || 1));
        const preview  = document.createElement('div');
        preview.className  = 'la-drop-preview';
        preview.style.left  = (bar * barW) + 'px';
        preview.style.width = (widthBars * barW) + 'px';
        if (bar + widthBars > this.modal.arrangementBars) preview.classList.add('la-drop-preview--overflow');
        cells.appendChild(preview);
        this.modal._dropPreview = preview;
    }

    _hideDropPreview() { this.modal._dropPreview?.remove(); this.modal._dropPreview = null; }

    // =========================================================
    // ARRANGER — CRUD
    // =========================================================

    // Delegates to ops sub-feature (extracted per audit §1.3)
    async _addTrack()                          { return this.ops?._addTrack(); }
    async _deleteTrack(trackId)                { return this.ops?._deleteTrack(trackId); }
    async _addBlock(trackId, loopId, positionBar, loopBars) { return this.ops?._addBlock(trackId, loopId, positionBar, loopBars); }
    async _moveBlock(blockId, newTrackId, newPositionBar)   { return this.ops?._moveBlock(blockId, newTrackId, newPositionBar); }
    async _changeReps(blockId, delta)          { return this.ops?._changeReps(blockId, delta); }
    async _deleteBlock(blockId)                { return this.ops?._deleteBlock(blockId); }
    async _saveArrangement(opts)               { return this.ops?._saveArrangement(opts); }
    async _deleteArrangement(id)               { return this.ops?._deleteArrangement(id); }
    async _duplicateArrangement(sourceId)      { return this.ops?._duplicateArrangement(sourceId); }
    _adjustArrTempo(d)                         { return this.ops?._adjustArrTempo(d); }
    _adjustArrBars(d)                          { return this.ops?._adjustArrBars(d); }
    async _playArrangement(startBar = 0)       { return this.ops?._playArrangement(startBar); }
    _scheduleCountIn(target, secPerBar)        { return this.ops?._scheduleCountIn(target, secPerBar); }
    _stopArrangerPlay()                        { return this.ops?._stopArrangerPlay(); }
    _startPlaybarRAF()                         { return this.ops?._startPlaybarRAF(); }
    _stopPlaybarRAF()                          { return this.ops?._stopPlaybarRAF(); }
    _renderArrangerPlayhead(elapsedSec)        { return this.ops?._renderArrangerPlayhead(elapsedSec); }
    _onDocMouseMove(e)                         { return this.ops?._onDocMouseMove(e); }
    async _onDocMouseUp()                      { return this.ops?._onDocMouseUp(); }
    _scheduleAutoSave(delayMs = 800)           { return this.ops?._scheduleAutoSave(delayMs); }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerArrangerFeature = LoopManagerArrangerFeature;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopManagerArrangerFeature;
    }
})();
