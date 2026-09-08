/**
 * @file src/files/MidiBaker.js
 * @description Bakes adaptation CC events (string select CC20, fret select
 * CC21, hand-position CC22+) directly into the MIDI file binary, replacing
 * the original blob in the BlobStore. Mirrors the injection logic of
 * {@link MidiPlayer} but operates entirely in tick-space so no playback
 * session is needed.
 */
import { parseMidi, writeMidi } from 'midi-file';
import HandAssigner from '../midi/adaptation/HandAssigner.js';
import HandPositionPlanner from '../midi/adaptation/HandPositionPlanner.js';
import LongitudinalPlanner from '../midi/adaptation/LongitudinalPlanner.js';
import {
  indexHandOverrides,
  isNoteDisabled,
  plannerAnchors
} from '../midi/adaptation/HandOverrides.js';

const MICROSECONDS_PER_MINUTE = 60_000_000;

class MidiBaker {
  /**
   * @param {Object} deps
   * @param {import('../persistence/Database.js').default} deps.database
   * @param {import('../storage/BlobStore.js').default} deps.blobStore
   * @param {Object} deps.logger
   */
  constructor({ database, blobStore, logger }) {
    this.database = database;
    this.blobStore = blobStore;
    this.logger = logger;
  }

  /**
   * Generate a new MIDI binary with all adaptation CC events embedded.
   *
   * @param {number|string} fileId
   * @returns {Promise<{buffer: Buffer, stats: {cc_events_added: number}}>}
   */
  async bake(fileId) {
    const id = Number(fileId);
    const file = this.database.getFile(id);
    if (!file) throw new Error(`File not found: ${id}`);
    if (!file.blob_path) throw new Error(`File ${id} has no blob_path`);

    const buffer = this.blobStore.read(file.blob_path);
    const midi = parseMidi(buffer);
    const ppq = midi.header.ticksPerBeat || 480;

    const tempoMap = this._buildTempoMap(midi, ppq);

    // Accumulate CC events per track index.
    const ccByTrack = new Map(); // Map<trackIdx, [{absTick, channel, controllerType, value}]>
    const addCCs = (trackIdx, events) => {
      const arr = ccByTrack.get(trackIdx) || [];
      arr.push(...events);
      ccByTrack.set(trackIdx, arr);
    };

    // 1. CC20 (string select) + CC21 (fret select) from tablature data.
    const tabCCs = this._generateTablatureCCs(id, midi);
    for (const [trackIdx, events] of tabCCs) addCCs(trackIdx, events);

    // 2. Hand-position CCs (CC22+) from routings + planners.
    let routings = [];
    try {
      routings = this.database.getRoutingsByFile(id, false) || [];
    } catch (e) {
      this.logger.debug(`MidiBaker: no routings for file ${id}: ${e.message}`);
    }
    // Operator overrides per source channel, indexed exactly like the live
    // player does (shared HandOverrides module) so both chains plan and strip
    // from identical inputs (R13 / F-139).
    const overridesByChannel = this._indexRoutingOverrides(routings);

    const handCCs = this._generateHandPositionCCs(
      id,
      midi,
      tempoMap,
      ppq,
      routings,
      overridesByChannel
    );
    for (const [trackIdx, events] of handCCs) addCCs(trackIdx, events);

    // 3. Notes the operator disabled in the hand-position editor: they are
    // REMOVED from the baked bytes, mirroring the live path where
    // PlaybackScheduler skips the `_handDisabled` events. Without this the
    // baked file still contains a note that live playback would not emit.
    const disabledCount = this._countDisabled(overridesByChannel);

    let totalAdded = 0;
    let totalRemoved = 0;
    const newTracks = midi.tracks.map((track, idx) => {
      const newCCs = ccByTrack.get(idx) || [];
      const removals =
        disabledCount > 0 ? this._collectDisabledEvents(track, overridesByChannel) : null;
      if (newCCs.length === 0 && (!removals || removals.size === 0)) return track;
      totalAdded += newCCs.length;
      totalRemoved += removals ? removals.size : 0;
      return this._mergeEventsIntoTrack(track, newCCs, removals);
    });

    const newBuffer = Buffer.from(writeMidi({ header: midi.header, tracks: newTracks }));
    this.logger.info(
      `MidiBaker: baked ${totalAdded} CC events into file ${id}` +
        (totalRemoved > 0 ? ` (removed ${totalRemoved} operator-disabled note events)` : '')
    );

    return {
      buffer: newBuffer,
      stats: { cc_events_added: totalAdded, note_events_removed: totalRemoved }
    };
  }

