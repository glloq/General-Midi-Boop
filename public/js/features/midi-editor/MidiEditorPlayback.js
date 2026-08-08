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

(function () {
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
    1.0 // 120-127 SFX
  ];
  const HELD_NOTE_SAFETY_MS = 8000; // hard cap so a stuck pointer never sustains forever
  const HELD_NOTE_DURATION_S = 9999; // "play until cancel()" sentinel for MidiSynthesizer.playNote

  // Count only the EDITOR's own outstanding indicator refs. The global
  // SoundBankLoadingIndicator is a shared refcount used by other features too,
  // so teardown must unwind only what the editor still holds — never drain the
  // global to 0, which would hide another feature's in-progress spinner
  // (audit D N1). withLoadingIndicator keeps this balanced via try/finally;
  // the counter is the safety net for disposeSynthesizer.
  let editorIndicatorRefs = 0;

  /**
   * Run an async loader while the global SoundBank loading indicator is
   * shown, guaranteeing `end()` even if the loader throws.
   */
  async function withLoadingIndicator(loader) {
    const hasIndicator = typeof SoundBankLoadingIndicator !== 'undefined';
    if (hasIndicator) {
      SoundBankLoadingIndicator.begin();
      editorIndicatorRefs++;
    }
    try {
      await loader();
    } finally {
      if (hasIndicator) {
        SoundBankLoadingIndicator.end();
        editorIndicatorRefs = Math.max(0, editorIndicatorRefs - 1);
      }
    }
  }

  /** Cancel every envelope in a held-note entry and clear its safety timeout. */
  function cancelHeldEntry(entry) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    for (const env of entry.envelopes) {
      try {
        env?.cancel?.();
      } catch (_) {
        /* ignore */
      }
    }
  }

  class MidiEditorPlayback {
    constructor(modal) {
      this.modal = modal;
      // key = `${channel}:${note}` -> { envelopes, timeoutId }
      this._heldEnvelopes = new Map();
      // Sub-feature: playback transport (audit §1.3).
      this.transport =
        typeof MidiEditorTransport !== 'undefined' ? new MidiEditorTransport(this) : null;
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

    /**
     * Pre-warm the synthesizer + soundbank in the background so the first
     * note feedback (click / drag / piano key) is instant instead of
     * blocking the user gesture on the SF2 fetch + decode (audit P1.1).
     * Fire-and-forget, idempotent. Does NOT resume the AudioContext —
     * that requires a user gesture and stays in _prepareForFeedback.
     */
    warmUpSynth() {
      const m = this.modal;
      // The modal was torn down before this idle callback ran — `container`
      // is nulled by MidiEditorLifecycle on close and only ever set (by
      // routingOps.render) before initPianoRoll schedules this. Skip so we
      // don't resurrect an AudioContext for a closed editor.
      if (!m.container) return Promise.resolve();
      if (this._warmupPromise) return this._warmupPromise;
      if (this._feedbackInstrumentsLoaded) return Promise.resolve();
      this._warmupPromise = (async () => {
        try {
          if (!m.synthesizer) await this.initSynthesizer();
          if (!m.synthesizer || !m.synthesizer.isInitialized) return;
          if (this._feedbackInstrumentsLoaded) return;
          this.loadSequenceForPlayback();
          await withLoadingIndicator(() => m.synthesizer.preloadInstruments());
          this._feedbackInstrumentsLoaded = true;
        } catch (err) {
          m.log('warn', 'warmUpSynth error:', err.message);
        }
      })();
      return this._warmupPromise;
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
        sequence = sequence.filter((note) => {
          const playable = m._routedPlayableNotes.get(note.c);
          // undefined (no entry) or null (all notes allowed) → keep.
          return playable == null || playable.has(note.n);
        });
      }

      m.synthesizer.loadSequence(sequence, tempo, ticksPerBeat);

      // Audit §4.2: read effective program via channelState — handles the
      // previewSource=='routed' + routed-gm-cache fallback in one call.
      m.channels.forEach((ch) => {
        const program = m.channelState
          ? m.channelState.getEffectiveProgram(ch.channel)
          : m.previewSource === 'routed' && m._routedGmPrograms.get(ch.channel) != null
            ? m._routedGmPrograms.get(ch.channel)
            : ch.program || 0;
        const sf2Id = m.channelState
          ? m.channelState.getEffectiveSf2Id(ch.channel)
          : m.previewSource === 'routed'
            ? (m._routedSf2Ids?.get(ch.channel) ?? null)
            : null;
        m.synthesizer.setChannelInstrument(ch.channel, program, sf2Id);
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

      // Audit §4.2: route reads through `channelState` so the "muted"
      // computation has one canonical source of truth. `isAudible`
      // combines active+!disabled in a single call.
      const cs = m.channelState;
      // When previewing routed instruments, mute channels that have no
      // routing target — otherwise they'd play through the default GM
      // synth and confuse the user about what they'll actually hear on
      // their physical setup.
      const routedPreview = m.previewSource === 'routed';
      m.channels.forEach((ch) => {
        if (tabSolo) {
          // In tablature mode, mute everything except the tablature channel
          if (ch.channel !== tabChannel) {
            mutedChannels.push(ch.channel);
          }
        } else if (
          cs
            ? !cs.isAudible(ch.channel)
            : !m.activeChannels.has(ch.channel) || m.channelDisabled.has(ch.channel)
        ) {
          mutedChannels.push(ch.channel);
        } else if (
          routedPreview &&
          !(cs ? cs.hasRouting(ch.channel) : m.channelRouting?.has(ch.channel))
        ) {
          mutedChannels.push(ch.channel);
        }
      });

      m.synthesizer.setMutedChannels(mutedChannels);
      m.log(
        'debug',
        `Muted channels: ${mutedChannels.map((c) => c + 1).join(', ') || 'none'}${tabSolo ? ' (tablature solo)' : ''}${routedPreview ? ' (routed preview)' : ''}`
      );
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

      sequence.forEach((note) => {
        const endTick = note.t + note.g;
        if (endTick > maxTick) maxTick = endTick;
      });

      return maxTick;
    }

    // ========================================================================
    // PLAY / PAUSE / STOP (delegates to transport sub-feature, audit §1.3)
    // ========================================================================
    async playbackPlay() {
      return this.transport?.playbackPlay();
    }
    playbackPause() {
      return this.transport?.playbackPause();
    }
    playbackStop() {
      return this.transport?.playbackStop();
    }
    togglePlayback() {
      return this.transport?.togglePlayback();
    }
    updatePlaybackCursor(tick) {
      return this.transport?.updatePlaybackCursor(tick);
    }
    onPlaybackComplete() {
      return this.transport?.onPlaybackComplete();
    }
    updatePlaybackButtons() {
      return this.transport?.updatePlaybackButtons();
    }

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

      const notesToPlay = [];
      currentSequence.forEach((note, index) => {
        const key = `${note.t}_${note.c}_${index}`;
        const prevNote = previousMap.get(key);

        if (!prevNote || prevNote.n !== note.n) {
          notesToPlay.push(note);
        }
      });

      if (notesToPlay.length > 0 && notesToPlay.length <= 5) {
        notesToPlay.forEach((note) => {
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

      // If a background warm-up (audit P1.1) is in flight, join it instead
      // of kicking off a second preload of the same soundbank.
      if (this._warmupPromise) {
        try {
          await this._warmupPromise;
        } catch (_) {
          /* fall through to lazy load */
        }
      }

      if (!this._feedbackInstrumentsLoaded) {
        this.loadSequenceForPlayback();
        await withLoadingIndicator(() => m.synthesizer.preloadInstruments());
        this._feedbackInstrumentsLoaded = true;
      }

      if (channel === 9) {
        if (m.synthesizer.drumPresets.size === 0) {
          await withLoadingIndicator(() => m.synthesizer.loadDrumKit());
        }
      } else {
        const program = m.synthesizer.channelInstruments[channel] || 0;
        const bankId =
          typeof m.synthesizer._bankForChannel === 'function'
            ? m.synthesizer._bankForChannel(channel)
            : m.synthesizer.currentBankId;
        const cacheKey =
          typeof m.synthesizer._instKey === 'function'
            ? m.synthesizer._instKey(bankId, program)
            : program;
        if (!m.synthesizer.loadedInstruments.has(cacheKey)) {
          await withLoadingIndicator(() => m.synthesizer.loadInstrument(program, bankId));
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

        const envelopes = m.synthesizer.playNote(
          noteNumber,
          velocity,
          channel,
          HELD_NOTE_DURATION_S
        );
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
      cancelHeldEntry(entry);
    }

    /**
     * Cancel every held note. Called on dispose / modal close / blur.
     */
    releaseAllNotes() {
      if (!this._heldEnvelopes.size) return;
      for (const entry of this._heldEnvelopes.values()) {
        cancelHeldEntry(entry);
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
        // Halt scheduler + envelopes before tearing down audio nodes so a
        // preview that was actively playing doesn't keep ringing while the
        // modal closes.
        try {
          m.synthesizer.stop();
        } catch (_) {
          /* best-effort */
        }
        m.synthesizer.dispose();
        m.synthesizer = null;
      }
      m.isPlaying = false;
      m.isPaused = false;
      // Reset per-session warm-up flags so the loading indicator re-runs
      // when the next file is opened (the synth was disposed above, so the
      // cached instruments no longer exist).
      this._feedbackInstrumentsLoaded = false;
      this._warmupPromise = null;
      // Unwind ONLY the editor's own outstanding indicator refs — never drain
      // the shared global counter to 0, which would hide another feature's
      // in-progress spinner (audit D N1). end() floors the global count at 0, so
      // a race with an in-flight loader's finally is harmless.
      if (typeof SoundBankLoadingIndicator !== 'undefined') {
        try {
          while (editorIndicatorRefs > 0) {
            SoundBankLoadingIndicator.end();
            editorIndicatorRefs--;
          }
        } catch (_) {
          /* best-effort */
        }
      }
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
