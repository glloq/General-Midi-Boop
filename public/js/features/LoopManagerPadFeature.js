/**
 * LoopManagerPadFeature — Pad tab of LoopManagerModal.
 *
 * Audit §6.6 — fourth slice of the LoopCreatorModal god-class
 * (after Keyboard, Library and Live). Extracts the configurable
 * pad grid (1×1 to 8×8) with pointer-based triggering, hold mode,
 * launch quantize, long-press picker, drag-and-drop assignment,
 * and per-pad cycle scheduling.
 *
 * Interface with the parent modal:
 *   reads  : modal.library, modal.api, modal.t(), modal.$(),
 *            modal.$$(), modal.escape(), modal._instrIconHtml(),
 *            modal._getOutputTarget(), modal._fetchLoopData(),
 *            modal._deviceShim, modal._renderPlaybar(),
 *            modal.activeTab, modal.libraryFeature.filterAndRender()
 *
 * Public methods (used by the modal):
 *   - renderTabHtml()                — string; template
 *   - initSynth()                    — async; lazy-create the synth
 *   - renderGrid()                   — paint/refresh the pad cells
 *   - setCols(v), setRows(v), adjustCols(d), adjustRows(d)
 *   - setPlayMode(mode), setQuantize(q)
 *   - trigger(index, opts)           — async; toggle / start a pad
 *   - stop(index), stopAll()
 *   - assignSlot(index, loopId)
 *   - openPicker(index, anchorEl), closePicker(), clearLongPress()
 *   - clearAll()                     — async; confirm + clear
 *   - cleanupSlotsForLoop(loopId)    — used by modal._deleteLoopById
 *   - load()                         — restore layout from PadStorage
 *   - slots (Array, readonly)        — used by Library cards
 *   - pickerIndex (number|null)      — used by modal._switchTab
 *   - playTimes (Map, readonly)      — used by _renderPlaybar
 */
