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

(function() {
    'use strict';

    // Feedback note durations by GM family (in seconds), used when the caller
    // cannot supply a real note-off (button click, scrubbing animation).
    // Strings/basses/pads need a long enough tail to engage the SF2 sample loop;
    // 0.3 s used to cut violins and made basses inaudible.
    // For channel 9 (drums) MidiSynthesizer.drumMinDurations already enforces
    // per-note minimums, so the constant here is a floor only.
    const FEEDBACK_DURATION_BY_FAMILY = [
        1.0, // 0-7   Piano
        0.8, // 8-15  Chromatic Percussion
        1.2, // 16-23 Organ
        1.2, // 24-31 Guitar
        1.5, // 32-39 Bass
        2.0, // 40-47 Strings
        2.0, // 48-55 Ensemble
        1.5, // 56-63 Brass
        1.5, // 64-71 Reed
        1.5, // 72-79 Pipe
        1.2, // 80-87 Synth Lead
        2.5, // 88-95 Synth Pad
        2.0, // 96-103 Synth FX
        1.2, // 104-111 Ethnic
        0.5, // 112-119 Percussive
        1.0  // 120-127 SFX
    ];
    const HELD_NOTE_SAFETY_MS = 8000; // hard cap so a stuck pointer never sustains forever
    const HELD_NOTE_DURATION_S = 9999; // "play until cancel()" sentinel for MidiSynthesizer.playNote

    class MidiEditorPlayback {
    constructor(modal) {
        this.modal = modal;
        // key = `${channel}:${note}` -> { envelopes, timeoutId }
        this._heldEnvelopes = new Map();
        // Sub-feature: playback transport (audit §1.3).
        this.transport = typeof MidiEditorTransport !== 'undefined'
            ? new MidiEditorTransport(this)
            : null;
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
        if (!m.synthesizer || !m.pianoRollRenderer?.isMounted()) return;

        const { start: markstart, end: markendRaw } = m.pianoRollRenderer.getMarkers();
        let markend = markendRaw;

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
    // PLAY / PAUSE / STOP (delegates to transport sub-feature, audit §1.3)
    // ========================================================================
    async playbackPlay()         { return this.transport?.playbackPlay(); }
    playbackPause()              { return this.transport?.playbackPause(); }
    playbackStop()               { return this.transport?.playbackStop(); }
    togglePlayback()             { return this.transport?.togglePlayback(); }
    updatePlaybackCursor(tick)   { return this.transport?.updatePlaybackCursor(tick); }
    onPlaybackComplete()         { return this.transport?.onPlaybackComplete(); }
    updatePlaybackButtons()      { return this.transport?.updatePlaybackButtons(); }

    // ========================================================================
    // NOTE FEEDBACK
    // ========================================================================

    /**
     * Gerer le feedback audio lors de changements de notes
     */
    handleNoteFeedback(previousSequence) {
        const m = this.modal;
        const currentSequence = m.pianoRollRenderer?.getSequence();
        if (!currentSequence) return;

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
     * Get a sensible fallback duration for a one-shot feedback note based on
     * the channel's current GM program family. Used when the caller cannot
     * provide a real note-off (button clicks, scrubbing).
     */
    getFeedbackDuration(channel) {
        const m = this.modal;
        if (channel === 9) return 0.3; // drumMinDurations in MidiSynthesizer takes over per note
        const program = (m.synthesizer && m.synthesizer.channelInstruments[channel]) || 0;
        return FEEDBACK_DURATION_BY_FAMILY[(program >>> 3) & 0x0f];
    }

    /**
     * Prepare the synthesizer + channel instrument for a feedback note.
     * Returns true if the note can be played; false otherwise (synth missing,
     * out of routed range, etc.).
     */
    async _prepareForFeedback(noteNumber, channel) {
        const m = this.modal;
        if (!m.synthesizer) {
            await this.initSynthesizer();
        }
        if (!m.synthesizer || !m.synthesizer.isInitialized) return false;

        if (m.synthesizer.audioContext && m.synthesizer.audioContext.state === 'suspended') {
            await m.synthesizer.audioContext.resume();
        }

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

        if (m.previewSource === 'routed' && m._routedPlayableNotes.has(channel)) {
            const playable = m._routedPlayableNotes.get(channel);
            if (playable !== null && !playable.has(noteNumber)) return false;
        }
        return true;
    }

    /**
     * Jouer une note courte comme feedback audio (fire-and-forget).
     * Use playNoteHold/releaseNote instead when the trigger is a pointer
     * the user holds, so the note can sustain naturally.
     */
    async playNoteFeedback(noteNumber, velocity = 100, channel = 0) {
        const m = this.modal;
        try {
            const ready = await this._prepareForFeedback(noteNumber, channel);
            if (!ready) return;
            const duration = this.getFeedbackDuration(channel);
            m.synthesizer.playNote(noteNumber, velocity, channel, duration);
        } catch (err) {
            m.log('warn', 'playNoteFeedback error:', err.message);
        }
    }

    /**
     * Start a held note (pointerdown). The note rings until releaseNote()
     * is called for the same (channel, noteNumber) pair, or until the
     * safety timeout fires (HELD_NOTE_SAFETY_MS).
     */
    async playNoteHold(noteNumber, velocity = 100, channel = 0) {
        const m = this.modal;
        try {
            const ready = await this._prepareForFeedback(noteNumber, channel);
            if (!ready) return;

            const key = `${channel}:${noteNumber}`;
            // If the same key is already held (re-entrant pointerdown), release first.
            this.releaseNote(noteNumber, channel);

            const envelopes = m.synthesizer.playNote(noteNumber, velocity, channel, HELD_NOTE_DURATION_S);
            if (!envelopes) return;

            const timeoutId = setTimeout(() => {
                this.releaseNote(noteNumber, channel);
            }, HELD_NOTE_SAFETY_MS);

            this._heldEnvelopes.set(key, { envelopes, timeoutId });
        } catch (err) {
            m.log('warn', 'playNoteHold error:', err.message);
        }
    }

    /**
     * Stop a held note. Safe to call multiple times.
     */
    releaseNote(noteNumber, channel = 0) {
        const key = `${channel}:${noteNumber}`;
        const entry = this._heldEnvelopes.get(key);
        if (!entry) return;
        this._heldEnvelopes.delete(key);
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        for (const env of entry.envelopes) {
            try { env?.cancel?.(); } catch (_) { /* ignore */ }
        }
    }

    /**
     * Cancel every held note. Called on dispose / modal close / blur.
     */
    releaseAllNotes() {
        if (!this._heldEnvelopes.size) return;
        for (const entry of this._heldEnvelopes.values()) {
            if (entry.timeoutId) clearTimeout(entry.timeoutId);
            for (const env of entry.envelopes) {
                try { env?.cancel?.(); } catch (_) { /* ignore */ }
            }
        }
        this._heldEnvelopes.clear();
    }

    // ========================================================================
    // DISPOSE
    // ========================================================================

    /**
     * Nettoyer le synthetiseur
     */
    disposeSynthesizer() {
        const m = this.modal;
        this.releaseAllNotes();
        if (m.synthesizer) {
            m.synthesizer.dispose();
            m.synthesizer = null;
        }
        m.isPlaying = false;
        m.isPaused = false;
        // Cancel any pending playback-cursor rAF scheduled by the transport
        // sub-feature so a tick queued by the (now-disposed) synthesizer
        // doesn't wake up one frame later to paint stale state (audit §6.4).
        if (this.transport?._cursorRafId) {
            cancelAnimationFrame(this.transport._cursorRafId);
            this.transport._cursorRafId = 0;
            this.transport._pendingTick = null;
        }
    }
}

    if (typeof window !== 'undefined') {
        window.MidiEditorPlayback = MidiEditorPlayback;
    }
})();
