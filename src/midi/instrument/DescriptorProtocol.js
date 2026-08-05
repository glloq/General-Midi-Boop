/**
 * @file src/midi/instrument/DescriptorProtocol.js
 * @description Pure core of the v2 Instrument Recognition & Capability Protocol
 * (docs/SYSEX_IDENTITY.md), independent of any transport or persistence:
 *
 *   - {@link assembleChunks}     — reassemble a block 0x10 segmented transfer
 *                                  (§3) into the descriptor JSON string.
 *   - {@link validateDescriptor} — structural validation of a parsed descriptor
 *                                  (§5). Unknown fields are ignored on purpose
 *                                  (the protocol's extensibility rule).
 *   - {@link diffOverrides}      — decide which user overrides to drop when a
 *                                  new descriptor arrives (§6 arbitration).
 *
 * These are the pieces the migration plan (§11.2) calls for on the GMB side.
 * They are deliberately side-effect-free so they can be unit-tested without the
 * MIDI stack or the database, and wired into DeviceManager / the persistence
 * layer separately.
 */

const MAX_INSTRUMENTS = 16;
const SUPPORTED_DESCRIPTOR_VERSION = 2;
const NOTE_MODES = new Set(['range', 'discrete']);

/**
 * Reassemble a block 0x10 segmented descriptor transfer (§3). Each chunk is
 * `{ index, total, payload }` where `payload` is the ASCII string carried by
 * one segment. Chunks may arrive out of order and be duplicated.
 *
 * @param {Array<{index:number,total:number,payload:string}>} chunks
 * @returns {{complete:boolean, total:(number|null), missing:number[], json:(string|null)}}
 */
export function assembleChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { complete: false, total: null, missing: [], json: null };
  }
  // `total` is taken from the chunks; reject a transfer whose chunks disagree
  // on the total (a mixed/corrupt stream — the caller should restart it).
  const totals = new Set(
    chunks.map((c) => c && c.total).filter((t) => Number.isInteger(t) && t > 0)
  );
  if (totals.size !== 1) {
    return { complete: false, total: null, missing: [], json: null };
  }
  const total = [...totals][0];

  const byIndex = new Map();
  for (const c of chunks) {
    if (!c || !Number.isInteger(c.index) || c.index < 0 || c.index >= total) continue;
    if (typeof c.payload !== 'string') continue;
    byIndex.set(c.index, c.payload); // last write wins on duplicates
  }

  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!byIndex.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    return { complete: false, total, missing, json: null };
  }

  let json = '';
  for (let i = 0; i < total; i++) json += byIndex.get(i);
  return { complete: true, total, missing: [], json };
}

/**
 * Structurally validate a parsed descriptor object (§5). Only known structural
 * constraints are checked; unknown fields are ignored so a future instrument
 * can add fields without failing validation. Returns the canonical
 * `{valid, errors}` envelope. On failure the caller falls back to level 0
 * (§7 step 6).
 *
 * @param {*} obj - parsed descriptor (e.g. JSON.parse of the transfer)
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateDescriptor(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['descriptor must be an object'] };
  }
  if (obj.gmb_descriptor !== SUPPORTED_DESCRIPTOR_VERSION) {
    errors.push(`gmb_descriptor must be ${SUPPORTED_DESCRIPTOR_VERSION}`);
  }
  if (obj.revision != null && !(Number.isInteger(obj.revision) && obj.revision >= 0)) {
    errors.push('revision must be a non-negative integer');
  }
  if (obj.device != null && (typeof obj.device !== 'object' || Array.isArray(obj.device))) {
    errors.push('device must be an object');
  }
  if (!Array.isArray(obj.instruments) || obj.instruments.length === 0) {
    errors.push('instruments must be a non-empty array');
  } else if (obj.instruments.length > MAX_INSTRUMENTS) {
    errors.push(`instruments must have at most ${MAX_INSTRUMENTS} entries`);
  } else {
    const seenChannels = new Set();
    obj.instruments.forEach((inst, i) => {
      const at = `instruments[${i}]`;
      if (!inst || typeof inst !== 'object' || Array.isArray(inst)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!Number.isInteger(inst.channel) || inst.channel < 0 || inst.channel > 15) {
        errors.push(`${at}.channel must be an integer 0-15`);
      } else if (seenChannels.has(inst.channel)) {
        errors.push(`${at}.channel ${inst.channel} is duplicated`);
      } else {
        seenChannels.add(inst.channel);
      }
      if (inst.configured != null && typeof inst.configured !== 'boolean') {
        errors.push(`${at}.configured must be a boolean`);
      }
      if (
        inst.gm_program != null &&
        !(Number.isInteger(inst.gm_program) && inst.gm_program >= 0 && inst.gm_program <= 127)
      ) {
        errors.push(`${at}.gm_program must be an integer 0-127`);
      }
      if (inst.type != null && typeof inst.type !== 'string') {
        errors.push(`${at}.type must be a string`);
      }
      if (inst.subtype != null && typeof inst.subtype !== 'string') {
        errors.push(`${at}.subtype must be a string`);
      }
      _validateNotes(inst.notes, `${at}.notes`, errors);
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a `notes` block (§5.3): `{mode:'range', min, max}` or
 * `{mode:'discrete', list:[...]}`. Absent notes is allowed (unknown).
 * @private
 */
