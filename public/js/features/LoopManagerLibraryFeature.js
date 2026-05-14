/**
 * LoopManagerLibraryFeature — Library tab of LoopManagerModal.
 *
 * Audit §6.6 — second slice of the LoopCreatorModal god-class.
 * Extracts the Library tab: searchable / filterable / sortable grid
 * of loops with edit / delete / live-trigger / drag-to-pad actions.
 *
 * Owns the per-tab state (`library`, search/filter/sort), the tab
 * template, and the rendering pipeline (filter, sort, populate
 * instrument-filter dropdown, build cards, wire grid handlers).
 *
 * Delete/onSaved stay in the modal because they cascade across
 * features (clear pad slots, stop live, reload arrangement) — the
 * feature calls back via `callbacks.onDeleteLoop(id)` /
 * `callbacks.onOpenLoopEditor(id)`.
 *
 * Interface with the parent modal:
 *   reads  : modal.api, modal.activeTab, modal.t(), modal.$(),
 *            modal.escape(), modal._gmProgramName(),
 *            modal._instrIconHtml(), modal._padSlots,
 *            modal._livePlayingLoops
 *   writes : library, _libSearch, _libFilter, _libSort (own state)
 *   emits  : callbacks.onDeleteLoop, callbacks.onOpenLoopEditor,
 *            callbacks.onLibraryLoaded
 *
 * Public methods (used by the modal):
 *   - loadLibrary()        — async; fetch loops
 *   - renderTabHtml()      — string; template
 *   - filterAndRender()    — re-render grid
 *   - setSearch(str), setFilter(str), setSort(str)
 *   - getLibrary()         — array (used by other features)
 */
