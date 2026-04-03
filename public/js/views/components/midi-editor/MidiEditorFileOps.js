// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorFileOps.js
// Description: File operations for the MIDI Editor
//   - save(), showSaveAsDialog(), saveAsFile()
//   - convertSequenceToMidi() (the big MIDI export method)
//   - showRenameDialog()
//   - loadMidiFile(), convertMidiToSequence()
//   - loadScript()
// ============================================================================

class MidiEditorFileOps {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // LOAD
    // ========================================================================

    /**
     * Charger le fichier MIDI depuis le backend
     */
    async loadMidiFile(fileId) {
        const m = this.modal;
        try {
            m.log('info', `Loading MIDI file: ${m.currentFilename || fileId}`);

            const response = await m.api.readMidiFile(fileId);

            if (!response || !response.midiData) {
                throw new Error('No MIDI data received from server');
            }

            const fileData = response.midiData;
            m.midiData = fileData.midi || fileData;

            if (!m.midiData.header || !m.midiData.tracks) {
                throw new Error('Invalid MIDI data structure');
            }

            this.convertMidiToSequence();

            m.log('info', `MIDI file loaded: ${m.midiData.tracks?.length || 0} tracks, ${m.sequence.length} notes`);

        } catch (error) {
            m.log('error', 'Failed to load MIDI file:', error);

            if (error.message.includes('Unknown command') || error.message.includes('file_read')) {
                throw new Error(m.t('midiEditor.backendNotSupported'));
            }

            throw error;
        }
    }