function _validateNotes(notes, at, errors) {
  if (notes == null) return;
  if (typeof notes !== 'object' || Array.isArray(notes)) {
    errors.push(`${at} must be an object`);
    return;
  }
  if (!NOTE_MODES.has(notes.mode)) {
    errors.push(`${at}.mode must be 'range' or 'discrete'`);
    return;
  }
  if (notes.mode === 'range') {
    const okMin =
      notes.min == null || (Number.isInteger(notes.min) && notes.min >= 0 && notes.min <= 127);
    const okMax =
      notes.max == null || (Number.isInteger(notes.max) && notes.max >= 0 && notes.max <= 127);
    if (!okMin) errors.push(`${at}.min must be an integer 0-127`);
    if (!okMax) errors.push(`${at}.max must be an integer 0-127`);
    if (Number.isInteger(notes.min) && Number.isInteger(notes.max) && notes.min > notes.max) {
      errors.push(`${at}.min must be <= ${at}.max`);
    }
  } else {
    // discrete
    if (!Array.isArray(notes.list) || notes.list.length === 0) {
      errors.push(`${at}.list must be a non-empty array in discrete mode`);
    } else if (notes.list.some((n) => !(Number.isInteger(n) && n >= 0 && n <= 127))) {
      errors.push(`${at}.list must contain only integers 0-127`);
    }
  }
}

/**
 * Decide which user overrides to drop when a new descriptor arrives, per the §6
 * arbitration rule: an override is dropped only when the instrument itself
 * changed that field's value (so GMB defers to the device's own knowledge);
 * otherwise it is kept. Granularity is the leaf field, and a field's value is
 * compared as a whole (`tuning` is one value — one string changing drops the
 * whole tuning override).
 *
 * Special cases (§6):
 *   - `prevInstrument` is null (first descriptor ever seen for this instrument)
 *     → keep every override; nothing proves the device changed.
 *   - `nextInstrument.configured === false` → keep every override; GMB returns
 *     to manual entry without discarding anything.
 *   - a field present before but absent now (device "no longer knows") → keep.
 *
 * @param {?Object} prevInstrument - the previously cached descriptor instrument, or null
 * @param {Object} nextInstrument  - the newly received descriptor instrument
 * @param {string[]} overriddenFields - leaf field names the user has overridden
 * @returns {{purge:string[], keep:string[]}}
 */
export function diffOverrides(prevInstrument, nextInstrument, overriddenFields) {
  const fields = Array.isArray(overriddenFields) ? [...new Set(overriddenFields)] : [];
  // First descriptor, or instrument now unconfigured → keep everything.
  if (prevInstrument == null || (nextInstrument && nextInstrument.configured === false)) {
    return { purge: [], keep: fields };
  }
  const next = nextInstrument || {};
  const purge = [];
  const keep = [];
  for (const f of fields) {
    const prevHas =
      Object.prototype.hasOwnProperty.call(prevInstrument, f) && prevInstrument[f] !== undefined;
    const nextHas = Object.prototype.hasOwnProperty.call(next, f) && next[f] !== undefined;
    // Drop the override only when the device declared this field before AND
    // now, with a different value — i.e. the device moved it.
    if (prevHas && nextHas && !_deepEqual(prevInstrument[f], next[f])) {
      purge.push(f);
    } else {
      keep.push(f);
    }
  }
  return { purge, keep };
}

/**
 * Structural deep-equality for descriptor leaf values (numbers, strings,
 * booleans, null, and arrays/objects thereof). Sufficient for comparing
 * declared field values; not a general-purpose deep-equal.
 * @private
 */
function _deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => _deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && _deepEqual(a[k], b[k]));
  }
  return false;
}
