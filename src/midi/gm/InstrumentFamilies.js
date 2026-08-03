/**
 * @file src/midi/gm/InstrumentFamilies.js
 * @description Backend mirror of the instrument-family taxonomy used by
 * the frontend picker. Loads the canonical data from
 * `shared/instrument-families.json` at module init time (synchronous,
 * one-shot) and exposes helpers that backend consumers can use:
 *   - getFamilies()                     → Array<Family>
 *   - getFamilyBySlug(slug)             → Family | null
 *   - getFamilyForProgram(program, ch)  → Family | null
 *   - isDrumFamily(slug)                → boolean
 *   - getProgramSlug(program)           → string | null
 *   - drumKitOffset                     → number (128)
 *   - gmDrumKits                        → Array<{program, name}>
 *
 * The frontend keeps an inline copy of the same data for synchronous
 * page-load. A Vitest test asserts parity between the JSON and the
 * frontend module (see tests/unit/instrument-families-sync.test.js).
 *
 * Playback, matcher, and adaptation pipelines should use this module
 * rather than duplicating the taxonomy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JSON_PATH = path.resolve(__dirname, '../../../shared/instrument-families.json');

const _data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const FAMILIES = Object.freeze(_data.families.map((f) => Object.freeze({ ...f })));
const PROGRAM_TO_SLUG = Object.freeze(
  Object.fromEntries(Object.entries(_data.programToSlug).map(([k, v]) => [Number(k), v]))
);
const GM_DRUM_KITS = Object.freeze(_data.gmDrumKits.map((k) => Object.freeze({ ...k })));
const DRUM_KIT_OFFSET = _data.drumKitOffset;

// Reverse lookup (program → family slug), drum-kit family excluded
const _programToFamily = new Map();
for (const fam of FAMILIES) {
  if (fam.isDrumKits) continue;
  for (const p of fam.programs) _programToFamily.set(p, fam.slug);
}

/**
 * @returns {ReadonlyArray<Object>} The 13 family descriptors in display order.
 */
export function getFamilies() {
  return FAMILIES;
}

/**
 * @param {string} slug
 * @returns {Object|null}
 */
export function getFamilyBySlug(slug) {
  if (!slug) return null;
  return FAMILIES.find((f) => f.slug === slug) || null;
}

/**
 * Resolve the family a GM program belongs to. Channel 9 or
 * `program >= DRUM_KIT_OFFSET` always resolve to the `drum_kits` family.
 *
 * @param {number|null|undefined} program
 * @param {number|null|undefined} channel
 * @returns {Object|null}
 */
export function getFamilyForProgram(program, channel) {
  if (channel === 9) return getFamilyBySlug('drum_kits');
  if (program == null) return null;
  if (program >= DRUM_KIT_OFFSET) return getFamilyBySlug('drum_kits');
  const slug = _programToFamily.get(program);
  return slug ? getFamilyBySlug(slug) : null;
}

/**
 * @param {string} slug
 * @returns {boolean}
 */
export function isDrumFamily(slug) {
  const f = getFamilyBySlug(slug);
  return !!(f && f.isDrumKits);
}

/**
 * Canonical SVG slug for a program (matches public/assets/instruments/<slug>.svg).
 * Returns null for programs that don't have a dedicated SVG yet — caller
 * should fall back to the family emoji.
 *
 * @param {number|null|undefined} program
 * @returns {string|null}
 */
export function getProgramSlug(program) {
  if (program == null) return null;
  return PROGRAM_TO_SLUG[program] || null;
}

export { DRUM_KIT_OFFSET as drumKitOffset, GM_DRUM_KITS as gmDrumKits };

export default {
  getFamilies,
  getFamilyBySlug,
  getFamilyForProgram,
  isDrumFamily,
  getProgramSlug,
  drumKitOffset: DRUM_KIT_OFFSET,
  gmDrumKits: GM_DRUM_KITS
};
