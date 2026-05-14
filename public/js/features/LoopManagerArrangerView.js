// ============================================================================
// File: public/js/features/LoopManagerArrangerView.js
// Description: Arranger UI — history (undo/redo), rendering (palette,
//   timeline, ruler, minimap, tracks, blocks) and selection/clipboard
//   ops. Extracted from LoopManagerArrangerFeature per audit §1.3
//   (god-class split).
//
// Owns:
//   - Undo/redo & dirty flag: _snapshotArr, _resetArrHistory,
//     _pushArrHistory, _arrUndo, _arrRedo, _restoreArrSnapshot,
//     _markArrDirty, _refreshUndoButtons.
//   - Rendering: _renderPalette, _renderTimeline, _renderMinimap,
//     _renderRuler, _renderArrangerStartMarker, _renderTracks,
//     _buildTrackEl, _buildCells, _isTrackAudible, _toggleTrackMute,
//     _toggleTrackSolo.
//   - Selection / clipboard: _toggleBlockSelection,
//     _clearBlockSelection, _refreshBlockSelectionUI,
//     _deleteSelectedBlocks, _copySelectedBlocks, _pasteBlocks,
//     _duplicateSelectedBlocks, _nextFreeBar.
//
// Accessed via `arrangerFeature.view`. LoopManagerArrangerFeature keeps
// thin delegates so external callers (LoopCreatorModal one-liners) are
// unchanged.
// ============================================================================

