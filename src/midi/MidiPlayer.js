/**
 * @file src/midi/MidiPlayer.js
 * @description Master MIDI playback engine. Loads a file from the
 * database, expands its tracks into a single absolute-time event list,
 * and feeds the {@link PlaybackScheduler} which is responsible for the
 * sub-millisecond scheduling of each event.
 *
 * Major responsibilities (1300 LOC; only public methods carry full
 * JSDoc, internal helpers get one-liners where useful):
 *   - File loading + tempo-aware tick→seconds conversion
 *   - Per-channel routing & muting (with split-routing support)
 *   - Tablature CC injection so string-instrument controllers receive
 *     fret/string events alongside the noteOn/noteOff stream
 *   - Playlist queue management (loop, shuffle, gap, status broadcast)
 *   - Lifecycle: play / pause / resume / seek / stop / destroy
 *   - WS broadcast of `playback_*` events for the frontend
 *
 * Collaborators:
 *   - {@link PlaybackScheduler} for actual timer / send orchestration.
 *   - {@link MidiClockGenerator} when MIDI Clock should accompany playback.
 *   - DeviceManager (lazy via `_deps`) for MIDI emission.
 *   - Database for file payload + persisted routings.
 */
import { parseMidi } from 'midi-file';
import { performance } from 'perf_hooks';
import PlaybackScheduler from './PlaybackScheduler.js';

/** Used to convert MIDI `microsecondsPerBeat` into BPM. */
const MICROSECONDS_PER_MINUTE = 60000000;

/** MIDI Channel Mode CC #123. */
const MIDI_CC_ALL_NOTES_OFF = 123;

/**
 * Maps `midi-file` event types to constructors that produce the
 * normalised event objects consumed by {@link PlaybackScheduler}. Each
 * builder is `(rawEvent, absoluteTimeSec) => normalisedEvent`.
 */
const EVENT_BUILDERS = {
  noteOn: (e, time) => ({
    time, type: 'noteOn', channel: e.channel ?? 0,
    note: e.noteNumber, velocity: e.velocity
  }),
  noteOff: (e, time) => ({
    time, type: 'noteOff', channel: e.channel ?? 0,
    note: e.noteNumber, velocity: e.velocity
  }),
  controller: (e, time) => ({
    time, type: 'controller', channel: e.channel ?? 0,
    controller: e.controllerType, value: e.value
  }),
  pitchBend: (e, time) => ({
    time, type: 'pitchBend', channel: e.channel ?? 0,
    value: e.value
  }),
  programChange: (e, time) => ({
    time, type: 'programChange', channel: e.channel ?? 0,
    program: e.programNumber !== undefined ? e.programNumber : e.value
  }),
  channelAftertouch: (e, time) => ({
    time, type: 'channelAftertouch', channel: e.channel ?? 0,
    value: e.value
  }),
  noteAftertouch: (e, time) => ({
    time, type: 'noteAftertouch', channel: e.channel ?? 0,
    note: e.noteNumber, value: e.value
  }),
  setTempo: (e, time) => ({
    time, type: 'setTempo',
    tempo: MICROSECONDS_PER_MINUTE / e.microsecondsPerBeat
  })
};

/**
 * Stateful playback engine. One instance per process, registered as
 * `midiPlayer`. Many consumers (CommandRegistry, PlaylistCommands)
 * call directly into it.
 */
