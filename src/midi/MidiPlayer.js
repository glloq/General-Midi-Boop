// src/midi/MidiPlayer.js
import { parseMidi } from 'midi-file';
import { performance } from 'perf_hooks';
import PlaybackScheduler from './PlaybackScheduler.js';

// Playback timing constants
const MICROSECONDS_PER_MINUTE = 60000000; // For tempo conversion

// MIDI CC constants
const MIDI_CC_ALL_NOTES_OFF = 123;

class MidiPlayer {
  constructor(deps) {
    this.logger = deps.logger;
    this.database = deps.database;
    this._deps = deps; // For lazy resolution of wsServer, deviceManager
    this.playing = false;
    this.paused = false;
    this.position = 0; // seconds
    this.duration = 0; // seconds
    this.tempo = 120; // BPM
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
        return;
      }
    }
    this.tempo = 120;
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

  buildEventList() {
    this.events = [];
    const tempoMap = this._buildTempoMap();

    this.tracks.forEach(track => {
      let trackTicks = 0;
      track.events.forEach(event => {
        trackTicks += event.deltaTime;
        const timeInSeconds = this._ticksToSecondsWithTempoMap(trackTicks, tempoMap);

        if (event.type === 'noteOn' || event.type === 'noteOff') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            note: event.noteNumber,
            velocity: event.velocity
          });
        } else if (event.type === 'controller') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            controller: event.controllerType,
            value: event.value
          });
        } else if (event.type === 'pitchBend') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            value: event.value
          });
        } else if (event.type === 'programChange') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            program: event.programNumber !== undefined ? event.programNumber : event.value
          });
        } else if (event.type === 'channelAftertouch') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            value: event.value
          });
        } else if (event.type === 'noteAftertouch') {
          this.events.push({
            time: timeInSeconds,
            type: event.type,
            channel: event.channel !== undefined ? event.channel : 0,
            note: event.noteNumber,
            value: event.value
          });
        } else if (event.type === 'setTempo') {
          // Inject tempo change events so the scheduler can update MIDI clock
          const bpm = MICROSECONDS_PER_MINUTE / event.microsecondsPerBeat;
          this.events.push({
            time: timeInSeconds,
            type: 'setTempo',
            tempo: bpm
          });
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

  ticksToSeconds(ticks) {
    const beatsPerSecond = this.tempo / 60;
    const ticksPerSecond = beatsPerSecond * this.ppq;
    return ticks / ticksPerSecond;
  }

  calculateDuration() {
    if (this.events.length === 0) {
      this.duration = 0;
    } else {
      this.duration = this.events[this.events.length - 1].time;
    }
  }

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
      this.startTime = performance.now() - (resumePosition * 1000);
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
    this.scheduler.stopScheduler();
    this.sendAllNotesOff();

    // Stop MIDI clock
    if (this.midiClockGenerator) {
      this.midiClockGenerator.stopPlayback();
    }

    this.broadcastStatus();
    this.logger.info('Playback stopped');
  }

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

  sendAllNotesOff() {
    this.scheduler.sendAllNotesOff(this.outputDevice, this.channelRouting, this.channels);
  }

  setLoop(enabled) {
    this.loop = enabled;
    this.logger.info(`Loop ${enabled ? 'enabled' : 'disabled'}`);
  }

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

  broadcastPosition() {
    if (this._deps.wsServer) {
      this._deps.wsServer.broadcast('playback_position', {
        position: this.position,
        percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0
      });
    }
  }

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

  clearChannelRouting() {
    this.channelRouting.clear();
    this.scheduler.invalidateCompensationCache();
    this.channels.forEach(c => c.assignedDevice = null);
    this.logger.info('All channel routing cleared');
  }

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
              const key = `${channel}_${note}`;
              const counter = (this._overlapCounters.get(key) || 0);
              this._overlapCounters.set(key, counter + 1);
              const seg = matching[counter % matching.length];
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'second') {
              // Prefer last matching segment
              const seg = matching[matching.length - 1];
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'least_loaded') {
              // Route to segment with fewer active notes
              if (!this._segmentNoteCounts) this._segmentNoteCounts = new Map();
              // On noteOff: decrement and route to same segment as the noteOn did
              if (eventType === 'noteOff') {
                const noteKey = `${channel}_${note}_seg`;
                const assignedIdx = this._overlapNoteAssign?.get(noteKey);
                if (assignedIdx !== undefined && matching[assignedIdx]) {
                  const seg = matching[assignedIdx];
                  const segKey = `${seg.device}_${seg.targetChannel}`;
                  const count = this._segmentNoteCounts.get(segKey) || 0;
                  if (count > 0) this._segmentNoteCounts.set(segKey, count - 1);
                  this._overlapNoteAssign.delete(noteKey);
                  return { device: seg.device, targetChannel: seg.targetChannel };
                }
                // Untracked noteOff — route to first matching without modifying counters
                return { device: matching[0].device, targetChannel: matching[0].targetChannel };
              }
              // On noteOn: pick least loaded and track assignment
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
              if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();
              this._overlapNoteAssign.set(`${channel}_${note}_seg`, bestIdx);
              return { device: bestSeg.device, targetChannel: bestSeg.targetChannel };
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

  unmuteChannel(channel) {
    this.mutedChannels.delete(channel);
    this.logger.info(`Channel ${channel + 1} unmuted`);
  }

  isChannelMuted(channel) {
    return this.mutedChannels.has(channel);
  }

  getMutedChannels() {
    return Array.from(this.mutedChannels);
  }

  // ==================== QUEUE / PLAYLIST ====================

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
