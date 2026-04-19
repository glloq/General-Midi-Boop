// ============================================================================
// File: public/js/features/midi-editor/MidiEditorPlayback.js
// Description: Playback/Synthesizer management for the MIDI Editor
//   - loadSequenceForPlayback()
//   - togglePlayback(), playbackPause(), playbackStop()
//   - updatePlaybackCursor(), onPlaybackComplete()
//   - updatePlaybackButtons(), updatePlaybackRange()
//   - syncMutedChannels()
//   - disposeSynthesizer()
//   - getSequenceEndTick()
//   - MidiSynthesizer integration
// ============================================================================

class MidiEditorPlayback {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // SYNTHESIZER INIT
    // ========================================================================

    /**
     * Initialiser le synthetiseur
     */
    async initSynthesizer() {
        const m = this.modal;
        if (m.synthesizer) {
            // Sync the sound bank with the current setting
            if (m.synthesizer.setSoundBank) {
                const savedBank = MidiSynthesizer.getSavedBank();
                m.synthesizer.setSoundBank(savedBank);
            }
            return true;
        }

        try {
            if (typeof MidiSynthesizer === 'undefined') {
                m.log('error', 'MidiSynthesizer class not found. Please include MidiSynthesizer.js');
                return false;
            }

            m.synthesizer = new MidiSynthesizer();
            const initialized = await m.synthesizer.initialize();

            if (initialized) {
                m.synthesizer.onTickUpdate = (tick) => this.updatePlaybackCursor(tick);
                m.synthesizer.onPlaybackEnd = () => this.onPlaybackComplete();

                m.log('info', 'Synthesizer initialized successfully');
                return true;
            } else {
                m.log('error', 'Failed to initialize synthesizer');
                return false;
            }
        } catch (error) {
            m.log('error', 'Error initializing synthesizer:', error);
            return false;
        }
    }

    // ========================================================================
    // LOAD SEQUENCE
    // ========================================================================

    /**
     * Charger la sequence dans le synthetiseur
     */
    loadSequenceForPlayback() {
        const m = this.modal;
        if (!m.synthesizer) return;

        let sequence = m.fullSequence.length > 0 ? m.fullSequence : m.sequence;
        const tempo = m.tempo || 120;
        const ticksPerBeat = m.ticksPerBeat || 480;

        // Filter out non-playable notes when using routed instruments
        if (m.previewSource === 'routed' && m._routedPlayableNotes.size > 0) {
            sequence = sequence.filter(note => {
                const playable = m._routedPlayableNotes.get(note.c);
                if (playable === undefined) return true;
                if (playable === null) return true;
                return playable.has(note.n);
            });
        }

        m.synthesizer.loadSequence(sequence, tempo, ticksPerBeat);

        m.channels.forEach(ch => {
            let program = ch.program || 0;
            if (m.previewSource === 'routed') {
                const routedGm = m._routedGmPrograms.get(ch.channel);
                if (routedGm != null) program = routedGm;
            }
            m.synthesizer.setChannelInstrument(ch.channel, program);
        });

        this.syncMutedChannels();
        this.updatePlaybackRange();
    }

    // ========================================================================
    // MUTED CHANNELS
    // ========================================================================

    /**
     * Synchroniser les canaux mutes avec le synthetiseur.
     * When tablature is visible, only the tablature channel is audible.
     */
    syncMutedChannels() {
        const m = this.modal;
        if (!m.synthesizer) return;

        const mutedChannels = [];

        // If tablature is open, solo the tablature channel
        const tabSolo = m.tablatureEditor && m.tablatureEditor.isVisible;
        const tabChannel = tabSolo ? m.tablatureEditor.channel : -1;

        m.channels.forEach(ch => {
            if (tabSolo) {
                // In tablature mode, mute everything except the tablature channel
                if (ch.channel !== tabChannel) {
                    mutedChannels.push(ch.channel);
                }
            } else {
                // Normal mode: mute inactive channels or disabled channels
                if (!m.activeChannels.has(ch.channel) || m.channelDisabled.has(ch.channel)) {
                    mutedChannels.push(ch.channel);
                }
            }
        });

        m.synthesizer.setMutedChannels(mutedChannels);
        m.log('debug', `Muted channels: ${mutedChannels.map(c => c + 1).join(', ') || 'none'}${tabSolo ? ' (tablature solo)' : ''}`);
    }