  // ---------------------------------------------------------------------------
  // Operator overrides (hand_position_overrides — R13 / F-139)
  // ---------------------------------------------------------------------------

  /**
   * Index every enabled routing's `hand_position_overrides` by source channel.
   * @private
   * @param {Array<Object>} routings
   * @returns {Map<number, import('../midi/adaptation/HandOverrides.js').HandOverrideIndex>}
   */
  _indexRoutingOverrides(routings) {
    const out = new Map();
    for (const routing of routings || []) {
      if (!routing || routing.enabled === false) continue;
      if (routing.hand_position_overrides == null) continue;
      const index = indexHandOverrides(routing.hand_position_overrides);
      if (index.isEmpty) continue;
      // Split routings share one source channel; merging is unnecessary because
      // the editors write one override blob per (file, channel) — last wins,
      // same rule as `indexHandOverrides` applies to duplicate pins.
      out.set(routing.channel, index);
    }
    return out;
  }

  /** @private @returns {number} total disabled entries across all channels. */
  _countDisabled(overridesByChannel) {
    let n = 0;
    for (const idx of overridesByChannel.values()) n += idx.disabled.size;
    return n;
  }

  /**
   * Indices of the raw track events belonging to an operator-disabled note —
   * the note-on AND its matching note-off — using the same one-at-a-time
   * pairing rule as `MidiPlayer._applyDisabledNotes`, so overlapping same-pitch
   * notes release correctly.
   *
   * @private
   * @param {Array<Object>} track - raw midi-file events (deltaTime based)
   * @param {Map<number, Object>} overridesByChannel
   * @returns {Set<number>} indices to drop
   */
  _collectDisabledEvents(track, overridesByChannel) {
    const drop = new Set();
    if (overridesByChannel.size === 0) return drop;
    const pendingOff = new Map();
    let absTick = 0;
    for (let i = 0; i < track.length; i++) {
      const ev = track[i];
      absTick += ev.deltaTime;
      const isNoteOn = ev.type === 'noteOn' && (ev.velocity ?? 0) > 0;
      const isNoteOff = ev.type === 'noteOff' || (ev.type === 'noteOn' && (ev.velocity ?? 0) === 0);
      if (!isNoteOn && !isNoteOff) continue;
      const key = `${ev.channel}:${ev.noteNumber}`;
      if (isNoteOn) {
        const index = overridesByChannel.get(ev.channel);
        if (index && isNoteDisabled(index, absTick, ev.noteNumber)) {
          drop.add(i);
          pendingOff.set(key, (pendingOff.get(key) || 0) + 1);
        }
        continue;
      }
      const waiting = pendingOff.get(key) || 0;
      if (waiting > 0) {
        drop.add(i);
        pendingOff.set(key, waiting - 1);
      }
    }
    return drop;
  }

  // ---------------------------------------------------------------------------
  // Tempo map helpers (mirrors MidiPlayer._buildTempoMap / _ticksToSecondsWithTempoMap)
  // ---------------------------------------------------------------------------

