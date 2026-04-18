/**
 * @file src/midi/PlaybackScheduler.js
 * @description Tick-driven event scheduler extracted from {@link MidiPlayer}.
 *
 * Owns the per-playback hot path:
 *   - 10 ms `setInterval` tick (`SCHEDULER_TICK_MS`) advances the position
 *     clock and queues every event up to `position + LOOKAHEAD_SECONDS +
 *     maxCompensation` via `setTimeout`.
 *   - Per-event `setTimeout` IDs are tracked in `pendingTimeouts` so
 *     {@link PlaybackScheduler#stopScheduler} can cancel everything in flight
 *     without leaking timers across stop/start cycles.
 *
 * Caches keyed by `device:channel`:
 *   - `_syncDelayCache` — combined user `sync_delay` + measured hardware
 *     latency, clamped to ±`MAX_COMPENSATION_MS`.
 *   - `_stringCCCache`  — whether CC 20/21 (string/fret select) should be
 *     forwarded for the target instrument.
 *   - `_timingConstraintCache` — `min_note_interval`, `min_note_duration`
 *     and `polyphony` from `instrumentCapabilitiesDB`.
 *
 * All caches are invalidated on `instrument_settings_changed` and at the
 * start of every playback via {@link PlaybackScheduler#resetForPlayback}
 * to prevent stale values from a previous file/routing.
 *
 * Disconnect policy (`state.disconnectedPolicy`): the first failed send to
 * a device is broadcast as `playback_device_disconnected` with policy
 * `pause` / `mute` / `skip`; subsequent failures on the same device are
 * silenced for the rest of the playback.
 */
import { performance } from 'perf_hooks';
import { TIMING, MIDI_CC } from '../constants.js';

const { SCHEDULER_TICK_MS, LOOKAHEAD_SECONDS, MAX_COMPENSATION_MS } = TIMING;
const MIDI_CC_ALL_NOTES_OFF = MIDI_CC.ALL_NOTES_OFF;
const MIDI_CC_STRING_SELECT = MIDI_CC.STRING_SELECT;
const MIDI_CC_FRET_SELECT = MIDI_CC.FRET_SELECT;

class PlaybackScheduler {
  /**
   * @param {Object} app - Application context (logger, database, eventBus, wsServer, deviceManager, latencyCompensator)
   */
  constructor(app) {
    this.app = app;
    this.scheduler = null;
    this.pendingTimeouts = new Set(); // Track scheduled setTimeout IDs for cleanup
    this._syncDelayCache = new Map(); // Cache sync_delay per device to avoid DB queries per event
    this._stringCCCache = new Map(); // Cache string instrument CC allowed per device:channel
    this._failedDevices = new Set(); // Track devices that failed to send (notify once per playback)
    this._unroutedChannels = new Set(); // Track channels with no routing (notify once per playback)
    this._maxCompensationMs = 0; // Cached max compensation across all active routings

    // Timing constraint enforcement: track last noteOn timestamp per (device:channel)
    this._lastNoteOnTime = new Map(); // key: "device:channel" -> timestamp (ms)
    this._timingConstraintCache = new Map(); // key: "device:channel" -> { minNoteInterval, minNoteDuration, polyphony }
    // Polyphony enforcement: track active notes per (device:channel)
    this._activeNotes = new Map(); // key: "device:channel" -> Set of active note numbers

    // Invalidate sync_delay cache immediately when instrument settings change
    this._onSettingsChanged = () => {
      this._syncDelayCache.clear();
      this._stringCCCache.clear();
      this._timingConstraintCache.clear();
      this._maxCompensationMs = 0;
    };
    this.app.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
  }

  /**
   * Start the scheduler interval.
   * @param {Function} tickCallback - Called every SCHEDULER_TICK_MS
   */
  startScheduler(tickCallback) {
    this.scheduler = setInterval(tickCallback, SCHEDULER_TICK_MS);
  }

  /**
   * Stop the scheduler and clear all pending event timeouts.
   */
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

