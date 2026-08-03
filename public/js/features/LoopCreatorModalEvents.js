// ============================================================================
// File: public/js/features/LoopCreatorModalEvents.js
// Description: Keyboard / mouse event handlers for LoopCreatorModal —
//   extracted per audit §1.3 (god-class split, complementing §6.6).
//
// Owns:
//   - `_onKeyDown(e)` — global keydown router (tab arrow nav, modal
//     close, undo/redo, copy/paste/duplicate/delete for arranger
//     selection, accelerators).
//   - `_switchTab(tab)` — programmatic tab change.
//   - `_attachEvents()` — wires the modal's click / contextmenu /
//     change / input / keydown delegated listeners.
//   - `_onClick(e)` / `_onContextMenu(e)` / `_onChange(e)` /
//     `_onInput(e)` — delegated handlers dispatching `data-action`.
//   - `_openBlockMenu(x, y)` / `_closeBlockMenu()` — context menu for
//     selected arranger blocks.
//
// Accessed via `loopCreatorModal.events`. The modal keeps thin delegates
// so existing call sites (lifecycle, super.onOpen) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class LoopCreatorModalEvents {
    /** @param {LoopCreatorModal} parent */
    constructor(parent) {
      this.parent = parent;
    }

    _onKeyDown(e) {
      const t = e.target;
      const tag = (t?.tagName || '').toLowerCase();

      // Navigation clavier dans la tablist (APG tabs pattern, AUDIT §A2).
      // Capture en premier — pas conditionné par l'input/textarea check
      // car le focus est sur un bouton tab.
      if (t?.classList?.contains('lc-tab') && t.getAttribute('role') === 'tab') {
        const tabs = ['library', 'pad', 'live', 'keyboard', 'arranger'];
        const i = tabs.indexOf(t.dataset.tab);
        if (i >= 0) {
          let next = -1;
          if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
          else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabs.length - 1;
          if (next >= 0) {
            e.preventDefault();
            this._switchTab(tabs[next]);
            this.parent.$(`#lc-tab-${tabs[next]}`)?.focus();
            return;
          }
        }
      }

      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      if (this.parent._loopEditor?.isOpen) return; // editor handles its own shortcuts

      const mod = e.ctrlKey || e.metaKey;

      if (this.parent.activeTab === 'arranger') {
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.parent._arrUndo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) {
          e.preventDefault();
          this.parent._arrRedo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          this.parent._arrRedo();
          return;
        }
        if (mod && e.key.toLowerCase() === 's') {
          e.preventDefault();
          this.parent._saveArrangement();
          return;
        }
        if (e.key === ' ') {
          e.preventDefault();
          this.parent.isArrangerPlaying
            ? this.parent._stopArrangerPlay()
            : this.parent._playArrangement(this.parent._arrangerStartBar);
          return;
        }
        if (e.key === 'Escape') {
          this.parent._stopArrangerPlay();
          this.parent._clearBlockSelection();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.parent._selectedBlocks.size) {
          e.preventDefault();
          this.parent._deleteSelectedBlocks();
          return;
        }
        if (mod && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          this.parent._selectedBlocks = new Set(this.parent.blocks.map((b) => b.id));
          this.parent._refreshBlockSelectionUI();
          return;
        }
        if (mod && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          this.parent._copySelectedBlocks();
          return;
        }
        if (mod && e.key.toLowerCase() === 'x') {
          e.preventDefault();
          this.parent._copySelectedBlocks();
          this.parent._deleteSelectedBlocks();
          return;
        }
        if (mod && e.key.toLowerCase() === 'v') {
          e.preventDefault();
          this.parent._pasteBlocks();
          return;
        }
        if (mod && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          this.parent._duplicateSelectedBlocks();
          return;
        }
      }

      if (this.parent.activeTab === 'live') {
        if (e.key === 'Escape') {
          this.parent._liveStopAll();
          return;
        }
      }
    }

    // =========================================================
    // TAB SWITCHING
    // =========================================================

    _switchTab(tab) {
      // Close the pad assignment picker if leaving the Pad tab
      if (
        this.parent.activeTab === 'pad' &&
        tab !== 'pad' &&
        this.parent._padPickerIndex !== null
      ) {
        this.parent._closePadPicker();
      }
      this.parent.activeTab = tab;
      this.parent.$$('.lc-tab').forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle('lc-tab--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        // APG : tabindex roving — un seul tab focusable à la fois.
        btn.setAttribute('tabindex', active ? '0' : '-1');
      });
      this.parent.$$('.lc-pane').forEach((pane) => {
        pane.classList.toggle('lc-pane--hidden', !pane.id.endsWith(tab));
      });
      const saveBtn = this.parent.$('#lc-header-save');
      if (saveBtn) saveBtn.style.display = tab === 'arranger' ? '' : 'none';

      // The embedded keyboard panel can only live in one host at a time, so
      // unmount it whenever the user leaves the Keyboard tab.
      if (tab !== 'keyboard' && this.parent.keyboard?.mounted) this.parent.keyboard.unmount();

      if (tab === 'library') this.parent._filterAndRenderLibrary();
      if (tab === 'pad') this.parent._renderPadGrid();
      if (tab === 'live') this.parent._renderLiveArea();
      if (tab === 'keyboard') this.parent.keyboard?.enterTab();
      if (tab === 'arranger') this.parent._initArrangerTab();
    }

    // =========================================================
    // EVENTS
    // =========================================================

    _attachEvents() {
      this.parent.dialog.addEventListener('click', (e) => this._onClick(e));
      this.parent.dialog.addEventListener('change', (e) => this._onChange(e));
      this.parent.dialog.addEventListener('input', (e) => this._onInput(e));
      this.parent.dialog.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    }

    _onClick(e) {
      // Close pad picker on outside click
      if (
        this.parent._padPickerIndex !== null &&
        !e.target.closest('#lm-pad-picker') &&
        !e.target.closest('.lm-pad-cell')
      ) {
        this.parent._closePadPicker();
      }

      const tabBtn = e.target.closest('.lc-tab[data-tab]');
      if (tabBtn) {
        this._switchTab(tabBtn.dataset.tab);
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      switch (a) {
        // Global stop (header button)
        case 'stop-all-playback':
          this.parent._stopAllPads();
          this.parent._liveStopAll();
          this.parent._stopArrangerPlay();
          this.parent.keyboard?.stopAllNotes();
          break;
        case 'toggle-output':
          this.parent._toggleHeaderOutput();
          break;
        // Library
        case 'new-loop':
          this.parent._loopEditor.open();
          break;
        // Pad
        case 'pad-clear-all':
          this.parent._clearAllPads();
          break;
        case 'pad-cols-dec':
          this.parent._adjustPadCols(-1);
          break;
        case 'pad-cols-inc':
          this.parent._adjustPadCols(+1);
          break;
        case 'pad-rows-dec':
          this.parent._adjustPadRows(-1);
          break;
        case 'pad-rows-inc':
          this.parent._adjustPadRows(+1);
          break;
        case 'pad-set-mode':
          this.parent._setPadPlayMode(btn.dataset.mode);
          break;
        case 'pad-set-quantize':
          this.parent._setPadQuantize(btn.dataset.quantize);
          break;
        // Live
        case 'live-stop-all':
          this.parent._liveStopAll();
          break;
        case 'live-trigger': {
          const loopId = parseInt(btn.dataset.loopId);
          if (!isNaN(loopId)) this.parent._liveTrigger(loopId);
          break;
        }
        // Arranger
        case 'arr-tempo-dec':
          this.parent._adjustArrTempo(-1);
          break;
        case 'arr-tempo-inc':
          this.parent._adjustArrTempo(+1);
          break;
        case 'arr-bars-dec':
          this.parent._adjustArrBars(-4);
          break;
        case 'arr-bars-inc':
          this.parent._adjustArrBars(+4);
          break;
        case 'arr-add-track':
          this.parent._addTrack();
          break;
        case 'arr-play':
          this.parent._playArrangement(this.parent._arrangerStartBar);
          break;
        case 'arr-stop':
          this.parent._stopArrangerPlay();
          break;
        case 'arr-new':
          this.parent._newArrangementConfirm();
          break;
        case 'arr-zoom-in':
          this.parent._arrZoom(1.5);
          break;
        case 'arr-zoom-out':
          this.parent._arrZoom(1 / 1.5);
          break;
        case 'arr-zoom-reset':
          this.parent._arrZoomReset();
          break;
        case 'arr-zoomv-in':
          this.parent._arrZoomV(1.3);
          break;
        case 'arr-zoomv-out':
          this.parent._arrZoomV(1 / 1.3);
          break;
        case 'arr-toggle-loop':
          this.parent._toggleLoopPlayback();
          break;
        case 'arr-toggle-countin':
          this.parent._toggleCountIn();
          break;
        case 'arr-undo':
          this.parent._arrUndo();
          break;
        case 'arr-redo':
          this.parent._arrRedo();
          break;
        case 'save-arrangement':
          this.parent._saveArrangement();
          break;
        case 'close':
          this.parent.close();
          break;
      }
    }

    _onContextMenu(e) {
      const cell = e.target.closest('.lm-pad-cell[data-pad-index]');
      if (cell) {
        e.preventDefault();
        this.parent._openPadPicker(parseInt(cell.dataset.padIndex), cell);
        return;
      }
      const blockEl = e.target.closest('.la-block[data-block-id]');
      if (blockEl) {
        e.preventDefault();
        const bid = parseInt(blockEl.dataset.blockId);
        if (!this.parent._selectedBlocks.has(bid)) {
          this.parent._selectedBlocks.clear();
          this.parent._selectedBlocks.add(bid);
          this.parent._refreshBlockSelectionUI();
        }
        this._openBlockMenu(e.clientX, e.clientY);
      }
    }

    _openBlockMenu(x, y) {
      this._closeBlockMenu();
      const menu = document.createElement('div');
      menu.className = 'la-block-menu';
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      const items = [
        { action: 'duplicate', label: this.parent.t('loopManager.blockMenuDuplicate'), icon: '⎘' },
        { action: 'copy', label: this.parent.t('loopManager.blockMenuCopy'), icon: '⧉' },
        { action: 'reps-inc', label: this.parent.t('loopManager.blockMenuRepsInc'), icon: '+' },
        { action: 'reps-dec', label: this.parent.t('loopManager.blockMenuRepsDec'), icon: '−' },
        {
          action: 'delete',
          label: this.parent.t('loopManager.blockMenuDelete'),
          icon: '🗑',
          danger: true
        }
      ];
      menu.innerHTML = items
        .map(
          (it) =>
            `<button class="la-block-menu-item${it.danger ? ' la-block-menu-item--danger' : ''}" data-menu-action="${it.action}">
                <span class="la-block-menu-icon">${it.icon}</span>${it.label}
            </button>`
        )
        .join('');
      document.body.appendChild(menu);
      // Clamp position to viewport
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth)
        menu.style.left = window.innerWidth - rect.width - 4 + 'px';
      if (rect.bottom > window.innerHeight)
        menu.style.top = window.innerHeight - rect.height - 4 + 'px';

      menu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-menu-action]');
        if (!btn) return;
        this._closeBlockMenu();
        const a = btn.dataset.menuAction;
        const ids = [...this.parent._selectedBlocks];
        switch (a) {
          case 'duplicate':
            this.parent._duplicateSelectedBlocks();
            break;
          case 'copy':
            this.parent._copySelectedBlocks();
            break;
          case 'reps-inc':
            ids.forEach((id) => this.parent._changeReps(id, +1));
            break;
          case 'reps-dec':
            ids.forEach((id) => this.parent._changeReps(id, -1));
            break;
          case 'delete':
            this.parent._deleteSelectedBlocks();
            break;
        }
      });
      // Dismiss on outside click / escape
      this.parent._blockMenuEl = menu;
      this.parent._blockMenuDismiss = (ev) => {
        if (ev.type === 'keydown' && ev.key !== 'Escape') return;
        if (ev.type === 'mousedown' && menu.contains(ev.target)) return;
        this._closeBlockMenu();
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this.parent._blockMenuDismiss);
        document.addEventListener('keydown', this.parent._blockMenuDismiss);
      }, 0);
    }

    _closeBlockMenu() {
      if (!this.parent._blockMenuEl) return;
      document.removeEventListener('mousedown', this.parent._blockMenuDismiss);
      document.removeEventListener('keydown', this.parent._blockMenuDismiss);
      this.parent._blockMenuEl.remove();
      this.parent._blockMenuEl = null;
      this.parent._blockMenuDismiss = null;
    }

    _onChange(e) {
      const id = e.target.id;
      if (id === 'lm-lib-filter') {
        this.parent.libraryFeature?.setFilter(e.target.value);
      } else if (id === 'lm-lib-sort') {
        this.parent.libraryFeature?.setSort(e.target.value);
      } else if (id === 'lm-pad-cols') {
        this.parent._setPadCols(parseInt(e.target.value));
      } else if (id === 'lm-pad-rows') {
        this.parent._setPadRows(parseInt(e.target.value));
      } else if (id === 'la-bars') {
        const v = LoopUtils.validate.arrBars(e.target.value, this.parent.arrangementBars);
        const changed = v !== this.parent.arrangementBars;
        this.parent.arrangementBars = v;
        e.target.value = v;
        if (changed) {
          this.parent._renderTimeline();
          this.parent._pushArrHistory();
          this.parent._scheduleAutoSave();
        }
      }
    }

    _onInput(e) {
      const id = e.target.id;
      if (id === 'lm-lib-search') {
        this.parent.libraryFeature?.setSearch(e.target.value);
      } else if (id === 'lm-live-search') {
        this.parent.liveFeature?.setSearch(e.target.value);
      } else if (id === 'la-palette-search') {
        this.parent._paletteSearch = e.target.value;
        this.parent._renderPalette();
      } else if (id === 'la-name-input') {
        if (this.parent.arrangementName === e.target.value) return;
        this.parent.arrangementName = e.target.value;
        this.parent._markArrDirty(true);
        this.parent._scheduleAutoSave();
      } else if (id === 'la-tempo') {
        const v = LoopUtils.validate.tempo(e.target.value, this.parent.arrangementTempo);
        if (v !== this.parent.arrangementTempo) {
          this.parent.arrangementTempo = v;
          this.parent._markArrDirty(true);
          this.parent._scheduleAutoSave();
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.LoopCreatorModalEvents = LoopCreatorModalEvents;
  }
})();
