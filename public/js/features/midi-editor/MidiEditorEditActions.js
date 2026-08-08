// ============================================================================
// File: public/js/features/midi-editor/MidiEditorEditActions.js
// Description: Edit actions (undo/redo, copy/paste, channel/instrument,
//   edit modes, keyboard shortcuts) for the MIDI editor.
//   Sub-component class ; called via `modal.editActions.<method>(...)`.
//   (P2-F.10j body rewrite — no longer a prototype mixin.)
// ============================================================================

(function () {
  'use strict';

  class MidiEditorEditActions {
    constructor(modal) {
      this.modal = modal;
      // Sub-features extracted per audit §1.3:
      this.channelOps =
        typeof MidiEditorChannelOps !== 'undefined' ? new MidiEditorChannelOps(this) : null;
      this.clipboard =
        typeof MidiEditorClipboard !== 'undefined' ? new MidiEditorClipboard(this) : null;
    }

    _getActiveSpecializedEditor() {
      if (this.modal.drumPatternEditor?.isVisible) return this.modal.drumPatternEditor;
      if (this.modal.windInstrumentEditor?.isVisible) return this.modal.windInstrumentEditor;
      if (this.modal.tablatureEditor?.isVisible) return this.modal.tablatureEditor;
      return null;
    }

    _getActiveSpecializedRenderer() {
      const editor = this._getActiveSpecializedEditor();
      if (!editor) return null;
      return editor.gridRenderer || editor.renderer || null;
    }

    // Common tail after a specialized-editor mutation (undo/redo/paste/
    // delete): optional monophony enforcement, MIDI sync, dirty + buttons.
    // `updateUndoRedo` is only set on the history (undo/redo) path to
    // preserve the historical clipboard behaviour exactly.
    _afterSpecializedEdit({ enforceMonophony = false, updateUndoRedo = false } = {}) {
      const editor = this._getActiveSpecializedEditor();
      if (enforceMonophony && typeof editor?._enforceMonophony === 'function') {
        editor._enforceMonophony();
      }
      if (typeof editor?._syncToMidi === 'function') {
        editor._syncToMidi();
      }
      this.modal.isDirty = true;
      this.modal.routingOps.updateSaveButton();
      if (updateUndoRedo) this.updateUndoRedoButtonsState();
      this.updateEditButtons();
    }

    // undo/redo share the same shape: try the active specialized renderer
    // first, otherwise the piano roll. `op` is 'undo' or 'redo'.
    _historyStep(op) {
      const specializedRenderer = this._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        // Wind editor needs monophony enforcement after history steps.
        if (specializedRenderer[op]()) {
          this._afterSpecializedEdit({ enforceMonophony: true, updateUndoRedo: true });
        }
        return;
      }

      const label = op === 'undo' ? 'Undo' : 'Redo';
      if (!this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.log('warn', `${label} not available`);
        return;
      }

      if (this.modal.pianoRollRenderer?.[op]()) {
        this.modal.log('info', `${label} successful`);
        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
        this.updateUndoRedoButtonsState();
      }
    }

    undo() {
      this._historyStep('undo');
    }
    redo() {
      this._historyStep('redo');
    }

    updateUndoRedoButtonsState() {
      const undoBtn = document.getElementById('undo-btn');
      const redoBtn = document.getElementById('redo-btn');

      const specializedRenderer = this._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        const canUndo =
          typeof specializedRenderer.canUndo === 'function' ? specializedRenderer.canUndo() : true;
        const canRedo =
          typeof specializedRenderer.canRedo === 'function' ? specializedRenderer.canRedo() : true;
        if (undoBtn) undoBtn.disabled = !canUndo;
        if (redoBtn) redoBtn.disabled = !canRedo;
        return;
      }

      if (!this.modal.pianoRollRenderer?.isMounted()) return;

      if (undoBtn) {
        undoBtn.disabled = !this.modal.pianoRollRenderer?.canUndo();
      }
      if (redoBtn) {
        redoBtn.disabled = !this.modal.pianoRollRenderer?.canRedo();
      }
    }

    // Delegates to clipboard sub-feature (extracted per audit §1.3)
    getSelectedNotes() {
      return this.clipboard?.getSelectedNotes() ?? [];
    }
    getSelectionCount() {
      return this.clipboard?.getSelectionCount() ?? 0;
    }
    copy() {
      return this.clipboard?.copy();
    }
    paste() {
      return this.clipboard?.paste();
    }
    deleteSelectedNotes() {
      return this.clipboard?.deleteSelectedNotes();
    }
    deleteAssociatedCCAndVelocity(deletedNotes) {
      return this.clipboard?.deleteAssociatedCCAndVelocity(deletedNotes);
    }
    selectAllNotes() {
      return this.clipboard?.selectAllNotes();
    }

    // Delegates to channelOps sub-feature (extracted per audit §1.3)
    async changeChannel() {
      return this.channelOps?.changeChannel();
    }
    refreshChannelButtons(keepPopover = false) {
      return this.channelOps?.refreshChannelButtons(keepPopover);
    }
    async applyInstrument() {
      return this.channelOps?.applyInstrument();
    }
    async applyInstrumentToSelection(program, instrumentName) {
      return this.channelOps?.applyInstrumentToSelection(program, instrumentName);
    }
    applyInstrumentToChannel(channel, program, instrumentName, info) {
      return this.channelOps?.applyInstrumentToChannel(channel, program, instrumentName, info);
    }
    findAvailableChannel(program) {
      return this.channelOps?.findAvailableChannel(program) ?? -1;
    }

    cycleSnap() {
      // Move to the next value (cycle)
      this.modal.currentSnapIndex =
        (this.modal.currentSnapIndex + 1) % this.modal.snapValues.length;

      const currentSnap = this.modal.snapValues[this.modal.currentSnapIndex];

      // Update the button's display
      const snapValueElement = document.getElementById('snap-value');
      if (snapValueElement) {
        snapValueElement.textContent = currentSnap.label;
      }

      // Apply snap on the piano roll (visual grid stays fixed at 120)
      // Use the JavaScript property to ensure the change is applied
      if (this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.pianoRollRenderer?.setSnap(currentSnap.ticks);
        this.modal.log(
          'info',
          `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${this.modal.pianoRollRenderer?.getElement()?.snap}`
        );
      }

      // Sync every editor
      this.modal.ccPicker.syncAllEditors();

      this.modal.showNotification(
        this.modal.t('midiEditor.snapChanged', { snap: currentSnap.label }),
        'info'
      );
    }

    setTempo(newTempo) {
      if (!newTempo || isNaN(newTempo) || newTempo < 20 || newTempo > 300) {
        this.modal.log('warn', `Invalid tempo value: ${newTempo}`);
        return;
      }

      this.modal.tempo = newTempo;
      this.modal.isDirty = true;
      this.modal.routingOps.updateSaveButton();

      // Update the piano roll
      if (this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.pianoRollRenderer?.setTempo(newTempo);
      }

      // Update the synthesizer if it exists
      if (this.modal.synthesizer) {
        this.modal.synthesizer.tempo = newTempo;
      }

      this.modal.log('info', `Tempo changed to ${newTempo} BPM`);
      this.modal.showNotification(
        this.modal.t('midiEditor.tempoChanged', { tempo: newTempo }),
        'info'
      );
    }

    setEditMode(mode) {
      this.modal.editMode = mode;

      // Dispatch to specialized editor if active
      const editor = this._getActiveSpecializedEditor();
      if (editor) {
        // Map main toolbar modes to specialized editor modes
        const modeMap = { 'drag-view': 'pan', select: 'select' };
        const editorMode = modeMap[mode] || mode;
        if (typeof editor._setEditMode === 'function') {
          editor._setEditMode(editorMode);
        }
      } else {
        // Use the piano roll's setUIMode method
        if (this.modal.pianoRollRenderer?.isMounted()) {
          this.modal.pianoRollRenderer?.setUIMode(mode);
        }
      }

      // Propagate to CC/Velocity/Tempo editors if the section is open
      if (this.modal.ccSectionExpanded) {
        const ccToolMap = {
          select: 'select',
          'drag-notes': 'move',
          edit: 'move',
          'drag-view': 'select'
        };
        const ccTool = ccToolMap[mode];
        if (ccTool) {
          if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
            this.modal.tempoEditor.setTool(ccTool);
          } else if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
            this.modal.velocityEditor.setTool(ccTool);
          } else if (this.modal.ccEditor) {
            this.modal.ccEditor.setTool(ccTool);
          }
          // Update CC tool button active states
          const ccToolBtns = this.modal.container?.querySelectorAll('.cc-tool-btn');
          if (ccToolBtns) {
            ccToolBtns.forEach((b) => b.classList.remove('active'));
          }
        }
      }

      // Update the UI
      this.updateModeButtons();

      this.modal.log('info', `Edit mode changed to: ${mode}`);
    }

    updateModeButtons() {
      const modeButtons = this.modal.container?.querySelectorAll('.editor-toolbar [data-mode]');
      if (!modeButtons) return;

      // Determine supported modes based on active editor
      const supportedModes = this._getSupportedModes();

      modeButtons.forEach((btn) => {
        // Skip hidden buttons (touch mode toggle)
        if (btn.classList.contains('hidden')) return;

        const btnMode = btn.dataset.mode;
        const isSupported = supportedModes.includes(btnMode);

        if (!isSupported) {
          // Disable unsupported modes (grayed out)
          btn.classList.remove('active');
          btn.classList.add('mode-unsupported');
          btn.disabled = true;
        } else if (btnMode === this.modal.editMode) {
          btn.classList.add('active');
          btn.classList.remove('mode-unsupported');
          btn.disabled = true;
        } else {
          btn.classList.remove('active', 'mode-unsupported');
          btn.disabled = false;
        }
      });
    }

    _getSupportedModes() {
      // Piano roll supports every mode; every specialized editor
      // (drum / wind / tablature) only supports pan + select.
      return this._getActiveSpecializedEditor()
        ? ['drag-view', 'select']
        : ['drag-view', 'select', 'edit', 'drag-notes', 'add-note', 'resize-note'];
    }

    toggleTouchMode() {
      this.modal.touchMode = !this.modal.touchMode;
      this.modal._saveTouchModePref(this.modal.touchMode);

      // Update the popover switch (standalone mode) and the inline
      // toolbar toggle (always present) so they stay in sync.
      const toggles = this.modal.container?.querySelectorAll(
        '#touch-mode-toggle, #touch-mode-inline-toggle'
      );
      const label = this.modal.touchMode ? this.modal.t('common.on') : this.modal.t('common.off');
      toggles?.forEach((btn) => {
        btn.dataset.active = String(this.modal.touchMode);
        btn.setAttribute('aria-pressed', String(this.modal.touchMode));
        const srLabel = btn.querySelector('.sr-only');
        if (srLabel) srLabel.textContent = label;
      });

      // Show/hide pencil button vs touch edit buttons
      const pencilBtn = this.modal.container?.querySelector('.edit-unified-btn');
      const touchBtns = this.modal.container?.querySelectorAll('.touch-edit-btn');

      if (pencilBtn) {
        pencilBtn.classList.toggle('hidden', this.modal.touchMode);
      }
      if (touchBtns) {
        touchBtns.forEach((b) => b.classList.toggle('hidden', !this.modal.touchMode));
      }

      // Adjust the current edit mode when needed
      if (
        !this.modal.touchMode &&
        (this.modal.editMode === 'drag-notes' ||
          this.modal.editMode === 'add-note' ||
          this.modal.editMode === 'resize-note')
      ) {
        // Leaving touch mode: switch back to the unified edit mode
        this.setEditMode('edit');
      } else if (this.modal.touchMode && this.modal.editMode === 'edit') {
        // Entering touch mode: switch to drag-notes
        this.setEditMode('drag-notes');
      }

      this.updateModeButtons();
      this.modal.log('info', `Touch mode: ${this.modal.touchMode ? 'ON' : 'OFF'}`);
    }

    // Delegates to clipboard sub-feature (extracted per audit §1.3)
    selectAll() {
      return this.clipboard?.selectAll();
    }
    updateEditButtons() {
      return this.clipboard?.updateEditButtons();
    }

    setupKeyboardShortcuts() {
      // Idempotent: a failed show() (initPianoRoll throwing before isOpen=true)
      // leaves the previous handler attached because doClose() never ran, so a
      // later open would stack a second handler on the reused singleton and fire
      // every shortcut twice — drop any existing one first (audit D M3).
      if (this.modal.keyboardHandler) {
        document.removeEventListener('keydown', this.modal.keyboardHandler);
        this.modal.keyboardHandler = null;
      }
      this.modal.keyboardHandler = (e) => {
        // A blocking sub-dialog/overlay open on top of the editor must swallow
        // ALL shortcuts, not just Escape: otherwise Delete deletes notes behind
        // the dialog and Space toggles playback AND preventDefault()s the
        // dialog's focused button (audit D M2). Use .visible for fade-out
        // dialogs so a dismissing one doesn't block the editor close.
        const hasOpenOverlay = !!document.querySelector(
          '.confirm-modal-overlay.visible, .rename-dialog-overlay, ' +
            '.unsaved-changes-modal, .file-info-modal-overlay.visible'
        );

        // Escape closes the modal — but not while a sub-dialog is open.
        if (e.key === 'Escape') {
          if (!hasOpenOverlay) {
            this.modal.close();
          }
          return;
        }

        // Skip remaining shortcuts while typing in a form control (INPUT /
        // TEXTAREA / SELECT — e.g. the channel/instrument pickers) or a
        // contentEditable, or while a blocking dialog is open (audit D M2).
        const tag = e.target && e.target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (e.target && e.target.isContentEditable)
        ) {
          return;
        }
        if (hasOpenOverlay) {
          return;
        }

        // Ctrl/Cmd + Z = Undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.undo();
        }

        // Ctrl/Cmd + Y = Redo (or Ctrl/Cmd + Shift + Z)
        else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
          e.preventDefault();
          this.redo();
        }

        // Ctrl/Cmd + C = Copy
        else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          e.preventDefault();
          this.copy();
        }

        // Ctrl/Cmd + V = Paste
        else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
          e.preventDefault();
          this.paste();
        }

        // Ctrl/Cmd + A = Select All
        else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
          e.preventDefault();
          this.selectAllNotes();
        }

        // Delete or Backspace = Delete
        else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          // When the CC/velocity section is open, delete the selected CC/velocity points
          if (this.modal.ccSectionExpanded) {
            this.modal.ccPicker.deleteSelectedCCVelocity();
          } else {
            // Otherwise delete the selected notes
            this.deleteSelectedNotes();
          }
        }

        // Space = Play/Pause
        else if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          this.modal.togglePlayback();
        }
      };

      document.addEventListener('keydown', this.modal.keyboardHandler);
    }

    _isSpecializedEditorActive() {
      return !!(
        (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) ||
        (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) ||
        (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)
      );
    }

    _getActiveViewportState() {
      const containerWidth =
        this.modal.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;

      // Tablature editor
      if (
        this.modal.tablatureEditor &&
        this.modal.tablatureEditor.isVisible &&
        this.modal.tablatureEditor.renderer
      ) {
        const r = this.modal.tablatureEditor.renderer;
        const headerWidth = r.headerWidth || 40;
        const tpp = r.ticksPerPixel || 2;
        const xoffset = r.scrollX || 0;
        const xrange = (containerWidth - headerWidth) * tpp;
        return { xoffset, xrange, ticksPerPixel: tpp };
      }

      // Drum pattern editor
      if (
        this.modal.drumPatternEditor &&
        this.modal.drumPatternEditor.isVisible &&
        this.modal.drumPatternEditor.gridRenderer
      ) {
        const r = this.modal.drumPatternEditor.gridRenderer;
        const headerWidth = r.headerWidth || 80;
        const tpp = r.ticksPerPixel || 2;
        const xoffset = r.scrollX || 0;
        const xrange = (containerWidth - headerWidth) * tpp;
        return { xoffset, xrange, ticksPerPixel: tpp };
      }

      // Wind instrument editor
      if (
        this.modal.windInstrumentEditor &&
        this.modal.windInstrumentEditor.isVisible &&
        this.modal.windInstrumentEditor.renderer
      ) {
        const r = this.modal.windInstrumentEditor.renderer;
        const headerWidth = r.headerWidth || 50;
        const tpp = r.ticksPerPixel || 2;
        const xoffset = r.scrollX || 0;
        const xrange = (containerWidth - headerWidth) * tpp;
        return { xoffset, xrange, ticksPerPixel: tpp };
      }

      // Default: piano roll
      if (this.modal.pianoRollRenderer?.isMounted()) {
        const xoffset = this.modal.pianoRollRenderer?.getXOffset() || 0;
        const xrange = this.modal.pianoRollRenderer?.getXRange() || 1920;
        const headerWidth = 64; // yruler 24 + kbwidth 40
        const tpp = xrange / Math.max(1, containerWidth - headerWidth);
        return { xoffset, xrange, ticksPerPixel: tpp };
      }

      return { xoffset: 0, xrange: 1920, ticksPerPixel: 2 };
    }

    // Flip a boolean playback preference, persist it, sync its toggle
    // button, and log. `flag` is the modal property name.
    _togglePlaybackPref(flag, savePref, btnId, logLabel) {
      const value = !this.modal[flag];
      this.modal[flag] = value;
      savePref.call(this.modal, value);
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.dataset.active = String(value);
        const srLabel = btn.querySelector('.sr-only');
        const label = value ? this.modal.t('common.on') : this.modal.t('common.off');
        if (srLabel) {
          srLabel.textContent = label;
        } else {
          btn.textContent = label;
        }
      }
      this.modal.log('info', `${logLabel}: ${value ? 'ON' : 'OFF'}`);
    }

    toggleKeyboardPlayback() {
      this._togglePlaybackPref(
        'keyboardPlaybackEnabled',
        this.modal._saveKeyboardPlaybackPref,
        'keyboard-playback-toggle',
        'Keyboard playback'
      );
    }

    toggleDragPlayback() {
      this._togglePlaybackPref(
        'dragPlaybackEnabled',
        this.modal._saveDragPlaybackPref,
        'drag-playback-toggle',
        'Drag playback'
      );
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorEditActions = MidiEditorEditActions;
  }
})();