  /**
   * Build a tempo map: [{tick, time, microsecondsPerBeat}, …].
   * @private
   */
  _buildTempoMap(midi, ppq) {
    const DEFAULT_MICROS = MICROSECONDS_PER_MINUTE / 120; // 500000 (120 BPM)

    // Collect all setTempo events with their absolute tick positions.
    const tempoEvents = [];
    for (const track of midi.tracks) {
      let absTick = 0;
      for (const ev of track) {
        absTick += ev.deltaTime;
        // A malformed file can carry `microsecondsPerBeat <= 0` (e.g. FF 51 03
        // 00 00 00 parses fine); it would make secsPerTick 0 → Infinity/NaN
        // ticks → corrupted delta-times in the baked output. Skip non-positive
        // tempos, matching MidiFileParser.extractTempoMap (audit B2 baker).
        if (ev.type === 'setTempo' && ev.microsecondsPerBeat > 0) {
          tempoEvents.push({ tick: absTick, microsecondsPerBeat: ev.microsecondsPerBeat });
        }
      }
    }
    tempoEvents.sort((a, b) => a.tick - b.tick);

    const map = [];
    let cumSecs = 0;
    let lastTick = 0;
    // The SMF spec mandates 120 BPM until the first Set Tempo. Seed the
    // running tempo with that default — NOT the first tempo event's value,
    // which may sit at a non-zero tick — so baked event times match actual
    // playback (audit P1 — mirror MidiPlayer._buildTempoMap's tick-0 anchor).
    let curMicros = DEFAULT_MICROS;

    // Anchor tick 0 at 120 BPM unless a tempo event already sits there.
    if (!tempoEvents.length || tempoEvents[0].tick > 0) {
      map.push({ tick: 0, time: 0, microsecondsPerBeat: DEFAULT_MICROS });
    }

    for (const te of tempoEvents) {
      const delta = te.tick - lastTick;
      cumSecs += (delta * curMicros) / (ppq * 1e6);
      // A tempo event exactly at the previous entry's tick overwrites it
      // (deterministic last-wins) rather than appending a zero-width segment.
      const existing =
        map.length && map[map.length - 1].tick === te.tick ? map[map.length - 1] : null;
      if (existing) {
        existing.microsecondsPerBeat = te.microsecondsPerBeat;
      } else {
        map.push({ tick: te.tick, time: cumSecs, microsecondsPerBeat: te.microsecondsPerBeat });
      }
      lastTick = te.tick;
      curMicros = te.microsecondsPerBeat;
    }

    if (map.length === 0) {
      map.push({ tick: 0, time: 0, microsecondsPerBeat: DEFAULT_MICROS });
    }

    return map;
  }

