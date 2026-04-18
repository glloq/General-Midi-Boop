// ============================================================================
// File: public/js/views/components/midi-editor/MidiEditorEditActions.js
// Description: Editing actions (undo/redo/copy/paste/delete/channel/instrument)
//   Mixin: methods added to MidiEditorModal.prototype
// ============================================================================

(function() {
    'use strict';

    const MidiEditorEditActionsMixin = {};

    // ========================================================================
    // EDIT ACTIONS
    // ========================================================================

    /**
    * Return the active specialized editor (Drum, Wind, Tablature) or null when the piano roll is focused
    */
    MidiEditorEditActionsMixin._getActiveSpecializedEditor = function() {
        if (this.drumPatternEditor?.isVisible) return this.drumPatternEditor;
        if (this.windInstrumentEditor?.isVisible) return this.windInstrumentEditor;
        if (this.tablatureEditor?.isVisible) return this.tablatureEditor;
        return null;
    }

    /**
    * Return the inner renderer of the active specialized editor
    */
    MidiEditorEditActionsMixin._getActiveSpecializedRenderer = function() {
        const editor = this._getActiveSpecializedEditor();
        if (!editor) return null;
        return editor.gridRenderer || editor.renderer || null;
    }

    /**
    * Undo the last action
    */
    MidiEditorEditActionsMixin.undo = function() {
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
                this.isDirty = true;
                this.updateSaveButton();
                this.updateUndoRedoButtonsState();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.undo !== 'function') {
            this.log('warn', 'Undo not available');
            return;
        }

        if (this.pianoRoll.undo()) {
            this.log('info', 'Undo successful');
            this.isDirty = true;
            this.updateSaveButton();
            this.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
    * Redo the last undone action
    */
    MidiEditorEditActionsMixin.redo = function() {
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
                this.isDirty = true;
                this.updateSaveButton();
                this.updateUndoRedoButtonsState();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.redo !== 'function') {
            this.log('warn', 'Redo not available');
            return;
        }

        if (this.pianoRoll.redo()) {
            this.log('info', 'Redo successful');
            this.isDirty = true;
            this.updateSaveButton();
            this.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
    * Update the undo/redo button state
    */
    MidiEditorEditActionsMixin.updateUndoRedoButtonsState = function() {
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

        if (!this.pianoRoll) return;

        if (undoBtn) {
            undoBtn.disabled = !this.pianoRoll.canUndo();
        }
        if (redoBtn) {
            redoBtn.disabled = !this.pianoRoll.canRedo();
        }
    }

    /**
    * Return the piano roll's currently selected notes
    */
    MidiEditorEditActionsMixin.getSelectedNotes = function() {
        if (!this.pianoRoll) {
            return [];
        }

    // Use the piano roll's public method when available
        if (typeof this.pianoRoll.getSelectedNotes === 'function') {
            return this.pianoRoll.getSelectedNotes();
        }

    // Fallback: filter the sequence directly
        const sequence = this.pianoRoll.sequence || [];
        return sequence.filter(note => note.f === 1); // f=1 indique une note sélectionnée
    }

    /**
    * Return the number of selected notes
    */
    MidiEditorEditActionsMixin.getSelectionCount = function() {
        if (!this.pianoRoll || typeof this.pianoRoll.getSelectionCount !== 'function') {
            return 0;
        }
        return this.pianoRoll.getSelectionCount();
    }

    /**
    * Copy the selected notes
    */
    MidiEditorEditActionsMixin.copy = function() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.copySelected === 'function') {
                specializedRenderer.copySelected();
                this.log('info', 'Copied selection from specialized editor');
    // Enable paste button
                const pasteBtn = document.getElementById('paste-btn');
                if (pasteBtn) pasteBtn.disabled = false;
            }
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.copySelection !== 'function') {
            this.showNotification(this.t('midiEditor.copyNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

    // Use the piano roll's method
        this.clipboard = this.pianoRoll.copySelection();

        this.log('info', `Copied ${this.clipboard.length} notes`);
        this.showNotification(this.t('midiEditor.notesCopied', { count: this.clipboard.length }), 'success');

    // Enable the Paste button
        const pasteBtn = document.getElementById('paste-btn');
        if (pasteBtn) {
            pasteBtn.disabled = false;
        }

        this.updateEditButtons();
    }

    /**
    * Paste notes from the clipboard
    */
    MidiEditorEditActionsMixin.paste = function() {
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
                this.isDirty = true;
                this.updateSaveButton();
                this.updateEditButtons();
            }
            return;
        }

        if (!this.clipboard || this.clipboard.length === 0) {
            this.showNotification(this.t('midiEditor.clipboardEmpty'), 'info');
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.pasteNotes !== 'function') {
            this.showNotification(this.t('midiEditor.pasteNotAvailable'), 'error');
            return;
        }

    // Obtenir la position actuelle du curseur
        const currentTime = this.pianoRoll.xoffset || 0;

    // Use the piano roll's method
        this.pianoRoll.pasteNotes(this.clipboard, currentTime);

        this.log('info', `Pasted ${this.clipboard.length} notes`);
        this.showNotification(this.t('midiEditor.notesPasted', { count: this.clipboard.length }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    /**
    * Delete the selected notes
    */
    MidiEditorEditActionsMixin.deleteSelectedNotes = function() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.deleteSelected === 'function') {
                if (specializedRenderer.deleteSelected() > 0) {
                    const editor = this._getActiveSpecializedEditor();
                    if (editor && typeof editor._syncToMidi === 'function') {
                        editor._syncToMidi();
                    }
                    this.isDirty = true;
                    this.updateSaveButton();
                    this.updateEditButtons();
                }
            }
            return;
        }

        if (!this.pianoRoll || typeof this.pianoRoll.deleteSelection !== 'function') {
            this.showNotification(this.t('midiEditor.deleteNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

    // Grab the selected notes before deletion
        const selectedNotes = this.getSelectedNotes();

    // Use the piano roll's method
        this.pianoRoll.deleteSelection();

    // Delete CC/velocity points associated with deleted notes
        this.deleteAssociatedCCAndVelocity(selectedNotes);

        this.log('info', `Deleted ${count} notes`);
        this.showNotification(this.t('midiEditor.notesDeleted', { count }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.updateEditButtons();
    }

    /**
    * Supprimer les événements CC et vélocité associés aux notes supprimées
    */
    MidiEditorEditActionsMixin.deleteAssociatedCCAndVelocity = function(deletedNotes) {
        if (!deletedNotes || deletedNotes.length === 0) return;

    // Build a Set of (tick, channel) for deleted notes for fast lookup
        const deletedPositions = new Set();
        deletedNotes.forEach(note => {
    // Build a unique key per (tick + channel) position
            const key = `${note.t}_${note.c}`;
            deletedPositions.add(key);
        });

    // Delete CC/pitch-bend events at the same positions
        if (this.ccEditor && this.ccEditor.events) {
            const initialCCCount = this.ccEditor.events.length;
            this.ccEditor.events = this.ccEditor.events.filter(event => {
                const key = `${event.ticks}_${event.channel}`;
                return !deletedPositions.has(key);
            });
            const deletedCCCount = initialCCCount - this.ccEditor.events.length;
            if (deletedCCCount > 0) {
                this.log('info', `Deleted ${deletedCCCount} CC/pitchbend events associated with deleted notes`);
                this.ccEditor.renderThrottled();
            }
        }

    // Delete velocity points of deleted notes
    // (velocity is already removed with the note, but we still refresh the editor)
        if (this.velocityEditor) {
            this.velocityEditor.setSequence(this.pianoRoll.sequence);
            this.velocityEditor.renderThrottled();
        }
    }

    /**
    * Select all notes affichées (canaux actifs)
    */
    MidiEditorEditActionsMixin.selectAllNotes = function() {
    // Delegate to the unified selectAll() which handles all editor types
        this.selectAll();
    }

    /**
    * Changer le canal des notes sélectionnées
    */
    MidiEditorEditActionsMixin.changeChannel = async function() {
        if (!this.pianoRoll || typeof this.pianoRoll.changeChannelSelection !== 'function') {
            this.showNotification(this.t('midiEditor.changeChannelNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            this.showNotification(this.t('midiEditor.noNoteSelected'), 'info');
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
            this.showNotification(this.t('midiEditor.sameChannel'), 'info');
            return;
        }

    // Afficher le modal de confirmation
        const confirmed = await this.dialogs.showChangeChannelModal(count, currentChannel, newChannel);
        if (!confirmed) {
            this.log('info', 'Channel change cancelled by user');
            return;
        }

    // Check whether the target channel already exists
        const targetChannelInfo = this.channels.find(ch => ch.channel === newChannel);

    // If this is a new channel, use the program selected in the dropdown
        if (!targetChannelInfo && instrumentSelector) {
            this.selectedInstrument = parseInt(instrumentSelector.value);
            this.log('info', `New channel ${newChannel} will use instrument: ${this.getInstrumentName(this.selectedInstrument)}`);
        }

    // Use the piano roll's method to move the notes
        this.pianoRoll.changeChannelSelection(newChannel);

        this.log('info', `Changed channel of ${count} notes to ${newChannel}`);
        this.showNotification(this.t('midiEditor.channelChanged', { count }), 'success');

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();

    // Update the channel list (automatically drops empty channels)
        this.ccPicker.updateChannelsFromSequence();

    // Nettoyer activeChannels : retirer les canaux qui n'existent plus
        const existingChannelNumbers = new Set(this.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.activeChannels.delete(ch);
            this.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Auto-activate the new channel if it was not already active
        if (!this.activeChannels.has(newChannel)) {
            this.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.updateSequenceFromActiveChannels(null, true);

    // Refresh the channel buttons
        this.refreshChannelButtons();

    // Update the instrument selector for the new channel
        this.updateInstrumentSelector();

        this.updateEditButtons();
    }

    /**
    * Rafraîchir les boutons de canal
    */
    MidiEditorEditActionsMixin.refreshChannelButtons = function(keepPopover = false) {
        if (!keepPopover) {
            this._closeChannelSettingsPopover();
        }

        const channelsToolbar = this.container?.querySelector('.channels-toolbar');
        if (channelsToolbar) {
    // Preserve scroll position across DOM rebuild
            const scrollLeft = channelsToolbar.scrollLeft;

            channelsToolbar.innerHTML = this.renderChannelButtons();

    // Restore scroll position so the user sees the same channels as before
            channelsToolbar.scrollLeft = scrollLeft;

    // Events are handled through delegation on this.container
    // (see attachEventHandlers) — no need to rebind direct listeners

    // Update disabled visual states
            this.channelDisabled.forEach(ch => {
                this._updateChannelDisabledVisual(ch);
            });

    // Update TAB button active states
            this._updateChannelTabButtons();

    // Update DRUM button active states
            this._updateDrumButtonState(
                this.drumPatternEditor && this.drumPatternEditor.isVisible
            );

    // Update WIND button active states
            this._updateWindButtonState(
                this.windInstrumentEditor && this.windInstrumentEditor.isVisible
            );

    // Async: adjust TAB buttons based on DB cc_enabled setting
            this._refreshStringInstrumentChannels();
        }
    }

    /**
    * Appliquer l'instrument sélectionné au canal ciblé ou aux notes sélectionnées
    */
    MidiEditorEditActionsMixin.applyInstrument = async function() {
        if (this.activeChannels.size === 0) {
            this.showNotification(this.t('midiEditor.noActiveChannel'), 'info');
            return;
        }

    // Si plusieurs canaux sont actifs, demander de n'en garder qu'un seul
        if (this.activeChannels.size > 1) {
            this.showNotification(
                this.t('midiEditor.multipleChannelsWarning', { count: this.activeChannels.size }),
                'warning'
            );
            return;
        }

        const instrumentSelector = document.getElementById('instrument-selector');
        if (!instrumentSelector) return;

        const selectedProgram = parseInt(instrumentSelector.value);
        const instrumentName = this.getInstrumentName(selectedProgram);

    // Un seul canal actif : c'est celui-ci qu'on modifie
        const targetChannel = Array.from(this.activeChannels)[0];
        const channelInfo = this.channels.find(ch => ch.channel === targetChannel);

        if (!channelInfo) {
            this.log('error', `Channel ${targetChannel} not found in this.channels`);
            return;
        }

    // Check whether the program is changing
        if (channelInfo.program === selectedProgram) {
            this.showNotification(this.t('midiEditor.sameInstrument'), 'info');
            return;
        }

    // Check whether any notes are selected
        const selectionCount = this.getSelectionCount();
        const hasSelection = selectionCount > 0;

    // Afficher le modal de confirmation
        const result = await this.dialogs.showChangeInstrumentModal({
            noteCount: selectionCount,
            channelNoteCount: channelInfo.noteCount,
            channel: targetChannel,
            currentInstrument: channelInfo.instrument,
            newInstrument: instrumentName,
            hasSelection
        });

        if (result === false) {
            this.log('info', 'Instrument change cancelled by user');
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

    /**
    * Appliquer l'instrument uniquement aux notes sélectionnées
    * Crée un nouveau canal si nécessaire
    */
    MidiEditorEditActionsMixin.applyInstrumentToSelection = async function(program, instrumentName) {
        const selectedNotes = this.getSelectedNotes();
        if (selectedNotes.length === 0) return;

    // Trouver un canal libre pour les notes avec le nouvel instrument
        let newChannel = this.findAvailableChannel(program);

        if (newChannel === -1) {
            this.showNotification(this.t('midiEditor.noChannelAvailable'), 'error');
            return;
        }

    // Append the new channel to the list if it does not exist
        let channelInfo = this.channels.find(ch => ch.channel === newChannel);
        if (!channelInfo) {
            channelInfo = {
                channel: newChannel,
                program: program,
                instrument: newChannel === 9 ? 'Drums' : instrumentName,
                noteCount: 0
            };
            this.channels.push(channelInfo);
        } else {
    // Update the channel's program
            channelInfo.program = program;
            channelInfo.instrument = newChannel === 9 ? 'Drums' : instrumentName;
        }

    // Move the selected notes to the new channel
        if (this.pianoRoll && typeof this.pianoRoll.changeChannelSelection === 'function') {
            this.pianoRoll.changeChannelSelection(newChannel);
        }

        this.log('info', `Applied instrument ${instrumentName} to ${selectedNotes.length} selected notes (moved to channel ${newChannel + 1})`);
        this.showNotification(
            this.t('midiEditor.instrumentAppliedToSelection', { count: selectedNotes.length, instrument: instrumentName }),
            'success'
        );

        this.isDirty = true;
        this.updateSaveButton();
        this.syncFullSequenceFromPianoRoll();
        this.ccPicker.updateChannelsFromSequence();

    // Nettoyer activeChannels : retirer les canaux qui n'existent plus
        const existingChannelNumbers = new Set(this.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.activeChannels.delete(ch);
            this.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Activer le nouveau canal
        if (!this.activeChannels.has(newChannel)) {
            this.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.updateSequenceFromActiveChannels(null, true);

        this.refreshChannelButtons();
        this._refreshStringInstrumentChannels();
        this.updateInstrumentSelector();
        this.updateEditButtons();
    }

    /**
    * Appliquer l'instrument à tout un canal
    */
    MidiEditorEditActionsMixin.applyInstrumentToChannel = function(channel, program, instrumentName, channelInfo) {
        channelInfo.program = program;
        channelInfo.instrument = channel === 9 ? 'Drums' : instrumentName;
        channelInfo.hasExplicitProgram = true;

        this.log('info', `Applied instrument ${instrumentName} to channel ${channel + 1}`);
        this.showNotification(this.t('midiEditor.instrumentApplied', { channel: channel + 1, instrument: instrumentName }), 'success');

        // Reset feedback instruments so they get reloaded with the new program
        if (this._playback) this._playback._feedbackInstrumentsLoaded = false;

        this.refreshChannelButtons();
        this.isDirty = true;
        this.updateSaveButton();

    // Clean up stale string instrument config if program changed to non-string
        const gmMatch = typeof MidiEditorChannelPanel !== 'undefined'
            ? MidiEditorChannelPanel.getStringInstrumentCategory(program)
            : null;
        if (!gmMatch) {
    // Delete stale DB record for this channel so TAB doesn't reappear
            this.api.sendCommand('string_instrument_delete', {
                device_id: this.getEffectiveDeviceId(),
                channel: channel
            }).catch(() => { /* ignore if no record existed */ });
        }

    // Update tablature buttons (string instrument detection may change)
        this._refreshStringInstrumentChannels();
        if (this.channelPanel) {
            this.channelPanel.updateTablatureButton();
        }
    }

    /**
    * Trouver un canal disponible pour un instrument
    * Priorité : canal existant avec le même instrument, sinon nouveau canal libre
    */
    MidiEditorEditActionsMixin.findAvailableChannel = function(program) {
    // Look first for an existing channel with the same program
        const existingChannel = this.channels.find(ch => ch.program === program && ch.channel !== 9);
        if (existingChannel) {
            return existingChannel.channel;
        }

    // Sinon, trouver un canal libre (0-15, sauf 9 pour drums)
        const usedChannels = new Set(this.channels.map(ch => ch.channel));

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue; // Skip drum channel
            if (!usedChannels.has(i)) {
                return i;
            }
        }

    // If every channel is taken, use the first available one that is not the current channel
        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            const channelInfo = this.channels.find(ch => ch.channel === i);
            if (channelInfo && channelInfo.noteCount === 0) {
                return i;
            }
        }

        return -1; // Aucun canal disponible
    }

    /**
    * Cycler entre les différentes valeurs de grille/snap
    */
    MidiEditorEditActionsMixin.cycleSnap = function() {
    // Move to the next value (cycle)
        this.currentSnapIndex = (this.currentSnapIndex + 1) % this.snapValues.length;

        const currentSnap = this.snapValues[this.currentSnapIndex];

    // Update the button's display
        const snapValueElement = document.getElementById('snap-value');
        if (snapValueElement) {
            snapValueElement.textContent = currentSnap.label;
        }

    // Apply snap on the piano roll (visual grid stays fixed at 120)
    // Use the JavaScript property to ensure the change is applied
        if (this.pianoRoll) {
            this.pianoRoll.snap = currentSnap.ticks;
            this.log('info', `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${this.pianoRoll.snap}`);
        }

    // Sync every editor
        this.ccPicker.syncAllEditors();

        this.showNotification(this.t('midiEditor.snapChanged', { snap: currentSnap.label }), 'info');
    }

    /**
    * Changer le tempo BPM
    */
    MidiEditorEditActionsMixin.setTempo = function(newTempo) {
        if (!newTempo || isNaN(newTempo) || newTempo < 20 || newTempo > 300) {
            this.log('warn', `Invalid tempo value: ${newTempo}`);
            return;
        }

        this.tempo = newTempo;
        this.isDirty = true;
        this.updateSaveButton();

    // Update the piano roll
        if (this.pianoRoll) {
            this.pianoRoll.tempo = newTempo;
        }

    // Update the synthesizer if it exists
        if (this.synthesizer) {
            this.synthesizer.tempo = newTempo;
        }

        this.log('info', `Tempo changed to ${newTempo} BPM`);
        this.showNotification(this.t('midiEditor.tempoChanged', { tempo: newTempo }), 'info');
    }

    /**
    * Changer le mode d'édition
    */
    MidiEditorEditActionsMixin.setEditMode = function(mode) {
        this.editMode = mode;

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
            if (this.pianoRoll && typeof this.pianoRoll.setUIMode === 'function') {
                this.pianoRoll.setUIMode(mode);
            }
        }

    // Propager aux editeurs CC/Velocity/Tempo si la section est ouverte
        if (this.ccSectionExpanded) {
            const ccToolMap = { 'select': 'select', 'drag-notes': 'move', 'edit': 'move', 'drag-view': 'select' };
            const ccTool = ccToolMap[mode];
            if (ccTool) {
                if (this.currentCCType === 'tempo' && this.tempoEditor) {
                    this.tempoEditor.setTool(ccTool);
                } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
                    this.velocityEditor.setTool(ccTool);
                } else if (this.ccEditor) {
                    this.ccEditor.setTool(ccTool);
                }
            // Update CC tool button active states
                const ccToolBtns = this.container?.querySelectorAll('.cc-tool-btn');
                if (ccToolBtns) {
                    ccToolBtns.forEach(b => b.classList.remove('active'));
                }
            }
        }

    // Update the UI
        this.updateModeButtons();

        this.log('info', `Edit mode changed to: ${mode}`);
    }

    /**
    * Mettre à jour les boutons de mode
    */
    MidiEditorEditActionsMixin.updateModeButtons = function() {
        const modeButtons = this.container?.querySelectorAll('.editor-toolbar [data-mode]');
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
            } else if (btnMode === this.editMode) {
                btn.classList.add('active');
                btn.classList.remove('mode-unsupported');
                btn.disabled = true;
            } else {
                btn.classList.remove('active', 'mode-unsupported');
                btn.disabled = false;
            }
        });
    }

    /**
    * Retourne les modes supportes par l'editeur actif
    */
    MidiEditorEditActionsMixin._getSupportedModes = function() {
        const editor = this._getActiveSpecializedEditor();
        if (!editor) {
    // Piano roll: all modes
            return ['drag-view', 'select', 'edit', 'drag-notes', 'add-note', 'resize-note'];
        }
        if (editor === this.drumPatternEditor) {
            return ['drag-view', 'select'];
        }
        if (editor === this.windInstrumentEditor) {
            return ['drag-view', 'select'];
        }
        if (editor === this.tablatureEditor) {
            return ['drag-view', 'select'];
        }
        return ['drag-view', 'select'];
    }

    /**
    * Basculer le mode tactile (boutons séparés vs bouton crayon unifié)
    */
    MidiEditorEditActionsMixin.toggleTouchMode = function() {
        this.touchMode = !this.touchMode;
        this._saveTouchModePref(this.touchMode);

        // Update the toggle button
        const toggleBtn = this.container?.querySelector('#touch-mode-toggle');
        if (toggleBtn) {
            toggleBtn.dataset.active = String(this.touchMode);
            const srLabel = toggleBtn.querySelector('.sr-only');
            const label = this.touchMode ? this.t('common.on') : this.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                toggleBtn.textContent = label;
            }
        }

        // Show/hide pencil button vs touch edit buttons
        const pencilBtn = this.container?.querySelector('.edit-unified-btn');
        const touchBtns = this.container?.querySelectorAll('.touch-edit-btn');

        if (pencilBtn) {
            pencilBtn.classList.toggle('hidden', this.touchMode);
        }
        if (touchBtns) {
            touchBtns.forEach(b => b.classList.toggle('hidden', !this.touchMode));
        }

        // Adjust the current edit mode when needed
        if (!this.touchMode && (this.editMode === 'drag-notes' || this.editMode === 'add-note' || this.editMode === 'resize-note')) {
            // Leaving touch mode: switch back to the unified edit mode
            this.setEditMode('edit');
        } else if (this.touchMode && this.editMode === 'edit') {
            // Entering touch mode: switch to drag-notes
            this.setEditMode('drag-notes');
        }

        this.updateModeButtons();
        this.log('info', `Touch mode: ${this.touchMode ? 'ON' : 'OFF'}`);
    }

    /**
    * Selectionner tous les elements de l'editeur actif
    */
    MidiEditorEditActionsMixin.selectAll = function() {
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer) {
            if (typeof specializedRenderer.selectAll === 'function') {
                specializedRenderer.selectAll();
                this.updateEditButtons();
            }
            return;
        }

    // Piano roll: select all notes
        if (this.pianoRoll && typeof this.pianoRoll.selectAll === 'function') {
            this.pianoRoll.selectAll();
            this.updateEditButtons();
        }
    }

    /**
    * Mettre à jour les boutons d'édition (copy, paste, delete, change channel)
    */
    MidiEditorEditActionsMixin.updateEditButtons = function() {
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

        this.log('debug', `Selection: ${selectionCount} notes`);
    }

    /**
    * Configurer les raccourcis clavier
    */
    MidiEditorEditActionsMixin.setupKeyboardShortcuts = function() {
        this.keyboardHandler = (e) => {
    // Skip when focus is inside an input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

    // Ctrl/Cmd + Z = Undo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            }

    // Ctrl/Cmd + Y = Redo (ou Ctrl/Cmd + Shift + Z)
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

    // Delete ou Backspace = Delete
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
    // When the CC/velocity section is open, delete the selected CC/velocity points
                if (this.ccSectionExpanded) {
                    this.ccPicker.deleteSelectedCCVelocity();
                } else {
    // Otherwise delete the selected notes
                    this.deleteSelectedNotes();
                }
            }

    // Space = Play/Pause
            else if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                this.togglePlayback();
            }
        };

        document.addEventListener('keydown', this.keyboardHandler);
    }


    /**
    * Retourne true si un editeur specialise (tablature, drum, wind) est actuellement actif
    */
    MidiEditorEditActionsMixin._isSpecializedEditorActive = function() {
        return !!(
            (this.tablatureEditor && this.tablatureEditor.isVisible) ||
            (this.drumPatternEditor && this.drumPatternEditor.isVisible) ||
            (this.windInstrumentEditor && this.windInstrumentEditor.isVisible)
        );
    }

    /**
    * Retourne l'etat du viewport de l'editeur actuellement actif.
    * Cela permet a syncAllEditors, syncCCEditor, etc. de lire les bonnes
    * valeurs de scroll/zoom meme quand un editeur specialise est actif
    * (et que le piano roll est cache/stale).
    * @returns {{ xoffset: number, xrange: number, ticksPerPixel: number }}
    */
    MidiEditorEditActionsMixin._getActiveViewportState = function() {
        const containerWidth = this.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;

        // Tablature editor
        if (this.tablatureEditor && this.tablatureEditor.isVisible && this.tablatureEditor.renderer) {
            const r = this.tablatureEditor.renderer;
            const headerWidth = r.headerWidth || 40;
            const tpp = r.ticksPerPixel || 2;
            const xoffset = r.scrollX || 0;
            const xrange = (containerWidth - headerWidth) * tpp;
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        // Drum pattern editor
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible && this.drumPatternEditor.gridRenderer) {
            const r = this.drumPatternEditor.gridRenderer;
            const headerWidth = r.headerWidth || 80;
            const tpp = r.ticksPerPixel || 2;
            const xoffset = r.scrollX || 0;
            const xrange = (containerWidth - headerWidth) * tpp;
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        // Wind instrument editor
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible && this.windInstrumentEditor.renderer) {
            const r = this.windInstrumentEditor.renderer;
            const headerWidth = r.headerWidth || 50;
            const tpp = r.ticksPerPixel || 2;
            const xoffset = r.scrollX || 0;
            const xrange = (containerWidth - headerWidth) * tpp;
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        // Default: piano roll
        if (this.pianoRoll) {
            const xoffset = this.pianoRoll.xoffset || 0;
            const xrange = this.pianoRoll.xrange || 1920;
            const headerWidth = 64; // yruler 24 + kbwidth 40
            const tpp = xrange / Math.max(1, containerWidth - headerWidth);
            return { xoffset, xrange, ticksPerPixel: tpp };
        }

        return { xoffset: 0, xrange: 1920, ticksPerPixel: 2 };
    }

    /**
    * Basculer le son au clic sur le clavier piano
    */
    MidiEditorEditActionsMixin.toggleKeyboardPlayback = function() {
        this.keyboardPlaybackEnabled = !this.keyboardPlaybackEnabled;
        this._saveKeyboardPlaybackPref(this.keyboardPlaybackEnabled);
        const btn = document.getElementById('keyboard-playback-toggle');
        if (btn) {
            btn.dataset.active = String(this.keyboardPlaybackEnabled);
            const srLabel = btn.querySelector('.sr-only');
            const label = this.keyboardPlaybackEnabled ? this.t('common.on') : this.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                btn.textContent = label;
            }
        }
        this.log('info', `Keyboard playback: ${this.keyboardPlaybackEnabled ? 'ON' : 'OFF'}`);
    }

    /**
    * Basculer le son au deplacement de notes
    */
    MidiEditorEditActionsMixin.toggleDragPlayback = function() {
        this.dragPlaybackEnabled = !this.dragPlaybackEnabled;
        this._saveDragPlaybackPref(this.dragPlaybackEnabled);
        const btn = document.getElementById('drag-playback-toggle');
        if (btn) {
            btn.dataset.active = String(this.dragPlaybackEnabled);
            const srLabel = btn.querySelector('.sr-only');
            const label = this.dragPlaybackEnabled ? this.t('common.on') : this.t('common.off');
            if (srLabel) {
                srLabel.textContent = label;
            } else {
                btn.textContent = label;
            }
        }
        this.log('info', `Drag playback: ${this.dragPlaybackEnabled ? 'ON' : 'OFF'}`);
    }

    // Facade sub-component (P2-F.10c-batch).
    class MidiEditorEditActions {
        constructor(modal) { this.modal = modal; }
    }
    Object.keys(MidiEditorEditActionsMixin).forEach((key) => {
        MidiEditorEditActions.prototype[key] = function(...args) {
            return MidiEditorEditActionsMixin[key].apply(this.modal, args);
        };
    });

    if (typeof window !== 'undefined') {
        window.MidiEditorEditActionsMixin = MidiEditorEditActionsMixin;
        window.MidiEditorEditActions = MidiEditorEditActions;
    }
})();