(function () {
  'use strict';

  class LoopManagerPadFeature {
    /** @param {LoopManagerModal} modal */
    constructor(modal) {
      this.modal = modal;
      this.cols = 4;
      this.rows = 4;
      this.playMode = 'loop'; // 'loop' | 'one-shot' | 'hold'
      this.quantize = 'off'; // 'off' | 'beat' | 'bar'
      this.slots = Array(this.cols * this.rows).fill(null);
      this.playingIndex = new Set();
      this.playbackTimers = new Map(); // padIndex → [timerIds]
      this.synth = null;
      this.pickerIndex = null; // pad index whose picker is open
      this._pickerHandler = null;
      this._clockStartMs = null; // free-running launch-quantize reference
      this.holdActive = new Set();
      this.playTimes = new Map(); // padIndex → { startMs, durMs }
      this._clearLongPress = null; // set on first renderGrid()
      // Sub-feature: HTML template + grid renderer (audit §1.3).
      this.view = typeof LoopManagerPadView !== 'undefined' ? new LoopManagerPadView(this) : null;
    }

    // -------------------------------------------------------------
    // Template
    // -------------------------------------------------------------

    // Delegates to view sub-feature (extracted per audit §1.3)
    renderTabHtml() {
      return this.view?.renderTabHtml() ?? '';
    }
    async initSynth() {
      return this.view?.initSynth();
    }
    clearLongPress() {
      return this.view?.clearLongPress();
    }
    renderGrid() {
      return this.view?.renderGrid();
    }

    // -------------------------------------------------------------
    // Layout config
    // -------------------------------------------------------------

    _resize(newCols, newRows) {
      const cols = Math.max(1, Math.min(8, parseInt(newCols) || this.cols));
      const rows = Math.max(1, Math.min(8, parseInt(newRows) || this.rows));
      if (cols === this.cols && rows === this.rows) return;
      const oldCols = this.cols;
      const oldRows = this.rows;
      const oldSlots = this.slots;
      const next = new Array(cols * rows).fill(null);
      for (let r = 0; r < Math.min(rows, oldRows); r++) {
        for (let c = 0; c < Math.min(cols, oldCols); c++) {
          next[r * cols + c] = oldSlots[r * oldCols + c];
        }
      }
      this.stopAll();
      this.cols = cols;
      this.rows = rows;
      this.slots = next;
      this._syncControls();
      this.renderGrid();
      this._persist();
    }

    setCols(v) {
      this._resize(v, this.rows);
    }
    setRows(v) {
      this._resize(this.cols, v);
    }
    adjustCols(d) {
      this._resize(this.cols + d, this.rows);
    }
    adjustRows(d) {
      this._resize(this.cols, this.rows + d);
    }

    setPlayMode(mode) {
      if (!['loop', 'one-shot', 'hold'].includes(mode)) return;
      if (mode === this.playMode) return;
      this.playMode = mode;
      this.stopAll();
      this._persist();
      this._syncModeButtons();
    }

    setQuantize(quantize) {
      if (!['off', 'beat', 'bar'].includes(quantize)) return;
      if (quantize === this.quantize) return;
      this.quantize = quantize;
      if (this.playingIndex.size === 0) this._clockStartMs = null;
      this._persist();
      this._syncQuantButtons();
    }

    _syncModeButtons() {
      this.modal.$$('.lm-pad-mode-btn').forEach((btn) => {
        const active = btn.dataset.mode === this.playMode;
        btn.classList.toggle('lm-pad-mode-btn--active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    _syncQuantButtons() {
      this.modal.$$('.lm-pad-quant-btn').forEach((btn) => {
        const active = btn.dataset.quantize === this.quantize;
        btn.classList.toggle('lm-pad-quant-btn--active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    _syncControls() {
      const m = this.modal;
      const colsIn = m.$('#lm-pad-cols');
      if (colsIn) colsIn.value = this.cols;
      const rowsIn = m.$('#lm-pad-rows');
      if (rowsIn) rowsIn.value = this.rows;
      this._syncModeButtons();
      this._syncQuantButtons();
    }

    // -------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------

    async trigger(index, opts = {}) {
      const m = this.modal;
      const slot = this.slots[index];
      if (!slot) return;

      // In non-hold modes, a click on an already-playing pad acts as a toggle.
      // In hold mode, pointerdown should restart playback if pad is already
      // playing (e.g. from a previous hold not yet faded).
      if (this.playingIndex.has(index)) {
        if (this.playMode === 'hold' && opts.fromHold) {
          this.stop(index);
        } else {
          this.stop(index);
          return;
        }
      }

      const loopData = await m._fetchLoopData(slot.loopId);
      if (!loopData) {
        LoopUtils.toast(m.t('loopManager.errLoopUnavailable'), 'error');
        return;
      }

      // Drum kits (program ≥ 128) DOIVENT sortir sur le canal 9 sinon
      // MidiSynthesizer.playNote() prend le path mélodique et ne trouve
      // aucun preset → loop silencieuse. Les autres pads se partagent
      // les canaux 0-15 en wrappant sur l'index.
      const prog = loopData.instrument_program ?? 0;
      const isDrum = prog >= 128;
      const ch = isDrum ? 9 : index % 16;
      const target = m._getOutputTarget(this.synth);
      if (target) {
        try {
          target.setChannelInstrument(ch, prog);
        } catch (err) {
          LoopUtils.handleError(err, 'pad.synth.setChannelInstrument');
        }
        if (isDrum) {
          await target
            .loadDrumKit?.()
            .catch((err) => LoopUtils.handleError(err, 'pad.synth.loadDrumKit'));
        } else if (!target.loadedInstruments?.has(prog)) {
          await target
            .loadInstrument(prog)
            .catch((err) => LoopUtils.handleError(err, 'pad.synth.loadInstrument'));
        }
      }

      // If hold was released between fetch and now, abort
      if (this.playMode === 'hold' && opts.fromHold && !this.holdActive.has(index)) {
        return;
      }

      this.playingIndex.add(index);
      this._updateCell(index);
      this._schedule(index, loopData, ch, { quantize: true });
    }

    _computeStartDelay(loopData) {
      if (this.quantize === 'off') return 0;
      if (this._clockStartMs == null) {
        this._clockStartMs = performance.now();
        return 0;
      }
      const tempo = loopData.tempo || 120;
      const beatMs = 60000 / tempo;
      const stepMs = this.quantize === 'bar' ? beatMs * 4 : beatMs;
      const elapsed = performance.now() - this._clockStartMs;
      const phase = ((elapsed % stepMs) + stepMs) % stepMs;
      const delay = stepMs - phase;
      return delay < 5 ? 0 : delay;
    }

    _schedule(index, loopData, channel = 0, opts = {}) {
      const m = this.modal;
      const { quantize = false, cycleStart = false } = opts;
      const seq = LoopUtils.parseSequence(loopData.midi_data);
      const loopDurMs = LoopUtils.loopDurationMs(loopData);
      const tempo = loopData.tempo || 120;
      const ppq = loopData.ppq || 480;
      const startDelay = quantize && !cycleStart ? this._computeStartDelay(loopData) : 0;
      const isLoopMode = this.playMode === 'loop' || this.playMode === 'hold';

      this.playTimes.set(index, {
        startMs: performance.now() + startDelay,
        durMs: loopDurMs
      });
      m._renderPlaybar();

      const isAlive = () => this.playingIndex.has(index);
      const timers = LoopUtils.scheduleSequence({
        synth: m._getOutputTarget(this.synth),
        sequence: seq,
        tempo,
        ppq,
        channel,
        startDelayMs: startDelay,
        isAlive,
        cycleMs: loopDurMs + 50,
        onCycleEnd: () => {
          if (!isAlive()) return;
          if (isLoopMode) {
            this._schedule(index, loopData, channel, { cycleStart: true });
          } else {
            this.stop(index);
          }
        }
      });

      this.playbackTimers.set(index, timers);
    }

    stop(index) {
      const m = this.modal;
      (this.playbackTimers.get(index) || []).forEach((t) => clearTimeout(t));
      this.playbackTimers.delete(index);
      this.playingIndex.delete(index);
      this.playTimes.delete(index);
      this._updateCell(index);
      m._renderPlaybar();
    }

    stopAll() {
      const m = this.modal;
      for (let i = 0; i < this.slots.length; i++) this.stop(i);
      this.holdActive.clear();
      this.playTimes.clear();
      try {
        this.synth?.cancelAllNotes?.();
      } catch (err) {
        LoopUtils.handleError(err, 'pad.synth.cancelAllNotes');
      }
      try {
        m._deviceShim?.cancelAllNotes?.();
      } catch (err) {
        LoopUtils.handleError(err, 'pad.device.cancelAllNotes');
      }
    }

    _updateCell(index) {
      const cell = this.modal.$(`#lm-pad-grid .lm-pad-cell[data-pad-index="${index}"]`);
      if (!cell) return;
      const slot = this.slots[index];
      const playing = this.playingIndex.has(index);
      cell.classList.toggle('lm-pad-cell--playing', playing);
      cell.classList.toggle('lm-pad-cell--assigned', slot !== null);
    }

    // -------------------------------------------------------------
    // Assignment + picker
    // -------------------------------------------------------------

    assignSlot(index, loopId) {
      const m = this.modal;
      const loop = m.library.find((l) => l.id === loopId);
      if (!loop) return;
      this.stop(index);
      this.slots[index] = {
        loopId: loop.id,
        name: loop.name,
        tempo: loop.tempo,
        bars: loop.bars,
        instrument_program: loop.instrument_program ?? 0
      };
      this.renderGrid();
      this.closePicker();
      this._persist();
      if (m.activeTab === 'library') m.libraryFeature?.filterAndRender();
    }

    openPicker(index, anchorEl) {
      const m = this.modal;
      // Reset any previous picker handler
      this._detachPickerHandler();
      this.pickerIndex = index;
      const picker = m.$('#lm-pad-picker');
      if (!picker) return;

      picker.innerHTML = `
                <div class="lm-picker-title">${m.t('loopManager.assignPad')}</div>
                <input type="text" class="lm-picker-search" id="lm-picker-search"
                    placeholder="${m.t('loopManager.search')}" autocomplete="off" />
                <div class="lm-picker-list">
                    ${m.library
                      .map(
                        (l) => `
                    <div class="lm-picker-item" data-assign-loop="${l.id}" data-search-name="${m.escape(l.name.toLowerCase())}">
                        <span class="lm-picker-name">${m.escape(l.name)}</span>
                        <span class="lm-picker-meta">${l.tempo}♩·${l.bars}M</span>
                    </div>`
                      )
                      .join('')}
                    <div class="lm-picker-item lm-picker-item--clear" data-assign-loop="__clear__">
                        ${m.t('loopManager.clearPad')}
                    </div>
                </div>`;

      const search = picker.querySelector('#lm-picker-search');
      if (search) {
        search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          picker.querySelectorAll('.lm-picker-item[data-search-name]').forEach((el) => {
            el.style.display = !q || el.dataset.searchName.includes(q) ? '' : 'none';
          });
        });
        requestAnimationFrame(() => search.focus());
      }

      this._pickerHandler = (e) => {
        const item = e.target.closest('[data-assign-loop]');
        if (!item) return;
        const val = item.dataset.assignLoop;
        if (val === '__clear__') {
          this.stop(index);
          this.slots[index] = null;
          this.renderGrid();
          this.closePicker();
          this._persist();
        } else {
          this.assignSlot(index, parseInt(val));
        }
      };
      picker.addEventListener('click', this._pickerHandler);

      // Position near anchor (fixed so it escapes any overflow:hidden containers)
      const rect = anchorEl.getBoundingClientRect();
      picker.style.left = rect.left + 'px';
      picker.style.top = rect.bottom + 4 + 'px';
      picker.style.display = 'block';
    }

    _detachPickerHandler() {
      if (this._pickerHandler) {
        const picker = this.modal.$('#lm-pad-picker');
        picker?.removeEventListener('click', this._pickerHandler);
        this._pickerHandler = null;
      }
    }

    closePicker() {
      this._detachPickerHandler();
      this.pickerIndex = null;
      const picker = this.modal.$('#lm-pad-picker');
      if (picker) picker.style.display = 'none';
    }

    // -------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------

    _persist() {
      LoopUtils.PadStorage.save({
        slots: this.slots,
        cols: this.cols,
        rows: this.rows,
        playMode: this.playMode,
        quantize: this.quantize
      });
    }

    load() {
      const saved = LoopUtils.PadStorage.load();
      if (!saved) return;
      const clamp = (v, min, max, fb) => {
        const n = parseInt(v);
        if (!Number.isFinite(n)) return fb;
        return Math.max(min, Math.min(max, n));
      };
      const cols = clamp(saved.cols, 1, 8, this.cols);
      const rows = clamp(saved.rows, 1, 8, this.rows);
      const expected = cols * rows;
      if (Array.isArray(saved.slots) && saved.slots.length === expected) {
        this.cols = cols;
        this.rows = rows;
        this.slots = saved.slots.map((s) =>
          s
            ? {
                loopId: s.loopId,
                name: s.name,
                tempo: s.tempo,
                bars: s.bars,
                instrument_program: s.instrument_program ?? 0
              }
            : null
        );
      }
      if (['loop', 'one-shot', 'hold'].includes(saved.playMode)) this.playMode = saved.playMode;
      if (['off', 'beat', 'bar'].includes(saved.quantize)) this.quantize = saved.quantize;
    }

    // -------------------------------------------------------------
    // Public helpers for cross-feature coordination
    // -------------------------------------------------------------

    /**
     * Clear and stop every pad slot that references the given loopId.
     * Called from the modal's _deleteLoopById cascade.
     * @returns {boolean} True when at least one slot was cleared.
     */
    cleanupSlotsForLoop(loopId) {
      let changed = false;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i]?.loopId === loopId) {
          this.stop(i);
          this.slots[i] = null;
          changed = true;
        }
      }
      if (changed) this._persist();
      return changed;
    }

    async clearAll() {
      const m = this.modal;
      const ok = await LoopUtils.confirm(m.t('loopManager.confirmClearAllPads'), {
        icon: '🧹',
        danger: true
      });
      if (!ok) return;
      for (let i = 0; i < this.slots.length; i++) {
        this.stop(i);
        this.slots[i] = null;
      }
      this.renderGrid();
      this._persist();
      LoopUtils.toast(m.t('loopManager.padsCleared'), 'success');
    }
  }

  if (typeof window !== 'undefined') {
    window.LoopManagerPadFeature = LoopManagerPadFeature;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoopManagerPadFeature;
  }
})();
