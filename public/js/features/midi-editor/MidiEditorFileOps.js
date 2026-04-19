// ============================================================================
// File: public/js/features/midi-editor/MidiEditorFileOps.js
// Description: File operations (save/load/rename/export) for the MIDI editor
//   Sub-component class ; called via `modal.fileOps.<method>(...)`.
//   (P2-F.10d body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorFileOps {
        constructor(modal) {
            this.modal = modal;
        }

    convertSequenceToMidi() {
    // Use fullSequence which holds every up-to-date note
        const fullSequenceToSave = this.modal.fullSequence;

        if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
            this.modal.log('warn', 'No sequence to convert');
            return null;
        }

        const ticksPerBeat = this.modal.midiData?.header?.ticksPerBeat || 480;

        this.modal.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

    // Clamp MIDI values to their valid ranges and count any corrections for the log.
    // The MIDI standard enforces 7-bit values (0-127) for note/velocity/CC,
    // 4-bit (0-15) for channel, and 14-bit signed (-8192..8191) for pitch bend.
        const clampStats = { note: 0, channel: 0, velocity: 0, cc: 0, pitchBend: 0, ticks: 0 };
        const clamp = (value, min, max, kind) => {
            const n = Number(value);
            if (!Number.isFinite(n)) { clampStats[kind]++; return min; }
            if (n < min) { clampStats[kind]++; return min; }
            if (n > max) { clampStats[kind]++; return max; }
            return n;
        };

    // Convert the sequence into MIDI events
        const events = [];

    // Add tempo events (full tempo map or global tempo)
        if (this.modal.tempoEvents && this.modal.tempoEvents.length > 0) {
            this.modal.tempoEvents.forEach(tempoEvent => {
                const usPerBeat = Math.round(60000000 / tempoEvent.tempo);
                events.push({
                    absoluteTime: tempoEvent.ticks,
                    type: 'setTempo',
                    microsecondsPerBeat: usPerBeat
                });
            });
            this.modal.log('debug', `Added ${this.modal.tempoEvents.length} tempo events from tempo map`);
        } else {
    // Fallback: tempo global unique
            const tempo = this.modal.tempo || 120;
            const microsecondsPerBeat = Math.round(60000000 / tempo);
            events.push({
                absoluteTime: 0,
                type: 'setTempo',
                microsecondsPerBeat: microsecondsPerBeat
            });
            this.modal.log('debug', `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} μs/beat)`);
        }

    // Determine which channels are in use and their programs
        const usedChannels = new Map(); // canal -> program
        fullSequenceToSave.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            if (!usedChannels.has(channel)) {
    // Trouver l'instrument pour ce canal
                const channelInfo = this.modal.channels.find(ch => ch.channel === channel);
                const program = channelInfo ? channelInfo.program : this.modal.selectedInstrument || 0;
                usedChannels.set(channel, program);
            }
        });

    // Add programChange events at tick 0 for each channel
        usedChannels.forEach((program, channel) => {
            if (channel !== 9) { // Canal 10 (index 9) est pour drums, pas de programChange
                events.push({
                    absoluteTime: 0,
                    type: 'programChange',
                    channel: channel,
                    programNumber: program
                });
                this.modal.log('debug', `Added programChange for channel ${channel}: ${this.modal.getInstrumentName(program)}`);
            }
        });

    // Add note events
        fullSequenceToSave.forEach(note => {
            const tick = clamp(note.t, 0, Number.MAX_SAFE_INTEGER, 'ticks');
            const noteNumber = clamp(note.n, 0, 127, 'note');
            const gate = Math.max(1, clamp(note.g, 1, Number.MAX_SAFE_INTEGER, 'ticks'));
            const channel = clamp(note.c !== undefined ? note.c : 0, 0, 15, 'channel');
            const velocity = clamp(note.v || 100, 1, 127, 'velocity');

    // Note On
            events.push({
                absoluteTime: tick,
                type: 'noteOn',
                channel: channel,
                noteNumber: noteNumber,
                velocity: velocity
            });

    // Note Off
            events.push({
                absoluteTime: tick + gate,
                type: 'noteOff',
                channel: channel,
                noteNumber: noteNumber,
                velocity: 0
            });
        });

    // Add CC and pitch-bend events
        if (this.modal.ccEvents && this.modal.ccEvents.length > 0) {
            this.modal.log('info', `Adding ${this.modal.ccEvents.length} CC/pitchbend events to MIDI file`);

            let ccCount = 0, pbCount = 0, atCount = 0;
            this.modal.ccEvents.forEach(ccEvent => {
                const ccTick = clamp(ccEvent.ticks ?? ccEvent.tick ?? 0, 0, Number.MAX_SAFE_INTEGER, 'ticks');
                const ccChannel = clamp(ccEvent.channel, 0, 15, 'channel');
    // Translate the editor type (cc1, cc2, cc5, cc7, cc10, cc11, cc74) into a controller number
                if (ccEvent.type.startsWith('cc')) {
    // Extract the numeric type (cc1 -> 1, cc7 -> 7, etc.)
                    const controllerNumber = parseInt(ccEvent.type.replace('cc', ''));
                    events.push({
                        absoluteTime: ccTick,
                        type: 'controller',
                        channel: ccChannel,
                        controllerType: controllerNumber,
                        value: clamp(ccEvent.value, 0, 127, 'cc')
                    });
                    ccCount++;
                } else if (ccEvent.type === 'pitchbend') {
                    events.push({
                        absoluteTime: ccTick,
                        type: 'pitchBend',
                        channel: ccChannel,
                        value: clamp(ccEvent.value, -8192, 8191, 'pitchBend')
                    });
                    pbCount++;
                } else if (ccEvent.type === 'aftertouch') {
                    events.push({
                        absoluteTime: ccTick,
                        type: 'channelAftertouch',
                        channel: ccChannel,
                        amount: clamp(ccEvent.value, 0, 127, 'cc')
                    });
                    atCount++;
                } else if (ccEvent.type === 'polyAftertouch') {
                    events.push({
                        absoluteTime: ccTick,
                        type: 'polyAftertouch',
                        channel: ccChannel,
                        noteNumber: clamp(ccEvent.note || 0, 0, 127, 'note'),
                        pressure: clamp(ccEvent.value, 0, 127, 'cc')
                    });
                    atCount++;
                }
            });

            this.modal.log('info', `Converted to MIDI: ${ccCount} CC, ${pbCount} pitchbend, ${atCount} aftertouch events`);
        } else {
            this.modal.log('warn', 'No CC/Pitchbend events to save');
        }

    // Trier par temps absolu
        events.sort((a, b) => a.absoluteTime - b.absoluteTime);

    // Convertir temps absolu en deltaTime
        let lastTime = 0;
        const trackEvents = events.map(event => {
            const deltaTime = event.absoluteTime - lastTime;
            lastTime = event.absoluteTime;

            const trackEvent = {
                deltaTime: deltaTime,
                type: event.type,
                channel: event.channel
            };

    // Add event-type-specific fields
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
            } else if (event.type === 'setTempo') {
                trackEvent.microsecondsPerBeat = event.microsecondsPerBeat;
    // setTempo events have no channel
                delete trackEvent.channel;
            }

            return trackEvent;
        });

    // Ajouter End of Track
        trackEvents.push({
            deltaTime: 0,
            type: 'endOfTrack'
        });

    // Structure MIDI compatible avec midi-file
    // Report any clamped values so data corruption shows up in the log instead of silently
        const totalClamped = Object.values(clampStats).reduce((a, b) => a + b, 0);
        if (totalClamped > 0) {
            this.modal.log('warn', `Clamped ${totalClamped} out-of-range MIDI values: ${JSON.stringify(clampStats)}`);
        }

        return {
            header: {
                format: this.modal.midiData?.header?.format || 1,
                numTracks: 1,
                ticksPerBeat: ticksPerBeat
            },
            tracks: [trackEvents]
        };
    }

    async saveMidiFile() {
        if (!this.modal.currentFile || !this.modal.pianoRoll) {
            this.modal.log('error', 'Cannot save: no file or piano roll');
            this.modal.showError(this.modal.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.modal.log('info', `Saving MIDI file: ${this.modal.currentFile}`);

    // Sync fullSequence with the current piano roll (handles channels, additions, deletions, etc.)
            this.modal.sequenceOps.syncFullSequenceFromPianoRoll();

    // Sync CC/pitch-bend events from the editor
            this.modal.ccPicker.syncCCEventsFromEditor();

    // Sync tempo events from the editor
            this.modal.ccPicker.syncTempoEventsFromEditor();

    // Update the channel list to reflect the current sequence
            this.modal.ccPicker.updateChannelsFromSequence();

            this.modal.log('info', `Saving ${this.modal.fullSequence.length} notes across ${this.modal.channels.length} channels`);

    // Convertir en format MIDI
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Échec de conversion en format MIDI');
            }

            this.modal.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Send to the backend
            const response = await this.modal.api.writeMidiFile(this.modal.currentFile, midiData);

            if (response && response.success) {
                this.modal.isDirty = false;
                this.modal.routingOps?.updateSaveButton();
                this.modal.showNotification(this.modal.t('midiEditor.saveSuccess'), 'success');

    // Emit event
                if (this.modal.eventBus) {
                    this.modal.eventBus.emit('midi_editor:saved', {
                        filePath: this.modal.currentFile
                    });
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.modal.log('error', 'Failed to save MIDI file:', error);
            this.modal.showError(`${this.modal.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    showSaveAsDialog() {
        if (!this.modal.currentFile || !this.modal.pianoRoll) {
            this.modal.log('error', 'Cannot save as: no file or piano roll');
            this.modal.showError(this.modal.t('midiEditor.cannotSave'));
            return;
        }

    // Extract current name without extension
        const currentName = this.modal.currentFilename || this.modal.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Create the Save As dialog
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>📄 ${this.modal.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${this.modal.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.modal.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.modal.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

    // Select name without extension for easy editing
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

    // Cancel
        cancelBtn.addEventListener('click', () => {
            dialog.remove();
        });

    // Confirm - Save As
        confirmBtn.addEventListener('click', async () => {
            const newBaseName = input.value.trim();
            if (!newBaseName) {
                this.modal.showError(this.modal.t('midiEditor.emptyFilename'));
                return;
            }

            const newFilename = newBaseName + extension;
            dialog.remove();

    // Call saveAsFile with the new filename
            await this.saveAsFile(newFilename);
        });

    // Enter to confirm
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            } else if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });

    // Click outside to cancel
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    async saveAsFile(newFilename) {
        if (!this.modal.currentFile || !this.modal.pianoRoll) {
            this.modal.log('error', 'Cannot save as: no file or piano roll');
            this.modal.showError(this.modal.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.modal.log('info', `Saving MIDI file as: ${newFilename}`);

    // Synchronize data from piano roll
            this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
            this.modal.ccPicker.syncCCEventsFromEditor();
            this.modal.ccPicker.updateChannelsFromSequence();

            this.modal.log('info', `Saving ${this.modal.fullSequence.length} notes across ${this.modal.channels.length} channels`);

    // Convert to MIDI format
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Failed to convert to MIDI format');
            }

            this.modal.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Send to backend with new filename
            const response = await this.modal.api.sendCommand('file_save_as', {
                fileId: this.modal.currentFile,
                newFilename: newFilename,
                midiData: midiData
            });

            if (response && response.success) {
                this.modal.showNotification(
                    this.modal.t('midiEditor.saveAsSuccess', { filename: newFilename }),
                    'success'
                );

    // Emit event
                if (this.modal.eventBus) {
                    this.modal.eventBus.emit('midi_editor:saved_as', {
                        originalFile: this.modal.currentFile,
                        newFile: response.newFileId,
                        newFilename: newFilename
                    });
                }

    // Optionally reload file list in parent
                if (window.loadFiles) {
                    window.loadFiles();
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.modal.log('error', 'Failed to save file as:', error);
            this.modal.showError(`${this.modal.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    async showAutoAssignModal() {
        if (!this.modal.currentFile) {
            this.modal.showErrorModal(this.modal.t('midiEditor.noFileLoaded'));
            return;
        }

        if (!window.RoutingSummaryPage) {
            this.modal.showErrorModal(this.modal.t('autoAssign.componentNotLoaded'));
            return;
        }

        const routingPage = new window.RoutingSummaryPage(this.modal.api);
        routingPage.show(this.modal.currentFile, this.modal.currentFilename || '', this.modal.channels || [], (result) => {
            if (result && window.eventBus) {
                window.eventBus.emit('routing:changed', result);
            }
        });
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
    // Check if already loaded
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
    // Script tag exists but maybe failed - remove and reload
                existing.remove();
            }
            const script = document.createElement('script');
            script.src = src + '?v=' + Date.now();
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    showRenameDialog() {
    // Extraire le nom sans extension
        const currentName = this.modal.currentFilename || this.modal.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Create the rename dialog (centered modal)
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>✏️ ${this.modal.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.modal.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.modal.t('common.save')}</button>
                </div>
            </div>
        `;

    // Append to <body> so it sits on top of everything
        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

    // Focus and select the text
        input.focus();
        input.select();

    // Fonction de fermeture
        const closeDialog = () => {
            dialog.remove();
        };

    // Fonction de validation
        const confirmRename = async () => {
            const newName = input.value.trim();
            if (!newName) {
                this.modal.showError(this.modal.t('midiEditor.renameEmpty'));
                return;
            }

            const newFilename = newName + extension;

            try {
    // Appeler l'API pour renommer le fichier
                const response = await this.modal.api.sendCommand('file_rename', {
                    fileId: this.modal.currentFile,
                    newFilename: newFilename
                });

                if (response && response.success) {
    // Update the displayed name
                    this.modal.currentFilename = newFilename;
                    const fileNameSpan = this.modal.container.querySelector('#editor-file-name');
                    if (fileNameSpan) {
                        fileNameSpan.textContent = newFilename;
                    }

                    this.modal.showNotification(this.modal.t('midiEditor.renameSuccess'), 'success');

    // Emit event to refresh the file list
                    if (this.modal.eventBus) {
                        this.modal.eventBus.emit('midi_editor:file_renamed', {
                            fileId: this.modal.currentFile,
                            oldFilename: currentName,
                            newFilename: newFilename
                        });
                    }
                } else {
                    throw new Error(response?.error || 'Rename failed');
                }
            } catch (error) {
                this.modal.log('error', 'Failed to rename file:', error);
                this.modal.showError(`${this.modal.t('midiEditor.renameFailed')}: ${error.message}`);
            }

            closeDialog();
        };

    // Events
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
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorFileOps = MidiEditorFileOps;
    }
})();
