/**
 * @file src/midi/playback/PlaybackScheduler.js
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
import { TIMING, MIDI_CC, MIDI_EVENT_TYPES, DEVICE_MSG_TYPES } from '../../core/constants.js';

const { SCHEDULER_TICK_MS, LOOKAHEAD_SECONDS } = TIMING;
const MIDI_CC_ALL_NOTES_OFF = MIDI_CC.ALL_NOTES_OFF;
const MIDI_CC_STRING_SELECT = MIDI_CC.STRING_SELECT;
const MIDI_CC_FRET_SELECT = MIDI_CC.FRET_SELECT;

class PlaybackScheduler {
  /**
   * @param {Object} deps - Explicit dependency bag.
   * @param {Object} deps.logger
   * @param {Object} deps.database
   * @param {Object} deps.eventBus
   * @param {Object} [deps.wsServer]
   * @param {Object} deps.deviceManager
   * @param {Object} [deps.compensationService]
   * @param {Object} [deps.capabilityResolver]
   * @param {Object} [deps.midiClockGenerator]
   */
  constructor(deps) {
    this.logger              = deps.logger;
    this.database            = deps.database;
    this.eventBus            = deps.eventBus;
    this.wsServer            = deps.wsServer;
    this.deviceManager       = deps.deviceManager;
    this.compensationService = deps.compensationService   || null;
    this.capabilityResolver  = deps.capabilityResolver    || null;
    this.midiClockGenerator  = deps.midiClockGenerator    || null;
    this.scheduler = null;
    this.pendingTimeouts = new Set(); // Track scheduled setTimeout IDs for cleanup
    this._failedDevices = new Set(); // Track devices that failed to send (notify once per playback)
    this._unroutedChannels = new Set(); // Track channels with no routing (notify once per playback)
    this._maxCompensationMs = 0; // Cached max compensation across all active routings

    // Timing constraint enforcement: track last noteOn timestamp per (device:channel)
    this._lastNoteOnTime = new Map(); // key: "device:channel" -> timestamp (ms)
    // Polyphony enforcement: track active notes per (device:channel)
    this._activeNotes = new Map(); // key: "device:channel" -> Set of active note numbers

    // Invalidate caches immediately when instrument settings change.
    // Note: _syncDelayCache is removed — compensation is now handled by
    // CompensationService. The remaining caches (string CC, timing constraints)
    // still need local invalidation.
    this._onSettingsChanged = () => {
      // CapabilityResolver handles its own invalidation via the same event.
      // We only need to reset the local per-playback aggregate here.
      this._maxCompensationMs = 0;
    };
    this.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);
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
    this._failedDevices.clear();
    this._unroutedChannels.clear();
    this._maxCompensationMs = 0;
    this._lastNoteOnTime.clear();
    this._activeNotes.clear();
    // CapabilityResolver caches survive across playbacks (invalidated on settings change).
    // No need to clear them here — they hold per-device capability data, not per-file state.
  }

  /**
   * Delegates to CapabilityResolver. Falls back to false when the resolver
   * is unavailable (tests without full DI wiring).
   */
  _isStringCCAllowed(deviceId, channel) {
    return this.capabilityResolver?.isStringCCAllowed(deviceId, channel) ?? false;
  }

  /**
   * Delegates to CapabilityResolver. Returns null-constraint object when
   * the resolver is unavailable.
   */
  _getTimingConstraints(deviceId, channel) {
    return this.capabilityResolver?.getTimingConstraints(deviceId, channel)
      ?? { minNoteInterval: null, minNoteDuration: null, polyphony: null };
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

    if (eventType === MIDI_EVENT_TYPES.NOTE_OFF) {
      // Track noteOff for polyphony counting
      const activeSet = this._activeNotes.get(cacheKey);
      if (activeSet) activeSet.delete(note);
      return false; // Never gate noteOff
    }

    // eventType === MIDI_EVENT_TYPES.NOTE_ON
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
   * CompensationService has its own invalidate(); this resets the local
   * per-playback max-compensation aggregate.
   */
  invalidateCompensationCache() {
    this._maxCompensationMs = 0;
    this.compensationService?.invalidate();
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
    if (event.type === MIDI_EVENT_TYPES.SET_TEMPO) {
      const delay = Math.max(0, event.time - currentPosition);
      const timeoutId = setTimeout(() => {
        this.pendingTimeouts.delete(timeoutId);
        if (this.midiClockGenerator) {
          this.midiClockGenerator.setTempo(event.tempo);
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

    // Routing override: events injected by the hand-position planner for
    // a specific split-routing segment carry `_routeTo: { device,
    // targetChannel }` so they reach only that segment's device. Without
    // this bypass the generic split dispatch would broadcast the CC to
    // every segment of the split, which is wrong because each segment
    // may declare its own hands_config and CC number.
    if (event._routeTo && event._routeTo.device) {
      const syncDelay = this._getSyncDelay(event._routeTo.device, event._routeTo.targetChannel);
      const adjustedDelay = Math.max(0, delay - (syncDelay / 1000));
      const timeoutId = setTimeout(() => {
        this.pendingTimeouts.delete(timeoutId);
        this._sendEventToRouting(event, event._routeTo, state);
      }, adjustedDelay * 1000);
      this.pendingTimeouts.add(timeoutId);
      return;
    }

    // For note events, pass the note and event type to routing for split support
    const isNoteEvent = event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF;
    const note = isNoteEvent ? (event.note ?? null) : null;
    const routing = getOutputForChannel(event.channel, note, isNoteEvent ? event.type : null);

    if (!routing) {
      if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        this.logger.warn(`No output device for channel ${event.channel + 1}, skipping events`);
        this.wsServer?.broadcast('playback_channel_skipped', {
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
      this.logger.warn(`No output device for channel ${event.channel + 1}, skipping event`);
      return;
    }

    // Get sync_delay from cache using device + targetChannel key
    const syncDelay = this._getSyncDelay(routing.device, routing.targetChannel);

    // Apply sync_delay compensation (convert ms to seconds)
    const adjustedDelay = Math.max(0, delay - (syncDelay / 1000));

    if (syncDelay > 0 && delay < syncDelay / 1000) {
      this.logger.debug(
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

    const isNoteEvent = event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF;
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
        this.logger.warn(`No output device for channel ${event.channel + 1}`);
        this.wsServer?.broadcast('playback_channel_skipped', {
          channel: event.channel,
          channelDisplay: event.channel + 1,
          reason: 'no_routing'
        });
      }
      return;
    }

    // Use targetChannel from routing
    const outChannel = routing.targetChannel;
    const device = this.deviceManager;
    let sendResult = true;

    // Per-channel transposition: applied to note pitches just before
    // device send so the routing/split decision (made above) still
    // operates on source-note ranges as the operator sees them in
    // the routing modal. Out-of-range pitches are clamped to the
    // valid MIDI byte range — the gate path will drop a clamped
    // note if the device's polyphony / spacing rules reject it.
    const transposeSemis = state.channelTransposition
      ? (state.channelTransposition.get(event.channel) || 0) : 0;
    const outNote = (event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF || event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH)
      ? Math.max(0, Math.min(127, (event.note ?? 0) + transposeSemis))
      : event.note;

    // Enforce timing and polyphony constraints for note events
    if (event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      const isNoteOn = event.type === MIDI_EVENT_TYPES.NOTE_ON && (event.velocity ?? 0) > 0;
      const evtType = isNoteOn ? MIDI_EVENT_TYPES.NOTE_ON : MIDI_EVENT_TYPES.NOTE_OFF;
      if (this._shouldGateNote(routing.device, outChannel, outNote, evtType)) {
        return; // Gated: note dropped due to timing or polyphony constraint
      }
    }

    if (event.type === MIDI_EVENT_TYPES.NOTE_ON) {
      if (event.velocity === 0) {
        // velocity 0 noteOn = noteOff, track for polyphony
        this._shouldGateNote(routing.device, outChannel, outNote, MIDI_EVENT_TYPES.NOTE_OFF);
        sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_OFF, {
          channel: outChannel,
          note: outNote,
          velocity: 0
        });
      } else {
        sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_ON, {
          channel: outChannel,
          note: outNote,
          velocity: event.velocity
        });
      }
    } else if (event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_OFF, {
        channel: outChannel,
        note: outNote,
        velocity: event.velocity
      });
    } else if (event.type === MIDI_EVENT_TYPES.PROGRAM_CHANGE) {
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.PROGRAM, {
        channel: outChannel,
        program: event.program
      });
    } else if (event.type === MIDI_EVENT_TYPES.CONTROLLER) {
      // Filter CC 20/21 (string/fret select): only send for string instruments with cc_enabled
      if (event.controller === MIDI_CC_STRING_SELECT || event.controller === MIDI_CC_FRET_SELECT) {
        if (!this._isStringCCAllowed(routing.device, outChannel)) {
          return;
        }
      }
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.CC, {
        channel: outChannel,
        controller: event.controller,
        value: event.value
      });
    } else if (event.type === MIDI_EVENT_TYPES.PITCH_BEND) {
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.PITCH_BEND, {
        channel: outChannel,
        value: event.value
      });
    } else if (event.type === MIDI_EVENT_TYPES.CHANNEL_AFTERTOUCH) {
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH, {
        channel: outChannel,
        pressure: event.value
      });
    } else if (event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH) {
      sendResult = device.sendMessage(routing.device, DEVICE_MSG_TYPES.POLY_AFTERTOUCH, {
        channel: outChannel,
        note: outNote,
        pressure: event.value
      });
    }

    // Notify once per device if send fails, apply disconnect policy
    if (!sendResult && !this._failedDevices.has(routing.device)) {
      this._failedDevices.add(routing.device);
      this.logger.warn(`Device unreachable during playback: ${routing.device}`);

      const policy = state.disconnectedPolicy || 'skip';

      if (policy === 'pause') {
        this.wsServer?.broadcast('playback_device_disconnected', {
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
        this.wsServer?.broadcast('playback_device_disconnected', {
          deviceId: routing.device,
          channel: event.channel,
          policy: 'mute',
          mutedChannels,
          message: `Device ${routing.device} is unreachable, channels auto-muted`
        });
      } else {
        // 'skip' - existing behavior
        this.wsServer?.broadcast('playback_device_error', {
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

    const device = this.deviceManager;
    const outChannel = routing.targetChannel;

    // Apply per-channel transposition for note pitches (see sendEvent
    // for the rationale: routing decisions stay in source-note space).
    const transposeSemis = state.channelTransposition
      ? (state.channelTransposition.get(event.channel) || 0) : 0;
    const outNote = (event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF || event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH)
      ? Math.max(0, Math.min(127, (event.note ?? 0) + transposeSemis))
      : event.note;

    // Enforce timing and polyphony constraints for note events
    if (event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      const isNoteOn = event.type === MIDI_EVENT_TYPES.NOTE_ON && (event.velocity ?? 0) > 0;
      const evtType = isNoteOn ? MIDI_EVENT_TYPES.NOTE_ON : MIDI_EVENT_TYPES.NOTE_OFF;
      if (this._shouldGateNote(routing.device, outChannel, outNote, evtType)) {
        return; // Gated: note dropped due to timing or polyphony constraint
      }
    }

    if (event.type === MIDI_EVENT_TYPES.NOTE_ON) {
      if (event.velocity === 0) {
        this._shouldGateNote(routing.device, outChannel, outNote, MIDI_EVENT_TYPES.NOTE_OFF);
        device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_OFF, { channel: outChannel, note: outNote, velocity: 0 });
      } else {
        device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_ON, { channel: outChannel, note: outNote, velocity: event.velocity });
      }
    } else if (event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.NOTE_OFF, { channel: outChannel, note: outNote, velocity: event.velocity });
    } else if (event.type === MIDI_EVENT_TYPES.CONTROLLER) {
      // Filter CC 20/21 (string/fret select): only send for string instruments with cc_enabled
      if (event.controller === MIDI_CC_STRING_SELECT || event.controller === MIDI_CC_FRET_SELECT) {
        if (!this._isStringCCAllowed(routing.device, outChannel)) {
          return;
        }
      }
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.CC, { channel: outChannel, controller: event.controller, value: event.value });
    } else if (event.type === MIDI_EVENT_TYPES.PROGRAM_CHANGE) {
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.PROGRAM, { channel: outChannel, program: event.program });
    } else if (event.type === MIDI_EVENT_TYPES.PITCH_BEND) {
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.PITCH_BEND, { channel: outChannel, value: event.value });
    } else if (event.type === MIDI_EVENT_TYPES.CHANNEL_AFTERTOUCH) {
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH, { channel: outChannel, pressure: event.value });
    } else if (event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH) {
      device.sendMessage(routing.device, DEVICE_MSG_TYPES.POLY_AFTERTOUCH, { channel: outChannel, note: outNote, pressure: event.value });
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

    const device = this.deviceManager;

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
   * Delegates to CompensationService (shared with MidiRouter) so both hot
   * paths read from the same cache.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {number} Compensation in ms
   */
  _getSyncDelay(deviceId, channel) {
    const svc = this.compensationService;
    if (!svc) return 0;
    return svc.getDelay(deviceId, channel);
  }

  /**
   * Cleanup resources.
   */
  destroy() {
    this.stopScheduler();
    if (this._onSettingsChanged) {
      this.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }
  }
}

export default PlaybackScheduler;
