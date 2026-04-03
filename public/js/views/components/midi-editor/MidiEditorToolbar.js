// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorToolbar.js
// Description: Toolbar section for the MIDI Editor
//   - Playback controls (play, pause, stop)
//   - Undo/Redo buttons
//   - Grid/Snap cycling
//   - Zoom controls
//   - Edit mode buttons (select, drag-notes, add-note, resize-note)
//   - Edit action buttons (copy, paste, delete)
// ============================================================================

class MidiEditorToolbar {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // EDIT MODE
    // ========================================================================

    /**
     * Changer le mode d'edition
     */
    setEditMode(mode) {
        const m = this.modal;
        m.editMode = mode;

        if (m.pianoRoll && typeof m.pianoRoll.setUIMode === 'function') {
            m.pianoRoll.setUIMode(mode);
        }

        this.updateModeButtons();

        m.log('info', `Edit mode changed to: ${mode}`);
    }

    /**
     * Mettre a jour les boutons de mode
     */
    updateModeButtons() {
        const m = this.modal;
        const modeButtons = m.container?.querySelectorAll('[data-mode]');
        if (!modeButtons) return;

        modeButtons.forEach(btn => {
            const btnMode = btn.dataset.mode;
            if (btnMode === m.editMode) {
                btn.classList.add('active');
                btn.disabled = true;
            } else {
                btn.classList.remove('active');
                btn.disabled = false;
            }
        });
    }

    // ========================================================================
    // GRID / SNAP
    // ========================================================================

    /**
     * Cycler entre les differentes valeurs de grille/snap
     */
    cycleSnap() {
        const m = this.modal;
        m.currentSnapIndex = (m.currentSnapIndex + 1) % m.snapValues.length;

        const currentSnap = m.snapValues[m.currentSnapIndex];

        const snapValueElement = document.getElementById('snap-value');
        if (snapValueElement) {
            snapValueElement.textContent = currentSnap.label;
        }

        if (m.pianoRoll) {
            m.pianoRoll.snap = currentSnap.ticks;
            m.log('info', `Snap to grid changed to ${currentSnap.label} (${currentSnap.ticks} ticks) - snap property set to ${m.pianoRoll.snap}`);
        }

        m.syncAllEditors();

        m.showNotification(m.t('midiEditor.snapChanged', { snap: currentSnap.label }), 'info');
    }

    // ========================================================================
    // ZOOM
    // ========================================================================

