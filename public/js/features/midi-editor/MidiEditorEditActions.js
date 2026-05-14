// ============================================================================
// File: public/js/features/midi-editor/MidiEditorEditActions.js
// Description: Edit actions (undo/redo, copy/paste, channel/instrument,
//   edit modes, keyboard shortcuts) for the MIDI editor.
//   Sub-component class ; called via `modal.editActions.<method>(...)`.
//   (P2-F.10j body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorEditActions {
        constructor(modal) {
            this.modal = modal;
            // Sub-feature: channel & instrument operations (audit §1.3).
            this.channelOps = typeof MidiEditorChannelOps !== 'undefined'
                ? new MidiEditorChannelOps(this)
                : null;
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

    undo() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (specializedRenderer.undo()) {
                const editor = this._getActiveSpecializedEditor();
    // Wind editor needs monophony enforcement
                if (editor && typeof editor._enforceMonophony === 'function') {
                    editor._enforceMonophony();
                }
                if (editor && typeof editor._syncToMidi === 'function') {
                    editor._syncToMidi();
                }
                this.modal.isDirty = true;
                this.modal.routingOps.updateSaveButton();
                this.updateUndoRedoButtonsState();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.log('warn', 'Undo not available');
            return;
        }

        if (this.modal.pianoRollRenderer?.undo()) {
            this.modal.log('info', 'Undo successful');
            this.modal.isDirty = true;
            this.modal.routingOps.updateSaveButton();
            this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    redo() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (specializedRenderer.redo()) {
                const editor = this._getActiveSpecializedEditor();
                if (editor && typeof editor._enforceMonophony === 'function') {
                    editor._enforceMonophony();
                }
                if (editor && typeof editor._syncToMidi === 'function') {
                    editor._syncToMidi();
                }
                this.modal.isDirty = true;
                this.modal.routingOps.updateSaveButton();
                this.updateUndoRedoButtonsState();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.log('warn', 'Redo not available');
            return;
        }

        if (this.modal.pianoRollRenderer?.redo()) {
            this.modal.log('info', 'Redo successful');
            this.modal.isDirty = true;
            this.modal.routingOps.updateSaveButton();
            this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    updateUndoRedoButtonsState() {
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');

        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            const canUndo = typeof specializedRenderer.canUndo === 'function' ? specializedRenderer.canUndo() : true;
            const canRedo = typeof specializedRenderer.canRedo === 'function' ? specializedRenderer.canRedo() : true;
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

    getSelectedNotes() {
        if (!this.modal.pianoRollRenderer?.isMounted()) {
            return [];
        }

    // Use the piano roll's public method when available
        if (true) {
            return this.modal.pianoRollRenderer?.getSelectedNotes();
        }

    // Fallback: filter the sequence directly
        const sequence = this.modal.pianoRollRenderer?.getSequence() || [];
        return sequence.filter(note => note.f === 1); // f=1 indicates a selected note
    }

    getSelectionCount() {
        if (!this.modal.pianoRollRenderer?.isMounted()) {
            return 0;
        }
        return this.modal.pianoRollRenderer?.getSelectionCount();
    }

    copy() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.copySelected === 'function') {
                specializedRenderer.copySelected();
                this.modal.log('info', 'Copied selection from specialized editor');
    // Enable paste button
                const pasteBtn = document.getElementById('paste-btn');
                if (pasteBtn) pasteBtn.disabled = false;
            }
            return;
        }

        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.showNotification(this.modal.t('midiEditor.copyNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

    // Use the piano roll's method
        this.modal.clipboard = this.modal.pianoRollRenderer?.copySelection();

        this.modal.log('info', `Copied ${this.modal.clipboard.length} notes`);
        this.modal.showNotification(this.modal.t('midiEditor.notesCopied', { count: this.modal.clipboard.length }), 'success');

    // Enable the Paste button
        const pasteBtn = document.getElementById('paste-btn');
        if (pasteBtn) {
            pasteBtn.disabled = false;
        }

        this.updateEditButtons();
    }

    paste() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.hasClipboard === 'function' && specializedRenderer.hasClipboard()) {
                const tick = specializedRenderer.playheadTick || 0;
                specializedRenderer.paste(tick);
                const editor = this._getActiveSpecializedEditor();
                if (editor && typeof editor._enforceMonophony === 'function') {
                    editor._enforceMonophony();
                }
                if (editor && typeof editor._syncToMidi === 'function') {
                    editor._syncToMidi();
                }
                this.modal.isDirty = true;
                this.modal.routingOps.updateSaveButton();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.modal.clipboard || this.modal.clipboard.length === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.clipboardEmpty'), 'info');
            return;
        }

        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.showNotification(this.modal.t('midiEditor.pasteNotAvailable'), 'error');
            return;
        }

    // Get the current cursor (playhead) position
        const currentTime = this.modal.pianoRollRenderer?.getCursor() || 0;

    // Use the piano roll's method
        this.modal.pianoRollRenderer?.pasteNotes(this.modal.clipboard, currentTime);

        this.modal.log('info', `Pasted ${this.modal.clipboard.length} notes`);
        this.modal.showNotification(this.modal.t('midiEditor.notesPasted', { count: this.modal.clipboard.length }), 'success');

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    deleteSelectedNotes() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.deleteSelected === 'function') {
                if (specializedRenderer.deleteSelected() > 0) {
                    const editor = this._getActiveSpecializedEditor();
                    if (editor && typeof editor._syncToMidi === 'function') {
                        editor._syncToMidi();
                    }
                    this.modal.isDirty = true;
                    this.modal.routingOps.updateSaveButton();
                    this.updateEditButtons();
                }
            }
            return;
        }

        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.showNotification(this.modal.t('midiEditor.deleteNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

    // Grab the selected notes before deletion
        const selectedNotes = this.getSelectedNotes();

    // Use the piano roll's method
        this.modal.pianoRollRenderer?.deleteSelection();

    // Delete CC/velocity points associated with deleted notes
        this.deleteAssociatedCCAndVelocity(selectedNotes);

        this.modal.log('info', `Deleted ${count} notes`);
        this.modal.showNotification(this.modal.t('midiEditor.notesDeleted', { count }), 'success');

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    deleteAssociatedCCAndVelocity(deletedNotes) {
        if (!deletedNotes || deletedNotes.length === 0) return;

        // Pack (tick, channel) into a single integer key. MIDI channels fit
        // in 4 bits (0-15) so `tick * 16 + channel` is collision-free up to
        // 2^49 ticks (well past any musically realistic value). Avoids the
        // string allocation per note that used to dominate large deletes.
        const deletedPositions = new Set();
        deletedNotes.forEach(note => {
            deletedPositions.add(note.t * 16 + note.c);
        });

    // Delete CC/pitch-bend events at the same positions
        if (this.modal.ccEditor && this.modal.ccEditor.events) {
            const initialCCCount = this.modal.ccEditor.events.length;
            this.modal.ccEditor.events = this.modal.ccEditor.events.filter(event => {
                return !deletedPositions.has(event.ticks * 16 + event.channel);
            });
            const deletedCCCount = initialCCCount - this.modal.ccEditor.events.length;
            if (deletedCCCount > 0) {
                this.modal.log('info', `Deleted ${deletedCCCount} CC/pitchbend events associated with deleted notes`);
                this.modal.ccEditor.renderThrottled();
            }
        }

    // Delete velocity points of deleted notes
    // (velocity is already removed with the note, but we still refresh the editor)
        if (this.modal.velocityEditor) {
            this.modal.velocityEditor.setSequence(this.modal.pianoRollRenderer?.getSequence());
            this.modal.velocityEditor.renderThrottled();
        }
    }

    selectAllNotes() {
    // Delegate to the unified selectAll() which handles all editor types
        this.selectAll();
    }

    // Delegates to channelOps sub-feature (extracted per audit §1.3)
    async changeChannel()                                                { return this.channelOps?.changeChannel(); }
    refreshChannelButtons(keepPopover = false)                           { return this.channelOps?.refreshChannelButtons(keepPopover); }
    async applyInstrument()                                              { return this.channelOps?.applyInstrument(); }
    async applyInstrumentToSelection(program, instrumentName)            { return this.channelOps?.applyInstrumentToSelection(program, instrumentName); }
    applyInstrumentToChannel(channel, program, instrumentName, info)     { return this.channelOps?.applyInstrumentToChannel(channel, program, instrumentName, info); }
    findAvailableChannel(program)                                        { return this.channelOps?.findAvailableChannel(program) ?? -1; }

    cycleSnap() {
    // Move to the next value (cycle)
        this.modal.currentSnapIndex = (this.modal.currentSnapIndex + 1) % this.modal.snapValues.length;

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
            this.modal.log('info', `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${this.modal.pianoRollRenderer?.getElement()?.snap}`);
        }

    // Sync every editor
        this.modal.ccPicker.syncAllEditors();

        this.modal.showNotification(this.modal.t('midiEditor.snapChanged', { snap: currentSnap.label }), 'info');
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
        this.modal.showNotification(this.modal.t('midiEditor.tempoChanged', { tempo: newTempo }), 'info');
    }

    setEditMode(mode) {
        this.modal.editMode = mode;

    // Dispatch to specialized editor if active
        const editor = this._getActiveSpecializedEditor();
        if (editor) {
    // Map main toolbar modes to specialized editor modes
            const modeMap = { 'drag-view': 'pan', 'select': 'select' };
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
            const ccToolMap = { 'select': 'select', 'drag-notes': 'move', 'edit': 'move', 'drag-view': 'select' };
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
                    ccToolBtns.forEach(b => b.classList.remove('active'));
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

        modeButtons.forEach(btn => {
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
        const editor = this._getActiveSpecializedEditor();
        if (!editor) {
    // Piano roll: all modes
            return ['drag-view', 'select', 'edit', 'drag-notes', 'add-note', 'resize-note'];
        }
        if (editor === this.modal.drumPatternEditor) {
            return ['drag-view', 'select'];
        }
        if (editor === this.modal.windInstrumentEditor) {
            return ['drag-view', 'select'];
        }
        if (editor === this.modal.tablatureEditor) {
            return ['drag-view', 'select'];
        }
        return ['drag-view', 'select'];
    }

    toggleTouchMode() {
        this.modal.touchMode = !this.modal.touchMode;
        this.modal._saveTouchModePref(this.modal.touchMode);

        // Update the popover switch (standalone mode) and the inline
        // toolbar toggle (always present) so they stay in sync.
        const toggles = this.modal.container?.querySelectorAll('#touch-mode-toggle, #touch-mode-inline-toggle');
        const label = this.modal.touchMode ? this.modal.t('common.on') : this.modal.t('common.off');
        toggles?.forEach(btn => {
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
            touchBtns.forEach(b => b.classList.toggle('hidden', !this.modal.touchMode));
        }

        // Adjust the current edit mode when needed
        if (!this.modal.touchMode && (this.modal.editMode === 'drag-notes' || this.modal.editMode === 'add-note' || this.modal.editMode === 'resize-note')) {
            // Leaving touch mode: switch back to the unified edit mode
            this.setEditMode('edit');
        } else if (this.modal.touchMode && this.modal.editMode === 'edit') {
            // Entering touch mode: switch to drag-notes
            this.setEditMode('drag-notes');
        }

        this.updateModeButtons();
        this.modal.log('info', `Touch mode: ${this.modal.touchMode ? 'ON' : 'OFF'}`);
    }

    selectAll() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.selectAll === 'function') {
                specializedRenderer.selectAll();
                this.updateEditButtons();
            }
            return;
        }

    // Piano roll: select all notes
        if (this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.pianoRollRenderer?.selectAll();
            this.updateEditButtons();
        }
    }

    updateEditButtons() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
    // For specialized editors, enable buttons based on renderer state
            const hasSelection = typeof specializedRenderer.getSelectionCount === 'function'
                ? specializedRenderer.getSelectionCount() > 0
                : true; // Default to enabled if we can't check
            const copyBtn = document.getElementById('copy-btn');
            const deleteBtn = document.getElementById('delete-btn');
            const pasteBtn = document.getElementById('paste-btn');
            const changeChannelBtn = document.getElementById('change-channel-btn');
            if (copyBtn) copyBtn.disabled = !hasSelection;
            if (deleteBtn) deleteBtn.disabled = !hasSelection;
            if (pasteBtn) pasteBtn.disabled = !(typeof specializedRenderer.hasClipboard === 'function' && specializedRenderer.hasClipboard());
            if (changeChannelBtn) changeChannelBtn.disabled = true; // Not applicable for specialized editors
            return;
        }

        const selectionCount = this.getSelectionCount();
        const hasSelection = selectionCount > 0;

        const copyBtn = document.getElementById('copy-btn');
        const deleteBtn = document.getElementById('delete-btn');
        const changeChannelBtn = document.getElementById('change-channel-btn');

        if (copyBtn) copyBtn.disabled = !hasSelection;
        if (deleteBtn) deleteBtn.disabled = !hasSelection;
        if (changeChannelBtn) changeChannelBtn.disabled = !hasSelection;

        this.modal.log('debug', `Selection: ${selectionCount} notes`);
    }

    setupKeyboardShortcuts() {
        this.modal.keyboardHandler = (e) => {
    // Escape closes the modal — but not if a sub-dialog is currently open.
    // Use .visible for dialogs that fade-out (opacity:0 + pointer-events:none
    // while fading) so a dismissing dialog doesn't block the editor close.
            if (e.key === 'Escape') {
                const hasOpenOverlay = document.querySelector(
                    '.confirm-modal-overlay.visible, .rename-dialog-overlay, ' +
                    '.unsaved-changes-modal, .file-info-modal-overlay.visible'
                );
                if (!hasOpenOverlay) {
                    this.modal.close();
                }
                return;
            }

    // Skip remaining shortcuts when focus is inside an input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
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
        const containerWidth = this.modal.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;

        // Tablature editor
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.tablatureEditor.renderer) {
            const r = this.modal.tablatureEditor.renderer;
            const headerWidth = r.headerWidth || 40;
            const tpp = r.ticksPerPixel || 2;
            const xoffset = r.scrollX || 0;
            const xrange = (containerWidth - headerWidth) * tpp;
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        // Drum pattern editor
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible && this.modal.drumPatternEditor.gridRenderer) {
            const r = this.modal.drumPatternEditor.gridRenderer;
            const headerWidth = r.headerWidth || 80;
            const tpp = r.ticksPerPixel || 2;
            const xoffset = r.scrollX || 0;
            const xrange = (containerWidth - headerWidth) * tpp;
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        // Wind instrument editor
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible && this.modal.windInstrumentEditor.renderer) {
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

    toggleKeyboardPlayback() {
        this.modal.keyboardPlaybackEnabled = !this.modal.keyboardPlaybackEnabled;
        this.modal._saveKeyboardPlaybackPref(this.modal.keyboardPlaybackEnabled);
        const btn = document.getElementById('keyboard-playback-toggle');
        if (btn) {
            btn.dataset.active = String(this.modal.keyboardPlaybackEnabled);
            const srLabel = btn.querySelector('.sr-only');
            const label = this.modal.keyboardPlaybackEnabled ? this.modal.t('common.on') : this.modal.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                btn.textContent = label;
            }
        }
        this.modal.log('info', `Keyboard playback: ${this.modal.keyboardPlaybackEnabled ? 'ON' : 'OFF'}`);
    }

    toggleDragPlayback() {
        this.modal.dragPlaybackEnabled = !this.modal.dragPlaybackEnabled;
        this.modal._saveDragPlaybackPref(this.modal.dragPlaybackEnabled);
        const btn = document.getElementById('drag-playback-toggle');
        if (btn) {
            btn.dataset.active = String(this.modal.dragPlaybackEnabled);
            const srLabel = btn.querySelector('.sr-only');
            const label = this.modal.dragPlaybackEnabled ? this.modal.t('common.on') : this.modal.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                btn.textContent = label;
            }
        }
        this.modal.log('info', `Drag playback: ${this.modal.dragPlaybackEnabled ? 'ON' : 'OFF'}`);
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorEditActions = MidiEditorEditActions;
    }
})();
