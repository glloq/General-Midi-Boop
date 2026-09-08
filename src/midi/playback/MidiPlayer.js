/**
 * @file src/midi/playback/MidiPlayer.js
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
import PlaybackSnapshot from './PlaybackSnapshot.js';
import { PlaybackStateMachine, PLAYBACK_STATES } from './state/PlaybackStateMachine.js';
import HandAssigner from '../adaptation/HandAssigner.js';
import HandPositionPlanner from '../adaptation/HandPositionPlanner.js';
import LongitudinalPlanner from '../adaptation/LongitudinalPlanner.js';
import { planVoiceProgramChanges } from '../adaptation/VoiceSelector.js';
import { ConfigurationError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import {
  DEFAULT_MICROSECONDS_PER_BEAT,
  EVENT_ORDER_PRIORITY,
  TIMING
} from '../../core/constants.js';

/** Used to convert MIDI `microsecondsPerBeat` into BPM. */
const MICROSECONDS_PER_MINUTE = 60000000;

/** MIDI Channel Mode CC #123. */
const MIDI_CC_ALL_NOTES_OFF = 123;

/** Bank Select MSB (CC0) / LSB (CC32). */
const BANK_SELECT_CCS = new Set([0, 32]);
/**
 * Effective ordering priority slotted BETWEEN setTempo (1) and programChange
 * (3). Bank Select is a `controller` (default priority 4), which would sort it
 * AFTER a Program Change at the same tick — so the PC would latch the old bank
 * and the selected variation/drum-kit would be ignored (audit P1). Ordering
 * Bank Select just before the PC fixes it while leaving ordinary CCs after.
 */
const BANK_SELECT_PRIORITY = 2;

/**
 * Effective same-tick ordering priority for one event.
 * @param {Object} e
 * @returns {number}
 */
function eventPriority(e) {
  if (e.type === 'controller' && BANK_SELECT_CCS.has(e.controller)) {
    return BANK_SELECT_PRIORITY;
  }
  return EVENT_ORDER_PRIORITY[e.type] ?? 50;
}

/**
 * Deterministic comparator for the merged event list. Primary key is the
 * absolute time; ties (same tick across tracks) are broken by the standard
 * "state before notes" priority (see {@link EVENT_ORDER_PRIORITY}) and then
 * by the stable per-build sequence number so ordering never depends on
 * V8's unstable-for-large-arrays sort or on track iteration order.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareEvents(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  const pa = eventPriority(a);
  const pb = eventPriority(b);
  if (pa !== pb) return pa - pb;
  return (a._seq ?? 0) - (b._seq ?? 0);
}

/**
 * Maps `midi-file` event types to constructors that produce the
 * normalised event objects consumed by {@link PlaybackScheduler}. Each
 * builder is `(rawEvent, absoluteTimeSec) => normalisedEvent`.
 */
