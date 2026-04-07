// src/midi/MidiTransposer.js

// MIDI note constants
const MIDI_NOTE_MIN = 0;
const MIDI_NOTE_MAX = 127;
/**
 * MidiTransposer - Applique des transpositions à des fichiers MIDI
 *
 * Permet de :
 * - Transposer des canaux par octaves (multiples de 12 semitones)
 * - Remapper des notes (pour drums/pads discrets)
 * - Créer des fichiers dérivés avec métadonnées de transformation
 */
class MidiTransposer {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Applique des transpositions à plusieurs canaux (single-pass pipeline).
   * Handles transposition, note remapping, out-of-range suppression,
   * CC remapping, and polyphony reduction in one pass per track.
   * @param {Object} midiData - Fichier MIDI parsé
   * @param {Object} transpositions - { channel: { semitones, noteRemapping, suppressOutOfRange, noteRangeMin, noteRangeMax, ccMapping, maxPolyphony } }
   * @returns {Object} - { midiData, stats }
   */
  transposeChannels(midiData, transpositions) {
    // Shallow clone + deep clone des tracks seulement (plus performant)
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
        let newEvent = event; // Par défaut, garder la référence

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

          // Step 4: Polyphony reduction (after note transforms, before commit)
          if (transposition.maxPolyphony && transposition.maxPolyphony > 0) {
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
          // Step 5: CC remapping (inline, same pass)
          if (transposition.ccMapping) {
            const cc = event.controllerNumber ?? event.controller ?? event.cc;
            const targetCC = transposition.ccMapping[cc];
            if (targetCC !== undefined) {
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

        // Remplacer l'événement si modifié
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

    return {
      midiData: modifiedData,
      stats: {
        notesChanged,
        notesRemapped,
        notesSuppressed,
        notesDropped,
        ccsRemapped,
        totalNotes,
        transpositions
      }
    };
  }

  /**
   * Applique une transposition à un seul canal
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
   * Applique un remapping de notes (pour drums)
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
   * Clamp une note à la plage MIDI valide (0-127)
   * @param {number} note
   * @returns {number}
   */
  clampNote(note) {
    return Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, Math.round(note)));
  }

  /**
   * Compte le nombre total de notes dans un fichier MIDI
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
   * Génère les métadonnées d'adaptation pour un fichier dérivé
   * @param {Object} assignments - Assignations appliquées
   * @param {Object} stats - Statistiques de transposition
   * @returns {Object}
   */
  generateAdaptationMetadata(assignments, stats) {
    const transpositions = {};

    for (const [channel, assignment] of Object.entries(assignments)) {
      const channelNum = parseInt(channel);
      const transposition = assignment.transposition || { semitones: 0, octaves: 0 };
      const noteRemapping = assignment.noteRemapping || null;

      transpositions[channelNum] = {
        semitones: transposition.semitones || 0,
        octaves: transposition.octaves || 0,
        noteRemapping,
        reason: assignment.info ? (Array.isArray(assignment.info) ? assignment.info.join('; ') : String(assignment.info)) : 'Auto-assigned'
      };
    }

    return {
      created_at: new Date().toISOString(),
      strategy: 'octave_preserving',
      transpositions,
      notes_changed: stats.notesChanged || 0,
      notes_remapped: stats.notesRemapped || 0,
      notes_suppressed: stats.notesSuppressed || 0,
      total_notes: stats.totalNotes || 0
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
      // Track noteOn→segment mapping to route matching noteOff to the same segment
      const activeNotes = new Map(); // note → segmentIndex

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
          if (segIdx >= 0) {
            activeNotes.set(note, segIdx);
            newEvents.push({ ...event, channel: segments[segIdx].targetChannel });
            segmentCounts[segIdx]++;
            if (segments[segIdx].targetChannel !== sourceChannel) notesMoved++;
          } else {
            // Note outside all segments — route to nearest segment
            let closest = 0, minDist = Infinity;
            for (let s = 0; s < segments.length; s++) {
              const dist = Math.min(Math.abs(note - segments[s].noteMin), Math.abs(note - segments[s].noteMax));
              if (dist < minDist) { minDist = dist; closest = s; }
            }
            activeNotes.set(note, closest);
            newEvents.push({ ...event, channel: segments[closest].targetChannel });
            segmentCounts[closest]++;
            if (segments[closest].targetChannel !== sourceChannel) notesMoved++;
          }
        } else if (isNoteOff && note !== undefined) {
          // Route noteOff to the same segment as its matching noteOn
          const segIdx = activeNotes.get(note) ?? 0;
          activeNotes.delete(note);
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
}

export default MidiTransposer;
