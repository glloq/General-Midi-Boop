/**
 * @file src/midi/MidiTransposer.js
 * @description Applies transformations to a parsed MIDI file:
 *   - Channel transposition by N semitones (typically multiples of 12).
 *   - Per-note remapping (used by drum maps and discrete-pad targets).
 *   - Free-channel discovery so a split can be materialised without
 *     stomping on existing channels.
 *
 * Operates on a deep-cloned copy of the input — original `midiData`
 * objects are never mutated, which keeps the file editor safe.
 *
 * The file is large (~760 LOC); only public entry points carry full
 * JSDoc.
 */

/** Lower MIDI note bound. */
const MIDI_NOTE_MIN = 0;
/** Upper MIDI note bound. */
const MIDI_NOTE_MAX = 127;

class MidiTransposer {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Apply transpositions to multiple channels (single-pass pipeline).
   * Handles transposition, note remapping, out-of-range suppression,
   * CC remapping, and polyphony reduction in one pass per track.
   * @param {Object} midiData - Parsed MIDI file
   * @param {Object} transpositions - { channel: { semitones, noteRemapping, suppressOutOfRange, noteRangeMin, noteRangeMax, ccMapping, maxPolyphony, polyStrategy } }
   *   polyStrategy: 'drop' (default, remove inner voices) or 'shorten' (shorten NoteOff to reduce overlap)
   * @returns {Object} - { midiData, stats }
   */
  transposeChannels(midiData, transpositions) {
    // Shallow clone + deep clone tracks only (more performant)
    const modifiedData = {
      ...midiData,
      tracks: midiData.tracks.map(track => ({
        ...track,
        events: track.events ? [...track.events] : []
      }))
    };

    let notesChanged = 0;
    let notesRemapped = 0;
    let notesSuppressed = 0;
    let notesDropped = 0;
    let ccsRemapped = 0;
    const totalNotes = this.countAllNotes(midiData);

    for (const track of modifiedData.tracks) {
      if (!track.events) continue;

      const eventsToRemove = [];
      // Per-channel polyphony tracking: channel -> Map(note -> eventIndex)
      const activeNotesPerChannel = new Map();
      // Track dropped noteOn notes to also remove their matching noteOff
      const droppedNotesPerChannel = new Map();

      for (let i = 0; i < track.events.length; i++) {
        const event = track.events[i];
        const channel = event.channel;
        const transposition = transpositions[channel];

        if (!transposition) continue;

        let eventModified = false;
        let newEvent = event; // By default, keep the reference

        // Process note events (noteOn, noteOff)
        if (event.type === 'noteOn' || event.type === 'noteOff') {
          const originalNote = event.note ?? event.noteNumber;
          let currentNote = originalNote;

          // Step 1: Apply transposition by semitones
          if (transposition.semitones && transposition.semitones !== 0) {
            currentNote = this.clampNote(currentNote + transposition.semitones);
            if (currentNote !== originalNote) {
              if (!eventModified) {
                newEvent = { ...event };
                eventModified = true;
              }
              notesChanged++;
            }
          }

          // Step 2: Apply note remapping (on transposed note)
          if (transposition.noteRemapping && Object.keys(transposition.noteRemapping).length > 0) {
            const remappedNote = transposition.noteRemapping[currentNote];
            if (remappedNote !== undefined) {
              if (!eventModified) {
                newEvent = { ...event };
                eventModified = true;
              }
              currentNote = remappedNote;
              notesRemapped++;

              // Apply optional velocity scaling for remapped notes (e.g., drum substitutions)
              if (transposition.velocityScale && transposition.velocityScale[remappedNote] !== undefined) {
                const scale = transposition.velocityScale[remappedNote];
                const velocity = newEvent.velocity ?? event.velocity;
                if (velocity !== undefined && velocity > 0) {
                  newEvent.velocity = Math.max(1, Math.min(127, Math.round(velocity * scale)));
                }
              }
            }
          }

          // Step 3: Suppress out-of-range notes if requested
          if (transposition.suppressOutOfRange && transposition.noteRangeMin != null && transposition.noteRangeMax != null) {
            if (currentNote < transposition.noteRangeMin || currentNote > transposition.noteRangeMax) {
              eventsToRemove.push(i);
              if (event.type === 'noteOn') {
                notesSuppressed++;
              }
              continue;
            }
          }

          // Update note in event if modified
          if (eventModified) {
            newEvent.note = currentNote;
            if (newEvent.noteNumber !== undefined) {
              newEvent.noteNumber = currentNote;
            }
          }

          // Step 4: Polyphony reduction — drop strategy only (shorten is post-processed)
          if (transposition.maxPolyphony && transposition.maxPolyphony > 0 && transposition.polyStrategy !== 'shorten') {
            const finalNote = eventModified ? currentNote : (event.note ?? event.noteNumber);
            const isNoteOn = event.type === 'noteOn' && (event.velocity ?? (eventModified ? newEvent.velocity : event.velocity)) > 0;
            const isNoteOff = event.type === 'noteOff' || (event.type === 'noteOn' && (event.velocity ?? 0) === 0);

            if (!activeNotesPerChannel.has(channel)) {
              activeNotesPerChannel.set(channel, new Map());
              droppedNotesPerChannel.set(channel, new Set());
            }
            const activeNotes = activeNotesPerChannel.get(channel);
            const droppedNotes = droppedNotesPerChannel.get(channel);

            if (isNoteOn) {
              activeNotes.set(finalNote, i);

              if (activeNotes.size > transposition.maxPolyphony) {
                // Sort by note number, drop inner voices (keep lowest + highest)
                const noteEntries = [...activeNotes.entries()].sort((a, b) => a[0] - b[0]);
                while (noteEntries.length > transposition.maxPolyphony) {
                  const midIdx = Math.floor(noteEntries.length / 2);
                  const [droppedNote, droppedIdx] = noteEntries[midIdx];
                  eventsToRemove.push(droppedIdx);
                  activeNotes.delete(droppedNote);
                  droppedNotes.add(droppedNote);
                  noteEntries.splice(midIdx, 1);
                  notesDropped++;
                }
              }
            } else if (isNoteOff) {
              if (droppedNotes.has(finalNote)) {
                // Matching noteOff for a dropped noteOn — remove it too
                eventsToRemove.push(i);
                droppedNotes.delete(finalNote);
                continue;
              } else {
                activeNotes.delete(finalNote);
              }
            }
          }
        } else if (event.type === 'keyPressure' || event.type === 'polyAftertouch') {
          // Aftertouch polyphonique - apply same logic
          const originalNote = event.note ?? event.noteNumber;
          let currentNote = originalNote;

          if (transposition.semitones && transposition.semitones !== 0) {
            currentNote = this.clampNote(currentNote + transposition.semitones);
            if (!eventModified) {
              newEvent = { ...event };
              eventModified = true;
            }
          }

          if (transposition.noteRemapping && Object.keys(transposition.noteRemapping).length > 0) {
            const remappedNote = transposition.noteRemapping[currentNote];
            if (remappedNote !== undefined) {
              if (!eventModified) {
                newEvent = { ...event };
                eventModified = true;
              }
              currentNote = remappedNote;
            }
          }

          // Suppress out-of-range aftertouch
          if (transposition.suppressOutOfRange && transposition.noteRangeMin != null && transposition.noteRangeMax != null) {
            if (currentNote < transposition.noteRangeMin || currentNote > transposition.noteRangeMax) {
              eventsToRemove.push(i);
              continue;
            }
          }

          if (eventModified) {
            newEvent.note = currentNote;
            if (newEvent.noteNumber !== undefined) {
              newEvent.noteNumber = currentNote;
            }
          }
        } else if (event.type === 'controlChange' || event.type === 'cc') {
          // Step 5: CC remapping / suppression (inline, same pass)
          if (transposition.ccMapping) {
            const cc = event.controllerNumber ?? event.controller ?? event.cc;
            const targetCC = transposition.ccMapping[cc];
            if (targetCC !== undefined) {
              if (targetCC === -1) {
                // Suppress this CC event entirely
                eventsToRemove.push(i);
                continue;
              }
              if (!eventModified) {
                newEvent = { ...event };
                eventModified = true;
              }
              if (newEvent.controllerNumber !== undefined) newEvent.controllerNumber = targetCC;
              if (newEvent.controller !== undefined) newEvent.controller = targetCC;
              if (newEvent.cc !== undefined) newEvent.cc = targetCC;
              ccsRemapped++;
            }
          }
        }

        // Replace the event if modified
        if (eventModified) {
          track.events[i] = newEvent;
        }
      }

      // Remove suppressed/dropped events (in reverse order to preserve indices)
      if (eventsToRemove.length > 0) {
        // Deduplicate and sort descending
        const uniqueRemove = [...new Set(eventsToRemove)].sort((a, b) => b - a);
        for (const idx of uniqueRemove) {
          track.events.splice(idx, 1);
        }
      }
    }

    // Post-processing: apply gentle polyphony reduction (shorten strategy)
    let notesShortened = 0;
    let finalMidiData = modifiedData;
    for (const [channelStr, transposition] of Object.entries(transpositions)) {
      if (transposition.polyStrategy === 'shorten' && transposition.maxPolyphony && transposition.maxPolyphony > 0) {
        const ch = parseInt(channelStr);
        const result = this.reducePolyphonyGentle(finalMidiData, ch, transposition.maxPolyphony);
        finalMidiData = result.midiData;
        notesShortened += result.stats.notesShortened;
      }
    }

    return {
      midiData: finalMidiData,
      stats: {
        notesChanged,
        notesRemapped,
        notesSuppressed,
        notesDropped,
        notesShortened,
        ccsRemapped,
        totalNotes,
        transpositions
      }
    };
  }

