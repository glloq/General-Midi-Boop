/**
 * VoiceSelector — per-note GM voice selection for multi-voice instruments.
 *
 * Phase 8 of the instrument-family refactor. An instrument channel can carry
 * SECONDARY GM voices (`instrument_voices`) that are ALTERNATIVE techniques on
 * the SAME physical instrument — e.g. a bass playing fingerstyle vs slap vs
 * tapping, or a string instrument playing arco vs pizzicato. The primary voice
 * lives on `instruments_latency.gm_program`; secondary voices live in
 * `instrument_voices`. At playback the engine must pick ONE voice per note
 * "based on context" (see `migrations/003_instrument_voices.sql`).
 *
 * The context signal was deliberately left open by the schema (octave /
 * velocity / articulation CC / MIDI annotation are all candidates). This module
 * implements the FIRST, data-driven policy:
 *
 *   **By declared per-voice note capability.** Migration 005 lets each secondary
 *   voice declare its own playable-note set (range or discrete list), gated by
 *   `instruments_latency.voices_share_notes` (default 1 = every voice shares the
 *   primary's notes). When the flag is CLEARED, a secondary voice whose declared
 *   notes CONTAIN the note "claims" it; the most specific claimant wins; notes
 *   claimed by no secondary voice fall back to the PRIMARY voice.
 *
 * The policy is a strict NO-OP (always returns the primary program) when:
 *   - `voices_share_notes` is set (the default) — nothing to discriminate on; or
 *   - no secondary voice declares its own note capability.
 * So an instrument WITHOUT an explicit per-voice note configuration behaves
 * exactly as before (single primary GM program) — zero regression.
 *
 * This module is pure (no I/O). The caller loads the voices
 * (`InstrumentRepository.listVoices`) and the `voices_share_notes` flag, then
 * uses {@link selectVoiceProgram} per note or {@link planVoiceProgramChanges}
 * over an ordered note sequence.
 *
 * @module midi/adaptation/VoiceSelector
 */

/**
 * @typedef {Object} Voice
 * @property {number} gm_program              GM program (0-127) or ≥128 encoded drum kit.
 * @property {string} [note_selection_mode]   'range' | 'discrete' | null.
 * @property {number} [note_range_min]        Inclusive low note (range mode).
 * @property {number} [note_range_max]        Inclusive high note (range mode).
 * @property {number[]} [selected_notes]      Playable notes (discrete mode).
 * @property {number} [display_order]         Stable ordering for tie-breaks.
 */

/**
 * Does a voice declare a usable per-voice note capability we can discriminate
 * on? A voice that shares the primary's notes (no declared mode) cannot.
 * @param {Voice} v
 * @returns {boolean}
 */
function declaresNotes(v) {
  if (!v || v.gm_program == null) return false;
  if (v.note_selection_mode === 'range') {
    return Number.isInteger(v.note_range_min) && Number.isInteger(v.note_range_max);
  }
  if (v.note_selection_mode === 'discrete') {
    return Array.isArray(v.selected_notes) && v.selected_notes.length > 0;
  }
  return false;
}

/**
 * Does `note` fall within a voice's declared note set? Assumes
 * {@link declaresNotes} is true.
 * @param {Voice} v
 * @param {number} note
 * @returns {boolean}
 */
function voiceClaims(v, note) {
  if (v.note_selection_mode === 'range') {
    return note >= v.note_range_min && note <= v.note_range_max;
  }
  // discrete
  return v.selected_notes.includes(note);
}

/**
 * Specificity of a voice's declared note set — SMALLER = more specific, so a
 * tight range or a short discrete list beats a wide range. Used to resolve
 * overlapping claims deterministically.
 * @param {Voice} v
 * @returns {number} count of notes the voice claims (its "span")
 */
function specificity(v) {
  if (v.note_selection_mode === 'range') {
    return v.note_range_max - v.note_range_min + 1;
  }
  return v.selected_notes.length;
}

/**
 * Select the GM program to use for a single note.
 *
 * @param {Object} params
 * @param {number} params.note                MIDI note number (0-127).
 * @param {number} params.primaryProgram      The channel's primary GM program.
 * @param {Voice[]} [params.voices]           Secondary voices on the channel.
 * @param {boolean} [params.sharesNotes=true] `voices_share_notes` flag. When
 *   true (default) the policy is a no-op and always returns `primaryProgram`.
 * @returns {number} the GM program to sound this note with.
 */
export function selectVoiceProgram({ note, primaryProgram, voices, sharesNotes = true }) {
  if (sharesNotes !== false) return primaryProgram;
  if (!Array.isArray(voices) || voices.length === 0) return primaryProgram;

  let best = null;
  for (const v of voices) {
    if (!declaresNotes(v) || !voiceClaims(v, note)) continue;
    if (best === null) {
      best = v;
      continue;
    }
    const s = specificity(v);
    const bs = specificity(best);
    if (
      s < bs ||
      // tie → lowest display_order, then lowest gm_program, for stable output.
      (s === bs && (v.display_order ?? 0) < (best.display_order ?? 0)) ||
      (s === bs &&
        (v.display_order ?? 0) === (best.display_order ?? 0) &&
        v.gm_program < best.gm_program)
    ) {
      best = v;
    }
  }
  return best ? best.gm_program : primaryProgram;
}

/**
 * Plan the minimal sequence of Program Change insertions for an ordered note
 * sequence. Emits a change ONLY when the selected program differs from the one
 * currently active on the channel, so identical consecutive voices collapse to
 * a single (or zero) change.
 *
 * The caller decides the initial active program via `startProgram` — pass the
 * program the channel is known to already carry (typically `primaryProgram`, or
 * the file's own Program Change) so a leading run of primary-voice notes emits
 * nothing.
 *
 * The result is transport-agnostic: each entry references the note it precedes
 * by index, leaving MIDI-tick / delta-time placement to the integrator (bake or
 * live router), which knows the channel mapping to the destination instrument.
 *
 * @param {Array<{note:number}>} noteSequence  Ordered note-ons (time order).
 * @param {Object} params
 * @param {number} params.primaryProgram
 * @param {Voice[]} [params.voices]
 * @param {boolean} [params.sharesNotes=true]
 * @param {number} [params.startProgram]       Active program before the first
 *   note (defaults to `primaryProgram`).
 * @returns {Array<{index:number, note:number, program:number}>} program changes
 *   to insert immediately before `noteSequence[index]`.
 */
export function planVoiceProgramChanges(
  noteSequence,
  { primaryProgram, voices, sharesNotes = true, startProgram }
) {
  if (sharesNotes !== false || !Array.isArray(voices) || !voices.some(declaresNotes)) {
    return []; // no-op: nothing to discriminate on.
  }
  const changes = [];
  let active = startProgram == null ? primaryProgram : startProgram;
  for (let i = 0; i < noteSequence.length; i++) {
    const note = noteSequence[i].note;
    const program = selectVoiceProgram({ note, primaryProgram, voices, sharesNotes });
    if (program !== active) {
      changes.push({ index: i, note, program });
      active = program;
    }
  }
  return changes;
}

export default { selectVoiceProgram, planVoiceProgramChanges };
