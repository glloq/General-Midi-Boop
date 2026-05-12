/**
 * @file src/api/commands/schemas/loop.schemas.js
 * @description Declarative validation schemas for `loop_*` and
 * `arrangement_*` WebSocket commands. Consumed by
 * `JsonValidator.validateByCommand` via the `COMPILED_SCHEMAS` lookup.
 *
 * Bornes choisies pour matcher les défauts de la migration SQL
 * (`migrations/017_loops.sql`, `018_loop_arrangements.sql`) et les
 * contraintes UI (cf. `LoopUtils.validate*`). La principale fonction
 * de ces schemas est de stopper les payloads invalides AVANT qu'ils
 * atteignent le repository — voir AUDIT_MODAL_BOUCLES_2026-05-11.md
 * §B1-B7.
 */

/** Contraintes partagées — exposées pour réutilisation côté repository. */
export const LOOP_CONSTRAINTS = Object.freeze({
  NAME_MAX_LENGTH: 120,
  TEMPO_MIN: 20,
  TEMPO_MAX: 300,
  TIME_SIG_NUM_MIN: 1,
  TIME_SIG_NUM_MAX: 32,
  TIME_SIG_DEN_VALUES: [1, 2, 4, 8, 16, 32],
  BARS_MIN: 1,
  BARS_MAX: 256,
  PPQ_MIN: 24,
  PPQ_MAX: 960,
  PROGRAM_MIN: 0,
  PROGRAM_MAX: 127,
  NOTE_MIN: 0,
  NOTE_MAX: 127,
  VELOCITY_MIN: 1,
  VELOCITY_MAX: 127,
  MIDI_DATA_MAX_BYTES: 256 * 1024, // 256 KB de JSON encodé
  TOTAL_BARS_MIN: 1,
  TOTAL_BARS_MAX: 1024,
  POSITION_BAR_MIN: 0,
  POSITION_BAR_MAX: 1024,
  REPETITIONS_MIN: 1,
  REPETITIONS_MAX: 256,
  TRACK_INDEX_MIN: 0,
  TRACK_INDEX_MAX: 64,
  MIDI_CHANNEL_MIN: 1,
  MIDI_CHANNEL_MAX: 16,
  LABEL_MAX_LENGTH: 80
});

const C = LOOP_CONSTRAINTS;

/**
 * Valide un nom : string non-vide après trim, ≤ NAME_MAX_LENGTH.
 * @param {*} v
 * @returns {?string} message d'erreur ou null
 */
