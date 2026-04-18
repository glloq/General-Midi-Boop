/**
 * @file src/midi/playback/commands/midiConverterCache.js
 * @description Lazy {@link JsonMidiConverter} cache shared by every
 * playback-domain handler that needs to parse a stored MIDI buffer
 * (P0-1.2). One converter per `app` instance — the WeakMap lets the
 * converter be GC'd alongside the app facade in tests.
 */
import JsonMidiConverter from '../../../files/JsonMidiConverter.js';

/** @type {WeakMap<Object, JsonMidiConverter>} app facade → converter. */
const converterCache = new WeakMap();

/**
 * Resolve a per-app `JsonMidiConverter` instance, creating it on first
 * call. Keeps converter construction (which loads constants tables)
 * out of the hot request path.
 *
 * @param {Object} app
 * @returns {JsonMidiConverter}
 */
export function getMidiConverter(app) {
  if (!converterCache.has(app)) {
    converterCache.set(app, new JsonMidiConverter(app.logger));
  }
  return converterCache.get(app);
}
