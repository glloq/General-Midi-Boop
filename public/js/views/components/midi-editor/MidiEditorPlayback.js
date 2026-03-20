// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorPlayback.js
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

        const sequence = m.fullSequence.length > 0 ? m.fullSequence : m.sequence;
        const tempo = m.tempo || 120;
        const ticksPerBeat = m.ticksPerBeat || 480;

        m.synthesizer.loadSequence(sequence, tempo, ticksPerBeat);

        m.channels.forEach(ch => {
            m.synthesizer.setChannelInstrument(ch.channel, ch.program || 0);
        });

        this.syncMutedChannels();
        this.updatePlaybackRange();
    }

    // ========================================================================
    // MUTED CHANNELS
    // ========================================================================

    /**
     * Synchroniser les canaux mutes avec le synthetiseur
     */
    syncMutedChannels() {
        const m = this.modal;
        if (!m.synthesizer) return;

        const mutedChannels = [];
        m.channels.forEach(ch => {
            if (!m.activeChannels.has(ch.channel)) {
                mutedChannels.push(ch.channel);
            }
        });

        m.synthesizer.setMutedChannels(mutedChannels);
        m.log('debug', `Muted channels: ${mutedChannels.map(c => c + 1).join(', ') || 'none'}`);
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

            if (m.pianoRoll && m.pianoRoll.cursor > 0) {
                m.synthesizer.seek(m.pianoRoll.cursor);
            }
        } else if (m.isPaused) {
            if (m.pianoRoll) {
                m.synthesizer.seek(m.pianoRoll.cursor);
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

        if (m.pianoRoll) {
            m.pianoRoll.cursor = m.playbackStartTick;
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
        if (!m.pianoRoll) return;

        m.pianoRoll.cursor = tick;

        const xoffset = m.pianoRoll.xoffset || 0;
        const xrange = m.pianoRoll.xrange || 1920;

        if (tick > xoffset + xrange * 0.9) {
            m.pianoRoll.xoffset = tick - xrange * 0.2;
        } else if (tick < xoffset) {
            m.pianoRoll.xoffset = Math.max(0, tick - xrange * 0.1);
        }

        // Update tablature editor playhead and fretboard
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(tick);
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
        if (!m.synthesizer) {
            await this.initSynthesizer();
        }

        if (!m.synthesizer || !m.synthesizer.isInitialized) {
            return;
        }

        const duration = 0.1;
        m.synthesizer.playNote(noteNumber, velocity, channel, duration);
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
