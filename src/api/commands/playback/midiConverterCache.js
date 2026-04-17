// src/api/commands/playback/midiConverterCache.js
// Shared lazy MIDI converter cache — extracted from PlaybackCommands.js (P0-1.2).
import JsonMidiConverter from '../../../storage/JsonMidiConverter.js';

const converterCache = new WeakMap();

export function getMidiConverter(app) {
  if (!converterCache.has(app)) {
    converterCache.set(app, new JsonMidiConverter(app.logger));
  }
  return converterCache.get(app);
}
