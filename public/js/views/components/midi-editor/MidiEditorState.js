// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorState.js
// Description: State management for the MIDI Editor
//   - Command history (undo/redo)
//   - Clipboard (copy/paste)
//   - Selection management
//   - Dirty flag tracking
//   - Sequence data (fullSequence, sequence, ccEvents, tempoEvents)
//   - activeChannels set
//   - Channel info management
// ============================================================================

class MidiEditorState {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // UNDO / REDO
    // ========================================================================

    /**
     * Annuler la derniere action
     */
    undo() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.undo !== 'function') {
            m.log('warn', 'Undo not available');
            return;
        }

        if (m.pianoRoll.undo()) {
            m.log('info', 'Undo successful');
            m.isDirty = true;
            m.updateSaveButton();
            m.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
     * Refaire la derniere action annulee
     */
    redo() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.redo !== 'function') {
            m.log('warn', 'Redo not available');
            return;
        }

        if (m.pianoRoll.redo()) {
            m.log('info', 'Redo successful');
            m.isDirty = true;
            m.updateSaveButton();
            m.syncFullSequenceFromPianoRoll();
            this.updateUndoRedoButtonsState();
        }
    }

    /**
     * Mettre a jour l'etat des boutons undo/redo
     */
    updateUndoRedoButtonsState() {
        const m = this.modal;
        if (!m.pianoRoll) return;

        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');

        if (undoBtn) {
            undoBtn.disabled = !m.pianoRoll.canUndo();
        }
        if (redoBtn) {
            redoBtn.disabled = !m.pianoRoll.canRedo();
        }
    }

    // ========================================================================
    // SELECTION
    // ========================================================================

    /**
     * Obtenir les notes selectionnees du piano roll
     */
    getSelectedNotes() {
        const m = this.modal;
        if (!m.pianoRoll) {
            return [];
        }

        if (typeof m.pianoRoll.getSelectedNotes === 'function') {
            return m.pianoRoll.getSelectedNotes();
        }

        const sequence = m.pianoRoll.sequence || [];
        return sequence.filter(note => note.f === 1);
    }

    /**
     * Obtenir le nombre de notes selectionnees
     */
    getSelectionCount() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.getSelectionCount !== 'function') {
            return 0;
        }
        return m.pianoRoll.getSelectionCount();
    }

    /**
     * Selectionner toutes les notes affichees (canaux actifs)
     */
    selectAllNotes() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.selectAll !== 'function') {
            m.log('warn', 'selectAll not available on piano roll');
            return;
        }

        m.pianoRoll.selectAll();
        m.updateEditButtons();

        const count = this.getSelectionCount();
        m.log('info', `Selected all notes: ${count}`);
    }

    // ========================================================================
    // CLIPBOARD (COPY / PASTE)
    // ========================================================================

    /**
     * Copier les notes selectionnees
     */
    copy() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.copySelection !== 'function') {
            m.showNotification(m.t('midiEditor.copyNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            m.showNotification(m.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        m.clipboard = m.pianoRoll.copySelection();

        m.log('info', `Copied ${m.clipboard.length} notes`);
        m.showNotification(m.t('midiEditor.notesCopied', { count: m.clipboard.length }), 'success');

        const pasteBtn = document.getElementById('paste-btn');
        if (pasteBtn) {
            pasteBtn.disabled = false;
        }

        m.updateEditButtons();
    }

    /**
     * Coller les notes du clipboard
     */
    paste() {
        const m = this.modal;
        if (!m.clipboard || m.clipboard.length === 0) {
            m.showNotification(m.t('midiEditor.clipboardEmpty'), 'info');
            return;
        }

        if (!m.pianoRoll || typeof m.pianoRoll.pasteNotes !== 'function') {
            m.showNotification(m.t('midiEditor.pasteNotAvailable'), 'error');
            return;
        }

        const currentTime = m.pianoRoll.xoffset || 0;
        m.pianoRoll.pasteNotes(m.clipboard, currentTime);

        m.log('info', `Pasted ${m.clipboard.length} notes`);
        m.showNotification(m.t('midiEditor.notesPasted', { count: m.clipboard.length }), 'success');

        m.isDirty = true;
        m.updateSaveButton();
        m.syncFullSequenceFromPianoRoll();
        m.updateEditButtons();
    }

    // ========================================================================
    // DELETE
    // ========================================================================

    /**
     * Supprimer les notes selectionnees
     */
    deleteSelectedNotes() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.deleteSelection !== 'function') {
            m.showNotification(m.t('midiEditor.deleteNotAvailable'), 'error');
            return;
        }

        const count = this.getSelectionCount();
        if (count === 0) {
            m.showNotification(m.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        const selectedNotes = this.getSelectedNotes();
        m.pianoRoll.deleteSelection();

        this.deleteAssociatedCCAndVelocity(selectedNotes);

        m.log('info', `Deleted ${count} notes`);
        m.showNotification(m.t('midiEditor.notesDeleted', { count }), 'success');

        m.isDirty = true;
        m.updateSaveButton();
        m.syncFullSequenceFromPianoRoll();
        m.updateEditButtons();
    }

    /**
     * Supprimer les evenements CC et velocite associes aux notes supprimees
     */
    deleteAssociatedCCAndVelocity(deletedNotes) {
        const m = this.modal;
        if (!deletedNotes || deletedNotes.length === 0) return;

        const deletedPositions = new Set();
        deletedNotes.forEach(note => {
            const key = `${note.t}_${note.c}`;
            deletedPositions.add(key);
        });

        if (m.ccEditor && m.ccEditor.events) {
            const initialCCCount = m.ccEditor.events.length;
            m.ccEditor.events = m.ccEditor.events.filter(event => {
                const key = `${event.ticks}_${event.channel}`;
                return !deletedPositions.has(key);
            });
            const deletedCCCount = initialCCCount - m.ccEditor.events.length;
            if (deletedCCCount > 0) {
                m.log('info', `Deleted ${deletedCCCount} CC/pitchbend events associated with deleted notes`);
                m.ccEditor.renderThrottled();
            }
        }

        if (m.velocityEditor) {
            m.velocityEditor.setSequence(m.pianoRoll.sequence);
            m.velocityEditor.renderThrottled();
        }
    }

    // ========================================================================
    // EDIT BUTTONS
    // ========================================================================

    /**
     * Mettre a jour les boutons d'edition (copy, paste, delete, change channel)
     */
    updateEditButtons() {
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

    // ========================================================================
    // SEQUENCE SYNC
    // ========================================================================

    /**
     * Synchroniser fullSequence avec les notes actuelles du piano roll
     * @param {Set} previousActiveChannels - Canaux qui etaient visibles dans le piano roll (optionnel)
     */
    syncFullSequenceFromPianoRoll(previousActiveChannels = null) {
        const m = this.modal;
        if (!m.pianoRoll || !m.pianoRoll.sequence) return;

        const currentSequence = m.pianoRoll.sequence;
        const visibleChannels = previousActiveChannels || m.activeChannels;
        const invisibleNotes = m.fullSequence.filter(note => !visibleChannels.has(note.c));
        const visibleNotes = currentSequence.map(note => ({
            t: note.t,
            g: note.g,
            n: note.n,
            c: note.c !== undefined ? note.c : Array.from(visibleChannels)[0] || 0,
            v: note.v || 100
        }));

        m.fullSequence = [...invisibleNotes, ...visibleNotes];
        m.fullSequence.sort((a, b) => a.t - b.t);

        m.log('debug', `Synced fullSequence: ${invisibleNotes.length} invisible + ${visibleNotes.length} visible = ${m.fullSequence.length} total (using ${previousActiveChannels ? 'previous' : 'current'} active channels)`);
    }

    /**
     * Mettre a jour la sequence depuis les canaux actifs
     * @param {Set} previousActiveChannels - Canaux qui etaient actifs AVANT le changement (optionnel)
     * @param {boolean} skipSync - Si true, ne pas synchroniser fullSequence (deja fait)
     */
    updateSequenceFromActiveChannels(previousActiveChannels = null, skipSync = false) {
        const m = this.modal;

        if (!skipSync) {
            this.syncFullSequenceFromPianoRoll(previousActiveChannels);
        }

        if (m.activeChannels.size === 0) {
            m.sequence = [];
        } else {
            m.sequence = m.fullSequence.filter(note => m.activeChannels.has(note.c));
        }

        m.log('info', `Updated sequence: ${m.sequence.length} notes from ${m.activeChannels.size} active channel(s)`);

        if (m.pianoRoll) {
            m.pianoRoll.sequence.length = 0;

            m.sequence.forEach(note => {
                m.pianoRoll.sequence.push({...note});
            });

            m.pianoRoll.channelColors = m.channelColors;

            if (m.activeChannels.size > 0) {
                m.pianoRoll.defaultChannel = Array.from(m.activeChannels)[0];
                m.log('debug', `Default channel for new notes: ${m.pianoRoll.defaultChannel}`);
            }

            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
                m.log('debug', `Piano roll redrawn after channel toggle: ${m.pianoRoll.sequence.length} notes visible`);
            }
        }

        // Sync CC/Velocity editor channel when editing a single channel
        if (m.activeChannels.size === 1 && m.ccSectionExpanded) {
            const ch = Array.from(m.activeChannels)[0];
            if (m.ccEditor) m.ccEditor.setChannel(ch);
            if (m.velocityEditor) m.velocityEditor.setChannel(ch);
            if (typeof m.updateEditorChannelSelector === 'function') {
                m.updateEditorChannelSelector();
            }
        }
    }

    /**
     * Copier une sequence de notes
     */
    copySequence(sequence) {
        if (!sequence || sequence.length === 0) return [];
        return sequence.map(note => ({
            t: note.t,
            g: note.g,
            n: note.n,
            c: note.c,
            v: note.v
        }));
    }

    /**
     * Mettre a jour la liste des canaux basee sur fullSequence
     */
    updateChannelsFromSequence() {
        const m = this.modal;
        const channelNoteCount = new Map();
        const channelPrograms = new Map();

        m.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

            if (!channelPrograms.has(channel)) {
                const existingChannel = m.channels.find(ch => ch.channel === channel);
                if (existingChannel) {
                    channelPrograms.set(channel, existingChannel.program);
                } else {
                    channelPrograms.set(channel, m.selectedInstrument || 0);
                }
            }
        });

        m.channels = [];
        channelNoteCount.forEach((count, channel) => {
            const program = channelPrograms.get(channel) || 0;
            const instrumentName = channel === 9 ? m.t('midiEditor.drumKit') : m.getInstrumentName(program);

            m.channels.push({
                channel: channel,
                program: program,
                instrument: instrumentName,
                noteCount: count
            });
        });

        m.channels.sort((a, b) => a.channel - b.channel);

        m.log('debug', `Updated channels: ${m.channels.length} channels found`);
    }

    // ========================================================================
    // DIRTY FLAG / SAVE BUTTON
    // ========================================================================

    /**
     * Mettre a jour le bouton de sauvegarde
     */
    updateSaveButton() {
        const m = this.modal;
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            if (m.isDirty) {
                saveBtn.classList.add('btn-warning');
                saveBtn.innerHTML = `\uD83D\uDCBE ${m.t('midiEditor.saveModified')}`;
            } else {
                saveBtn.classList.remove('btn-warning');
                saveBtn.innerHTML = `\uD83D\uDCBE ${m.t('midiEditor.save')}`;
            }
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorState;
}

if (typeof window !== 'undefined') {
    window.MidiEditorState = MidiEditorState;
}
