// ============================================================================
// File: public/js/views/components/midi-editor/MidiEditorFileOpsMixin.js
// Description: File operations for the MIDI Editor (save / save-as / rename /
//              convert sequence → MIDI / auto-assign modal).
//   Mixin: methods added to MidiEditorModal.prototype
// ============================================================================

(function() {
    'use strict';

    const MidiEditorFileOpsMixin = {};

    /**
    * Convertir la sequence en données MIDI pour le backend
    * Format compatible avec la bibliothèque 'midi-file'
    */
    MidiEditorFileOpsMixin.convertSequenceToMidi = function() {
    // Use fullSequence which holds every up-to-date note
        const fullSequenceToSave = this.fullSequence;

        if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
            this.log('warn', 'No sequence to convert');
            return null;
        }

        const ticksPerBeat = this.midiData?.header?.ticksPerBeat || 480;

        this.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

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
        if (this.tempoEvents && this.tempoEvents.length > 0) {
            this.tempoEvents.forEach(tempoEvent => {
                const usPerBeat = Math.round(60000000 / tempoEvent.tempo);
                events.push({
                    absoluteTime: tempoEvent.ticks,
                    type: 'setTempo',
                    microsecondsPerBeat: usPerBeat
                });
            });
            this.log('debug', `Added ${this.tempoEvents.length} tempo events from tempo map`);
        } else {
    // Fallback: tempo global unique
            const tempo = this.tempo || 120;
            const microsecondsPerBeat = Math.round(60000000 / tempo);
            events.push({
                absoluteTime: 0,
                type: 'setTempo',
                microsecondsPerBeat: microsecondsPerBeat
            });
            this.log('debug', `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} μs/beat)`);
        }

    // Determine which channels are in use and their programs
        const usedChannels = new Map(); // canal -> program
        fullSequenceToSave.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            if (!usedChannels.has(channel)) {
    // Trouver l'instrument pour ce canal
                const channelInfo = this.channels.find(ch => ch.channel === channel);
                const program = channelInfo ? channelInfo.program : this.selectedInstrument || 0;
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
                this.log('debug', `Added programChange for channel ${channel}: ${this.getInstrumentName(program)}`);
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
        if (this.ccEvents && this.ccEvents.length > 0) {
            this.log('info', `Adding ${this.ccEvents.length} CC/pitchbend events to MIDI file`);

            let ccCount = 0, pbCount = 0, atCount = 0;
            this.ccEvents.forEach(ccEvent => {
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

            this.log('info', `Converted to MIDI: ${ccCount} CC, ${pbCount} pitchbend, ${atCount} aftertouch events`);
        } else {
            this.log('warn', 'No CC/Pitchbend events to save');
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
            this.log('warn', `Clamped ${totalClamped} out-of-range MIDI values: ${JSON.stringify(clampStats)}`);
        }

        return {
            header: {
                format: this.midiData?.header?.format || 1,
                numTracks: 1,
                ticksPerBeat: ticksPerBeat
            },
            tracks: [trackEvents]
        };
    }

    /**
    * Save the MIDI file
    */
    MidiEditorFileOpsMixin.saveMidiFile = async function() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file: ${this.currentFile}`);

    // Sync fullSequence with the current piano roll (handles channels, additions, deletions, etc.)
            this.syncFullSequenceFromPianoRoll();

    // Sync CC/pitch-bend events from the editor
            this.syncCCEventsFromEditor();

    // Sync tempo events from the editor
            this.syncTempoEventsFromEditor();

    // Update the channel list to reflect the current sequence
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

    // Convertir en format MIDI
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Échec de conversion en format MIDI');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Send to the backend
            const response = await this.api.writeMidiFile(this.currentFile, midiData);

            if (response && response.success) {
                this.isDirty = false;
                this.updateSaveButton();
                this.showNotification(this.t('midiEditor.saveSuccess'), 'success');

    // Emit event
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved', {
                        filePath: this.currentFile
                    });
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.log('error', 'Failed to save MIDI file:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
    * Show Save As dialog to save the file with a new name
    */
    MidiEditorFileOpsMixin.showSaveAsDialog = function() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

    // Extract current name without extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Create the Save As dialog
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>📄 ${this.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${this.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
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
                this.showError(this.t('midiEditor.emptyFilename'));
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

    /**
    * Save the current file with a new name (export)
    */
    MidiEditorFileOpsMixin.saveAsFile = async function(newFilename) {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file as: ${newFilename}`);

    // Synchronize data from piano roll
            this.syncFullSequenceFromPianoRoll();
            this.syncCCEventsFromEditor();
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

    // Convert to MIDI format
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Failed to convert to MIDI format');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Send to backend with new filename
            const response = await this.api.sendCommand('file_save_as', {
                fileId: this.currentFile,
                newFilename: newFilename,
                midiData: midiData
            });

            if (response && response.success) {
                this.showNotification(
                    this.t('midiEditor.saveAsSuccess', { filename: newFilename }),
                    'success'
                );

    // Emit event
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved_as', {
                        originalFile: this.currentFile,
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
            this.log('error', 'Failed to save file as:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
    * Show routing modal (RoutingSummaryPage)
    */
    MidiEditorFileOpsMixin.showAutoAssignModal = async function() {
        if (!this.currentFile) {
            this.showErrorModal(this.t('midiEditor.noFileLoaded'));
            return;
        }

        if (!window.RoutingSummaryPage) {
            this.showErrorModal(this.t('autoAssign.componentNotLoaded'));
            return;
        }

        const routingPage = new window.RoutingSummaryPage(this.api);
        routingPage.show(this.currentFile, this.currentFilename || '', this.channels || [], (result) => {
            if (result && window.eventBus) {
                window.eventBus.emit('routing:changed', result);
            }
        });
    }

    /**
    * Dynamically load a script if not already loaded
    * @param {string} src - Script path relative to root
    * @returns {Promise<void>}
    */
    MidiEditorFileOpsMixin.loadScript = function(src) {
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

    /**
    * Afficher la boîte de dialogue pour renommer le fichier
    */
    MidiEditorFileOpsMixin.showRenameDialog = function() {
    // Extraire le nom sans extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Create the rename dialog (centered modal)
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>✏️ ${this.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
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
                this.showError(this.t('midiEditor.renameEmpty'));
                return;
            }

            const newFilename = newName + extension;

            try {
    // Appeler l'API pour renommer le fichier
                const response = await this.api.sendCommand('file_rename', {
                    fileId: this.currentFile,
                    newFilename: newFilename
                });

                if (response && response.success) {
    // Update the displayed name
                    this.currentFilename = newFilename;
                    const fileNameSpan = this.container.querySelector('#editor-file-name');
                    if (fileNameSpan) {
                        fileNameSpan.textContent = newFilename;
                    }

                    this.showNotification(this.t('midiEditor.renameSuccess'), 'success');

    // Emit event to refresh the file list
                    if (this.eventBus) {
                        this.eventBus.emit('midi_editor:file_renamed', {
                            fileId: this.currentFile,
                            oldFilename: currentName,
                            newFilename: newFilename
                        });
                    }
                } else {
                    throw new Error(response?.error || 'Rename failed');
                }
            } catch (error) {
                this.log('error', 'Failed to rename file:', error);
                this.showError(`${this.t('midiEditor.renameFailed')}: ${error.message}`);
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

    // Facade sub-component (P2-F.10c-batch).
    class MidiEditorFileOps {
        constructor(modal) { this.modal = modal; }
    }
    Object.keys(MidiEditorFileOpsMixin).forEach((key) => {
        MidiEditorFileOps.prototype[key] = function(...args) {
            return MidiEditorFileOpsMixin[key].apply(this.modal, args);
        };
    });

    if (typeof window !== 'undefined') {
        window.MidiEditorFileOpsMixin = MidiEditorFileOpsMixin;
        window.MidiEditorFileOps = MidiEditorFileOps;
    }
})();