(function () {
    'use strict';

    class LoopManagerLibraryFeature {
        /**
         * @param {LoopManagerModal} modal
         * @param {Object} callbacks
         * @param {(id:number)=>void} callbacks.onDeleteLoop
         * @param {(id:number)=>void} callbacks.onOpenLoopEditor
         * @param {()=>void}          [callbacks.onLibraryLoaded]
         */
        constructor(modal, callbacks = {}) {
            this.modal = modal;
            this.callbacks = callbacks;
            this.library = [];
            this.search = '';
            this.filter = ''; // instrument_program as string, or '' for all
            this.sort = 'name';
        }

        // -------------------------------------------------------------
        // State setters — called from the modal's _onChange / _onInput.
        // -------------------------------------------------------------

        setSearch(value) { this.search = value || ''; this.filterAndRender(); }
        setFilter(value) { this.filter = value || ''; this.filterAndRender(); }
        setSort(value)   { this.sort   = value || 'name'; this.filterAndRender(); }
        getLibrary()     { return this.library; }

        // -------------------------------------------------------------
        // Async load
        // -------------------------------------------------------------

        async loadLibrary() {
            try {
                const r = await this.modal.api.sendCommand('loop_list');
                this.library = r.loops || [];
                if (this.modal.activeTab === 'library') this.filterAndRender();
                if (typeof this.callbacks.onLibraryLoaded === 'function') {
                    try { this.callbacks.onLibraryLoaded(); } catch (_) { /* best-effort */ }
                }
            } catch (err) {
                LoopUtils.handleError(err, 'manager.loadLibrary', {
                    toast: this.modal.t('loopManager.errLoadLibrary')
                });
            }
        }

        // -------------------------------------------------------------
        // Tab template
        // -------------------------------------------------------------

        renderTabHtml() {
            const t = this.modal.t.bind(this.modal);
            return `
            <div class="lc-pane${this.modal.activeTab==='library' ? '' : ' lc-pane--hidden'}" id="lc-pane-library" role="tabpanel" aria-labelledby="lc-tab-library">
                <div class="lc-ctrl-bar lc-ctrl-bar--lib">
                    <input type="search" id="lm-lib-search" class="lc-name-input lm-lib-search"
                        aria-label="${t('loopManager.search')}"
                        placeholder="${t('loopManager.search')}" value="${this.modal.escape(this.search)}" />
                    <select id="lm-lib-filter" class="lc-select lm-lib-filter"
                        aria-label="${t('loopManager.allInstruments')}">
                        <option value="">— ${t('loopManager.allInstruments')} —</option>
                    </select>
                    <select id="lm-lib-sort" class="lc-select lm-lib-sort"
                        aria-label="${t('loopManager.sortName')}">
                        <option value="name"       ${this.sort==='name'       ?'selected':''}>↕ ${t('loopManager.sortName')}</option>
                        <option value="tempo"      ${this.sort==='tempo'      ?'selected':''}>↕ ${t('loopManager.sortTempo')}</option>
                        <option value="bars"       ${this.sort==='bars'       ?'selected':''}>↕ ${t('loopManager.sortBars')}</option>
                        <option value="instrument" ${this.sort==='instrument' ?'selected':''}>↕ ${t('loopManager.sortInstrument')}</option>
                    </select>
                    <span class="lc-ctrl-spacer"></span>
                    <button class="lc-btn lc-btn-primary lc-btn-sm" data-action="new-loop">+ ${t('loopManager.newLoop')}</button>
                </div>
                <div class="lm-library-grid" id="lm-library-grid">
                    <div class="lc-empty">
                        <p>${t('loopCreator.libraryEmpty')}</p>
                        <button class="lc-btn lc-btn-primary" data-action="new-loop">+ ${t('loopManager.newLoop')}</button>
                    </div>
                </div>
            </div>`;
        }

        // -------------------------------------------------------------
        // Render pipeline
        // -------------------------------------------------------------

        filterAndRender() {
            const grid = this.modal.$('#lm-library-grid');
            if (!grid) return;

            this._populateInstrumentFilter();

            let items = [...this.library];
            if (this.search) {
                const q = this.search.toLowerCase();
                items = items.filter(l => l.name.toLowerCase().includes(q));
            }
            if (this.filter !== '') {
                const prog = parseInt(this.filter);
                items = items.filter(l => (l.instrument_program ?? 0) === prog);
            }
            items.sort((a, b) => {
                if (this.sort === 'tempo')      return a.tempo - b.tempo;
                if (this.sort === 'bars')       return a.bars  - b.bars;
                if (this.sort === 'instrument') return (a.instrument_program ?? 0) - (b.instrument_program ?? 0);
                return a.name.localeCompare(b.name);
            });

            if (!items.length) {
                grid.innerHTML = `<div class="lc-empty">${this.modal.t('loopCreator.libraryEmpty')}</div>`;
                return;
            }
            grid.innerHTML = items.map(loop => this._loopCardHtml(loop)).join('');

            if (!grid.dataset.lmWired) {
                grid.dataset.lmWired = '1';
                grid.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-loop-action]');
                    if (!btn) return;
                    const id = parseInt(btn.dataset.loopId);
                    if (btn.dataset.loopAction === 'edit') {
                        this.callbacks.onOpenLoopEditor?.(id);
                    }
                    if (btn.dataset.loopAction === 'delete') {
                        this.callbacks.onDeleteLoop?.(id);
                    }
                });
                // Cards are draggable → drop on pads, palette chips, etc.
                grid.addEventListener('dragstart', (e) => {
                    const card = e.target.closest('.lc-card[data-loop-id]');
                    if (!card) return;
                    const id = parseInt(card.dataset.loopId);
                    const loop = this.library.find(l => l.id === id);
                    if (!loop) return;
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        source:   'library-card',
                        loopId:   id,
                        loopBars: loop.bars,
                        loopName: loop.name
                    }));
                    card.classList.add('lc-card--dragging');
                });
                grid.addEventListener('dragend', (e) => {
                    const card = e.target.closest('.lc-card[data-loop-id]');
                    if (card) card.classList.remove('lc-card--dragging');
                });
            }
        }

        _populateInstrumentFilter() {
            const sel = this.modal.$('#lm-lib-filter');
            if (!sel) return;
            const programs = [...new Set(this.library.map(l => l.instrument_program ?? 0))].sort((a, b) => a - b);
            const current = sel.value;
            sel.innerHTML = `<option value="">— ${this.modal.t('loopManager.allInstruments')} —</option>`;
            for (const prog of programs) {
                const opt = document.createElement('option');
                opt.value = prog;
                opt.textContent = this.modal._gmProgramName(prog);
                if (String(prog) === (current || String(this.filter))) opt.selected = true;
                sel.appendChild(opt);
            }
        }

        _loopCardHtml(loop) {
            const m = this.modal;
            const prog   = loop.instrument_program ?? 0;
            const family = LoopUtils.familyForProgram(prog);
            const instrName = m._gmProgramName(prog);
            const padIndexes = m._padSlots
                .map((s, i) => s?.loopId === loop.id ? (i + 1) : null)
                .filter(x => x != null);
            const padTagHtml = padIndexes.length
                ? `<span class="lc-card-pad-tag" title="${m.t('loopManager.assignedPadsTitle', { pads: padIndexes.join(', ') })}">📌 ${padIndexes.join(',')}</span>`
                : '';
            const playing = m._livePlayingLoops.has(loop.id);
            return `<div class="lc-card" draggable="true" data-loop-id="${loop.id}" style="--family-color:${family.color}" title="${m.escape(loop.name)} — ${m.escape(instrName)}">
                <div class="lc-card-head">
                    ${m._instrIconHtml(prog, 'instrument', 'lc-card-icon')}
                    <span class="lc-card-name">${m.escape(loop.name)}</span>
                    ${padTagHtml}
                </div>
                <div class="lc-card-actions">
                    <button class="lc-card-btn lc-card-btn--play${playing ? ' lc-card-btn--playing' : ''}" data-action="live-trigger" data-loop-id="${loop.id}" title="${m.t('loopCreator.preview')}">${playing ? '⏹' : '▶'}</button>
                    <button class="lc-card-btn" data-loop-action="edit"   data-loop-id="${loop.id}" title="${m.t('loopCreator.loadLoop')}">✏️</button>
                    <button class="lc-card-btn lc-card-btn--danger" data-loop-action="delete" data-loop-id="${loop.id}" title="${m.t('loopCreator.deleteLoop')}">🗑</button>
                </div>
            </div>`;
        }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerLibraryFeature = LoopManagerLibraryFeature;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopManagerLibraryFeature;
    }
})();
