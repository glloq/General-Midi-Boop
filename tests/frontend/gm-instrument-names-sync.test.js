// tests/frontend/gm-instrument-names-sync.test.js
// Guards parity of the GM 1 instrument-name table. Canonical source is
// `shared/gm-instrument-names.json`; the en.json locale (`instruments.list`)
// is the user-facing fallback and must match exactly. The frontend
// `GM_INSTRUMENTS` array inlined in `public/index.html` is the
// offline-only fallback (used before i18n loads) — verified here too
// so the three lists never drift.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sharedNames = JSON.parse(
  readFileSync(resolve(__dirname, '../../shared/gm-instrument-names.json'), 'utf8')
);
const enLocale = JSON.parse(
  readFileSync(resolve(__dirname, '../../public/locales/en.json'), 'utf8')
);
const indexHtml = readFileSync(
  resolve(__dirname, '../../public/index.html'),
  'utf8'
);

describe('GM instrument names — shared JSON parity', () => {
  it('shared/gm-instrument-names.json has exactly 128 entries', () => {
    expect(sharedNames).toHaveLength(128);
    for (const name of sharedNames) expect(typeof name).toBe('string');
  });

  it('matches public/locales/en.json instruments.list exactly', () => {
    expect(enLocale?.instruments?.list).toEqual(sharedNames);
  });

  it('matches the inline GM_INSTRUMENTS fallback in public/index.html', () => {
    // Extract the array literal that follows `const GM_INSTRUMENTS = [`
    // up to the closing `];`. The list is comment-interleaved so we
    // parse string literals individually.
    const m = indexHtml.match(/const\s+GM_INSTRUMENTS\s*=\s*\[([\s\S]*?)\];/);
    expect(m, 'GM_INSTRUMENTS array missing from index.html').toBeTruthy();
    const items = [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
    expect(items).toEqual(sharedNames);
  });
});
