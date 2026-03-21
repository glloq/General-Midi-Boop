// src/midi/MidiPlayer.js
import { parseMidi } from 'midi-file';
import { performance } from 'perf_hooks';

// Playback timing constants
const SCHEDULER_TICK_MS = 10; // Scheduler resolution in milliseconds
const LOOKAHEAD_SECONDS = 0.1; // Base look-ahead window for event scheduling (100ms)
const MAX_COMPENSATION_MS = 5000; // Maximum allowed compensation in milliseconds (5s)
const MICROSECONDS_PER_MINUTE = 60000000; // For tempo conversion

// MIDI CC constants
const MIDI_CC_ALL_NOTES_OFF = 123;

class MidiPlayer {
  constructor(app) {
    this.app = app;
    this.playing = false;
    this.paused = false;
    this.position = 0; // seconds
    this.duration = 0; // seconds
    this.tempo = 120; // BPM
    this.ppq = 480; // Pulses per quarter note
    this.tracks = [];
    this.events = [];
    this.currentEventIndex = 0;
    this.scheduler = null;
    this.startTime = 0;
    this.pauseTime = 0;
    this.outputDevice = null;
    this.loop = false;
    this.loadedFileId = null; // ID of currently loaded file
    this.channels = []; // MIDI channels found in file
    this.channelRouting = new Map(); // channel -> { device, targetChannel } mapping
    this.mutedChannels = new Set(); // Muted channels
    this.pendingTimeouts = new Set(); // Track scheduled setTimeout IDs for cleanup
    this._syncDelayCache = new Map(); // Cache sync_delay per device to avoid DB queries per event
    this._failedDevices = new Set(); // Track devices that failed to send (notify once per playback)
    this._maxCompensationMs = 0; // Cached max compensation across all active routings

    // Invalidate sync_delay cache immediately when instrument settings change
    this._onSettingsChanged = () => {
      this._syncDelayCache.clear();
      this._maxCompensationMs = 0;
    };
    this.app.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);

