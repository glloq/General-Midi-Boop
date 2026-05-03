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

    // Determine initial tempo (first setTempo event across all tracks).
    let globalTempoMicros = MICROSECONDS_PER_MINUTE / 120;
    outer: for (const track of midi.tracks) {
      for (const ev of track) {
        if (ev.type === 'setTempo') {
          globalTempoMicros = ev.microsecondsPerBeat;
          break outer;
        }
      }
    }

    const tempoMap = this._buildTempoMap(midi, ppq, globalTempoMicros);

    // Accumulate CC events per track index.
    const ccByTrack = new Map(); // Map<trackIdx, [{absTick, channel, controllerType, value}]>
    const addCCs = (trackIdx, events) => {
      const arr = ccByTrack.get(trackIdx) || [];
      arr.push(...events);
      ccByTrack.set(trackIdx, arr);
    };

    // 1. CC20 (string select) + CC21 (fret select) from tablature data.
    const tabCCs = this._generateTablatureCCs(id, midi, tempoMap, ppq);
    for (const [trackIdx, events] of tabCCs) addCCs(trackIdx, events);

    // 2. Hand-position CCs (CC22+) from routings + planners.
    let routings = [];
    try {
      routings = this.database.getRoutingsByFile(id, false) || [];
    } catch (e) {
      this.logger.debug(`MidiBaker: no routings for file ${id}: ${e.message}`);
    }
    const handCCs = this._generateHandPositionCCs(id, midi, tempoMap, ppq, routings);
    for (const [trackIdx, events] of handCCs) addCCs(trackIdx, events);

    let totalAdded = 0;
    const newTracks = midi.tracks.map((track, idx) => {
      const newCCs = ccByTrack.get(idx);
      if (!newCCs || newCCs.length === 0) return track;
      totalAdded += newCCs.length;
      return this._mergeEventsIntoTrack(track, newCCs);
    });

    const newBuffer = Buffer.from(writeMidi({ header: midi.header, tracks: newTracks }));
    this.logger.info(`MidiBaker: baked ${totalAdded} CC events into file ${id}`);

    return { buffer: newBuffer, stats: { cc_events_added: totalAdded } };
  }

  // ---------------------------------------------------------------------------
  // Tempo map helpers (mirrors MidiPlayer._buildTempoMap / _ticksToSecondsWithTempoMap)
  // ---------------------------------------------------------------------------

  /**
   * Build a tempo map: [{tick, time, microsecondsPerBeat}, …].
   * @private
   */
  _buildTempoMap(midi, ppq, globalTempoMicros) {
    // Collect all setTempo events with their absolute tick positions.
    const tempoEvents = [];
    for (const track of midi.tracks) {
      let absTick = 0;
      for (const ev of track) {
        absTick += ev.deltaTime;
        if (ev.type === 'setTempo') {
          tempoEvents.push({ tick: absTick, microsecondsPerBeat: ev.microsecondsPerBeat });
        }
      }
    }
    tempoEvents.sort((a, b) => a.tick - b.tick);

    const map = [];
    let cumSecs = 0;
    let lastTick = 0;
    let curMicros = globalTempoMicros;

    for (const te of tempoEvents) {
      const delta = te.tick - lastTick;
      cumSecs += (delta * curMicros) / (ppq * 1e6);
      map.push({ tick: te.tick, time: cumSecs, microsecondsPerBeat: te.microsecondsPerBeat });
      lastTick = te.tick;
      curMicros = te.microsecondsPerBeat;
    }

    if (map.length === 0) {
      map.push({ tick: 0, time: 0, microsecondsPerBeat: curMicros });
    }

    return map;
  }

  /** @private Ticks → seconds (same algorithm as MidiPlayer._ticksToSecondsWithTempoMap). */
  _ticksToSeconds(ticks, tempoMap, ppq) {
    let active = tempoMap[0];
    for (const entry of tempoMap) {
      if (entry.tick <= ticks) active = entry;
      else break;
    }
    return active.time + (ticks - active.tick) * (active.microsecondsPerBeat / (ppq * 1e6));
  }

  /** @private Seconds → ticks (inverse of above). */
  _secondsToTicks(seconds, tempoMap, ppq) {
    let active = tempoMap[0];
    for (const entry of tempoMap) {
      if (entry.time <= seconds) active = entry;
      else break;
    }
    const secsPerTick = active.microsecondsPerBeat / (ppq * 1e6);
    return Math.round(active.tick + (seconds - active.time) / secsPerTick);
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
  _generateTablatureCCs(fileId, midi, tempoMap, ppq) {
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
        instrument = this.database.stringInstrumentDB.getStringInstrumentById(tab.string_instrument_id);
      } catch (e) {
        this.logger.debug(`MidiBaker: instrument ${tab.string_instrument_id} lookup failed: ${e.message}`);
        continue;
      }
      if (!instrument || instrument.cc_enabled === false) continue;

      const ch = tab.channel ?? 0;
      const trackIdx = this._findTrackForChannel(midi, ch);

      const ccStr  = instrument.cc_string_number ?? 20;
      const ccFret = instrument.cc_fret_number   ?? 21;
      const strMin = instrument.cc_string_min    ?? 1;
      const strMax = instrument.cc_string_max    ?? 12;
      const strOff = instrument.cc_string_offset ?? 0;
      const fretMin = instrument.cc_fret_min     ?? 0;
      const fretMax = instrument.cc_fret_max     ?? 36;
      const fretOff = instrument.cc_fret_offset  ?? 0;

      const events = [];
      for (const ev of tab.tablature_data) {
        const tick = ev.tick;

        const strVal = Math.max(0, Math.min(127,
          Math.max(strMin, Math.min(strMax, ev.string + strOff))
        ));
        const fretVal = Math.max(0, Math.min(127,
          Math.max(fretMin, Math.min(fretMax, Math.round(ev.fret) + fretOff))
        ));

        events.push({ absTick: tick, channel: ch, controllerType: ccStr,  value: strVal  });
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
  _generateHandPositionCCs(fileId, midi, tempoMap, ppq, routings) {
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
        } catch (e) { /* no tablature is fine */ }
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
      } catch (e) { continue; }

      const handsCfg = capabilities?.hands_config;
      if (!handsCfg || handsCfg.enabled === false) continue;
      if (!Array.isArray(handsCfg.hands) || handsCfg.hands.length === 0) continue;

      const trackIdx = this._findTrackForChannel(midi, srcCh);

      if (handsCfg.mode === 'frets') {
        const events = this._planFretsMode(
          srcCh, trackIdx, fileId, midi, tempoMap, ppq,
          handsCfg, capabilities, getTab
        );
        if (events.length > 0) {
          const existing = result.get(trackIdx) || [];
          result.set(trackIdx, existing.concat(events));
        }
      } else {
        const events = this._planSemitonesMode(
          srcCh, trackIdx, midi, tempoMap, ppq,
          handsCfg, capabilities
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
  _planFretsMode(srcCh, trackIdx, fileId, midi, tempoMap, ppq, handsCfg, capabilities, getTab) {
    const tab = getTab(srcCh);
    if (!tab || !Array.isArray(tab.tablature_data) || tab.tablature_data.length === 0) return [];

    let stringInstrument = null;
    if (tab.string_instrument_id) {
      try {
        stringInstrument = this.database.stringInstrumentDB
          .getStringInstrumentById(tab.string_instrument_id);
      } catch (e) { /* ignore */ }
    }

    // Determine max addressable fret on this instrument.
    let maxFret = 24;
    if (stringInstrument) {
      if (Array.isArray(stringInstrument.frets_per_string) && stringInstrument.frets_per_string.length > 0) {
        maxFret = stringInstrument.frets_per_string.reduce((a, b) => Math.max(a, b ?? 0), 0);
      } else if (Number.isFinite(stringInstrument.num_frets) && stringInstrument.num_frets > 0) {
        maxFret = stringInstrument.num_frets;
      } else if (stringInstrument.is_fretless || stringInstrument.num_frets === 0) {
        maxFret = 48;
      }
    }

    const scaleLengthMm = (stringInstrument && Number.isFinite(stringInstrument.scale_length_mm))
      ? stringInstrument.scale_length_mm
      : null;

    // Build planner note list from tablature (skip open strings — fret <= 0).
    const notes = [];
    for (const ev of tab.tablature_data) {
      if (!Number.isFinite(ev.fret) || ev.fret <= 0) continue;
      const time = this._ticksToSeconds(ev.tick, tempoMap, ppq);
      notes.push({
        time,
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

    const useLongitudinal = handsCfg.mechanism === 'string_sliding_fingers'
      && Number.isFinite(scaleLengthMm) && scaleLengthMm > 0;

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

    const { ccEvents, warnings } = planner.plan(notes);
    if (warnings.length > 0) {
      this.logger.debug(
        `MidiBaker: ${warnings.length} hand-position warnings for ch ${srcCh + 1} (frets mode)`
      );
    }

    return ccEvents.map(cc => ({
      absTick: this._secondsToTicks(cc.time, tempoMap, ppq),
      channel: srcCh,
      controllerType: cc.controller,
      value: cc.value
    }));
  }

  /**
   * Plan hand-position CCs for a keyboard instrument (semitones mode).
   * @private
   */
  _planSemitonesMode(srcCh, trackIdx, midi, tempoMap, ppq, handsCfg, capabilities) {
    // Collect all note-ons for this channel from every track.
    const notes = [];
    for (const track of midi.tracks) {
      let absTick = 0;
      for (const ev of track) {
        absTick += ev.deltaTime;
        if (ev.type === 'noteOn' && ev.channel === srcCh && (ev.velocity ?? 0) > 0) {
          notes.push({
            time: this._ticksToSeconds(absTick, tempoMap, ppq),
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
    const { assignments } = assigner.assign(notes, {});
    const tagged = notes.map((n, i) => ({ ...n, hand: assignments[i]?.hand }));

    const planner = new HandPositionPlanner(handsCfg, {
      noteRangeMin: capabilities?.note_range_min ?? null,
      noteRangeMax: capabilities?.note_range_max ?? null,
      minNoteIntervalMs: capabilities?.min_note_interval ?? 0
    });
    const { ccEvents } = planner.plan(tagged);

    return ccEvents.map(cc => ({
      absTick: this._secondsToTicks(cc.time, tempoMap, ppq),
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
      if (midi.tracks[i].some(ev => ev.type === 'noteOn' && ev.channel === channel)) {
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
   * @returns {Array<Object>} New track with recomputed delta times.
   */
  _mergeEventsIntoTrack(track, newCCEvents) {
    // Expand track events to absolute ticks.
    const expanded = [];
    let absTick = 0;
    for (const ev of track) {
      absTick += ev.deltaTime;
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

    // Sort: by tick first; within the same tick, controllers precede noteOns.
    const typeOrder = { controller: 0, noteOn: 1, noteOff: 1 };
    expanded.sort((a, b) => {
      if (a._absTick !== b._absTick) return a._absTick - b._absTick;
      return (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2);
    });

    // Recompute delta times and strip the helper property.
    let prev = 0;
    return expanded.map(ev => {
      const { _absTick, ...rest } = ev;
      rest.deltaTime = _absTick - prev;
      prev = _absTick;
      return rest;
    });
  }
}

export default MidiBaker;
