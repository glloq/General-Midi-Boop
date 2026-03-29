// src/midi/MidiPlayer.js
import { parseMidi } from 'midi-file';
import { performance } from 'perf_hooks';
import PlaybackScheduler from './PlaybackScheduler.js';

// Playback timing constants
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
    this.startTime = 0;
    this.pauseTime = 0;
    this.outputDevice = null;
    this.loop = false;
    this.loadedFileId = null; // ID of currently loaded file
    this.channels = []; // MIDI channels found in file
    this.channelRouting = new Map(); // channel -> { device, targetChannel } mapping
    this.mutedChannels = new Set(); // Muted channels

    // Delegate scheduling, timing compensation, and event sending to PlaybackScheduler
    this.scheduler = new PlaybackScheduler(app);

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

    midi.tracks.forEach((track, trackIndex) => {
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

    this.app.logger.info(`Found ${this.channels.length} MIDI channels: ${this.channels.map(c => c.channelDisplay).join(', ')}`);
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
        }
      });
    });

    this.events.sort((a, b) => a.time - b.time);
  }

  /**
   * Inject CC events (string select + fret select) from tablature data.
   */
  _injectTablatureCCEvents() {
    if (!this.loadedFileId || !this.app.database) return;

    let tablatures;
    try {
      tablatures = this.app.database.getTablaturesByFile(this.loadedFileId);
    } catch (error) {
      this.app.logger.debug(`No tablature data for file ${this.loadedFileId}: ${error.message}`);
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
        instrument = this.app.database.stringInstrumentDB.getStringInstrumentById(tab.string_instrument_id);
      } catch (e) {
        this.app.logger.debug(`Skipping tablature CC: instrument lookup failed for ID ${tab.string_instrument_id}`);
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
      this.app.logger.info(`Injected ${ccEvents.length} tablature CC events for ${tabByChannel.size} channel(s)`);
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
      this.app.logger.warn('Player already playing');
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
    this.broadcastStatus();

    this.app.logger.info(`Playback started on ${outputDevice} at position ${this.position.toFixed(2)}s`);
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
      _lastBroadcastPosition: this._lastBroadcastPosition
    };

    const newIndex = this.scheduler.tick(
      state,
      (channel) => this.getOutputForChannel(channel),
      {
        onStop: () => this.stop(),
        onSeek: (pos) => this.seek(pos),
        onBroadcastPosition: () => this.broadcastPosition()
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
    this.scheduler.startScheduler(() => {
      this._schedulerTick();
    });
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
    this.scheduler.stopScheduler();
    this.sendAllNotesOff();
    this.broadcastStatus();
    this.app.logger.info('Playback stopped');
  }

  destroy() {
    this.stop();
    this.scheduler.destroy();
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
    const target = (targetChannel !== undefined && targetChannel !== null) ? targetChannel : channel;
    this.channelRouting.set(channel, { device: deviceId, targetChannel: target });
    this.app.logger.info(`Channel ${channel + 1} routed to ${deviceId} (target ch ${target + 1})`);

    this.scheduler.invalidateCompensationCache();

    const channelInfo = this.channels.find(c => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = deviceId;
    }
  }

  /**
   * Set split routing: one channel → multiple instruments based on note ranges
   * @param {number} channel - Source MIDI channel
   * @param {Array<Object>} segments - [{ device_id, target_channel, split_note_min, split_note_max }]
   */
  setChannelSplitRouting(channel, segments) {
    const splitRouting = {
      split: true,
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

    this.app.logger.info(`Channel ${channel + 1} split across ${segments.length} instruments`);
  }

  clearChannelRouting() {
    this.channelRouting.clear();
    this.scheduler.invalidateCompensationCache();
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

  /**
   * Get output routing for a channel, optionally considering the note for split routing
   * @param {number} channel
   * @param {number|null} [note=null] - MIDI note number (for split routing)
   * @returns {Object|Array|null} - { device, targetChannel } or array for broadcast, or null if muted
   */
  getOutputForChannel(channel, note = null) {
    if (this.channelRouting.has(channel)) {
      const routing = this.channelRouting.get(channel);

      // Legacy string format
      if (typeof routing === 'string') {
        return { device: routing, targetChannel: channel };
      }

      // Split routing: route based on note
      if (routing.split && routing.segments) {
        if (note !== null) {
          // Find segment covering this note
          for (const seg of routing.segments) {
            if (note >= seg.noteMin && note <= seg.noteMax) {
              return { device: seg.device, targetChannel: seg.targetChannel };
            }
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
    this.app.logger.info(`Channel ${channel + 1} muted`);

    if (this.outputDevice) {
      const routing = this.getOutputForChannel(channel);
      if (Array.isArray(routing)) {
        // Split routing: send All Notes Off to each segment
        for (const seg of routing) {
          if (seg && seg.device) {
            this.app.deviceManager.sendMessage(seg.device, 'cc', {
              channel: seg.targetChannel,
              controller: MIDI_CC_ALL_NOTES_OFF,
              value: 0
            });
          }
        }
      } else if (routing && routing.device) {
        this.app.deviceManager.sendMessage(routing.device, 'cc', {
          channel: routing.targetChannel,
          controller: MIDI_CC_ALL_NOTES_OFF,
          value: 0
        });
      }
    }
  }

  unmuteChannel(channel) {
    this.mutedChannels.delete(channel);
    this.app.logger.info(`Channel ${channel + 1} unmuted`);
  }

  isChannelMuted(channel) {
    return this.mutedChannels.has(channel);
  }

  getMutedChannels() {
    return Array.from(this.mutedChannels);
  }
}

export default MidiPlayer;
