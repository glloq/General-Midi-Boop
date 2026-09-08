/**
 * @file src/api/commands/schemas/helpers.js
 * @description Shared predicates for the declarative command schemas
 * (ADR-004). Not a schema file itself — the `*.schemas.js` suffix is what
 * the inventory tooling scans, so this module is deliberately named without
 * it.
 *
 * Design rule for the backfill of F-19: **be lenient about representation,
 * strict about shape and range.** The frontend has fifteen years of habits in
 * it — a channel arrives as `3` or `"3"`, a boolean as `true`, `1` or `"1"` —
 * and the handlers already normalise with `parseInt`/`Number`. A schema that
 * demanded canonical JSON types would reject payloads that work today, which
 * is precisely the regression the fail-closed switch must not cause.
 *
 * What these predicates DO stop is what the fuzzing campaign showed reaching
 * SQLite: objects and arrays where a scalar belongs, 200 000-character
 * strings, `1e308`, and 600-level-deep nesting.
 */

/** Longest accepted identifier (device ids, ALSA names, preset keys…). */
export const MAX_ID_LEN = 256;
/** Longest accepted human-facing name. */
export const MAX_NAME_LEN = 128;
/** Longest accepted free-text field (descriptions, filters…). */
export const MAX_TEXT_LEN = 1024;
/** Largest accepted array for bulk payloads (voices, notes, rules…). */
export const MAX_ARRAY_LEN = 10000;

/**
 * @param {*} v
 * @returns {boolean} True for plain `{...}` objects (excludes arrays/null).
 */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A field is "absent" when it is missing, `undefined` or `null`. Handlers
 * treat all three the same (`data.x || default`), so schemas must too.
 * @param {Object} data
 * @param {string} key
 * @returns {boolean}
 */
export function absent(data, key) {
  return data[key] === undefined || data[key] === null;
}

/**
 * Row identifier: a finite positive number, or a non-empty string of
 * reasonable length (device ids are strings, DB ids are numbers).
 * @param {*} v
 * @returns {boolean}
 */
export function isIdLike(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (typeof v === 'string') return v.length > 0 && v.length <= MAX_ID_LEN;
  return false;
}

/**
 * Integer, or a string that `parseInt` turns into one (the handlers do).
 * @param {*} v
 * @param {number} [min=-Infinity]
 * @param {number} [max=Infinity]
 * @returns {boolean}
 */
export function isIntLike(v, min = -Infinity, max = Infinity) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) n = Number(v);
  else return false;
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Finite number, or a string that parses to one.
 * @param {*} v
 * @param {number} [min=-Infinity]
 * @param {number} [max=Infinity]
 * @returns {boolean}
 */
export function isNumLike(v, min = -Infinity, max = Infinity) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return false;
  return Number.isFinite(n) && n >= min && n <= max;
}

/**
 * Boolean, or one of the representations SQLite/the SPA use for one.
 * @param {*} v
 * @returns {boolean}
 */
export function isBoolLike(v) {
  return (
    typeof v === 'boolean' ||
    v === 0 ||
    v === 1 ||
    v === '0' ||
    v === '1' ||
    v === 'true' ||
    v === 'false'
  );
}

/**
 * @param {*} v
 * @param {number} [max=MAX_TEXT_LEN]
 * @returns {boolean}
 */
export function isStr(v, max = MAX_TEXT_LEN) {
  return typeof v === 'string' && v.length <= max;
}

/**
 * Non-empty string within a length cap.
 * @param {*} v
 * @param {number} [max=MAX_TEXT_LEN]
 * @returns {boolean}
 */
export function isNonEmptyStr(v, max = MAX_TEXT_LEN) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * MIDI channel: 0-15, number or numeric string.
 * @param {*} v
 * @returns {boolean}
 */
export function isChannel(v) {
  return isIntLike(v, 0, 15);
}

/**
 * Build a `custom` validator from a table of per-field rules.
 *
 * Each rule is `[name, predicate, message, {required?:boolean}]`. A field that
 * is absent is skipped unless `required` is set — matching
 * {@link ../../../utils/SchemaCompiler.js}'s own `fields` semantics.
 *
 * @param {Array<[string, function(*):boolean, string, {required?:boolean}=]>} rules
 * @param {function(Object, string[]):void} [extra] - Cross-field checks.
 * @returns {function(Object):string[]}
 */
export function fieldRules(rules, extra) {
  return (data) => {
    const errors = [];
    for (const [name, predicate, message, opts] of rules) {
      if (absent(data, name)) {
        if (opts && opts.required) errors.push(`${name} is required`);
        continue;
      }
      if (!predicate(data[name])) errors.push(message);
    }
    if (extra) extra(data, errors);
    return errors;
  };
}

/**
 * Shorthand for the very common "one required identifier" schema.
 * @param {string} name
 * @returns {{custom: function(Object):string[]}}
 */
export function requireId(name) {
  return {
    custom: fieldRules([
      [name, isIdLike, `${name} must be a number or non-empty string`, { required: true }]
    ])
  };
}

/**
 * Shorthand for "one optional identifier" (list/filter commands).
 * @param {string} name
 * @returns {{custom: function(Object):string[]}}
 */
export function optionalId(name) {
  return {
    custom: fieldRules([[name, isIdLike, `${name} must be a number or non-empty string`]])
  };
}

/**
 * Bounded array check: an array with at most `max` entries.
 * @param {number} [max=MAX_ARRAY_LEN]
 * @returns {function(*):boolean}
 */
export function isArrayMax(max = MAX_ARRAY_LEN) {
  return (v) => Array.isArray(v) && v.length <= max;
}
