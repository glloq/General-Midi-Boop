// ============================================================================
// File: public/js/features/LoopManagerPadView.js
// Description: HTML template + grid renderer (with long-press detection
//   and pointer event wiring) for LoopManagerPadFeature — extracted per
//   audit §1.3 (god-class split).
//
// Owns:
//   - `renderTabHtml()` — top-level template for the Pad tab (grid +
//     toolbar + size controls).
//   - `renderGrid()` — paint the cols×rows pad grid and wire the
//     delegated pointerdown / pointerup / pointerleave handlers
//     (long-press triggers the slot picker, short-tap fires trigger/stop).
//
// Accessed via `padFeature.view`. LoopManagerPadFeature keeps thin
// delegates so the LoopCreatorModal entry point (renderTabHtml) is
// unchanged.
// ============================================================================

(function () {
    'use strict';

    class LoopManagerPadView {
        /** @param {LoopManagerPadFeature} parent */
        constructor(parent) {
            this.parent = parent;
        }

        renderTabHtml() {
            const m = this.parent.modal;
            const t = m.t.bind(m);
            const modeBtn = (val, labelKey, icon) =>
                `<button class="lc-btn lc-btn-sm lm-pad-mode-btn${this.parent.playMode === val ? ' lm-pad-mode-btn--active' : ''}"
                    data-action="pad-set-mode" data-mode="${val}"
                    title="${t('loopManager.' + labelKey)}"
                    aria-pressed="${this.parent.playMode === val}">${icon} ${t('loopManager.' + labelKey)}</button>`;
            const quantBtn = (val, labelKey) =>
                `<button class="lc-btn lc-btn-sm lm-pad-quant-btn${this.parent.quantize === val ? ' lm-pad-quant-btn--active' : ''}"
                    data-action="pad-set-quantize" data-quantize="${val}"
                    title="${t('loopManager.' + labelKey)}"
                    aria-pressed="${this.parent.quantize === val}">${t('loopManager.' + labelKey)}</button>`;
            return `
            <div class="lc-pane${m.activeTab==='pad' ? '' : ' lc-pane--hidden'}" id="lc-pane-pad" role="tabpanel" aria-labelledby="lc-tab-pad">
                <div class="lc-ctrl-bar lc-ctrl-bar--pad">
                    <label class="lc-label" for="lm-pad-cols">${t('loopManager.padCols')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="pad-cols-dec" aria-label="${t('loopManager.padCols')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="lm-pad-cols" class="lc-spin-input lc-spin-input--sm"
                            value="${this.parent.cols}" min="1" max="8" aria-label="${t('loopManager.padCols')}" />
                        <button class="lc-spin-btn" data-action="pad-cols-inc" aria-label="${t('loopManager.padCols')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <label class="lc-label" for="lm-pad-rows">${t('loopManager.padRows')}</label>
                    <div class="lc-spinbox">
                        <button class="lc-spin-btn" data-action="pad-rows-dec" aria-label="${t('loopManager.padRows')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="lm-pad-rows" class="lc-spin-input lc-spin-input--sm"
                            value="${this.parent.rows}" min="1" max="8" aria-label="${t('loopManager.padRows')}" />
                        <button class="lc-spin-btn" data-action="pad-rows-inc" aria-label="${t('loopManager.padRows')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <div class="lc-ctrl-sep"></div>
                    <span class="lc-label">${t('loopManager.padPlayMode')}</span>
                    <div class="lm-pad-mode-group" role="group" aria-label="${t('loopManager.padPlayMode')}">
                        ${modeBtn('loop',     'padModeLoop',    '🔁')}
                        ${modeBtn('one-shot', 'padModeOneShot', '▶')}
                        ${modeBtn('hold',     'padModeHold',    '✋')}
                    </div>
                    <span class="lc-label">${t('loopManager.padQuantize')}</span>
                    <div class="lm-pad-quant-group" role="group" aria-label="${t('loopManager.padQuantize')}">
                        ${quantBtn('off',  'padQuantizeOff')}
                        ${quantBtn('beat', 'padQuantizeBeat')}
                        ${quantBtn('bar',  'padQuantizeBar')}
                    </div>
                    <span class="lc-ctrl-spacer"></span>
                    <button class="lc-btn lc-btn-sm lc-btn-danger" data-action="pad-clear-all"
                        title="${t('loopManager.clearAllPads')}">🗑 ${t('loopManager.clearAllPads')}</button>
                </div>
                <div class="lm-pad-grid" id="lm-pad-grid"
                    style="--pad-cols:${this.parent.cols};--pad-rows:${this.parent.rows}"></div>
                <div class="lm-pad-picker" id="lm-pad-picker" style="display:none"></div>
            </div>`;
        }

        // -------------------------------------------------------------
        // Synth
        // -------------------------------------------------------------

        async initSynth() {
            if (!this.parent.synth) this.parent.synth = await LoopUtils.createSynth();
        }

        clearLongPress() {
            if (this.parent._clearLongPress) this.parent._clearLongPress();
        }

        // -------------------------------------------------------------
        // Grid rendering + pointer wiring
        // -------------------------------------------------------------

        renderGrid() {
            const m = this.parent.modal;
            const grid = m.$('#lm-pad-grid');
            if (!grid) return;
            grid.style.setProperty('--pad-cols', this.parent.cols);
            grid.style.setProperty('--pad-rows', this.parent.rows);
            grid.innerHTML = this.parent.slots.map((slot, i) => {
                const playing  = this.parent.playingIndex.has(i);
                const assigned = slot !== null;
                const row      = Math.floor(i / this.parent.cols);
                let iconHtml = '', familyColor = '';
                if (assigned) {
                    const family = LoopUtils.familyForProgram(slot.instrument_program ?? 0);
                    iconHtml = m._instrIconHtml(slot.instrument_program ?? 0, 'instrument', 'lm-pad-icon');
                    familyColor = family.color;
                }
                const styleAttr = familyColor ? `style="--family-color:${familyColor}"` : '';
                return `<div class="lm-pad-cell${assigned ? ' lm-pad-cell--assigned' : ''}${playing ? ' lm-pad-cell--playing' : ''}"
                    data-pad-index="${i}" data-row="${row}" ${styleAttr}
                    role="button"
                    aria-label="${assigned ? m.escape(slot.name) : m.t('loopManager.emptyPad', { index: i + 1 })}"
                    title="${assigned ? m.escape(slot.name) : m.t('loopManager.padHint')}">
                    ${iconHtml}
                    <span class="lm-pad-name">${assigned ? m.escape(slot.name) : '+'}</span>
                    <span class="lm-pad-meta">${assigned ? `${slot.tempo}♩·${slot.bars}M` : ''}</span>
                </div>`;
            }).join('');

            if (!grid.dataset.lmPadWired) {
                grid.dataset.lmPadWired = '1';
                // Pointer-based events: support hold mode + long-press for assignment
                const LONG_PRESS_MS = 500;
                const LONG_PRESS_MOVE_PX = 8;
                let lpTimer = null;
                let lpStartXY = null;
                let lpCell = null;
                let lpFired = false;

                const clearLongPress = () => {
                    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
                    lpStartXY = null; lpCell = null;
                };
                // Exposé pour onClose : sans ça, un timer armé < 500 ms tire
                // sur un DOM détaché après fermeture de la modale (AUDIT §L9).
                this.parent._clearLongPress = clearLongPress;

                grid.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0 && e.pointerType === 'mouse') return; // left-button or touch/pen only
                    lpFired = false; clearLongPress();
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (!cell) return;
                    const idx = parseInt(cell.dataset.padIndex);
                    const slot = this.parent.slots[idx];

                    // Empty pad → open picker immediately (no playback to trigger)
                    if (!slot) {
                        this.parent.openPicker(idx, cell);
                        return;
                    }

                    // Assigned pad: arm long-press for re-assignment (touch-friendly
                    // alternative to right-click). Skipped in hold mode since hold
                    // already owns the press gesture.
                    if (this.parent.playMode !== 'hold') {
                        lpCell  = cell;
                        lpStartXY = { x: e.clientX, y: e.clientY };
                        lpTimer = setTimeout(() => {
                            lpFired = true;
                            lpTimer = null;
                            this.parent.openPicker(idx, cell);
                        }, LONG_PRESS_MS);
                    }

                    if (this.parent.playMode === 'hold') {
                        this.parent.holdActive.add(idx);
                        try { cell.setPointerCapture?.(e.pointerId); } catch (_) {}
                        this.parent.trigger(idx, { fromHold: true });
                    }
                });

                grid.addEventListener('pointermove', (e) => {
                    if (!lpTimer || !lpStartXY) return;
                    const dx = e.clientX - lpStartXY.x;
                    const dy = e.clientY - lpStartXY.y;
                    if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) clearLongPress();
                });

                grid.addEventListener('pointerup', (e) => {
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (!cell) { clearLongPress(); return; }
                    const idx = parseInt(cell.dataset.padIndex);

                    if (this.parent.playMode === 'hold' && this.parent.holdActive.has(idx)) {
                        this.parent.holdActive.delete(idx);
                        this.parent.stop(idx);
                        return;
                    }

                    if (lpFired && lpCell === cell) {
                        lpFired = false;
                        clearLongPress();
                        return;
                    }

                    clearLongPress();
                    if (this.parent.slots[idx]) this.parent.trigger(idx);
                });

                const onCancel = (e) => {
                    clearLongPress();
                    if (this.parent.playMode !== 'hold') return;
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (!cell) return;
                    const idx = parseInt(cell.dataset.padIndex);
                    if (this.parent.holdActive.has(idx)) {
                        this.parent.holdActive.delete(idx);
                        this.parent.stop(idx);
                    }
                };
                grid.addEventListener('pointercancel', onCancel);
                grid.addEventListener('pointerleave',  onCancel);
                grid.addEventListener('dragover', (e) => {
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (!cell) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    cell.classList.add('lm-pad-cell--drop-target');
                });
                grid.addEventListener('dragleave', (e) => {
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (cell) cell.classList.remove('lm-pad-cell--drop-target');
                });
                grid.addEventListener('drop', (e) => {
                    const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
                    if (!cell) return;
                    e.preventDefault();
                    cell.classList.remove('lm-pad-cell--drop-target');
                    try {
                        const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                        if (data.loopId) this.parent.assignSlot(parseInt(cell.dataset.padIndex), data.loopId);
                    } catch (err) {
                        LoopUtils.handleError(err, 'pad.drop.parse');
                    }
                });
            }
        }

        // -------------------------------------------------------------
        // Layout config
        // -------------------------------------------------------------

    }

    if (typeof window !== 'undefined') {
        window.LoopManagerPadView = LoopManagerPadView;
    }
})();
