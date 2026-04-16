// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorSequence.js
// Description: Gestion de la sequence MIDI (conversion, sync, canaux)
//   Mixin: les methodes sont ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    /**
     * Methodes de gestion de la sequence MIDI.
     * Ajoutees au prototype de MidiEditorModal apres son chargement.
     * @namespace MidiEditorSequenceMixin
     */
    const MidiEditorSequenceMixin = {

        /**
         * Convertir les donnees MIDI en format sequence pour webaudio-pianoroll
         * Format: {t: tick, g: gate, n: note, c: channel, v: velocity}
         */
        convertMidiToSequence: function() {
            this.fullSequence = [];
            this.channels = [];

            if (!this.midiData || !this.midiData.tracks) {
                this.log('warn', 'No MIDI tracks to convert');
                return;
            }

            const ticksPerBeat = this.midiData.header?.ticksPerBeat || 480;
            this.ticksPerBeat = ticksPerBeat;

            // Extraire le tempo et la tempo map du fichier MIDI
            let tempo = 120;
            this.tempoEvents = [];
            if (this.midiData.tracks && this.midiData.tracks.length > 0) {
                for (const track of this.midiData.tracks) {
                    if (!track.events) continue;
                    let currentTick = 0;
                    for (const event of track.events) {
                        currentTick += event.deltaTime || 0;
                        if (event.type === 'setTempo' && event.microsecondsPerBeat) {
                            const bpm = Math.round(60000000 / event.microsecondsPerBeat);
                            if (this.tempoEvents.length === 0) {
                                tempo = bpm;
                            }
                            this.tempoEvents.push({
                                ticks: currentTick,
                                tempo: bpm,
                                id: Date.now() + Math.random() + this.tempoEvents.length
                            });
                        }
                    }
                }
                if (this.tempoEvents.length > 0) {
                    this.log('info', `Extracted ${this.tempoEvents.length} tempo events (first: ${tempo} BPM)`);
                }
            }
            this.tempo = tempo;

            this.log('info', `Converting MIDI: ${this.midiData.tracks.length} tracks, ${ticksPerBeat} ticks/beat, ${tempo} BPM`);

            const channelInstruments = new Map();
            const channelNoteCount = new Map();
            const allNotes = [];

            this.midiData.tracks.forEach((track, trackIndex) => {
                if (!track.events) {
                    this.log('debug', `Track ${trackIndex}: no events`);
                    return;
                }

                this.log('debug', `Track ${trackIndex} (${track.name || 'unnamed'}): ${track.events.length} events`);

                const activeNotes = new Map();
                let currentTick = 0;
                let noteOnCount = 0;
                let noteOffCount = 0;

                track.events.forEach((event, _eventIndex) => {
                    currentTick += event.deltaTime || 0;

                    if (event.type === 'programChange') {
                        const channel = event.channel ?? 0;
                        channelInstruments.set(channel, event.programNumber);
                        this.log('debug', `Channel ${channel}: program ${event.programNumber} (${this.getInstrumentName(event.programNumber)})`);
                    }

                    if (event.type === 'noteOn' && event.velocity > 0) {
                        noteOnCount++;
                        const channel = event.channel ?? 0;
                        const key = `${channel}_${event.noteNumber}`;

                        const existing = activeNotes.get(key);
                        if (existing) {
                            const gate = Math.max(1, currentTick - existing.tick);
                            allNotes.push({
                                tick: existing.tick, note: existing.note,
                                gate: gate, velocity: existing.velocity, channel: existing.channel
                            });
                            channelNoteCount.set(existing.channel, (channelNoteCount.get(existing.channel) || 0) + 1);
                        }

                        activeNotes.set(key, {
                            tick: currentTick, note: event.noteNumber,
                            velocity: event.velocity, channel: channel
                        });

                        if (noteOnCount === 1) {
                            this.log('debug', `First noteOn in track ${trackIndex}:`, {
                                tick: currentTick, note: event.noteNumber,
                                velocity: event.velocity, channel: channel
                            });
                        }
                    }
                    else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
                        noteOffCount++;
                        const channel = event.channel ?? 0;
                        const key = `${channel}_${event.noteNumber}`;
                        const noteOn = activeNotes.get(key);

                        if (noteOn) {
                            const gate = currentTick - noteOn.tick;
                            allNotes.push({
                                tick: noteOn.tick, note: noteOn.note,
                                gate: gate, velocity: noteOn.velocity, channel: channel
                            });
                            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);
                            activeNotes.delete(key);
                        }
                    }
                });

                for (const [, noteOn] of activeNotes) {
                    const defaultGate = Math.max(1, currentTick - noteOn.tick);
                    allNotes.push({
                        tick: noteOn.tick, note: noteOn.note,
                        gate: defaultGate > 0 ? defaultGate : 480,
                        velocity: noteOn.velocity, channel: noteOn.channel
                    });
                    channelNoteCount.set(noteOn.channel, (channelNoteCount.get(noteOn.channel) || 0) + 1);
                }
                if (activeNotes.size > 0) {
                    this.log('warn', `Track ${trackIndex}: ${activeNotes.size} orphaned notes (no noteOff) recovered`);
                }
                activeNotes.clear();

                this.log('debug', `Track ${trackIndex} summary: ${noteOnCount} note-ons, ${noteOffCount} note-offs, ${allNotes.length} complete notes`);
            });

            this.fullSequence = allNotes.map(note => ({
                t: note.tick, g: note.gate, n: note.note,
                c: note.channel, v: note.velocity || 100
            }));

            this.fullSequence.sort((a, b) => a.t - b.t);

            channelNoteCount.forEach((count, channel) => {
                const hasExplicitProgram = channelInstruments.has(channel);
                const programNumber = channelInstruments.get(channel) || 0;
                const instrumentName = channel === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(programNumber);

                this.channels.push({
                    channel: channel, program: programNumber,
                    instrument: instrumentName, noteCount: count,
                    hasExplicitProgram: hasExplicitProgram
                });
            });

            this.channels.sort((a, b) => a.channel - b.channel);

            this.log('info', `Converted ${this.fullSequence.length} notes to sequence`);
            this.log('info', `Found ${this.channels.length} channels:`, this.channels);

            this.extractCCAndPitchbend();
            this.updateDynamicCCButtons();

            this.activeChannels.clear();
            if (this.channels.length > 0) {
                this.channels.forEach(ch => this.activeChannels.add(ch.channel));
                this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));
                this.log('info', `All ${this.channels.length} channels activated by default`);
                this.log('info', `Initial sequence: ${this.sequence.length} notes visible`);
            } else {
                this.log('warn', 'No notes found! Check MIDI data structure.');
                this.sequence = [];
            }
        },

        /**
         * Basculer l'affichage d'un canal
         */
        toggleChannel: function(channel) {
            const previousActiveChannels = new Set(this.activeChannels);

            if (this.activeChannels.has(channel)) {
                this.activeChannels.delete(channel);
                this.channelDisabled.add(channel);
            } else {
                this.activeChannels.add(channel);
                this.channelDisabled.delete(channel);
            }

            this.log('info', `Toggled channel ${channel}. Active channels: [${Array.from(this.activeChannels).join(', ')}]`);

            if (this.tablatureEditor && this.tablatureEditor.isVisible) {
                this.tablatureEditor.hide();
                this._updateTabButtonState(false);
            }

            if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
                this.drumPatternEditor.hide();
                this._updateDrumButtonState(false);
            }

            this.updateSequenceFromActiveChannels(previousActiveChannels);
            this.updateChannelButtons();
            this.updateInstrumentSelector();

            if (this.channelPanel) {
                this.channelPanel.updateTablatureButton();
            }

            this.updateCCEditorChannel();
            this.syncMutedChannels();
            this._updateChannelDisabledVisual(channel);

            // Sync popover checkbox if open for this channel
            if (this._channelSettingsOpen === channel && this._channelSettingsPopoverEl) {
                const cb = this._channelSettingsPopoverEl.querySelector('.channel-enabled-checkbox');
                if (cb) cb.checked = this.activeChannels.has(channel);
            }

            if (this.channelPlayableHighlights.size > 0) {
                this._syncPianoRollHighlights();
            }
        },

        /**
         * Mettre a jour la sequence depuis les canaux actifs
         */
        updateSequenceFromActiveChannels: function(previousActiveChannels, skipSync) {
            if (previousActiveChannels === undefined) previousActiveChannels = null;
            if (skipSync === undefined) skipSync = false;

            if (!skipSync) {
                this.syncFullSequenceFromPianoRoll(previousActiveChannels);
            }

            if (this.activeChannels.size === 0) {
                this.sequence = [];
            } else {
                this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));
            }

            this.log('info', `Updated sequence: ${this.sequence.length} notes from ${this.activeChannels.size} active channel(s)`);

            if (this.pianoRoll) {
                this.pianoRoll.sequence.length = 0;

                this.sequence.forEach(note => {
                    this.pianoRoll.sequence.push({...note});
                });

                this.pianoRoll.channelColors = this.channelColors;

                if (this.activeChannels.size > 0) {
                    this.pianoRoll.defaultChannel = Array.from(this.activeChannels)[0];
                    this.log('debug', `Default channel for new notes: ${this.pianoRoll.defaultChannel}`);
                }

                if (typeof this.pianoRoll.redraw === 'function') {
                    this.pianoRoll.redraw();
                    this.log('debug', `Piano roll redrawn after channel toggle: ${this.pianoRoll.sequence.length} notes visible`);
                }
            }

            // Sync CC/Velocity editor to the edited channel
            if (this.activeChannels.size === 1 && this.ccSectionExpanded) {
                const ch = Array.from(this.activeChannels)[0];
                if (this.ccEditor) this.ccEditor.setChannel(ch);
                if (this.velocityEditor) this.velocityEditor.setChannel(ch);
                if (typeof this.updateEditorChannelSelector === 'function') {
                    this.updateEditorChannelSelector();
                }
            }
        },

        /**
         * Synchroniser fullSequence avec les notes actuelles du piano roll
         */
        syncFullSequenceFromPianoRoll: function(previousActiveChannels) {
            if (previousActiveChannels === undefined) previousActiveChannels = null;
            if (!this.pianoRoll || !this.pianoRoll.sequence) return;

            const currentSequence = this.pianoRoll.sequence;
            const visibleChannels = previousActiveChannels || this.activeChannels;
            const invisibleNotes = this.fullSequence.filter(note => !visibleChannels.has(note.c));
            const visibleNotes = currentSequence.map(note => ({
                t: note.t, g: note.g, n: note.n,
                c: note.c !== undefined ? note.c : Array.from(visibleChannels)[0] || 0,
                v: note.v || 100
            }));

            this.fullSequence = [...invisibleNotes, ...visibleNotes];
            this.fullSequence.sort((a, b) => a.t - b.t);

            this.log('debug', `Synced fullSequence: ${invisibleNotes.length} invisible + ${visibleNotes.length} visible = ${this.fullSequence.length} total (using ${previousActiveChannels ? 'previous' : 'current'} active channels)`);

            if (this.tablatureEditor && this.tablatureEditor.isVisible && this.activeChannels.size === 1) {
                const activeChannel = Array.from(this.activeChannels)[0];
                const channelNotes = visibleNotes.filter(n => n.c === activeChannel);
                this.tablatureEditor.onMidiNotesChanged(channelNotes);
            }

            if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
                const drumChannel = this.drumPatternEditor.channel;
                const drumNotes = visibleNotes.filter(n => n.c === drumChannel);
                this.drumPatternEditor.onMidiNotesChanged(drumNotes);
            }

            if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
                const windChannel = this.windInstrumentEditor.channel;
                const windNotes = visibleNotes.filter(n => n.c === windChannel);
                this.windInstrumentEditor.onMidiNotesChanged(windNotes);
            }
        }
    };

    // Export le mixin pour application ulterieure au prototype
    if (typeof window !== 'undefined') {
        window.MidiEditorSequenceMixin = MidiEditorSequenceMixin;
    }
})();
