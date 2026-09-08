/**
 * @file tests/audit/l03-deadcode-midimessage.test.js
 * @description Lot L03 — proof that `src/midi/messages/MidiMessage.js`
 * (finding F-09, delegated to lot L14) is genuinely dead, so L14 can delete it
 * without a runtime surprise.
 *
 * `dead-modules.mjs` only counts STATIC importers. This suite closes the two
 * holes that a static scan leaves open: a dynamic `import()` / `require()`, and
 * a lookup by NAME through the ServiceContainer or any other string-keyed
 * registry. It also records what is being deleted: an alternative MIDI parser
 * that handles System Common — which is precisely why F-08 stayed hidden for so
 * long, since the codebase looked like it had a complete parser.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'src/midi/messages/MidiMessage.js';
const SCAN_DIRS = ['src', 'public/js', 'tests', 'scripts', 'server.js', 'vite.config.js'];

function collect(rel, acc = []) {
  const abs = path.join(REPO, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (/\.(js|mjs|cjs|ts|json|html)$/.test(rel)) acc.push(rel);
    return acc;
  }
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    collect(path.join(rel, entry), acc);
  }
  return acc;
}

// This suite and the dead-module scanner both name the module in prose; they
// are excluded so the scan measures the PRODUCT, not its own audit tooling.
const SELF = 'tests/audit/l03-deadcode-midimessage.test.js';
const SCANNER = 'scripts/audit/dead-modules.mjs';
const FILES = SCAN_DIRS.flatMap((d) => collect(d)).filter(
  (f) => !f.endsWith(TARGET) && f !== SELF && f !== SCANNER
);

describe('L03/F-09 — MidiMessage.js is dead (evidence for lot L14)', () => {
  test('no file imports or requires it, statically or dynamically', () => {
    const offenders = [];
    for (const rel of FILES) {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      // Any import/require/URL mentioning the module path or its basename as a
      // module specifier.
      if (
        /(?:from|import|require)\s*\(?\s*['"][^'"]*\/MidiMessage(?:\.js)?['"]/.test(src) ||
        /['"][^'"]*midi\/messages\/MidiMessage/.test(src)
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no string-keyed lookup could resolve it at runtime', () => {
    // A ServiceContainer registration, a dynamic path built from a name, or a
    // bare `'MidiMessage'` used as a key would all defeat the static scan.
    const offenders = [];
    for (const rel of FILES) {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      for (const m of src.matchAll(/\bMidiMessage\b/g)) {
        const around = src.slice(Math.max(0, m.index - 24), m.index + 20);
        // `handleMidiMessage`, `sendMidiMessage`, `validateMidiMessage`,
        // `_onMidiMessage`, `midi_message` are unrelated identifiers.
        if (/[A-Za-z_$]MidiMessage|MidiMessages/.test(around)) continue;
        if (rel.startsWith('docs/')) continue;
        offenders.push(`${rel}: …${around.trim()}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('it is not reachable through the ServiceContainer either', () => {
    const app = readFileSync(path.join(REPO, 'src/core/Application.js'), 'utf8');
    // `handleMidiMessage` / `sendMidiMessage` are unrelated identifiers; only a
    // bare `MidiMessage` token could name the class.
    expect(app).not.toMatch(/(?<![A-Za-z_$])MidiMessage\b/);
  });

  test('what L14 would delete: an unused second MIDI parser, System Common included', () => {
    const src = readFileSync(path.join(REPO, TARGET), 'utf8');
    // Recorded so the deletion is a conscious one, not a surprise: this module
    // decodes 0xF1 / 0xF2 / 0xF8 — the very messages F-08 found missing from
    // the parser the product actually runs.
    expect(src).toMatch(/status === 0xf1/);
    expect(src).toMatch(/status === 0xf2/);
    expect(src).toMatch(/status === 0xf8/);
    expect(src.split('\n')).toHaveLength(468); // 467 lines + trailing newline
  });
});
