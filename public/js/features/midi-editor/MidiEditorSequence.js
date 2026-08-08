// ============================================================================
// File: public/js/features/midi-editor/MidiEditorSequence.js
// Description: MIDI sequence management (conversion, sync, channels).
//   Sub-component class ; called via `modal.sequenceOps.<method>(...)`.
//   (P2-F.10i body rewrite — no longer a prototype mixin.)
// ============================================================================

(function () {
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

      // Tempo + tempo-map are extracted inline in the single track/event
      // walk below — the separate full pre-pass over every event was
      // redundant (audit P2.3). `tempo`/`tempoEvents` finalised after.
      let tempo = 120;
      this.modal.tempoEvents = [];

      const channelInstruments = new Map();
      const channelNoteCount = new Map();
      const allNotes = [];

      this.modal.midiData.tracks.forEach((track, trackIndex) => {
        if (!track.events) {
          this.modal.log('debug', `Track ${trackIndex}: no events`);
          return;
        }

        this.modal.log(
          'debug',
          `Track ${trackIndex} (${track.name || 'unnamed'}): ${track.events.length} events`
        );

        const activeNotes = new Map();
        let currentTick = 0;
        let noteOnCount = 0;
        let noteOffCount = 0;

        track.events.forEach((event, _eventIndex) => {
          currentTick += event.deltaTime || 0;

          if (event.type === 'setTempo' && event.microsecondsPerBeat) {
            const bpm = Math.round(60000000 / event.microsecondsPerBeat);
            if (this.modal.tempoEvents.length === 0) tempo = bpm;
            this.modal.tempoEvents.push({
              ticks: currentTick,
              tempo: bpm,
              // Keep the exact source µs/beat so an untouched tempo is written
              // back verbatim instead of round-tripping through integer BPM,
              // which drifts fractional-BPM files on every save (audit D MD1).
              microsecondsPerBeat: event.microsecondsPerBeat,
              id: `tempo_${currentTick}_${this.modal.tempoEvents.length}`
            });
          }

          if (event.type === 'programChange') {
            const channel = event.channel ?? 0;
            const pn = event.programNumber ?? event.program;
            if (pn !== undefined) {
              channelInstruments.set(channel, pn);
              this.modal.log(
                'debug',
                `Channel ${channel}: program ${pn} (${this.modal.getInstrumentName(pn)})`
              );
            }
          }

          if (event.type === 'noteOn' && event.velocity > 0) {
            noteOnCount++;
            const channel = event.channel ?? 0;
            const key = `${channel}_${event.noteNumber}`;

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
              channelNoteCount.set(
                existing.channel,
                (channelNoteCount.get(existing.channel) || 0) + 1
              );
            }

            activeNotes.set(key, {
              tick: currentTick,
              note: event.noteNumber,
              velocity: event.velocity,
              channel: channel
            });

            if (noteOnCount === 1) {
              this.modal.log('debug', `First noteOn in track ${trackIndex}:`, {
                tick: currentTick,
                note: event.noteNumber,
                velocity: event.velocity,
                channel: channel
              });
            }
          } else if (
            event.type === 'noteOff' ||
            (event.type === 'noteOn' && event.velocity === 0)
          ) {
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
          this.modal.log(
            'warn',
            `Track ${trackIndex}: ${activeNotes.size} orphaned notes (no noteOff) recovered`
          );
        }
        activeNotes.clear();

        this.modal.log(
          'debug',
          `Track ${trackIndex} summary: ${noteOnCount} note-ons, ${noteOffCount} note-offs, ${allNotes.length} complete notes`
        );
      });

      this.modal.tempo = tempo;
      if (this.modal.tempoEvents.length > 0) {
        this.modal.log(
          'info',
          `Extracted ${this.modal.tempoEvents.length} tempo events (first: ${tempo} BPM)`
        );
      }
      this.modal.log(
        'info',
        `Converting MIDI: ${this.modal.midiData.tracks.length} tracks, ${ticksPerBeat} ticks/beat, ${tempo} BPM`
      );

      this.modal.fullSequence = allNotes.map((note) => ({
        t: note.tick,
        g: note.gate,
        n: note.note,
        c: note.channel,
        v: note.velocity || 100
      }));

      this.modal.fullSequence.sort((a, b) => a.t - b.t);

      channelNoteCount.forEach((count, channel) => {
        const hasExplicitProgram = channelInstruments.has(channel);
        const programNumber = channelInstruments.get(channel) || 0;
        const instrumentName =
          channel === 9
            ? this.modal.t('midiEditor.drumKit')
            : this.modal.getInstrumentName(programNumber);

        this.modal.channels.push({
          channel: channel,
          program: programNumber,
          instrument: instrumentName,
          noteCount: count,
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
        this.modal.channels.forEach((ch) => this.modal.activeChannels.add(ch.channel));
        this.modal.sequence = this.modal.fullSequence.filter((note) =>
          this.modal.activeChannels.has(note.c)
        );
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

      this.modal.log(
        'info',
        `Toggled channel ${channel}. Active channels: [${Array.from(this.modal.activeChannels).join(', ')}]`
      );

      if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
        this.modal.tablatureEditor.hide();
        this.modal.tablatureOps._updateTabButtonState(false);
      }

      if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
        this.modal.drumPatternEditor.hide();
        this.modal.tablatureOps._updateDrumButtonState(false);
      }

      this.updateSequenceFromActiveChannels(previousActiveChannels);
      this.modal.routingOps.updateChannelButtons();
      this.modal.renderer.updateInstrumentSelector();

      if (this.modal.channelPanel) {
        this.modal.channelPanel.updateTablatureButton();
      }

      this.modal.ccPicker.updateCCEditorChannel();
      this.modal.syncMutedChannels();
      this.modal.tablatureOps._updateChannelDisabledVisual(channel);

      // Sync popover checkbox if open for this channel
      if (this.modal._channelSettingsOpen === channel && this.modal._channelSettingsPopoverEl) {
        const cb = this.modal._channelSettingsPopoverEl.querySelector('.channel-enabled-checkbox');
        if (cb) cb.checked = this.modal.activeChannels.has(channel);
      }

      if (this.modal.channelPlayableHighlights.size > 0) {
        this.modal.tablatureOps._syncPianoRollHighlights();
      }
    }

    updateSequenceFromActiveChannels(previousActiveChannels = null, skipSync = false) {
      if (!skipSync) {
        this.syncFullSequenceFromPianoRoll(previousActiveChannels);
      }

      // Build the modal's filtered view AND the renderer's defensive
      // copy in a single pass (audit P2.1 — was filter + a second .map
      // spread). The copy is still required: the renderer mutates note
      // objects in place during drag, and modal.sequence shares object
      // refs with fullSequence.
      const renderPayload = [];
      if (this.modal.activeChannels.size === 0) {
        this.modal.sequence = [];
      } else {
        const seq = [];
        for (const note of this.modal.fullSequence) {
          if (this.modal.activeChannels.has(note.c)) {
            seq.push(note);
            renderPayload.push({ ...note });
          }
        }
        this.modal.sequence = seq;
      }

      this.modal.log(
        'info',
        `Updated sequence: ${this.modal.sequence.length} notes from ${this.modal.activeChannels.size} active channel(s)`
      );

      const renderer = this.modal.pianoRollRenderer;
      if (renderer?.isMounted()) {
        // Bulk replace via setSequence (audit §1.1 — drops the
        // per-note push loop, prepares for Canvas impl which will
        // benefit from a single spatial-index rebuild).
        renderer.setSequence(renderPayload);
        renderer.setChannelColors(this.modal.channelColors);

        if (this.modal.activeChannels.size > 0) {
          const ch = Array.from(this.modal.activeChannels)[0];
          renderer.setDefaultChannel(ch);
          this.modal.log('debug', `Default channel for new notes: ${ch}`);
        }

        renderer.redraw();
        this.modal.log(
          'debug',
          `Piano roll redrawn after channel toggle: ${this.modal.sequence.length} notes visible`
        );
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

    syncFullSequenceFromPianoRoll(previousActiveChannels = null) {
      const currentSequence = this.modal.pianoRollRenderer?.getSequence();
      if (!currentSequence) return;
      const visibleChannels = previousActiveChannels || this.modal.activeChannels;
      // `invisibleNotes` is a filtered subset of fullSequence, which is
      // kept tick-sorted (convertMidiToSequence sorts; this method
      // re-establishes the invariant on every call; all other writers
      // only `filter`, preserving order). So only `visibleNotes`
      // (rebuilt from the renderer) may be unordered — sort just that
      // subset and linear-merge the two sorted runs. O(n) instead of
      // concat + a full O(n log n) sort on every edit (audit P1.3).
      const invisibleNotes = this.modal.fullSequence.filter((note) => !visibleChannels.has(note.c));
      const fallbackChannel = Array.from(visibleChannels)[0] || 0;
      const visibleNotes = currentSequence.map((note) => ({
        t: note.t,
        g: note.g,
        n: note.n,
        c: note.c !== undefined ? note.c : fallbackChannel,
        v: note.v || 100
      }));
      visibleNotes.sort((a, b) => a.t - b.t);

      const merged = new Array(invisibleNotes.length + visibleNotes.length);
      let ii = 0,
        vi = 0,
        mi = 0;
      while (ii < invisibleNotes.length && vi < visibleNotes.length) {
        merged[mi++] =
          invisibleNotes[ii].t <= visibleNotes[vi].t ? invisibleNotes[ii++] : visibleNotes[vi++];
      }
      while (ii < invisibleNotes.length) merged[mi++] = invisibleNotes[ii++];
      while (vi < visibleNotes.length) merged[mi++] = visibleNotes[vi++];
      this.modal.fullSequence = merged;

      this.modal.log(
        'debug',
        `Synced fullSequence: ${invisibleNotes.length} invisible + ${visibleNotes.length} visible = ${this.modal.fullSequence.length} total (using ${previousActiveChannels ? 'previous' : 'current'} active channels)`
      );

      // Push the edited channel's notes into whichever specialized
      // editor is open. Tablature is single-channel only; drum/wind
      // use their own bound channel.
      const notifyEditor = (editor, channel) => {
        if (editor && editor.isVisible) {
          editor.onMidiNotesChanged(visibleNotes.filter((n) => n.c === channel));
        }
      };
      if (this.modal.activeChannels.size === 1) {
        notifyEditor(this.modal.tablatureEditor, Array.from(this.modal.activeChannels)[0]);
      }
      notifyEditor(this.modal.drumPatternEditor, this.modal.drumPatternEditor?.channel);
      notifyEditor(this.modal.windInstrumentEditor, this.modal.windInstrumentEditor?.channel);
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorSequence = MidiEditorSequence;
  }
})();
