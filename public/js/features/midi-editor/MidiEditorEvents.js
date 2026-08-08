// ============================================================================
// File: public/js/features/midi-editor/MidiEditorEvents.js
// Description: DOM event attachment + viewport / navigation / zoom / scroll.
//   Sub-component class ; called via `modal.events.<method>(...)`.
//   (P2-F.10f body rewrite — no longer a prototype mixin.)
// ============================================================================

(function () {
  'use strict';

  class MidiEditorEvents {
    constructor(modal) {
      this.modal = modal;
      // AbortController scoped to the current modal session. Listeners
      // attached on `document` / `window` should pass `{ signal }` so a
      // single `detachEvents()` call wipes them all (audit §7.1, §8.1).
      this._abortController = null;
      // Sub-features extracted per audit §1.3:
      this.viewport =
        typeof MidiEditorViewport !== 'undefined' ? new MidiEditorViewport(this) : null;
      this.resize = typeof MidiEditorResize !== 'undefined' ? new MidiEditorResize(this) : null;
      this.channelChips =
        typeof MidiEditorChannelChipEvents !== 'undefined'
          ? new MidiEditorChannelChipEvents(this)
          : null;
    }

    /**
     * @returns {AbortSignal|undefined} Signal for cross-DOM listeners.
     *   `undefined` when called before `attachEvents()` — caller should
     *   skip the attach to avoid an unmanaged listener.
     */
    getAbortSignal() {
      return this._abortController?.signal;
    }

    /**
     * Abort every listener registered with this session's signal.
     * Called from `MidiEditorLifecycle.doClose()`.
     */
    detachEvents() {
      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch {
          /* best-effort */
        }
        this._abortController = null;
      }
    }

    attachEvents() {
      if (!this.modal.container) return;
      // Fresh controller per attach so reopened modals don't reuse a
      // pre-aborted signal.
      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch {
          /* best-effort */
        }
      }
      this._abortController = new AbortController();

      // No backdrop click-to-close for the MIDI editor
      // (prevents accidental dismissals during editing)

      // Action buttons
      this.modal.container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;

        switch (action) {
          case 'close':
            this.modal.close();
            break;
          case 'save':
            this.modal.fileOps.saveMidiFile();
            break;
          case 'save-as':
            this.modal.fileOps.showSaveAsDialog();
            break;
          case 'auto-assign':
            this.modal.fileOps.showAutoAssignModal();
            break;
          case 'zoom-h-in':
            this.zoomHorizontal(0.8);
            break;
          case 'zoom-h-out':
            this.zoomHorizontal(1.25);
            break;
          case 'zoom-v-in':
            this.zoomVertical(0.8);
            break;
          case 'zoom-v-out':
            this.zoomVertical(1.25);
            break;

          // New edit buttons
          case 'undo':
            this.modal.editActions?.undo();
            break;
          case 'redo':
            this.modal.editActions?.redo();
            break;
          case 'copy':
            this.modal.editActions?.copy();
            break;
          case 'paste':
            this.modal.editActions?.paste();
            break;
          case 'delete':
            this.modal.editActions?.deleteSelectedNotes();
            break;
          case 'select-all':
            this.modal.editActions?.selectAll();
            break;
          case 'change-channel':
            this.modal.editActions?.changeChannel();
            break;
          case 'apply-instrument':
            this.modal.editActions?.applyInstrument();
            break;
          case 'cycle-snap':
            this.modal.editActions?.cycleSnap();
            break;
          case 'show-info':
            this.modal.infoModal?.show();
            break;
          case 'rename-file':
            this.modal.fileOps.showRenameDialog();
            break;
          case 'toggle-settings-popover':
            this.toggleSettingsPopover();
            break;
          case 'toggle-preview-source':
            this.modal.routingOps?.togglePreviewSource();
            break;
          // configure-string-instrument removed — config is in instrument settings

          // Playback controls
          case 'playback-play':
            this.modal.playbackPlay();
            break;
          case 'playback-pause':
            this.modal.playbackPause();
            break;
          case 'playback-stop':
            this.modal.playbackStop();
            break;

          // Edit modes
          case 'mode-select':
          case 'mode-drag-notes':
          case 'mode-drag-view':
          case 'mode-add-note':
          case 'mode-resize-note':
          case 'mode-edit': {
            const mode = btn.dataset.mode;
            if (mode) {
              this.modal.editActions?.setEditMode(mode);
            }
            break;
          }
        }
      });

      this.channelChips?.attachHandlers();

      // Toggle preview source (GM / Routed)
      const previewToggle = document.getElementById('preview-source-toggle');
      if (previewToggle) {
        previewToggle.addEventListener('click', () => this.modal.routingOps?.togglePreviewSource());
      }

      // Toggle playable notes global
      const playableToggle = document.getElementById('playable-notes-toggle');
      if (playableToggle) {
        playableToggle.addEventListener('click', () =>
          this.modal.routingOps.togglePlayableNotesGlobal()
        );
      }

      // Toggle touch mode — both the popover switch (#touch-mode-toggle) and
      // the inline toolbar button (#touch-mode-inline-toggle) flip the same
      // state. Loop/panel mode only renders the inline one.
      const touchModeToggle = document.getElementById('touch-mode-toggle');
      if (touchModeToggle) {
        touchModeToggle.addEventListener('click', () => this.modal.toggleTouchMode());
      }
      const touchModeInline = document.getElementById('touch-mode-inline-toggle');
      if (touchModeInline) {
        touchModeInline.addEventListener('click', () => this.modal.toggleTouchMode());
      }

      // Toggle keyboard playback
      const kbPlaybackToggle = document.getElementById('keyboard-playback-toggle');
      if (kbPlaybackToggle) {
        kbPlaybackToggle.addEventListener('click', () => this.modal.toggleKeyboardPlayback());
      }

      // Toggle drag playback
      const dragPlaybackToggle = document.getElementById('drag-playback-toggle');
      if (dragPlaybackToggle) {
        dragPlaybackToggle.addEventListener('click', () => this.modal.toggleDragPlayback());
      }

      // Tempo input
      const tempoInput = document.getElementById('tempo-input');
      if (tempoInput) {
        tempoInput.addEventListener('change', (e) => {
          const newTempo = parseInt(e.target.value);
          if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
            this.modal.setTempo(newTempo);
          } else {
            // Restore the previous value when invalid
            e.target.value = this.modal.tempo || 120;
          }
        });
        // Also react to changes made while typing (input event)
        tempoInput.addEventListener('input', (e) => {
          const newTempo = parseInt(e.target.value);
          if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
            // Real-time feedback while typing, but SILENT: the toast/log fire
            // once on commit via the `change` handler above, not per keystroke
            // (audit D N2).
            this.modal.setTempo(newTempo, { silent: true });
          }
        });
      }

      // CC section header (collapse/expand) — only on the title, not the channel tabs
      const ccSectionHeader = document.getElementById('cc-section-header');
      if (ccSectionHeader) {
        const ccTitle = ccSectionHeader.querySelector('.cc-section-title');
        if (ccTitle) {
          ccTitle.addEventListener('click', (e) => {
            e.preventDefault();
            this.modal.ccOps.toggleCCSection();
          });
        }
        // Gear button for CC drawing settings
        const ccDrawSettingsBtn = ccSectionHeader.querySelector('#cc-draw-settings-btn');
        if (ccDrawSettingsBtn) {
          ccDrawSettingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.modal.drawSettings.toggleDrawSettingsPopover();
          });
        }
      }

      // CC type buttons (horizontal)
      // OPTIMIZATION: Event delegation for CC type, tool, and delete buttons
      // Replaces ~20+ individual listeners with a single delegated listener
      this.modal.container.addEventListener('click', (e) => {
        const ccTypeBtn = e.target.closest('.cc-type-btn');
        if (ccTypeBtn) {
          e.preventDefault();
          const ccType = ccTypeBtn.dataset.ccType;
          if (ccType) this.modal.ccOps.selectCCType(ccType);
          return;
        }
        const ccToolBtn = e.target.closest('.cc-tool-btn');
        if (ccToolBtn) {
          e.preventDefault();
          const tool = ccToolBtn.dataset.tool;
          if (tool) {
            this.modal.container
              .querySelectorAll('.cc-tool-btn')
              .forEach((b) => b.classList.remove('active'));
            ccToolBtn.classList.add('active');
            if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
              this.modal.tempoEditor.setTool(tool);
            } else if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
              this.modal.velocityEditor.setTool(tool);
            } else if (this.modal.ccEditor) {
              this.modal.ccEditor.setTool(tool);
            }
          }
          return;
        }
        if (e.target.closest('#cc-delete-btn')) {
          e.preventDefault();
          this.modal.ccPicker.deleteSelectedCCVelocity();
          return;
        }
      });

      // "+" button to open the CC picker
      const ccAddBtn = document.getElementById('cc-add-btn');
      if (ccAddBtn) {
        ccAddBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.modal.ccPicker.openCCPicker();
        });
      }

      // Event listeners for channel buttons are attached
      // in attachEditorChannelListeners() called from updateEditorChannelSelector()
      // to avoid conflicts during dynamic channel updates

      // Instrument selector for new channels
      const instrumentSelector = document.getElementById('instrument-selector');
      if (instrumentSelector) {
        instrumentSelector.addEventListener('change', (e) => {
          this.modal.selectedInstrument = parseInt(e.target.value);
          this.modal.log(
            'info',
            `Selected instrument changed to: ${this.modal.getInstrumentName(this.modal.selectedInstrument)} (${this.modal.selectedInstrument})`
          );
        });
      }

      this.resize?.attachHandler();
    }

    reloadPianoRoll() {
      if (!this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.log('warn', 'Cannot reload piano roll: not initialized');
        return;
      }

      this.modal.log('info', `Reloading piano roll with ${this.modal.sequence.length} notes`);

      // Compute the tick range from the sequence
      let maxTick = 0;
      let minNote = 127;
      let maxNote = 0;

      if (this.modal.sequence && this.modal.sequence.length > 0) {
        this.modal.sequence.forEach((note) => {
          const endTick = note.t + note.g;
          if (endTick > maxTick) maxTick = endTick;
          if (note.n < minNote) minNote = note.n;
          if (note.n > maxNote) maxNote = note.n;
        });
      }

      // Update the piano-roll attributes
      const xrange = Math.max(128, Math.ceil(maxTick / 128) * 128);
      const noteRange = Math.max(36, maxNote - minNote + 12);

      const renderer = this.modal.pianoRollRenderer;
      renderer
        ?.setXRange(xrange)
        .setYRange(noteRange)
        .setSequence(this.modal.sequence)
        .setChannelColors(this.modal.channelColors)
        .redraw();

      // Update the stats
      this.modal.routingOps?.updateStats();

      this.modal.log(
        'info',
        `Piano roll reloaded: ${this.modal.sequence.length} notes, xrange=${xrange}, yrange=${noteRange}`
      );
    }

    // Delegates to viewport sub-feature (extracted per audit §1.3)
    zoomHorizontal(factor) {
      return this.viewport?.zoomHorizontal(factor);
    }
    zoomVertical(factor) {
      return this.viewport?.zoomVertical(factor);
    }
    _scheduleWebaudioPianoRollRedraw(afterRedraw) {
      return this.viewport?.scheduleRedraw(afterRedraw);
    }
    _initNavigationOverview(maxTick, xrange) {
      return this.viewport?.initNavigationOverview(maxTick, xrange);
    }
    _updateNavigationMinimap() {
      return this.viewport?.updateNavigationMinimap();
    }
    setupScrollSynchronization() {
      return this.viewport?.setupScrollSynchronization();
    }
    scrollHorizontal(percentage) {
      return this.viewport?.scrollHorizontal(percentage);
    }
    scrollVertical(percentage) {
      return this.viewport?.scrollVertical(percentage);
    }

    _applyPianoRollTheme() {
      const renderer = this.modal.pianoRollRenderer;
      if (!renderer?.isMounted()) return;

      const isDark = document.body.classList.contains('dark-mode');
      renderer.setThemeColors(
        isDark
          ? {
              collt: '#262830',
              coldk: '#22242a',
              colgrid: '#2e3038',
              colrulerbg: '#1e2028',
              colrulerfg: '#8890a0',
              colrulerborder: '#2e3038',
              colnoteborder: 'rgba(255,255,255,0.1)',
              // V2 keyboard colors — legacy WAC element has its own CSS rules
              // so colkb* keys are a no-op there. V2 Canvas reads them.
              colkbwhite: '#3a3c44',
              colkbblack: '#1a1c20'
            }
          : {
              collt: '#ddd6f3',
              coldk: '#d2cae8',
              colgrid: '#c8c0de',
              colrulerbg: '#d5cdef',
              colrulerfg: '#4a3f6b',
              colrulerborder: '#c0b8d8',
              colnoteborder: 'rgba(102,126,234,0.25)',
              colkbwhite: '#f8f8f8',
              colkbblack: '#222222'
            }
      );
    }

    toggleSettingsPopover() {
      const popover = this.modal.container.querySelector('#settings-popover');
      if (!popover) return;
      const isVisible = popover.style.display !== 'none';
      popover.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        const signal = this.getAbortSignal();
        // No signal = modal closing; skip to avoid a permanent listener.
        if (!signal || signal.aborted) return;
        const closeHandler = (e) => {
          if (
            !popover.contains(e.target) &&
            !e.target.closest('[data-action="toggle-settings-popover"]')
          ) {
            popover.style.display = 'none';
            document.removeEventListener('click', closeHandler);
          }
        };
        // setTimeout defers the attach past the click that opened the
        // popover. Bail if the modal closed during that single tick.
        setTimeout(() => {
          if (signal.aborted) return;
          document.addEventListener('click', closeHandler, { signal });
        }, 0);
      }
    }

    _initTimelineBar(maxTick, ticksPerBeat, xrange) {
      return this.viewport?.initTimelineBar(maxTick, ticksPerBeat, xrange);
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorEvents = MidiEditorEvents;
  }
})();