class MidiPlayer {
  /**
   * @param {Object} deps - DI bag (or Application facade). Needs at
   *   least `logger`, `database`. `wsServer`, `deviceManager`,
   *   `midiClockGenerator`, `latencyCompensator` are resolved lazily.
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.database = deps.database;
    this._deps = deps; // For lazy resolution of wsServer, deviceManager
    this.playing = false;
    this.paused = false;
    this.position = 0; // seconds
    this.duration = 0; // seconds
    this.tempo = 120; // BPM — effective (originalTempo * playbackRate)
    this.originalTempo = null; // BPM at file load; null when no file loaded
    this.playbackRate = 1.0; // tempo multiplier applied by the scheduler
    this.ppq = 480; // Pulses per quarter note
    this.tracks = [];
    this.events = [];
    this.currentEventIndex = 0;
    this.startTime = 0;
    this.pauseTime = 0;
    this.outputDevice = null;
    this.loop = false;
    this.loadedFileId = null; // ID of currently loaded file
    this.channels = []; // MIDI channels found in file
    this.channelRouting = new Map(); // channel -> { device, targetChannel } mapping
    this.mutedChannels = new Set(); // Muted channels

    // Queue / Playlist state
    this.queue = [];           // [{ fileId, filename }]
    this.queueIndex = -1;      // Current position (-1 = no queue)
    this.queueLoop = false;    // Loop entire queue
    this.playlistId = null;    // Active playlist ID
    this.queueGapSeconds = 0;  // Delay between files (seconds)
    this.queueShuffle = false; // Shuffle mode
    this._gapTimer = null;     // setTimeout handle for gap delay
    this._gapCountdownInterval = null; // Interval for countdown broadcast
    this._gapRemaining = 0;    // Seconds remaining in gap

    // Disconnect policy: 'skip' | 'pause' | 'mute'
    this.disconnectedPolicy = 'skip';

    // Guard against concurrent _handleFileEnd calls
    this._fileEndPending = false;

    // Delegate scheduling, timing compensation, and event sending to PlaybackScheduler
    this.scheduler = new PlaybackScheduler(deps);

    // MIDI Clock generator (injected via deps or set later)
    this.midiClockGenerator = deps.midiClockGenerator || null;

    this.logger.info('MidiPlayer initialized');
  }

  /**
   * Load a MIDI file from the database, parse it, build the absolute-
   * time event list and prime the scheduler. Sets up tempo, ppq,
   * channel summary, duration; loads any persisted routings.
   *
   * @param {(string|number)} fileId
   * @returns {Promise<{success:boolean, fileId:(string|number),
   *   tracks:number, channels:Object[], duration:number, tempo:number}>}
   * @throws {Error} When the file cannot be found or parsed.
   */
  async loadFile(fileId) {
    try {
      const file = this.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }
      if (!file.data) {
        throw new Error(`File ${fileId} (${file.filename}) has no MIDI data`);
      }

      // Handle both Buffer (BLOB) and base64 string (legacy)
      const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
      const midi = parseMidi(buffer);

      if (!midi || !midi.header || !Array.isArray(midi.tracks)) {
        throw new Error(`File ${fileId} (${file.filename}) contains invalid MIDI data`);
      }

      this.ppq = midi.header.ticksPerBeat || 480;
      this.parseTracks(midi);
      this.extractTempo(midi);
      this.extractChannels(midi);
      this.buildEventList();
      this.loadedFileId = fileId;
      this._injectTablatureCCEvents();
      // Reset split routing counters for the new file
      this._overlapCounters = null;
      this._segmentNoteCounts = null;
      this._alternateCounters = null;
      this._overlapNoteAssign = null;
      this.calculateDuration();

      this.logger.info(`File loaded: ${file.filename} (${this.events.length} events, ${this.duration.toFixed(2)}s)`);

      return {
        filename: file.filename,
        duration: this.duration,
        tracks: this.tracks.length,
        events: this.events.length,
        tempo: this.tempo,
        channels: this.channels
      };
    } catch (error) {
      this.logger.error(`Failed to load file: ${error.message}`);
      throw error;
    }
  }

  parseTracks(midi) {
    this.tracks = midi.tracks.map((track, index) => {
      return {
        index: index,
        events: track,
        name: this.extractTrackName(track)
      };
    });
  }

  extractTrackName(track) {
    const nameEvent = track.find(e => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }

  extractTempo(midi) {
    for (const track of midi.tracks) {
      const tempoEvent = track.find(e => e.type === 'setTempo');
      if (tempoEvent) {
        this.tempo = MICROSECONDS_PER_MINUTE / tempoEvent.microsecondsPerBeat;
        // Snapshot the file's native tempo so setPlaybackTempo can
        // compute a stable playbackRate multiplier and setTempo back
        // to this value resets the rate to 1.0.
        this.originalTempo = this.tempo;
        this.playbackRate = 1.0;
        return;
      }
    }
    this.tempo = 120;
    this.originalTempo = 120;
    this.playbackRate = 1.0;
  }

  extractChannels(midi) {
    const channelsSet = new Set();

    midi.tracks.forEach((track, _trackIndex) => {
      track.forEach(event => {
        if (event.channel !== undefined &&
            (event.type === 'noteOn' || event.type === 'noteOff')) {
          channelsSet.add(event.channel);
        }
      });
    });

    this.channels = Array.from(channelsSet).sort((a, b) => a - b).map(channel => {
      const tracksUsingChannel = [];
      midi.tracks.forEach((track, trackIndex) => {
        const usesChannel = track.some(e => e.channel === channel);
        if (usesChannel) {
          tracksUsingChannel.push({
            index: trackIndex,
            name: this.tracks[trackIndex]?.name || 'Unnamed'
          });
        }
      });

      return {
        channel: channel,
        channelDisplay: channel + 1,
        tracks: tracksUsingChannel,
        assignedDevice: null
      };
    });

    this.logger.info(`Found ${this.channels.length} MIDI channels: ${this.channels.map(c => c.channelDisplay).join(', ')}`);
  }

  /**
   * Walk every track of the loaded file, accumulate per-track tick
   * counters, and produce a single absolute-time event list ordered by
   * `time`. Non-channel meta events that affect playback (`setTempo`,
   * future: `timeSignature`) are kept; lyrics/text are ignored.
   *
   * Tablature CC injection is performed via
   * {@link MidiPlayer#_injectTablatureCCEvents} after the merge.
   *
   * @returns {void} Mutates `this.events` and `this.tempoMap`.
   * @private
   */
  buildEventList() {
    this.events = [];
    const tempoMap = this._buildTempoMap();

    this.tracks.forEach(track => {
      let trackTicks = 0;
      track.events.forEach(event => {
        trackTicks += event.deltaTime;
        const timeInSeconds = this._ticksToSecondsWithTempoMap(trackTicks, tempoMap);

        const builder = EVENT_BUILDERS[event.type];
        if (builder) {
          this.events.push(builder(event, timeInSeconds));
        }
      });
    });

    this.events.sort((a, b) => a.time - b.time);

    // Deduplicate setTempo events at the same time (multiple tracks may contain identical tempo changes)
    this.events = this.events.filter((event, idx, arr) => {
      if (event.type !== 'setTempo') return true;
      if (idx === 0) return true;
      const prev = arr[idx - 1];
      return !(prev.type === 'setTempo' && prev.time === event.time && prev.tempo === event.tempo);
    });
  }

  /**
   * Inject CC events (string select + fret select) from tablature data.
   */
  _injectTablatureCCEvents() {
    if (!this.loadedFileId || !this.database) return;

    let tablatures;
    try {
      tablatures = this.database.getTablaturesByFile(this.loadedFileId);
    } catch (error) {
      this.logger.debug(`No tablature data for file ${this.loadedFileId}: ${error.message}`);
      return;
    }

    if (!tablatures || tablatures.length === 0) return;

    const tempoMap = this._buildTempoMap();
    const tabByChannel = new Map();

    for (const tab of tablatures) {
      if (!Array.isArray(tab.tablature_data) || tab.tablature_data.length === 0) continue;

      // CC 20/21 only for string instruments with cc_enabled
      if (!tab.string_instrument_id) continue;

      let instrument;
      try {
        instrument = this.database.stringInstrumentDB.getStringInstrumentById(tab.string_instrument_id);
      } catch (e) {
        this.logger.debug(`Skipping tablature CC: instrument lookup failed for ID ${tab.string_instrument_id}`);
        continue;
      }
      if (!instrument || instrument.cc_enabled === false) continue;

      const ccConfig = {
        ccStringNumber: instrument.cc_string_number ?? 20,
        ccStringMin: instrument.cc_string_min ?? 1,
        ccStringMax: instrument.cc_string_max ?? 12,
        ccStringOffset: instrument.cc_string_offset ?? 0,
        ccFretNumber: instrument.cc_fret_number ?? 21,
        ccFretMin: instrument.cc_fret_min ?? 0,
        ccFretMax: instrument.cc_fret_max ?? 36,
        ccFretOffset: instrument.cc_fret_offset ?? 0
      };

      const channel = tab.channel || 0;
      const events = [];

      for (const ev of tab.tablature_data) {
        const timeInSeconds = this._ticksToSecondsWithTempoMap(ev.tick, tempoMap);
        events.push({
          time: timeInSeconds,
          string: ev.string,
          fret: ev.fret,
          midiNote: ev.midiNote
        });
      }

      tabByChannel.set(channel, { events, ccConfig });
    }

    const ccEvents = [];
    const EPSILON = 0.0001;

    for (const event of this.events) {
      if (event.type !== 'noteOn' || event.velocity === 0) continue;

      const tabData = tabByChannel.get(event.channel);
      if (!tabData) continue;

      const { events: tabEvents, ccConfig } = tabData;

      let bestMatch = null;
      let bestTimeDiff = Infinity;

      for (const te of tabEvents) {
        if (te.midiNote !== event.note) continue;
        const timeDiff = Math.abs(te.time - event.time);
        if (timeDiff < bestTimeDiff) {
          bestTimeDiff = timeDiff;
          bestMatch = te;
        }
      }

      if (bestMatch && bestTimeDiff < 0.05) {
        const stringRaw = bestMatch.string + ccConfig.ccStringOffset;
        const stringVal = Math.max(0, Math.min(127, Math.max(ccConfig.ccStringMin, Math.min(ccConfig.ccStringMax, stringRaw))));
        const fretRaw = Math.round(bestMatch.fret) + ccConfig.ccFretOffset;
        const fretVal = Math.max(0, Math.min(127, Math.max(ccConfig.ccFretMin, Math.min(ccConfig.ccFretMax, fretRaw))));

        ccEvents.push({
          time: event.time - EPSILON,
          type: 'controller',
          channel: event.channel,
          controller: ccConfig.ccStringNumber,
          value: stringVal
        });
        ccEvents.push({
          time: event.time - EPSILON,
          type: 'controller',
          channel: event.channel,
          controller: ccConfig.ccFretNumber,
          value: fretVal
        });
      }
    }

    if (ccEvents.length > 0) {
      this.events.push(...ccEvents);
      this.events.sort((a, b) => a.time - b.time);
      this.logger.info(`Injected ${ccEvents.length} tablature CC events for ${tabByChannel.size} channel(s)`);
    }
  }

  _buildTempoMap() {
    const tempoEvents = [];

    this.tracks.forEach(track => {
      let trackTicks = 0;
      track.events.forEach(event => {
        trackTicks += event.deltaTime;
        if (event.type === 'setTempo') {
          tempoEvents.push({
            tick: trackTicks,
            microsecondsPerBeat: event.microsecondsPerBeat
          });
        }
      });
    });

    tempoEvents.sort((a, b) => a.tick - b.tick);

    const tempoMap = [];
    let cumulativeSeconds = 0;
    let lastTick = 0;
    let currentMicrosecondsPerBeat = MICROSECONDS_PER_MINUTE / this.tempo;

    for (const te of tempoEvents) {
      const deltaTicks = te.tick - lastTick;
      const secondsPerTick = currentMicrosecondsPerBeat / (this.ppq * 1000000);
      cumulativeSeconds += deltaTicks * secondsPerTick;

      tempoMap.push({
        tick: te.tick,
        time: cumulativeSeconds,
        microsecondsPerBeat: te.microsecondsPerBeat
      });

      lastTick = te.tick;
      currentMicrosecondsPerBeat = te.microsecondsPerBeat;
    }

    if (tempoMap.length === 0) {
      tempoMap.push({
        tick: 0,
        time: 0,
        microsecondsPerBeat: currentMicrosecondsPerBeat
      });
    }

    return tempoMap;
  }

  _ticksToSecondsWithTempoMap(ticks, tempoMap) {
    let activeEntry = { tick: 0, time: 0, microsecondsPerBeat: MICROSECONDS_PER_MINUTE / this.tempo };

    for (const entry of tempoMap) {
      if (entry.tick <= ticks) {
        activeEntry = entry;
      } else {
        break;
      }
    }

    const deltaTicks = ticks - activeEntry.tick;
    const secondsPerTick = activeEntry.microsecondsPerBeat / (this.ppq * 1000000);
    return activeEntry.time + (deltaTicks * secondsPerTick);
  }

  /**
   * Linear approximation: convert MIDI ticks to seconds using the
   * single tempo captured at file load. Use the tempo-map-aware
   * variant {@link MidiPlayer#_ticksToSecondsWithTempoMap} when the
   * file contains tempo changes.
   *
   * @param {number} ticks
   * @returns {number} Seconds.
   */
  ticksToSeconds(ticks) {
    const beatsPerSecond = this.tempo / 60;
    const ticksPerSecond = beatsPerSecond * this.ppq;
    return ticks / ticksPerSecond;
  }

  /**
   * @returns {number} File duration in seconds (last event time, or 0
   *   when there are no events).
   */
  calculateDuration() {
    if (this.events.length === 0) {
      this.duration = 0;
    } else {
      this.duration = this.events[this.events.length - 1].time;
    }
  }

  /**
   * Begin playback of the loaded file on `outputDevice`. When
   * `resumePosition` is supplied (seek case), playback starts at that
   * absolute second instead of 0.
   *
   * Emits `playback_started` on the EventBus and triggers the
   * MidiClockGenerator if it's enabled.
   *
   * @param {?string} outputDevice - Default output device id (per-channel
   *   routing overrides this).
   * @param {?number} [resumePosition] - Resume position in seconds.
   * @returns {boolean} True if playback was actually started.
   */
  start(outputDevice, resumePosition = null) {
    if (this.playing) {
      this.logger.warn('Player already playing');
      return;
    }

    if (!outputDevice) {
      throw new Error('Output device required');
    }

    this.outputDevice = outputDevice;
    this.playing = true;
    this.paused = false;

    if (resumePosition !== null) {
      this.position = resumePosition;
      this.currentEventIndex = this.findEventIndexAtTime(resumePosition);
      // Rate-aware anchor: elapsed = (now - startTime) * rate must equal
      // resumePosition at the next tick.
      const rate = this.playbackRate > 0 ? this.playbackRate : 1;
      this.startTime = performance.now() - (resumePosition * 1000 / rate);
    } else {
      this.position = 0;
      this.currentEventIndex = 0;
      this.startTime = performance.now();
    }

    this.scheduler.resetForPlayback();

    this.scheduler.startScheduler(() => {
      this._schedulerTick();
    });

    // Start MIDI clock if enabled, using the tempo at current position
    if (this.midiClockGenerator) {
      const tempoAtPosition = this._getTempoAtPosition(this.position);
      this.midiClockGenerator.startPlayback(tempoAtPosition);
    }

    this.broadcastStatus();

    this.logger.info(`Playback started on ${outputDevice} at position ${this.position.toFixed(2)}s`);
  }

  /**
   * Internal tick callback - delegates to PlaybackScheduler.tick()
   */
  _schedulerTick() {
    const state = {
      playing: this.playing,
      paused: this.paused,
      position: this.position,
      duration: this.duration,
      events: this.events,
      currentEventIndex: this.currentEventIndex,
      startTime: this.startTime,
      playbackRate: this.playbackRate,
      loop: this.loop,
      channelRouting: this.channelRouting,
      mutedChannels: this.mutedChannels,
      disconnectedPolicy: this.disconnectedPolicy,
      _lastBroadcastPosition: this._lastBroadcastPosition
    };

    const newIndex = this.scheduler.tick(
      state,
      (channel, note, eventType) => this.getOutputForChannel(channel, note, eventType),
      {
        onStop: () => this.stop(),
        onSeek: (pos) => this.seek(pos),
        onBroadcastPosition: () => this.broadcastPosition(),
        onFileEnd: () => this._handleFileEnd(),
        onPause: () => this.pause()
      }
    );

    // Sync mutable state back
    this.position = state.position;
    this.currentEventIndex = newIndex;
    this._lastBroadcastPosition = state._lastBroadcastPosition;
  }

  /**
   * Pause playback. The current position is preserved; resume()
   * continues from there. No-op when not playing.
   *
   * @returns {boolean} True when the call actually transitioned state.
   */
  pause() {
    if (!this.playing || this.paused) {
      return;
    }

    this.paused = true;
    this.pauseTime = performance.now();
    this.scheduler.stopScheduler();
    this.sendAllNotesOff();

    // Pause MIDI clock
    if (this.midiClockGenerator) {
      this.midiClockGenerator.pausePlayback();
    }

    this.broadcastStatus();

    this.logger.info('Playback paused');
  }

  /**
   * Resume from the position captured by {@link MidiPlayer#pause}.
   * No-op when not paused.
   *
   * @returns {boolean} True when the call actually transitioned state.
   */
  resume() {
    if (!this.playing || !this.paused) {
      return;
    }

    this.paused = false;
    const pauseDuration = performance.now() - this.pauseTime;
    this.startTime += pauseDuration;
    this.scheduler.startScheduler(() => {
      this._schedulerTick();
    });

    // Resume MIDI clock
    if (this.midiClockGenerator) {
      this.midiClockGenerator.resumePlayback();
    }

    this.broadcastStatus();

    this.logger.info('Playback resumed');
  }

  /**
   * Stop playback, send All Notes Off, reset position to 0.
   * Idempotent. Emits `playback_stopped`.
   *
   * @returns {boolean} True when the call actually transitioned state.
   */
  stop() {
    this._clearGapTimer();

    if (!this.playing) {
      return;
    }

    this.playing = false;
    this.paused = false;
    this.position = 0;
    this.currentEventIndex = 0;
    this._lastBroadcastPosition = undefined;
    this._overlapCounters = null;
    this._segmentNoteCounts = null;
    this._overlapNoteAssign = null;
    this._alternateCounters = null;
    this.scheduler.stopScheduler();
    this.sendAllNotesOff();

    // Stop MIDI clock
    if (this.midiClockGenerator) {
      this.midiClockGenerator.stopPlayback();
    }

    this.broadcastStatus();
    this.logger.info('Playback stopped');
  }

  /**
   * Tear down the player: stop playback, clear timers, release
   * scheduler resources, drop any cached file. Called from
   * Application#stop.
   *
   * @returns {void}
   */
  destroy() {
    this.stop();
    this.scheduler.destroy();
    if (this.midiClockGenerator) {
      this.midiClockGenerator.destroy();
    }
    this.events = [];
    this.tracks = [];
    this.channelRouting.clear();
    this.mutedChannels.clear();
  }

  /**
   * Move playback to `position` seconds. Sends All Notes Off to avoid
   * stuck notes, then re-anchors the scheduler at the new position.
   * Works whether playback is currently active or paused.
   *
   * @param {number} position - Absolute target position in seconds.
   * @returns {boolean} True when the seek was applied.
   */
  seek(position) {
    const wasPlaying = this.playing;
    const seekPosition = Math.max(0, Math.min(position, this.duration));
    const savedOutputDevice = this.outputDevice;

    if (this.playing) {
      this.scheduler.stopScheduler();
      this.sendAllNotesOff();
      // Stop clock before restarting to avoid timer leaks
      if (this.midiClockGenerator) {
        this.midiClockGenerator.stopPlayback();
      }
      this.playing = false;
      this.paused = false;
    }

    this.position = seekPosition;
    this.currentEventIndex = this.findEventIndexAtTime(seekPosition);
    // Reset split routing counters on seek (stale note assignments)
    this._overlapCounters = null;
    this._segmentNoteCounts = null;
    this._alternateCounters = null;
    this._overlapNoteAssign = null;

    if (wasPlaying) {
      this.start(savedOutputDevice, seekPosition);
    } else {
      this.broadcastPosition();
    }
  }

  /**
   * Get the active tempo (BPM) at a given position in seconds.
   * Scans setTempo events in the event list to find the last tempo change before position.
   * @param {number} position - Position in seconds
   * @returns {number} BPM at the given position
   */
  _getTempoAtPosition(position) {
    let activeTempo = this.tempo; // Initial file tempo
    for (const event of this.events) {
      if (event.time > position) break;
      if (event.type === 'setTempo') {
        activeTempo = event.tempo;
      }
    }
    return activeTempo;
  }

  findEventIndexAtTime(time) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].time < time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Send All Notes Off (CC #123) on every channel of every routed
   * device. Used by stop / seek to avoid stuck notes.
   *
   * @returns {void}
   */
  sendAllNotesOff() {
    this.scheduler.sendAllNotesOff(this.outputDevice, this.channelRouting, this.channels);
  }

  /**
   * @param {boolean} enabled - When true, the file restarts from
   *   position 0 on end-of-file instead of stopping.
   * @returns {boolean}
   */
  setLoop(enabled) {
    this.loop = enabled;
    this.logger.info(`Loop ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Change the playback tempo. Applies a rate multiplier to the
   * scheduler so events fire `rate` times faster (or slower) without
   * re-timing the event list. Also forwards the new BPM to the MIDI
   * Clock generator so external gear synced via MIDI Clock follows.
   *
   * Clamps the resulting rate to [0.25, 4] so a runaway value can't
   * starve the scheduler or flood the MIDI bus.
   *
   * @param {number} bpm - Target tempo in BPM.
   * @returns {{success:boolean, bpm:number, playbackRate:number,
   *   originalTempo:?number}}
   */
  setPlaybackTempo(bpm) {
    const target = Number(bpm);
    if (!Number.isFinite(target) || target <= 0) {
      return { success: false, bpm: this.tempo, playbackRate: this.playbackRate, originalTempo: this.originalTempo };
    }

    // No file loaded yet — store the value for later and forward to the
    // clock if it happens to be running (master-only use case).
    if (!this.originalTempo) {
      this.tempo = target;
      if (this.midiClockGenerator?.isEnabled?.()) {
        this.midiClockGenerator.setTempo(target);
      }
      return { success: true, bpm: target, playbackRate: 1.0, originalTempo: null };
    }

    // Clamp rate so the scheduler can't be starved (0.25x) or swamped
    // with a 100x backlog (4x).
    let rate = target / this.originalTempo;
    if (rate < 0.25) rate = 0.25;
    if (rate > 4) rate = 4;
    const effectiveBpm = this.originalTempo * rate;

    // Rebase startTime so `position` stays continuous across the rate
    // switch: elapsed_old = elapsed_new holds when
    // startTime_new = now - position * 1000 / rate.
    if (this.playing && !this.paused) {
      const now = performance.now();
      this.startTime = now - (this.position * 1000 / rate);
    }

    this.playbackRate = rate;
    this.tempo = effectiveBpm;

    if (this.midiClockGenerator?.isEnabled?.()) {
      this.midiClockGenerator.setTempo(effectiveBpm);
    }

    this.logger.info(
      `Playback tempo set to ${effectiveBpm.toFixed(1)} BPM (rate ${rate.toFixed(3)})`
    );
    this.broadcastStatus();
    return { success: true, bpm: effectiveBpm, playbackRate: rate, originalTempo: this.originalTempo };
  }

  /**
   * Broadcast a `playback_status` WebSocket event with the full state
   * snapshot. Called on every transition (start/pause/stop/seek).
   *
   * @returns {void}
   */
  broadcastStatus() {
    if (this._deps.wsServer) {
      const status = {
        playing: this.playing,
        paused: this.paused,
        position: this.position,
        duration: this.duration,
        percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0,
        loop: this.loop
      };
      // Include queue/playlist info if active
      if (this.queue.length > 0 && this.queueIndex >= 0) {
        status.playlistId = this.playlistId;
        status.queueIndex = this.queueIndex;
        status.queueTotal = this.queue.length;
        status.queueLoop = this.queueLoop;
        status.queueFile = this.queue[this.queueIndex] || null;
      }
      this._deps.wsServer.broadcast('playback_status', status);
    }
  }

  /**
   * Lighter event than {@link MidiPlayer#broadcastStatus} — only
   * `position` + `duration`. Sent at high frequency by the scheduler so
   * the playhead UI stays smooth without saturating the WS.
   *
   * @returns {void}
   */
  broadcastPosition() {
    if (this._deps.wsServer) {
      this._deps.wsServer.broadcast('playback_position', {
        position: this.position,
        percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0
      });
    }
  }

  /**
   * Build a status snapshot for the API (`playback_status` command).
   *
   * @returns {Object} Includes flags, position/duration, tempo, file id,
   *   channel summary, current routing/mute state, queue progress.
   */
  getStatus() {
    return {
      playing: this.playing,
      paused: this.paused,
      position: this.position,
      duration: this.duration,
      percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0,
      outputDevice: this.outputDevice,
      loop: this.loop,
      tempo: this.tempo,
      events: this.events.length
    };
  }

  // ==================== CHANNEL ROUTING ====================

  /**
   * Route a single MIDI channel to a specific output device, optionally
   * remapping to a different target channel.
   *
   * @param {number} channel - Source channel (0-15).
   * @param {string} deviceId - Output device id; falsy clears the route.
   * @param {?number} [targetChannel] - Optional remapped destination channel.
   * @returns {void}
   */
  setChannelRouting(channel, deviceId, targetChannel) {
    const target = (targetChannel !== undefined && targetChannel !== null) ? targetChannel : channel;
    this.channelRouting.set(channel, { device: deviceId, targetChannel: target });
    this.logger.info(`Channel ${channel + 1} routed to ${deviceId} (target ch ${target + 1})`);

    this.scheduler.invalidateCompensationCache();

    const channelInfo = this.channels.find(c => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = deviceId;
    }
  }

  /**
   * Set split routing: one channel → multiple instruments based on note ranges
   * @param {number} channel - Source MIDI channel
   * @param {Array<Object>} segments - [{ device_id, target_channel, split_note_min, split_note_max, overlap_strategy }]
   */
  /**
   * Split a channel across multiple destinations based on note range
   * (e.g. low notes → bass amp, high notes → guitar amp).
   *
   * @param {number} channel - Source channel.
   * @param {Array<{minNote:number, maxNote:number, deviceId:string,
   *   targetChannel?:number}>} segments
   * @returns {void}
   */
  setChannelSplitRouting(channel, segments) {
    // Extract overlap_strategy from first segment that has one (shared across the split)
    const overlapStrategy = segments.find(s => s.overlap_strategy)?.overlap_strategy || 'first';

    const splitRouting = {
      split: true,
      overlapStrategy,
      segments: segments.map(seg => ({
        device: seg.device_id,
        targetChannel: seg.target_channel !== undefined ? seg.target_channel : channel,
        noteMin: seg.split_note_min ?? 0,
        noteMax: seg.split_note_max ?? 127,
        polyphonyShare: seg.split_polyphony_share ?? null
      }))
    };

    this.channelRouting.set(channel, splitRouting);
    this.scheduler.invalidateCompensationCache();

    const channelInfo = this.channels.find(c => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = segments.map(s => s.device_id).join('+');
    }

    this.logger.info(`Channel ${channel + 1} split across ${segments.length} instruments`);
  }

  /**
   * Drop every per-channel routing override; channels fall back to the
   * default `outputDevice` passed to {@link MidiPlayer#start}.
   *
   * @returns {void}
   */
  clearChannelRouting() {
    this.channelRouting.clear();
    this.scheduler.invalidateCompensationCache();
    this.channels.forEach(c => c.assignedDevice = null);
    this.logger.info('All channel routing cleared');
  }

  /**
   * @returns {Object<number, Object>} Snapshot of the current routing
   *   map keyed by source channel.
   */
  getChannelRouting() {
    return this.channels.map(c => {
      const routing = this.channelRouting.get(c.channel);
      const targetChannel = routing
        ? (typeof routing === 'string' ? c.channel : routing.targetChannel)
        : null;
      return {
        channel: c.channel,
        channelDisplay: c.channelDisplay,
        tracks: c.tracks,
        assignedDevice: c.assignedDevice,
        targetChannel: targetChannel,
        targetChannelDisplay: targetChannel !== null ? targetChannel + 1 : null
      };
    });
  }

  /**
   * Get output routing for a channel, optionally considering the note for split routing
   * @param {number} channel
   * @param {number|null} [note=null] - MIDI note number (for split routing)
   * @param {string|null} [eventType=null] - 'noteOn' or 'noteOff' (for least_loaded tracking)
   * @returns {Object|Array|null} - { device, targetChannel } or array for broadcast, or null if muted
   */
  /**
   * Resolve the destination for a single event. Considers (in order):
   * channel-level routing, split routing by note range, and finally the
   * default `outputDevice`. Returns `null` when nothing matches so the
   * scheduler can drop the event silently.
   *
   * @param {number} channel
   * @param {?number} [note] - For note events; required by split routing.
   * @param {?string} [eventType] - Used to differentiate note-vs-cc when
   *   choosing how to apply target-channel mapping.
   * @returns {?{deviceId:string, targetChannel:number}}
   */
  getOutputForChannel(channel, note = null, eventType = null) {
    if (this.channelRouting.has(channel)) {
      const routing = this.channelRouting.get(channel);

      // Legacy string format
      if (typeof routing === 'string') {
        return { device: routing, targetChannel: channel };
      }

      // Split routing: route based on note
      if (routing.split && routing.segments) {
        if (note !== null) {
          // Find all segments covering this note
          const matching = routing.segments.filter(seg => note >= seg.noteMin && note <= seg.noteMax);

          if (matching.length === 1) {
            return { device: matching[0].device, targetChannel: matching[0].targetChannel };
          }

          if (matching.length > 1) {
            // Multiple segments cover this note — apply overlap strategy
            const strategy = routing.overlapStrategy || 'first';

            if (strategy === 'shared' || strategy === 'round_robin') {
              // Round-robin: alternate between matching segments using a per-channel counter
              if (!this._overlapCounters) this._overlapCounters = new Map();
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const noteKey = `${channel}_${note}_seg`;
                const assignQueue = this._overlapNoteAssign.get(noteKey);
                if (assignQueue && assignQueue.length > 0) {
                  const assignedIdx = assignQueue.shift();
                  if (assignQueue.length === 0) this._overlapNoteAssign.delete(noteKey);
                  if (matching[assignedIdx]) {
                    const seg = matching[assignedIdx];
                    return { device: seg.device, targetChannel: seg.targetChannel };
                  }
                }
                // Untracked noteOff — route to first matching
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }

              // noteOn: increment counter and record assignment (FIFO queue for re-triggers)
              const key = `${channel}_${note}`;
              const counter = (this._overlapCounters.get(key) || 0);
              this._overlapCounters.set(key, counter + 1);
              const segIdx = counter % matching.length;
              const seg = matching[segIdx];
              const noteKey = `${channel}_${note}_seg`;
              if (!this._overlapNoteAssign.has(noteKey)) this._overlapNoteAssign.set(noteKey, []);
              this._overlapNoteAssign.get(noteKey).push(segIdx);
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'second') {
              // Prefer last matching segment (deterministic: both noteOn and noteOff
              // always route to the same segment since matching.length is stable)
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();

              if (eventType === 'noteOff') {
                const noteKey = `${channel}_${note}_seg`;
                const assignQueue = this._overlapNoteAssign.get(noteKey);
                if (assignQueue && assignQueue.length > 0) {
                  const assignedIdx = assignQueue.shift();
                  if (assignQueue.length === 0) this._overlapNoteAssign.delete(noteKey);
                  if (matching[assignedIdx]) {
                    const seg = matching[assignedIdx];
                    return { device: seg.device, targetChannel: seg.targetChannel };
                  }
                }
              }

              const segIdx = matching.length - 1;
              const seg = matching[segIdx];
              if (eventType === 'noteOn') {
                const noteKey = `${channel}_${note}_seg`;
                if (!this._overlapNoteAssign.has(noteKey)) this._overlapNoteAssign.set(noteKey, []);
                this._overlapNoteAssign.get(noteKey).push(segIdx);
              }
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'least_loaded') {
              // Route to segment with fewer active notes
              if (!this._segmentNoteCounts) this._segmentNoteCounts = new Map();
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();
              // On noteOff: decrement and route to same segment as the noteOn did (FIFO for re-triggers)
              if (eventType === 'noteOff') {
                const noteKey = `${channel}_${note}_seg`;
                const assignQueue = this._overlapNoteAssign.get(noteKey);
                if (assignQueue && assignQueue.length > 0) {
                  const assignedIdx = assignQueue.shift();
                  if (assignQueue.length === 0) this._overlapNoteAssign.delete(noteKey);
                  if (matching[assignedIdx]) {
                    const seg = matching[assignedIdx];
                    const segKey = `${seg.device}_${seg.targetChannel}`;
                    const count = this._segmentNoteCounts.get(segKey) || 0;
                    if (count > 0) this._segmentNoteCounts.set(segKey, count - 1);
                    return { device: seg.device, targetChannel: seg.targetChannel };
                  }
                }
                // Untracked noteOff — route to first matching without modifying counters
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }
              // On noteOn: pick least loaded and track assignment (FIFO queue for re-triggers)
              let bestSeg = matching[0];
              let bestIdx = 0;
              let bestCount = Infinity;
              for (let i = 0; i < matching.length; i++) {
                const segKey = `${matching[i].device}_${matching[i].targetChannel}`;
                const count = this._segmentNoteCounts.get(segKey) || 0;
                if (count < bestCount) { bestCount = count; bestSeg = matching[i]; bestIdx = i; }
              }
              const segKey = `${bestSeg.device}_${bestSeg.targetChannel}`;
              this._segmentNoteCounts.set(segKey, (this._segmentNoteCounts.get(segKey) || 0) + 1);
              const noteKey = `${channel}_${note}_seg`;
              if (!this._overlapNoteAssign.has(noteKey)) this._overlapNoteAssign.set(noteKey, []);
              this._overlapNoteAssign.get(noteKey).push(bestIdx);
              return { device: bestSeg.device, targetChannel: bestSeg.targetChannel };
            }

            if (strategy === 'overflow') {
              // Overflow: primary instrument (first segment) plays until its polyphony is full,
              // then excess notes go to secondary instrument (second segment).
              if (!this._segmentNoteCounts) this._segmentNoteCounts = new Map();
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();
              const primarySeg = matching[0];
              const primaryKey = `${primarySeg.device}_${primarySeg.targetChannel}`;

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const noteKey = `${channel}_${note}_seg`;
                const assignQueue = this._overlapNoteAssign.get(noteKey);
                if (assignQueue && assignQueue.length > 0) {
                  const assignedIdx = assignQueue.shift();
                  if (assignQueue.length === 0) this._overlapNoteAssign.delete(noteKey);
                  if (matching[assignedIdx]) {
                    const seg = matching[assignedIdx];
                    const sKey = `${seg.device}_${seg.targetChannel}`;
                    const count = this._segmentNoteCounts.get(sKey) || 0;
                    if (count > 0) this._segmentNoteCounts.set(sKey, count - 1);
                    return { device: seg.device, targetChannel: seg.targetChannel };
                  }
                }
                return { device: primarySeg.device, targetChannel: primarySeg.targetChannel };
              }

              // noteOn: check if primary has capacity
              const activeCount = this._segmentNoteCounts.get(primaryKey) || 0;
              const primaryPolyLimit = primarySeg.polyphonyShare ?? 16;
              if (activeCount >= primaryPolyLimit && matching.length > 1) {
                // Overflow to secondary
                const overflowSeg = matching[1];
                const oKey = `${overflowSeg.device}_${overflowSeg.targetChannel}`;
                this._segmentNoteCounts.set(oKey, (this._segmentNoteCounts.get(oKey) || 0) + 1);
                const noteKey = `${channel}_${note}_seg`;
                if (!this._overlapNoteAssign.has(noteKey)) this._overlapNoteAssign.set(noteKey, []);
                this._overlapNoteAssign.get(noteKey).push(1);
                return { device: overflowSeg.device, targetChannel: overflowSeg.targetChannel };
              }
              // Route to primary
              this._segmentNoteCounts.set(primaryKey, activeCount + 1);
              const noteKeyPrimary = `${channel}_${note}_seg`;
              if (!this._overlapNoteAssign.has(noteKeyPrimary)) this._overlapNoteAssign.set(noteKeyPrimary, []);
              this._overlapNoteAssign.get(noteKeyPrimary).push(0);
              return { device: primarySeg.device, targetChannel: primarySeg.targetChannel };
            }

            if (strategy === 'alternate') {
              // Alternate: global round-robin counter per channel (not per note pitch).
              // Each noteOn increments and picks next instrument, regardless of which note.
              if (!this._alternateCounters) this._alternateCounters = new Map();
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const noteKey = `${channel}_${note}_seg`;
                const assignQueue = this._overlapNoteAssign.get(noteKey);
                if (assignQueue && assignQueue.length > 0) {
                  const assignedIdx = assignQueue.shift();
                  if (assignQueue.length === 0) this._overlapNoteAssign.delete(noteKey);
                  if (matching[assignedIdx]) {
                    const seg = matching[assignedIdx];
                    return { device: seg.device, targetChannel: seg.targetChannel };
                  }
                }
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }

              // noteOn: increment global channel counter and record assignment (FIFO queue for re-triggers)
              const counter = this._alternateCounters.get(channel) || 0;
              this._alternateCounters.set(channel, counter + 1);
              const segIdx = counter % matching.length;
              const seg = matching[segIdx];
              const noteKey = `${channel}_${note}_seg`;
              if (!this._overlapNoteAssign.has(noteKey)) this._overlapNoteAssign.set(noteKey, []);
              this._overlapNoteAssign.get(noteKey).push(segIdx);
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            // Default: 'first' — first matching segment wins
            return { device: matching[0].device, targetChannel: matching[0].targetChannel };
          }

          // Note outside all ranges: route to closest segment
          let closest = routing.segments[0];
          let minDist = Infinity;
          for (const seg of routing.segments) {
            const dist = Math.min(Math.abs(note - seg.noteMin), Math.abs(note - seg.noteMax));
            if (dist < minDist) { minDist = dist; closest = seg; }
          }
          return { device: closest.device, targetChannel: closest.targetChannel };
        }
        // No note specified (CC, pitchBend, etc.) → return all segments for broadcast
        return routing.segments.map(seg => ({ device: seg.device, targetChannel: seg.targetChannel }));
      }

      return routing;
    }

    if (this.channelRouting.size > 0) {
      return null;
    }

    return { device: this.outputDevice, targetChannel: channel };
  }

  /**
   * @param {number} channel
   * @returns {void}
   */
  muteChannel(channel) {
    this.mutedChannels.add(channel);
    this.logger.info(`Channel ${channel + 1} muted`);

    if (this.outputDevice) {
      const routing = this.getOutputForChannel(channel);
      if (Array.isArray(routing)) {
        // Split routing: send All Notes Off to each segment
        for (const seg of routing) {
          if (seg && seg.device) {
            this._deps.deviceManager.sendMessage(seg.device, 'cc', {
              channel: seg.targetChannel,
              controller: MIDI_CC_ALL_NOTES_OFF,
              value: 0
            });
          }
        }
      } else if (routing && routing.device) {
        this._deps.deviceManager.sendMessage(routing.device, 'cc', {
          channel: routing.targetChannel,
          controller: MIDI_CC_ALL_NOTES_OFF,
          value: 0
        });
      }
    }
  }

  /**
   * @param {number} channel
   * @returns {void}
   */
  unmuteChannel(channel) {
    this.mutedChannels.delete(channel);
    this.logger.info(`Channel ${channel + 1} unmuted`);
  }

  /**
   * @param {number} channel
   * @returns {boolean}
   */
  isChannelMuted(channel) {
    return this.mutedChannels.has(channel);
  }

  /** @returns {number[]} Sorted list of currently muted channels. */
  getMutedChannels() {
    return Array.from(this.mutedChannels);
  }

  // ==================== QUEUE / PLAYLIST ====================

  /**
   * Replace the playback queue. Used by playlist commands and the
   * editor to enqueue a single file.
   *
   * @param {Array<{fileId:(string|number), filename:string}>} items
   * @param {boolean} loop - When true, restart from the first item on
   *   end-of-queue.
   * @param {?(string|number)} playlistId - Source playlist id, used for
   *   broadcast events.
   * @param {{gapSeconds?:number, shuffle?:boolean}} [options]
   * @returns {void}
   */
  setQueue(items, loop, playlistId, options = {}) {
    this.queue = items.map(item => ({ fileId: item.fileId, filename: item.filename }));
    this.queueIndex = -1;
    this.queueLoop = !!loop;
    this.playlistId = playlistId || null;
    this.queueGapSeconds = options.gapSeconds || 0;
    this.queueShuffle = !!options.shuffle;

    if (this.queueShuffle && this.queue.length > 1) {
      this._shuffleQueue();
    }

    this.logger.info(`Queue set: ${items.length} items, loop=${this.queueLoop}, shuffle=${this.queueShuffle}, gap=${this.queueGapSeconds}s, playlist=${this.playlistId}`);
  }

  /**
   * Drop every queue entry, cancel any pending gap timer, and reset
   * queue state. Does NOT stop the currently playing file.
   *
   * @returns {void}
   */
  clearQueue() {
    this._clearGapTimer();
    this.queue = [];
    this.queueIndex = -1;
    this.queueLoop = false;
    this.playlistId = null;
    this.queueGapSeconds = 0;
    this.queueShuffle = false;
    this.logger.info('Queue cleared');
  }

  /**
   * @returns {{active:boolean, playlistId:?(string|number), index:number,
   *   total:number, loop:boolean, shuffle:boolean, gapSeconds:number,
   *   gapRemaining?:number}} Snapshot of the queue runtime state.
   */
  getQueueStatus() {
    return {
      active: this.queue.length > 0 && this.queueIndex >= 0,
      playlistId: this.playlistId,
      items: this.queue,
      currentIndex: this.queueIndex,
      totalItems: this.queue.length,
      loop: this.queueLoop,
      gapSeconds: this.queueGapSeconds,
      shuffle: this.queueShuffle,
      waiting: this._gapTimer !== null,
      waitingRemaining: this._gapRemaining,
      currentFile: this.queueIndex >= 0 && this.queueIndex < this.queue.length
        ? this.queue[this.queueIndex]
        : null
    };
  }

  _clearGapTimer() {
    if (this._gapTimer) {
      clearTimeout(this._gapTimer);
      this._gapTimer = null;
    }
    if (this._gapCountdownInterval) {
      clearInterval(this._gapCountdownInterval);
      this._gapCountdownInterval = null;
    }
    this._gapRemaining = 0;
  }

  _startGapDelay(callback) {
    this._gapRemaining = this.queueGapSeconds;

    if (this._deps.wsServer) {
      this._deps.wsServer.broadcast('playlist_waiting', {
        playlistId: this.playlistId,
        remainingSeconds: this._gapRemaining
      });
    }

    this._gapCountdownInterval = setInterval(() => {
      this._gapRemaining--;
      if (this._deps.wsServer && this._gapRemaining > 0) {
        this._deps.wsServer.broadcast('playlist_waiting', {
          playlistId: this.playlistId,
          remainingSeconds: this._gapRemaining
        });
      }
    }, 1000);

    this._gapTimer = setTimeout(() => {
      this._clearGapTimer();
      callback();
    }, this.queueGapSeconds * 1000);

    this.logger.info(`Gap delay started: ${this.queueGapSeconds}s before next file`);
  }

  _shuffleQueue() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /**
   * Load + start the queue item at `index` (0-based). When `index` is
   * out of range, the queue is considered finished and
   * `_handleFileEnd` is called.
   *
   * @param {number} index
   * @returns {Promise<void>}
   */
  async playQueueItem(index) {
    if (index < 0 || index >= this.queue.length) {
      throw new Error(`Queue index out of range: ${index}`);
    }

    // Cancel any pending gap timer
    this._clearGapTimer();

    // Stop current playback if any
    if (this.playing) {
      this.playing = false;
      this.paused = false;
      this.scheduler.stopScheduler();
      this.sendAllNotesOff();
    }

    this.queueIndex = index;
    const item = this.queue[index];

    // Load file
    await this.loadFile(item.fileId);

    // Auto-load saved routings from database
    this._loadRoutingsFromDB(item.fileId);

    // Determine output device
    let outputDevice = this.outputDevice;
    if (!outputDevice) {
      const devices = this._deps.deviceManager.getDeviceList();
      const outputDevices = devices.filter(d => d.output && d.enabled);
      if (outputDevices.length === 0) {
        throw new Error('No output devices available');
      }
      outputDevice = outputDevices[0].id;
    }

    // Start playback
    this.start(outputDevice);

    // Broadcast queue item change
    if (this._deps.wsServer) {
      this._deps.wsServer.broadcast('playlist_item_changed', {
        playlistId: this.playlistId,
        index: this.queueIndex,
        totalItems: this.queue.length,
        fileId: item.fileId,
        filename: item.filename
      });
    }

    this.logger.info(`Playing queue item ${index + 1}/${this.queue.length}: ${item.filename}`);
  }

  /**
   * Advance to the next queue item, wrapping when `queueLoop` is true.
   *
   * @returns {Promise<void>}
   */
  async nextInQueue() {
    if (this.queue.length === 0) return;

    const nextIndex = this.queueIndex + 1;
    if (nextIndex >= this.queue.length) {
      if (this.queueLoop) {
        if (this.queueShuffle && this.queue.length > 1) {
          this._shuffleQueue();
        }
        await this.playQueueItem(0);
      } else {
        // End of queue
        this.stop();
        if (this._deps.wsServer) {
          this._deps.wsServer.broadcast('playlist_ended', {
            playlistId: this.playlistId
          });
        }
        this.logger.info('Playlist ended');
      }
    } else {
      await this.playQueueItem(nextIndex);
    }
  }

  /**
   * Step back to the previous queue item; clamps at index 0.
   *
   * @returns {Promise<void>}
   */
  async previousInQueue() {
    if (this.queue.length === 0) return;

    const prevIndex = this.queueIndex - 1;
    if (prevIndex < 0) {
      if (this.queueLoop) {
        await this.playQueueItem(this.queue.length - 1);
      } else {
        // Already at start, restart current
        await this.playQueueItem(0);
      }
    } else {
      await this.playQueueItem(prevIndex);
    }
  }

  /**
   * Handle end of file: advance queue or stop.
   * Called by PlaybackScheduler when all events have been played.
   * Uses _fileEndPending flag to prevent multiple concurrent invocations
   * (scheduler ticks can fire before async queue advance completes).
   */
  async _handleFileEnd() {
    if (this._fileEndPending) {
      return;
    }
    this._fileEndPending = true;

    try {
      if (this.loop) {
        // Single file loop
        this.seek(0);
      } else if (this.queue.length > 0) {
        if (this.queueGapSeconds > 0) {
          // Stop current playback during gap
          this.playing = false;
          this.paused = false;
          this.scheduler.stopScheduler();
          this.sendAllNotesOff();
          // Stop MIDI clock during gap between queue items
          if (this.midiClockGenerator) {
            this.midiClockGenerator.stopPlayback();
          }
          this.broadcastStatus();
          // Release pending flag before starting async timer
          this._fileEndPending = false;
          this._startGapDelay(() => {
            this.nextInQueue().catch(err => {
              this.logger.error(`Failed to advance queue after gap: ${err.message}`);
              this.stop();
            });
          });
          return; // _fileEndPending already cleared
        }
        // No gap: advance immediately
        await this.nextInQueue();
      } else {
        this.stop();
      }
    } catch (error) {
      this.logger.error(`Failed to handle file end: ${error.message}`);
      this.stop();
    } finally {
      this._fileEndPending = false;
    }
  }

  /**
   * Load saved channel routings from database for a file.
   * Replicates the logic from PlaybackCommands.playbackStart.
   */
  _loadRoutingsFromDB(fileId) {
    try {
      const savedRoutings = this.database.getRoutingsByFile(fileId);
      if (savedRoutings.length > 0) {
        this.clearChannelRouting();
        let loadedCount = 0;
        for (const routing of savedRoutings) {
          if (routing.channel !== null && routing.channel !== undefined && routing.device_id) {
            const targetChannel = routing.target_channel !== undefined ? routing.target_channel : routing.channel;
            this.setChannelRouting(routing.channel, routing.device_id, targetChannel);
            loadedCount++;
          }
        }
        this.logger.info(`Auto-loaded ${loadedCount} routings for file ${fileId}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to load routings for file ${fileId}: ${error.message}`);
    }
  }
}

export default MidiPlayer;
