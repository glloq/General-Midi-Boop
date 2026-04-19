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

        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.undo !== 'function') {
            this.modal.log('warn', 'Undo not available');
            return;
        }

        if (this.modal.pianoRoll.undo()) {
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

        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.redo !== 'function') {
            this.modal.log('warn', 'Redo not available');
            return;
        }

        if (this.modal.pianoRoll.redo()) {
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

        if (!this.modal.pianoRoll) return;

        if (undoBtn) {
            undoBtn.disabled = !this.modal.pianoRoll.canUndo();
        }
        if (redoBtn) {
            redoBtn.disabled = !this.modal.pianoRoll.canRedo();
        }
    }

    getSelectedNotes() {
        if (!this.modal.pianoRoll) {
            return [];
        }

    // Use the piano roll's public method when available
        if (typeof this.modal.pianoRoll.getSelectedNotes === 'function') {
            return this.modal.pianoRoll.getSelectedNotes();
        }

    // Fallback: filter the sequence directly
        const sequence = this.modal.pianoRoll.sequence || [];
        return sequence.filter(note => note.f === 1); // f=1 indicates a selected note
    }

    getSelectionCount() {
        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.getSelectionCount !== 'function') {
            return 0;
        }
        return this.modal.pianoRoll.getSelectionCount();
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

        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.copySelection !== 'function') {
            this.modal.showNotification(this.modal.t('midiEditor.copyNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

    // Use the piano roll's method
        this.modal.clipboard = this.modal.pianoRoll.copySelection();

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

        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.pasteNotes !== 'function') {
            this.modal.showNotification(this.modal.t('midiEditor.pasteNotAvailable'), 'error');
            return;
        }

    // Get the current cursor position
        const currentTime = this.modal.pianoRoll.xoffset || 0;

    // Use the piano roll's method
        this.modal.pianoRoll.pasteNotes(this.modal.clipboard, currentTime);

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

        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.deleteSelection !== 'function') {
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
        this.modal.pianoRoll.deleteSelection();

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

    // Build a Set of (tick, channel) for deleted notes for fast lookup
        const deletedPositions = new Set();
        deletedNotes.forEach(note => {
    // Build a unique key per (tick + channel) position
            const key = `${note.t}_${note.c}`;
            deletedPositions.add(key);
        });

    // Delete CC/pitch-bend events at the same positions
        if (this.modal.ccEditor && this.modal.ccEditor.events) {
            const initialCCCount = this.modal.ccEditor.events.length;
            this.modal.ccEditor.events = this.modal.ccEditor.events.filter(event => {
                const key = `${event.ticks}_${event.channel}`;
                return !deletedPositions.has(key);
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
            this.modal.velocityEditor.setSequence(this.modal.pianoRoll.sequence);
            this.modal.velocityEditor.renderThrottled();
        }
    }

    selectAllNotes() {
    // Delegate to the unified selectAll() which handles all editor types
        this.selectAll();
    }

    async changeChannel() {
        if (!this.modal.pianoRoll || typeof this.modal.pianoRoll.changeChannelSelection !== 'function') {
            this.modal.showNotification(this.modal.t('midiEditor.changeChannelNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        const channelSelector = document.getElementById('channel-selector');
        if (!channelSelector) return;

        const newChannel = parseInt(channelSelector.value);
        const instrumentSelector = document.getElementById('instrument-selector');

    // Determine the current channel of the selected notes
        const selectedNotes = this.getSelectedNotes();
        const currentChannels = new Set(selectedNotes.map(n => n.c));
        const currentChannel = currentChannels.size === 1 ? Array.from(currentChannels)[0] : -1;

    // Check whether we are moving to the same channel
        if (currentChannel === newChannel) {
            this.modal.showNotification(this.modal.t('midiEditor.sameChannel'), 'info');
            return;
        }

    // Show the confirmation modal
        const confirmed = await this.modal.dialogs.showChangeChannelModal(count, currentChannel, newChannel);
        if (!confirmed) {
            this.modal.log('info', 'Channel change cancelled by user');
            return;
        }

    // Check whether the target channel already exists
        const targetChannelInfo = this.modal.channels.find(ch => ch.channel === newChannel);

    // If this is a new channel, use the program selected in the dropdown
        if (!targetChannelInfo && instrumentSelector) {
            this.modal.selectedInstrument = parseInt(instrumentSelector.value);
            this.modal.log('info', `New channel ${newChannel} will use instrument: ${this.modal.getInstrumentName(this.modal.selectedInstrument)}`);
        }

    // Use the piano roll's method to move the notes
        this.modal.pianoRoll.changeChannelSelection(newChannel);

        this.modal.log('info', `Changed channel of ${count} notes to ${newChannel}`);
        this.modal.showNotification(this.modal.t('midiEditor.channelChanged', { count }), 'success');

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();

    // Update the channel list (automatically drops empty channels)
        this.modal.ccPicker.updateChannelsFromSequence();

    // Clean up activeChannels: remove channels that no longer exist
        const existingChannelNumbers = new Set(this.modal.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.modal.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.modal.activeChannels.delete(ch);
            this.modal.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Auto-activate the new channel if it was not already active
        if (!this.modal.activeChannels.has(newChannel)) {
            this.modal.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);

    // Refresh the channel buttons
        this.refreshChannelButtons();

    // Update the instrument selector for the new channel
        this.modal.renderer.updateInstrumentSelector();

        this.updateEditButtons();
    }

    refreshChannelButtons(keepPopover = false) {
        if (!keepPopover) {
            this.modal.tablatureOps._closeChannelSettingsPopover();
        }

        const channelsToolbar = this.modal.container?.querySelector('.channels-toolbar');
        if (channelsToolbar) {
    // Preserve scroll position across DOM rebuild
            const scrollLeft = channelsToolbar.scrollLeft;

            channelsToolbar.innerHTML = this.modal.renderer.renderChannelButtons();

    // Restore scroll position so the user sees the same channels as before
            channelsToolbar.scrollLeft = scrollLeft;

    // Events are handled through delegation on this.modal.container
    // (see attachEventHandlers) — no need to rebind direct listeners

    // Re-apply --chip-bg / --chip-border CSS vars on the freshly rendered
    // chips. renderChannelButtons() only emits --chip-color inline; without
    // this call, active chips remain visually greyed until "show all" is hit.
            this.modal.routingOps?.updateChannelButtons();

    // Update disabled visual states
            this.modal.channelDisabled.forEach(ch => {
                this.modal.tablatureOps._updateChannelDisabledVisual(ch);
            });

    // Update TAB button active states
            this.modal.tablatureOps._updateChannelTabButtons();

    // Update DRUM button active states
            this.modal.tablatureOps._updateDrumButtonState(
                this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible
            );

    // Update WIND button active states
            this.modal.tablatureOps._updateWindButtonState(
                this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible
            );

    // Async: adjust TAB buttons based on DB cc_enabled setting
            this.modal.tablatureOps._refreshStringInstrumentChannels();
        }
    }

    async applyInstrument() {
        if (this.modal.activeChannels.size === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noActiveChannel'), 'info');
            return;
        }

    // If several channels are active, ask to keep only one
        if (this.modal.activeChannels.size > 1) {
            this.modal.showNotification(
                this.modal.t('midiEditor.multipleChannelsWarning', { count: this.modal.activeChannels.size }),
                'warning'
            );
            return;
        }

        const instrumentSelector = document.getElementById('instrument-selector');
        if (!instrumentSelector) return;

        const selectedProgram = parseInt(instrumentSelector.value);
        const instrumentName = this.modal.getInstrumentName(selectedProgram);

    // Only one active channel: that's the one we modify
        const targetChannel = Array.from(this.modal.activeChannels)[0];
        const channelInfo = this.modal.channels.find(ch => ch.channel === targetChannel);

        if (!channelInfo) {
            this.modal.log('error', `Channel ${targetChannel} not found in this.modal.channels`);
            return;
        }

    // Check whether the program is changing
        if (channelInfo.program === selectedProgram) {
            this.modal.showNotification(this.modal.t('midiEditor.sameInstrument'), 'info');
            return;
        }

    // Check whether any notes are selected
        const selectionCount = this.getSelectionCount();
        const hasSelection = selectionCount > 0;

    // Show the confirmation modal
        const result = await this.modal.dialogs.showChangeInstrumentModal({
            noteCount: selectionCount,
            channelNoteCount: channelInfo.noteCount,
            channel: targetChannel,
            currentInstrument: channelInfo.instrument,
            newInstrument: instrumentName,
            hasSelection
        });

        if (result === false) {
            this.modal.log('info', 'Instrument change cancelled by user');
            return;
        }

        if (result === true && hasSelection) {
    // Change only the selected notes
    // They must be moved to a new channel with the new program
            await this.applyInstrumentToSelection(selectedProgram, instrumentName);
        } else {
    // Change the whole channel (result === 'channel' or no selection)
            this.applyInstrumentToChannel(targetChannel, selectedProgram, instrumentName, channelInfo);
        }
    }

    async applyInstrumentToSelection(program, instrumentName) {
        const selectedNotes = this.getSelectedNotes();
        if (selectedNotes.length === 0) return;

    // Find a free channel for the notes with the new instrument
        let newChannel = this.findAvailableChannel(program);

        if (newChannel === -1) {
            this.modal.showNotification(this.modal.t('midiEditor.noChannelAvailable'), 'error');
            return;
        }

    // Append the new channel to the list if it does not exist
        let channelInfo = this.modal.channels.find(ch => ch.channel === newChannel);
        if (!channelInfo) {
            channelInfo = {
                channel: newChannel,
                program: program,
                instrument: newChannel === 9 ? 'Drums' : instrumentName,
                noteCount: 0
            };
            this.modal.channels.push(channelInfo);
        } else {
    // Update the channel's program
            channelInfo.program = program;
            channelInfo.instrument = newChannel === 9 ? 'Drums' : instrumentName;
        }

    // Move the selected notes to the new channel
        if (this.modal.pianoRoll && typeof this.modal.pianoRoll.changeChannelSelection === 'function') {
            this.modal.pianoRoll.changeChannelSelection(newChannel);
        }

        this.modal.log('info', `Applied instrument ${instrumentName} to ${selectedNotes.length} selected notes (moved to channel ${newChannel + 1})`);
        this.modal.showNotification(
            this.modal.t('midiEditor.instrumentAppliedToSelection', { count: selectedNotes.length, instrument: instrumentName }),
            'success'
        );

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
        this.modal.ccPicker.updateChannelsFromSequence();

    // Clean up activeChannels: remove channels that no longer exist
        const existingChannelNumbers = new Set(this.modal.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.modal.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.modal.activeChannels.delete(ch);
            this.modal.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Activate the new channel
        if (!this.modal.activeChannels.has(newChannel)) {
            this.modal.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);

        this.refreshChannelButtons();
        this.modal.tablatureOps._refreshStringInstrumentChannels();
        this.modal.renderer.updateInstrumentSelector();
        this.updateEditButtons();
    }

    applyInstrumentToChannel(channel, program, instrumentName, channelInfo) {
        channelInfo.program = program;
        channelInfo.instrument = channel === 9 ? 'Drums' : instrumentName;
        channelInfo.hasExplicitProgram = true;

        this.modal.log('info', `Applied instrument ${instrumentName} to channel ${channel + 1}`);
        this.modal.showNotification(this.modal.t('midiEditor.instrumentApplied', { channel: channel + 1, instrument: instrumentName }), 'success');

        // Reset feedback instruments so they get reloaded with the new program
        if (this.modal._playback) this.modal._playback._feedbackInstrumentsLoaded = false;

        this.refreshChannelButtons();
        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();

    // Clean up stale string instrument config if program changed to non-string
        const gmMatch = typeof MidiEditorChannelPanel !== 'undefined'
            ? MidiEditorChannelPanel.getStringInstrumentCategory(program)
            : null;
        if (!gmMatch) {
    // Delete stale DB record for this channel so TAB doesn't reappear
            this.modal.api.sendCommand('string_instrument_delete', {
                device_id: this.modal.tablatureOps.getEffectiveDeviceId(),
                channel: channel
            }).catch(() => { /* ignore if no record existed */ });
        }

    // Update tablature buttons (string instrument detection may change)
        this.modal.tablatureOps._refreshStringInstrumentChannels();
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateTablatureButton();
        }
    }

    findAvailableChannel(program) {
    // Look first for an existing channel with the same program
        const existingChannel = this.modal.channels.find(ch => ch.program === program && ch.channel !== 9);
        if (existingChannel) {
            return existingChannel.channel;
        }

    // Otherwise, find a free channel (0-15, except 9 for drums)
        const usedChannels = new Set(this.modal.channels.map(ch => ch.channel));

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue; // Skip drum channel
            if (!usedChannels.has(i)) {
                return i;
            }
        }

    // If every channel is taken, use the first available one that is not the current channel
        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            const channelInfo = this.modal.channels.find(ch => ch.channel === i);
            if (channelInfo && channelInfo.noteCount === 0) {
                return i;
            }
        }

        return -1; // No channel available
    }

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
        if (this.modal.pianoRoll) {
            this.modal.pianoRoll.snap = currentSnap.ticks;
            this.modal.log('info', `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${this.modal.pianoRoll.snap}`);
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
        if (this.modal.pianoRoll) {
            this.modal.pianoRoll.tempo = newTempo;
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
            if (this.modal.pianoRoll && typeof this.modal.pianoRoll.setUIMode === 'function') {
                this.modal.pianoRoll.setUIMode(mode);
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

        // Update the toggle button
        const toggleBtn = this.modal.container?.querySelector('#touch-mode-toggle');
        if (toggleBtn) {
            toggleBtn.dataset.active = String(this.modal.touchMode);
            const srLabel = toggleBtn.querySelector('.sr-only');
            const label = this.modal.touchMode ? this.modal.t('common.on') : this.modal.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                toggleBtn.textContent = label;
            }
        }

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
        if (this.modal.pianoRoll && typeof this.modal.pianoRoll.selectAll === 'function') {
            this.modal.pianoRoll.selectAll();
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
    // Skip when focus is inside an input/textarea
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
        if (this.modal.pianoRoll) {
            const xoffset = this.modal.pianoRoll.xoffset || 0;
            const xrange = this.modal.pianoRoll.xrange || 1920;
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