  /**
   * Reset caches at the start of playback.
   */
  resetForPlayback() {
    this._syncDelayCache.clear();
    this._stringCCCache.clear();
    this._failedDevices.clear();
    this._unroutedChannels.clear();
    this._maxCompensationMs = 0;
    this._lastNoteOnTime.clear();
    this._timingConstraintCache.clear();
    this._activeNotes.clear();
  }

  /**
   * Check if CC 20/21 (string/fret select) is allowed for a given device+channel.
   * Returns true only if a string instrument with cc_enabled exists for that pair.
   */
  _isStringCCAllowed(deviceId, channel) {
    const cacheKey = `${deviceId}:${channel}`;
    if (this._stringCCCache.has(cacheKey)) {
      return this._stringCCCache.get(cacheKey);
    }
    let allowed = false;
    try {
      const instrument = this.app.database?.stringInstrumentDB?.getStringInstrument(deviceId, channel);
      allowed = instrument != null && instrument.cc_enabled !== false;
    } catch (e) {
      allowed = false;
    }
    this._stringCCCache.set(cacheKey, allowed);
    return allowed;
  }

  /**
   * Get timing and polyphony constraints for a given device+channel.
   * Cached per playback session to avoid DB queries per event.
   * @param {string} deviceId
   * @param {number} channel
   * @returns {{ minNoteInterval: number|null, minNoteDuration: number|null, polyphony: number|null }}
   */
  _getTimingConstraints(deviceId, channel) {
    const cacheKey = `${deviceId}:${channel}`;
    if (this._timingConstraintCache.has(cacheKey)) {
      return this._timingConstraintCache.get(cacheKey);
    }
    let constraints = { minNoteInterval: null, minNoteDuration: null, polyphony: null };
    try {
      const capDB = this.app.database?.instrumentCapabilitiesDB;
      if (capDB) {
        const instrument = capDB.getInstrumentCapabilities(deviceId, channel);
        if (instrument) {
          constraints = {
            minNoteInterval: instrument.min_note_interval || null,
            minNoteDuration: instrument.min_note_duration || null,
            polyphony: instrument.polyphony || null
          };
        }
      }
    } catch (e) {
      // Silently ignore — no constraints applied
    }
    this._timingConstraintCache.set(cacheKey, constraints);
    return constraints;
  }

  /**
   * Check if a noteOn should be gated (dropped) due to timing or polyphony constraints.
   * Also tracks active notes for polyphony enforcement.
   * @param {string} deviceId
   * @param {number} channel - Target channel on the device
   * @param {number} note - MIDI note number
   * @param {string} eventType - 'noteOn' or 'noteOff'
   * @returns {boolean} true if the event should be dropped/gated
   */
  _shouldGateNote(deviceId, channel, note, eventType) {
    const cacheKey = `${deviceId}:${channel}`;
    const constraints = this._getTimingConstraints(deviceId, channel);

    if (eventType === 'noteOff') {
      // Track noteOff for polyphony counting
      const activeSet = this._activeNotes.get(cacheKey);
      if (activeSet) activeSet.delete(note);
      return false; // Never gate noteOff
    }

    // eventType === 'noteOn'
    const now = performance.now();

    // Check min_note_interval: if the last noteOn on this device:channel was too recent, drop
    if (constraints.minNoteInterval) {
      const lastTime = this._lastNoteOnTime.get(cacheKey) || 0;
      if (lastTime > 0 && (now - lastTime) < constraints.minNoteInterval) {
        return true; // Gate: too fast for this instrument
      }
    }

    // Check polyphony limit: if active notes on this device:channel exceed the limit, drop
    if (constraints.polyphony) {
      if (!this._activeNotes.has(cacheKey)) this._activeNotes.set(cacheKey, new Set());
      const activeSet = this._activeNotes.get(cacheKey);
      if (activeSet.size >= constraints.polyphony && !activeSet.has(note)) {
        return true; // Gate: polyphony limit reached
      }
      activeSet.add(note);
    }

    // Update last noteOn timestamp
    this._lastNoteOnTime.set(cacheKey, now);

    return false; // Allow
  }