const EVENT_BUILDERS = {
  noteOn: (e, time) => ({
    time,
    type: 'noteOn',
    channel: e.channel ?? 0,
    note: e.noteNumber,
    velocity: e.velocity
  }),
  noteOff: (e, time) => ({
    time,
    type: 'noteOff',
    channel: e.channel ?? 0,
    note: e.noteNumber,
    velocity: e.velocity
  }),
  controller: (e, time) => ({
    time,
    type: 'controller',
    channel: e.channel ?? 0,
    controller: e.controllerType,
    value: e.value
  }),
  pitchBend: (e, time) => ({
    time,
    type: 'pitchBend',
    channel: e.channel ?? 0,
    value: e.value
  }),
  programChange: (e, time) => ({
    time,
    type: 'programChange',
    channel: e.channel ?? 0,
    program: e.programNumber !== undefined ? e.programNumber : e.value
  }),
  channelAftertouch: (e, time) => ({
    time,
    type: 'channelAftertouch',
    channel: e.channel ?? 0,
    value: e.value
  }),
  noteAftertouch: (e, time) => ({
    time,
    type: 'noteAftertouch',
    channel: e.channel ?? 0,
    note: e.noteNumber,
    value: e.value
  }),
  setTempo: (e, time) => ({
    time,
    type: 'setTempo',
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
    this.blobStore = deps.blobStore;
    this._deps = deps; // For lazy resolution of wsServer, deviceManager
    this.playing = false;
    this.paused = false;
    /** State machine for validated lifecycle transitions. */
    this.stateMachine = new PlaybackStateMachine(PLAYBACK_STATES.STOPPED);
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
    this.channelTransposition = new Map(); // channel -> semitones (signed integer)
    this.globalTranspose = 0; // live performance offset added to every channel
    this.channelNoteRemapping = new Map(); // channel -> { [srcNote]: destNote } (e.g. drum remap)
    this.mutedChannels = new Set(); // Muted channels

    // Queue / Playlist state
    this.queue = []; // [{ fileId, filename }]
    this.queueIndex = -1; // Current position (-1 = no queue)
    this.queueLoop = false; // Loop entire queue
    this.playlistId = null; // Active playlist ID
    this.queueGapSeconds = 0; // Delay between files (seconds)
    this.queueShuffle = false; // Shuffle mode
    this._gapTimer = null; // setTimeout handle for gap delay
    this._gapCountdownInterval = null; // Interval for countdown broadcast
    this._gapRemaining = 0; // Seconds remaining in gap

    // Disconnect policy: 'skip' | 'pause' | 'mute'
    this.disconnectedPolicy = 'skip';

    // Guard against concurrent _handleFileEnd calls
    this._fileEndPending = false;

    // Monotonic token that lets an in-flight async queue advance detect that it
    // was superseded (by stop() or a newer advance) while awaiting loadFile, so
    // it does not restart playback the user asked to stop (audit P3). `_advancing`
    // lets stop() finalize cleanly even though `playing` is briefly false during
    // the advance.
    this._playToken = 0;
    this._advancing = false;

    // Delegate scheduling, timing compensation, and event sending to PlaybackScheduler
    this.scheduler = new PlaybackScheduler(deps);

    // Reusable scheduler-tick state + callbacks. The scheduler fires ~100x/s;
    // allocating a fresh state object, a callbacks object and 6 closures on
    // every tick produced sustained young-gen GC pressure correlated with
    // playback jitter. We mutate a single state object in place and reuse
    // stable closures instead (see _schedulerTick).
    this._schedulerState = {
      playing: false,
      paused: false,
      position: 0,
      duration: 0,
      events: null,
      currentEventIndex: 0,
      startTime: 0,
      playbackRate: 1,
      loop: false,
      channelRouting: null,
      channelTransposition: null,
      mutedChannels: null,
      disconnectedPolicy: 'skip',
      _lastBroadcastPosition: undefined
    };
    this._getOutputForChannelBound = (channel, note, eventType) =>
      this.getOutputForChannel(channel, note, eventType);
    this._schedulerCallbacks = {
      onStop: () => this.stop(),
      onSeek: (pos) => this.seek(pos),
      onBroadcastPosition: () => this.broadcastPosition(),
      onFileEnd: () => this._handleFileEnd(),
      onPause: () => this.pause()
    };

    // MIDI Clock generator (injected via deps or set later)
    this.midiClockGenerator = deps.midiClockGenerator || null;

    // Per-playback immutable view of capability / compensation data.
    // null when no playback is active; built in play(), cleared in stop().
    this._snapshot = null;

    // Mutations arriving on `instrument_settings_changed` are deferred
    // while a snapshot is in effect — applied at stop() so the live
    // resolvers see them. Sub-typed payloads are accumulated; only the
    // last one wins (the event is fire-and-forget, no payload semantics).
    this._pendingMutationCount = 0;
    this._onSettingsChangedDeferred = () => {
      if (this._snapshot) {
        this._pendingMutationCount++;
      }
    };
    this._deps.eventBus?.on?.('instrument_settings_changed', this._onSettingsChangedDeferred);

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
        throw new NotFoundError('file', fileId);
      }
      if (!file.blob_path) {
        throw new ConfigurationError(`File ${fileId} (${file.filename}) has no blob_path`);
      }

      // Bytes live on disk under data/midi/<sha[0..1]>/<sha>.mid; resolved
      // by BlobStore. Re-parsed every load — for typical files this is
      // 5-15 ms on a Pi 4, well below playback startup budget.
      const buffer = this.blobStore.read(file.blob_path);
      let midi;
      try {
        midi = parseMidi(buffer);
      } catch (parseError) {
        throw new ValidationError(
          `File ${fileId} (${file.filename}) contains invalid MIDI data: ${parseError.message}`
        );
      }

      if (!midi || !midi.header || !Array.isArray(midi.tracks)) {
        throw new ValidationError(`File ${fileId} (${file.filename}) contains invalid MIDI data`);
      }

      // Reject formats/timings we cannot play back with a correct
      // chronology rather than silently producing wrong output (audit
      // P0-4). SMF format 2 holds independent sequences that cannot be
      // merged onto one timeline, and SMPTE (negative division) timing is
      // frame-based, not PPQ — playing it as PPQ 480 desynchronises it.
      if (midi.header.format === 2) {
        throw new ValidationError(
          `File ${fileId} (${file.filename}) is SMF format 2 (independent sequences), which is not supported for playback`
        );
      }
      // SMPTE frame timing is not PPQ; playing it as PPQ 480 desynchronises it.
      // The `midi-file` parser encodes SMPTE division as `framesPerSecond` +
      // `ticksPerFrame` and leaves `ticksPerBeat` UNDEFINED (never negative), so
      // the previous `ticksPerBeat < 0` guard never fired and SMPTE files were
      // silently played at PPQ 480. Detect it via the real fields and reject.
      const rawTicksPerBeat = midi.header.ticksPerBeat;
      if (midi.header.framesPerSecond != null && midi.header.ticksPerFrame != null) {
        throw new ValidationError(
          `File ${fileId} (${file.filename}) uses SMPTE frame-based timing, which is not supported for playback`
        );
      }

      this.ppq = rawTicksPerBeat && rawTicksPerBeat > 0 ? rawTicksPerBeat : 480;
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

      this.logger.info(
        `File loaded: ${file.filename} (${this.events.length} events, ${this.duration.toFixed(2)}s)`
      );

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
    const nameEvent = track.find((e) => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }

  extractTempo(midi) {
    for (const track of midi.tracks) {
      const tempoEvent = track.find((e) => e.type === 'setTempo');
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
      track.forEach((event) => {
        if (event.channel !== undefined && (event.type === 'noteOn' || event.type === 'noteOff')) {
          channelsSet.add(event.channel);
        }
      });
    });

    this.channels = Array.from(channelsSet)
      .sort((a, b) => a - b)
      .map((channel) => {
        const tracksUsingChannel = [];
        midi.tracks.forEach((track, trackIndex) => {
          const usesChannel = track.some((e) => e.channel === channel);
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

    this.logger.info(
      `Found ${this.channels.length} MIDI channels: ${this.channels.map((c) => c.channelDisplay).join(', ')}`
    );
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
    // Monotonic sequence number giving every event a stable identity so the
    // deterministic sort (see compareEvents) never depends on V8 sort
    // stability or on track iteration order (audit P1 "event ordering").
    let seq = 0;

    this.tracks.forEach((track) => {
      let trackTicks = 0;
      // Per-track pending SysEx buffer for divided/multi-packet SysEx
      // (F0 … then one or more F7 continuation packets). Reset per track.
      let pendingSysEx = null;
      track.events.forEach((event) => {
        trackTicks += event.deltaTime;
        const timeInSeconds = this._ticksToSecondsWithTempoMap(trackTicks, tempoMap);

        // SysEx / divided-SysEx capture (audit P0-3). midi-file emits
        // `sysEx` (0xF0 …) and `endSysEx` (0xF7 …) with `data` = the raw
        // payload bytes. Reassemble into a complete 0xF0 … 0xF7 frame.
        if (event.type === 'sysEx' || event.type === 'endSysEx') {
          const built = this._accumulateSysEx(pendingSysEx, event, timeInSeconds, track.index, seq);
          pendingSysEx = built.pending;
          if (built.event) {
            built.event._seq = seq++;
            this.events.push(built.event);
          }
          return;
        }

        const builder = EVENT_BUILDERS[event.type];
        if (builder) {
          const built = builder(event, timeInSeconds);
          // Tag the source track so downstream passes (hand-position
          // planner, split router) can use track identity when available.
          built.track = track.index;
          built._seq = seq++;
          this.events.push(built);
        }
      });
    });

    this.events.sort(compareEvents);

    // Deduplicate setTempo events at the same time (multiple tracks may contain identical tempo changes)
    this.events = this.events.filter((event, idx, arr) => {
      if (event.type !== 'setTempo') return true;
      if (idx === 0) return true;
      const prev = arr[idx - 1];
      return !(prev.type === 'setTempo' && prev.time === event.time && prev.tempo === event.tempo);
    });
  }

  /**
   * Append injected events to the timeline with a deterministic `_seq`
   * stamp, then re-sort. Injected CCs (tablature / hand-position) previously
   * carried no `_seq`, so `compareEvents` fell back to `0` for all of them
   * and their order among same-time / same-priority events depended on push
   * order — non-deterministic across runs (audit P2). Continuing the seq
   * counter past the current max gives every injected event a unique, stable
   * tiebreak.
   *
   * @param {Object[]} newEvents
   * @returns {void}
   * @private
   */
  _appendEventsWithSeq(newEvents) {
    if (!newEvents || newEvents.length === 0) return;
    let seq = 0;
    for (const e of this.events) {
      if ((e._seq ?? -1) >= seq) seq = e._seq + 1;
    }
    for (const e of newEvents) e._seq = seq++;
    this.events.push(...newEvents);
    this.events.sort(compareEvents);
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
        instrument = this.database.stringInstrumentDB.getStringInstrumentById(
          tab.string_instrument_id
        );
      } catch (e) {
        this.logger.debug(
          `Skipping tablature CC: instrument lookup failed for ID ${tab.string_instrument_id}`
        );
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
        const stringVal = Math.max(
          0,
          Math.min(127, Math.max(ccConfig.ccStringMin, Math.min(ccConfig.ccStringMax, stringRaw)))
        );
        const fretRaw = Math.round(bestMatch.fret) + ccConfig.ccFretOffset;
        const fretVal = Math.max(
          0,
          Math.min(127, Math.max(ccConfig.ccFretMin, Math.min(ccConfig.ccFretMax, fretRaw)))
        );

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
      this._appendEventsWithSeq(ccEvents);
      this.logger.info(
        `Injected ${ccEvents.length} tablature CC events for ${tabByChannel.size} channel(s)`
      );
    }
  }

  /**
   * Inject hand-position CC events (e.g. CC23 left / CC24 right) for
   * every source channel whose destination instrument declares a
   * `hands_config`. Destinations without the feature are skipped, so an
   * unconfigured playback pipeline is byte-identical to pre-feature.
   *
   * Must be called AFTER `channelRouting` is populated (before playback
   * starts) because the feature is looked up on the destination
   * instrument, not the source channel.
   *
   * Collected feasibility warnings are broadcast via the event bus so
   * the UI can surface them to the operator — non-blocking.
   *
   * @returns {number} Number of CC events injected.
   * @private
   */
  _injectHandPositionCCEvents() {
    // Remove any hand CCs left over from a previous pass FIRST, before any
    // early-return guard, so that re-routings don't accumulate and a replay
    // hitting a guard can't leave stale `_handInjected` CCs behind. Hand CCs
    // carry a `_handInjected` marker to make this safe and cheap (audit F6).
    if (this._handCCCount) {
      this.events = (this.events || []).filter((e) => !e._handInjected);
      this._handCCCount = 0;
    }
    if (!this.events || this.events.length === 0) return 0;
    if (!this.channelRouting || this.channelRouting.size === 0) return 0;
    if (!this.database?.getInstrumentCapabilities) return 0;

    const allCCs = [];
    const allWarnings = [];
    let hadAny = false;

    // Tablatures are loaded lazily once per call — frets-mode destinations
    // need them but keyboard-only sessions should not pay the DB round-trip.
    let tabByChannel = null;
    const getTabsForChannel = (srcChannel) => {
      if (tabByChannel === null) {
        tabByChannel = new Map();
        if (this.loadedFileId && this.database?.getTablaturesByFile) {
          try {
            const tabs = this.database.getTablaturesByFile(this.loadedFileId) || [];
            for (const t of tabs) {
              if (Array.isArray(t.tablature_data) && t.tablature_data.length > 0) {
                tabByChannel.set(t.channel ?? 0, t);
              }
            }
          } catch (e) {
            this.logger.debug(
              `Hand planner: no tablatures for file ${this.loadedFileId}: ${e.message}`
            );
          }
        }
      }
      return tabByChannel.get(srcChannel) || null;
    };

    /**
     * Plan hand CCs for one destination. `segmentFilter` is used by split
     * routings to restrict the notes that this destination actually plays
     * (matches the scheduler's own noteMin/noteMax logic).
     */
    const planForDestination = (srcChannel, device, targetChannel, segmentLabel, segmentFilter) => {
      let capabilities;
      try {
        capabilities = this.database.getInstrumentCapabilities(device, targetChannel);
      } catch (e) {
        return;
      }
      const handsCfg = capabilities?.hands_config;
      if (!handsCfg || handsCfg.enabled === false) return;
      if (!Array.isArray(handsCfg.hands) || handsCfg.hands.length === 0) return;

      // The file may already carry hand-position CCs baked in by
      // PlaybackAssignmentCommands.applyAssignments (the editor needs
      // them on disk to render). When that's the case we'd double-send
      // every event: one from the timeline + one from this injection.
      // Detect by looking for ANY controller event on `srcChannel` whose
      // controller number matches one of this destination's hands. If
      // found, skip — the baked stream is authoritative.
      const expectedCcNumbers = new Set(
        handsCfg.hands
          .map((h) => (h && Number.isInteger(h.cc_position_number) ? h.cc_position_number : null))
          .filter((v) => v !== null)
      );
      if (expectedCcNumbers.size > 0 && this._timelineHasHandCCs(srcChannel, expectedCcNumbers)) {
        this.logger.debug(
          `Hand planner (ch ${srcChannel + 1}${segmentLabel ? ` seg ${segmentLabel}` : ''}, ` +
            `device ${device}): timeline already carries CC(s) ${[...expectedCcNumbers].join(',')} — skipping injection`
        );
        return;
      }

      if (handsCfg.mode === 'frets') {
        this._planFretsForDestination({
          srcChannel,
          device,
          targetChannel,
          segmentLabel,
          segmentFilter,
          handsCfg,
          capabilities,
          getTabsForChannel,
          allCCs,
          allWarnings,
          markHadAny: () => {
            hadAny = true;
          }
        });
        return;
      }

      const notes = [];
      for (let i = 0; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.channel !== srcChannel) continue;
        if (e.type !== 'noteOn' || (e.velocity ?? 0) === 0) continue;
        if (segmentFilter && !segmentFilter(e.note)) continue;
        notes.push({
          time: e.time,
          // Tick is preserved alongside `time` so the assigner can match
          // operator pins keyed on (tick, note) — overrides are stored
          // in MIDI ticks for tempo independence.
          tick: e.tick,
          note: e.note,
          channel: e.channel,
          velocity: e.velocity,
          track: e.track
        });
      }
      if (notes.length === 0) return;

      const assigner = new HandAssigner(handsCfg);
      // Operator pins from the keyboard editor: `note_assignments` carrying
      // a `handId` (vs the strings shape with `string`/`fret`). The
      // assigner's optional `noteAssignments` arg honours them so the
      // operator's choice survives the auto/track/pitch_split decision.
      const routing = this.channelRouting.get(srcChannel);
      const handPins = (routing?.handOverrides?.note_assignments || []).filter(
        (a) => a && typeof a.handId === 'string' && a.handId.length > 0
      );
      const {
        assignments,
        warnings: assignWarnings,
        resolvedMode
      } = assigner.assign(notes, handPins.length > 0 ? { noteAssignments: handPins } : {});
      for (const w of assignWarnings) {
        allWarnings.push({ ...w, channel: srcChannel, segment: segmentLabel });
      }

      const tagged = notes.map((n, idx) => ({ ...n, hand: assignments[idx]?.hand }));

      const planner = new HandPositionPlanner(handsCfg, {
        noteRangeMin: capabilities?.note_range_min ?? null,
        noteRangeMax: capabilities?.note_range_max ?? null,
        minNoteIntervalMs: capabilities?.min_note_interval ?? 0
      });
      const { ccEvents, warnings: planWarnings } = planner.plan(tagged);
      for (const w of planWarnings) {
        allWarnings.push({ ...w, channel: srcChannel, segment: segmentLabel });
      }

      for (const cc of ccEvents) {
        cc._handInjected = true;
        // Route the CC straight to this destination; split broadcasts
        // would otherwise fire the same CC at every segment's device.
        cc._routeTo = { device, targetChannel };
        allCCs.push(cc);
      }
      if (ccEvents.length > 0) hadAny = true;

      this.logger.debug(
        `Hand planner (ch ${srcChannel + 1}${segmentLabel ? ` seg ${segmentLabel}` : ''}, ` +
          `device ${device}): ${ccEvents.length} CC events, ` +
          `${planWarnings.length + assignWarnings.length} warnings, mode=${resolvedMode}`
      );
    };

    for (const [srcChannel, routing] of this.channelRouting.entries()) {
      if (!routing) continue;

      if (routing.split && Array.isArray(routing.segments)) {
        // Split routing: plan per-segment so each destination gets a CC
        // stream that respects its own hand constraints, and only for
        // the notes it will actually play (segment noteMin..noteMax).
        for (let segIdx = 0; segIdx < routing.segments.length; segIdx++) {
          const seg = routing.segments[segIdx];
          if (!seg?.device) continue;
          const lo = seg.noteMin ?? 0;
          const hi = seg.noteMax ?? 127;
          const target = seg.targetChannel ?? srcChannel;
          planForDestination(
            srcChannel,
            seg.device,
            target,
            `${segIdx}[${lo}-${hi}]`,
            (n) => n >= lo && n <= hi
          );
        }
        continue;
      }

      if (!routing.device) continue;
      planForDestination(
        srcChannel,
        routing.device,
        routing.targetChannel ?? srcChannel,
        null,
        null
      );
    }

    // Retain the feasibility warnings so the scheduler can optionally
    // anticipate impossible actuator shifts (opt-in hand-shift compensation).
    this._handPositionWarnings = allWarnings;

    if (!hadAny) return 0;

    this._appendEventsWithSeq(allCCs);
    this._handCCCount = allCCs.length;

    if (allWarnings.length > 0) {
      // Broadcast non-blocking feasibility report so the UI can show it.
      this._deps.wsServer?.broadcast?.('playback_hand_position_warnings', {
        fileId: this.loadedFileId,
        warnings: allWarnings
      });
      this._deps.eventBus?.emit?.('playback_hand_position_warnings', {
        fileId: this.loadedFileId,
        warnings: allWarnings
      });
    }

    this.logger.info(
      `Injected ${allCCs.length} hand-position CC events (${allWarnings.length} warnings)`
    );
    return allCCs.length;
  }

  /**
   * Phase 8 — multi-voice program-change injection. When a destination
   * instrument has secondary GM voices (`instrument_voices`) AND the user has
   * cleared `voices_share_notes` (so each voice declares its own playable
   * notes), pick ONE voice per note-on by declared note capability
   * ({@link module:midi/adaptation/VoiceSelector}) and inject a Program Change
   * on the destination just before each note whose voice differs from the one
   * currently sounding. Mirrors {@link MidiPlayer#_injectHandPositionCCEvents}:
   * split segments are planned independently and injected events carry a
   * `_routeTo` so they reach only their destination, and a `_voiceInjected`
   * marker so a re-routing pass can strip the previous injection.
   *
   * Strict NO-OP (returns 0) unless a destination has `voices_share_notes = 0`
   * and at least one secondary voice declaring per-voice notes — instruments
   * without an explicit multi-voice configuration play exactly as before.
   *
   * NOTE: the audible result (voice switching on hardware) is validated on the
   * Pi (T9 runtime QA); this method's event planning is unit-tested against a
   * fake database in tests/midi-player-voice-injection.test.js.
   *
   * @returns {number} count of injected program-change events.
   * @private
   */
  _injectVoiceProgramChangeEvents() {
    // Strip any voice PCs left over from a previous pass FIRST, before any
    // early-return guard — otherwise a replay that hits a guard (routing
    // cleared, DB absent) would leave stale _voiceInjected PCs (with an old
    // _routeTo) in the stream (audit F6).
    if (this._voicePCCount) {
      this.events = (this.events || []).filter((e) => !e._voiceInjected);
      this._voicePCCount = 0;
    }
    if (!this.events || this.events.length === 0) return 0;
    if (!this.channelRouting || this.channelRouting.size === 0) return 0;
    if (!this.database?.getInstrumentCapabilities) return 0;
    if (typeof this.database.listInstrumentVoices !== 'function') return 0;

    const injected = [];

    const declaresNotes = (v) =>
      v &&
      v.gm_program != null &&
      ((v.note_selection_mode === 'range' &&
        Number.isInteger(v.note_range_min) &&
        Number.isInteger(v.note_range_max)) ||
        (v.note_selection_mode === 'discrete' &&
          Array.isArray(v.selected_notes) &&
          v.selected_notes.length > 0));

    const planForDestination = (srcChannel, device, targetChannel, segmentFilter) => {
      let capabilities;
      try {
        capabilities = this.database.getInstrumentCapabilities(device, targetChannel);
      } catch (e) {
        return;
      }
      // No-op unless the user opted into per-voice notes (voices_share_notes=0).
      if (!capabilities || capabilities.voices_share_notes !== 0) return;

      let voices;
      try {
        voices = this.database.listInstrumentVoices(device, targetChannel) || [];
      } catch (e) {
        return;
      }
      if (!voices.some(declaresNotes)) return; // nothing to discriminate on

      const primaryProgram = Number.isInteger(capabilities.gm_program)
        ? capabilities.gm_program
        : 0;

      // This destination's note-ons in time order (respecting split filter).
      const seq = [];
      for (const e of this.events) {
        if (e.channel !== srcChannel) continue;
        if (e.type !== 'noteOn' || (e.velocity ?? 0) === 0) continue;
        if (segmentFilter && !segmentFilter(e.note)) continue;
        seq.push(e);
      }
      if (seq.length === 0) return;

      const plan = planVoiceProgramChanges(seq, {
        primaryProgram,
        voices,
        sharesNotes: false,
        startProgram: primaryProgram
      });
      for (const change of plan) {
        const note = seq[change.index];
        injected.push({
          time: note.time,
          tick: note.tick,
          type: 'programChange',
          channel: srcChannel,
          program: change.program,
          _voiceInjected: true,
          _routeTo: { device, targetChannel }
        });
      }
    };

    for (const [srcChannel, routing] of this.channelRouting.entries()) {
      if (!routing) continue;
      if (routing.split && Array.isArray(routing.segments)) {
        for (const seg of routing.segments) {
          if (!seg?.device) continue;
          const lo = seg.noteMin ?? 0;
          const hi = seg.noteMax ?? 127;
          planForDestination(
            srcChannel,
            seg.device,
            seg.targetChannel ?? srcChannel,
            (n) => n >= lo && n <= hi
          );
        }
        continue;
      }
      if (!routing.device) continue;
      planForDestination(srcChannel, routing.device, routing.targetChannel ?? srcChannel, null);
    }

    if (injected.length === 0) return 0;
    this._appendEventsWithSeq(injected);
    this._voicePCCount = injected.length;
    this.logger.info(`Injected ${injected.length} voice program-change events`);
    return injected.length;
  }

  /**
   * @param {number} srcChannel
   * @param {Set<number>} expectedCcNumbers - controller numbers a given
   *   destination's `hands_config` would inject if not already present.
   * @returns {boolean} True when the loaded file already carries a
   *   controller event on `srcChannel` whose controller is in
   *   `expectedCcNumbers` and that did NOT originate from a prior
   *   in-memory injection (`_handInjected` marker). Used by
   *   {@link MidiPlayer#_injectHandPositionCCEvents} to avoid the
   *   double-emission problem described in TODO §"CC main absents".
   * @private
   */
  _timelineHasHandCCs(srcChannel, expectedCcNumbers) {
    if (!this.events || expectedCcNumbers.size === 0) return false;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e._handInjected) continue; // our own previous output — ignore
      if (e.type !== 'controller') continue;
      if (e.channel !== srcChannel) continue;
      if (expectedCcNumbers.has(e.controller)) return true;
    }
    return false;
  }

  /**
   * Fret-mode branch of {@link MidiPlayer#_injectHandPositionCCEvents}.
   * Reads the channel's persisted tablature (already laid out by the
   * TablatureConverter as `[{tick, string, fret, midiNote}, …]`), builds
   * planner input events with `fretPosition`, skips open strings so they
   * don't force unnecessary window shifts, and delegates window planning
   * to the generic {@link HandPositionPlanner} in 'frets' unit mode.
   *
   * The max reachable fret is taken from the associated `string_instrument`
   * (`max(frets_per_string)` or `num_frets`, with a 48 fretless floor).
   *
   * @private
   * @param {Object} ctx
   */
  _planFretsForDestination(ctx) {
    const {
      srcChannel,
      device,
      targetChannel,
      segmentLabel,
      segmentFilter,
      handsCfg,
      capabilities,
      getTabsForChannel,
      allCCs,
      allWarnings,
      markHadAny
    } = ctx;

    const tablature = getTabsForChannel(srcChannel);
    if (
      !tablature ||
      !Array.isArray(tablature.tablature_data) ||
      tablature.tablature_data.length === 0
    ) {
      this.logger.debug(
        `Hand planner (ch ${srcChannel + 1}, device ${device}): frets mode but no tablature — skipped`
      );
      return;
    }

    let stringInstrument = null;
    if (
      tablature.string_instrument_id &&
      this.database?.stringInstrumentDB?.getStringInstrumentById
    ) {
      try {
        stringInstrument = this.database.stringInstrumentDB.getStringInstrumentById(
          tablature.string_instrument_id
        );
      } catch (e) {
        this.logger.debug(
          `Hand planner: string_instrument ${tablature.string_instrument_id} lookup failed: ${e.message}`
        );
      }
    }

    // Max fret that can actually be addressed on this instrument. Fretless
    // instruments advertise num_frets=0; we give the planner a generous
    // ceiling (48 semitones / "frets") so fractional positions have room.
    let maxFret = 24;
    if (stringInstrument) {
      if (
        Array.isArray(stringInstrument.frets_per_string) &&
        stringInstrument.frets_per_string.length > 0
      ) {
        maxFret = stringInstrument.frets_per_string.reduce((a, b) => Math.max(a, b ?? 0), 0);
      } else if (Number.isFinite(stringInstrument.num_frets) && stringInstrument.num_frets > 0) {
        maxFret = stringInstrument.num_frets;
      } else if (stringInstrument.is_fretless || stringInstrument.num_frets === 0) {
        maxFret = 48;
      }
    }

    const tempoMap = this._buildTempoMap();
    const notes = [];
    for (const ev of tablature.tablature_data) {
      if (!Number.isFinite(ev.fret)) continue;
      if (ev.fret <= 0) continue; // open string: no fretting-hand constraint
      if (segmentFilter && ev.midiNote != null && !segmentFilter(ev.midiNote)) continue;
      const time = this._ticksToSecondsWithTempoMap(ev.tick, tempoMap);
      const endTime =
        Number.isFinite(ev.duration) && ev.duration > 0
          ? this._ticksToSecondsWithTempoMap(ev.tick + ev.duration, tempoMap)
          : null;
      notes.push({
        time,
        note: ev.midiNote,
        fretPosition: ev.fret,
        string: ev.string,
        duration: endTime != null ? Math.max(0, endTime - time) : undefined,
        channel: srcChannel,
        velocity: ev.velocity ?? 80,
        hand: 'fretting'
      });
    }
    if (notes.length === 0) return;

    notes.sort((a, b) => a.time - b.time);

    // Forward scale_length_mm to the planner so it can switch to the
    // position-dependent physical model when a hand span in mm is also
    // configured. When either input is missing, the planner falls back
    // to the constant-fret-window model (transparent to the caller).
    const scaleLengthMm =
      stringInstrument && Number.isFinite(stringInstrument.scale_length_mm)
        ? stringInstrument.scale_length_mm
        : null;

    // Planner selection: LongitudinalPlanner is now the default for
    // `string_sliding_fingers` whenever the geometric input is present.
    // It auto-derives its finger model from `max_fingers` + `hand_span_mm`
    // when no explicit `fingers[]` is given, so the V1.5 opt-in toggle is
    // gone. The V1 window planner stays as the fallback for
    // `fret_sliding_fingers` and for string instruments that lack a
    // scale length.
    const useLongitudinal =
      handsCfg &&
      handsCfg.mechanism === 'string_sliding_fingers' &&
      Number.isFinite(scaleLengthMm) &&
      scaleLengthMm > 0;

    const plannerCtx = {
      unit: 'frets',
      noteRangeMin: 0,
      noteRangeMax: maxFret,
      minNoteIntervalMs: capabilities?.min_note_interval ?? 0,
      scaleLengthMm
    };
    const planner = useLongitudinal
      ? new LongitudinalPlanner(handsCfg, plannerCtx)
      : new HandPositionPlanner(handsCfg, plannerCtx);
    const { ccEvents, warnings: planWarnings } = planner.plan(notes);
    for (const w of planWarnings) {
      allWarnings.push({ ...w, channel: srcChannel, segment: segmentLabel });
    }

    for (const cc of ccEvents) {
      cc._handInjected = true;
      cc._routeTo = { device, targetChannel };
      allCCs.push(cc);
    }
    if (ccEvents.length > 0) markHadAny();

    this.logger.debug(
      `Hand planner [frets/${useLongitudinal ? 'longitudinal' : 'window'}] ` +
        `(ch ${srcChannel + 1}${segmentLabel ? ` seg ${segmentLabel}` : ''}, ` +
        `device ${device}): ${ccEvents.length} CC events, ${planWarnings.length} warnings, ` +
        `maxFret=${maxFret}, scaleLengthMm=${scaleLengthMm ?? 'n/a'}`
    );
  }

  /**
   * Accumulate a (possibly divided) SysEx message into a complete
   * `0xF0 … 0xF7` byte frame. midi-file emits `sysEx` for the initial
   * `0xF0` packet and `endSysEx` for `0xF7` continuation/escape packets,
   * each with `data` holding the raw payload bytes (the leading 0xF0 and
   * trailing 0xF7 are NOT included in `data`).
   *
   * @param {?number[]} pending - Bytes accumulated so far, or null.
   * @param {Object} event - The `sysEx` / `endSysEx` raw event.
   * @param {number} time - Absolute time (s) of this packet.
   * @param {number} trackIndex
   * @returns {{ pending: ?number[], event: ?Object }} Updated pending
   *   buffer and, when the frame is complete, the normalised event.
   * @private
   */
  _accumulateSysEx(pending, event, time, trackIndex) {
    const data = Array.isArray(event.data) ? event.data : [];

    if (event.type === 'sysEx') {
      // A fresh F0 packet. It already carries its terminating F7 when the
      // message is not divided.
      const bytes = [0xf0, ...data];
      if (bytes[bytes.length - 1] === 0xf7) {
        return { pending: null, event: this._makeSysExEvent(bytes, time, trackIndex) };
      }
      // Divided: remember the start time and wait for continuation packets.
      return { pending: { bytes, time, trackIndex }, event: null };
    }

    // endSysEx (0xF7 …): a continuation of a divided SysEx, OR a raw
    // "escape" sequence when there is nothing pending.
    if (pending) {
      pending.bytes.push(...data);
      if (data[data.length - 1] === 0xf7) {
        return {
          pending: null,
          event: this._makeSysExEvent(pending.bytes, pending.time, pending.trackIndex)
        };
      }
      return { pending, event: null };
    }

    // Standalone escape packet: emit the raw bytes as-is so nothing is lost.
    return { pending: null, event: this._makeSysExEvent([...data], time, trackIndex) };
  }

  /**
   * @param {number[]} bytes - Complete SysEx frame.
   * @param {number} time
   * @param {number} trackIndex
   * @returns {Object}
   * @private
   */
  _makeSysExEvent(bytes, time, trackIndex) {
    return { time, type: 'sysEx', channel: -1, bytes, track: trackIndex };
  }

  _buildTempoMap() {
    const tempoEvents = [];

    this.tracks.forEach((track) => {
      let trackTicks = 0;
      track.events.forEach((event) => {
        trackTicks += event.deltaTime;
        if (event.type === 'setTempo') {
          tempoEvents.push({
            tick: trackTicks,
            microsecondsPerBeat: event.microsecondsPerBeat
          });
        }
      });
    });

    // Collect every tempo across all tracks with its absolute tick, sort
    // globally, then keep only the last value at each tick (a later track
    // overriding an earlier one at the same tick is undefined in the spec;
    // taking the last is deterministic given the stable sort input order).
    tempoEvents.sort((a, b) => a.tick - b.tick);

    // The SMF spec mandates 120 BPM (500000 µs/beat) until the first Set
    // Tempo. Seed the running tempo with that default — NOT with
    // `this.tempo`, which is the first setTempo found in track order and
    // may sit at a non-zero tick (audit P0-5).
    const tempoMap = [];
    let cumulativeSeconds = 0;
    let lastTick = 0;
    let currentMicrosecondsPerBeat = DEFAULT_MICROSECONDS_PER_BEAT;

    // Guarantee an explicit tick-0 anchor so ticks before the first Set
    // Tempo are always converted at 120 BPM. If a Set Tempo already sits at
    // tick 0 it will overwrite this entry below.
    if (!tempoEvents.length || tempoEvents[0].tick > 0) {
      tempoMap.push({ tick: 0, time: 0, microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT });
    }

    for (const te of tempoEvents) {
      const deltaTicks = te.tick - lastTick;
      const secondsPerTick = currentMicrosecondsPerBeat / (this.ppq * 1000000);
      cumulativeSeconds += deltaTicks * secondsPerTick;

      const existing =
        tempoMap.length && tempoMap[tempoMap.length - 1].tick === te.tick
          ? tempoMap[tempoMap.length - 1]
          : null;
      if (existing) {
        existing.microsecondsPerBeat = te.microsecondsPerBeat;
      } else {
        tempoMap.push({
          tick: te.tick,
          time: cumulativeSeconds,
          microsecondsPerBeat: te.microsecondsPerBeat
        });
      }

      lastTick = te.tick;
      currentMicrosecondsPerBeat = te.microsecondsPerBeat;
    }

    return tempoMap;
  }

  _ticksToSecondsWithTempoMap(ticks, tempoMap) {
    let activeEntry = {
      tick: 0,
      time: 0,
      microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT
    };

    for (const entry of tempoMap) {
      if (entry.tick <= ticks) {
        activeEntry = entry;
      } else {
        break;
      }
    }

    const deltaTicks = ticks - activeEntry.tick;
    const secondsPerTick = activeEntry.microsecondsPerBeat / (this.ppq * 1000000);
    return activeEntry.time + deltaTicks * secondsPerTick;
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
      throw new ConfigurationError('Output device required');
    }

    this.stateMachine.tryTransition(PLAYBACK_STATES.PLAYING);
    this.outputDevice = outputDevice;
    this.playing = true;
    this.paused = false;

    // Inject hand-position CC events now that routings are known. Safe to
    // call every start: the method is idempotent (removes prior injections
    // before re-running) and a no-op for instruments without hands_config.
    try {
      this._injectHandPositionCCEvents();
    } catch (err) {
      this.logger.warn(`Hand-position injection failed: ${err.message}`);
    }

    // Phase 8: inject per-note voice program-changes for multi-voice
    // instruments. Same idempotent/no-op contract as hand-position injection —
    // a strict no-op unless a destination declares per-voice notes.
    try {
      this._injectVoiceProgramChangeEvents();
    } catch (err) {
      this.logger.warn(`Voice program-change injection failed: ${err.message}`);
    }

    if (resumePosition !== null) {
      this.position = resumePosition;
      this.currentEventIndex = this.findEventIndexAtTime(resumePosition);
      // Rate-aware anchor: elapsed = (now - startTime) * rate must equal
      // resumePosition at the next tick.
      const rate = this.playbackRate > 0 ? this.playbackRate : 1;
      this.startTime = performance.now() - (resumePosition * 1000) / rate;
    } else {
      this.position = 0;
      this.currentEventIndex = 0;
      this.startTime = performance.now();
    }

    this.scheduler.resetForPlayback();

    // Build the per-playback snapshot so the hot path never re-queries
    // the DB for capability or compensation data, even if a UI mutation
    // fires `instrument_settings_changed` mid-playback. We pre-warm the
    // snapshot against the current routing map so the very first tick
    // already serves from the in-memory cache (no SQLite read inside the
    // critical path).
    this._snapshot = new PlaybackSnapshot({
      capabilityResolver: this._deps.capabilityResolver || null,
      compensationService: this._deps.compensationService || null,
      logger: this.logger
    });
    const warmed = this._snapshot.warmup(this.channelRouting);
    if (warmed > 0 && this.logger.isDebugEnabled?.()) {
      this.logger.debug(`Snapshot pre-warmed ${warmed} (device:channel) pairs`);
    }
    this._pendingMutationCount = 0;
    this.scheduler.setSnapshot(this._snapshot);
    // Feed the loaded file's hand-position feasibility warnings so the
    // scheduler can (when enabled) dispatch actuator-limited notes early.
    this.scheduler.setHandWarnings?.(this._handPositionWarnings || null);

    this.scheduler.startScheduler(() => {
      this._schedulerTick();
    });

    // Start MIDI clock if enabled, at the EFFECTIVE tempo (file tempo at the
    // current position × playbackRate) so external gear tracks the operator's
    // playback speed rather than the notated BPM (audit P2).
    if (this.midiClockGenerator) {
      const tempoAtPosition = this._getTempoAtPosition(this.position);
      const rate = this.playbackRate > 0 ? this.playbackRate : 1;
      this.midiClockGenerator.startPlayback(tempoAtPosition * rate);
    }

    this.broadcastStatus();

    this.logger.info(
      `Playback started on ${outputDevice} at position ${this.position.toFixed(2)}s`
    );
  }

  /**
   * Internal tick callback - delegates to PlaybackScheduler.tick()
   */
  _schedulerTick() {
    const state = this._schedulerState;
    state.playing = this.playing;
    state.paused = this.paused;
    state.position = this.position;
    state.duration = this.duration;
    state.events = this.events;
    state.currentEventIndex = this.currentEventIndex;
    state.startTime = this.startTime;
    state.playbackRate = this.playbackRate;
    state.loop = this.loop;
    state.channelRouting = this.channelRouting;
    state.outputDevice = this.outputDevice;
    state.channelTransposition = this.channelTransposition;
    state.globalTranspose = this.globalTranspose;
    state.channelNoteRemapping = this.channelNoteRemapping;
    state.mutedChannels = this.mutedChannels;
    state.disconnectedPolicy = this.disconnectedPolicy;
    state._lastBroadcastPosition = this._lastBroadcastPosition;

    // A callback invoked from INSIDE tick() can re-anchor the timeline
    // synchronously: end-of-file → single-file loop (`seek(0)` → `start()`),
    // end-of-file → `stop()`, or the `pause` disconnect policy. tick()
    // returns the index it entered with in those branches, so blindly
    // writing it back restored the cursor to the end of the file and the
    // loop's second pass emitted nothing at all (audit L05 F-56). Only sync
    // back when nothing re-anchored the player during the tick.
    const indexBefore = this.currentEventIndex;
    const startTimeBefore = this.startTime;
    const playingBefore = this.playing;

    const newIndex = this.scheduler.tick(
      state,
      this._getOutputForChannelBound,
      this._schedulerCallbacks
    );

    const reAnchored =
      this.currentEventIndex !== indexBefore ||
      this.startTime !== startTimeBefore ||
      this.playing !== playingBefore;
    if (reAnchored) return;

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

    this.stateMachine.tryTransition(PLAYBACK_STATES.PAUSED);
    this.paused = true;
    this.pauseTime = performance.now();
    // Freeze the EXACT position rather than the last tick's (up to one
    // SCHEDULER_TICK_MS stale). resume() rewinds the event cursor against
    // this value, so it has to be the real pause instant.
    const pauseRate = this.playbackRate > 0 ? this.playbackRate : 1;
    this.position = Math.min(this.duration, ((this.pauseTime - this.startTime) * pauseRate) / 1000);
    this.scheduler.stopScheduler();
    this.sendAllNotesOff();
    // All Notes Off just released every sounding voice; reset the scheduler's
    // per-note tracking so stale held-note state can't gate new noteOns after
    // resume on polyphony-limited instruments (audit P2).
    this.scheduler.resetNoteTracking?.();

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

    this.stateMachine.tryTransition(PLAYBACK_STATES.PLAYING);
    this.paused = false;
    const pauseDuration = performance.now() - this.pauseTime;
    this.startTime += pauseDuration;
    // pause() cancelled every event the scheduler had already queued inside
    // its lookahead window, but `currentEventIndex` still points PAST them —
    // so resuming skipped up to LOOKAHEAD_SECONDS of timeline: notes vanished
    // and a note-off could arrive with no matching note-on (audit L05 F-57).
    // Rewind the cursor to just after what was actually emitted. Everything
    // with `time <= position + EMIT_AHEAD_MS` already went out (the tickless
    // window fires those synchronously), so starting strictly after that
    // bound replays the cancelled events without duplicating any. The cursor
    // can only move BACKWARDS here.
    const emittedThrough = this.position + TIMING.EMIT_AHEAD_MS / 1000;
    let rewound = this.findEventIndexAtTime(emittedThrough);
    while (rewound < this.events.length && this.events[rewound].time <= emittedThrough) {
      rewound++;
    }
    if (rewound < this.currentEventIndex) {
      this.currentEventIndex = rewound;
    }
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
    // Invalidate any in-flight queue advance so its pending start() aborts.
    this._playToken++;
    this._clearGapTimer();

    // During a no-gap queue advance `playing` is briefly false (the next item is
    // still loading), so a naive `!this.playing` guard would make stop() a no-op
    // and the in-flight advance would restart playback. `_advancing` forces the
    // full stop cleanup in that window.
    const wasAdvancing = this._advancing;
    this._advancing = false;
    if (!this.playing && !wasAdvancing) {
      return;
    }

    this.stateMachine.tryTransition(PLAYBACK_STATES.STOPPED);
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

    // Tear down per-playback snapshot and flush any mutations that
    // arrived during playback. CapabilityResolver / CompensationService
    // already react to `instrument_settings_changed` on their own, but
    // we re-emit so any listener (UI status panel, metrics) can react
    // now that the deferral window is closed.
    this._releaseSnapshot();

    this.broadcastStatus();
    this.logger.info('Playback stopped');
  }

  /**
   * Detach the snapshot, notify the resolver/compensation services so
   * any deferred mutation is observable on the next lookup, and emit
   * `settings_applied` so the UI can refresh its status indicators.
   * Idempotent.
   * @private
   */
  _releaseSnapshot() {
    if (!this._snapshot) return;
    this.scheduler.clearSnapshot();
    this._snapshot.destroy();
    this._snapshot = null;

    if (this._pendingMutationCount > 0) {
      // Resolver and compensation service listen to the same event and
      // refresh their own caches; emit once more so a fresh tick reads
      // current DB state. We also surface a `settings_applied` event for
      // the UI so deferred-edit indicators can clear.
      this._deps.eventBus?.emit?.('instrument_settings_changed', { reason: 'playback_end' });
      this._deps.wsServer?.broadcast?.('settings_applied', {
        deferredCount: this._pendingMutationCount,
        timestamp: Date.now()
      });
      this._pendingMutationCount = 0;
    }
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
    if (this._onSettingsChangedDeferred) {
      this._deps.eventBus?.off?.('instrument_settings_changed', this._onSettingsChangedDeferred);
      this._onSettingsChangedDeferred = null;
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
    // A paused player has `playing === true`, so keying the post-seek action
    // off `this.playing` alone made seeking-while-paused RESTART playback
    // (audit P2). Distinguish the two: only actively-playing seeks resume.
    const wasActivelyPlaying = this.playing && !this.paused;
    const wasPaused = this.playing && this.paused;
    const seekPosition = Math.max(0, Math.min(position, this.duration));
    const prevPosition = this.position;
    const savedOutputDevice = this.outputDevice;

    this.stateMachine.tryTransition(PLAYBACK_STATES.SEEKING);

    if (this.playing) {
      this.scheduler.stopScheduler();
      this.sendAllNotesOff();
      // On a BACKWARD jump (scrub-back or loop-to-start), reset controllers too:
      // reconstruction below only re-applies controllers present AT the target,
      // it never clears a sustain (CC64) or other CC still held from the later
      // position — which would otherwise carry over and hang/over-sustain the
      // notes played after the jump (audit axis6-4).
      if (seekPosition < prevPosition) {
        this.resetControllers();
      }
      // Stop the clock only when we will restart it (active-play seek, where
      // start() calls startPlayback() again). For a PAUSED seek the clock is
      // already paused but still `_running`; calling stopPlayback() here clears
      // `_running`, so the later resume()'s resumePlayback() becomes a no-op and
      // external clock/transport sync is silently lost forever (audit P2).
      if (this.midiClockGenerator && wasActivelyPlaying) {
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

    // Reconstruct the MIDI channel state at the seek target so the
    // instruments resume with the correct bank/program/controllers/
    // pitch-bend and the last global SysEx (GM/GS/XG reset, master volume)
    // — not the stale state left over from before the jump (audit P0-8).
    try {
      this._emitReconstructedState(seekPosition);
    } catch (err) {
      this.logger.warn(`Seek state reconstruction failed: ${err.message}`);
    }

    if (wasActivelyPlaying) {
      this.start(savedOutputDevice, seekPosition);
    } else if (wasPaused) {
      // Stay PAUSED at the new position instead of resuming. Re-enter the
      // paused state with the scheduler stopped and anchor the clocks so a
      // later resume() continues from exactly `seekPosition`:
      //   resume() does startTime += (now - pauseTime), then elapsed =
      //   now - startTime. With pauseTime = startTime + seekPosition, that
      //   elapsed resolves to seekPosition regardless of pause duration.
      const rate = this.playbackRate || 1;
      const now = performance.now();
      this.playing = true;
      this.paused = true;
      this.startTime = now - (seekPosition * 1000) / rate;
      this.pauseTime = now;
      this.stateMachine.tryTransition(PLAYBACK_STATES.PAUSED);
      this.broadcastStatus();
      this.broadcastPosition();
    } else {
      this.broadcastPosition();
    }
  }

  /**
   * Scan the event list up to and including `position` and compute the
   * effective per-channel MIDI state (controllers, program, pitch bend,
   * channel pressure) plus the most recent global SysEx frame.
   *
   * @param {number} position - Target time in seconds.
   * @returns {{ channelState: Map<number, Object>, lastSysEx: ?Object }}
   * @private
   */
  _reconstructChannelStateAt(position) {
    const channelState = new Map();
    let lastSysEx = null;

    const getChannel = (channel) => {
      let st = channelState.get(channel);
      if (!st) {
        st = { controllers: new Map(), program: null, pitchBend: null, channelPressure: null };
        channelState.set(channel, st);
      }
      return st;
    };

    for (const ev of this.events) {
      // events are sorted by ascending time; everything at exactly the
      // seek position still belongs to the state we resume into.
      if (ev.time > position) break;
      switch (ev.type) {
        case 'controller':
          getChannel(ev.channel).controllers.set(ev.controller, ev.value);
          break;
        case 'programChange':
          getChannel(ev.channel).program = ev.program;
          break;
        case 'pitchBend':
          getChannel(ev.channel).pitchBend = ev.value;
          break;
        case 'channelAftertouch':
          getChannel(ev.channel).channelPressure = ev.value;
          break;
        case 'sysEx':
          lastSysEx = ev;
          break;
        default:
          break;
      }
    }

    return { channelState, lastSysEx };
  }

  /**
   * Emit the reconstructed channel state (see
   * {@link MidiPlayer#_reconstructChannelStateAt}) to the routed devices in
   * a spec-sensible order: Bank Select MSB/LSB → Program Change → remaining
   * controllers → pitch bend → channel pressure. Long notes that span the
   * seek point are intentionally NOT re-triggered (avoids spurious
   * re-attacks on mechanical instruments).
   *
   * @param {number} position
   * @returns {void}
   * @private
   */
  _emitReconstructedState(position) {
    if (!this.scheduler || typeof this.scheduler.dispatchStateEvent !== 'function') return;
    const { channelState, lastSysEx } = this._reconstructChannelStateAt(position);
    if (channelState.size === 0 && !lastSysEx) return;

    const dummyState = {
      playing: true,
      channelTransposition: this.channelTransposition,
      globalTranspose: this.globalTranspose,
      channelNoteRemapping: this.channelNoteRemapping,
      mutedChannels: new Set()
    };

    // Re-broadcast the last global SysEx (e.g. GM System On, GS/XG reset,
    // Master Volume) so the synth is back in the correct mode.
    if (lastSysEx && Array.isArray(lastSysEx.bytes)) {
      for (const device of this._routedDeviceSet()) {
        this._deps.deviceManager?.sendMessage(device, 'sysex', { bytes: lastSysEx.bytes });
      }
    }

    const BANK_MSB = 0;
    const BANK_LSB = 32;

    for (const [channel, st] of channelState) {
      const routing = this.getOutputForChannel(channel);
      const targets = Array.isArray(routing) ? routing : routing ? [routing] : [];
      for (const target of targets) {
        if (!target || !target.device) continue;
        const emit = (event) => this.scheduler.dispatchStateEvent(event, target, dummyState);

        if (st.controllers.has(BANK_MSB)) {
          emit({
            type: 'controller',
            channel,
            controller: BANK_MSB,
            value: st.controllers.get(BANK_MSB)
          });
        }
        if (st.controllers.has(BANK_LSB)) {
          emit({
            type: 'controller',
            channel,
            controller: BANK_LSB,
            value: st.controllers.get(BANK_LSB)
          });
        }
        if (st.program !== null) {
          emit({ type: 'programChange', channel, program: st.program });
        }
        // Remaining controllers in ascending CC order (bank select already sent).
        for (const cc of [...st.controllers.keys()].sort((a, b) => a - b)) {
          if (cc === BANK_MSB || cc === BANK_LSB) continue;
          emit({ type: 'controller', channel, controller: cc, value: st.controllers.get(cc) });
        }
        if (st.pitchBend !== null) {
          emit({ type: 'pitchBend', channel, value: st.pitchBend });
        }
        if (st.channelPressure !== null) {
          emit({ type: 'channelAftertouch', channel, value: st.channelPressure });
        }
      }
    }
  }

  /**
   * Unique set of physical devices referenced by the current routing map
   * (all split segments included), used for global (channel-less) sends
   * like SysEx during seek reconstruction.
   * @returns {Set<string>}
   * @private
   */
  _routedDeviceSet() {
    const devices = new Set();
    for (const [, routing] of this.channelRouting) {
      if (!routing) continue;
      if (routing.split && routing.segments) {
        for (const seg of routing.segments) if (seg.device) devices.add(seg.device);
      } else {
        const device = typeof routing === 'string' ? routing : routing.device;
        if (device) devices.add(device);
      }
    }
    if (devices.size === 0 && this.outputDevice) devices.add(this.outputDevice);
    return devices;
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
    let lo = 0,
      hi = this.events.length;
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
    // Pass the omni-aware resolver so channels routed only via the omni
    // fallback (absent from channelRouting) get their panic on the omni
    // instrument's device rather than the default output (audit P3 —
    // otherwise the omni instrument can retain stuck notes on stop/pause/seek).
    this.scheduler.sendAllNotesOff(this.outputDevice, this.channelRouting, this.channels, (ch) =>
      this.getOutputForChannel(ch)
    );
  }

  /**
   * Reset All Controllers (CC121) on every routed device/channel — clears a
   * held sustain (CC64) and other CCs to defaults. Called on a backward seek /
   * loop so stale forward-accumulated controllers don't hang the notes played
   * after the jump (audit axis6-4).
   * @returns {void}
   */
  resetControllers() {
    this.scheduler.resetControllers(this.outputDevice, this.channelRouting, this.channels, (ch) =>
      this.getOutputForChannel(ch)
    );
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
      return {
        success: false,
        bpm: this.tempo,
        playbackRate: this.playbackRate,
        originalTempo: this.originalTempo
      };
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
      this.startTime = now - (this.position * 1000) / rate;
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
    return {
      success: true,
      bpm: effectiveBpm,
      playbackRate: rate,
      originalTempo: this.originalTempo
    };
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
   * @param {?Object} [handOverrides] - Parsed `hand_position_overrides`
   *   for this routing (operator-pinned hand-anchors and
   *   note_assignments). Stored alongside the routing so the hand-
   *   planning path can honour them at runtime.
   * @returns {void}
   */
  setChannelRouting(channel, deviceId, targetChannel, handOverrides) {
    const target = targetChannel !== undefined && targetChannel !== null ? targetChannel : channel;
    // Release held notes via the OLD routing before switching, else the file's
    // note-off is sent to the NEW device and the old device's note hangs
    // (audit axis6-2). Panic first so All-Notes-Off targets the old destination.
    const prevRouting = this.channelRouting.get(channel);
    const routingChanged =
      !prevRouting ||
      prevRouting.split ||
      prevRouting.device !== deviceId ||
      prevRouting.targetChannel !== target;
    if (routingChanged && this.playing && !this.paused) {
      this._panicChannel(channel);
    }
    this.channelRouting.set(channel, {
      device: deviceId,
      targetChannel: target,
      handOverrides: handOverrides || null
    });
    this.logger.info(`Channel ${channel + 1} routed to ${deviceId} (target ch ${target + 1})`);

    this.scheduler.invalidateCompensationCache();

    const channelInfo = this.channels.find((c) => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = deviceId;
    }
  }

  /**
   * Set per-channel transposition applied at runtime to noteOn/noteOff
   * events (in semitones). Replaces any previous value. A zero value
   * clears the entry. The transposition is layered on top of routing
   * decisions: split routing still consults the source note (matches
   * the UI), but the device receives the shifted pitch.
   *
   * @param {number} channel
   * @param {number} semitones - signed integer; passing 0 clears.
   * @returns {void}
   */
  setChannelTransposition(channel, semitones) {
    const semi = Number.isFinite(semitones) ? Math.trunc(semitones) : 0;
    const prev = this.channelTransposition.get(channel) || 0;
    if (semi === 0) {
      this.channelTransposition.delete(channel);
    } else {
      this.channelTransposition.set(channel, semi);
    }
    // Release sounding notes on this channel so a note turned on under the old
    // offset can't be left stuck when its noteOff is emitted at the new pitch.
    if (semi !== prev && this.playing && !this.paused) {
      this._panicChannel(channel);
    }
  }

  /**
   * Set (or clear) a per-channel note-remapping table, applied at runtime by
   * the scheduler after transposition — e.g. GM drum substitution when a
   * pad instrument lacks a given drum voice. Applying it live means the
   * remap works even when playing the ORIGINAL file with no baked adapted
   * copy (audit P1 — note_remapping was persisted on routings but never
   * applied at playback).
   *
   * @param {number} channel
   * @param {?Object<string|number, number>} mapping - `{ srcNote: destNote }`;
   *   empty/null clears.
   * @returns {void}
   */
  /**
   * Set a GLOBAL live transposition (semitones) added to every channel on top
   * of any per-channel transposition — a performance control to shift the
   * whole song up/down without re-adapting. Applied at runtime by the
   * scheduler (audit P2 — `playback_transpose` was a no-op).
   *
   * @param {number} semitones - signed integer; 0 clears.
   * @returns {void}
   */
  setGlobalTranspose(semitones) {
    const next = Number.isFinite(semitones) ? Math.trunc(semitones) : 0;
    const prev = this.globalTranspose;
    this.globalTranspose = next;
    // A global change affects every channel: release all sounding notes and
    // reset the scheduler's voice tracking so notes turned on under the old
    // offset aren't left stuck (audit P2).
    if (next !== prev && this.playing && !this.paused) {
      this.sendAllNotesOff();
      this.scheduler.resetNoteTracking?.();
    }
  }

  setChannelNoteRemapping(channel, mapping) {
    const willHave = mapping && typeof mapping === 'object' && Object.keys(mapping).length > 0;
    // Release held notes before the remap changes, else a note turned on under
    // the old mapping is stranded when its note-off is emitted under the new one
    // (audit axis6-2).
    if ((this.channelNoteRemapping.has(channel) || willHave) && this.playing && !this.paused) {
      this._panicChannel(channel);
    }
    if (willHave) {
      this.channelNoteRemapping.set(channel, mapping);
    } else {
      this.channelNoteRemapping.delete(channel);
    }
  }

  /**
   * Split a channel across multiple destinations based on note range
   * (e.g. low notes → bass amp, high notes → guitar amp).
   *
   * @param {number} channel - Source MIDI channel.
   * @param {Array<Object>} segments - `[{ device_id, target_channel,
   *   split_note_min, split_note_max, split_polyphony_share,
   *   overlap_strategy }]`
   * @returns {void}
   */
  setChannelSplitRouting(channel, segments) {
    // Extract overlap_strategy from first segment that has one (shared across the split)
    const overlapStrategy = segments.find((s) => s.overlap_strategy)?.overlap_strategy || 'first';

    const splitRouting = {
      split: true,
      overlapStrategy,
      segments: segments.map((seg) => ({
        device: seg.device_id,
        targetChannel: seg.target_channel !== undefined ? seg.target_channel : channel,
        noteMin: seg.split_note_min ?? 0,
        noteMax: seg.split_note_max ?? 127,
        polyphonyShare: seg.split_polyphony_share ?? null
      }))
    };

    // Release held notes via the OLD routing before switching to the split
    // config, else in-flight notes strand (their note-off would resolve against
    // the new segments) (audit axis6-2). Only when the config actually changes,
    // so an idempotent re-apply doesn't needlessly cut sounding notes (audit
    // review) — mirrors the change-guard on setChannelRouting.
    const prevSplit = this.channelRouting.get(channel);
    const splitChanged =
      !prevSplit ||
      !prevSplit.split ||
      prevSplit.overlapStrategy !== splitRouting.overlapStrategy ||
      JSON.stringify(prevSplit.segments) !== JSON.stringify(splitRouting.segments);
    if (splitChanged && this.playing && !this.paused) {
      this._panicChannel(channel);
    }

    this.channelRouting.set(channel, splitRouting);
    this.scheduler.invalidateCompensationCache();

    const channelInfo = this.channels.find((c) => c.channel === channel);
    if (channelInfo) {
      channelInfo.assignedDevice = segments.map((s) => s.device_id).join('+');
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
    this.channelTransposition.clear();
    this.channelNoteRemapping.clear();
    this.scheduler.invalidateCompensationCache();
    this.invalidateOmniFallback();
    this.channels.forEach((c) => (c.assignedDevice = null));
    this.logger.info('All channel routing cleared');
  }

  /**
   * @returns {Object<number, Object>} Snapshot of the current routing
   *   map keyed by source channel.
   */
  getChannelRouting() {
    return this.channels.map((c) => {
      const routing = this.channelRouting.get(c.channel);
      const targetChannel = routing
        ? typeof routing === 'string'
          ? c.channel
          : routing.targetChannel
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
   * Record which split segment a noteOn was routed to, so the matching
   * noteOff (and any re-trigger) can replay the same decision in FIFO
   * order. Lazily allocates the per-note assignment map.
   * @param {number} channel
   * @param {number} note
   * @param {number} segIdx - Index into the `matching` segments array.
   * @private
   */
  _pushSegmentAssignment(channel, note, segIdx) {
    if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();
    const noteKey = `${channel}_${note}_seg`;
    let queue = this._overlapNoteAssign.get(noteKey);
    if (!queue) {
      queue = [];
      this._overlapNoteAssign.set(noteKey, queue);
    }
    queue.push(segIdx);
  }

  /**
   * Pop the segment index a prior noteOn recorded for (channel, note),
   * mirroring {@link MidiPlayer#_pushSegmentAssignment}. Returns -1 when
   * no assignment was tracked (untracked noteOff).
   * @param {number} channel
   * @param {number} note
   * @returns {number}
   * @private
   */
  _popSegmentAssignment(channel, note) {
    if (!this._overlapNoteAssign) this._overlapNoteAssign = new Map();
    const noteKey = `${channel}_${note}_seg`;
    const queue = this._overlapNoteAssign.get(noteKey);
    if (!queue || queue.length === 0) return -1;
    const idx = queue.shift();
    if (queue.length === 0) this._overlapNoteAssign.delete(noteKey);
    return idx;
  }

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
   * @returns {Object|Array|null} `{device, targetChannel}`, an array of
   *   such objects for broadcast (no-note events on a split), or null.
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
          const matching = routing.segments.filter(
            (seg) => note >= seg.noteMin && note <= seg.noteMax
          );

          if (matching.length === 1) {
            return { device: matching[0].device, targetChannel: matching[0].targetChannel };
          }

          if (matching.length > 1) {
            // Multiple segments cover this note — apply overlap strategy
            const strategy = routing.overlapStrategy || 'first';

            if (strategy === 'shared' || strategy === 'round_robin') {
              // Round-robin: alternate between matching segments using a per-channel counter
              if (!this._overlapCounters) this._overlapCounters = new Map();

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const assignedIdx = this._popSegmentAssignment(channel, note);
                const seg = matching[assignedIdx] || matching[0];
                return { device: seg.device, targetChannel: seg.targetChannel };
              }

              // noteOn: increment counter and record assignment (FIFO queue for re-triggers)
              const key = `${channel}_${note}`;
              const counter = this._overlapCounters.get(key) || 0;
              this._overlapCounters.set(key, counter + 1);
              const segIdx = counter % matching.length;
              const seg = matching[segIdx];
              this._pushSegmentAssignment(channel, note, segIdx);
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'second') {
              // Prefer last matching segment (deterministic: both noteOn and noteOff
              // always route to the same segment since matching.length is stable)
              if (eventType === 'noteOff') {
                const assignedIdx = this._popSegmentAssignment(channel, note);
                if (matching[assignedIdx]) {
                  const seg = matching[assignedIdx];
                  return { device: seg.device, targetChannel: seg.targetChannel };
                }
              }

              const segIdx = matching.length - 1;
              const seg = matching[segIdx];
              if (eventType === 'noteOn') {
                this._pushSegmentAssignment(channel, note, segIdx);
              }
              return { device: seg.device, targetChannel: seg.targetChannel };
            }

            if (strategy === 'least_loaded') {
              // Route to segment with fewer active notes
              if (!this._segmentNoteCounts) this._segmentNoteCounts = new Map();
              // On noteOff: decrement and route to same segment as the noteOn did (FIFO for re-triggers)
              if (eventType === 'noteOff') {
                const assignedIdx = this._popSegmentAssignment(channel, note);
                if (matching[assignedIdx]) {
                  const seg = matching[assignedIdx];
                  const segKey = `${seg.device}_${seg.targetChannel}`;
                  const count = this._segmentNoteCounts.get(segKey) || 0;
                  if (count > 0) this._segmentNoteCounts.set(segKey, count - 1);
                  return { device: seg.device, targetChannel: seg.targetChannel };
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
                if (count < bestCount) {
                  bestCount = count;
                  bestSeg = matching[i];
                  bestIdx = i;
                }
              }
              const segKey = `${bestSeg.device}_${bestSeg.targetChannel}`;
              this._segmentNoteCounts.set(segKey, (this._segmentNoteCounts.get(segKey) || 0) + 1);
              this._pushSegmentAssignment(channel, note, bestIdx);
              return { device: bestSeg.device, targetChannel: bestSeg.targetChannel };
            }

            if (strategy === 'overflow') {
              // Overflow: primary instrument (first segment) plays until its polyphony is full,
              // then excess notes go to secondary instrument (second segment).
              if (!this._segmentNoteCounts) this._segmentNoteCounts = new Map();
              const primarySeg = matching[0];
              const primaryKey = `${primarySeg.device}_${primarySeg.targetChannel}`;

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const assignedIdx = this._popSegmentAssignment(channel, note);
                if (matching[assignedIdx]) {
                  const seg = matching[assignedIdx];
                  const sKey = `${seg.device}_${seg.targetChannel}`;
                  const count = this._segmentNoteCounts.get(sKey) || 0;
                  if (count > 0) this._segmentNoteCounts.set(sKey, count - 1);
                  return { device: seg.device, targetChannel: seg.targetChannel };
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
                this._pushSegmentAssignment(channel, note, 1);
                return { device: overflowSeg.device, targetChannel: overflowSeg.targetChannel };
              }
              // Route to primary
              this._segmentNoteCounts.set(primaryKey, activeCount + 1);
              this._pushSegmentAssignment(channel, note, 0);
              return { device: primarySeg.device, targetChannel: primarySeg.targetChannel };
            }

            if (strategy === 'alternate') {
              // Alternate: global round-robin counter per channel (not per note pitch).
              // Each noteOn increments and picks next instrument, regardless of which note.
              if (!this._alternateCounters) this._alternateCounters = new Map();

              if (eventType === 'noteOff') {
                // Route noteOff to whichever segment got the corresponding noteOn (FIFO for re-triggers)
                const assignedIdx = this._popSegmentAssignment(channel, note);
                const seg = matching[assignedIdx] || matching[0];
                return { device: seg.device, targetChannel: seg.targetChannel };
              }

              // noteOn: increment global channel counter and record assignment (FIFO queue for re-triggers)
              const counter = this._alternateCounters.get(channel) || 0;
              this._alternateCounters.set(channel, counter + 1);
              const segIdx = counter % matching.length;
              const seg = matching[segIdx];
              this._pushSegmentAssignment(channel, note, segIdx);
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
            if (dist < minDist) {
              minDist = dist;
              closest = seg;
            }
          }
          return { device: closest.device, targetChannel: closest.targetChannel };
        }
        // No note specified (CC, pitchBend, etc.) → return all segments for broadcast
        return routing.segments.map((seg) => ({
          device: seg.device,
          targetChannel: seg.targetChannel
        }));
      }

      return routing;
    }

    // Omni fallback: if the user flagged one or more instruments as "accepts
    // all channels", route unrouted channels to the first omni instrument.
    // This is the use case "a single instrument on the device and I don't
    // want to care about which channel the MIDI file uses".
    const omniTarget = this._getOmniFallback();
    if (omniTarget) {
      return { device: omniTarget.device_id, targetChannel: omniTarget.channel };
    }

    if (this.channelRouting.size > 0) {
      return null;
    }

    return { device: this.outputDevice, targetChannel: channel };
  }

  /**
   * Cached lookup of the first omni-mode instrument row. Cache is invalidated
   * by {@link invalidateOmniFallback} — callers should invalidate on
   * `instrument_settings_changed`. Returns `null` when no omni instrument is
   * configured or the database is not available.
   */
  _getOmniFallback() {
    if (this._omniFallbackCache !== undefined) return this._omniFallbackCache;
    try {
      const rows = this.database?.getOmniInstruments?.() || [];
      this._omniFallbackCache = rows.length > 0 ? rows[0] : null;
    } catch {
      this._omniFallbackCache = null;
    }
    return this._omniFallbackCache;
  }

  invalidateOmniFallback() {
    this._omniFallbackCache = undefined;
  }

  /**
   * Send All Notes Off to the device(s) a single channel is currently routed
   * to. Used when a live change (transposition) would otherwise turn a note ON
   * under one pitch offset and emit its noteOff under a different one, leaving
   * the sounding pitch with no matching noteOff (stuck note, audit P2).
   * @param {number} channel
   * @returns {void}
   */
  _panicChannel(channel) {
    if (!this.outputDevice) return;
    const routing = this.getOutputForChannel(channel);
    const targets = Array.isArray(routing) ? routing : routing ? [routing] : [];
    for (const t of targets) {
      if (!t || !t.device) continue;
      try {
        this._deps.deviceManager?.sendMessage(t.device, 'cc', {
          channel: t.targetChannel != null ? t.targetChannel : channel,
          controller: MIDI_CC_ALL_NOTES_OFF,
          value: 0
        });
      } catch {
        /* device may be disconnected */
      }
    }
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
    this.queue = items.map((item) => ({ fileId: item.fileId, filename: item.filename }));
    this.queueIndex = -1;
    this.queueLoop = !!loop;
    this.playlistId = playlistId || null;
    this.queueGapSeconds = options.gapSeconds || 0;
    this.queueShuffle = !!options.shuffle;

    if (this.queueShuffle && this.queue.length > 1) {
      this._shuffleQueue();
    }

    this.logger.info(
      `Queue set: ${items.length} items, loop=${this.queueLoop}, shuffle=${this.queueShuffle}, gap=${this.queueGapSeconds}s, playlist=${this.playlistId}`
    );
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
      currentFile:
        this.queueIndex >= 0 && this.queueIndex < this.queue.length
          ? this.queue[this.queueIndex]
          : null
    };
  }

  _clearGapTimer() {
    const wasActive = this._gapTimer !== null || this._gapCountdownInterval !== null;
    if (this._gapTimer) {
      clearTimeout(this._gapTimer);
      this._gapTimer = null;
    }
    if (this._gapCountdownInterval) {
      clearInterval(this._gapCountdownInterval);
      this._gapCountdownInterval = null;
    }
    this._gapRemaining = 0;
    // Emit a terminal 0 so the UI countdown chip clears (audit fix: the client's
    // `remainingSeconds <= 0` clear branch was never reached — the countdown only
    // ever broadcast while > 0, then this timer fired silently, leaving the chip
    // frozen at "1s"). Covers both gap-end (next track starts) and
    // stop-during-gap, since both go through here.
    if (wasActive && this._deps.wsServer) {
      this._deps.wsServer.broadcast('playlist_waiting', {
        playlistId: this.playlistId,
        remainingSeconds: 0
      });
    }
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
      throw new ConfigurationError(`Queue index out of range: ${index}`);
    }

    // Claim this advance. A stop() (or a newer playQueueItem) that runs while we
    // await loadFile below will bump `_playToken`, and we bail before start()
    // rather than resurrect playback the user stopped (audit P3).
    const myToken = ++this._playToken;
    this._advancing = true;

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

    // Superseded while loading? stop() (or a newer advance) bumped the token —
    // do not start. Leave state ownership to whoever superseded us (stop()
    // already finalized; a newer playQueueItem will start itself).
    if (myToken !== this._playToken) {
      return;
    }
    this._advancing = false;

    // Auto-load saved routings from database
    this._loadRoutingsFromDB(item.fileId);

    // Determine output device
    let outputDevice = this.outputDevice;
    if (!outputDevice) {
      const devices = this._deps.deviceManager.getDeviceList();
      const outputDevices = devices.filter((d) => d.output && d.enabled);
      if (outputDevices.length === 0) {
        throw new ConfigurationError('No output devices available');
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
            this.nextInQueue().catch((err) => {
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
            const targetChannel =
              routing.target_channel !== undefined ? routing.target_channel : routing.channel;
            // Parse the JSON blob once on load — the hand-planning path
            // then reads from the in-memory routing entry without
            // re-parsing on every chord.
            let handOverrides = null;
            if (routing.hand_position_overrides != null) {
              try {
                handOverrides =
                  typeof routing.hand_position_overrides === 'string'
                    ? JSON.parse(routing.hand_position_overrides)
                    : routing.hand_position_overrides;
              } catch (e) {
                this.logger.warn(
                  `Invalid hand_position_overrides for ch ${routing.channel}: ${e.message}`
                );
              }
            }
            this.setChannelRouting(
              routing.channel,
              routing.device_id,
              targetChannel,
              handOverrides
            );
            // Per-channel transposition is applied at runtime so the
            // operator's choice in the routing modal survives a reload
            // even when no adapted file was generated.
            this.setChannelTransposition(routing.channel, routing.transposition_applied || 0);
            // Same for note remapping (e.g. GM drum substitution): apply it
            // live so it works when playing the original file too.
            if (routing.note_remapping != null) {
              let remap = routing.note_remapping;
              if (typeof remap === 'string') {
                try {
                  remap = JSON.parse(remap);
                } catch (e) {
                  this.logger.warn(
                    `Invalid note_remapping for ch ${routing.channel}: ${e.message}`
                  );
                  remap = null;
                }
              }
              this.setChannelNoteRemapping(routing.channel, remap);
            } else {
              this.setChannelNoteRemapping(routing.channel, null);
            }
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