    // ========================================================================
    // PLAYBACK RANGE
    // ========================================================================

    /**
     * Mettre a jour la plage de lecture depuis les marqueurs du piano roll
     */
    updatePlaybackRange() {
        const m = this.modal;
        if (!m.synthesizer || !m.pianoRoll) return;

        const markstart = m.pianoRoll.markstart || 0;
        let markend = m.pianoRoll.markend;

        if (markend === undefined || markend < 0) {
            markend = m.midiData?.maxTick || this.getSequenceEndTick();
        }

        m.playbackStartTick = markstart;
        m.playbackEndTick = markend;

        m.synthesizer.setPlaybackRange(m.playbackStartTick, m.playbackEndTick);

        m.log('debug', `Playback range: ${m.playbackStartTick} - ${m.playbackEndTick} ticks`);
    }

    /**
     * Obtenir le tick de fin de la sequence
     */
    getSequenceEndTick() {
        const m = this.modal;
        let maxTick = 0;
        const sequence = m.fullSequence.length > 0 ? m.fullSequence : m.sequence;

        sequence.forEach(note => {
            const endTick = note.t + note.g;
            if (endTick > maxTick) maxTick = endTick;
        });

        return maxTick;
    }

    // ========================================================================
    // PLAY / PAUSE / STOP
    // ========================================================================

    /**
     * Demarrer ou reprendre la lecture
     */
    async playbackPlay() {
        const m = this.modal;

        if (!m.synthesizer) {
            const initialized = await this.initSynthesizer();
            if (!initialized) {
                m.showNotification(m.t('midiEditor.synthInitError'), 'error');
                return;
            }
        }

        if (!m.isPlaying && !m.isPaused) {
            this.loadSequenceForPlayback();

            // Determine start position: use cursor if within range, otherwise range start
            const cursorTick = m.pianoRoll ? (m.pianoRoll.cursor || 0) : 0;
            const rangeStart = m.synthesizer.startTick || 0;
            const rangeEnd = m.synthesizer.endTick || 0;
            const startAt = (cursorTick >= rangeStart && cursorTick <= rangeEnd && cursorTick > 0)
                ? cursorTick : rangeStart;

            // seek() positions schedulePointer via binary search so scheduleNotes()
            // won't re-fire every note from t=0 through the cursor (which, on large
            // files, scheduled thousands of notes in the past and froze the tab).
            m.synthesizer.seek(startAt);
            m.synthesizer.isPaused = true; // Trick: play() will resume from currentTick
        } else if (m.isPaused) {
            // Resume from current cursor position
            if (m.pianoRoll) {
                const cursorTick = m.pianoRoll.cursor || 0;
                m.synthesizer.seek(cursorTick);
            }
        }

        await m.synthesizer.play();

        m.isPlaying = true;
        m.isPaused = false;

        this.updatePlaybackButtons();

        m.log('info', 'Playback started');
    }

    /**
     * Mettre en pause la lecture
     */
    playbackPause() {
        const m = this.modal;
        if (!m.synthesizer || !m.isPlaying) return;

        m.synthesizer.pause();

        m.isPlaying = false;
        m.isPaused = true;

        this.updatePlaybackButtons();

        m.log('info', 'Playback paused');
    }

