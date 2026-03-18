// public/js/audio/AudioPreview.js

/**
 * AudioPreview - Système de preview audio pour l'auto-assignation
 *
 * Permet d'écouter un extrait du fichier MIDI avec les transpositions appliquées
 * avant de valider l'assignation.
 */
class AudioPreview {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.synthesizer = null;
    this.isPlaying = false;
    this.isPreviewing = false;
    this.previewDuration = 15; // secondes
    this.previewStart = 0; // secondes
  }

  /**
   * Initialize synthesizer
   */
  async initSynthesizer() {
    if (!this.synthesizer) {
      if (!window.MidiSynthesizer) {
        throw new Error('MidiSynthesizer not available');
      }
      this.synthesizer = new window.MidiSynthesizer();
      await this.synthesizer.initialize();
    }
    return this.synthesizer;
  }

  /**
   * Preview adapted MIDI with transpositions
   * @param {Object} midiData - Original MIDI data
   * @param {Object} transpositions - { channel: { semitones, noteRemapping } }
   * @param {number} startTime - Start time in seconds (default: 0)
   * @param {number} duration - Duration in seconds (default: 15)
   * @param {Object} instrumentPrograms - { channel: gmProgram } (optional)
   */
  async previewAdapted(midiData, transpositions, startTime = 0, duration = 15, instrumentPrograms = {}) {
    try {
      this.isPreviewing = true;

      // Initialize synthesizer
      await this.initSynthesizer();

      // Apply instrument programs for selected instruments
      if (instrumentPrograms && this.synthesizer.setChannelInstrument) {
        for (const [channel, program] of Object.entries(instrumentPrograms)) {
          this.synthesizer.setChannelInstrument(Number(channel), program);
        }
      }

      // Apply transpositions to create preview sequence
      const previewSequence = this.createPreviewSequence(midiData, transpositions, startTime, duration);

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No notes to preview');
      }

      // Load and play
      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      await this.synthesizer.play();

      this.isPlaying = true;

      return true;
    } catch (error) {
      console.error('Preview error:', error);
      this.isPreviewing = false;
      throw error;
    }
  }

  /**
   * Preview original MIDI (for comparison)
   * @param {Object} midiData - Original MIDI data
   * @param {number} startTime - Start time in seconds
   * @param {number} duration - Duration in seconds
   */
  async previewOriginal(midiData, startTime = 0, duration = 15) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Create sequence without transpositions
      const previewSequence = this.createPreviewSequence(midiData, {}, startTime, duration);

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No notes to preview');
      }

      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      await this.synthesizer.play();

      this.isPlaying = true;

      return true;
    } catch (error) {
      console.error('Preview error:', error);
      this.isPreviewing = false;
      throw error;
    }
  }

  /**
   * Preview a single channel with only notes playable by the selected instrument.
   * Used in the auto-assign modal to audition an instrument on a specific channel.
   *
   * @param {Object} midiData - Original MIDI data
   * @param {number} channel - The MIDI channel to preview (0-15)
   * @param {Object} transposition - { semitones, noteRemapping } for this channel
   * @param {Object} instrumentConstraints - { gmProgram, noteRangeMin, noteRangeMax, noteSelectionMode, selectedNotes }
   * @param {number} startTime - Start time in seconds (default: 0)
   * @param {number} duration - Duration in seconds (default: 15)
   */
  async previewSingleChannel(midiData, channel, transposition = {}, instrumentConstraints = {}, startTime = 0, duration = 15) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Set the instrument sound for this channel
      if (instrumentConstraints.gmProgram != null && this.synthesizer.setChannelInstrument) {
        this.synthesizer.setChannelInstrument(channel, instrumentConstraints.gmProgram);
      }

      // Create sequence filtered to this channel only, with note range filtering
      const previewSequence = this.createPreviewSequence(
        midiData,
        { [channel]: transposition },
        startTime,
        duration,
        { channelFilter: channel, instrumentConstraints }
      );

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No playable notes to preview on this channel');
      }

      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      await this.synthesizer.play();

      this.isPlaying = true;
      return true;
    } catch (error) {
      console.error('Single channel preview error:', error);
      this.isPreviewing = false;
      throw error;
    }
  }

  /**
   * Create preview sequence from MIDI data
   * @param {Object} midiData
   * @param {Object} transpositions
   * @param {number} startTime - seconds
   * @param {number} duration - seconds
   * @param {Object} options - Optional: { channelFilter, instrumentConstraints }
   *   channelFilter: number - Only include notes from this channel (undefined = all channels)
   *   instrumentConstraints: { noteRangeMin, noteRangeMax, noteSelectionMode, selectedNotes }
   * @returns {Array} - Sequence in format [{t, g, n, c}, ...]
   */
  createPreviewSequence(midiData, transpositions, startTime, duration, options = {}) {
    const sequence = [];
    const endTime = startTime + duration;
    const ticksPerBeat = midiData.header?.ticksPerBeat || 480;
    const tempo = midiData.tempo || 120;
    const { channelFilter, instrumentConstraints } = options;

    // Convert seconds to ticks
    const msPerTick = (60000 / tempo) / ticksPerBeat;
    const startTick = (startTime * 1000) / msPerTick;
    const endTick = (endTime * 1000) / msPerTick;

    // Build a playable note set from instrument constraints
    const noteFilter = this._buildNoteFilter(instrumentConstraints);

    if (!midiData.tracks) {
      return sequence;
    }

    // Extract notes from all tracks
    for (const track of midiData.tracks) {
      if (!track.events) continue;

      let currentTime = 0;
      let currentTick = 0;

      for (const event of track.events) {
        // Update current time/tick
        if (event.deltaTime !== undefined) {
          currentTick += event.deltaTime;
        }
        if (event.time !== undefined) {
          currentTime = event.time;
        }

        // Skip events outside preview range
        if (currentTick < startTick || currentTick > endTick) {
          continue;
        }

        // Process note events
        if (event.type === 'noteOn' && event.velocity > 0) {
          const channel = event.channel || 0;

          // Filter by channel if specified
          if (channelFilter !== undefined && channel !== channelFilter) {
            continue;
          }

          let note = event.note || event.noteNumber || 60;

          // Apply transposition if exists
          const transposition = transpositions[channel];
          if (transposition) {
            if (transposition.semitones) {
              note = this.clampNote(note + transposition.semitones);
            }
            if (transposition.noteRemapping && transposition.noteRemapping[note] !== undefined) {
              note = transposition.noteRemapping[note];
            }
          }

          // Filter by instrument's playable note range
          if (noteFilter && !noteFilter(note)) {
            continue;
          }

          // Add to sequence
          // Format: t (time in ticks), g (duration/gate), n (note), c (channel)
          sequence.push({
            t: currentTick - startTick, // Relative to preview start
            g: event.duration || 480,   // Default duration if not specified
            n: note,
            c: channel,
            v: event.velocity || 100    // velocity
          });
        }
      }
    }

    // Sort by time
    sequence.sort((a, b) => a.t - b.t);

    return sequence;
  }

  /**
   * Build a note filter function from instrument constraints.
   * Returns null if no filtering needed, or a function (note) => boolean.
   */
  _buildNoteFilter(constraints) {
    if (!constraints) return null;

    const { noteRangeMin, noteRangeMax, noteSelectionMode, selectedNotes } = constraints;

    // Discrete mode: only specific notes are playable (e.g., drum pads)
    if (noteSelectionMode === 'discrete' && Array.isArray(selectedNotes) && selectedNotes.length > 0) {
      const allowedSet = new Set(selectedNotes);
      return (note) => allowedSet.has(note);
    }

    // Range mode: filter by min/max
    if (noteRangeMin != null && noteRangeMax != null) {
      return (note) => note >= noteRangeMin && note <= noteRangeMax;
    }

    // Only min specified
    if (noteRangeMin != null) {
      return (note) => note >= noteRangeMin;
    }

    // Only max specified
    if (noteRangeMax != null) {
      return (note) => note <= noteRangeMax;
    }

    return null;
  }

  /**
   * Clamp note to MIDI range (0-127)
   */
  clampNote(note) {
    return Math.max(0, Math.min(127, Math.round(note)));
  }

  /**
   * Stop preview
   */
  stop() {
    if (this.synthesizer && this.isPlaying) {
      this.synthesizer.stop();
      this.isPlaying = false;
    }
    this.isPreviewing = false;
  }

  /**
   * Pause preview
   */
  pause() {
    if (this.synthesizer && this.isPlaying) {
      this.synthesizer.pause();
    }
  }

  /**
   * Resume preview
   */
  resume() {
    if (this.synthesizer && this.synthesizer.isPaused) {
      this.synthesizer.resume();
    }
  }

  /**
   * Get playback state
   */
  getState() {
    return {
      isPlaying: this.isPlaying,
      isPreviewing: this.isPreviewing,
      currentTime: this.synthesizer?.currentTick || 0
    };
  }

  /**
   * Cleanup
   */
  destroy() {
    this.stop();
    if (this.synthesizer) {
      // Synthesizer cleanup if needed
      this.synthesizer = null;
    }
  }
}

// Make available globally
window.AudioPreview = AudioPreview;
