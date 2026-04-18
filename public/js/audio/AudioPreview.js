// public/js/audio/AudioPreview.js

/**
 * AudioPreview - Audio preview system for auto-assignment
 *
 * Allows listening to a MIDI file excerpt with transpositions applied
 * before validating the assignment.
 * Supports global preview (all channels), single-channel, and original.
 * Provides progress callbacks for the progress bar and minimap.
 */
class AudioPreview {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.synthesizer = null;
    this.isPlaying = false;
    this.isPreviewing = false;
    this.previewDuration = 15; // seconds (legacy, used when fullFile=false)
    this.previewStart = 0; // seconds

    // Progress tracking
    this.onProgress = null;      // callback(currentTick, totalTicks, currentTimeSec, totalTimeSec)
    this.onPlaybackEnd = null;   // callback()
    this.totalTicks = 0;
    this.totalDuration = 0;      // seconds
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
    } else if (this.synthesizer.setSoundBank) {
      // Synchronize the sound bank with the current setting
      const savedBank = window.MidiSynthesizer.getSavedBank();
      this.synthesizer.setSoundBank(savedBank);
    }
    return this.synthesizer;
  }

  /**
   * Connect progress callbacks to the synthesizer.
   * Must be called after loading a sequence.
   */
  _connectCallbacks() {
    if (!this.synthesizer) return;

    this.synthesizer.onTickUpdate = (tick) => {
      if (this.onProgress) {
        const currentSec = this.synthesizer.ticksToSeconds(tick);
        this.onProgress(tick, this.totalTicks, currentSec, this.totalDuration);
      }
    };

    this.synthesizer.onPlaybackEnd = () => {
      this.isPlaying = false;
      this.isPreviewing = false;
      if (this.onPlaybackEnd) {
        this.onPlaybackEnd();
      }
    };
  }

  /**
   * Compute total ticks and duration from the loaded sequence.
   */
  _computeTotals() {
    if (!this.synthesizer) return;
    this.totalTicks = this.synthesizer.endTick || 0;
    this.totalDuration = this.synthesizer.ticksToSeconds
      ? this.synthesizer.ticksToSeconds(this.totalTicks)
      : 0;
  }

  /**
   * Preview adapted MIDI with transpositions (all channels)
   * @param {Object} midiData - Original MIDI data
   * @param {Object} transpositions - { channel: { semitones, noteRemapping } }
   * @param {number} startTime - Start time in seconds (default: 0)
   * @param {number} duration - Duration in seconds (default: 15, ignored if fullFile=true)
   * @param {Object} instrumentPrograms - { channel: gmProgram } (optional)
   * @param {boolean} fullFile - If true, play entire file (no duration limit)
   */
  async previewAdapted(midiData, transpositions, startTime = 0, duration = 15, instrumentPrograms = {}, fullFile = false) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Reset all channels to original programs before applying routed programs
      this._resetChannelInstruments(midiData);

      // Apply instrument programs for selected instruments
      if (instrumentPrograms && this.synthesizer.setChannelInstrument) {
        for (const [channel, program] of Object.entries(instrumentPrograms)) {
          this.synthesizer.setChannelInstrument(Number(channel), program);
        }
      }

      const effectiveDuration = fullFile ? this._getFileDuration(midiData) : duration;

      // Apply transpositions to create preview sequence
      const previewSequence = this.createPreviewSequence(midiData, transpositions, startTime, effectiveDuration);

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No notes to preview');
      }

      // Load and play
      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      this._computeTotals();
      this._connectCallbacks();
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
   * @param {boolean} fullFile - If true, play entire file
   */
  async previewOriginal(midiData, startTime = 0, duration = 15, fullFile = false) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Reset channel instruments to the original MIDI programs
      // (clears any programs set by a previous routed preview)
      this._resetChannelInstruments(midiData);

      const effectiveDuration = fullFile ? this._getFileDuration(midiData) : duration;

      // Create sequence without transpositions
      const previewSequence = this.createPreviewSequence(midiData, {}, startTime, effectiveDuration);

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No notes to preview');
      }

      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      this._computeTotals();
      this._connectCallbacks();
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
   *
   * @param {Object} midiData - Original MIDI data
   * @param {number} channel - The MIDI channel to preview (0-15)
   * @param {Object} transposition - { semitones, noteRemapping } for this channel
   * @param {Object} instrumentConstraints - { gmProgram, noteRangeMin, noteRangeMax, noteSelectionMode, selectedNotes }
   * @param {number} startTime - Start time in seconds (default: 0)
   * @param {number} duration - Duration in seconds (default: 15)
   * @param {boolean} fullFile - If true, play entire file
   */
  async previewSingleChannel(midiData, channel, transposition = {}, instrumentConstraints = {}, startTime = 0, duration = 15, fullFile = false) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Reset all channels to original programs before overriding this channel
      this._resetChannelInstruments(midiData);

      // Set the instrument sound for this channel
      if (instrumentConstraints.gmProgram != null && this.synthesizer.setChannelInstrument) {
        this.synthesizer.setChannelInstrument(channel, instrumentConstraints.gmProgram);
      }

      const effectiveDuration = fullFile ? this._getFileDuration(midiData) : duration;

      // Create sequence filtered to this channel only, with note range filtering
      const previewSequence = this.createPreviewSequence(
        midiData,
        { [channel]: transposition },
        startTime,
        effectiveDuration,
        { channelFilter: channel, instrumentConstraints }
      );

      if (!previewSequence || previewSequence.length === 0) {
        throw new Error('No playable notes to preview on this channel');
      }

      this.synthesizer.loadSequence(previewSequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      this._computeTotals();
      this._connectCallbacks();
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
   * Preview ALL channels with their assigned instruments and adaptations.
   * This is the "global preview" that plays the full arrangement.
   *
   * @param {Object} midiData - Original MIDI data
   * @param {Object} channelConfigs - { [channel]: { transposition, instrumentConstraints, skipped } }
   *   transposition: { semitones, noteRemapping }
   *   instrumentConstraints: { gmProgram, noteRangeMin, noteRangeMax, noteSelectionMode, selectedNotes, suppressOutOfRange, noteCompression }
   *   skipped: boolean - if true, this channel is excluded
   * @param {number} startTime - Start time in seconds (default: 0)
   */
  async previewAllChannels(midiData, channelConfigs = {}, startTime = 0) {
    try {
      this.isPreviewing = true;

      await this.initSynthesizer();

      // Reset all channels to original programs before applying routed programs
      this._resetChannelInstruments(midiData);

      // Set instrument programs for each channel
      for (const [channel, config] of Object.entries(channelConfigs)) {
        if (config.skipped) continue;
        const gmProgram = config.instrumentConstraints?.gmProgram;
        if (gmProgram != null && this.synthesizer.setChannelInstrument) {
          this.synthesizer.setChannelInstrument(Number(channel), gmProgram);
        }
      }

      const totalDuration = this._getFileDuration(midiData);

      // Build combined sequence from all non-skipped channels
      const sequence = this._createMultiChannelSequence(midiData, channelConfigs, startTime, totalDuration);

      if (!sequence || sequence.length === 0) {
        throw new Error('No notes to preview');
      }

      this.synthesizer.loadSequence(sequence, midiData.tempo || 120, midiData.header?.ticksPerBeat || 480);
      this._computeTotals();
      this._connectCallbacks();
      await this.synthesizer.play();

      this.isPlaying = true;
      return true;
    } catch (error) {
      console.error('All channels preview error:', error);
      this.isPreviewing = false;
      throw error;
    }
  }

  /**
   * Build a combined sequence from all non-skipped channels, applying per-channel
   * transpositions and instrument constraints.
   */
  _createMultiChannelSequence(midiData, channelConfigs, startTime, duration) {
    const sequence = [];
    const endTime = startTime + duration;
    const ticksPerBeat = midiData.header?.ticksPerBeat || 480;
    const tempo = midiData.tempo || 120;

    const msPerTick = (60000 / tempo) / ticksPerBeat;
    const startTick = (startTime * 1000) / msPerTick;
    const endTick = (endTime * 1000) / msPerTick;

    // Build per-channel note filters
    const channelFilters = {};
    for (const [ch, config] of Object.entries(channelConfigs)) {
      if (config.skipped) continue;
      channelFilters[Number(ch)] = {
        noteFilter: this._buildNoteFilter(config.instrumentConstraints),
        transposition: config.transposition || {}
      };
    }

    if (!midiData.tracks) return sequence;

    for (const track of midiData.tracks) {
      if (!track.events) continue;

      let currentTick = 0;

      for (const event of track.events) {
        if (event.deltaTime !== undefined) {
          currentTick += event.deltaTime;
        }

        if (currentTick < startTick || currentTick > endTick) continue;

        if (event.type === 'noteOn' && event.velocity > 0) {
          const channel = event.channel ?? 0;

          // Skip channels not in config or marked as skipped
          const chConfig = channelFilters[channel];
          if (!chConfig) continue;

          let note = event.note ?? event.noteNumber ?? 60;

          // Apply transposition
          const transposition = chConfig.transposition;
          if (transposition) {
            if (transposition.semitones) {
              note = this.clampNote(note + transposition.semitones);
            }
            if (transposition.noteRemapping && transposition.noteRemapping[note] !== undefined) {
              note = transposition.noteRemapping[note];
            }
          }

          // Skip suppressed notes (e.g. muted drum notes mapped to -1)
          if (note < 0) continue;

          // Filter by instrument playable range
          if (chConfig.noteFilter && !chConfig.noteFilter(note)) continue;

          sequence.push({
            t: currentTick - startTick,
            g: event.duration || 480,
            n: note,
            c: channel,
            v: event.velocity || 100
          });
        }
      }
    }

    sequence.sort((a, b) => a.t - b.t);
    return sequence;
  }

  /**
   * Estimate total file duration in seconds from MIDI data.
   * Handles variable tempo by scanning setTempo events.
   */
  _getFileDuration(midiData) {
    if (midiData.duration) return midiData.duration;

    const ticksPerBeat = midiData.header?.ticksPerBeat || 480;
    const initialTempo = midiData.tempo || 120;

    if (!midiData.tracks) return 0;

    // Collect tempo changes from all tracks (typically in track 0)
    const tempoChanges = []; // [{tick, bpm}]
    let maxTick = 0;

    for (const track of midiData.tracks) {
      if (!track.events) continue;
      let tick = 0;
      for (const event of track.events) {
        if (event.deltaTime !== undefined) tick += event.deltaTime;
        if (event.type === 'setTempo' && event.microsecondsPerBeat) {
          tempoChanges.push({ tick, bpm: 60000000 / event.microsecondsPerBeat });
        }
      }
      if (tick > maxTick) maxTick = tick;
    }

    // No tempo changes: simple calculation
    if (tempoChanges.length === 0) {
      const msPerTick = (60000 / initialTempo) / ticksPerBeat;
      return (maxTick * msPerTick) / 1000;
    }

    // Sort tempo changes by tick and accumulate time
    tempoChanges.sort((a, b) => a.tick - b.tick);
    let totalMs = 0;
    let prevTick = 0;
    let currentBpm = initialTempo;

    for (const tc of tempoChanges) {
      const deltaTicks = tc.tick - prevTick;
      if (deltaTicks > 0) {
        totalMs += deltaTicks * (60000 / currentBpm) / ticksPerBeat;
      }
      currentBpm = tc.bpm;
      prevTick = tc.tick;
    }

    // Remaining ticks after last tempo change
    const remaining = maxTick - prevTick;
    if (remaining > 0) {
      totalMs += remaining * (60000 / currentBpm) / ticksPerBeat;
    }

    return totalMs / 1000;
  }

  /**
   * Seek to a position in seconds.
   */
  seek(timeSec) {
    if (!this.synthesizer) return;
    const ticksPerBeat = this.synthesizer.ticksPerBeat || 480;
    const tempo = this.synthesizer.tempo || 120;
    const tick = this.synthesizer.secondsToTicks
      ? this.synthesizer.secondsToTicks(timeSec)
      : (timeSec * 1000) / ((60000 / tempo) / ticksPerBeat);
    this.synthesizer.seek(tick);
  }

  /**
   * Reset synthesizer channel instruments to the original programs from the MIDI file.
   * Clears any routed instrument programs set by a previous preview mode.
   * @param {Object} midiData - MIDI data containing tracks with programChange events
   */
  _resetChannelInstruments(midiData) {
    if (!this.synthesizer?.setChannelInstrument) return;

    // Reset all channels to GM defaults
    for (let ch = 0; ch < 16; ch++) {
      this.synthesizer.setChannelInstrument(ch, 0); // Acoustic Grand Piano
      if (this.synthesizer.setChannelVolume) {
        this.synthesizer.setChannelVolume(ch, 100); // Default volume
      }
    }

    // Apply original program changes from the MIDI file
    if (midiData?.tracks) {
      for (const track of midiData.tracks) {
        if (!track.events) continue;
        for (const event of track.events) {
          if (event.type === 'programChange' || event.type === 'program') {
            const ch = event.channel ?? 0;
            const program = event.program ?? event.programNumber ?? 0;
            this.synthesizer.setChannelInstrument(ch, program);
          }
        }
      }
    }
  }

  /**
   * Create preview sequence from MIDI data
   * @param {Object} midiData
   * @param {Object} transpositions
   * @param {number} startTime - seconds
   * @param {number} duration - seconds
   * @param {Object} options - Optional: { channelFilter, instrumentConstraints }
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

      let currentTick = 0;

      for (const event of track.events) {
        // Update current time/tick
        if (event.deltaTime !== undefined) {
          currentTick += event.deltaTime;
        }

        // Skip events outside preview range
        if (currentTick < startTick || currentTick > endTick) {
          continue;
        }

        // Process note events
        if (event.type === 'noteOn' && event.velocity > 0) {
          const channel = event.channel ?? 0;

          // Filter by channel if specified
          if (channelFilter !== undefined && channel !== channelFilter) {
            continue;
          }

          let note = event.note ?? event.noteNumber ?? 60;

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

          // Skip suppressed notes (e.g. muted drum notes mapped to -1)
          if (note < 0) continue;

          // Filter by instrument's playable note range
          if (noteFilter && !noteFilter(note)) {
            continue;
          }

          // Add to sequence
          sequence.push({
            t: currentTick - startTick,
            g: event.duration || 480,
            n: note,
            c: channel,
            v: event.velocity || 100
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
      this.isPlaying = false;
    }
  }

  /**
   * Resume preview
   */
  resume() {
    if (this.synthesizer && this.synthesizer.isPaused) {
      this.synthesizer.play();
      this.isPlaying = true;
    }
  }

  /**
   * Get playback state
   */
  getState() {
    return {
      isPlaying: this.isPlaying,
      isPreviewing: this.isPreviewing,
      isPaused: this.synthesizer?.isPaused || false,
      currentTick: this.synthesizer?.currentTick || 0,
      totalTicks: this.totalTicks,
      totalDuration: this.totalDuration
    };
  }

  /**
   * Cleanup
   */
  destroy() {
    this.stop();
    if (this.synthesizer) {
      this.synthesizer.onTickUpdate = null;
      this.synthesizer.onPlaybackEnd = null;
      this.synthesizer = null;
    }
    this.onProgress = null;
    this.onPlaybackEnd = null;
  }
}

// Make available globally
window.AudioPreview = AudioPreview;
