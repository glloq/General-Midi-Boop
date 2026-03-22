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
   * Applique des transpositions à plusieurs canaux
   * @param {Object} midiData - Fichier MIDI parsé
   * @param {Object} transpositions - { channel: { semitones, noteRemapping, suppressOutOfRange, noteRangeMin, noteRangeMax } }
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
    const totalNotes = this.countAllNotes(midiData);

    for (const track of modifiedData.tracks) {
      if (!track.events) continue;

      const eventsToRemove = [];

      for (let i = 0; i < track.events.length; i++) {
        const event = track.events[i];
        const channel = event.channel;
        const transposition = transpositions[channel];

        if (!transposition) continue;

        let eventModified = false;
        let newEvent = event; // Par défaut, garder la référence

        // Process note events (noteOn, noteOff)
        if (event.type === 'noteOn' || event.type === 'noteOff') {
          const originalNote = event.note || event.noteNumber;
          let currentNote = originalNote;

          // Step 1: Apply transposition by semitones
          if (transposition.semitones && transposition.semitones !== 0) {
            currentNote = this.clampNote(currentNote + transposition.semitones);
            if (currentNote !== originalNote) {
              if (!eventModified) {
                newEvent = { ...event }; // Clone seulement si modification
                eventModified = true;
              }
              notesChanged++;
            }
          }

          // Step 2: Apply note remapping (on transposed note)
          // This includes both discrete note mapping (drums) and octave wrapping
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

          // Update note in event if eventModified
          if (eventModified) {
            newEvent.note = currentNote;
            if (newEvent.noteNumber !== undefined) {
              newEvent.noteNumber = currentNote;
            }
          }
        } else if (event.type === 'keyPressure' || event.type === 'polyAftertouch') {
          // Aftertouch polyphonique - apply same logic
          const originalNote = event.note || event.noteNumber;
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
        }

        // Remplacer l'événement si modifié
        if (eventModified) {
          track.events[i] = newEvent;
        }
      }

      // Remove suppressed events (in reverse order to preserve indices)
      if (eventsToRemove.length > 0) {
        for (let j = eventsToRemove.length - 1; j >= 0; j--) {
          track.events.splice(eventsToRemove[j], 1);
        }
      }
    }

    return {
      midiData: modifiedData,
      stats: {
        notesChanged,
        notesRemapped,
        notesSuppressed,
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

}

export default MidiTransposer;