  /**
   * Rightmost tempo-map entry whose `key` ('tick' or 'time') is ≤ value. The
   * map is built sorted ascending in BOTH tick and cumulative time, so a binary
   * search returns exactly what the previous linear scan did (default to entry
   * 0 when none qualify) in O(log n). The conversions below are called once per
   * event during hand-position CC generation, so the linear scan was
   * O(events × tempo-changes) and could freeze the bake on a file with a dense
   * tempo map (audit B2/B3 open item).
   * @private
   */
  _activeTempoEntry(tempoMap, key, value) {
    let lo = 0;
    let hi = tempoMap.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tempoMap[mid][key] <= value) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return tempoMap[ans];
  }

  /** @private Ticks → seconds (same algorithm as MidiPlayer._ticksToSecondsWithTempoMap). */
  _ticksToSeconds(ticks, tempoMap, ppq) {
    const active = this._activeTempoEntry(tempoMap, 'tick', ticks);
    return active.time + (ticks - active.tick) * (active.microsecondsPerBeat / (ppq * 1e6));
  }

  /** @private Seconds → ticks, unrounded. */
  _secondsToTicksExact(seconds, tempoMap, ppq) {
    const active = this._activeTempoEntry(tempoMap, 'time', seconds);
    const secsPerTick = active.microsecondsPerBeat / (ppq * 1e6);
    return active.tick + (seconds - active.time) / secsPerTick;
  }

  /** @private Seconds → ticks (inverse of above). */
  _secondsToTicks(seconds, tempoMap, ppq) {
    return Math.round(this._secondsToTicksExact(seconds, tempoMap, ppq));
  }

  /**
   * Tick for a planner CC event, honouring its `placement`.
   *
   * The planners emit a shift CC at `previous_note_on + 0.1 ms` ("as early as
   * possible") and the very first placement at `first_note − 0.1 ms`. That
   * epsilon is far below one tick (≈1 ms at 480 ppq / 120 BPM), so plain
   * rounding collapsed a shift CC onto the previous note's tick — where
   * `_mergeEventsIntoTrack` sorts controllers BEFORE note-ons and the baked
   * file moved the hand one note too early, while live playback moved it just
   * after. Rounding away from the reference note keeps both chains on the same
   * side of it (R16 — hand-CC ordering parity).
   *
   * @private
   */
  _ccEventTick(cc, tempoMap, ppq) {
    const raw = this._secondsToTicksExact(cc.time, tempoMap, ppq);
    const tick = cc.placement === 'post' ? Math.ceil(raw) : Math.round(raw);
    return Math.max(0, tick);
  }

  // ---------------------------------------------------------------------------
  // CC generation: tablature (CC20/21)
  // ---------------------------------------------------------------------------

  /**
   * Generate string-select (CC20) and fret-select (CC21) events from
   * persisted tablature rows.
   *
   * @private
   * @returns {Map<number, Array<{absTick, channel, controllerType, value}>>}
   */
  _generateTablatureCCs(fileId, midi) {
    const result = new Map();

    let tablatures;
    try {
      tablatures = this.database.getTablaturesByFile(fileId);
    } catch (e) {
      this.logger.debug(`MidiBaker: tablature lookup failed for file ${fileId}: ${e.message}`);
      return result;
    }
    if (!tablatures || tablatures.length === 0) return result;

    for (const tab of tablatures) {
      if (!Array.isArray(tab.tablature_data) || tab.tablature_data.length === 0) continue;
      if (!tab.string_instrument_id) continue;

      let instrument;
      try {
        instrument = this.database.stringInstrumentDB.getStringInstrumentById(
          tab.string_instrument_id
        );
      } catch (e) {
        this.logger.debug(
          `MidiBaker: instrument ${tab.string_instrument_id} lookup failed: ${e.message}`
        );
        continue;
      }
      if (!instrument || instrument.cc_enabled === false) continue;

      const ch = tab.channel ?? 0;
      const trackIdx = this._findTrackForChannel(midi, ch);

      const ccStr = instrument.cc_string_number ?? 20;
      const ccFret = instrument.cc_fret_number ?? 21;
      const strMin = instrument.cc_string_min ?? 1;
      const strMax = instrument.cc_string_max ?? 12;
      const strOff = instrument.cc_string_offset ?? 0;
      const fretMin = instrument.cc_fret_min ?? 0;
      const fretMax = instrument.cc_fret_max ?? 36;
      const fretOff = instrument.cc_fret_offset ?? 0;

      const events = [];
      for (const ev of tab.tablature_data) {
        const tick = ev.tick;

        const strVal = Math.max(
          0,
          Math.min(127, Math.max(strMin, Math.min(strMax, ev.string + strOff)))
        );
        const fretVal = Math.max(
          0,
          Math.min(127, Math.max(fretMin, Math.min(fretMax, Math.round(ev.fret) + fretOff)))
        );

        events.push({ absTick: tick, channel: ch, controllerType: ccStr, value: strVal });
        events.push({ absTick: tick, channel: ch, controllerType: ccFret, value: fretVal });
      }

      const existing = result.get(trackIdx) || [];
      result.set(trackIdx, existing.concat(events));
      this.logger.debug(
        `MidiBaker: ${events.length} tablature CC events for ch ${ch + 1} → track ${trackIdx}`
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // CC generation: hand position (CC22+)
  // ---------------------------------------------------------------------------

  /**
   * Generate hand-position CC events by running HandPositionPlanner /
   * LongitudinalPlanner for every routing that has a `hands_config`.
   *
   * @private
   * @returns {Map<number, Array<{absTick, channel, controllerType, value}>>}
   */
  _generateHandPositionCCs(fileId, midi, tempoMap, ppq, routings, overridesByChannel = new Map()) {
    const result = new Map();
    if (!routings || routings.length === 0) return result;

    // Lazy-load tablature map (only paid when frets-mode instruments exist).
    let tabByChannel = null;
    const getTab = (ch) => {
      if (tabByChannel === null) {
        tabByChannel = new Map();
        try {
          const tabs = this.database.getTablaturesByFile(fileId) || [];
          for (const t of tabs) {
            if (Array.isArray(t.tablature_data) && t.tablature_data.length > 0) {
              tabByChannel.set(t.channel ?? 0, t);
            }
          }
        } catch (e) {
          /* no tablature is fine */
        }
      }
      return tabByChannel.get(ch) || null;
    };

    for (const routing of routings) {
      if (!routing.enabled) continue;
      const srcCh = routing.channel;
      const device = routing.device_id;
      const targetCh = routing.target_channel ?? srcCh;
      if (!device) continue;

      let capabilities;
      try {
        capabilities = this.database.getInstrumentCapabilities(device, targetCh);
      } catch (e) {
        continue;
      }

      const handsCfg = capabilities?.hands_config;
      if (!handsCfg || handsCfg.enabled === false) continue;
      if (!Array.isArray(handsCfg.hands) || handsCfg.hands.length === 0) continue;

      const trackIdx = this._findTrackForChannel(midi, srcCh);
      const overrideIndex = overridesByChannel.get(srcCh) || indexHandOverrides(null);

      if (handsCfg.mode === 'frets') {
        const events = this._planFretsMode(
          srcCh,
          trackIdx,
          fileId,
          midi,
          tempoMap,
          ppq,
          handsCfg,
          capabilities,
          getTab,
          overrideIndex
        );
        if (events.length > 0) {
          const existing = result.get(trackIdx) || [];
          result.set(trackIdx, existing.concat(events));
        }
      } else {
        const events = this._planSemitonesMode(
          srcCh,
          trackIdx,
          midi,
          tempoMap,
          ppq,
          handsCfg,
          capabilities,
          overrideIndex
        );
        if (events.length > 0) {
          const existing = result.get(trackIdx) || [];
          result.set(trackIdx, existing.concat(events));
        }
      }
    }

    return result;
  }

  /**
   * Plan hand-position CCs for a string instrument (frets mode).
   * Mirrors MidiPlayer._planFretsForDestination.
   * @private
   */
  _planFretsMode(
    srcCh,
    trackIdx,
    fileId,
    midi,
    tempoMap,
    ppq,
    handsCfg,
    capabilities,
    getTab,
    overrideIndex = null
  ) {
    const tab = getTab(srcCh);
    if (!tab || !Array.isArray(tab.tablature_data) || tab.tablature_data.length === 0) return [];

    let stringInstrument = null;
    if (tab.string_instrument_id) {
      try {
        stringInstrument = this.database.stringInstrumentDB.getStringInstrumentById(
          tab.string_instrument_id
        );
      } catch (e) {
        /* ignore */
      }
    }

    // Determine max addressable fret on this instrument.
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

    const scaleLengthMm =
      stringInstrument && Number.isFinite(stringInstrument.scale_length_mm)
        ? stringInstrument.scale_length_mm
        : null;

    // Build planner note list from tablature (skip open strings — fret <= 0).
    const notes = [];
    for (const ev of tab.tablature_data) {
      if (!Number.isFinite(ev.fret) || ev.fret <= 0) continue;
      // Same exclusion as MidiPlayer._planFretsForDestination (R13 / F-139).
      if (isNoteDisabled(overrideIndex, ev.tick, ev.midiNote)) continue;
      const time = this._ticksToSeconds(ev.tick, tempoMap, ppq);
      notes.push({
        time,
        tick: ev.tick,
        note: ev.midiNote,
        fretPosition: ev.fret,
        string: ev.string,
        channel: srcCh,
        velocity: ev.velocity ?? 80,
        hand: 'fretting'
      });
    }
    if (notes.length === 0) return [];
    notes.sort((a, b) => a.time - b.time);

    const useLongitudinal =
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

    const { ccEvents, warnings } = planner.plan(notes, {
      anchors: plannerAnchors(overrideIndex)
    });
    if (warnings.length > 0) {
      this.logger.debug(
        `MidiBaker: ${warnings.length} hand-position warnings for ch ${srcCh + 1} (frets mode)`
      );
    }

    return ccEvents.map((cc) => ({
      absTick: this._ccEventTick(cc, tempoMap, ppq),
      channel: srcCh,
      controllerType: cc.controller,
      value: cc.value
    }));
  }

  /**
   * Plan hand-position CCs for a keyboard instrument (semitones mode).
   * @private
   */
  _planSemitonesMode(
    srcCh,
    trackIdx,
    midi,
    tempoMap,
    ppq,
    handsCfg,
    capabilities,
    overrideIndex = null
  ) {
    // Collect all note-ons for this channel from every track.
    const notes = [];
    for (const track of midi.tracks) {
      let absTick = 0;
      for (const ev of track) {
        absTick += ev.deltaTime;
        if (ev.type === 'noteOn' && ev.channel === srcCh && (ev.velocity ?? 0) > 0) {
          // Operator-disabled notes are stripped from the baked bytes, so they
          // must not shape the hand plan either (R13 / F-139).
          if (isNoteDisabled(overrideIndex, absTick, ev.noteNumber)) continue;
          notes.push({
            time: this._ticksToSeconds(absTick, tempoMap, ppq),
            tick: absTick,
            note: ev.noteNumber,
            channel: srcCh,
            velocity: ev.velocity
          });
        }
      }
    }
    if (notes.length === 0) return [];
    notes.sort((a, b) => a.time - b.time);

    const assigner = new HandAssigner(handsCfg);
    // Operator hand pins from the keyboard editor — the same list
    // MidiPlayer._injectHandPositionCCEvents feeds the assigner.
    const handPins = overrideIndex ? overrideIndex.handPins : [];
    const { assignments } = assigner.assign(
      notes,
      handPins.length > 0 ? { noteAssignments: handPins } : {}
    );
    const tagged = notes.map((n, i) => ({ ...n, hand: assignments[i]?.hand }));

    const planner = new HandPositionPlanner(handsCfg, {
      noteRangeMin: capabilities?.note_range_min ?? null,
      noteRangeMax: capabilities?.note_range_max ?? null,
      minNoteIntervalMs: capabilities?.min_note_interval ?? 0
    });
    const { ccEvents } = planner.plan(tagged, { anchors: plannerAnchors(overrideIndex) });

    return ccEvents.map((cc) => ({
      absTick: this._ccEventTick(cc, tempoMap, ppq),
      channel: srcCh,
      controllerType: cc.controller,
      value: cc.value
    }));
  }

  // ---------------------------------------------------------------------------
  // Track helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the first track index that owns noteOn events on `channel`.
   * Falls back to the last track so CCs always land somewhere.
   * @private
   */
  _findTrackForChannel(midi, channel) {
    for (let i = 0; i < midi.tracks.length; i++) {
      if (midi.tracks[i].some((ev) => ev.type === 'noteOn' && ev.channel === channel)) {
        return i;
      }
    }
    return Math.max(0, midi.tracks.length - 1);
  }

  /**
   * Insert new CC events into a track, sort by absolute tick (controllers
   * before noteOns at the same tick), and recompute delta times.
   *
   * @private
   * @param {Array<Object>} track - Raw midi-file events (with deltaTime).
   * @param {Array<{absTick:number, channel:number, controllerType:number, value:number}>} newCCEvents
   * @param {?Set<number>} [dropIndices] - Track-event indices to remove
   *   (operator-disabled notes, R13). Their tick gap is preserved because the
   *   rebuild works in absolute ticks.
   * @returns {Array<Object>} New track with recomputed delta times.
   */
  _mergeEventsIntoTrack(track, newCCEvents, dropIndices = null) {
    // Build the set of (channel, controllerType) pairs the bake is about
    // to (re)emit. Strip any pre-existing events on the same pairs so
    // that re-applying assignments does NOT stack new CCs on top of the
    // previous bake's output (accumulating gibberish across iterations).
    // This is the deliberate trade-off described in TODO §"CC main absents"
    // option A: manual edits to those CC streams in the editor are
    // overwritten by the next apply.
    const ownedPairs = new Set(newCCEvents.map((cc) => `${cc.channel}|${cc.controllerType}`));
    const stripPreviousBake = (ev) => {
      if (ev.type !== 'controller') return false;
      const key = `${ev.channel}|${ev.controllerType ?? ev.controller}`;
      return ownedPairs.has(key);
    };

    // Expand track events to absolute ticks, dropping any controller this
    // bake is about to re-emit.
    const expanded = [];
    let absTick = 0;
    for (let i = 0; i < track.length; i++) {
      const ev = track[i];
      absTick += ev.deltaTime;
      if (dropIndices && dropIndices.has(i)) continue;
      if (stripPreviousBake(ev)) continue;
      expanded.push({ ...ev, _absTick: absTick });
    }

    // Append new CC events.
    for (const cc of newCCEvents) {
      expanded.push({
        _absTick: cc.absTick,
        deltaTime: 0,
        type: 'controller',
        channel: cc.channel,
        controllerType: cc.controllerType,
        value: cc.value
      });
    }

    // Keep endOfTrack last: an injected CC whose tick is strictly greater than
    // the original end-of-track tick would otherwise sort AFTER it and be
    // silently dropped by spec-compliant players — losing the very adaptation
    // being baked (audit B2 baker). Push endOfTrack to >= the max event tick.
    const eot = expanded.find((e) => e.type === 'endOfTrack');
    if (eot) {
      const maxTick = expanded.reduce((m, e) => (e._absTick > m ? e._absTick : m), 0);
      eot._absTick = maxTick;
    }

    // Sort: by tick first; within the same tick, controllers precede noteOns,
    // and endOfTrack is forced strictly last.
    const typeOrder = { controller: 0, noteOn: 1, noteOff: 1, endOfTrack: 3 };
    expanded.sort((a, b) => {
      if (a._absTick !== b._absTick) return a._absTick - b._absTick;
      return (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2);
    });

    // Recompute delta times and strip the helper property.
    let prev = 0;
    return expanded.map((ev) => {
      const { _absTick, ...rest } = ev;
      rest.deltaTime = _absTick - prev;
      prev = _absTick;
      return rest;
    });
  }
}

export default MidiBaker;
