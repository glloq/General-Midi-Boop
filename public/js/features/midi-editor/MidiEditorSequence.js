// ============================================================================
// File: public/js/features/midi-editor/MidiEditorSequence.js
// Description: MIDI sequence management (conversion, sync, channels).
//   Sub-component class ; called via `modal.sequenceOps.<method>(...)`.
//   (P2-F.10i body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorSequence {
        constructor(modal) {
            this.modal = modal;
        }

    convertMidiToSequence() {
            this.modal.fullSequence = [];
            this.modal.channels = [];

            if (!this.modal.midiData || !this.modal.midiData.tracks) {
                this.modal.log('warn', 'No MIDI tracks to convert');
                return;
            }

            const ticksPerBeat = this.modal.midiData.header?.ticksPerBeat || 480;
            this.modal.ticksPerBeat = ticksPerBeat;

            // Extraire le tempo et la tempo map du fichier MIDI
            let tempo = 120;
            this.modal.tempoEvents = [];
            if (this.modal.midiData.tracks && this.modal.midiData.tracks.length > 0) {
                for (const track of this.modal.midiData.tracks) {
                    if (!track.events) continue;
                    let currentTick = 0;
                    for (const event of track.events) {
                        currentTick += event.deltaTime || 0;
                        if (event.type === 'setTempo' && event.microsecondsPerBeat) {
                            const bpm = Math.round(60000000 / event.microsecondsPerBeat);
                            if (this.modal.tempoEvents.length === 0) {
                                tempo = bpm;
                            }
                            this.modal.tempoEvents.push({
                                ticks: currentTick,
                                tempo: bpm,
                                id: `tempo_${currentTick}_${this.modal.tempoEvents.length}`
                            });
                        }
                    }
                }
                if (this.modal.tempoEvents.length > 0) {
                    this.modal.log('info', `Extracted ${this.modal.tempoEvents.length} tempo events (first: ${tempo} BPM)`);
                }
            }
            this.modal.tempo = tempo;

            this.modal.log('info', `Converting MIDI: ${this.modal.midiData.tracks.length} tracks, ${ticksPerBeat} ticks/beat, ${tempo} BPM`);

            const channelInstruments = new Map();
            const channelNoteCount = new Map();
            const allNotes = [];

            this.modal.midiData.tracks.forEach((track, trackIndex) => {
                if (!track.events) {
                    this.modal.log('debug', `Track ${trackIndex}: no events`);
                    return;
                }

                this.modal.log('debug', `Track ${trackIndex} (${track.name || 'unnamed'}): ${track.events.length} events`);

                const activeNotes = new Map();
                let currentTick = 0;
                let noteOnCount = 0;
                let noteOffCount = 0;

                track.events.forEach((event, _eventIndex) => {
                    currentTick += event.deltaTime || 0;

                    if (event.type === 'programChange') {
                        const channel = event.channel ?? 0;
                        channelInstruments.set(channel, event.programNumber);
                        this.modal.log('debug', `Channel ${channel}: program ${event.programNumber} (${this.modal.getInstrumentName(event.programNumber)})`);
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
                            this.modal.log('debug', `First noteOn in track ${trackIndex}:`, {
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
                    this.modal.log('warn', `Track ${trackIndex}: ${activeNotes.size} orphaned notes (no noteOff) recovered`);
                }
                activeNotes.clear();

                this.modal.log('debug', `Track ${trackIndex} summary: ${noteOnCount} note-ons, ${noteOffCount} note-offs, ${allNotes.length} complete notes`);
            });

            this.modal.fullSequence = allNotes.map(note => ({
                t: note.tick, g: note.gate, n: note.note,
                c: note.channel, v: note.velocity || 100
            }));

            this.modal.fullSequence.sort((a, b) => a.t - b.t);

            channelNoteCount.forEach((count, channel) => {
                const hasExplicitProgram = channelInstruments.has(channel);
                const programNumber = channelInstruments.get(channel) || 0;
                const instrumentName = channel === 9 ? this.modal.t('midiEditor.drumKit') : this.modal.getInstrumentName(programNumber);

                this.modal.channels.push({
                    channel: channel, program: programNumber,
                    instrument: instrumentName, noteCount: count,
                    hasExplicitProgram: hasExplicitProgram
                });
            });

            this.modal.channels.sort((a, b) => a.channel - b.channel);

            this.modal.log('info', `Converted ${this.modal.fullSequence.length} notes to sequence`);
            this.modal.log('info', `Found ${this.modal.channels.length} channels:`, this.modal.channels);

            this.modal.ccOps.extractCCAndPitchbend();
            this.modal.ccOps.updateDynamicCCButtons();

            this.modal.activeChannels.clear();
            if (this.modal.channels.length > 0) {
                this.modal.channels.forEach(ch => this.modal.activeChannels.add(ch.channel));
                this.modal.sequence = this.modal.fullSequence.filter(note => this.modal.activeChannels.has(note.c));
                this.modal.log('info', `All ${this.modal.channels.length} channels activated by default`);
                this.modal.log('info', `Initial sequence: ${this.modal.sequence.length} notes visible`);
            } else {
                this.modal.log('warn', 'No notes found! Check MIDI data structure.');
                this.modal.sequence = [];
            }
        }

    toggleChannel(channel) {
            const previousActiveChannels = new Set(this.modal.activeChannels);

            if (this.modal.activeChannels.has(channel)) {
                this.modal.activeChannels.delete(channel);
                this.modal.channelDisabled.add(channel);
            } else {
                this.modal.activeChannels.add(channel);
                this.modal.channelDisabled.delete(channel);
            }

            this.modal.log('info', `Toggled channel ${channel}. Active channels: [${Array.from(this.modal.activeChannels).join(', ')}]`);

            if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
                this.modal.tablatureEditor.hide();
                this.modal._updateTabButtonState(false);
            }

            if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
                this.modal.drumPatternEditor.hide();
                this.modal._updateDrumButtonState(false);
            }

            this.updateSequenceFromActiveChannels(previousActiveChannels);
            this.modal.routingOps.updateChannelButtons();
            this.modal.renderer.updateInstrumentSelector();

            if (this.modal.channelPanel) {
                this.modal.channelPanel.updateTablatureButton();
            }

            this.modal.ccPicker.updateCCEditorChannel();
            this.modal.syncMutedChannels();
            this.modal._updateChannelDisabledVisual(channel);

            // Sync popover checkbox if open for this channel
            if (this.modal._channelSettingsOpen === channel && this.modal._channelSettingsPopoverEl) {
                const cb = this.modal._channelSettingsPopoverEl.querySelector('.channel-enabled-checkbox');
                if (cb) cb.checked = this.modal.activeChannels.has(channel);
            }

            if (this.modal.channelPlayableHighlights.size > 0) {
                this.modal._syncPianoRollHighlights();
            }
        }

    updateSequenceFromActiveChannels(previousActiveChannels, skipSync) {
            if (previousActiveChannels === undefined) previousActiveChannels = null;
            if (skipSync === undefined) skipSync = false;

            if (!skipSync) {
                this.syncFullSequenceFromPianoRoll(previousActiveChannels);
            }

            if (this.modal.activeChannels.size === 0) {
                this.modal.sequence = [];
            } else {
                this.modal.sequence = this.modal.fullSequence.filter(note => this.modal.activeChannels.has(note.c));
            }

            this.modal.log('info', `Updated sequence: ${this.modal.sequence.length} notes from ${this.modal.activeChannels.size} active channel(s)`);

            if (this.modal.pianoRoll) {
                this.modal.pianoRoll.sequence.length = 0;

                this.modal.sequence.forEach(note => {
                    this.modal.pianoRoll.sequence.push({...note});
                });

                this.modal.pianoRoll.channelColors = this.modal.channelColors;

                if (this.modal.activeChannels.size > 0) {
                    this.modal.pianoRoll.defaultChannel = Array.from(this.modal.activeChannels)[0];
                    this.modal.log('debug', `Default channel for new notes: ${this.modal.pianoRoll.defaultChannel}`);
                }

                if (typeof this.modal.pianoRoll.redraw === 'function') {
                    this.modal.pianoRoll.redraw();
                    this.modal.log('debug', `Piano roll redrawn after channel toggle: ${this.modal.pianoRoll.sequence.length} notes visible`);
                }
            }

            // Sync CC/Velocity editor to the edited channel
            if (this.modal.activeChannels.size === 1 && this.modal.ccSectionExpanded) {
                const ch = Array.from(this.modal.activeChannels)[0];
                if (this.modal.ccEditor) this.modal.ccEditor.setChannel(ch);
                if (this.modal.velocityEditor) this.modal.velocityEditor.setChannel(ch);
                if (typeof this.modal.ccOps.updateEditorChannelSelector === 'function') {
                    this.modal.ccOps.updateEditorChannelSelector();
                }
            }

            if (typeof this.modal.events._updateNavigationMinimap === 'function') {
                this.modal.events._updateNavigationMinimap();
            }
        }

    syncFullSequenceFromPianoRoll(previousActiveChannels) {
            if (previousActiveChannels === undefined) previousActiveChannels = null;
            if (!this.modal.pianoRoll || !this.modal.pianoRoll.sequence) return;

            const currentSequence = this.modal.pianoRoll.sequence;
            const visibleChannels = previousActiveChannels || this.modal.activeChannels;
            const invisibleNotes = this.modal.fullSequence.filter(note => !visibleChannels.has(note.c));
            const visibleNotes = currentSequence.map(note => ({
                t: note.t, g: note.g, n: note.n,
                c: note.c !== undefined ? note.c : Array.from(visibleChannels)[0] || 0,
                v: note.v || 100
            }));

            this.modal.fullSequence = [...invisibleNotes, ...visibleNotes];
            this.modal.fullSequence.sort((a, b) => a.t - b.t);

            this.modal.log('debug', `Synced fullSequence: ${invisibleNotes.length} invisible + ${visibleNotes.length} visible = ${this.modal.fullSequence.length} total (using ${previousActiveChannels ? 'previous' : 'current'} active channels)`);

            if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.activeChannels.size === 1) {
                const activeChannel = Array.from(this.modal.activeChannels)[0];
                const channelNotes = visibleNotes.filter(n => n.c === activeChannel);
                this.modal.tablatureEditor.onMidiNotesChanged(channelNotes);
            }

            if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
                const drumChannel = this.modal.drumPatternEditor.channel;
                const drumNotes = visibleNotes.filter(n => n.c === drumChannel);
                this.modal.drumPatternEditor.onMidiNotesChanged(drumNotes);
            }

            if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
                const windChannel = this.modal.windInstrumentEditor.channel;
                const windNotes = visibleNotes.filter(n => n.c === windChannel);
                this.modal.windInstrumentEditor.onMidiNotesChanged(windNotes);
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorSequence = MidiEditorSequence;
    }
})();
