// tests/frontend/gm-instrument-names-sync.test.js
// Guards parity of the GM 1 instrument-name table. Canonical source is
// `shared/gm-instrument-names.json`; every other inline copy across the
// frontend must match it exactly. The locale en.json is the user-facing
// fallback. The inline arrays in index.html, MidiEditorConstants.js and
// LoopCreatorModal.js are offline copies (used before i18n loads / by
// modules that haven't been migrated to read the shared file yet).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sharedNames = JSON.parse(
  readFileSync(resolve(__dirname, '../../shared/gm-instrument-names.json'), 'utf8')
);
const enLocale = JSON.parse(
  readFileSync(resolve(__dirname, '../../public/locales/en.json'), 'utf8')
);

/** Extract a 128-string-literal array literal preceded by `pattern`. */
function extractArrayAfter(source, pattern) {
  const m = source.match(pattern);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

describe('GM instrument names — shared JSON parity', () => {
  it('shared/gm-instrument-names.json has exactly 128 entries', () => {
    expect(sharedNames).toHaveLength(128);
    for (const name of sharedNames) expect(typeof name).toBe('string');
  });

  it('no canonical entry contains a single quote (the regex would miss it)', () => {
    for (const n of sharedNames) expect(n.includes("'")).toBe(false);
  });

  it('matches public/locales/en.json instruments.list exactly', () => {
    expect(enLocale?.instruments?.list).toEqual(sharedNames);
  });

  it.each([
    ['public/index.html', /const\s+GM_INSTRUMENTS\s*=\s*\[([\s\S]*?)\];/],
    ['public/js/features/midi-editor/MidiEditorConstants.js',
      /gmInstruments:\s*\[([\s\S]*?)\]/],
    ['public/js/features/LoopCreatorModal.js',
      /GM_PROGRAM_NAMES\s*=\s*\[([\s\S]*?)\];/],
  ])('matches the inline copy in %s', (relPath, pattern) => {
    const src = readFileSync(resolve(__dirname, '../../', relPath), 'utf8');
    const items = extractArrayAfter(src, pattern);
    expect(items, `inline array not found in ${relPath}`).toBeTruthy();
    expect(items).toEqual(sharedNames);
  });
});