    /**
     * Convertir les donnees MIDI en format sequence pour webaudio-pianoroll
     */
    convertMidiToSequence() {
        const m = this.modal;
        m.fullSequence = [];
        m.channels = [];

        if (!m.midiData || !m.midiData.tracks) {
            m.log('warn', 'No MIDI tracks to convert');
            return;
        }

        const ticksPerBeat = m.midiData.header?.ticksPerBeat || 480;
        m.ticksPerBeat = ticksPerBeat;

        let tempo = 120;
        m.tempoEvents = [];
        if (m.midiData.tracks && m.midiData.tracks.length > 0) {
            for (const track of m.midiData.tracks) {
                if (!track.events) continue;
                let currentTick = 0;
                for (const event of track.events) {
                    currentTick += event.deltaTime || 0;
                    if (event.type === 'setTempo' && event.microsecondsPerBeat) {
                        const bpm = Math.round(60000000 / event.microsecondsPerBeat);
                        if (m.tempoEvents.length === 0) {
                            tempo = bpm;
                        }
                        m.tempoEvents.push({
                            ticks: currentTick,
                            tempo: bpm,
                            id: Date.now() + Math.random() + m.tempoEvents.length
                        });
                    }
                }
            }
            if (m.tempoEvents.length > 0) {
                m.log('info', `Extracted ${m.tempoEvents.length} tempo events (first: ${tempo} BPM)`);
            }
        }
        m.tempo = tempo;

        m.log('info', `Converting MIDI: ${m.midiData.tracks.length} tracks, ${ticksPerBeat} ticks/beat, ${tempo} BPM`);

        const channelInstruments = new Map();
        const channelNoteCount = new Map();
        const allNotes = [];

        m.midiData.tracks.forEach((track, trackIndex) => {
            if (!track.events) {
                m.log('debug', `Track ${trackIndex}: no events`);
                return;
            }

            m.log('debug', `Track ${trackIndex} (${track.name || 'unnamed'}): ${track.events.length} events`);

            const activeNotes = new Map();
            let currentTick = 0;
            let noteOnCount = 0;
            let noteOffCount = 0;

            track.events.forEach((event, _eventIndex) => {
                currentTick += event.deltaTime || 0;

                if (event.type === 'programChange') {
                    const channel = event.channel ?? 0;
                    channelInstruments.set(channel, event.programNumber);
                    m.log('debug', `Channel ${channel}: program ${event.programNumber} (${m.getInstrumentName(event.programNumber)})`);
                }

                if (event.type === 'noteOn' && event.velocity > 0) {
                    noteOnCount++;
                    const channel = event.channel ?? 0;
                    const key = `${channel}_${event.noteNumber}`;

                    // If a note is already active on this key, close it first
                    // (handles overlapping noteOn without intermediate noteOff)
                    const existing = activeNotes.get(key);
                    if (existing) {
                        const gate = Math.max(1, currentTick - existing.tick);
                        allNotes.push({
                            tick: existing.tick,
                            note: existing.note,
                            gate: gate,
                            velocity: existing.velocity,
                            channel: existing.channel
                        });
                        channelNoteCount.set(existing.channel, (channelNoteCount.get(existing.channel) || 0) + 1);
                    }

                    activeNotes.set(key, {
                        tick: currentTick,
                        note: event.noteNumber,
                        velocity: event.velocity,
                        channel: channel
                    });

                    if (noteOnCount === 1) {
                        m.log('debug', `First noteOn in track ${trackIndex}:`, {
                            tick: currentTick,
                            note: event.noteNumber,
                            velocity: event.velocity,
                            channel: channel
                        });
                    }
                } else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
                    noteOffCount++;
                    const channel = event.channel ?? 0;
                    const key = `${channel}_${event.noteNumber}`;
                    const noteOn = activeNotes.get(key);

                    if (noteOn) {
                        const gate = currentTick - noteOn.tick;
                        allNotes.push({
                            tick: noteOn.tick,
                            note: noteOn.note,
                            gate: gate,
                            velocity: noteOn.velocity,
                            channel: channel
                        });

                        channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);
                        activeNotes.delete(key);
                    }
                }
            });

            // Flush orphaned notes (noteOn without matching noteOff at end of track)
            for (const [, noteOn] of activeNotes) {
                const defaultGate = Math.max(1, currentTick - noteOn.tick);
                allNotes.push({
                    tick: noteOn.tick,
                    note: noteOn.note,
                    gate: defaultGate > 0 ? defaultGate : 480,
                    velocity: noteOn.velocity,
                    channel: noteOn.channel
                });
                channelNoteCount.set(noteOn.channel, (channelNoteCount.get(noteOn.channel) || 0) + 1);
            }
            if (activeNotes.size > 0) {
                m.log('warn', `Track ${trackIndex}: ${activeNotes.size} orphaned notes (no noteOff) recovered`);
            }
            activeNotes.clear();

            m.log('debug', `Track ${trackIndex} summary: ${noteOnCount} note-ons, ${noteOffCount} note-offs, ${allNotes.length} complete notes`);
        });

        m.fullSequence = allNotes.map(note => ({
            t: note.tick,
            g: note.gate,
            n: note.note,
            c: note.channel,
            v: note.velocity || 100
        }));

        m.fullSequence.sort((a, b) => a.t - b.t);

        channelNoteCount.forEach((count, channel) => {
            const programNumber = channelInstruments.get(channel) || 0;
            const instrumentName = channel === 9 ? m.t('midiEditor.drumKit') : m.getInstrumentName(programNumber);

            m.channels.push({
                channel: channel,
                program: programNumber,
                instrument: instrumentName,
                noteCount: count
            });
        });

        m.channels.sort((a, b) => a.channel - b.channel);

        m.log('info', `Converted ${m.fullSequence.length} notes to sequence`);
        m.log('info', `Found ${m.channels.length} channels:`, m.channels);

        // Extraire les evenements CC et pitchbend
        if (m.ccPanel) {
            m.ccPanel.extractCCAndPitchbend();
            m.ccPanel.updateDynamicCCButtons();
        }

        m.activeChannels.clear();
        if (m.channels.length > 0) {
            m.channels.forEach(ch => m.activeChannels.add(ch.channel));
            m.sequence = m.fullSequence.filter(note => m.activeChannels.has(note.c));

            m.log('info', `All ${m.channels.length} channels activated by default`);
            m.log('info', `Initial sequence: ${m.sequence.length} notes visible`);
        } else {
            m.log('warn', 'No notes found! Check MIDI data structure.');
            m.sequence = [];
        }
    }

    // ========================================================================
    // SAVE
    // ========================================================================

    /**
     * Sauvegarder le fichier MIDI
     */
    async saveMidiFile() {
        const m = this.modal;
        if (!m.currentFile || !m.pianoRoll) {
            m.log('error', 'Cannot save: no file or piano roll');
            m.showError(m.t('midiEditor.cannotSave'));
            return;
        }

        try {
            m.log('info', `Saving MIDI file: ${m.currentFile}`);

            m.syncFullSequenceFromPianoRoll();
            m.syncCCEventsFromEditor();
            m.syncTempoEventsFromEditor();
            m.updateChannelsFromSequence();

            m.log('info', `Saving ${m.fullSequence.length} notes across ${m.channels.length} channels`);

            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Echec de conversion en format MIDI');
            }

            m.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

            const response = await m.api.writeMidiFile(m.currentFile, midiData);

            if (response && response.success) {
                m.isDirty = false;
                m.updateSaveButton();
                m.showNotification(m.t('midiEditor.saveSuccess'), 'success');

                if (m.eventBus) {
                    m.eventBus.emit('midi_editor:saved', {
                        filePath: m.currentFile
                    });
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            m.log('error', 'Failed to save MIDI file:', error);
            m.showError(`${m.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    // ========================================================================
    // SAVE AS
    // ========================================================================

    /**
     * Show Save As dialog to save the file with a new name
     */
    showSaveAsDialog() {
        const m = this.modal;
        if (!m.currentFile || !m.pianoRoll) {
            m.log('error', 'Cannot save as: no file or piano roll');
            m.showError(m.t('midiEditor.cannotSave'));
            return;
        }

        const currentName = m.currentFilename || m.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>\uD83D\uDCC4 ${m.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${m.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${m.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${m.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

        cancelBtn.addEventListener('click', () => {
            dialog.remove();
        });

        confirmBtn.addEventListener('click', async () => {
            const newBaseName = input.value.trim();
            if (!newBaseName) {
                m.showError(m.t('midiEditor.emptyFilename'));
                return;
            }

            const newFilename = newBaseName + extension;
            dialog.remove();

            await this.saveAsFile(newFilename);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            } else if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });

        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    /**
     * Save the current file with a new name (export)
     */
    async saveAsFile(newFilename) {
        const m = this.modal;
        if (!m.currentFile || !m.pianoRoll) {
            m.log('error', 'Cannot save as: no file or piano roll');
            m.showError(m.t('midiEditor.cannotSave'));
            return;
        }

        try {
            m.log('info', `Saving MIDI file as: ${newFilename}`);

            m.syncFullSequenceFromPianoRoll();
            m.syncCCEventsFromEditor();
            m.updateChannelsFromSequence();

            m.log('info', `Saving ${m.fullSequence.length} notes across ${m.channels.length} channels`);

            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Failed to convert to MIDI format');
            }

            m.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

            const response = await m.api.sendCommand('file_save_as', {
                fileId: m.currentFile,
                newFilename: newFilename,
                midiData: midiData
            });

            if (response && response.success) {
                m.showNotification(
                    m.t('midiEditor.saveAsSuccess', { filename: newFilename }),
                    'success'
                );

                if (m.eventBus) {
                    m.eventBus.emit('midi_editor:saved_as', {
                        originalFile: m.currentFile,
                        newFile: response.newFileId,
                        newFilename: newFilename
                    });
                }

                if (window.loadFiles) {
                    window.loadFiles();
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            m.log('error', 'Failed to save file as:', error);
            m.showError(`${m.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    // ========================================================================
    // CONVERT SEQUENCE TO MIDI
    // ========================================================================

    /**
     * Convertir la sequence en donnees MIDI pour le backend
     */
    convertSequenceToMidi() {
        const m = this.modal;
        const fullSequenceToSave = m.fullSequence;

        if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
            m.log('warn', 'No sequence to convert');
            return null;
        }

        const ticksPerBeat = m.midiData?.header?.ticksPerBeat || 480;

        m.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

        const events = [];

        // Tempo events
        if (m.tempoEvents && m.tempoEvents.length > 0) {
            m.tempoEvents.forEach(tempoEvent => {
                const usPerBeat = Math.round(60000000 / tempoEvent.tempo);
                events.push({
                    absoluteTime: tempoEvent.ticks,
                    type: 'setTempo',
                    microsecondsPerBeat: usPerBeat
                });
            });
            m.log('debug', `Added ${m.tempoEvents.length} tempo events from tempo map`);
        } else {
            const tempo = m.tempo || 120;
            const microsecondsPerBeat = Math.round(60000000 / tempo);
            events.push({
                absoluteTime: 0,
                type: 'setTempo',
                microsecondsPerBeat: microsecondsPerBeat
            });
            m.log('debug', `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} us/beat)`);
        }

        // Channel instruments
        const usedChannels = new Map();
        fullSequenceToSave.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            if (!usedChannels.has(channel)) {
                const channelInfo = m.channels.find(ch => ch.channel === channel);
                const program = channelInfo ? channelInfo.program : m.selectedInstrument || 0;
                usedChannels.set(channel, program);
            }
        });

        usedChannels.forEach((program, channel) => {
            if (channel !== 9) {
                events.push({
                    absoluteTime: 0,
                    type: 'programChange',
                    channel: channel,
                    programNumber: program
                });
                m.log('debug', `Added programChange for channel ${channel}: ${m.getInstrumentName(program)}`);
            }
        });

        // Note events
        fullSequenceToSave.forEach(note => {
            const tick = note.t;
            const noteNumber = note.n;
            const gate = note.g;
            const channel = note.c !== undefined ? note.c : 0;
            const velocity = note.v || 100;

            events.push({
                absoluteTime: tick,
                type: 'noteOn',
                channel: channel,
                noteNumber: noteNumber,
                velocity: velocity
            });

            events.push({
                absoluteTime: tick + gate,
                type: 'noteOff',
                channel: channel,
                noteNumber: noteNumber,
                velocity: 0
            });
        });

        // CC and pitchbend events
        if (m.ccEvents && m.ccEvents.length > 0) {
            m.log('info', `Adding ${m.ccEvents.length} CC/pitchbend events to MIDI file`);

            let ccCount = 0, pbCount = 0, atCount = 0, patCount = 0;
            m.ccEvents.forEach(ccEvent => {
                if (ccEvent.type.startsWith('cc')) {
                    const controllerNumber = parseInt(ccEvent.type.replace('cc', ''));
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'controller',
                        channel: ccEvent.channel,
                        controllerType: controllerNumber,
                        value: ccEvent.value
                    });
                    ccCount++;
                } else if (ccEvent.type === 'pitchbend') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'pitchBend',
                        channel: ccEvent.channel,
                        value: ccEvent.value
                    });
                    pbCount++;
                } else if (ccEvent.type === 'aftertouch') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'channelAftertouch',
                        channel: ccEvent.channel,
                        amount: ccEvent.value
                    });
                    atCount++;
                } else if (ccEvent.type === 'polyAftertouch') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'noteAftertouch',
                        channel: ccEvent.channel,
                        noteNumber: ccEvent.note,
                        amount: ccEvent.value
                    });
                    patCount++;
                }
            });

            m.log('info', `Converted to MIDI: ${ccCount} CC, ${pbCount} pitchbend, ${atCount} aftertouch, ${patCount} poly aftertouch events`);
        } else {
            m.log('warn', 'No CC/Pitchbend events to save');
        }

        events.sort((a, b) => a.absoluteTime - b.absoluteTime);

        // Convert absolute time to deltaTime
        let lastTime = 0;
        const trackEvents = events.map(event => {
            const deltaTime = event.absoluteTime - lastTime;
            lastTime = event.absoluteTime;

            const trackEvent = {
                deltaTime: deltaTime,
                type: event.type,
                channel: event.channel
            };

            if (event.type === 'programChange') {
                trackEvent.programNumber = event.programNumber;
            } else if (event.type === 'noteOn' || event.type === 'noteOff') {
                trackEvent.noteNumber = event.noteNumber;
                trackEvent.velocity = event.velocity;
            } else if (event.type === 'controller') {
                trackEvent.controllerType = event.controllerType;
                trackEvent.value = event.value;
            } else if (event.type === 'pitchBend') {
                trackEvent.value = event.value;
            } else if (event.type === 'channelAftertouch') {
                trackEvent.amount = event.amount;
            } else if (event.type === 'noteAftertouch') {
                trackEvent.noteNumber = event.noteNumber;
                trackEvent.amount = event.amount;
            } else if (event.type === 'setTempo') {
                trackEvent.microsecondsPerBeat = event.microsecondsPerBeat;
                delete trackEvent.channel;
            }

            return trackEvent;
        });

        trackEvents.push({
            deltaTime: 0,
            type: 'endOfTrack'
        });

        return {
            header: {
                format: m.midiData?.header?.format || 1,
                numTracks: 1,
                ticksPerBeat: ticksPerBeat
            },
            tracks: [trackEvents]
        };
    }

    // ========================================================================
    // RENAME
    // ========================================================================

    /**
     * Afficher la boite de dialogue pour renommer le fichier
     */
    showRenameDialog() {
        const m = this.modal;
        const currentName = m.currentFilename || m.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>\u270F\uFE0F ${m.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${m.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${m.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

        input.focus();
        input.select();

        const closeDialog = () => {
            dialog.remove();
        };

        const confirmRename = async () => {
            const newName = input.value.trim();
            if (!newName) {
                m.showError(m.t('midiEditor.renameEmpty'));
                return;
            }

            const newFilename = newName + extension;

            try {
                const response = await m.api.sendCommand('file_rename', {
                    fileId: m.currentFile,
                    newFilename: newFilename
                });

                if (response && response.success) {
                    m.currentFilename = newFilename;
                    const fileNameSpan = m.container.querySelector('#editor-file-name');
                    if (fileNameSpan) {
                        fileNameSpan.textContent = newFilename;
                    }

                    m.showNotification(m.t('midiEditor.renameSuccess'), 'success');

                    if (m.eventBus) {
                        m.eventBus.emit('midi_editor:file_renamed', {
                            fileId: m.currentFile,
                            oldFilename: currentName,
                            newFilename: newFilename
                        });
                    }
                } else {
                    throw new Error(response?.error || 'Rename failed');
                }
            } catch (error) {
                m.log('error', 'Failed to rename file:', error);
                m.showError(`${m.t('midiEditor.renameFailed')}: ${error.message}`);
            }

            closeDialog();
        };

        cancelBtn.addEventListener('click', closeDialog);
        confirmBtn.addEventListener('click', confirmRename);
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) closeDialog();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmRename();
            if (e.key === 'Escape') closeDialog();
        });
    }

    // ========================================================================
    // AUTO-ASSIGN
    // ========================================================================

    /**
     * Show auto-assignment modal
     */
    async showAutoAssignModal() {
        const m = this.modal;
        if (!m.currentFile) {
            m.showErrorModal(m.t('midiEditor.noFileLoaded'));
            return;
        }

        if (!window.AutoAssignModal) {
            m.log('warn', 'AutoAssignModal not found on window, attempting dynamic load...');
            try {
                await this.loadScript('js/views/components/AutoAssignModal.js');
            } catch (e) {
                m.log('error', 'Failed to dynamically load AutoAssignModal:', e);
            }
        }

        if (!window.AutoAssignModal) {
            m.showErrorModal(m.t('autoAssign.componentNotLoaded'));
            return;
        }

        const modal = new window.AutoAssignModal(m.api, m);
        modal.show(m.currentFile);
    }

    /**
     * Dynamically load a script if not already loaded
     * @param {string} src - Script path relative to root
     * @returns {Promise<void>}
     */
    loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                existing.remove();
            }
            const script = document.createElement('script');
            script.src = src + '?v=' + Date.now();
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorFileOps;
}

if (typeof window !== 'undefined') {
    window.MidiEditorFileOps = MidiEditorFileOps;
}