  /**
   * Invalidate compensation caches (e.g., when routing changes).
   */
  invalidateCompensationCache() {
    this._maxCompensationMs = 0;
    this._syncDelayCache.clear();
  }

  /**
   * Process a scheduler tick: schedule events within the lookahead window.
   * @param {Object} state - { playing, paused, position, duration, events, currentEventIndex, loop }
   * @param {Function} getOutputForChannel - (channel) => { device, targetChannel } | null
   * @param {Object} callbacks - { onStop, onSeek, onBroadcastPosition }
   * @returns {number} Updated currentEventIndex
   */
  tick(state, getOutputForChannel, callbacks) {
    if (!state.playing || state.paused) {
      return state.currentEventIndex;
    }

    // Update position. playbackRate >1 makes playback run faster, <1
    // makes it run slower (see MidiPlayer.setPlaybackTempo).
    const rate = state.playbackRate > 0 ? state.playbackRate : 1;
    const elapsed = (performance.now() - state.startTime) * rate / 1000;
    state.position = elapsed;

    // Check if reached end
    if (state.position >= state.duration) {
      if (callbacks.onFileEnd) {
        callbacks.onFileEnd();
      } else if (state.loop) {
        callbacks.onSeek(0);
      } else {
        callbacks.onStop();
      }
      return state.currentEventIndex;
    }

    // Dynamic lookahead: extend beyond base to accommodate large sync_delay compensations
    const maxCompSec = this._getMaxActiveCompensation(state, getOutputForChannel) / 1000;
    const targetTime = state.position + LOOKAHEAD_SECONDS + maxCompSec;

    let idx = state.currentEventIndex;
    while (idx < state.events.length) {
      const event = state.events[idx];

      if (event.time > targetTime) {
        break;
      }

      this.scheduleEvent(event, state.position, getOutputForChannel, state, callbacks);
      idx++;
    }

    // Broadcast position update (every 100ms = every 10th tick at 10ms resolution)
    if (state._lastBroadcastPosition === undefined ||
        Math.floor(state.position * 10) !== Math.floor(state._lastBroadcastPosition * 10)) {
      state._lastBroadcastPosition = state.position;
      callbacks.onBroadcastPosition();
    }

    return idx;
  }

  /**
   * Schedule a single MIDI event with latency compensation.
   * @param {Object} event - MIDI event
   * @param {number} currentPosition - Current playback position in seconds
   * @param {Function} getOutputForChannel - Routing lookup function
   * @param {Object} state - Player state (for playing check in sendEvent)
   */
  scheduleEvent(event, currentPosition, getOutputForChannel, state, callbacks) {
    // Handle tempo change events (for MIDI clock synchronization)
    if (event.type === 'setTempo') {
      const delay = Math.max(0, event.time - currentPosition);
      const timeoutId = setTimeout(() => {
        this.pendingTimeouts.delete(timeoutId);
        if (this.app.midiClockGenerator) {
          this.app.midiClockGenerator.setTempo(event.tempo);
        }
      }, delay * 1000);
      this.pendingTimeouts.add(timeoutId);
      return;
    }

    const eventTime = event.time;
    // Divide wall-clock delay by playbackRate so a rate>1 fires events
    // proportionally sooner, matching the accelerated position advance
    // computed in tick().
    const rate = state.playbackRate > 0 ? state.playbackRate : 1;
    const delay = Math.max(0, eventTime - currentPosition) / rate;

    // For note events, pass the note and event type to routing for split support
    const isNoteEvent = event.type === 'noteOn' || event.type === 'noteOff';
    const note = isNoteEvent ? (event.note ?? null) : null;
    const routing = getOutputForChannel(event.channel, note, isNoteEvent ? event.type : null);

    if (!routing) {
      if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        this.app.logger.warn(`No output device for channel ${event.channel + 1}, skipping events`);
        this.app.wsServer?.broadcast('playback_channel_skipped', {
          channel: event.channel,
          channelDisplay: event.channel + 1,
          reason: 'no_routing'
        });
      }
      return;
    }

