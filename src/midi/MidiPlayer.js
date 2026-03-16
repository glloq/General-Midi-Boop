// src/midi/MidiPlayer.js
import { parseMidi } from 'midi-file';
import { performance } from 'perf_hooks';

// Playback timing constants
const SCHEDULER_TICK_MS = 10; // Scheduler resolution in milliseconds
const LOOKAHEAD_SECONDS = 0.1; // Look-ahead window for event scheduling (100ms)
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

    this.app.logger.info('MidiPlayer initialized');
  }

  async loadFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      const buffer = Buffer.from(file.data, 'base64');
      const midi = parseMidi(buffer);

      this.ppq = midi.header.ticksPerBeat || 480;
      this.parseTracks(midi);
      this.extractTempo(midi);
      this.extractChannels(midi);
      this.buildEventList();
      this.calculateDuration();
      this.loadedFileId = fileId;

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
        }
      });
    });

    // Sort events by time
    this.events.sort((a, b) => a.time - b.time);
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
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].time >= time) {
        return i;
      }
    }
    return this.events.length;
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

    // Process events
    const targetTime = this.position + LOOKAHEAD_SECONDS;

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
   * Get total timing compensation for a device+channel in milliseconds.
   * Combines:
   *   - sync_delay (user-configured per instrument, from instruments_latency table)
   *   - hardware latency (measured via LatencyCompensator loopback test)
   * Positive value = send event earlier to compensate for device/instrument delay.
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

    if (event.type === 'noteOn') {
      // noteOn with velocity 0 is equivalent to noteOff per MIDI spec
      if (event.velocity === 0) {
        device.sendMessage(routing.device, 'noteoff', {
          channel: outChannel,
          note: event.note,
          velocity: 0
        });
        return;
      }
      device.sendMessage(routing.device, 'noteon', {
        channel: outChannel,
        note: event.note,
        velocity: event.velocity
      });
    } else if (event.type === 'noteOff') {
      device.sendMessage(routing.device, 'noteoff', {
        channel: outChannel,
        note: event.note,
        velocity: event.velocity
      });
    } else if (event.type === 'controller') {
      device.sendMessage(routing.device, 'cc', {
        channel: outChannel,
        controller: event.controller,
        value: event.value
      });
    } else if (event.type === 'pitchBend') {
      device.sendMessage(routing.device, 'pitchbend', {
        channel: outChannel,
        value: event.value
      });
    } else if (event.type === 'programChange') {
      device.sendMessage(routing.device, 'program', {
        channel: outChannel,
        program: event.program
      });
    }
  }

  sendAllNotesOff() {
    if (!this.outputDevice) {
      return;
    }

    const device = this.app.deviceManager;

    // Collect all unique target devices (default + routed)
    const targetDevices = new Set([this.outputDevice]);
    for (const routing of this.channelRouting.values()) {
      const deviceName = typeof routing === 'string' ? routing : routing?.device;
      if (deviceName) targetDevices.add(deviceName);
    }

    // Send All Notes Off on all 16 MIDI channels to all target devices
    for (const targetDevice of targetDevices) {
      for (let channel = 0; channel < 16; channel++) {
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
    // Get specific device + targetChannel for this channel, or default device
    if (this.channelRouting.has(channel)) {
      const routing = this.channelRouting.get(channel);
      // Support both old format (string) and new format ({ device, targetChannel })
      if (typeof routing === 'string') {
        return { device: routing, targetChannel: channel };
      }
      return routing;
    }
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