    /**
     * Zoom horizontal
     */
    zoomHorizontal(factor) {
        const m = this.modal;
        if (!m.pianoRoll) {
            m.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

        const currentRange = m.pianoRoll.xrange || parseInt(m.pianoRoll.getAttribute('xrange')) || 128;
        const newRange = Math.max(16, Math.min(100000, Math.round(currentRange * factor)));

        m.pianoRoll.setAttribute('xrange', newRange.toString());
        if (m.pianoRoll.xrange !== undefined) {
            m.pianoRoll.xrange = newRange;
        }

        this.updateGridResolution(newRange);

        setTimeout(() => {
            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
            }
        }, 50);

        m.syncAllEditors();

        m.log('info', `Horizontal zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Zoom vertical
     */
    zoomVertical(factor) {
        const m = this.modal;
        if (!m.pianoRoll) {
            m.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

        const currentRange = m.pianoRoll.yrange || parseInt(m.pianoRoll.getAttribute('yrange')) || 36;
        const newRange = Math.max(12, Math.min(88, Math.round(currentRange * factor)));

        m.pianoRoll.setAttribute('yrange', newRange.toString());
        if (m.pianoRoll.yrange !== undefined) {
            m.pianoRoll.yrange = newRange;
        }

        setTimeout(() => {
            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
            }
        }, 50);

        m.log('info', `Vertical zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Ajuster la grille en fonction du niveau de zoom horizontal
     */
    updateGridResolution(xrange) {
        const m = this.modal;
        if (!m.pianoRoll) return;

        let gridValue;

        if (xrange > 2000) {
            gridValue = 100000;
        } else if (xrange < 500) {
            gridValue = 1;
        } else if (xrange < 1000) {
            gridValue = 2;
        } else if (xrange < 1500) {
            gridValue = 4;
        } else {
            gridValue = 8;
        }

        m.pianoRoll.setAttribute('grid', gridValue.toString());
        if (m.pianoRoll.grid !== undefined) {
            m.pianoRoll.grid = gridValue;
        }

        m.log('info', `Grid resolution updated: ${gridValue} (xrange=${xrange})`);
    }

    // ========================================================================
    // TEMPO
    // ========================================================================

    /**
     * Changer le tempo BPM
     */
    setTempo(newTempo) {
        const m = this.modal;
        if (!newTempo || isNaN(newTempo) || newTempo < 20 || newTempo > 300) {
            m.log('warn', `Invalid tempo value: ${newTempo}`);
            return;
        }

        m.tempo = newTempo;
        m.isDirty = true;
        m.updateSaveButton();

        if (m.pianoRoll) {
            m.pianoRoll.tempo = newTempo;
        }

        if (m.synthesizer) {
            m.synthesizer.tempo = newTempo;
        }

        m.log('info', `Tempo changed to ${newTempo} BPM`);
        m.showNotification(`Tempo: ${newTempo} BPM`, 'info');
    }

    // ========================================================================
    // CHANNEL CHANGE (toolbar action)
    // ========================================================================

    /**
     * Changer le canal des notes selectionnees
     */
    async changeChannel() {
        const m = this.modal;
        if (!m.pianoRoll || typeof m.pianoRoll.changeChannelSelection !== 'function') {
            m.showNotification(m.t('midiEditor.changeChannelNotAvailable'), 'error');
            return;
        }

        const count = m.getSelectionCount();
        if (count === 0) {
            m.showNotification(m.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        const channelSelector = document.getElementById('channel-selector');
        if (!channelSelector) return;

        const newChannel = parseInt(channelSelector.value);
        const instrumentSelector = document.getElementById('instrument-selector');

        const selectedNotes = m.getSelectedNotes();
        const currentChannels = new Set(selectedNotes.map(n => n.c));
        const currentChannel = currentChannels.size === 1 ? Array.from(currentChannels)[0] : -1;

        if (currentChannel === newChannel) {
            m.showNotification(m.t('midiEditor.sameChannel'), 'info');
            return;
        }

        const confirmed = await m.showChangeChannelModal(count, currentChannel, newChannel);
        if (!confirmed) {
            m.log('info', 'Channel change cancelled by user');
            return;
        }

        const targetChannelInfo = m.channels.find(ch => ch.channel === newChannel);

        if (!targetChannelInfo && instrumentSelector) {
            m.selectedInstrument = parseInt(instrumentSelector.value);
            m.log('info', `New channel ${newChannel} will use instrument: ${m.getInstrumentName(m.selectedInstrument)}`);
        }

        m.pianoRoll.changeChannelSelection(newChannel);

        m.log('info', `Changed channel of ${count} notes to ${newChannel}`);
        m.showNotification(m.t('midiEditor.channelChanged', { count }), 'success');

        m.isDirty = true;
        m.updateSaveButton();
        m.syncFullSequenceFromPianoRoll();

        m.updateChannelsFromSequence();

        const existingChannelNumbers = new Set(m.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        m.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            m.activeChannels.delete(ch);
            m.log('info', `Removed empty channel ${ch} from active channels`);
        });

        if (!m.activeChannels.has(newChannel)) {
            m.activeChannels.add(newChannel);
        }

        m.updateSequenceFromActiveChannels(null, true);
        m.refreshChannelButtons();
        m.updateInstrumentSelector();
        m.updateEditButtons();
    }

    // ========================================================================
    // INSTRUMENT APPLICATION
    // ========================================================================

    /**
     * Appliquer l'instrument selectionne au canal cible ou aux notes selectionnees
     */
    async applyInstrument() {
        const m = this.modal;
        if (m.activeChannels.size === 0) {
            m.showNotification(m.t('midiEditor.noActiveChannel'), 'info');
            return;
        }

        if (m.activeChannels.size > 1) {
            m.showNotification(
                m.t('midiEditor.multipleChannelsWarning', { count: m.activeChannels.size }),
                'warning'
            );
            return;
        }

        const instrumentSelector = document.getElementById('instrument-selector');
        if (!instrumentSelector) return;

        const selectedProgram = parseInt(instrumentSelector.value);
        const instrumentName = m.getInstrumentName(selectedProgram);

        const targetChannel = Array.from(m.activeChannels)[0];
        const channelInfo = m.channels.find(ch => ch.channel === targetChannel);

        if (!channelInfo) {
            m.log('error', `Channel ${targetChannel} not found in this.channels`);
            return;
        }

        if (channelInfo.program === selectedProgram) {
            m.showNotification(m.t('midiEditor.sameInstrument'), 'info');
            return;
        }

        const selectionCount = m.getSelectionCount();
        const hasSelection = selectionCount > 0;

        const result = await m.showChangeInstrumentModal({
            noteCount: selectionCount,
            channelNoteCount: channelInfo.noteCount,
            channel: targetChannel,
            currentInstrument: channelInfo.instrument,
            newInstrument: instrumentName,
            hasSelection
        });

        if (result === false) {
            m.log('info', 'Instrument change cancelled by user');
            return;
        }

        if (result === true && hasSelection) {
            await this.applyInstrumentToSelection(selectedProgram, instrumentName);
        } else {
            this.applyInstrumentToChannel(targetChannel, selectedProgram, instrumentName, channelInfo);
        }
    }

    /**
     * Appliquer l'instrument uniquement aux notes selectionnees
     */
    async applyInstrumentToSelection(program, instrumentName) {
        const m = this.modal;
        const selectedNotes = m.getSelectedNotes();
        if (selectedNotes.length === 0) return;

        let newChannel = this.findAvailableChannel(program);

        if (newChannel === -1) {
            m.showNotification(m.t('midiEditor.noChannelAvailable'), 'error');
            return;
        }

        let channelInfo = m.channels.find(ch => ch.channel === newChannel);
        if (!channelInfo) {
            channelInfo = {
                channel: newChannel,
                program: program,
                instrument: newChannel === 9 ? 'Drums' : instrumentName,
                noteCount: 0
            };
            m.channels.push(channelInfo);
        } else {
            channelInfo.program = program;
            channelInfo.instrument = newChannel === 9 ? 'Drums' : instrumentName;
        }

        if (m.pianoRoll && typeof m.pianoRoll.changeChannelSelection === 'function') {
            m.pianoRoll.changeChannelSelection(newChannel);
        }

        m.log('info', `Applied instrument ${instrumentName} to ${selectedNotes.length} selected notes (moved to channel ${newChannel + 1})`);
        m.showNotification(
            m.t('midiEditor.instrumentAppliedToSelection', { count: selectedNotes.length, instrument: instrumentName }),
            'success'
        );

        m.isDirty = true;
        m.updateSaveButton();
        m.syncFullSequenceFromPianoRoll();
        m.updateChannelsFromSequence();

        const existingChannelNumbers = new Set(m.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        m.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            m.activeChannels.delete(ch);
            m.log('info', `Removed empty channel ${ch} from active channels`);
        });

        if (!m.activeChannels.has(newChannel)) {
            m.activeChannels.add(newChannel);
        }

        m.updateSequenceFromActiveChannels(null, true);
        m.refreshChannelButtons();
        m.updateInstrumentSelector();
        m.updateEditButtons();
    }

    /**
     * Appliquer l'instrument a tout un canal
     */
    applyInstrumentToChannel(channel, program, instrumentName, channelInfo) {
        const m = this.modal;
        channelInfo.program = program;
        channelInfo.instrument = channel === 9 ? 'Drums' : instrumentName;

        m.log('info', `Applied instrument ${instrumentName} to channel ${channel + 1}`);
        m.showNotification(m.t('midiEditor.instrumentApplied', { channel: channel + 1, instrument: instrumentName }), 'success');

        m.refreshChannelButtons();
        m.isDirty = true;
        m.updateSaveButton();
    }

    /**
     * Trouver un canal disponible pour un instrument
     */
    findAvailableChannel(program) {
        const m = this.modal;
        const existingChannel = m.channels.find(ch => ch.program === program && ch.channel !== 9);
        if (existingChannel) {
            return existingChannel.channel;
        }

        const usedChannels = new Set(m.channels.map(ch => ch.channel));

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            if (!usedChannels.has(i)) {
                return i;
            }
        }

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            const channelInfo = m.channels.find(ch => ch.channel === i);
            if (channelInfo && channelInfo.noteCount === 0) {
                return i;
            }
        }

        return -1;
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorToolbar;
}

if (typeof window !== 'undefined') {
    window.MidiEditorToolbar = MidiEditorToolbar;
}