    // Handle broadcast (split routing returns array for non-note events)
    if (Array.isArray(routing)) {
      // Schedule for each segment
      for (const segRouting of routing) {
        if (!segRouting || !segRouting.device) continue;
        const syncDelay = this._getSyncDelay(segRouting.device, segRouting.targetChannel);
        const adjustedDelay = Math.max(0, delay - (syncDelay / 1000));
        const timeoutId = setTimeout(() => {
          this.pendingTimeouts.delete(timeoutId);
          this._sendEventToRouting(event, segRouting, state);
        }, adjustedDelay * 1000);
        this.pendingTimeouts.add(timeoutId);
      }
      return;
    }

    if (!routing.device) {
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
      this.sendEvent(event, state, getOutputForChannel, callbacks);
    }, adjustedDelay * 1000);
    this.pendingTimeouts.add(timeoutId);
  }

  /**
   * Send a MIDI event to the appropriate device.
   * @param {Object} event - MIDI event
   * @param {Object} state - Player state { playing, mutedChannels }
   * @param {Function} getOutputForChannel - Routing lookup
   */
  sendEvent(event, state, getOutputForChannel, callbacks) {
    if (!state.playing) {
      return;
    }

    // Skip muted channels
    if (state.mutedChannels && state.mutedChannels.has(event.channel)) {
      return;
    }

    const isNoteEvent = event.type === 'noteOn' || event.type === 'noteOff';
    const note = isNoteEvent ? (event.note ?? null) : null;
    const routing = getOutputForChannel(event.channel, note, isNoteEvent ? event.type : null);

    // Handle broadcast for split routing (non-note events go to all segments)
    if (Array.isArray(routing)) {
      for (const segRouting of routing) {
        if (segRouting && segRouting.device) {
          this._sendEventToRouting(event, segRouting, state);
        }
      }
      return;
    }

    if (!routing || !routing.device) {
      if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        this.app.logger.warn(`No output device for channel ${event.channel + 1}`);
        this.app.wsServer?.broadcast('playback_channel_skipped', {
          channel: event.channel,
          channelDisplay: event.channel + 1,
          reason: 'no_routing'
        });
      }
      return;
    }

    // Use targetChannel from routing
    const outChannel = routing.targetChannel;
    const device = this.app.deviceManager;
    let sendResult = true;

    // Enforce timing and polyphony constraints for note events
    if (event.type === 'noteOn' || event.type === 'noteOff') {
      const isNoteOn = event.type === 'noteOn' && (event.velocity ?? 0) > 0;
      const evtType = isNoteOn ? 'noteOn' : 'noteOff';
      if (this._shouldGateNote(routing.device, outChannel, event.note, evtType)) {
        return; // Gated: note dropped due to timing or polyphony constraint
      }
    }

    if (event.type === 'noteOn') {
      if (event.velocity === 0) {
        // velocity 0 noteOn = noteOff, track for polyphony
        this._shouldGateNote(routing.device, outChannel, event.note, 'noteOff');
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
    } else if (event.type === 'programChange') {
      sendResult = device.sendMessage(routing.device, 'program', {
        channel: outChannel,
        program: event.program
      });
    } else if (event.type === 'controller') {
      // Filter CC 20/21 (string/fret select): only send for string instruments with cc_enabled
      if (event.controller === MIDI_CC_STRING_SELECT || event.controller === MIDI_CC_FRET_SELECT) {
        if (!this._isStringCCAllowed(routing.device, outChannel)) {
          return;
        }
      }
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

    // Notify once per device if send fails, apply disconnect policy
    if (!sendResult && !this._failedDevices.has(routing.device)) {
      this._failedDevices.add(routing.device);
      this.app.logger.warn(`Device unreachable during playback: ${routing.device}`);

      const policy = state.disconnectedPolicy || 'skip';

      if (policy === 'pause') {
        this.app.wsServer?.broadcast('playback_device_disconnected', {
          deviceId: routing.device,
          channel: event.channel,
          policy: 'pause',
          message: `Device ${routing.device} is unreachable`
        });
        if (callbacks && callbacks.onPause) {
          callbacks.onPause();
        }
      } else if (policy === 'mute') {
        // Auto-mute all channels routed to this device
        const mutedChannels = [];
        if (state.channelRouting) {
          for (const [ch, r] of state.channelRouting) {
            if (r && r.device === routing.device) {
              state.mutedChannels.add(ch);
              mutedChannels.push(ch);
            }
          }
        }
        this.app.wsServer?.broadcast('playback_device_disconnected', {
          deviceId: routing.device,
          channel: event.channel,
          policy: 'mute',
          mutedChannels,
          message: `Device ${routing.device} is unreachable, channels auto-muted`
        });
      } else {
        // 'skip' - existing behavior
        this.app.wsServer?.broadcast('playback_device_error', {
          deviceId: routing.device,
          channel: event.channel,
          message: `Device ${routing.device} is unreachable`
        });
      }
    }
  }

  /**
   * Send a single event to a specific routing target (used for split broadcast)
   * @param {Object} event
   * @param {Object} routing - { device, targetChannel }
   * @param {Object} state
   */
  _sendEventToRouting(event, routing, state) {
    if (!state.playing) return;
    if (state.mutedChannels && state.mutedChannels.has(event.channel)) return;

    const device = this.app.deviceManager;
    const outChannel = routing.targetChannel;

    // Enforce timing and polyphony constraints for note events
    if (event.type === 'noteOn' || event.type === 'noteOff') {
      const isNoteOn = event.type === 'noteOn' && (event.velocity ?? 0) > 0;
      const evtType = isNoteOn ? 'noteOn' : 'noteOff';
      if (this._shouldGateNote(routing.device, outChannel, event.note, evtType)) {
        return; // Gated: note dropped due to timing or polyphony constraint
      }
    }

    if (event.type === 'noteOn') {
      if (event.velocity === 0) {
        this._shouldGateNote(routing.device, outChannel, event.note, 'noteOff');
        device.sendMessage(routing.device, 'noteoff', { channel: outChannel, note: event.note, velocity: 0 });
      } else {
        device.sendMessage(routing.device, 'noteon', { channel: outChannel, note: event.note, velocity: event.velocity });
      }
    } else if (event.type === 'noteOff') {
      device.sendMessage(routing.device, 'noteoff', { channel: outChannel, note: event.note, velocity: event.velocity });
    } else if (event.type === 'controller') {
      // Filter CC 20/21 (string/fret select): only send for string instruments with cc_enabled
      if (event.controller === MIDI_CC_STRING_SELECT || event.controller === MIDI_CC_FRET_SELECT) {
        if (!this._isStringCCAllowed(routing.device, outChannel)) {
          return;
        }
      }
      device.sendMessage(routing.device, 'cc', { channel: outChannel, controller: event.controller, value: event.value });
    } else if (event.type === 'programChange') {
      device.sendMessage(routing.device, 'program', { channel: outChannel, program: event.program });
    } else if (event.type === 'pitchBend') {
      device.sendMessage(routing.device, 'pitchbend', { channel: outChannel, value: event.value });
    } else if (event.type === 'channelAftertouch') {
      device.sendMessage(routing.device, 'channel aftertouch', { channel: outChannel, pressure: event.value });
    } else if (event.type === 'noteAftertouch') {
      device.sendMessage(routing.device, 'poly aftertouch', { channel: outChannel, note: event.note, pressure: event.value });
    }
  }

  /**
   * Send All Notes Off to all routed devices/channels.
   * @param {string} outputDevice - Default output device
   * @param {Map} channelRouting - Channel routing map
   * @param {Array} channels - MIDI channels from file
   */
  sendAllNotesOff(outputDevice, channelRouting, channels) {
    if (!outputDevice) {
      return;
    }

    const device = this.app.deviceManager;

    // Build map of device -> target channels actually routed to it
    const channelsPerDevice = new Map();

    for (const [sourceChannel, routing] of channelRouting) {
      // Handle split routing: extract all segment devices
      if (routing && routing.split && routing.segments) {
        for (const seg of routing.segments) {
          if (!seg.device) continue;
          if (!channelsPerDevice.has(seg.device)) {
            channelsPerDevice.set(seg.device, new Set());
          }
          channelsPerDevice.get(seg.device).add(seg.targetChannel);
        }
        continue;
      }

      const deviceName = typeof routing === 'string' ? routing : routing?.device;
      const targetChannel = typeof routing === 'string' ? sourceChannel : routing.targetChannel;
      if (!deviceName) continue;

      if (!channelsPerDevice.has(deviceName)) {
        channelsPerDevice.set(deviceName, new Set());
      }
      channelsPerDevice.get(deviceName).add(targetChannel);
    }

    // Also include channels from the MIDI file that use the default device (no explicit routing)
    for (const ch of channels) {
      if (!channelRouting.has(ch.channel)) {
        if (!channelsPerDevice.has(outputDevice)) {
          channelsPerDevice.set(outputDevice, new Set());
        }
        channelsPerDevice.get(outputDevice).add(ch.channel);
      }
    }

    // Send All Notes Off only on the channels actually routed to each device
    for (const [targetDevice, chSet] of channelsPerDevice) {
      for (const channel of chSet) {
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

  /**
   * Get max compensation across all active channel routings (cached per playback session).
   * @param {Object} state - Player state with channelRouting
   * @param {Function} getOutputForChannel - Routing lookup
   * @returns {number} Maximum compensation in milliseconds
   */
  _getMaxActiveCompensation(state, _getOutputForChannel) {
    if (this._maxCompensationMs > 0) {
      return this._maxCompensationMs;
    }
    let maxComp = 0;
    if (state.channelRouting) {
      for (const [channel, routing] of state.channelRouting) {
        // Handle split routing: iterate over segments
        if (routing && routing.split && routing.segments) {
          for (const seg of routing.segments) {
            const comp = this._getSyncDelay(seg.device, seg.targetChannel);
            if (comp > maxComp) maxComp = comp;
          }
          continue;
        }
        const deviceId = typeof routing === 'string' ? routing : routing.device;
        const targetCh = typeof routing === 'string' ? channel : routing.targetChannel;
        const comp = this._getSyncDelay(deviceId, targetCh);
        if (comp > maxComp) maxComp = comp;
      }
    }
    this._maxCompensationMs = maxComp;
    return maxComp;
  }

  /**
   * Get total timing compensation for a device+channel in milliseconds.
   * Combines sync_delay + hardware latency. Clamped to MAX_COMPENSATION_MS.
   * @param {string} deviceId - Device identifier
   * @param {number} channel - MIDI channel
   * @returns {number} Compensation in ms
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

    // Clamp to maximum allowed compensation (both positive and negative)
    if (syncDelay > MAX_COMPENSATION_MS) {
      this.app.logger.warn(`Compensation ${syncDelay.toFixed(0)}ms for device ${deviceId} ch ${channel} exceeds max ${MAX_COMPENSATION_MS}ms, clamping`);
      syncDelay = MAX_COMPENSATION_MS;
    } else if (syncDelay < -MAX_COMPENSATION_MS) {
      this.app.logger.warn(`Compensation ${syncDelay.toFixed(0)}ms for device ${deviceId} ch ${channel} exceeds min -${MAX_COMPENSATION_MS}ms, clamping`);
      syncDelay = -MAX_COMPENSATION_MS;
    }

    if (syncDelay !== 0) {
      this.app.logger.debug(`Total compensation ${syncDelay.toFixed(1)}ms for device ${deviceId} ch ${channel}`);
    }

    this._syncDelayCache.set(cacheKey, syncDelay);
    return syncDelay;
  }

  /**
   * Cleanup resources.
   */
  destroy() {
    this.stopScheduler();
    this._syncDelayCache.clear();
    if (this._onSettingsChanged) {
      this.app.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }
  }
}

export default PlaybackScheduler;