(function () {
    'use strict';

    // Mirror of the constant in LoopManagerArrangerFeature's IIFE — declared
    // here too because IIFE scopes don't bleed across separate <script> files.
    const ARRANGER_HISTORY_LIMIT = 50;

    class LoopManagerArrangerView {
        /** @param {LoopManagerArrangerFeature} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

    _snapshotArr() {
        return {
            name:   this.parent.modal.arrangementName,
            tempo:  this.parent.modal.arrangementTempo,
            bars:   this.parent.modal.arrangementBars,
            tracks: this.parent.modal.tracks.map(t => ({ ...t })),
            blocks: this.parent.modal.blocks.map(b => ({ ...b }))
        };
    }

    _resetArrHistory() {
        this.parent.modal._arrHistory = [this._snapshotArr()];
        this.parent.modal._arrHistoryIdx = 0;
        this._refreshUndoButtons();
        this._markArrDirty(false);
    }

    _pushArrHistory() {
        // Drop forward history if we branched
        this.parent.modal._arrHistory = this.parent.modal._arrHistory.slice(0, this.parent.modal._arrHistoryIdx + 1);
        this.parent.modal._arrHistory.push(this._snapshotArr());
        if (this.parent.modal._arrHistory.length > ARRANGER_HISTORY_LIMIT) {
            this.parent.modal._arrHistory.shift();
        } else {
            this.parent.modal._arrHistoryIdx++;
        }
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _arrUndo() {
        if (this.parent.modal._arrHistoryIdx <= 0) return;
        this.parent.modal._arrHistoryIdx--;
        this._restoreArrSnapshot(this.parent.modal._arrHistory[this.parent.modal._arrHistoryIdx]);
    }

    _arrRedo() {
        if (this.parent.modal._arrHistoryIdx >= this.parent.modal._arrHistory.length - 1) return;
        this.parent.modal._arrHistoryIdx++;
        this._restoreArrSnapshot(this.parent.modal._arrHistory[this.parent.modal._arrHistoryIdx]);
    }

    _restoreArrSnapshot(snap) {
        if (!snap) return;
        if (snap.name  !== undefined) this.parent.modal.arrangementName  = snap.name;
        if (snap.tempo !== undefined) this.parent.modal.arrangementTempo = snap.tempo;
        if (snap.bars  !== undefined) this.parent.modal.arrangementBars  = snap.bars;
        this.parent.modal.tracks = snap.tracks.map(t => ({ ...t }));
        this.parent.modal.blocks = snap.blocks.map(b => ({ ...b }));
        this.parent.modal._selectedBlocks.clear();
        // Sync inputs with restored metadata
        const setVal = (sel, v) => { const el = this.parent.modal.$(sel); if (el && v !== undefined) el.value = v; };
        setVal('#la-name-input', this.parent.modal.arrangementName);
        setVal('#la-tempo',      this.parent.modal.arrangementTempo);
        setVal('#la-bars',       this.parent.modal.arrangementBars);
        // Prune mute/solo for tracks that no longer exist
        const ids = new Set(this.parent.modal.tracks.map(t => t.id));
        for (const id of this.parent.modal._trackMute) if (!ids.has(id)) this.parent.modal._trackMute.delete(id);
        for (const id of this.parent.modal._trackSolo) if (!ids.has(id)) this.parent.modal._trackSolo.delete(id);
        this._renderTimeline();
        this._refreshUndoButtons();
        this._markArrDirty(true);
    }

    _markArrDirty(dirty) {
        this.parent.modal._arrDirty = !!dirty;
        const saveBtn = this.parent.modal.$('#lc-header-save');
        if (saveBtn) saveBtn.classList.toggle('lc-btn--dirty', this.parent.modal._arrDirty);
    }

    _refreshUndoButtons() {
        const u = this.parent.modal.$('#la-undo-btn');
        const r = this.parent.modal.$('#la-redo-btn');
        if (u) u.disabled = this.parent.modal._arrHistoryIdx <= 0;
        if (r) r.disabled = this.parent.modal._arrHistoryIdx >= this.parent.modal._arrHistory.length - 1;
    }

    // =========================================================
    // ARRANGER — PALETTE
    // =========================================================

    _renderPalette() {
        const grid = this.parent.modal.$('#la-palette-grid');
        if (!grid) return;
        if (!this.parent.modal.library.length) { grid.innerHTML = `<div class="lc-empty">${this.parent.modal.t('loopCreator.libraryEmpty')}</div>`; return; }
        const q = (this.parent.modal._paletteSearch || '').trim().toLowerCase();
        const items = q
            ? this.parent.modal.library.filter(l => (l.name || '').toLowerCase().includes(q)
                  || (GM_PROGRAM_NAMES[l.instrument_program ?? 0] || '').toLowerCase().includes(q))
            : this.parent.modal.library;
        if (!items.length) { grid.innerHTML = `<div class="lc-empty">${this.parent.modal.t('loopManager.noResults')}</div>`; return; }
        grid.innerHTML = items.map(loop => {
            const family = LoopUtils.familyForProgram(loop.instrument_program ?? 0);
            return `<div class="la-palette-chip" draggable="true" data-loop-id="${loop.id}"
                data-loop-bars="${loop.bars}" data-loop-name="${this.parent.modal.escape(loop.name)}"
                style="--family-color:${family.color}">
                <div class="la-chip-name">${this.parent.modal._instrIconHtml(loop.instrument_program ?? 0, 'instrument', 'la-chip-icon')} ${this.parent.modal.escape(loop.name)}</div>
                <div class="la-chip-meta">${loop.bars}${this.parent.modal.t('loopCreator.barsUnit')}</div>
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
                this.parent.modal._dragInfo = { type: 'palette', loopBars, reps: 1 };
            });
            chip.addEventListener('dragend', () => { this.parent.modal._dragInfo = null; });
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
        const canvas = this.parent.modal.$('#la-minimap');
        if (!canvas) return;
        const wrap = this.parent.modal.$('#la-timeline-wrap');
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

        const totalBars = Math.max(1, this.parent.modal.arrangementBars);
        const trackCount = Math.max(1, this.parent.modal.tracks?.length || 0);
        const barW   = W / totalBars;
        const rowH   = (H - 4) / trackCount;
        const trackIndexById = new Map((this.parent.modal.tracks || []).map((t, i) => [t.id, i]));

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
        for (const block of (this.parent.modal.blocks || [])) {
            const ti = trackIndexById.get(block.track_id);
            if (ti === undefined) continue;
            const x = block.position_bar * barW;
            const w = Math.max(1, block.loop_bars * block.repetitions * barW);
            const y = 2 + ti * rowH;
            const h = Math.max(2, rowH - 2);
            const loop = this.parent.modal.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            ctx.fillStyle = family.color;
            ctx.fillRect(x, y, w, h);
        }

        // Viewport rectangle : portion visible du timeline scrollable.
        if (wrap) {
            const cellsBarW = this.parent._barWidth();
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
                const targetBar = ratio * this.parent.modal.arrangementBars;
                const w = this.parent.modal.$('#la-timeline-wrap');
                if (!w) return;
                const cellsBarW = this.parent._barWidth();
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
        const ruler = this.parent.modal.$('#la-ruler');
        if (!ruler) return;
        const BAR_W = this.parent._barWidth();
        // Spacer 120px = largeur des track-labels, garantit que la 1ère
        // mesure du ruler est alignée avec le début des cells.
        let html = '<div class="la-ruler-spacer" aria-hidden="true"></div>';
        for (let b = 0; b < this.parent.modal.arrangementBars; b++) {
            const marker = (b % 4 === 0) ? `<span class="la-ruler-label">${b+1}</span>` : '';
            html += `<div class="la-ruler-cell" data-ruler-bar="${b}" style="width:${BAR_W}px">${marker}</div>`;
        }
        ruler.style.width = (120 + BAR_W * this.parent.modal.arrangementBars) + 'px';
        ruler.innerHTML = html;
        if (!ruler.dataset.lcWired) {
            ruler.dataset.lcWired = '1';
            ruler.title = this.parent.modal.t('loopManager.rulerClickHint');
            ruler.style.cursor = 'pointer';
            ruler.addEventListener('click', (e) => {
                const cell = e.target.closest('[data-ruler-bar]');
                if (!cell) return;
                const bar = parseInt(cell.dataset.rulerBar);
                if (Number.isNaN(bar)) return;
                if (this.parent.modal.isArrangerPlaying) {
                    this.parent._stopArrangerPlay();
                    this.parent._playArrangement(bar);
                } else {
                    this.parent.modal._arrangerStartBar = bar;
                    this._renderArrangerStartMarker();
                }
            });
        }
        this._renderArrangerStartMarker();
    }

    _renderArrangerStartMarker() {
        const wrap = this.parent.modal.$('#la-timeline-wrap');
        if (!wrap) return;
        let marker = wrap.querySelector('.la-start-marker');
        if (this.parent.modal._arrangerStartBar <= 0 || this.parent.modal.isArrangerPlaying) {
            marker?.remove();
            return;
        }
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'la-start-marker';
            wrap.appendChild(marker);
        }
        const BAR_W  = this.parent._barWidth();
        const labelW = this.parent.modal.$('.la-track-label')?.offsetWidth || 120;
        marker.style.transform = `translateX(${labelW + this.parent.modal._arrangerStartBar * BAR_W}px)`;
    }

    _renderTracks() {
        const container = this.parent.modal.$('#la-tracks');
        if (!container) return;
        container.innerHTML = '';
        for (const track of this.parent.modal.tracks) container.appendChild(this._buildTrackEl(track));
    }

    _buildTrackEl(track) {
        const BAR_W  = this.parent._barWidth();
        const totalW = BAR_W * this.parent.modal.arrangementBars;
        const muted  = this.parent.modal._trackMute.has(track.id);
        const soloed = this.parent.modal._trackSolo.has(track.id);
        const audible = this._isTrackAudible(track.id);
        const trackEl = document.createElement('div');
        trackEl.className = `la-track${muted ? ' la-track--muted' : ''}${soloed ? ' la-track--solo' : ''}${audible ? '' : ' la-track--silent'}`;
        trackEl.dataset.trackId = track.id;
        trackEl.style.height = this.parent._trackHeight() + 'px';
        // Label par défaut « Piste N » côté client si le backend n'en a
        // pas posé (Phase 1 a vidé les labels par défaut pour i18n).
        const defaultLabel = this.parent.modal.t('loopManager.defaultTrackName', { index: (track.track_index ?? 0) + 1 })
            || `Track ${(track.track_index ?? 0) + 1}`;
        const displayLabel = (track.label && track.label.trim()) || defaultLabel;
        trackEl.innerHTML = `
            <div class="la-track-label">
                <input type="text" class="la-track-name-input lc-name-input"
                    value="${this.parent.modal.escape(displayLabel)}"
                    placeholder="${this.parent.modal.escape(defaultLabel)}"
                    aria-label="${this.parent.modal.t('loopManager.trackName') || 'Track name'}"
                    data-track-id="${track.id}" />
                <button class="la-track-toggle la-track-toggle--mute${muted ? ' la-track-toggle--active' : ''}"
                    data-track-action="mute" data-track-id="${track.id}"
                    aria-pressed="${muted}" title="${this.parent.modal.t('loopManager.trackMute')}">M</button>
                <button class="la-track-toggle la-track-toggle--solo${soloed ? ' la-track-toggle--active' : ''}"
                    data-track-action="solo" data-track-id="${track.id}"
                    aria-pressed="${soloed}" title="${this.parent.modal.t('loopManager.trackSolo')}">S</button>
                <button class="lc-card-btn lc-card-btn--danger" data-track-action="delete" data-track-id="${track.id}" title="${this.parent.modal.t('loopCreator.deleteTrack')}">✕</button>
            </div>
            <div class="la-track-cells" data-track-id="${track.id}" style="width:${totalW}px">
                ${this._buildCells(track.id, BAR_W)}
            </div>`;

        const cells = trackEl.querySelector('.la-track-cells');
        cells.addEventListener('dragstart', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (!blockEl) return;
            const blockId = parseInt(blockEl.dataset.blockId);
            const block = this.parent.modal.blocks.find(b => b.id === blockId);
            if (!block) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
                source:   'block',
                blockId,
                loopBars: block.loop_bars,
                reps:     block.repetitions
            }));
            blockEl.classList.add('la-block--dragging');
            this.parent.modal._dragInfo = { type: 'block', loopBars: block.loop_bars, reps: block.repetitions };
        });
        cells.addEventListener('dragend', (e) => {
            const blockEl = e.target.closest('.la-block[data-block-id]');
            if (blockEl) blockEl.classList.remove('la-block--dragging');
            this.parent._hideDropPreview();
            this.parent.modal._dragInfo = null;
        });
        cells.addEventListener('dragover',  (e) => {
            e.preventDefault();
            // dropEffect doit matcher effectAllowed posé au dragstart :
            // - palette chip / library card → effectAllowed='copy' → dropEffect='copy'
            // - block existant → effectAllowed='move' → dropEffect='move'
            // Firefox (strict HTML5 DnD spec) annule le drop si mismatch
            // → bouton drop pas firé.
            e.dataTransfer.dropEffect = (this.parent.modal._dragInfo?.type === 'block') ? 'move' : 'copy';
            this.parent._showDropPreview(cells, this.parent._barFromX(e.offsetX, BAR_W), BAR_W);
        });
        cells.addEventListener('dragleave', () => this.parent._hideDropPreview());
        cells.addEventListener('drop',      (e) => {
            e.preventDefault(); this.parent._hideDropPreview();
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                const bar = this.parent._barFromX(e.offsetX, BAR_W);
                if (data.source === 'block' && data.blockId) {
                    this.parent._moveBlock(data.blockId, track.id, bar);
                } else if (data.loopId) {
                    this.parent._addBlock(track.id, data.loopId, bar, data.loopBars || 2);
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
            const block   = this.parent.modal.blocks.find(b => b.id === blockId);
            if (!block || !blockEl) return;
            const rect    = blockEl.getBoundingClientRect();
            this.parent.modal._resizeState = {
                blockId,
                blockEl,
                leftPx:   rect.left,
                barW:     this.parent._barWidth(),
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
                if (actionBtn.dataset.blockAction === 'reps-inc') this.parent._changeReps(bid, +1);
                if (actionBtn.dataset.blockAction === 'reps-dec') this.parent._changeReps(bid, -1);
                if (actionBtn.dataset.blockAction === 'delete')   this.parent._deleteBlock(bid);
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
                await this.parent.modal.api.sendCommand('arrangement_update_track', { trackId: track.id, label: nameInput.value });
                const t = this.parent.modal.tracks.find(x => x.id === track.id);
                if (t) t.label = nameInput.value;
                this._pushArrHistory();
            } catch (err) {
                LoopUtils.handleError(err, 'arr.track.rename', {
                    toast: this.parent.modal.t('loopManager.errSave')
                });
            }
        });
        trackEl.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => this.parent._deleteTrack(track.id));
        trackEl.querySelector('[data-track-action="mute"]')?.addEventListener('click', () => this._toggleTrackMute(track.id));
        trackEl.querySelector('[data-track-action="solo"]')?.addEventListener('click', () => this._toggleTrackSolo(track.id));
        // Le sélecteur de canal MIDI a été retiré du header de track : le
        // routing canal est automatiquement géré par _playArrangement
        // (allocation dynamique selon les programmes utilisés).
        return trackEl;
    }

    _isTrackAudible(trackId) {
        if (this.parent.modal._trackMute.has(trackId)) return false;
        if (this.parent.modal._trackSolo.size > 0)     return this.parent.modal._trackSolo.has(trackId);
        return true;
    }

    _toggleTrackMute(trackId) {
        if (this.parent.modal._trackMute.has(trackId)) this.parent.modal._trackMute.delete(trackId);
        else                              this.parent.modal._trackMute.add(trackId);
        this._renderTracks();
    }

    _toggleTrackSolo(trackId) {
        if (this.parent.modal._trackSolo.has(trackId)) this.parent.modal._trackSolo.delete(trackId);
        else                              this.parent.modal._trackSolo.add(trackId);
        this._renderTracks();
    }

    _buildCells(trackId, BAR_W) {
        let html = '';
        this.parent.modal.blocks.filter(b => b.track_id === trackId).forEach((block) => {
            const loop   = this.parent.modal.library.find(l => l.id === block.loop_id);
            const family = LoopUtils.familyForProgram(loop?.instrument_program ?? 0);
            const blockW = block.loop_bars * block.repetitions * BAR_W;
            const blockL = block.position_bar * BAR_W;
            const selected = this.parent.modal._selectedBlocks.has(block.id);
            const endBar   = block.position_bar + block.loop_bars * block.repetitions;
            const overflow = endBar > this.parent.modal.arrangementBars;
            const classes  = ['la-block'];
            if (selected) classes.push('la-block--selected');
            if (overflow) classes.push('la-block--overflow');
            const title = overflow
                ? this.parent.modal.t('loopManager.blockOverflow', { end: endBar, total: this.parent.modal.arrangementBars })
                : this.parent.modal.t('loopManager.blockDragHint');
            html += `<div class="${classes.join(' ')}"
                draggable="true" data-block-id="${block.id}" data-loop-bars="${block.loop_bars}"
                data-block-reps="${block.repetitions}"
                data-wide="${blockW >= 70 ? 'true' : 'false'}"
                style="left:${blockL}px;width:${blockW}px;background:${family.color}"
                title="${title}">
                <div class="la-block-label">${this.parent.modal._instrIconHtml(loop?.instrument_program ?? 0, 'instrument', 'la-block-icon')} ${this.parent.modal.escape(block.loop_name)} ×${block.repetitions}${overflow ? ' ⚠' : ''}</div>
                <div class="la-block-actions">
                    <button class="la-block-btn" draggable="false" data-block-action="reps-dec" data-block-id="${block.id}">−</button>
                    <span class="la-block-reps">${block.repetitions}</span>
                    <button class="la-block-btn" draggable="false" data-block-action="reps-inc" data-block-id="${block.id}">+</button>
                    <button class="la-block-btn la-block-btn--del" draggable="false" data-block-action="delete" data-block-id="${block.id}" title="${this.parent.modal.t('loopCreator.deleteBlock')}">✕</button>
                </div>
                <div class="la-block-resize" draggable="false" data-block-resize="${block.id}" title="${this.parent.modal.t('loopManager.dragToResize')}"></div>
            </div>`;
        });
        return html;
    }

    _toggleBlockSelection(blockId, additive) {
        if (additive) {
            if (this.parent.modal._selectedBlocks.has(blockId)) this.parent.modal._selectedBlocks.delete(blockId);
            else this.parent.modal._selectedBlocks.add(blockId);
        } else {
            const onlyOne = this.parent.modal._selectedBlocks.size === 1 && this.parent.modal._selectedBlocks.has(blockId);
            this.parent.modal._selectedBlocks.clear();
            if (!onlyOne) this.parent.modal._selectedBlocks.add(blockId);
        }
        this._refreshBlockSelectionUI();
    }

    _clearBlockSelection() {
        if (!this.parent.modal._selectedBlocks.size) return;
        this.parent.modal._selectedBlocks.clear();
        this._refreshBlockSelectionUI();
    }

    _refreshBlockSelectionUI() {
        this.parent.modal.$$('.la-block').forEach(el => {
            const bid = parseInt(el.dataset.blockId);
            el.classList.toggle('la-block--selected', this.parent.modal._selectedBlocks.has(bid));
        });
    }

    async _deleteSelectedBlocks() {
        const ids = [...this.parent.modal._selectedBlocks];
        if (!ids.length) return;
        for (const bid of ids) {
            try {
                await this.parent.modal.api.sendCommand('arrangement_delete_block', { blockId: bid });
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.deleteMulti', {
                    toast: this.parent.modal.t('loopManager.errSave')
                });
            }
        }
        this.parent.modal.blocks = this.parent.modal.blocks.filter(b => !this.parent.modal._selectedBlocks.has(b.id));
        this.parent.modal._selectedBlocks.clear();
        this._renderTimeline();
        this._pushArrHistory();
    }

    _copySelectedBlocks() {
        const sel = this.parent.modal.blocks.filter(b => this.parent.modal._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const minBar = Math.min(...sel.map(b => b.position_bar));
        const tracksOrder = this.parent.modal.tracks.map(t => t.id);
        const minTrackIdx = Math.min(...sel.map(b => tracksOrder.indexOf(b.track_id)));
        this.parent.modal._blockClipboard = sel.map(b => ({
            loop_id:        b.loop_id,
            loop_name:      b.loop_name,
            loop_bars:      b.loop_bars,
            repetitions:    b.repetitions,
            track_offset:   tracksOrder.indexOf(b.track_id) - minTrackIdx,
            bar_offset:     b.position_bar - minBar
        }));
        LoopUtils.toast?.(this.parent.modal.t('loopManager.blocksCopied', { count: sel.length }), 'info');
    }

    async _pasteBlocks(targetTrackId = null, targetBar = null) {
        if (!this.parent.modal._blockClipboard.length || !this.parent.modal.currentArrangementId) return;
        const tracksOrder = this.parent.modal.tracks.map(t => t.id);
        if (!tracksOrder.length) return;
        // Default paste anchor: after the rightmost existing block on the first track
        const baseTrackIdx = targetTrackId != null
            ? Math.max(0, tracksOrder.indexOf(targetTrackId))
            : 0;
        const baseBar = targetBar != null
            ? targetBar
            : this._nextFreeBar(tracksOrder[baseTrackIdx]);
        const newBlocks = [];
        for (const item of this.parent.modal._blockClipboard) {
            const trackIdx = Math.min(tracksOrder.length - 1, baseTrackIdx + item.track_offset);
            const trackId  = tracksOrder[trackIdx];
            const posBar   = Math.max(0, Math.min(this.parent.modal.arrangementBars - 1, baseBar + item.bar_offset));
            try {
                const r = await this.parent.modal.api.sendCommand('arrangement_add_block', {
                    trackId, loopId: item.loop_id, position_bar: posBar, repetitions: item.repetitions
                });
                const created = {
                    id: r.blockId, track_id: trackId, loop_id: item.loop_id,
                    position_bar: posBar, repetitions: item.repetitions,
                    loop_name: item.loop_name, loop_bars: item.loop_bars
                };
                this.parent.modal.blocks.push(created);
                newBlocks.push(created.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.paste', {
                    toast: this.parent.modal.t('loopManager.errSave')
                });
            }
        }
        if (newBlocks.length) {
            this.parent.modal._selectedBlocks = new Set(newBlocks);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    async _duplicateSelectedBlocks() {
        const sel = this.parent.modal.blocks.filter(b => this.parent.modal._selectedBlocks.has(b.id));
        if (!sel.length) return;
        const newIds = [];
        for (const b of sel) {
            const span     = b.loop_bars * b.repetitions;
            const posBar   = Math.max(0, Math.min(this.parent.modal.arrangementBars - 1, b.position_bar + span));
            try {
                const r = await this.parent.modal.api.sendCommand('arrangement_add_block', {
                    trackId: b.track_id, loopId: b.loop_id, position_bar: posBar, repetitions: b.repetitions
                });
                const dup = {
                    id: r.blockId, track_id: b.track_id, loop_id: b.loop_id,
                    position_bar: posBar, repetitions: b.repetitions,
                    loop_name: b.loop_name, loop_bars: b.loop_bars
                };
                this.parent.modal.blocks.push(dup);
                newIds.push(dup.id);
            } catch (err) {
                LoopUtils.handleError(err, 'arr.block.duplicate', {
                    toast: this.parent.modal.t('loopManager.errSave')
                });
            }
        }
        if (newIds.length) {
            this.parent.modal._selectedBlocks = new Set(newIds);
            this._renderTimeline();
            this._pushArrHistory();
        }
    }

    _nextFreeBar(trackId) {
        let end = 0;
        for (const b of this.parent.modal.blocks) {
            if (b.track_id !== trackId) continue;
            const e = b.position_bar + b.loop_bars * b.repetitions;
            if (e > end) end = e;
        }
        return Math.min(end, Math.max(0, this.parent.modal.arrangementBars - 1));
    }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerArrangerView = LoopManagerArrangerView;
    }
})();