    this.app.logger.info('MidiPlayer initialized');
  }

  async loadFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }
      if (!file.data) {
        throw new Error(`File ${fileId} (${file.filename}) has no MIDI data`);
      }

      const buffer = Buffer.from(file.data, 'base64');
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

      this.app.logger.info(`File loaded: ${file.filename} (${this.events.length} events, ${this.duration.toFixed(2)}s)`);

      return {
        filename: file.filename,
        duration: this.duration,
        tracks: this.tracks.length,
        events: this.events.length,
        tempo: this.tempo,
        channels: this.channels
      };
    } catch (error) {
      this.app.logger.error(`Failed to load file: ${error.message}`);
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
    // Find first tempo event
    for (const track of midi.tracks) {
      const tempoEvent = track.find(e => e.type === 'setTempo');
      if (tempoEvent) {
        this.tempo = MICROSECONDS_PER_MINUTE / tempoEvent.microsecondsPerBeat;
        return;
      }
    }
    this.tempo = 120; // Default tempo
  }

  extractChannels(midi) {
    // Extract all MIDI channels used in the file
    const channelsSet = new Set();

    midi.tracks.forEach((track, trackIndex) => {
      track.forEach(event => {
        if (event.channel !== undefined) {
          channelsSet.add(event.channel);
        }
      });
    });

    // Convert to array and create channel info
    this.channels = Array.from(channelsSet).sort((a, b) => a - b).map(channel => {
      // Find which track(s) use this channel
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
        channelDisplay: channel + 1, // MIDI channels are 0-indexed, display as 1-16
        tracks: tracksUsingChannel,
        assignedDevice: null // Will be set by user
      };
    });

    this.app.logger.info(`Found ${this.channels.length} MIDI channels: ${this.channels.map(c => c.channelDisplay).join(', ')}`);
  }

  buildEventList() {
    this.events = [];

    // Build tempo map from all tracks (tempo events are typically on track 0)
    const tempoMap = this._buildTempoMap();

    // Combine all tracks into single event list
    this.tracks.forEach(track => {
      let trackTicks = 0;
      track.events.forEach(event => {
        trackTicks += event.deltaTime;

        // Convert ticks to seconds using tempo map
        const timeInSeconds = this._ticksToSecondsWithTempoMap(trackTicks, tempoMap);

        // Include note events, CC, and pitch bend
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
        }
      });
    });

    // Sort events by time
    this.events.sort((a, b) => a.time - b.time);
  }

  /**
   * Inject CC20 (string select) and CC21 (fret select) events from tablature data.
   * Called after buildEventList() and loadedFileId is set.
   * For each noteOn on a channel with tablature, inserts CC events just before the note.
   */
  _injectTablatureCCEvents() {
    if (!this.loadedFileId || !this.app.database) return;

    const CC_STRING_SELECT = 20;
    const CC_FRET_SELECT = 21;

    let tablatures;
    try {
      tablatures = this.app.database.getTablaturesByFile(this.loadedFileId);
    } catch (error) {
      this.app.logger.debug(`No tablature data for file ${this.loadedFileId}: ${error.message}`);
      return;
    }

    if (!tablatures || tablatures.length === 0) return;

    const tempoMap = this._buildTempoMap();

    // Build lookup: channel -> array of {time, string, fret, midiNote}
    const tabByChannel = new Map();

    for (const tab of tablatures) {
      if (!Array.isArray(tab.tablature_data) || tab.tablature_data.length === 0) continue;

      // Skip if the instrument has CC generation disabled
      if (tab.string_instrument_id) {
        try {
          const instrument = this.app.database.stringInstrumentDB.getStringInstrumentById(tab.string_instrument_id);
          if (instrument && instrument.cc_enabled === false) continue;
        } catch (e) { /* ignore lookup errors */ }
      }

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

      tabByChannel.set(channel, events);
    }

    // For each noteOn, find matching tab event and inject CC20+CC21 just before it
    const ccEvents = [];
    const EPSILON = 0.0001; // CC events 0.1ms before noteOn

    for (const event of this.events) {
      if (event.type !== 'noteOn' || event.velocity === 0) continue;

      const tabEvents = tabByChannel.get(event.channel);
      if (!tabEvents) continue;

      // Find matching tab event (closest time + same MIDI note)
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

      // Match within 50ms tolerance
      if (bestMatch && bestTimeDiff < 0.05) {
        ccEvents.push({
          time: event.time - EPSILON,
          type: 'controller',
          channel: event.channel,
          controller: CC_STRING_SELECT,
          value: Math.min(127, Math.max(0, bestMatch.string))
        });
        ccEvents.push({
          time: event.time - EPSILON,
          type: 'controller',
          channel: event.channel,
          controller: CC_FRET_SELECT,
          value: Math.min(127, Math.max(0, Math.round(bestMatch.fret)))
        });
      }
    }

    if (ccEvents.length > 0) {
      this.events.push(...ccEvents);
      this.events.sort((a, b) => a.time - b.time);
      this.app.logger.info(`Injected ${ccEvents.length} tablature CC events (CC20/CC21) for ${tabByChannel.size} channel(s)`);
    }
  }

  _buildTempoMap() {
    // Collect all tempo change events with their absolute tick positions
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

    // Sort by tick position
    tempoEvents.sort((a, b) => a.tick - b.tick);

    // Build tempo map with cumulative time at each tempo change
    const tempoMap = [];
    let cumulativeSeconds = 0;
    let lastTick = 0;
    let currentMicrosecondsPerBeat = MICROSECONDS_PER_MINUTE / this.tempo; // default

    for (const te of tempoEvents) {
      // Calculate time elapsed since last tempo change at the previous tempo
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

    // If no tempo events found, use default
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
    // Find the last tempo change at or before this tick position
    let activeEntry = { tick: 0, time: 0, microsecondsPerBeat: MICROSECONDS_PER_MINUTE / this.tempo };

    for (const entry of tempoMap) {
      if (entry.tick <= ticks) {
        activeEntry = entry;
      } else {
        break;
      }
    }

    // Calculate time from the active tempo change point to this tick
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
      this.app.logger.warn('Player already playing');
      return;
    }

    if (!outputDevice) {
      throw new Error('Output device required');
    }

    this.outputDevice = outputDevice;
    this.playing = true;
    this.paused = false;

    // When resuming from seek, preserve the seeked position
    if (resumePosition !== null) {
      this.position = resumePosition;
      this.currentEventIndex = this.findEventIndexAtTime(resumePosition);
      this.startTime = performance.now() - (resumePosition * 1000);
    } else {
      this.position = 0;
      this.currentEventIndex = 0;
      this.startTime = performance.now();
    }

    this._syncDelayCache.clear(); // Refresh sync_delay cache on each playback start
    this._failedDevices.clear(); // Reset failed device tracking
    this._maxCompensationMs = 0; // Reset max compensation cache

    this.startScheduler();
    this.broadcastStatus();

    this.app.logger.info(`Playback started on ${outputDevice} at position ${this.position.toFixed(2)}s`);
  }

  pause() {
    if (!this.playing || this.paused) {
      return;
    }

    this.paused = true;
    this.pauseTime = performance.now();
    this.stopScheduler();

    // Send all notes off to avoid stuck notes
    this.sendAllNotesOff();

    this.broadcastStatus();

    this.app.logger.info('Playback paused');
  }

  resume() {
    if (!this.playing || !this.paused) {
      return;
    }

    this.paused = false;
    const pauseDuration = performance.now() - this.pauseTime;
    this.startTime += pauseDuration;
    this.startScheduler();
    this.broadcastStatus();
    
    this.app.logger.info('Playback resumed');
  }

  stop() {
    if (!this.playing) {
      return;
    }

    this.playing = false;
    this.paused = false;
    this.position = 0;
    this.currentEventIndex = 0;
    this._lastBroadcastPosition = undefined;
    this.stopScheduler();
    
    // Send all notes off
    this.sendAllNotesOff();
    
    this.broadcastStatus();
    this.app.logger.info('Playback stopped');
  }

  destroy() {
    this.stop();
    this._syncDelayCache.clear();
    if (this._onSettingsChanged) {
      this.app.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
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
      // Stop scheduler and notes without broadcasting position=0
      this.stopScheduler();
      this.sendAllNotesOff();
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

  findEventIndexAtTime(time) {
    // Binary search — events are sorted by time
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

  startScheduler() {
    this.scheduler = setInterval(() => {
      this.tick();
    }, SCHEDULER_TICK_MS);
  }

  stopScheduler() {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
    // Clear all pending event timeouts to prevent stale events
    for (const timeoutId of this.pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    this.pendingTimeouts.clear();
  }

  tick() {
    if (!this.playing || this.paused) {
      return;
    }

    // Update position
    const elapsed = (performance.now() - this.startTime) / 1000;
    this.position = elapsed;

    // Check if reached end
    if (this.position >= this.duration) {
      if (this.loop) {
        this.seek(0);
      } else {
        this.stop();
      }
      return;
    }

    // Dynamic lookahead: extend beyond base to accommodate large sync_delay compensations
    const maxCompSec = this._getMaxActiveCompensation() / 1000;
    const targetTime = this.position + LOOKAHEAD_SECONDS + maxCompSec;

    while (this.currentEventIndex < this.events.length) {
      const event = this.events[this.currentEventIndex];
      
      if (event.time > targetTime) {
        break;
      }

      this.scheduleEvent(event);
      this.currentEventIndex++;
    }

    // Broadcast position update (every 100ms = every 10th tick at 10ms resolution)
    if (this._lastBroadcastPosition === undefined ||
        Math.floor(this.position * 10) !== Math.floor(this._lastBroadcastPosition * 10)) {
      this._lastBroadcastPosition = this.position;
      this.broadcastPosition();
    }
  }

  /**
   * Get max compensation across all active channel routings (cached per playback session).
   * Used to extend the lookahead window so high-compensation events are scheduled early enough.
   * @returns {number} Maximum compensation in milliseconds
   */
  _getMaxActiveCompensation() {
    if (this._maxCompensationMs > 0) {
      return this._maxCompensationMs;
    }
    let maxComp = 0;
    for (const [channel, routing] of this.channelRouting) {
      const device = typeof routing === 'string' ? routing : routing.device;
      const targetCh = typeof routing === 'string' ? channel : routing.targetChannel;
      const comp = this._getSyncDelay(device, targetCh);
      if (comp > maxComp) maxComp = comp;
    }
    this._maxCompensationMs = maxComp;
    return maxComp;
  }

  /**
   * Get total timing compensation for a device+channel in milliseconds.
   * Combines:
   *   - sync_delay (user-configured per instrument, in ms, from instruments_latency table)
   *   - hardware latency (measured via LatencyCompensator loopback test, in ms)
   * Positive value = send event earlier to compensate for device/instrument delay.
   * Clamped to MAX_COMPENSATION_MS to prevent runaway delays.
   */
  _getSyncDelay(deviceId, channel) {
    const cacheKey = channel !== undefined ? `${deviceId}_${channel}` : deviceId;
    if (this._syncDelayCache.has(cacheKey)) {
      return this._syncDelayCache.get(cacheKey);
    }

    let syncDelay = 0;

    // 1. User-configured sync_delay (per instrument/channel)
    if (this.app.database) {
      try {
        const settings = this.app.database.getInstrumentSettings(deviceId, channel);
        if (settings && settings.sync_delay !== undefined && settings.sync_delay !== null) {
          syncDelay = settings.sync_delay;
        }
      } catch (error) {
        this.app.logger.warn(`Failed to get sync_delay for device ${deviceId}: ${error.message}`);
      }
    }

    // 2. Add measured hardware latency (from LatencyCompensator loopback test)
    if (this.app.latencyCompensator) {
      const hwLatency = this.app.latencyCompensator.getLatency(deviceId);
      if (hwLatency > 0) {
        syncDelay += hwLatency;
      }
    }

    // Clamp to maximum allowed compensation
    if (syncDelay > MAX_COMPENSATION_MS) {
      this.app.logger.warn(`Compensation ${syncDelay.toFixed(0)}ms for device ${deviceId} ch ${channel} exceeds max ${MAX_COMPENSATION_MS}ms, clamping`);
      syncDelay = MAX_COMPENSATION_MS;
    }

    if (syncDelay !== 0) {
      this.app.logger.debug(`Total compensation ${syncDelay.toFixed(1)}ms for device ${deviceId} ch ${channel}`);
    }

    this._syncDelayCache.set(cacheKey, syncDelay);
    return syncDelay;
  }

  scheduleEvent(event) {
    const eventTime = event.time;
    const currentTime = this.position;
    const delay = Math.max(0, eventTime - currentTime);

    // Get the target device + channel for this source channel BEFORE calculating latency
    const routing = this.getOutputForChannel(event.channel);

    if (!routing || !routing.device) {
      this.app.logger.warn(`No output device for channel ${event.channel + 1}, skipping event`);
      return;
    }

    // Get sync_delay from cache using device + targetChannel key
    const syncDelay = this._getSyncDelay(routing.device, routing.targetChannel);

    // Apply sync_delay compensation (convert ms to seconds)
    const adjustedDelay = Math.max(0, delay - (syncDelay / 1000));

    if (syncDelay > 0 && delay < syncDelay / 1000) {
      this.app.logger.debug(
        `Compensation ${syncDelay.toFixed(0)}ms exceeds delay ${(delay * 1000).toFixed(0)}ms for ch${event.channel + 1}, sending immediately`
      );
    }

    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(timeoutId);
      this.sendEvent(event);
    }, adjustedDelay * 1000);
    this.pendingTimeouts.add(timeoutId);
  }

  sendEvent(event) {
    if (!this.playing) {
      return;
    }

    // Skip muted channels
    if (this.mutedChannels.has(event.channel)) {
      return;
    }

    const device = this.app.deviceManager;
    // Use channel-specific routing if available
    const routing = this.getOutputForChannel(event.channel);

    if (!routing || !routing.device) {
      this.app.logger.warn(`No output device for channel ${event.channel + 1}`);
      return;
    }

    // Use targetChannel from routing (remaps source channel to instrument's actual MIDI channel)
    const outChannel = routing.targetChannel;
    let sendResult = true;

    if (event.type === 'noteOn') {
      // noteOn with velocity 0 is equivalent to noteOff per MIDI spec
      if (event.velocity === 0) {
        sendResult = device.sendMessage(routing.device, 'noteoff', {
          channel: outChannel,
          note: event.note,
          velocity: 0
        });
      } else {
        sendResult = device.sendMessage(routing.device, 'noteon', {
          channel: outChannel,
          note: event.note,
          velocity: event.velocity
        });
      }
    } else if (event.type === 'noteOff') {
      sendResult = device.sendMessage(routing.device, 'noteoff', {
        channel: outChannel,
        note: event.note,
        velocity: event.velocity
      });
    } else if (event.type === 'controller') {
      sendResult = device.sendMessage(routing.device, 'cc', {
        channel: outChannel,
        controller: event.controller,
        value: event.value
      });
    } else if (event.type === 'pitchBend') {
      sendResult = device.sendMessage(routing.device, 'pitchbend', {
        channel: outChannel,
        value: event.value
      });
    } else if (event.type === 'programChange') {
      sendResult = device.sendMessage(routing.device, 'program', {
        channel: outChannel,
        program: event.program
      });
    } else if (event.type === 'channelAftertouch') {
      sendResult = device.sendMessage(routing.device, 'channel aftertouch', {
        channel: outChannel,
        pressure: event.value
      });
    } else if (event.type === 'noteAftertouch') {
      sendResult = device.sendMessage(routing.device, 'poly aftertouch', {
        channel: outChannel,
        note: event.note,
        pressure: event.value
      });
    }

    // Notify once per device if send fails (device likely disconnected)
    if (!sendResult && !this._failedDevices.has(routing.device)) {
      this._failedDevices.add(routing.device);
      this.app.logger.warn(`Device unreachable during playback: ${routing.device}`);
      if (this.app.wsServer) {
        this.app.wsServer.broadcast('playback_device_error', {
          deviceId: routing.device,
          channel: event.channel,
          message: `Device ${routing.device} is unreachable`
        });
      }
    }
  }

  sendAllNotesOff() {
    if (!this.outputDevice) {
      return;
    }

    const device = this.app.deviceManager;

    // Build map of device → target channels actually routed to it
    // Only send All Notes Off on channels that are actively used, to avoid
    // silencing unrelated instruments on the same device
    const channelsPerDevice = new Map();

    for (const [sourceChannel, routing] of this.channelRouting) {
      const deviceName = typeof routing === 'string' ? routing : routing?.device;
      const targetChannel = typeof routing === 'string' ? sourceChannel : routing.targetChannel;
      if (!deviceName) continue;

      if (!channelsPerDevice.has(deviceName)) {
        channelsPerDevice.set(deviceName, new Set());
      }
      channelsPerDevice.get(deviceName).add(targetChannel);
    }

    // Also include channels from the MIDI file that use the default device (no explicit routing)
    for (const ch of this.channels) {
      if (!this.channelRouting.has(ch.channel)) {
        if (!channelsPerDevice.has(this.outputDevice)) {
          channelsPerDevice.set(this.outputDevice, new Set());
        }
        channelsPerDevice.get(this.outputDevice).add(ch.channel);
      }
    }

    // Send All Notes Off only on the channels actually routed to each device
    for (const [targetDevice, channels] of channelsPerDevice) {
      for (const channel of channels) {
        try {
          device.sendMessage(targetDevice, 'cc', {
            channel: channel,
            controller: MIDI_CC_ALL_NOTES_OFF,
            value: 0
          });
        } catch (err) {
          // Device may be disconnected; continue cleanup for other devices
        }
      }
    }
  }

  setLoop(enabled) {
    this.loop = enabled;
    this.app.logger.info(`Loop ${enabled ? 'enabled' : 'disabled'}`);
  }

  broadcastStatus() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('playback_status', {
        playing: this.playing,
        paused: this.paused,
        position: this.position,
        duration: this.duration,
        percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0,
        loop: this.loop
      });
    }
  }

  broadcastPosition() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('playback_position', {
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
    // targetChannel defaults to source channel for backward compatibility
    const target = (targetChannel !== undefined && targetChannel !== null) ? targetChannel : channel;
    this.channelRouting.set(channel, { device: deviceId, targetChannel: target });
    this.app.logger.info(`Channel ${channel + 1} routed to ${deviceId} (target ch ${target + 1})`);

    // Update channel info
    const channelInfo = this.channels.find(c => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = deviceId;
    }
  }

  clearChannelRouting() {
    this.channelRouting.clear();
    this.channels.forEach(c => c.assignedDevice = null);
    this.app.logger.info('All channel routing cleared');
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

  getOutputForChannel(channel) {
    // Get specific device + targetChannel for this channel
    if (this.channelRouting.has(channel)) {
      const routing = this.channelRouting.get(channel);
      // Support both old format (string) and new format ({ device, targetChannel })
      if (typeof routing === 'string') {
        return { device: routing, targetChannel: channel };
      }
      return routing;
    }

    // If explicit routings exist for other channels, do NOT send unrouted channels
    // to the default device — this prevents leaking events to instruments that
    // share the same device but weren't assigned this channel
    if (this.channelRouting.size > 0) {
      return null;
    }

    // No routing at all — use default device (legacy/simple mode)
    return { device: this.outputDevice, targetChannel: channel };
  }

  // Mute a channel
  muteChannel(channel) {
    this.mutedChannels.add(channel);
    this.app.logger.info(`Channel ${channel + 1} muted`);

    // Send All Notes Off for this channel to stop currently playing notes
    if (this.outputDevice) {
      const routing = this.getOutputForChannel(channel);
      if (routing && routing.device) {
        this.app.deviceManager.sendMessage(routing.device, 'cc', {
          channel: routing.targetChannel,
          controller: MIDI_CC_ALL_NOTES_OFF,
          value: 0
        });
      }
    }
  }

  // Unmute a channel
  unmuteChannel(channel) {
    this.mutedChannels.delete(channel);
    this.app.logger.info(`Channel ${channel + 1} unmuted`);
  }

  // Check if a channel is muted
  isChannelMuted(channel) {
    return this.mutedChannels.has(channel);
  }

  // Get all muted channels
  getMutedChannels() {
    return Array.from(this.mutedChannels);
  }
}

export default MidiPlayer;