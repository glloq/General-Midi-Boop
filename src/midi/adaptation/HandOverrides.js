/**
 * @file src/midi/adaptation/HandOverrides.js
 * @description Engine-side reader for `midi_instrument_routings.hand_position_overrides`
 * (migration 009) — the operator's pinned hand anchors, disabled notes and
 * per-note assignments authored in the hand-position editors.
 *
 * Until R13 these three lists were written, persisted, redrawn on screen and
 * honoured **only** by the client-side simulation
 * (`public/js/features/auto-assign/HandPositionFeasibility.js`): the engine read
 * `note_assignments` alone, and even that lookup was inert because the playback
 * event list carried no `tick` (audit F-139 — "capacité morte"). This module is
 * the single normalisation point shared by the two engine consumers so the live
 * player and the offline baker can never drift apart:
 *
 *   - {@link module:midi/playback/MidiPlayer} (live playback)
 *   - {@link module:files/MidiBaker}          (offline bake)
 *
 * The indexing rules mirror `HandPositionFeasibility._indexOverrides` exactly —
 * same keys, same validity predicates, same "an entry carries either
 * `{string,fret}` or `{handId}`, never both" split — so what the operator sees
 * simulated on screen is what the engine plans and emits.
 *
 * All positions are keyed in **MIDI ticks** (tempo-independent), which is how
 * the editors serialise them.
 */

/**
 * @typedef {Object} HandOverrideIndex
 * @property {Map<string, Map<number, number>>} anchors - handId → (tick → anchor).
 *   Anchor unit follows the destination's `hands_config.mode`: MIDI note number
 *   in `semitones` mode, absolute fret number in `frets` mode.
 * @property {Set<string>} disabled - `"tick:note"` keys the operator disabled.
 * @property {Array<{tick:number, note:number, handId:string}>} handPins -
 *   `note_assignments` entries in the keyboard shape.
 * @property {Map<string, {string:number, fret:number}>} stringPins -
 *   `note_assignments` entries in the string shape, keyed `"tick:note"`.
 * @property {boolean} isEmpty - true when nothing at all was declared.
 */

/** Empty, frozen index reused for the (very common) no-override case. */
const EMPTY_INDEX = Object.freeze({
  anchors: new Map(),
  disabled: new Set(),
  handPins: Object.freeze([]),
  stringPins: new Map(),
  isEmpty: true
});

/**
 * Normalise a parsed `hand_position_overrides` payload into engine lookups.
 * Accepts the raw JSON string as well as the parsed object so both the live
 * player (which parses on routing load) and the baker (which reads DB rows
 * straight) can call it.
 *
 * Malformed entries are skipped silently — the payload is operator data that
 * has already passed the `routing_hand_overrides_set` validator, and a partial
 * override must never break playback.
 *
 * @param {?Object|string} overrides
 * @returns {HandOverrideIndex}
 */
export function indexHandOverrides(overrides) {
  let src = overrides;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      return EMPTY_INDEX;
    }
  }
  if (!src || typeof src !== 'object') return EMPTY_INDEX;

  const anchors = new Map();
  const disabled = new Set();
  const handPins = [];
  const stringPins = new Map();

  if (Array.isArray(src.hand_anchors)) {
    for (const a of src.hand_anchors) {
      if (!a || !Number.isFinite(a.tick) || !a.handId || !Number.isFinite(a.anchor)) continue;
      let byTick = anchors.get(a.handId);
      if (!byTick) {
        byTick = new Map();
        anchors.set(a.handId, byTick);
      }
      // Last entry wins for a duplicated (handId, tick) — deterministic and
      // matches the editor, which replaces an existing pin in place.
      byTick.set(a.tick, a.anchor);
    }
  }

  if (Array.isArray(src.disabled_notes)) {
    for (const n of src.disabled_notes) {
      if (!n || !Number.isFinite(n.tick) || !Number.isFinite(n.note)) continue;
      disabled.add(`${n.tick}:${n.note}`);
    }
  }

  if (Array.isArray(src.note_assignments)) {
    for (const a of src.note_assignments) {
      if (!a || !Number.isFinite(a.tick) || !Number.isFinite(a.note)) continue;
      if (Number.isFinite(a.string) && Number.isFinite(a.fret)) {
        stringPins.set(`${a.tick}:${a.note}`, { string: a.string, fret: a.fret });
      } else if (typeof a.handId === 'string' && a.handId.length > 0) {
        handPins.push({ tick: a.tick, note: a.note, handId: a.handId });
      }
    }
  }

  const isEmpty =
    anchors.size === 0 && disabled.size === 0 && handPins.length === 0 && stringPins.size === 0;
  if (isEmpty) return EMPTY_INDEX;
  return { anchors, disabled, handPins, stringPins, isEmpty };
}

/**
 * @param {HandOverrideIndex} index
 * @param {?number} tick
 * @param {?number} note
 * @returns {boolean} True when the operator disabled this (tick, note).
 */
export function isNoteDisabled(index, tick, note) {
  if (!index || index.disabled.size === 0) return false;
  if (!Number.isFinite(tick) || !Number.isFinite(note)) return false;
  return index.disabled.has(`${tick}:${note}`);
}

/**
 * The planner-facing view of the pinned anchors: `Map<handId, Map<tick, anchor>>`,
 * or null when nothing is pinned (so a planner can skip the lookup entirely and
 * stay byte-identical to its pre-R13 output).
 *
 * @param {HandOverrideIndex} index
 * @returns {?Map<string, Map<number, number>>}
 */
export function plannerAnchors(index) {
  if (!index || index.anchors.size === 0) return null;
  return index.anchors;
}

export default { indexHandOverrides, isNoteDisabled, plannerAnchors };