function validateName(v) {
  if (typeof v !== 'string' || !v.trim()) return 'name is required';
  if (v.trim().length > C.NAME_MAX_LENGTH) {
    return `name must be at most ${C.NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/** Tempo optionnel : nombre fini ∈ [TEMPO_MIN, TEMPO_MAX]. */
function validateTempo(v, fieldName = 'tempo') {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `${fieldName} must be a finite number`;
  }
  if (v < C.TEMPO_MIN || v > C.TEMPO_MAX) {
    return `${fieldName} must be between ${C.TEMPO_MIN} and ${C.TEMPO_MAX}`;
  }
  return null;
}

/** time_sig_num optionnel : entier ∈ [1, 32]. */
function validateTimeSigNum(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.TIME_SIG_NUM_MIN || v > C.TIME_SIG_NUM_MAX) {
    return `time_sig_num must be an integer between ${C.TIME_SIG_NUM_MIN} and ${C.TIME_SIG_NUM_MAX}`;
  }
  return null;
}

/** time_sig_den optionnel : entier dans la liste des dénominateurs musicaux. */
function validateTimeSigDen(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || !C.TIME_SIG_DEN_VALUES.includes(v)) {
    return `time_sig_den must be one of ${C.TIME_SIG_DEN_VALUES.join(', ')}`;
  }
  return null;
}

/** bars optionnel : entier ∈ [1, 256]. */
function validateBars(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.BARS_MIN || v > C.BARS_MAX) {
    return `bars must be an integer between ${C.BARS_MIN} and ${C.BARS_MAX}`;
  }
  return null;
}

/** ppq optionnel : entier ∈ [24, 960]. */
function validatePpq(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.PPQ_MIN || v > C.PPQ_MAX) {
    return `ppq must be an integer between ${C.PPQ_MIN} and ${C.PPQ_MAX}`;
  }
  return null;
}

/** instrument_program optionnel : entier ∈ [0, 127] (programme GM mélodique)
 *  ou ∈ [DRUM_KIT_OFFSET, DRUM_KIT_OFFSET + 127] (kit drum encodé avec
 *  l'offset documenté dans `shared/instrument-families.json`). On accepte
 *  ici la borne [0, 255] qui couvre les deux cas — la décode côté player
 *  est faite par `MidiSynthesizer._decodeKitProgram`.
 */
const PROGRAM_MAX_WITH_DRUM_OFFSET = C.PROGRAM_MAX + 128; // 255
function validateProgram(v, fieldName = 'instrument_program') {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.PROGRAM_MIN || v > PROGRAM_MAX_WITH_DRUM_OFFSET) {
    return `${fieldName} must be an integer between ${C.PROGRAM_MIN} and ${PROGRAM_MAX_WITH_DRUM_OFFSET}`;
  }
  return null;
}

/**
 * Valide midi_data : array de notes, OU string JSON parsable représentant
 * un array. Limite la taille sérialisée à MIDI_DATA_MAX_BYTES pour éviter
 * un DoS via gros payload.
 * @param {*} v
 * @returns {?string}
 */
function validateMidiData(v) {
  if (v === undefined || v === null) return null;

  let arr;
  let encodedLength;

  if (typeof v === 'string') {
    encodedLength = v.length;
    if (encodedLength > C.MIDI_DATA_MAX_BYTES) {
      return `midi_data exceeds ${C.MIDI_DATA_MAX_BYTES} bytes`;
    }
    try {
      arr = JSON.parse(v);
    } catch {
      return 'midi_data must be valid JSON';
    }
  } else if (Array.isArray(v)) {
    arr = v;
    try {
      encodedLength = JSON.stringify(v).length;
    } catch {
      return 'midi_data must be JSON-serialisable';
    }
    if (encodedLength > C.MIDI_DATA_MAX_BYTES) {
      return `midi_data exceeds ${C.MIDI_DATA_MAX_BYTES} bytes`;
    }
  } else {
    return 'midi_data must be an array or a JSON string';
  }

  if (!Array.isArray(arr)) {
    return 'midi_data must be a JSON array';
  }

  // Vérifie chaque note : {t, n, v, l} avec types entiers + bornes.
  for (let i = 0; i < arr.length; i++) {
    const note = arr[i];
    if (note === null || typeof note !== 'object' || Array.isArray(note)) {
      return `midi_data[${i}] must be an object`;
    }
    if (!Number.isInteger(note.t) || note.t < 0) {
      return `midi_data[${i}].t (tick) must be a non-negative integer`;
    }
    if (!Number.isInteger(note.n) || note.n < C.NOTE_MIN || note.n > C.NOTE_MAX) {
      return `midi_data[${i}].n (note) must be an integer between ${C.NOTE_MIN} and ${C.NOTE_MAX}`;
    }
    if (!Number.isInteger(note.v) || note.v < C.VELOCITY_MIN || note.v > C.VELOCITY_MAX) {
      return `midi_data[${i}].v (velocity) must be an integer between ${C.VELOCITY_MIN} and ${C.VELOCITY_MAX}`;
    }
    if (!Number.isInteger(note.l) || note.l <= 0) {
      return `midi_data[${i}].l (length) must be a positive integer`;
    }
  }

  return null;
}

/** Empile les erreurs non-null dans `errors`. */
function push(errors, ...maybeErrs) {
  for (const e of maybeErrs) if (e) errors.push(e);
}

// ── loop_* ──────────────────────────────────────────────────────────

export const loop_create = {
  custom: (data) => {
    const errors = [];
    push(errors,
      validateName(data.name),
      validateTempo(data.tempo),
      validateTimeSigNum(data.time_sig_num),
      validateTimeSigDen(data.time_sig_den),
      validateBars(data.bars),
      validatePpq(data.ppq),
      validateProgram(data.instrument_program),
      validateMidiData(data.midi_data)
    );
    return errors;
  }
};

export const loop_get = {
  fields: {
    loopId: { type: 'id', required: true }
  }
};

export const loop_update = {
  custom: (data) => {
    const errors = [];
    if (data.loopId === undefined || data.loopId === null) {
      errors.push('loopId is required');
    }
    // name : optionnel à l'update mais si présent doit être valide.
    if (data.name !== undefined) {
      const e = validateName(data.name);
      if (e) errors.push(e);
    }
    push(errors,
      validateTempo(data.tempo),
      validateTimeSigNum(data.time_sig_num),
      validateTimeSigDen(data.time_sig_den),
      validateBars(data.bars),
      validatePpq(data.ppq),
      validateProgram(data.instrument_program),
      validateMidiData(data.midi_data)
    );
    return errors;
  }
};

export const loop_delete = {
  fields: {
    loopId: { type: 'id', required: true }
  }
};

// ── arrangement_* ──────────────────────────────────────────────────

/** total_bars optionnel. */
function validateTotalBars(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.TOTAL_BARS_MIN || v > C.TOTAL_BARS_MAX) {
    return `total_bars must be an integer between ${C.TOTAL_BARS_MIN} and ${C.TOTAL_BARS_MAX}`;
  }
  return null;
}

/** position_bar optionnel (défaut 0). */
function validatePositionBar(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.POSITION_BAR_MIN || v > C.POSITION_BAR_MAX) {
    return `position_bar must be an integer between ${C.POSITION_BAR_MIN} and ${C.POSITION_BAR_MAX}`;
  }
  return null;
}

/** repetitions optionnel (défaut 1). */
function validateRepetitions(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.REPETITIONS_MIN || v > C.REPETITIONS_MAX) {
    return `repetitions must be an integer between ${C.REPETITIONS_MIN} and ${C.REPETITIONS_MAX}`;
  }
  return null;
}

/** track_index optionnel. */
function validateTrackIndex(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.TRACK_INDEX_MIN || v > C.TRACK_INDEX_MAX) {
    return `track_index must be an integer between ${C.TRACK_INDEX_MIN} and ${C.TRACK_INDEX_MAX}`;
  }
  return null;
}

/** midi_channel optionnel — convention 1-16 (cf. LoopArrangementsDB default 1). */
function validateMidiChannel(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < C.MIDI_CHANNEL_MIN || v > C.MIDI_CHANNEL_MAX) {
    return `midi_channel must be an integer between ${C.MIDI_CHANNEL_MIN} and ${C.MIDI_CHANNEL_MAX}`;
  }
  return null;
}

/** Label optionnel : string ≤ 80 chars (peut être vide). */
function validateLabel(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return 'label must be a string';
  if (v.length > C.LABEL_MAX_LENGTH) {
    return `label must be at most ${C.LABEL_MAX_LENGTH} characters`;
  }
  return null;
}

export const arrangement_create = {
  custom: (data) => {
    const errors = [];
    push(errors,
      validateName(data.name),
      validateTempo(data.global_tempo, 'global_tempo'),
      validateTotalBars(data.total_bars)
    );
    return errors;
  }
};

export const arrangement_get = {
  fields: {
    arrangementId: { type: 'id', required: true }
  }
};

export const arrangement_update = {
  custom: (data) => {
    const errors = [];
    if (data.arrangementId === undefined || data.arrangementId === null) {
      errors.push('arrangementId is required');
    }
    if (data.name !== undefined) {
      const e = validateName(data.name);
      if (e) errors.push(e);
    }
    push(errors,
      validateTempo(data.global_tempo, 'global_tempo'),
      validateTotalBars(data.total_bars)
    );
    return errors;
  }
};

export const arrangement_delete = {
  fields: {
    arrangementId: { type: 'id', required: true }
  }
};

export const arrangement_add_track = {
  custom: (data) => {
    const errors = [];
    if (data.arrangementId === undefined || data.arrangementId === null) {
      errors.push('arrangementId is required');
    }
    push(errors,
      validateTrackIndex(data.track_index),
      validateLabel(data.label),
      validateMidiChannel(data.midi_channel)
    );
    return errors;
  }
};

export const arrangement_update_track = {
  custom: (data) => {
    const errors = [];
    if (data.trackId === undefined || data.trackId === null) {
      errors.push('trackId is required');
    }
    push(errors,
      validateLabel(data.label),
      validateMidiChannel(data.midi_channel)
    );
    return errors;
  }
};

export const arrangement_delete_track = {
  fields: {
    trackId: { type: 'id', required: true }
  }
};

export const arrangement_add_block = {
  custom: (data) => {
    const errors = [];
    if (data.trackId === undefined || data.trackId === null) {
      errors.push('trackId is required');
    }
    if (data.loopId === undefined || data.loopId === null) {
      errors.push('loopId is required');
    }
    push(errors,
      validatePositionBar(data.position_bar),
      validateRepetitions(data.repetitions)
    );
    return errors;
  }
};

export const arrangement_update_block = {
  custom: (data) => {
    const errors = [];
    if (data.blockId === undefined || data.blockId === null) {
      errors.push('blockId is required');
    }
    push(errors,
      validatePositionBar(data.position_bar),
      validateRepetitions(data.repetitions)
    );
    return errors;
  }
};

export const arrangement_delete_block = {
  fields: {
    blockId: { type: 'id', required: true }
  }
};

// ── Registry ───────────────────────────────────────────────────────

const schemas = {
  loop_create,
  loop_get,
  loop_update,
  loop_delete,
  arrangement_create,
  arrangement_get,
  arrangement_update,
  arrangement_delete,
  arrangement_add_track,
  arrangement_update_track,
  arrangement_delete_track,
  arrangement_add_block,
  arrangement_update_block,
  arrangement_delete_block
};

export default schemas;