  /**
   * Apply a transposition to a single channel
   * @param {Object} midiData
   * @param {number} channel
   * @param {number} semitones
   * @returns {Object}
   */
  transposeChannel(midiData, channel, semitones) {
    return this.transposeChannels(midiData, {
      [channel]: { semitones }
    });
  }

  /**
   * Apply a note remapping (for drums)
   * @param {Object} midiData
   * @param {number} channel
   * @param {Object} mapping - { oldNote: newNote }
   * @returns {Object}
   */
  remapNotes(midiData, channel, mapping) {
    return this.transposeChannels(midiData, {
      [channel]: { noteRemapping: mapping }
    });
  }

  /**
   * Clamp a note to the valid MIDI range (0-127)
   * @param {number} note
   * @returns {number}
   */
  clampNote(note) {
    return Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, Math.round(note)));
  }

  /**
   * Count the total number of notes in a MIDI file
   * @param {Object} midiData
   * @returns {number}
   */
  countAllNotes(midiData) {
    let count = 0;

    if (!midiData || !midiData.tracks) {
      return count;
    }

    for (const track of midiData.tracks) {
      if (!track.events) continue;

      for (const event of track.events) {
        if (event.type === 'noteOn' && event.velocity > 0) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Compress notes into instrument range using octave folding.
   * Notes below range are folded up, notes above are folded down.
   * @param {number} note - MIDI note number
   * @param {number} min - Instrument range min
   * @param {number} max - Instrument range max
   * @returns {number}
   */
  compressNoteToRange(note, min, max) {
    if (note >= min && note <= max) return note;
    const range = max - min;
    if (range <= 0) return min;

    if (note < min) {
      const diff = min - note;
      return min + (diff % range);
    } else {
      const diff = note - max;
      return max - (diff % range);
    }
  }

  /**
   * Apply note compression to a channel - folds out-of-range notes into range
   * @param {Object} midiData - Parsed MIDI file
   * @param {number} channel - Channel number
   * @param {number} rangeMin - Instrument note range min
   * @param {number} rangeMax - Instrument note range max
   * @returns {Object} - { midiData, stats }
   */
  compressChannel(midiData, channel, rangeMin, rangeMax) {
    const remapping = {};
    // Build remapping for all 128 MIDI notes
    for (let n = 0; n <= 127; n++) {
      if (n < rangeMin || n > rangeMax) {
        remapping[n] = this.compressNoteToRange(n, rangeMin, rangeMax);
      }
    }
    return this.transposeChannels(midiData, {
      [channel]: { noteRemapping: remapping }
    });
  }

  /**
   * Reduce polyphony on a channel by removing excess simultaneous notes.
   * Keeps bass (lowest) and melody (highest) notes, removes inner voices.
   * Delegates to transposeChannels single-pass pipeline.
   * @param {Object} midiData - Parsed MIDI file
   * @param {number} channel - Channel number
   * @param {number} maxPolyphony - Maximum allowed simultaneous notes
   * @returns {Object} - { midiData, stats }
   */
  reducePolyphony(midiData, channel, maxPolyphony) {
    const result = this.transposeChannels(midiData, {
      [channel]: { maxPolyphony }
    });
    return {
      midiData: result.midiData,
      stats: { notesDropped: result.stats.notesDropped, totalNotes: result.stats.totalNotes }
    };
  }

  /**
   * Reduce polyphony by shortening overlapping notes (gentle strategy).
   * Instead of dropping notes entirely, moves NoteOff earlier to reduce overlap.
   * Preserves all notes — only their duration is affected.
   *
   * Algorithm:
   * 1. Build note intervals (noteOn → noteOff pairs) with absolute ticks
   * 2. At each NoteOn that causes polyphony > maxPolyphony, find the active note
   *    ending soonest and shorten it to end just before this NoteOn
   * 3. Rewrite deltaTime values to reflect the moved NoteOff events
   *
   * @param {Object} midiData - Parsed MIDI file
   * @param {number} channel - Channel number (0-15)
   * @param {number} maxPolyphony - Maximum allowed simultaneous notes
   * @returns {Object} - { midiData, stats: { notesShortened } }
   */
  reducePolyphonyGentle(midiData, channel, maxPolyphony) {
    if (!maxPolyphony || maxPolyphony <= 0) {
      return { midiData, stats: { notesShortened: 0 } };
    }

    const modifiedData = {
      ...midiData,
      tracks: midiData.tracks.map(track => ({
        ...track,
        events: track.events ? track.events.map(e => ({ ...e })) : []
      }))
    };

    let notesShortened = 0;

    for (const track of modifiedData.tracks) {
      if (!track.events || track.events.length === 0) continue;

      // Step 1: Compute absolute ticks and find noteOn/noteOff pairs for this channel
      const absTicks = [];
      let tick = 0;
      for (let i = 0; i < track.events.length; i++) {
        tick += (track.events[i].deltaTime || 0);
        absTicks.push(tick);
      }

      // Build note intervals: { noteOnIdx, noteOffIdx, note, startTick, endTick }
      // Track active noteOns waiting for their noteOff
      const pendingNotes = new Map(); // note -> [{ noteOnIdx, startTick }]
      const intervals = [];

      for (let i = 0; i < track.events.length; i++) {
        const event = track.events[i];
        if (event.channel !== channel) continue;

        const note = event.note ?? event.noteNumber;
        if (note === undefined) continue;

        const isNoteOn = event.type === 'noteOn' && (event.velocity ?? 0) > 0;
        const isNoteOff = event.type === 'noteOff' || (event.type === 'noteOn' && (event.velocity ?? 0) === 0);

        if (isNoteOn) {
          if (!pendingNotes.has(note)) pendingNotes.set(note, []);
          pendingNotes.get(note).push({ noteOnIdx: i, startTick: absTicks[i] });
        } else if (isNoteOff) {
          const pending = pendingNotes.get(note);
          if (pending && pending.length > 0) {
            const match = pending.shift();
            if (pending.length === 0) pendingNotes.delete(note);
            intervals.push({
              noteOnIdx: match.noteOnIdx,
              noteOffIdx: i,
              note,
              startTick: match.startTick,
              endTick: absTicks[i]
            });
          }
        }
      }

      if (intervals.length === 0) continue;

      // Step 2: Walk through NoteOn events in tick order and shorten overlapping notes
      // Sort intervals by startTick for processing
      intervals.sort((a, b) => a.startTick - b.startTick);

      // Track which intervals are active at any point, using a set of interval indices
      // We'll process each interval's start and check polyphony
      const activeIntervals = []; // { intervalIdx, endTick, note }

      for (let ii = 0; ii < intervals.length; ii++) {
        const interval = intervals[ii];

        // Remove expired intervals (endTick <= current startTick)
        for (let a = activeIntervals.length - 1; a >= 0; a--) {
          if (activeIntervals[a].endTick <= interval.startTick) {
            activeIntervals.splice(a, 1);
          }
        }

        // Add current interval
        activeIntervals.push({ intervalIdx: ii, endTick: interval.endTick, note: interval.note });

        // While polyphony exceeds limit, shorten the note ending soonest
        while (activeIntervals.length > maxPolyphony) {
          // Find the active note that ends soonest (shortest remaining time)
          let shortest = 0;
          for (let a = 1; a < activeIntervals.length; a++) {
            if (activeIntervals[a].endTick < activeIntervals[shortest].endTick) {
              shortest = a;
            }
          }

          const toShorten = activeIntervals[shortest];
          const targetInterval = intervals[toShorten.intervalIdx];

          // Move its NoteOff to just before the current NoteOn (1 tick gap)
          const newEndTick = Math.max(targetInterval.startTick + 1, interval.startTick - 1);
          if (newEndTick < targetInterval.endTick) {
            targetInterval.endTick = newEndTick;
            toShorten.endTick = newEndTick;
            notesShortened++;
          }

          // Remove from active (it now ends before current note starts)
          activeIntervals.splice(shortest, 1);
        }
      }

      if (notesShortened === 0) continue;

      // Step 3: Rebuild absolute ticks for modified noteOff positions
      // Create a map of noteOffIdx -> newAbsTick
      const noteOffMoves = new Map();
      for (const interval of intervals) {
        const originalEndTick = absTicks[interval.noteOffIdx];
        if (interval.endTick !== originalEndTick) {
          noteOffMoves.set(interval.noteOffIdx, interval.endTick);
        }
      }

      if (noteOffMoves.size === 0) continue;

      // Rebuild deltaTime values from modified absolute ticks
      // First, build the new absolute tick array
      const newAbsTicks = [...absTicks];
      for (const [idx, newTick] of noteOffMoves) {
        newAbsTicks[idx] = newTick;
      }

      // We need to re-sort events by absolute tick and recompute deltaTime.
      // Build index array sorted by new absolute tick (stable sort preserves order for same tick).
      const indices = track.events.map((_, i) => i);
      indices.sort((a, b) => newAbsTicks[a] - newAbsTicks[b] || a - b);

      const reorderedEvents = indices.map(i => track.events[i]);
      const reorderedAbsTicks = indices.map(i => newAbsTicks[i]);

      // Recompute deltaTime
      for (let i = 0; i < reorderedEvents.length; i++) {
        const prevTick = i > 0 ? reorderedAbsTicks[i - 1] : 0;
        reorderedEvents[i].deltaTime = Math.max(0, reorderedAbsTicks[i] - prevTick);
      }

      track.events = reorderedEvents;
    }

    return {
      midiData: modifiedData,
      stats: { notesShortened }
    };
  }

  /**
   * Remap CC controllers on a channel.
   * Delegates to transposeChannels single-pass pipeline.
   * @param {Object} midiData - Parsed MIDI file
   * @param {number} channel - Channel number
   * @param {Object} ccMapping - { sourceCC: targetCC }
   * @returns {Object} - { midiData, stats }
   */
  remapCCs(midiData, channel, ccMapping) {
    const result = this.transposeChannels(midiData, {
      [channel]: { ccMapping }
    });
    return {
      midiData: result.midiData,
      stats: { ccsRemapped: result.stats.ccsRemapped }
    };
  }

  /**
   * Physically split a MIDI channel into N separate channels in the file.
   * Each segment gets a copy of the source channel's events, filtered to its note range.
   * Control events (CC, pitch bend, program change) are broadcast to all target channels.
   * The source channel's first segment keeps the original channel number.
   *
   * @param {Object} midiData - Parsed MIDI data with tracks/events
   * @param {number} sourceChannel - Source MIDI channel (0-15) to split
   * @param {Array} segments - [{ targetChannel: number, noteMin: number, noteMax: number, gmProgram?: number }]
   *   targetChannel: MIDI channel (0-15) for this segment's output
   *   noteMin/noteMax: note range this segment handles (inclusive)
   * @returns {{ midiData: Object, stats: { notesMoved: number, controlsDuplicated: number, segmentCounts: number[] } }}
   */
  splitChannelInFile(midiData, sourceChannel, segments) {
    if (!segments || segments.length < 2) {
      return { midiData, stats: { notesMoved: 0, controlsDuplicated: 0, segmentCounts: [] } };
    }

    const modifiedData = {
      ...midiData,
      tracks: midiData.tracks.map(track => ({
        ...track,
        events: track.events ? [...track.events] : []
      }))
    };

    let notesMoved = 0;
    let controlsDuplicated = 0;
    const segmentCounts = new Array(segments.length).fill(0);

    for (const track of modifiedData.tracks) {
      if (!track.events) continue;

      // Check if this track has events on the source channel
      const hasSourceChannel = track.events.some(e => e.channel === sourceChannel);
      if (!hasSourceChannel) continue;

      const newEvents = [];
      // Track noteOn→segment mapping to route matching noteOff to the same segment.
      // Uses a stack (array) per note to handle overlapping NoteOn events on the same pitch.
      const activeNotes = new Map(); // note → segmentIndex[]

      for (let i = 0; i < track.events.length; i++) {
        const event = track.events[i];

        // Keep all events not on the source channel as-is
        if (event.channel !== sourceChannel) {
          newEvents.push(event);
          continue;
        }

        // Meta events (no channel) — keep as-is
        if (event.channel === undefined) {
          newEvents.push(event);
          continue;
        }

        const isNoteOn = event.type === 'noteOn' && (event.velocity > 0);
        const isNoteOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0);
        const note = event.note ?? event.noteNumber;

        if (isNoteOn && note !== undefined) {
          // Find which segment handles this note
          const segIdx = segments.findIndex(s => note >= s.noteMin && note <= s.noteMax);
          let resolvedIdx;
          if (segIdx >= 0) {
            resolvedIdx = segIdx;
          } else {
            // Note outside all segments — route to nearest segment
            let closest = 0, minDist = Infinity;
            for (let s = 0; s < segments.length; s++) {
              const dist = Math.min(Math.abs(note - segments[s].noteMin), Math.abs(note - segments[s].noteMax));
              if (dist < minDist) { minDist = dist; closest = s; }
            }
            resolvedIdx = closest;
          }
          // Push onto stack for this note (handles overlapping NoteOn)
          const stack = activeNotes.get(note);
          if (stack) { stack.push(resolvedIdx); } else { activeNotes.set(note, [resolvedIdx]); }
          newEvents.push({ ...event, channel: segments[resolvedIdx].targetChannel });
          segmentCounts[resolvedIdx]++;
          if (segments[resolvedIdx].targetChannel !== sourceChannel) notesMoved++;
        } else if (isNoteOff && note !== undefined) {
          // Route noteOff to the same segment as its matching noteOn (LIFO)
          const stack = activeNotes.get(note);
          const segIdx = (stack && stack.length > 0) ? stack.pop() : 0;
          if (stack && stack.length === 0) activeNotes.delete(note);
          newEvents.push({ ...event, channel: segments[segIdx].targetChannel });
        } else {
          // Control events (CC, pitch bend, program change, aftertouch, etc.)
          // Broadcast to all target channels
          const uniqueChannels = [...new Set(segments.map(s => s.targetChannel))];
          for (let c = 0; c < uniqueChannels.length; c++) {
            if (c === 0) {
              // First copy: modify in place
              newEvents.push({ ...event, channel: uniqueChannels[0] });
            } else {
              // Additional copies: insert with deltaTime 0
              newEvents.push({ ...event, channel: uniqueChannels[c], deltaTime: 0 });
              controlsDuplicated++;
            }
          }
        }
      }

      track.events = newEvents;
    }

    // Insert program change events at the start for segments that need a specific GM program
    for (const seg of segments) {
      if (seg.gmProgram != null && seg.targetChannel !== sourceChannel) {
        // Find the first track with events and prepend a program change
        const firstTrack = modifiedData.tracks.find(t => t.events?.length > 0);
        if (firstTrack) {
          firstTrack.events.unshift({
            deltaTime: 0,
            type: 'programChange',
            channel: seg.targetChannel,
            programNumber: seg.gmProgram
          });
        }
      }
    }

    this.logger?.info?.(
      `[SplitChannel] Ch ${sourceChannel} → ${segments.length} segments: ` +
      `${notesMoved} notes moved, ${controlsDuplicated} controls duplicated, ` +
      `counts: [${segmentCounts.join(', ')}]`
    );

    return {
      midiData: modifiedData,
      stats: { notesMoved, controlsDuplicated, segmentCounts }
    };
  }

  /**
   * Find free MIDI channels in a parsed MIDI file.
   * Returns channels not used by any noteOn/noteOff event.
   * Channel 9 (drums) is excluded unless explicitly requested.
   *
   * @param {Object} midiData - Parsed MIDI data
   * @param {boolean} includeDrumChannel - Whether to include channel 9 (default false)
   * @returns {number[]} - Array of free channel numbers (0-15)
   */
  findFreeChannels(midiData, includeDrumChannel = false) {
    const usedChannels = new Set();
    for (const track of (midiData.tracks || [])) {
      for (const event of (track.events || [])) {
        if ((event.type === 'noteOn' || event.type === 'noteOff') && event.channel !== undefined) {
          usedChannels.add(event.channel);
        }
      }
    }
    const free = [];
    for (let ch = 0; ch < 16; ch++) {
      if (ch === 9 && !includeDrumChannel) continue;
      if (!usedChannels.has(ch)) free.push(ch);
    }
    return free;
  }

  /**
   * Invert a note remapping (forward mapping -> reverse mapping).
   * Used to convert recorded MIDI notes back to GM standard after drum remapping.
   * For many-to-one mappings (multiple source notes mapped to same target),
   * the reverse mapping picks the source note with the highest priority (lowest GM note).
   * @param {Object} mapping - Forward mapping { sourceNote: targetNote }
   * @returns {Object} Inverse mapping { targetNote: sourceNote }
   */
  static invertMapping(mapping) {
    if (!mapping || typeof mapping !== 'object') return {};
    const inverse = {};
    for (const [source, target] of Object.entries(mapping)) {
      const sourceNum = parseInt(source);
      const targetNum = parseInt(target);
      if (isNaN(sourceNum) || isNaN(targetNum)) continue;
      // For many-to-one: keep the lowest source note (most "standard" in GM)
      if (inverse[targetNum] === undefined || sourceNum < inverse[targetNum]) {
        inverse[targetNum] = sourceNum;
      }
    }
    return inverse;
  }
}

export default MidiTransposer;
