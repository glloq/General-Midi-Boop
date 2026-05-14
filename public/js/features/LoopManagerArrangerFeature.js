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
        const tracksEl = this.$('#la-tracks');
        const rulerEl  = this.$('#la-ruler');
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
        const el = this.$('#la-arr-list');
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
            const f = (id, v) => { const el = this.$(id); if (el) el.value = v; };
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

    _snapshotArr() {
        return {
            name:   this.modal.arrangementName,
            tempo:  this.modal.arrangementTempo,
            bars:   this.modal.arrangementBars,
            tracks: this.modal.tracks.map(t => ({ ...t })),
            blocks: this.modal.blocks.map(b => ({ ...b }))
        };
    }

    _resetArrHistory() {
        this.modal._arrHistory = [this._snapshotArr()];
        this.modal._arrHistoryIdx = 0;
        this._refreshUndoButtons();
        this._markArrDirty(false);
    }

    _pushArrHistory() {
        // Drop forward history if we branched
        this.modal._arrHistory = this.modal._arrHistory.slice(0, this.modal._arrHistoryIdx + 1);
        this.modal._arrHistory.push(this._snapshotArr());
        if (this.modal._arrHistory.length > ARRANGER_HISTORY_LIMIT) {
            this.modal._arrHistory.shift();
        } else {
            this.modal._arrHistoryIdx++;
        }
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _arrUndo() {
        if (this.modal._arrHistoryIdx <= 0) return;
        this.modal._arrHistoryIdx--;
        this._restoreArrSnapshot(this.modal._arrHistory[this.modal._arrHistoryIdx]);
    }

    _arrRedo() {
        if (this.modal._arrHistoryIdx >= this.modal._arrHistory.length - 1) return;
        this.modal._arrHistoryIdx++;
        this._restoreArrSnapshot(this.modal._arrHistory[this.modal._arrHistoryIdx]);
    }

    _restoreArrSnapshot(snap) {
        if (!snap) return;
        if (snap.name  !== undefined) this.modal.arrangementName  = snap.name;
        if (snap.tempo !== undefined) this.modal.arrangementTempo = snap.tempo;
        if (snap.bars  !== undefined) this.modal.arrangementBars  = snap.bars;
        this.modal.tracks = snap.tracks.map(t => ({ ...t }));
        this.modal.blocks = snap.blocks.map(b => ({ ...b }));
        this.modal._selectedBlocks.clear();
        // Sync inputs with restored metadata
        const setVal = (sel, v) => { const el = this.$(sel); if (el && v !== undefined) el.value = v; };
        setVal('#la-name-input', this.modal.arrangementName);
        setVal('#la-tempo',      this.modal.arrangementTempo);
        setVal('#la-bars',       this.modal.arrangementBars);
        // Prune mute/solo for tracks that no longer exist
        const ids = new Set(this.modal.tracks.map(t => t.id));
        for (const id of this.modal._trackMute) if (!ids.has(id)) this.modal._trackMute.delete(id);
        for (const id of this.modal._trackSolo) if (!ids.has(id)) this.modal._trackSolo.delete(id);
        this._renderTimeline();
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _markArrDirty(dirty) {
        this.modal._arrDirty = !!dirty;
        const saveBtn = this.$('#lc-header-save');
        if (saveBtn) saveBtn.classList.toggle('lc-btn--dirty', this.modal._arrDirty);
    }

    _refreshUndoButtons() {
        const u = this.$('#la-undo-btn');
        const r = this.$('#la-redo-btn');
        if (u) u.disabled = this.modal._arrHistoryIdx <= 0;
        if (r) r.disabled = this.modal._arrHistoryIdx >= this.modal._arrHistory.length - 1;
    }

    // =========================================================
    // ARRANGER — PALETTE
    // =========================================================

    _renderPalette() {
        const grid = this.$('#la-palette-grid');
        if (!grid) return;
        if (!this.modal.library.length) { grid.innerHTML = `<div class="lc-empty">${this.modal.t('loopCreator.libraryEmpty')}</div>`; return; }
        const q = (this.modal._paletteSearch || '').trim().toLowerCase();
        const items = q
            ? this.modal.library.filter(l => (l.name || '').toLowerCase().includes(q)
                  || (GM_PROGRAM_NAMES[l.instrument_program ?? 0] || '').toLowerCase().includes(q))
            : this.modal.library;
        if (!items.length) { grid.innerHTML = `<div class="lc-empty">${this.modal.t('loopManager.noResults')}</div>`; return; }
        grid.innerHTML = items.map(loop => {
            const family = LoopUtils.familyForProgram(loop.instrument_program ?? 0);
            return `<div class="la-palette-chip" draggable="true" data-loop-id="${loop.id}"
                data-loop-bars="${loop.bars}" data-loop-name="${this.modal.escape(loop.name)}"
                style="--family-color:${family.color}">
                <div class="la-chip-name">${this.modal._instrIconHtml(loop.instrument_program ?? 0, 'instrument', 'la-chip-icon')} ${this.modal.escape(loop.name)}</div>
                <div class="la-chip-meta">${loop.bars}${this.modal.t('loopCreator.barsUnit')}</div>
            </div>`;
        }).join('');
        grid.querySelectorAll('.la-palette-chip').forEach(chip => {
            chip.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                const loopBars = parseInt(chip.dataset.loopBars);
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    loopId: parseInt(chip.dataset.loopId),
                    loopBars,
                    loopName: chip.dataset.loopName
                }));
                this.modal._dragInfo = { type: 'palette', loopBars, reps: 1 };
            });
            chip.addEventListener('dragend', () => { this.modal._dragInfo = null; });
        });
    }

    // =========================================================
    // ARRANGER — TIMELINE
    // =========================================================

    _renderTimeline() { this._renderRuler(); this._renderTracks(); this._renderMinimap(); this._renderPalette(); this._refreshBlockSelectionUI(); }

    /**
     * Minimap d'aperçu canvas (compacte) au-dessus du timeline arranger.
     * Affiche l'arrangement entier dans une bande horizontale :
     *  - lignes horizontales = tracks
     *  - rectangles colorés = blocks (couleur famille GM)
     *  - rectangle viewport = portion actuellement visible dans le
     *    timeline scrollable
     *  - click/drag = scroll le timeline principal sur la position
     */
    _renderMinimap() {
        const canvas = this.$('#la-minimap');
        if (!canvas) return;
        const wrap = this.$('#la-timeline-wrap');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.clientWidth  || canvas.parentElement?.clientWidth || 600;
        const H = parseInt(canvas.getAttribute('height')) || 48;
        if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
            canvas.width  = W * dpr;
            canvas.height = H * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        ctx.clearRect(0, 0, W, H);

        const totalBars = Math.max(1, this.modal.arrangementBars);
        const trackCount = Math.max(1, this.modal.tracks?.length || 0);
        const barW   = W / totalBars;
        const rowH   = (H - 4) / trackCount;
        const trackIndexById = new Map((this.modal.tracks || []).map((t, i) => [t.id, i]));

        // Fond + grille très légère toutes les 4 mesures.
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        for (let b = 0; b <= totalBars; b += 4) {
            const x = b * barW;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }

        // Blocks.
        for (const block of (this.modal.blocks || [])) {
            const ti = trackIndexById.get(block.track_id);
            if (ti === undefined) continue;
            const x = block.position_bar * barW;
            const w = Math.max(1, block.loop_bars * block.repetitions * barW);
            const y = 2 + ti * rowH;
            const h = Math.max(2, rowH - 2);
            const loop = this.modal.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            ctx.fillStyle = family.color;
            ctx.fillRect(x, y, w, h);
        }

        // Viewport rectangle : portion visible du timeline scrollable.
        if (wrap) {
            const cellsBarW = this._barWidth();
            const tracksTotalW = cellsBarW * totalBars; // largeur du contenu cells (sans label)
            if (tracksTotalW > 0) {
                const scrollL = wrap.scrollLeft;
                const visibleW = wrap.clientWidth - 120; // soustrait labels sticky
                const viewStart = Math.max(0, scrollL / cellsBarW);
                const viewBars  = Math.min(totalBars - viewStart, visibleW / cellsBarW);
                ctx.strokeStyle = '#f5a623';
                ctx.lineWidth = 2;
                ctx.strokeRect(viewStart * barW + 1, 1, Math.max(2, viewBars * barW - 2), H - 2);
                ctx.fillStyle = 'rgba(245,166,35,0.10)';
                ctx.fillRect(viewStart * barW + 1, 1, Math.max(2, viewBars * barW - 2), H - 2);
            }
        }

        // Wire l'interaction une seule fois.
        if (!canvas.dataset.lcWired) {
            canvas.dataset.lcWired = '1';
            const seek = (clientX) => {
                const rect = canvas.getBoundingClientRect();
                const x = clientX - rect.left;
                const ratio = Math.max(0, Math.min(1, x / rect.width));
                const targetBar = ratio * this.modal.arrangementBars;
                const w = this.$('#la-timeline-wrap');
                if (!w) return;
                const cellsBarW = this._barWidth();
                w.scrollLeft = Math.max(0, targetBar * cellsBarW - (w.clientWidth - 120) / 2);
                this._renderMinimap();
            };
            let dragging = false;
            canvas.addEventListener('mousedown', (e) => { dragging = true; seek(e.clientX); });
            canvas.addEventListener('mousemove', (e) => { if (dragging) seek(e.clientX); });
            window.addEventListener('mouseup', () => { dragging = false; });
            wrap?.addEventListener('scroll', () => this._renderMinimap(), { passive: true });
            // Re-render à chaque resize de la modale
            const ro = new ResizeObserver(() => this._renderMinimap());
            ro.observe(canvas);
        }
    }

    _renderRuler() {
        const ruler = this.$('#la-ruler');
        if (!ruler) return;
        const BAR_W = this._barWidth();
        // Spacer 120px = largeur des track-labels, garantit que la 1ère
        // mesure du ruler est alignée avec le début des cells.
        let html = '<div class="la-ruler-spacer" aria-hidden="true"></div>';
        for (let b = 0; b < this.modal.arrangementBars; b++) {
            const marker = (b % 4 === 0) ? `<span class="la-ruler-label">${b+1}</span>` : '';
            html += `<div class="la-ruler-cell" data-ruler-bar="${b}" style="width:${BAR_W}px">${marker}</div>`;
        }
        ruler.style.width = (120 + BAR_W * this.modal.arrangementBars) + 'px';
        ruler.innerHTML = html;
        if (!ruler.dataset.lcWired) {
            ruler.dataset.lcWired = '1';
            ruler.title = this.modal.t('loopManager.rulerClickHint');
            ruler.style.cursor = 'pointer';
            ruler.addEventListener('click', (e) => {
                const cell = e.target.closest('[data-ruler-bar]');
                if (!cell) return;
                const bar = parseInt(cell.dataset.rulerBar);
                if (Number.isNaN(bar)) return;
                if (this.modal.isArrangerPlaying) {
                    this._stopArrangerPlay();
                    this._playArrangement(bar);
                } else {
                    this.modal._arrangerStartBar = bar;
                    this._renderArrangerStartMarker();
                }
            });
        }
        this._renderArrangerStartMarker();
    }

    _renderArrangerStartMarker() {
        const wrap = this.$('#la-timeline-wrap');
        if (!wrap) return;
        let marker = wrap.querySelector('.la-start-marker');
        if (this.modal._arrangerStartBar <= 0 || this.modal.isArrangerPlaying) {
            marker?.remove();
            return;
        }
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'la-start-marker';
            wrap.appendChild(marker);
        }
        const BAR_W  = this._barWidth();
        const labelW = this.$('.la-track-label')?.offsetWidth || 120;
        marker.style.transform = `translateX(${labelW + this.modal._arrangerStartBar * BAR_W}px)`;
    }

    _renderTracks() {
        const container = this.$('#la-tracks');
        if (!container) return;
        container.innerHTML = '';
        for (const track of this.modal.tracks) container.appendChild(this._buildTrackEl(track));
    }

    _buildTrackEl(track) {
        const BAR_W  = this._barWidth();
        const totalW = BAR_W * this.modal.arrangementBars;
        const muted  = this.modal._trackMute.has(track.id);
        const soloed = this.modal._trackSolo.has(track.id);
        const audible = this._isTrackAudible(track.id);
        const trackEl = document.createElement('div');
        trackEl.className = `la-track${muted ? ' la-track--muted' : ''}${soloed ? ' la-track--solo' : ''}${audible ? '' : ' la-track--silent'}`;
        trackEl.dataset.trackId = track.id;
        trackEl.style.height = this._trackHeight() + 'px';
        // Label par défaut « Piste N » côté client si le backend n'en a
        // pas posé (Phase 1 a vidé les labels par défaut pour i18n).
        const defaultLabel = this.modal.t('loopManager.defaultTrackName', { index: (track.track_index ?? 0) + 1 })
            || `Track ${(track.track_index ?? 0) + 1}`;
        const displayLabel = (track.label && track.label.trim()) || defaultLabel;
        trackEl.innerHTML = `
            <div class="la-track-label">
                <input type="text" class="la-track-name-input lc-name-input"
                    value="${this.modal.escape(displayLabel)}"
                    placeholder="${this.modal.escape(defaultLabel)}"
                    aria-label="${this.modal.t('loopManager.trackName') || 'Track name'}"
                    data-track-id="${track.id}" />
                <button class="la-track-toggle la-track-toggle--mute${muted ? ' la-track-toggle--active' : ''}"
                    data-track-action="mute" data-track-id="${track.id}"
                    aria-pressed="${muted}" title="${this.modal.t('loopManager.trackMute')}">M</button>
                <button class="la-track-toggle la-track-toggle--solo${soloed ? ' la-track-toggle--active' : ''}"
                    data-track-action="solo" data-track-id="${track.id}"
                    aria-pressed="${soloed}" title="${this.modal.t('loopManager.trackSolo')}">S</button>
                <button class="lc-card-btn lc-card-btn--danger" data-track-action="delete" data-track-id="${track.id}" title="${this.modal.t('loopCreator.deleteTrack')}">✕</button>
            </div>
            <div class="la-track-cells" data-track-id="${track.id}" style="width:${totalW}px">
                ${this._buildCells(track.id, BAR_W)}
            </div>`;

        const cells = trackEl.querySelector('.la-track-cells');
        cells.addEventListener('dragstart', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (!blockEl) return;
            const blockId = parseInt(blockEl.dataset.blockId);
            const block = this.modal.blocks.find(b => b.id === blockId);
            if (!block) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
                source:   'block',
                blockId,
                loopBars: block.loop_bars,
                reps:     block.repetitions
            }));
            blockEl.classList.add('la-block--dragging');
            this.modal._dragInfo = { type: 'block', loopBars: block.loop_bars, reps: block.repetitions };
        });
        cells.addEventListener('dragend', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) blockEl.classList.remove('la-block--dragging');
            this._hideDropPreview();
            this.modal._dragInfo = null;
        });
        cells.addEventListener('dragover',  (e) => {
            e.preventDefault();
            // dropEffect doit matcher effectAllowed posé au dragstart :
            // - palette chip / library card → effectAllowed='copy' → dropEffect='copy'
            // - block existant → effectAllowed='move' → dropEffect='move'
            // Firefox (strict HTML5 DnD spec) annule le drop si mismatch
            // → bouton drop pas firé.
            e.dataTransfer.dropEffect = (this.modal._dragInfo?.type === 'block') ? 'move' : 'copy';
            this._showDropPreview(cells, this._barFromX(e.offsetX, BAR_W), BAR_W);
        });
        cells.addEventListener('dragleave', () => this._hideDropPreview());
        cells.addEventListener('drop',      (e) => {
            e.preventDefault(); this._hideDropPreview();
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                const bar = this._barFromX(e.offsetX, BAR_W);
                if (data.source === 'block' && data.blockId) {
                    this._moveBlock(data.blockId, track.id, bar);
                } else if (data.loopId) {
                    this._addBlock(track.id, data.loopId, bar, data.loopBars || 2);
                }
            } catch (err) {
                LoopUtils.handleError(err, 'arr.drop.parse');
            }
        });

        // Resize handle — initiates a custom drag that updates repetitions live
        cells.addEventListener('mousedown', (e) => {
            const handle = e.target.closest('[data-block-resize]');
            if (!handle) return;
            e.preventDefault();
            e.stopPropagation();
            const blockEl = handle.closest('.la-block');
            const blockId = parseInt(handle.dataset.blockResize);
            const block   = this.modal.blocks.find(b => b.id === blockId);
            if (!block || !blockEl) return;
            const rect    = blockEl.getBoundingClientRect();
            this.modal._resizeState = {
                blockId,
                blockEl,
                leftPx:   rect.left,
                barW:     this._barWidth(),
                loopBars: block.loop_bars,
                origReps: block.repetitions,
                newReps:  block.repetitions
            };
            blockEl.classList.add('la-block--resizing');
        });

        // Wire block actions and selection (single delegated listener — no setTimeout race)
        cells.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('[data-block-action]');
            if (actionBtn) {
                e.stopPropagation();
                const bid = parseInt(actionBtn.dataset.blockId);
                if (actionBtn.dataset.blockAction === 'reps-inc') this._changeReps(bid, +1);
                if (actionBtn.dataset.blockAction === 'reps-dec') this._changeReps(bid, -1);
                if (actionBtn.dataset.blockAction === 'delete')   this._deleteBlock(bid);
                return;
            }
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) {
                const bid = parseInt(blockEl.dataset.blockId);
                this._toggleBlockSelection(bid, e.shiftKey || e.metaKey || e.ctrlKey);
            }
        });

        const nameInput = trackEl.querySelector('.la-track-name-input');
        nameInput?.addEventListener('change', async () => {
            try {
                await this.modal.api.sendCommand('arrangement_update_track', { trackId: track.id, label: nameInput.value });
                const t = this.modal.tracks.find(x => x.id === track.id);
                if (t) t.label = nameInput.value;
                this._pushArrHistory();
            } catch (err) {
                LoopUtils.handleError(err, 'arr.track.rename', {
                    toast: this.modal.t('loopManager.errSave')
                });
            }
        });
        trackEl.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => this._deleteTrack(track.id));
        trackEl.querySelector('[data-track-action="mute"]')?.addEventListener('click', () => this._toggleTrackMute(track.id));
        trackEl.querySelector('[data-track-action="solo"]')?.addEventListener('click', () => this._toggleTrackSolo(track.id));
        // Le sélecteur de canal MIDI a été retiré du header de track : le
        // routing canal est automatiquement géré par _playArrangement
        // (allocation dynamique selon les programmes utilisés).
        return trackEl;
    }

    _isTrackAudible(trackId) {
        if (this.modal._trackMute.has(trackId)) return false;
        if (this.modal._trackSolo.size > 0)     return this.modal._trackSolo.has(trackId);
        return true;
    }

    _toggleTrackMute(trackId) {
        if (this.modal._trackMute.has(trackId)) this.modal._trackMute.delete(trackId);
        else                              this.modal._trackMute.add(trackId);
        this._renderTracks();
    }

    _toggleTrackSolo(trackId) {
        if (this.modal._trackSolo.has(trackId)) this.modal._trackSolo.delete(trackId);
        else                              this.modal._trackSolo.add(trackId);
        this._renderTracks();
    }

    _buildCells(trackId, BAR_W) {
        let html = '';
        this.modal.blocks.filter(b => b.track_id === trackId).forEach((block) => {
            const loop   = this.modal.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            const blockW = block.loop_bars * block.repetitions * BAR_W;
            const blockL = block.position_bar * BAR_W;
            const selected = this.modal._selectedBlocks.has(block.id);
            const endBar   = block.position_bar + block.loop_bars * block.repetitions;
            const overflow = endBar > this.modal.arrangementBars;
            const classes  = ['la-block'];
            if (selected) classes.push('la-block--selected');
            if (overflow) classes.push('la-block--overflow');
            const title = overflow
                ? this.modal.t('loopManager.blockOverflow', { end: endBar, total: this.modal.arrangementBars })
                : this.modal.t('loopManager.blockDragHint');
            html += `<div class="${classes.join(' ')}"
                draggable="true" data-block-id="${block.id}" data-loop-bars="${block.loop_bars}"
                data-block-reps="${block.repetitions}"
                data-wide="${blockW >= 70 ? 'true' : 'false'}"
                style="left:${blockL}px;width:${blockW}px;background:${family.color}"
                title="${title}">
                <div class="la-block-label">${this.modal._instrIconHtml(loop?.instrument_program ?? 0, 'instrument', 'la-block-icon')} ${this.modal.escape(block.loop_name)} ×${block.repetitions}${overflow ? ' ⚠' : ''}</div>
                <div class="la-block-actions">
                    <button class="la-block-btn" draggable="false" data-block-action="reps-dec" data-block-id="${block.id}">−</button>
                    <span class="la-block-reps">${block.repetitions}</span>
                    <button class="la-block-btn" draggable="false" data-block-action="reps-inc" data-block-id="${block.id}">+</button>
                    <button class="la-block-btn la-block-btn--del" draggable="false" data-block-action="delete" data-block-id="${block.id}" title="${this.modal.t('loopCreator.deleteBlock')}">✕</button>
                </div>
                <div class="la-block-resize" draggable="false" data-block-resize="${block.id}" title="${this.modal.t('loopManager.dragToResize')}"></div>
            </div>`;
        });
        return html;
    }

    _toggleBlockSelection(blockId, additive) {
        if (additive) {
            if (this.modal._selectedBlocks.has(blockId)) this.modal._selectedBlocks.delete(blockId);
            else this.modal._selectedBlocks.add(blockId);
        } else {
            const onlyOne = this.modal._selectedBlocks.size === 1 && this.modal._selectedBlocks.has(blockId);
            this.modal._selectedBlocks.clear();
            if (!onlyOne) this.modal._selectedBlocks.add(blockId);
        }
        this._refreshBlockSelectionUI();
    }

    _clearBlockSelection() {
        if (!this.modal._selectedBlocks.size) return;
        this.modal._selectedBlocks.clear();
        this._refreshBlockSelectionUI();
    }

    _refreshBlockSelectionUI() {
        this.$$('.la-block').forEach(el => {
            const bid = parseInt(el.dataset.blockId);
            el.classList.toggle('la-block--selected', this.modal._selectedBlocks.has(bid));
        });
    }

    async _deleteSelectedBlocks() {
        const ids = [...this.modal._selectedBlocks];
        if (!ids.length) return;
        for (const bid of ids) {
            try {
                await this.modal.api.sendCommand('arrangement_delete_block', { blockId: bid });
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.deleteMulti', {
                    toast: this.modal.t('loopManager.errSave')
                });
            }
        }
        this.modal.blocks = this.modal.blocks.filter(b => !this.modal._selectedBlocks.has(b.id));
        this.modal._selectedBlocks.clear();
        this._renderTimeline();
        this._pushArrHistory();
    }

    _copySelectedBlocks() {
        const sel = this.modal.blocks.filter(b => this.modal._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const minBar = Math.min(...sel.map(b => b.position_bar));
        const tracksOrder = this.modal.tracks.map(t => t.id);
        const minTrackIdx = Math.min(...sel.map(b => tracksOrder.indexOf(b.track_id)));
        this.modal._blockClipboard = sel.map(b => ({
            loop_id:        b.loop_id,
            loop_name:      b.loop_name,
            loop_bars:      b.loop_bars,
            repetitions:    b.repetitions,
            track_offset:   tracksOrder.indexOf(b.track_id) - minTrackIdx,
            bar_offset:     b.position_bar - minBar
        }));
        LoopUtils.toast?.(this.modal.t('loopManager.blocksCopied', { count: sel.length }), 'info');
    }

    async _pasteBlocks(targetTrackId = null, targetBar = null) {
        if (!this.modal._blockClipboard.length || !this.modal.currentArrangementId) return;
        const tracksOrder = this.modal.tracks.map(t => t.id);
        if (!tracksOrder.length) return;
        // Default paste anchor: after the rightmost existing block on the first track
        const baseTrackIdx = targetTrackId != null
            ? Math.max(0, tracksOrder.indexOf(targetTrackId))
            : 0;
        const baseBar = targetBar != null
            ? targetBar
            : this._nextFreeBar(tracksOrder[baseTrackIdx]);
        const newBlocks = [];
        for (const item of this.modal._blockClipboard) {
            const trackIdx = Math.min(tracksOrder.length - 1, baseTrackIdx + item.track_offset);
            const trackId  = tracksOrder[trackIdx];
            const posBar   = Math.max(0, Math.min(this.modal.arrangementBars - 1, baseBar + item.bar_offset));
            try {
                const r = await this.modal.api.sendCommand('arrangement_add_block', {
                    trackId, loopId: item.loop_id, position_bar: posBar, repetitions: item.repetitions
                });
                const created = {
                    id: r.blockId, track_id: trackId, loop_id: item.loop_id,
                    position_bar: posBar, repetitions: item.repetitions,
                    loop_name: item.loop_name, loop_bars: item.loop_bars
                };
                this.modal.blocks.push(created);
                newBlocks.push(created.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.paste', {
                    toast: this.modal.t('loopManager.errSave')
                });
            }
        }
        if (newBlocks.length) {
            this.modal._selectedBlocks = new Set(newBlocks);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    async _duplicateSelectedBlocks() {
        const sel = this.modal.blocks.filter(b => this.modal._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const newIds = [];
        for (const b of sel) {
            const span     = b.loop_bars * b.repetitions;
            const posBar   = Math.max(0, Math.min(this.modal.arrangementBars - 1, b.position_bar + span));
            try {
                const r = await this.modal.api.sendCommand('arrangement_add_block', {
                    trackId: b.track_id, loopId: b.loop_id, position_bar: posBar, repetitions: b.repetitions
                });
                const dup = {
                    id: r.blockId, track_id: b.track_id, loop_id: b.loop_id,
                    position_bar: posBar, repetitions: b.repetitions,
                    loop_name: b.loop_name, loop_bars: b.loop_bars
                };
                this.modal.blocks.push(dup);
                newIds.push(dup.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.duplicate', {
                    toast: this.modal.t('loopManager.errSave')
                });
            }
        }
        if (newIds.length) {
            this.modal._selectedBlocks = new Set(newIds);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    _nextFreeBar(trackId) {
        let end = 0;
        for (const b of this.modal.blocks) {
            if (b.track_id !== trackId) continue;
            const e = b.position_bar + b.loop_bars * b.repetitions;
            if (e > end) end = e;
        }
        return Math.min(end, Math.max(0, this.modal.arrangementBars - 1));
    }

    _barWidth() {
        const wrap = this.$('#la-timeline-wrap');
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
        const btn = this.$('#la-loop-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', this.modal._arrangerLoop ? 'true' : 'false');
            btn.classList.toggle('lc-btn-icon--active', this.modal._arrangerLoop);
        }
    }

    _toggleCountIn() {
        this.modal._arrangerCountIn = !this.modal._arrangerCountIn;
        const btn = this.$('#la-countin-btn');
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

    async _addTrack() {
        if (!this.modal.currentArrangementId) return;
        const label = `Track ${this.modal.tracks.length + 1}`;
        try {
            const r = await this.modal.api.sendCommand('arrangement_add_track', {
                arrangementId: this.modal.currentArrangementId,
                label
            });
            this.modal.tracks.push({
                id: r.trackId,
                arrangement_id: this.modal.currentArrangementId,
                track_index: this.modal.tracks.length,
                label,
                midi_channel: 1
            });
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.add', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _deleteTrack(trackId) {
        try {
            await this.modal.api.sendCommand('arrangement_delete_track', { trackId });
            this.modal.tracks = this.modal.tracks.filter(t => t.id !== trackId);
            this.modal.blocks = this.modal.blocks.filter(b => b.track_id !== trackId);
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.delete', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _addBlock(trackId, loopId, positionBar, loopBars) {
        try {
            const r = await this.modal.api.sendCommand('arrangement_add_block', {
                trackId, loopId, position_bar: positionBar, repetitions: 1
            });
            const loop = this.modal.library.find(l => l.id === loopId);
            this.modal.blocks.push({
                id: r.blockId, track_id: trackId, loop_id: loopId,
                position_bar: positionBar, repetitions: 1,
                loop_name: loop?.name || '?', loop_bars: loop?.bars || loopBars
            });
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.add', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _moveBlock(blockId, newTrackId, newPositionBar) {
        const block = this.modal.blocks.find(b => b.id === blockId);
        if (!block) return;
        if (block.track_id === newTrackId && block.position_bar === newPositionBar) return;
        try {
            await this.modal.api.sendCommand('arrangement_update_block', {
                blockId,
                track_id: newTrackId,
                position_bar: newPositionBar
            });
            block.track_id     = newTrackId;
            block.position_bar = newPositionBar;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.move', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _changeReps(blockId, delta) {
        const block = this.modal.blocks.find(b => b.id === blockId);
        if (!block) return;
        const newReps = Math.max(1, block.repetitions + delta);
        try {
            await this.modal.api.sendCommand('arrangement_update_block', { blockId, repetitions: newReps });
            block.repetitions = newReps;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.update', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _deleteBlock(blockId) {
        try {
            await this.modal.api.sendCommand('arrangement_delete_block', { blockId });
            this.modal.blocks = this.modal.blocks.filter(b => b.id !== blockId);
            this.modal._selectedBlocks.delete(blockId);
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.delete', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _saveArrangement({ silent = false } = {}) {
        this.modal.arrangementName = this.$('#la-name-input')?.value?.trim() || this.modal.t('loopCreator.untitledArrangement');
        const tempo = LoopUtils.validate.tempo(this.$('#la-tempo')?.value, this.modal.arrangementTempo);
        const bars  = LoopUtils.validate.arrBars(this.$('#la-bars')?.value, this.modal.arrangementBars);
        try {
            if (this.modal.currentArrangementId) {
                await this.modal.api.sendCommand('arrangement_update', {
                    arrangementId: this.modal.currentArrangementId,
                    name: this.modal.arrangementName, global_tempo: tempo, total_bars: bars
                });
                await this._loadArrangements();
                this._markArrDirty(false);
                if (!silent) LoopUtils.toast(this.modal.t('loopCreator.statusSaved'), 'success');
            }
        } catch (err) {
            LoopUtils.handleError(err, 'arr.save', {
                toast: `${this.modal.t('loopCreator.statusError')}: ${err.message}`
            });
        }
    }

    async _deleteArrangement(id) {
        try {
            await this.modal.api.sendCommand('arrangement_delete', { arrangementId: id });
            if (this.modal.currentArrangementId === id) await this._newArrangement();
            await this._loadArrangements();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.delete', {
                toast: this.modal.t('loopManager.errSave')
            });
        }
    }

    async _duplicateArrangement(sourceId) {
        if (this.modal._arrDirty && !confirm(this.modal.t('loopManager.confirmSwitchArrangement'))) return;
        try {
            const r = await this.modal.api.sendCommand('arrangement_get', { arrangementId: sourceId });
            const { arrangement, tracks, blocks } = r;
            const create = await this.modal.api.sendCommand('arrangement_create', {
                name: this.modal.t('loopManager.copySuffix', { name: arrangement.name }),
                global_tempo: arrangement.global_tempo,
                total_bars:   arrangement.total_bars
            });
            const newId = create.arrangementId;
            // _create auto-adds 3 default tracks — remove them first
            const created = await this.modal.api.sendCommand('arrangement_get', { arrangementId: newId });
            for (const t of created.tracks) {
                await this.modal.api.sendCommand('arrangement_delete_track', { trackId: t.id });
            }
            // Recreate source tracks (keeping order) and remember the id mapping
            const trackIdMap = new Map();
            for (let i = 0; i < tracks.length; i++) {
                const src = tracks[i];
                const tr = await this.modal.api.sendCommand('arrangement_add_track', {
                    arrangementId: newId,
                    label: src.label,
                    midi_channel: src.midi_channel,
                    track_index: i
                });
                trackIdMap.set(src.id, tr.trackId);
            }
            // Recreate blocks
            for (const b of blocks) {
                const newTrackId = trackIdMap.get(b.track_id);
                if (!newTrackId) continue;
                await this.modal.api.sendCommand('arrangement_add_block', {
                    trackId: newTrackId,
                    loopId:  b.loop_id,
                    position_bar: b.position_bar,
                    repetitions: b.repetitions
                });
            }
            await this._loadArrangementById(newId);
            LoopUtils.toast?.(this.modal.t('loopManager.arrangementDuplicated'), 'success');
        } catch (err) {
            LoopUtils.handleError(err, 'arr.duplicate', {
                toast: this.modal.t('loopManager.errDuplicateArrangement')
            });
        }
    }

    _adjustArrTempo(d) {
        const prev = this.modal.arrangementTempo;
        this.modal.arrangementTempo = LoopUtils.validate.tempo(prev + d, prev);
        const el = this.$('#la-tempo'); if (el) el.value = this.modal.arrangementTempo;
        if (this.modal.arrangementTempo !== prev) {
            this._markArrDirty(true);
            this._scheduleAutoSave();
        }
    }

    _adjustArrBars(d) {
        const prev = this.modal.arrangementBars;
        this.modal.arrangementBars = LoopUtils.validate.arrBars(prev + d, prev);
        const el = this.$('#la-bars'); if (el) el.value = this.modal.arrangementBars;
        if (this.modal.arrangementBars !== prev) {
            this._renderTimeline();
            this._pushArrHistory();
            this._scheduleAutoSave();
        }
    }

    // =========================================================
    // ARRANGER — PLAYBACK
    // =========================================================

    async _playArrangement(startBar = 0) {
        if (!this.modal.currentArrangementId || this.modal.isArrangerPlaying) return;
        this._stopArrangerPlay();
        this.modal.isArrangerPlaying = true;
        this.$('#la-play-btn')?.classList.add('lc-btn-record--active');

        const secPerBar  = 60 / this.modal.arrangementTempo * 4;
        this.modal._arrangerStartBar = Math.max(0, Math.min(this.modal.arrangementBars - 1, startBar | 0));
        const startSec   = this.modal._arrangerStartBar * secPerBar;
        const totalSec   = this.modal.arrangementBars * secPerBar;
        const events = [];
        const programsToLoad = new Set([0]);

        for (const block of this.modal.blocks) {
            if (!this._isTrackAudible(block.track_id)) continue;
            const loopData = await this.modal._fetchLoopData(block.loop_id);
            if (!loopData) continue;
            const prog      = loopData.instrument_program ?? 0;
            programsToLoad.add(prog);
            const seq       = LoopUtils.parseSequence(loopData.midi_data);
            const loopTempo = loopData.tempo || 120;
            const loopPPQ   = loopData.ppq   || 480;
            const spt       = 60 / (loopTempo * loopPPQ);
            const loopDurSec = loopData.bars * (60 / loopTempo) * 4;
            for (let rep = 0; rep < block.repetitions; rep++) {
                const offsetSec = block.position_bar * secPerBar + rep * loopDurSec;
                for (const note of seq) {
                    const evSec = offsetSec + note.t * spt;
                    if (evSec < startSec || evSec >= totalSec) continue;
                    events.push({
                        sec: evSec - startSec,
                        note: note.n, vel: note.v || 80,
                        durSec: (note.g || note.l || 120) * spt,
                        prog,
                        trackId: block.track_id
                    });
                }
            }
        }

        // Garde-fou : on ne peut router que 16 programmes distincts (canaux
        // MIDI 0-15). Au-delà, l'ancien code faisait `chIdx++ % 16` et
        // écrasait silencieusement les premiers canaux → instruments
        // sortaient avec le mauvais son (AUDIT §L4). Mieux vaut refuser
        // explicitement la lecture que la fausser.
        const MAX_DISTINCT_PROGRAMS = 16;
        if (programsToLoad.size > MAX_DISTINCT_PROGRAMS) {
            LoopUtils.toast(
                this.modal.t('loopManager.errTooManyPrograms', { max: MAX_DISTINCT_PROGRAMS, count: programsToLoad.size })
                    || `Arrangement uses ${programsToLoad.size} distinct programs (max ${MAX_DISTINCT_PROGRAMS}). Playback cancelled.`,
                'error'
            );
            this.modal.isArrangerPlaying = false;
            this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }

        const target = this.modal._getOutputTarget(this.modal._arrangerSynth);

        // Preload all instruments used. Drum kits (prog ≥ 128) passent
        // par loadDrumKit() — loadInstrument() les traiterait comme un
        // programme mélodique et ne chargerait pas les samples de batterie.
        if (target) {
            for (const prog of programsToLoad) {
                if (prog >= 128) {
                    target.setChannelInstrument?.(9, prog);
                    await target.loadDrumKit?.().catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadDrumKit'));
                } else if (!target.loadedInstruments?.has(prog)) {
                    await target.loadInstrument(prog).catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadInstrument'));
                }
            }
        }

        // Allocate channels: tracks with a custom midi_channel keep theirs;
        // remaining programs auto-assign onto the rest.
        const trackChMap = new Map();   // trackId → channel
        const usedCh     = new Set();
        for (const t of this.modal.tracks) {
            const ch = (t.midi_channel ?? 0);
            if (ch > 0 && ch <= 16 && !usedCh.has(ch - 1)) {
                trackChMap.set(t.id, ch - 1);
                usedCh.add(ch - 1);
            }
        }
        // Second garde-fou (AUDIT §L4) : programmes + canaux pré-réservés
        // par les tracks ne doivent pas dépasser 16 au total. Le check
        // initial sur programsToLoad.size > 16 ne couvrait pas le cas où
        // des tracks revendiquent un midi_channel personnalisé (usedCh).
        if (programsToLoad.size + usedCh.size > 16) {
            LoopUtils.toast(
                this.modal.t('loopManager.errTooManyPrograms', {
                    max: 16 - usedCh.size,
                    count: programsToLoad.size
                }) || `Arrangement needs ${programsToLoad.size + usedCh.size} MIDI channels (max 16). Playback cancelled.`,
                'error'
            );
            this.modal.isArrangerPlaying = false;
            this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }
        // Drum programs (prog ≥ 128) sont épinglés sur le canal 9 (canal GM
        // drums) ; le synth ne reconnaît un kit que là. On réserve donc
        // le canal 9 avant d'auto-allouer les autres programmes pour éviter
        // qu'un instrument mélodique ne le récupère.
        const programChannelMap = new Map();
        const hasDrumProgram = [...programsToLoad].some(p => p >= 128);
        if (hasDrumProgram) usedCh.add(9);
        let chIdx = 0;
        const nextFreeCh = () => {
            while (chIdx < 16 && usedCh.has(chIdx)) chIdx++;
            const c = chIdx % 16;
            chIdx++;
            return c;
        };
        for (const prog of programsToLoad) {
            const ch = prog >= 128 ? 9 : nextFreeCh();
            programChannelMap.set(prog, ch);
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument'); }
        }
        // Set per-track channel programs (channel hosts that track's loop progs)
        for (const [trackId, ch] of trackChMap) {
            // Use the first block on that track to determine which program to load
            const block = this.modal.blocks.find(b => b.track_id === trackId);
            if (!block) continue;
            const loop = this.modal.library.find(l => l.id === block.loop_id);
            const prog = loop?.instrument_program ?? 0;
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument.track'); }
        }

        const scheduleEvents = (offsetMs) => {
            for (const ev of events) {
                // Drum events ignorent l'override midi_channel du track :
                // ils DOIVENT sortir sur le canal 9 pour que le synth les
                // route via drumPresets au lieu du chemin mélodique.
                const ch = ev.prog >= 128
                    ? 9
                    : (trackChMap.has(ev.trackId)
                        ? trackChMap.get(ev.trackId)
                        : (programChannelMap.get(ev.prog) ?? 0));
                this.modal._arrangerTimers.push(setTimeout(() => {
                    if (!this.modal.isArrangerPlaying) return;
                    try { target?.playNote?.(ev.note, ev.vel, ch, ev.durSec); }
                    catch (err) { LoopUtils.handleError(err, 'arr.synth.playNote'); }
                }, offsetMs + ev.sec * 1000));
            }
        };

        events.sort((a, b) => a.sec - b.sec);

        const countInMs = this.modal._arrangerCountIn ? secPerBar * 1000 : 0;
        const playableMs = (totalSec - startSec) * 1000;

        if (this.modal._arrangerCountIn) {
            this._scheduleCountIn(target, secPerBar);
            // Le count-in réécrit channel 9 avec le Woodblock (programme 115).
            // S'il y a un drum kit dans l'arrangement, on restaure son programme
            // juste avant que les notes drum ne démarrent, sinon le synth
            // utilisera kit 115 au lieu du kit choisi par l'utilisateur.
            if (hasDrumProgram) {
                const drumProg = [...programsToLoad].find(p => p >= 128);
                this.modal._arrangerTimers.push(setTimeout(() => {
                    if (!this.modal.isArrangerPlaying) return;
                    try { target?.setChannelInstrument?.(9, drumProg); }
                    catch (err) { LoopUtils.handleError(err, 'arr.restoreDrumProg'); }
                }, Math.max(0, countInMs - 5)));
            }
        }
        scheduleEvents(countInMs);

        if (this.modal._arrangerLoop) {
            // Re-arm playback when the iteration completes (cooperative loop)
            this.modal._arrangerTimers.push(setTimeout(() => {
                if (!this.modal.isArrangerPlaying) return;
                this.modal.isArrangerPlaying = false;
                this.modal._arrangerTimers.forEach(t => clearTimeout(t));
                this.modal._arrangerTimers = [];
                this._playArrangement(0);
            }, countInMs + playableMs));
        } else {
            this.modal._arrangerTimers.push(setTimeout(() => this._stopArrangerPlay(), countInMs + playableMs));
        }

        this.modal._arrangerStartTime = performance.now() + countInMs;
        this._startPlaybarRAF();
    }

    _scheduleCountIn(target, secPerBar) {
        // 4 clicks (a beat) using GM Woodblock (program 115) on channel 9
        const ch = 9;
        try { target?.setChannelInstrument?.(ch, 115); }
        catch (err) { LoopUtils.handleError(err, 'arr.countIn.setProgram'); }
        const beatMs = (secPerBar / 4) * 1000;
        for (let i = 0; i < 4; i++) {
            this.modal._arrangerTimers.push(setTimeout(() => {
                if (!this.modal.isArrangerPlaying) return;
                try { target?.playNote?.(76, 100, ch, 0.08); }
                catch (err) { LoopUtils.handleError(err, 'arr.countIn.playNote'); }
            }, i * beatMs));
        }
    }

    _stopArrangerPlay() {
        this.modal._arrangerTimers.forEach(t => clearTimeout(t));
        this.modal._arrangerTimers = [];
        this.modal.isArrangerPlaying = false;
        this.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
        try { this.modal._arrangerSynth?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.synth.cancelAllNotes'); }
        try { this.modal._deviceShim?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.device.cancelAllNotes'); }
        this._stopPlaybarRAF();
        this.modal._renderPlaybar();
        this._renderArrangerStartMarker();
    }

    // =========================================================
    // PLAYBACK TIMELINE BAR
    // =========================================================

    _startPlaybarRAF() {
        if (this.modal._playbarRAF) return;
        const tick = () => {
            this.modal._renderPlaybar();
            if (this.modal.isArrangerPlaying) {
                this.modal._playbarRAF = requestAnimationFrame(tick);
            } else {
                this.modal._playbarRAF = null;
            }
        };
        this.modal._playbarRAF = requestAnimationFrame(tick);
    }

    _stopPlaybarRAF() {
        if (this.modal._playbarRAF) { cancelAnimationFrame(this.modal._playbarRAF); this.modal._playbarRAF = null; }
    }

    _renderArrangerPlayhead(elapsedSec) {
        const ph = this.$('#la-playhead');
        if (!ph) return;
        if (elapsedSec == null || !this.modal.isArrangerPlaying) {
            ph.style.display = 'none';
            return;
        }
        const BAR_W = this._barWidth();
        const secPerBar = 60 / this.modal.arrangementTempo * 4;
        const bar = Math.min(this.modal.arrangementBars, this.modal._arrangerStartBar + elapsedSec / secPerBar);
        const labelW = this.$('.la-track-label')?.offsetWidth || 120;
        ph.style.display = 'block';
        ph.style.transform = `translateX(${labelW + bar * BAR_W}px)`;
    }


    _onDocMouseMove(e) {
        const r = this.modal._resizeState;
        if (!r) return;
        // Recalcul à chaque move : barW peut avoir changé (resize fenêtre,
        // zoom changé via raccourci), et leftPx peut s'être décalé (scroll
        // horizontal du container). Le coût d'un getBoundingClientRect par
        // mousemove est négligeable comparé à un décalage de plusieurs
        // mesures pendant un drag (AUDIT §L3).
        const curRect = r.blockEl.getBoundingClientRect();
        const curBarW = this._barWidth();
        if (curBarW > 0) r.barW = curBarW;
        r.leftPx = curRect.left;
        const widthPx     = Math.max(r.barW, e.clientX - r.leftPx);
        const newReps     = Math.max(1, Math.round(widthPx / (r.loopBars * r.barW)));
        if (newReps === r.newReps) return;
        r.newReps = newReps;
        const w = r.loopBars * newReps * r.barW;
        r.blockEl.style.width = w + 'px';
        const repsLabel = r.blockEl.querySelector('.la-block-reps');
        if (repsLabel) repsLabel.textContent = newReps;
        const nameLabel = r.blockEl.querySelector('.la-block-label');
        if (nameLabel) {
            const block = this.modal.blocks.find(b => b.id === r.blockId);
            const overflow = block && (block.position_bar + r.loopBars * newReps > this.modal.arrangementBars);
            r.blockEl.classList.toggle('la-block--overflow', !!overflow);
        }
        r.blockEl.dataset.wide = w >= 70 ? 'true' : 'false';
    }

    async _onDocMouseUp() {
        const r = this.modal._resizeState;
        if (!r) return;
        this.modal._resizeState = null;
        r.blockEl.classList.remove('la-block--resizing');
        if (r.newReps === r.origReps) return;
        try {
            await this.modal.api.sendCommand('arrangement_update_block', {
                blockId: r.blockId, repetitions: r.newReps
            });
            const block = this.modal.blocks.find(b => b.id === r.blockId);
            if (block) block.repetitions = r.newReps;
            this._renderTimeline();
            this._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.resize', {
                toast: this.modal.t('loopManager.errSave')
            });
            this._renderTimeline();
        }
    }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerArrangerFeature = LoopManagerArrangerFeature;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopManagerArrangerFeature;
    }
})();
