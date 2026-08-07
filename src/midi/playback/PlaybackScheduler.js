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
import {
  TIMING,
  MIDI_CC,
  MIDI_EVENT_TYPES,
  DEVICE_MSG_TYPES,
  SEND_STATUS
} from '../../core/constants.js';
import {
  clampNote,
  foldIntoRange,
  snapToNearest,
  selectPolyphonyVictim
} from '../adaptation/NoteEnforcement.js';

const { SCHEDULER_TICK_MS, LOOKAHEAD_SECONDS, EMIT_AHEAD_MS } = TIMING;
const MIDI_CC_ALL_NOTES_OFF = MIDI_CC.ALL_NOTES_OFF;
const MIDI_CC_RESET_ALL_CONTROLLERS = MIDI_CC.RESET_ALL_CONTROLLERS;
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
   * @param {Object} [deps.eventLoopMonitor]  - Optional; reduces lookahead when event loop is lagging.
   */
  constructor(deps) {
    this._deps = deps;
    this.logger = deps.logger;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
    this.deviceManager = deps.deviceManager;
    // MidiClockGenerator is registered before MidiPlayer (which builds this
    // scheduler) — see Application.initialize() comments — so the eager
    // capture is safe.
    this.midiClockGenerator = deps.midiClockGenerator || null;

    // The next four deps are registered AFTER `midiPlayer` in
    // Application.initialize() (compensationService, capabilityResolver,
    // wsServer in initialize; eventLoopMonitor in start). Capturing them
    // eagerly would freeze a null reference here and silently disable
    // every consumer at runtime — see AUDIT 2026-05-10 §12. Expose them as
    // getters that re-resolve through the DI Proxy on each access.
    Object.defineProperty(this, 'wsServer', {
      get: () => this._deps.wsServer || null
    });
    Object.defineProperty(this, 'compensationService', {
      get: () => this._deps.compensationService || null
    });
    Object.defineProperty(this, 'capabilityResolver', {
      get: () => this._deps.capabilityResolver || null
    });
    Object.defineProperty(this, 'eventLoopMonitor', {
      get: () => this._deps.eventLoopMonitor || null
    });
    Object.defineProperty(this, 'latencyCompensator', {
      get: () => this._deps.latencyCompensator || null
    });

    // Hand-shift travel-time compensation (opt-in, default off). When enabled,
    // a note whose window needs a fret/position shift the actuator physically
    // can't complete in time (a `move_too_fast` planner warning) is dispatched
    // that shortfall earlier, so the hand arrives before the note sounds — at
    // the cost of nudging that note off the beat. Off by default because the
    // right value is hardware-specific and the early note desyncs from other
    // instruments; see docs/adr and config `playback.handShiftCompensation`.
    this._handShiftEnabled = false;
    this._handWarnings = null; // move_too_fast warnings for the loaded file
    this._maxHandShiftMs = 0; // max shortfall across warnings (lookahead budget)

    this.scheduler = null;
    this.pendingTimeouts = new Set(); // Track scheduled setTimeout IDs for cleanup

    // Per-playback immutable view of capability + compensation data.
    // When set, the hot-path lookups serve from this snapshot instead of
    // hitting CapabilityResolver / CompensationService — which insulates
    // the scheduler from mid-playback DB mutations (P0-5).
    this._snapshot = null;
    this._failedDevices = new Set(); // Track devices that failed to send (notify once per playback)
    this._unroutedChannels = new Set(); // Track channels with no routing (notify once per playback)
    this._maxCompensationMs = 0; // Cached max compensation across all active routings

    // Timing constraint enforcement: track last noteOn timestamp per (device:channel)
    this._lastNoteOnTime = new Map(); // key: "device:channel" -> timestamp (ms)
    // Polyphony enforcement: track active notes per (device:channel) as a
    // count map so overlapping same-pitch notes are counted separately.
    this._activeNotes = new Map(); // key: "device:channel" -> Map<note, count>
    // noteOn timestamps per (device:channel:note) for min_note_duration.
    this._noteOnTimes = new Map(); // key: "device:channel:note" -> timestamp (ms)
    // Count of noteOns dropped by a constraint, per (device:channel:note),
    // so the matching noteOff can be suppressed exactly once.
    this._droppedNoteOns = new Map(); // key: "device:channel:note" -> count
    // Monotonic instance id per (device:channel:note), bumped on every accepted
    // noteOn. A DEFERRED noteOff (min_note_duration) captures the instance and
    // only fires if it still matches — so a fast same-pitch retrigger within the
    // defer window isn't cut short by the previous note's late release (P2 axis6-5).
    this._noteInstance = new Map(); // key: "device:channel:note" -> instance id

    // Per-playback timing observability (see getTimingMetrics).
    this._metrics = { emitted: 0, earlyCount: 0, maxEarlinessMs: 0, sumEarlinessMs: 0 };

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
    this.scheduler.unref();
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
    this._noteOnTimes.clear();
    this._droppedNoteOns.clear();
    this._noteInstance.clear();
    this._handWarnings = null;
    this._maxHandShiftMs = 0;
    this._metrics = { emitted: 0, earlyCount: 0, maxEarlinessMs: 0, sumEarlinessMs: 0 };
    // CapabilityResolver caches survive across playbacks (invalidated on settings change).
    // No need to clear them here — they hold per-device capability data, not per-file state.
  }

  /**
   * Reset per-note physical-voice tracking to "nothing sounding". Called on
   * pause, after All Notes Off has physically released every note: the held
   * notes' noteOff events are still pending on the timeline, so without this
   * `_activeNotes` keeps over-reporting active voices after resume and a
   * polyphony-limited (mechanical) instrument gates/drops new noteOns until
   * those stale noteOffs drain (audit P2). Clearing `_droppedNoteOns` also
   * prevents a later real noteOff from being wrongly swallowed.
   * @returns {void}
   */
  resetNoteTracking() {
    this._activeNotes.clear();
    this._lastNoteOnTime.clear();
    this._noteOnTimes.clear();
    this._droppedNoteOns.clear();
    this._noteInstance.clear();
  }

  /**
   * Attach the per-playback snapshot. Subsequent hot-path lookups
   * (`_isStringCCAllowed`, `_getTimingConstraints`, `_getSyncDelay`)
   * read from the snapshot instead of touching CapabilityResolver /
   * CompensationService, so a mid-playback `instrument_settings_changed`
   * cannot cause an SQLite re-query inside a tick.
   *
   * @param {import('./PlaybackSnapshot.js').PlaybackSnapshot|null} snapshot
   * @returns {void}
   */
  setSnapshot(snapshot) {
    this._snapshot = snapshot || null;
  }

  /**
   * Detach the snapshot at end-of-playback so the next lookup goes back
   * through the live services.
   * @returns {void}
   */
  clearSnapshot() {
    this._snapshot = null;
  }

  /**
   * Register the `move_too_fast` hand-position warnings for the loaded file so
   * note-on dispatch can anticipate impossible actuator shifts. Reads the
   * opt-in config flag once per playback (avoids a per-event lookup) and caches
   * the largest shortfall as the extra lookahead budget. Pass `null` (or an
   * empty list) to disable — e.g. at stop or for a file with no warnings.
   *
   * @param {Array<{code:string,time:number,channel?:number,requiredMs?:number,
   *   availableMs?:number}>|null} warnings
   * @returns {void}
   */
  setHandWarnings(warnings) {
    this._handShiftEnabled = !!this._deps.config?.get?.('playback.handShiftCompensation', false);
    if (!this._handShiftEnabled || !Array.isArray(warnings) || warnings.length === 0) {
      this._handWarnings = null;
      this._maxHandShiftMs = 0;
      return;
    }
    this._handWarnings = warnings;
    let maxMs = 0;
    for (const w of warnings) {
      if (!w || w.code !== 'move_too_fast') continue;
      const required = Number.isFinite(w.requiredMs) ? w.requiredMs : 0;
      const available = Number.isFinite(w.availableMs) ? w.availableMs : 0;
      const shortfall = Math.max(0, required - available);
      if (shortfall > maxMs) maxMs = shortfall;
    }
    this._maxHandShiftMs = maxMs;
  }

  /**
   * Extra ms a note-on should depart early to cover an actuator shift the
   * planner flagged as `move_too_fast`. 0 when disabled, not a note-on, or no
   * matching warning. Delegates the matching to LatencyCompensator so the
   * shortfall logic lives in one place.
   * @private
   */
  _handShiftMsFor(event) {
    if (!this._handShiftEnabled || !this._handWarnings) return 0;
    if (event.type !== MIDI_EVENT_TYPES.NOTE_ON) return 0;
    return (
      this.latencyCompensator?.shiftExtraMs(this._handWarnings, event.time, event.channel) || 0
    );
  }

  /**
   * Delegates to the playback snapshot when present, otherwise to the
   * live CapabilityResolver. Falls back to false when neither is wired.
   */
  _isStringCCAllowed(deviceId, channel) {
    if (this._snapshot) return this._snapshot.isStringCCAllowed(deviceId, channel);
    return this.capabilityResolver?.isStringCCAllowed(deviceId, channel) ?? false;
  }

  /**
   * Whether a Control Change should be forwarded, given the instrument's
   * declared `supported_ccs`. When the instrument declares a non-empty set,
   * only those CCs are sent — plus protocol-safety controllers that are never
   * filtered: channel-mode messages (120-127: all-sound-off, reset, all-notes-
   * off, omni/mono/poly, local control) and Bank Select (0/32). This keeps an
   * unsupported expression CC from deregulating the firmware (audit P2-4) while
   * never dropping the control messages the engine and protocol rely on. When
   * no set is declared, everything is forwarded (backward-compatible default).
   * CC 20/21 (string/fret select) are handled by their own gate and never reach
   * this check.
   *
   * @param {number} controller
   * @param {Object} constraints - from {@link _getTimingConstraints}
   * @returns {boolean}
   */
  _isCCSupported(controller, constraints) {
    const list = constraints?.supportedCcs;
    if (!Array.isArray(list) || list.length === 0) return true; // not declared → allow all
    if (controller >= MIDI_CC.ALL_SOUND_OFF) return true; // 120..127 channel-mode/safety
    if (controller === MIDI_CC.BANK_SELECT || controller === MIDI_CC.BANK_SELECT_LSB) return true;
    return list.includes(controller);
  }

  /**
   * Delegates to the playback snapshot when present, otherwise to the
   * live CapabilityResolver. Returns null-constraint object when neither
   * is wired.
   */
  _getTimingConstraints(deviceId, channel) {
    if (this._snapshot) return this._snapshot.getTimingConstraints(deviceId, channel);
    return (
      this.capabilityResolver?.getTimingConstraints(deviceId, channel) ?? {
        minNoteInterval: null,
        minNoteDuration: null,
        polyphony: null,
        noteRangeMin: null,
        noteRangeMax: null,
        selectedNotes: null
      }
    );
  }

  /**
   * Snap a note to the nearest value in the instrument's discrete playable set
   * (`selectedNotes`), preserving the note only if it is already available.
   * Ties break downward. Used for instruments (kalimba, handpan, tuned
   * percussion…) that can only produce specific pitches, so an off-set note is
   * played as its closest available neighbour instead of being lost.
   *
   * @param {number} note
   * @param {number[]} selected - sorted or unsorted non-empty list of MIDI notes
   * @returns {number}
   */
  _snapToSelected(note, selected) {
    return snapToNearest(note, selected);
  }

  /**
   * Fold a note into the instrument's playable [min,max] window by whole
   * octaves, preserving pitch class. Notes outside the declared range would
   * otherwise be sent verbatim to an instrument that physically cannot produce
   * them (audit P1 — no range clamp by default). When no octave of the pitch
   * class fits (range narrower than an octave), clamp to the nearest bound.
   * Returns the note unchanged when the instrument declares no range.
   *
   * @param {number} note
   * @param {?number} min
   * @param {?number} max
   * @returns {number}
   */
  _foldIntoRange(note, min, max) {
    return foldIntoRange(note, min, max);
  }

  /**
   * Check if a noteOn should be gated (dropped) due to timing or polyphony constraints.
   * Also tracks active notes for polyphony enforcement.
   * @param {string} deviceId
   * @param {number} channel - Target channel on the device
   * @param {number} note - MIDI note number
   * @param {string} eventType - 'noteOn' or 'noteOff'
   * @returns {{gate:boolean, evictNote:?number}} `gate` true if the event must
   *   be dropped; `evictNote` is a still-sounding pitch the caller must release
   *   first to free a polyphony slot for the admitted note (keep-outer policy).
   */
  _shouldGateNote(deviceId, channel, note, eventType) {
    const cacheKey = `${deviceId}:${channel}`;
    const noteKey = `${cacheKey}:${note}`;
    const constraints = this._getTimingConstraints(deviceId, channel);

    if (eventType === MIDI_EVENT_TYPES.NOTE_OFF) {
      // If the matching noteOn was previously dropped by a constraint,
      // swallow exactly one noteOff for this pitch so it cannot cut a
      // still-sounding earlier note of the same pitch (audit P1 —
      // "note tracking insufficient").
      const dropped = this._droppedNoteOns.get(noteKey) || 0;
      if (dropped > 0) {
        this._droppedNoteOns.set(noteKey, dropped - 1);
        return { gate: true, evictNote: null }; // suppress: belongs to a dropped noteOn
      }
      // Decrement the active-note count (Map<note, count>) so overlapping
      // same-pitch notes are released one at a time, not all at once.
      const counts = this._activeNotes.get(cacheKey);
      if (counts) {
        const c = counts.get(note) || 0;
        if (c > 1) counts.set(note, c - 1);
        else counts.delete(note);
      }
      return { gate: false, evictNote: null }; // Never gate a real noteOff
    }

    // eventType === MIDI_EVENT_TYPES.NOTE_ON
    const now = performance.now();

    // min_note_interval. A MONOPHONIC instrument (polyphony === 1) has a single
    // shared actuator, so the re-strike guard applies PER CHANNEL — any two
    // consecutive strikes, even of different pitches, must respect it (audit
    // P3-a). A POLYPHONIC instrument has one actuator per pitch, so the guard is
    // PER PITCH — otherwise chord notes struck together would drop each other
    // (audit P2). `_lastNoteOnTime` is therefore keyed per-channel or per-pitch.
    const isMonophonic = constraints.polyphony === 1;
    const intervalKey = isMonophonic ? cacheKey : noteKey;
    if (constraints.minNoteInterval) {
      const lastTime = this._lastNoteOnTime.get(intervalKey) || 0;
      if (lastTime > 0 && now - lastTime < constraints.minNoteInterval) {
        this._droppedNoteOns.set(noteKey, (this._droppedNoteOns.get(noteKey) || 0) + 1);
        return { gate: true, evictNote: null }; // Gate: too fast for this instrument
      }
    }

    // Polyphony limit. When over the cap, mirror the offline adapter's
    // keep-outer policy (drop the MEDIAN voice, keep lowest+highest) instead of
    // always dropping the newest note, so live playback drops the same voices as
    // the baked file (audit P3-b). If the median is the incoming note, gate it;
    // otherwise evict the sounding median voice and admit the incoming note. The
    // count Map counts two overlapping same-pitch notes as two voices (audit P1).
    let evictNote = null;
    if (constraints.polyphony) {
      if (!this._activeNotes.has(cacheKey)) this._activeNotes.set(cacheKey, new Map());
      const counts = this._activeNotes.get(cacheKey);
      let activeVoices = 0;
      for (const c of counts.values()) activeVoices += c;
      if (activeVoices >= constraints.polyphony) {
        const sounding = [];
        for (const [n, cnt] of counts) for (let k = 0; k < cnt; k++) sounding.push(n);
        sounding.push(note);
        const victim = selectPolyphonyVictim(sounding);
        if (victim === note) {
          this._droppedNoteOns.set(noteKey, (this._droppedNoteOns.get(noteKey) || 0) + 1);
          return { gate: true, evictNote: null }; // Gate: incoming note is the median
        }
        // Evict one sounding instance of the victim pitch; its real note-off is
        // swallowed later (via _droppedNoteOns) so it can't cut a newer note.
        const vc = counts.get(victim) || 0;
        if (vc > 1) counts.set(victim, vc - 1);
        else counts.delete(victim);
        const victimKey = `${cacheKey}:${victim}`;
        this._droppedNoteOns.set(victimKey, (this._droppedNoteOns.get(victimKey) || 0) + 1);
        evictNote = victim;
      }
    }

    // Accept: register the active voice and timestamps.
    if (!this._activeNotes.has(cacheKey)) this._activeNotes.set(cacheKey, new Map());
    const counts = this._activeNotes.get(cacheKey);
    counts.set(note, (counts.get(note) || 0) + 1);
    this._lastNoteOnTime.set(intervalKey, now); // retrigger guard (per-pitch, or per-channel if monophonic)
    this._noteOnTimes.set(noteKey, now);
    // New sounding instance of this pitch — supersedes any deferred noteOff
    // still pending from a previous note on the same pitch (axis6-5).
    this._noteInstance.set(noteKey, (this._noteInstance.get(noteKey) || 0) + 1);

    return { gate: false, evictNote }; // Allow (optionally after evicting a voice)
  }

  /**
   * Compute how long (ms) a noteOff for this voice must be held back to
   * honour the instrument's `min_note_duration` constraint (audit P1). A
   * solenoid/actuator needs the note to stay physically engaged for a
   * minimum time; releasing it too soon can miss the strike entirely.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @param {number} note
   * @returns {number} Milliseconds to defer the noteOff (0 = send now).
   * @private
   */
  _noteOffDeferMs(deviceId, channel, note) {
    const constraints = this._getTimingConstraints(deviceId, channel);
    const minDur = constraints.minNoteDuration;
    if (!minDur) return 0;
    const noteKey = `${deviceId}:${channel}:${note}`;
    const startedAt = this._noteOnTimes.get(noteKey);
    if (startedAt === undefined) return 0;
    const held = performance.now() - startedAt;
    if (held >= minDur) return 0;
    return minDur - held;
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
    const elapsed = ((performance.now() - state.startTime) * rate) / 1000;
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

    // Dynamic lookahead: extend beyond base to accommodate large sync_delay compensations.
    // Under event-loop pressure, reduce the lookahead window to avoid queuing too many
    // setTimeout callbacks that will pile up and worsen the lag.
    const maxCompSec = this._getMaxActiveCompensation(state, getOutputForChannel) / 1000;
    const lagMs = this.eventLoopMonitor?.currentLag ?? 0;
    // Compensation is always added to targetTime below, so compensated
    // notes are never queued late regardless of the base lookahead. Under
    // event-loop pressure we still shrink the base window (fewer queued
    // setTimeout callbacks that would worsen the lag) but scale it gently
    // (x0.5 of the lag) instead of subtracting the full lag, so mild jitter
    // doesn't collapse the window and cause re-scheduling churn.
    const effectiveLookahead =
      lagMs > 20 ? Math.max(0.05, LOOKAHEAD_SECONDS - (lagMs / 1000) * 0.5) : LOOKAHEAD_SECONDS;
    // Hand-shift compensation fires note-ons up to _maxHandShiftMs early, so the
    // window must reach that far ahead too or those notes would queue late.
    const handShiftSec = this._handShiftEnabled ? this._maxHandShiftMs / 1000 : 0;
    const targetTime = state.position + effectiveLookahead + maxCompSec + handShiftSec;

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
    if (
      state._lastBroadcastPosition === undefined ||
      Math.floor(state.position * 10) !== Math.floor(state._lastBroadcastPosition * 10)
    ) {
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
      const rate = state.playbackRate > 0 ? state.playbackRate : 1;
      const delayMs = Math.max(0, ((event.time - currentPosition) * 1000) / rate);
      // Drive the MIDI clock at the EFFECTIVE tempo (file BPM × playbackRate)
      // so external gear (arpeggiators/drum machines) stays in sync when the
      // operator changes playback speed — the raw file tempo desynced them
      // above/below 1× (audit P2).
      const effectiveTempo = event.tempo * rate;
      this._emit(delayMs, () => {
        if (this.midiClockGenerator) {
          this.midiClockGenerator.setTempo(effectiveTempo);
        }
      });
      return;
    }

    const eventTime = event.time;
    // Divide wall-clock delay by playbackRate so a rate>1 fires events
    // proportionally sooner, matching the accelerated position advance
    // computed in tick().
    const rate = state.playbackRate > 0 ? state.playbackRate : 1;
    const delaySec = Math.max(0, eventTime - currentPosition) / rate;

    // SysEx is global (no MIDI channel), so it cannot be routed per-channel
    // like note/CC events (audit P0-3). Broadcast the raw frame to every
    // device that has any routing so GM/GS/XG resets and Master Volume
    // reach all instruments.
    if (event.type === MIDI_EVENT_TYPES.SYSEX) {
      this._emit(Math.max(0, delaySec * 1000), () => this._broadcastSysEx(event, state));
      return;
    }

    // Routing override: events injected by the hand-position planner for
    // a specific split-routing segment carry `_routeTo: { device,
    // targetChannel }` so they reach only that segment's device. Without
    // this bypass the generic split dispatch would broadcast the CC to
    // every segment of the split, which is wrong because each segment
    // may declare its own hands_config and CC number.
    if (event._routeTo && event._routeTo.device) {
      const syncDelay = this._getSyncDelay(event._routeTo.device, event._routeTo.targetChannel);
      const adjustedMs = Math.max(0, delaySec * 1000 - syncDelay);
      this._emit(adjustedMs, () =>
        this._sendEventToRouting(event, event._routeTo, state, callbacks)
      );
      return;
    }

    // For note events, pass the note and LOGICAL event type to routing for split
    // support. A velocity-0 note-on is a running-status note-off: route it as a
    // note-off so stateful split strategies (round_robin/alternate/least_loaded/
    // overflow) POP the segment its note-on pushed, instead of taking the
    // note-on path (push + counter increment) and stranding the note on the
    // wrong segment while dispatch emits an actual note-off (audit axis6-1).
    const isNoteEvent =
      event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF;
    const logicalNoteType = isNoteEvent
      ? event.type === MIDI_EVENT_TYPES.NOTE_ON && (event.velocity ?? 0) === 0
        ? MIDI_EVENT_TYPES.NOTE_OFF
        : event.type
      : null;
    const note = isNoteEvent ? (event.note ?? null) : null;
    const routing = getOutputForChannel(event.channel, note, logicalNoteType);

    if (!routing) {
      if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        if (this.logger.isWarnEnabled?.() ?? true) {
          this.logger.warn(`No output device for channel ${event.channel + 1}, skipping events`);
        }
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
      for (const segRouting of routing) {
        if (!segRouting || !segRouting.device) continue;
        const syncDelay = this._getSyncDelay(segRouting.device, segRouting.targetChannel);
        const adjustedMs = Math.max(0, delaySec * 1000 - syncDelay);
        this._emit(adjustedMs, () => this._sendEventToRouting(event, segRouting, state, callbacks));
      }
      return;
    }

    if (!routing.device) {
      // Dedup so a misconfigured channel cannot flood the log mid-playback.
      if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        if (this.logger.isWarnEnabled?.() ?? true) {
          this.logger.warn(`No output device for channel ${event.channel + 1}, skipping event`);
        }
      }
      return;
    }

    // Get sync_delay from cache using device + targetChannel key
    const syncDelay = this._getSyncDelay(routing.device, routing.targetChannel);

    // Apply sync_delay compensation (convert ms to seconds), plus optional
    // hand-shift travel time so a note whose actuator can't reach in time
    // departs early (0 unless enabled + this is a flagged note-on).
    const handShiftMs = this._handShiftMsFor(event);
    const adjustedMs = Math.max(0, delaySec * 1000 - syncDelay - handShiftMs);

    // Per-event debug — gated to avoid building the string when filtered out.
    if (syncDelay > 0 && delaySec * 1000 < syncDelay && (this.logger.isDebugEnabled?.() ?? false)) {
      this.logger.debug(
        `Compensation ${syncDelay.toFixed(0)}ms exceeds delay ${(delaySec * 1000).toFixed(0)}ms for ch${event.channel + 1}, sending immediately`
      );
    }

    // Pass the routing already resolved above so sendEvent does NOT call
    // getOutputForChannel a second time — a second call re-advances the
    // split overlap/round-robin counters, so every note landed on the same
    // segment and the other instruments stayed silent (audit P1).
    this._emit(adjustedMs, () =>
      this.sendEvent(event, state, getOutputForChannel, callbacks, routing)
    );
  }

  /**
   * Tickless emit helper: fires `emit()` directly when the residual
   * delay falls inside the {@link EMIT_AHEAD_MS} window, otherwise
   * schedules a single `setTimeout(residual)`. This collapses the
   * per-event timer cascade for near-due events while preserving exact
   * latency for events whose compensation puts them further out.
   *
   * @param {number} delayMs - Residual delay in milliseconds (≥ 0).
   * @param {Function} emit  - Side-effect to perform (send MIDI / set tempo).
   * @private
   */
  _emit(delayMs, emit) {
    if (delayMs <= EMIT_AHEAD_MS) {
      // Fired directly from the tick: the event goes out up to EMIT_AHEAD_MS
      // early. Record the earliness so operators can see the actual timing
      // distribution (audit P1 — "scheduler can send up to 5 ms early").
      if (delayMs > 0) {
        const m = this._metrics;
        m.earlyCount++;
        m.sumEarlinessMs += delayMs;
        if (delayMs > m.maxEarlinessMs) m.maxEarlinessMs = delayMs;
      }
      this._metrics.emitted++;
      emit();
      return;
    }
    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(timeoutId);
      this._metrics.emitted++;
      emit();
    }, delayMs);
    this.pendingTimeouts.add(timeoutId);
  }

  /**
   * Per-playback timing metrics for observability (reset by
   * {@link PlaybackScheduler#resetForPlayback}). `avgEarlinessMs` is over
   * the events that fired inside the EMIT_AHEAD window; `eventLoopLagMs` is
   * the current monitored loop lag when available.
   * @returns {{emitted:number, earlyCount:number, maxEarlinessMs:number,
   *   avgEarlinessMs:number, eventLoopLagMs:number}}
   */
  getTimingMetrics() {
    const m = this._metrics;
    return {
      emitted: m.emitted,
      earlyCount: m.earlyCount,
      maxEarlinessMs: m.maxEarlinessMs,
      avgEarlinessMs: m.earlyCount ? m.sumEarlinessMs / m.earlyCount : 0,
      eventLoopLagMs: this.eventLoopMonitor?.currentLag ?? 0
    };
  }

  /**
   * Send a MIDI event to the appropriate device.
   * @param {Object} event - MIDI event
   * @param {Object} state - Player state { playing, mutedChannels }
   * @param {Function} getOutputForChannel - Routing lookup
   */
  sendEvent(event, state, getOutputForChannel, callbacks, precomputedRouting) {
    if (!state.playing) {
      return;
    }

    // Skip muted channels
    if (state.mutedChannels && state.mutedChannels.has(event.channel)) {
      return;
    }

    const isNoteEvent =
      event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF;
    const note = isNoteEvent ? (event.note ?? null) : null;
    // A velocity-0 note-on is a logical note-off — route it as such so stateful
    // split strategies pop instead of push (mirror of scheduleEvent, axis6-1).
    const logicalNoteType = isNoteEvent
      ? event.type === MIDI_EVENT_TYPES.NOTE_ON && (event.velocity ?? 0) === 0
        ? MIDI_EVENT_TYPES.NOTE_OFF
        : event.type
      : null;
    // Reuse a routing already resolved by scheduleEvent when provided, so the
    // stateful split lookup runs exactly once per event (audit P1). Callers
    // that omit it (direct/test invocations) still resolve it here.
    const routing =
      precomputedRouting !== undefined
        ? precomputedRouting
        : getOutputForChannel(event.channel, note, logicalNoteType);

    // Handle broadcast for split routing (non-note events go to all segments)
    if (Array.isArray(routing)) {
      for (const segRouting of routing) {
        if (segRouting && segRouting.device) {
          this._sendEventToRouting(event, segRouting, state, callbacks);
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

    // Dispatch (transpose + gate + per-type send). Returns null when no
    // send was attempted (gated / CC-filtered / unhandled type). Returns a
    // typed {status} object otherwise; only a genuine disconnect/error
    // triggers the disconnect policy — a rate-limit drop or unsupported
    // message must NOT be mistaken for an unreachable device (audit P0-6).
    const sendResult = this._dispatchToDevice(event, routing, state);
    this._applyDisconnectPolicy(sendResult, routing.device, event.channel, state, callbacks);
  }

  /**
   * Apply the disconnect policy (`skip` | `pause` | `mute`) when a send
   * returns a genuine DISCONNECTED/ERROR status. Notifies once per device.
   * Factored out of {@link PlaybackScheduler#sendEvent} so the split /
   * broadcast path ({@link PlaybackScheduler#_sendEventToRouting}) applies
   * the same handling — previously a disconnected split segment went
   * undetected (audit P2). A rate-limit drop or unsupported message returns a
   * non-failure status and is ignored here.
   *
   * @param {?{status:string}} sendResult
   * @param {string} device
   * @param {number} channel
   * @param {Object} state
   * @param {Object} [callbacks]
   * @private
   */
  _applyDisconnectPolicy(sendResult, device, channel, state, callbacks) {
    const isFailure =
      sendResult &&
      (sendResult.status === SEND_STATUS.DISCONNECTED || sendResult.status === SEND_STATUS.ERROR);
    if (!isFailure || !device || this._failedDevices.has(device)) return;

    this._failedDevices.add(device);
    this.logger.warn(`Device unreachable during playback: ${device}`);

    const policy = state.disconnectedPolicy || 'skip';

    if (policy === 'pause') {
      this.wsServer?.broadcast('playback_device_disconnected', {
        deviceId: device,
        channel,
        policy: 'pause',
        message: `Device ${device} is unreachable`
      });
      if (callbacks && callbacks.onPause) {
        callbacks.onPause();
      }
    } else if (policy === 'mute') {
      // Auto-mute all channels routed to this device (including split segments).
      const mutedChannels = [];
      if (state.channelRouting) {
        for (const [ch, r] of state.channelRouting) {
          const routesToDevice =
            r &&
            (r.device === device ||
              (r.split &&
                Array.isArray(r.segments) &&
                r.segments.some((s) => s.device === device)));
          if (routesToDevice) {
            state.mutedChannels.add(ch);
            mutedChannels.push(ch);
          }
        }
      }
      this.wsServer?.broadcast('playback_device_disconnected', {
        deviceId: device,
        channel,
        policy: 'mute',
        mutedChannels,
        message: `Device ${device} is unreachable, channels auto-muted`
      });
    } else {
      // 'skip' - existing behavior
      this.wsServer?.broadcast('playback_device_error', {
        deviceId: device,
        channel,
        message: `Device ${device} is unreachable`
      });
    }
  }

  /**
   * Broadcast a raw SysEx frame to every device that has any routing (or
   * the default output device when nothing is explicitly routed). Each
   * device receives the frame exactly once.
   * @param {Object} event - `{ type:'sysEx', bytes:number[] }`
   * @param {Object} state
   * @private
   */
  _broadcastSysEx(event, state) {
    if (!state.playing) return;
    if (!Array.isArray(event.bytes) || event.bytes.length === 0) return;
    for (const device of this._collectRoutedDevices(state)) {
      this.deviceManager.sendMessage(device, DEVICE_MSG_TYPES.SYSEX, { bytes: event.bytes });
    }
  }

  /**
   * Collect the unique set of physical devices referenced by the current
   * routing map (including every segment of split routings), falling back
   * to the default output device when no explicit routing exists.
   * @param {Object} state
   * @returns {Set<string>}
   * @private
   */
  _collectRoutedDevices(state) {
    const devices = new Set();
    if (state.channelRouting) {
      for (const [, routing] of state.channelRouting) {
        if (!routing) continue;
        if (routing.split && routing.segments) {
          for (const seg of routing.segments) if (seg.device) devices.add(seg.device);
        } else {
          const device = typeof routing === 'string' ? routing : routing.device;
          if (device) devices.add(device);
        }
      }
    }
    if (devices.size === 0 && state.outputDevice) devices.add(state.outputDevice);
    return devices;
  }

  /**
   * Immediately dispatch a single control/state event (Bank Select /
   * Program Change / CC / pitch-bend / channel-pressure) to a routing
   * target, bypassing the scheduling window. Used by
   * {@link MidiPlayer#seek} to reconstruct channel state at the target
   * position before playback resumes (audit P0-8).
   * @param {Object} event
   * @param {{device:string, targetChannel:number}} routing
   * @param {Object} [state]
   */
  dispatchStateEvent(event, routing, state) {
    if (!routing || !routing.device) return;
    this._dispatchToDevice(event, routing, state || { playing: true });
  }

  /**
   * Send a single event to a specific routing target (used for split broadcast)
   * @param {Object} event
   * @param {Object} routing - { device, targetChannel }
   * @param {Object} state
   */
  _sendEventToRouting(event, routing, state, callbacks) {
    if (!state.playing) return;
    if (state.mutedChannels && state.mutedChannels.has(event.channel)) return;
    const sendResult = this._dispatchToDevice(event, routing, state);
    // Detect a disconnected split segment too (audit P2 — the broadcast path
    // used to ignore the dispatch result, so a dead split device was silent).
    this._applyDisconnectPolicy(sendResult, routing.device, event.channel, state, callbacks);
  }

  /**
   * Send through the device manager, preferring the typed
   * {@link DeviceManager#sendMessageEx} and falling back to the boolean
   * `sendMessage` (test doubles / older device managers that expose only
   * the boolean API). Always returns a typed `{status}` object.
   *
   * @param {string} deviceId
   * @param {string} type
   * @param {Object} data
   * @returns {{status:string, error?:Error}}
   * @private
   */
  _send(deviceId, type, data) {
    const dm = this.deviceManager;
    let result;
    if (typeof dm.sendMessageEx === 'function') {
      result = dm.sendMessageEx(deviceId, type, data);
    } else {
      const ok = dm.sendMessage(deviceId, type, data);
      result = { status: ok ? SEND_STATUS.SENT : SEND_STATUS.DISCONNECTED };
    }

    // Mirror a routed-out event onto the EventBus so lighting rules (and any
    // other `midi_routed` consumer) react to FILE PLAYBACK, not only to live
    // physical input — playback sends never went through MidiRouter, so
    // external fixtures stayed dark during a song (audit P1). Shape matches
    // MidiRouter's `midi_routed` payload. Only for actually-landed sends.
    if (
      typeof this.eventBus?.emit === 'function' &&
      (result.status === SEND_STATUS.SENT || result.status === SEND_STATUS.QUEUED)
    ) {
      this.eventBus.emit('midi_routed', {
        source: 'playback',
        destination: deviceId,
        type,
        data,
        timestamp: Date.now()
      });
    }
    return result;
  }

  /**
   * Shared dispatch core for {@link PlaybackScheduler#sendEvent} and
   * {@link PlaybackScheduler#_sendEventToRouting}: applies per-channel
   * transposition, enforces timing/polyphony gating, filters string/fret
   * CCs, then forwards the event to the device.
   *
   * Per-channel transposition is applied to note pitches just before the
   * device send so the routing/split decision (made by the caller) still
   * operates on source-note ranges as the operator sees them in the
   * routing modal. Out-of-range pitches are clamped to the valid MIDI
   * byte range.
   *
   * @param {Object} event
   * @param {{device:string, targetChannel:number}} routing
   * @param {Object} state
   * @returns {boolean|null} The device send result, or `null` when no
   *   send was attempted (gated, CC-filtered, or unhandled event type).
   * @private
   */
  _dispatchToDevice(event, routing, state) {
    const outChannel = routing.targetChannel;

    const transposeSemis =
      (state.channelTransposition ? state.channelTransposition.get(event.channel) || 0 : 0) +
      (state.globalTranspose || 0); // live global performance offset (audit P2)
    const isNoteTypeEvent =
      event.type === MIDI_EVENT_TYPES.NOTE_ON ||
      event.type === MIDI_EVENT_TYPES.NOTE_OFF ||
      event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH;
    let outNote = isNoteTypeEvent
      ? Math.max(0, Math.min(127, (event.note ?? 0) + transposeSemis))
      : event.note;

    // Apply per-channel note remapping AFTER transposition (mirrors the
    // adapted-file MidiTransposer order). Runtime application means the remap
    // — e.g. GM drum substitution — works even when playing the original
    // file with no baked adapted copy (audit P1 — note_remapping never
    // applied at playback). The same deterministic map is applied to the
    // matching note-off, so paired events stay consistent.
    if (isNoteTypeEvent && state.channelNoteRemapping) {
      const mapping = state.channelNoteRemapping.get(event.channel);
      if (mapping) {
        const remapped = mapping[outNote];
        if (remapped !== undefined && remapped !== null) {
          outNote = Math.max(0, Math.min(127, remapped));
        }
      }
    }

    // Fold an out-of-range pitch into the instrument's declared playable
    // window (octave fold, pitch-class preserving) so a note the instrument
    // physically cannot produce isn't sent verbatim (audit P1 — no range clamp
    // by default). Skip the GM drum channel (9): those are voice selectors,
    // not pitches, and drum remap already handles substitution.
    if (isNoteTypeEvent && event.channel !== 9) {
      // Fold into range, then snap to the physically playable set (explicit
      // selected_notes, else the octave_mode/scale_root scale). Shared with the
      // live router via NoteEnforcement so both paths clamp identically.
      outNote = clampNote(outNote, this._getTimingConstraints(routing.device, outChannel));
    }

    // Enforce timing and polyphony constraints for note events
    if (event.type === MIDI_EVENT_TYPES.NOTE_ON || event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      const isNoteOn = event.type === MIDI_EVENT_TYPES.NOTE_ON && (event.velocity ?? 0) > 0;
      const evtType = isNoteOn ? MIDI_EVENT_TYPES.NOTE_ON : MIDI_EVENT_TYPES.NOTE_OFF;
      const gateResult = this._shouldGateNote(routing.device, outChannel, outNote, evtType);
      if (gateResult.evictNote != null) {
        // Free a polyphony slot by releasing the evicted (median) voice before
        // the new note-on, matching the offline keep-outer policy (audit P3-b).
        this._sendNoteOff(routing.device, outChannel, gateResult.evictNote, 0);
      }
      if (gateResult.gate) {
        return null; // Gated: note dropped due to timing or polyphony constraint
      }
    }

    if (event.type === MIDI_EVENT_TYPES.NOTE_ON) {
      if (event.velocity === 0) {
        // velocity-0 noteOn == noteOff. Gating/counting was already applied
        // by the block above (it maps velocity-0 to NOTE_OFF), so do NOT
        // call _shouldGateNote again here (that double-decremented the
        // active-note count).
        return this._sendNoteOff(routing.device, outChannel, outNote, 0);
      }
      return this._send(routing.device, DEVICE_MSG_TYPES.NOTE_ON, {
        channel: outChannel,
        note: outNote,
        velocity: event.velocity
      });
    }
    if (event.type === MIDI_EVENT_TYPES.NOTE_OFF) {
      return this._sendNoteOff(routing.device, outChannel, outNote, event.velocity);
    }
    if (event.type === MIDI_EVENT_TYPES.PROGRAM_CHANGE) {
      return this._send(routing.device, DEVICE_MSG_TYPES.PROGRAM, {
        channel: outChannel,
        program: event.program
      });
    }
    if (event.type === MIDI_EVENT_TYPES.CONTROLLER) {
      // Filter CC 20/21 (string/fret select): only send for string instruments with cc_enabled
      if (event.controller === MIDI_CC_STRING_SELECT || event.controller === MIDI_CC_FRET_SELECT) {
        if (!this._isStringCCAllowed(routing.device, outChannel)) {
          return null;
        }
      } else if (
        !this._isCCSupported(event.controller, this._getTimingConstraints(routing.device, outChannel))
      ) {
        // Drop a CC the instrument does not declare in supported_ccs so an
        // unsupported controller can't deregulate the firmware (audit P2-4).
        return null;
      }
      return this._send(routing.device, DEVICE_MSG_TYPES.CC, {
        channel: outChannel,
        controller: event.controller,
        value: event.value
      });
    }
    if (event.type === MIDI_EVENT_TYPES.PITCH_BEND) {
      // `event.value` is the midi-file CENTERED value (-8192..8191, center 0).
      // Pass it in the unambiguous `centeredValue` field — the legacy `value`
      // field is treated as raw 14-bit for non-negatives, which turned a
      // return-to-center (0) into a full downward bend on BLE/net/serial
      // (audit P0). Also covers the seek state-reconstruction path.
      return this._send(routing.device, DEVICE_MSG_TYPES.PITCH_BEND, {
        channel: outChannel,
        centeredValue: event.value
      });
    }
    if (event.type === MIDI_EVENT_TYPES.CHANNEL_AFTERTOUCH) {
      return this._send(routing.device, DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH, {
        channel: outChannel,
        pressure: event.value
      });
    }
    if (event.type === MIDI_EVENT_TYPES.NOTE_AFTERTOUCH) {
      return this._send(routing.device, DEVICE_MSG_TYPES.POLY_AFTERTOUCH, {
        channel: outChannel,
        note: outNote,
        pressure: event.value
      });
    }
    return null; // unhandled event type — no send attempted
  }

  /**
   * Send a Note Off, deferring it when the note has not yet been held for
   * the instrument's `min_note_duration` (audit P1). Deferral reuses the
   * tracked `pendingTimeouts` so a stop/seek cancels the pending release.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @param {number} note
   * @param {number} velocity
   * @returns {{status:string}|null} Send result, or a queued marker when
   *   the release was deferred.
   * @private
   */
  _sendNoteOff(deviceId, channel, note, velocity) {
    const deferMs = this._noteOffDeferMs(deviceId, channel, note);
    const send = () =>
      this._send(deviceId, DEVICE_MSG_TYPES.NOTE_OFF, {
        channel,
        note,
        velocity
      });
    if (deferMs <= EMIT_AHEAD_MS) {
      return send();
    }
    // Defer to honour min_note_duration, but bind the release to THIS note
    // instance: if the same pitch is re-struck before the timer fires, a newer
    // instance id is recorded and this stale release is skipped so it doesn't
    // cut the retriggered note short — its own noteOff releases it (axis6-5).
    const noteKey = `${deviceId}:${channel}:${note}`;
    const instance = this._noteInstance.get(noteKey);
    this._emit(deferMs, () => {
      if (this._noteInstance.get(noteKey) !== instance) return;
      send();
    });
    return { status: SEND_STATUS.QUEUED };
  }

  /**
   * Send All Notes Off to all routed devices/channels.
   * @param {string} outputDevice - Default output device
   * @param {Map} channelRouting - Channel routing map
   * @param {Array} channels - MIDI channels from file
   */
  sendAllNotesOff(outputDevice, channelRouting, channels, resolveChannel = null) {
    this._broadcastCC(
      outputDevice,
      channelRouting,
      channels,
      resolveChannel,
      MIDI_CC_ALL_NOTES_OFF
    );
  }

  /**
   * Reset All Controllers (CC121, value 0) on every routed device/channel —
   * clears sustain (CC64), modulation, expression, etc. to defaults. Sent on a
   * BACKWARD seek / loop-to-start so stale forward-accumulated controllers (a
   * held sustain at the old position) don't carry over the jump and hang the
   * notes played after it (audit axis6-4).
   * @param {string} outputDevice
   * @param {Map} channelRouting
   * @param {Array} channels
   * @param {?Function} resolveChannel
   */
  resetControllers(outputDevice, channelRouting, channels, resolveChannel = null) {
    this._broadcastCC(
      outputDevice,
      channelRouting,
      channels,
      resolveChannel,
      MIDI_CC_RESET_ALL_CONTROLLERS
    );
  }

  /**
   * Send a single CC (value 0) to every channel actually routed to each
   * destination device. Shared by {@link sendAllNotesOff} and
   * {@link resetControllers}.
   * @private
   */
  _broadcastCC(outputDevice, channelRouting, channels, resolveChannel, controller) {
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

    // Also include channels from the MIDI file that have no explicit routing.
    // Resolve each through the omni-aware resolver when available so an
    // omni-fallback channel gets its panic on the omni instrument's device;
    // only truly unresolved channels fall back to the default output device.
    for (const ch of channels) {
      if (!channelRouting.has(ch.channel)) {
        let targets = [];
        if (resolveChannel) {
          const resolved = resolveChannel(ch.channel);
          if (Array.isArray(resolved)) targets = resolved.filter((t) => t && t.device);
          else if (resolved && resolved.device) targets = [resolved];
        }
        if (targets.length === 0) {
          targets = [{ device: outputDevice, targetChannel: ch.channel }];
        }
        for (const t of targets) {
          const dev = t.device;
          const tch = t.targetChannel != null ? t.targetChannel : ch.channel;
          if (!channelsPerDevice.has(dev)) channelsPerDevice.set(dev, new Set());
          channelsPerDevice.get(dev).add(tch);
        }
      }
    }

    // Send the CC only on the channels actually routed to each device
    for (const [targetDevice, chSet] of channelsPerDevice) {
      for (const channel of chSet) {
        try {
          device.sendMessage(targetDevice, 'cc', {
            channel: channel,
            controller,
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
    if (this._snapshot) return this._snapshot.getCompensationMs(deviceId, channel);
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