    /**
     * Arreter la lecture
     */
    playbackStop() {
        const m = this.modal;
        if (!m.synthesizer) return;

        m.synthesizer.stop();

        m.isPlaying = false;
        m.isPaused = false;

        const resetTick = m.playbackStartTick || 0;

        if (m.pianoRoll) {
            m.pianoRoll.cursor = resetTick;
        }

        // Reset PlaybackTimelineBar playhead so the red triangle returns to start
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(resetTick);
            if (m.pianoRoll) {
                m.timelineBar.setScrollX(m.pianoRoll.xoffset || 0);
            }
        }

        // Reset tablature playhead and clear fretboard positions
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(resetTick);
            if (m.tablatureEditor.fretboard) {
                m.tablatureEditor.fretboard.clearActivePositions();
            }
        }

        // Reset drum pattern playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(resetTick);
        }

        // Reset wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(resetTick);
        }

        this.updatePlaybackButtons();

        m.log('info', 'Playback stopped');
    }

    /**
     * Basculer entre play et pause
     */
    togglePlayback() {
        const m = this.modal;
        if (m.isPlaying) {
            this.playbackPause();
        } else {
            this.playbackPlay();
        }
    }

    // ========================================================================
    // PLAYBACK CURSOR
    // ========================================================================

    /**
     * Mettre a jour le curseur pendant la lecture
     * @param {number} tick - Position actuelle en ticks
     */
    updatePlaybackCursor(tick) {
        const m = this.modal;

        // Update piano roll cursor (even when hidden, keeps state consistent)
        if (m.pianoRoll) {
            m.pianoRoll.cursor = tick;

            const xoffset = m.pianoRoll.xoffset || 0;
            const xrange = m.pianoRoll.xrange || 1920;

            if (tick > xoffset + xrange * 0.9) {
                m.pianoRoll.xoffset = tick - xrange * 0.2;
            } else if (tick < xoffset) {
                m.pianoRoll.xoffset = Math.max(0, tick - xrange * 0.1);
            }
        }

        // Update PlaybackTimelineBar
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(tick);
            if (m.pianoRoll) {
                m.timelineBar.setScrollX(m.pianoRoll.xoffset || 0);
            }
        }

        // Update tablature editor playhead, fretboard, and auto-scroll
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(tick);

            // Sync navigation overview bar with tablature scroll position
            if (m.navigationBar && m.tablatureEditor.renderer) {
                const maxTick = m.midiData?.maxTick || 0;
                const renderer = m.tablatureEditor.renderer;
                const canvasWidth = m.tablatureEditor.tabCanvasEl?.width || 800;
                const visibleTicks = (canvasWidth - renderer.headerWidth) * renderer.ticksPerPixel;
                m.navigationBar.setViewport(renderer.scrollX, visibleTicks, maxTick);
            }
        }

        // Update drum pattern editor playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(tick);
        }

        // Update wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(tick);
        }
    }

    /**
     * Callback quand la lecture est terminee
     */
    onPlaybackComplete() {
        const m = this.modal;
        m.isPlaying = false;
        m.isPaused = false;

        if (m.pianoRoll) {
            m.pianoRoll.cursor = m.playbackStartTick;
        }

        const resetTick = m.playbackStartTick || 0;

        // Reset timeline bar
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(resetTick);
            if (m.pianoRoll) {
                m.timelineBar.setScrollX(m.pianoRoll.xoffset || 0);
            }
        }

        // Reset tablature playhead and clear fretboard positions
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(resetTick);
            if (m.tablatureEditor.fretboard) {
                m.tablatureEditor.fretboard.clearActivePositions();
            }
        }

        // Reset drum pattern playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(resetTick);
        }

        // Reset wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(resetTick);
        }

        this.updatePlaybackButtons();

        m.log('info', 'Playback complete');
    }

    // ========================================================================
    // PLAYBACK BUTTONS
    // ========================================================================

    /**
     * Mettre a jour les boutons de playback
     */
    updatePlaybackButtons() {
        const m = this.modal;
        const playBtn = document.getElementById('play-btn');
        const pauseBtn = document.getElementById('pause-btn');
        const stopBtn = document.getElementById('stop-btn');

        if (m.isPlaying) {
            if (playBtn) playBtn.style.display = 'none';
            if (pauseBtn) pauseBtn.style.display = '';
            if (stopBtn) stopBtn.disabled = false;
        } else if (m.isPaused) {
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = false;
        } else {
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = true;
        }
    }

    // ========================================================================
    // NOTE FEEDBACK
    // ========================================================================

    /**
     * Gerer le feedback audio lors de changements de notes
     */
    handleNoteFeedback(previousSequence) {
        const m = this.modal;
        if (!m.pianoRoll || !m.pianoRoll.sequence) return;

        const currentSequence = m.pianoRoll.sequence;

        const previousMap = new Map();
        previousSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            previousMap.set(key, note);
        });

        const currentMap = new Map();
        currentSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            currentMap.set(key, note);
        });

        const notesToPlay = [];
        currentSequence.forEach((note, index) => {
            const key = `${note.t}_${note.c}_${index}`;
            const prevNote = previousMap.get(key);

            if (!prevNote || prevNote.n !== note.n) {
                notesToPlay.push(note);
            }
        });

        if (notesToPlay.length > 0 && notesToPlay.length <= 5) {
            notesToPlay.forEach(note => {
                this.playNoteFeedback(note.n, note.v || 100, note.c || 0);
            });
        }
    }

    /**
     * Jouer une note courte comme feedback audio
     */
    async playNoteFeedback(noteNumber, velocity = 100, channel = 0) {
        const m = this.modal;
        try {
            if (!m.synthesizer) {
                await this.initSynthesizer();
            }

            if (!m.synthesizer || !m.synthesizer.isInitialized) {
                return;
            }

            // Resume audio context if suspended (browser autoplay policy)
            if (m.synthesizer.audioContext && m.synthesizer.audioContext.state === 'suspended') {
                await m.synthesizer.audioContext.resume();
            }

            // Ensure instruments are loaded for playback feedback
            if (!this._feedbackInstrumentsLoaded) {
                this.loadSequenceForPlayback();
                if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.begin();
                try {
                    await m.synthesizer.preloadInstruments();
                } finally {
                    if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.end();
                }
                this._feedbackInstrumentsLoaded = true;
            }

            // Ensure the specific channel instrument is loaded
            if (channel === 9) {
                if (m.synthesizer.drumPresets.size === 0) {
                    if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.begin();
                    try {
                        await m.synthesizer.loadDrumKit();
                    } finally {
                        if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.end();
                    }
                }
            } else {
                const program = m.synthesizer.channelInstruments[channel] || 0;
                if (!m.synthesizer.loadedInstruments.has(program)) {
                    if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.begin();
                    try {
                        await m.synthesizer.loadInstrument(program);
                    } finally {
                        if (typeof SoundBankLoadingIndicator !== 'undefined') SoundBankLoadingIndicator.end();
                    }
                }
            }

            // Skip notes outside the routed instrument's playable range
            if (m.previewSource === 'routed' && m._routedPlayableNotes.has(channel)) {
                const playable = m._routedPlayableNotes.get(channel);
                if (playable !== null && !playable.has(noteNumber)) {
                    return;
                }
            }

            const duration = 0.3;
            m.synthesizer.playNote(noteNumber, velocity, channel, duration);
        } catch (err) {
            m.log('warn', 'playNoteFeedback error:', err.message);
        }
    }

    // ========================================================================
    // DISPOSE
    // ========================================================================

    /**
     * Nettoyer le synthetiseur
     */
    disposeSynthesizer() {
        const m = this.modal;
        if (m.synthesizer) {
            m.synthesizer.dispose();
            m.synthesizer = null;
        }
        m.isPlaying = false;
        m.isPaused = false;
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorPlayback;
}

if (typeof window !== 'undefined') {
    window.MidiEditorPlayback = MidiEditorPlayback;
}
