// public/js/features/auto-assign/RoutingSummaryPreview.js
// Pure data transforms used by the preview path (P2-F.4x).
// Extracted from RoutingSummaryPage.js to remove the duplicated split-channel
// note redistribution algorithm shared by `_previewAll` and `_previewChannel`.
// Exposed on `window.RoutingSummaryPreview` — IIFE+globals.

(function() {
  'use strict';

  /**
   * Redistribute noteOn/noteOff/CC events of one source channel to multiple
   * target channels according to per-segment note ranges and an overlap
   * strategy. Mutates `midiData.tracks[*].events` in place.
   *
   * @param {object}  midiData          Parsed MIDI structure ({ tracks: [{events}] })
   * @param {number}  sourceChannel     Channel whose events get redistributed
   * @param {Array}   segments          [{ noteRange:{min,max}, polyphonyShare?, fullRange? }]
   * @param {Array}   segChannels       [chSeg0, chSeg1, ...] target channel per segment
   * @param {string}  [overlapStrategy] 'shared' | 'alternate' | 'overflow' | undefined
   * @param {object}  [chRemap]         { ccNum: -1 } to fully suppress a CC
   * @param {object}  [chSegMute]       { ccNum: Set<segIdx> } per-segment CC mute
   */
  function redistributeSplitChannel({
    midiData,
    sourceChannel,
    segments,
    segChannels,
    overlapStrategy,
    chRemap = {},
    chSegMute = {}
  }) {
    let alternateCounter = 0;
    const activeNotes = new Map();
    for (const sCh of segChannels) activeNotes.set(sCh, 0);
    const segPolyphony = segments.map(seg => seg.polyphonyShare || seg.fullRange?.polyphony || 16);

    for (const track of (midiData.tracks || [])) {
      const dupes = [];
      const evtsToRemove = [];
      let tick = 0;
      for (let ei = 0; ei < track.events.length; ei++) {
        const evt = track.events[ei];
        if (evt.deltaTime !== undefined) tick += evt.deltaTime;
        evt._absTick = tick;

        if ((evt.type === 'noteOn' || evt.type === 'noteOff') && (evt.channel ?? 0) === sourceChannel) {
          const note = evt.note ?? evt.noteNumber ?? 60;
          const isNoteOn = evt.type === 'noteOn' && (evt.velocity ?? 0) > 0;
          const matches = [];
          for (let si = 0; si < segments.length; si++) {
            const rMin = segments[si].noteRange?.min ?? 0;
            const rMax = segments[si].noteRange?.max ?? 127;
            if (note >= rMin && note <= rMax && si < segChannels.length) matches.push(si);
          }
          if (matches.length > 0) {
            if (matches.length === 1 || overlapStrategy === 'shared') {
              evt.channel = segChannels[matches[0]];
              if (overlapStrategy === 'shared' && matches.length > 1) {
                for (let mi = 1; mi < matches.length; mi++) {
                  dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                }
              }
            } else if (overlapStrategy === 'alternate') {
              if (isNoteOn) {
                const target = matches[alternateCounter % matches.length];
                evt.channel = segChannels[target];
                alternateCounter++;
              } else {
                evt.channel = segChannels[matches[0]];
                for (let mi = 1; mi < matches.length; mi++) {
                  dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                }
              }
            } else if (overlapStrategy === 'overflow') {
              if (isNoteOn) {
                let assigned = false;
                for (const si of matches) {
                  const sCh = segChannels[si];
                  if ((activeNotes.get(sCh) || 0) < segPolyphony[si]) {
                    evt.channel = sCh;
                    activeNotes.set(sCh, (activeNotes.get(sCh) || 0) + 1);
                    assigned = true;
                    break;
                  }
                }
                if (!assigned) evt.channel = segChannels[matches[0]];
              } else {
                evt.channel = segChannels[matches[0]];
                for (const si of matches) {
                  const sCh = segChannels[si];
                  if ((activeNotes.get(sCh) || 0) > 0) activeNotes.set(sCh, activeNotes.get(sCh) - 1);
                }
                for (let mi = 1; mi < matches.length; mi++) {
                  dupes.push({ ...evt, channel: segChannels[matches[mi]], _absTick: tick });
                }
              }
            } else {
              evt.channel = segChannels[matches[0]];
            }
          }
        } else if ((evt.type === 'controlChange' || evt.type === 'cc') && (evt.channel ?? 0) === sourceChannel) {
          const cc = evt.controllerNumber ?? evt.controller ?? evt.cc;
          if (chRemap[cc] === -1) { evtsToRemove.push(ei); continue; }
          const mutedSegs = chSegMute[cc];
          if (mutedSegs?.has(0)) {
            evtsToRemove.push(ei);
          } else {
            evt.channel = segChannels[0];
          }
          for (let si = 1; si < segChannels.length; si++) {
            if (mutedSegs?.has(si)) continue;
            dupes.push({ ...evt, channel: segChannels[si], _absTick: tick });
          }
        }
      }
      for (let ri = evtsToRemove.length - 1; ri >= 0; ri--) {
        track.events.splice(evtsToRemove[ri], 1);
      }
      if (dupes.length > 0) {
        const allEvts = [...track.events, ...dupes];
        allEvts.sort((a, b) => a._absTick - b._absTick);
        let prev = 0;
        for (const e of allEvts) { e.deltaTime = e._absTick - prev; prev = e._absTick; }
        track.events = allEvts;
      }
      for (const evt of track.events) delete evt._absTick;
    }
  }

  /**
   * Allocate `count` free MIDI channels (0..15) excluding channel 9 (drums),
   * any channel in `excluded`, and any channel currently used by `usedChannels`.
   */
  function allocateFreeChannels({ count, usedChannels, excluded = new Set() }) {
    const free = [];
    for (let c = 0; c < 16; c++) {
      if (c === 9) continue;
      if (excluded.has(c)) continue;
      if (usedChannels.has(c)) continue;
      free.push(c);
      if (free.length >= count) break;
    }
    return free;
  }

  /**
   * Collect the set of channel numbers used by any noteOn event in `midiData`.
   */
  function collectUsedChannels(midiData) {
    const used = new Set();
    for (const track of (midiData?.tracks || [])) {
      for (const evt of (track.events || [])) {
        if (evt.type === 'noteOn' && evt.channel != null) used.add(evt.channel);
      }
    }
    return used;
  }

  window.RoutingSummaryPreview = Object.freeze({
    redistributeSplitChannel,
    allocateFreeChannels,
    collectUsedChannels
  });
})();
