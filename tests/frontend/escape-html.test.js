// tests/frontend/escape-html.test.js
// Locks in the hardened canonical escapeHtml: it must escape the full
// OWASP set (& < > " ') so the same call is safe in BOTH text and
// attribute contexts. Regression guard for the DeviceSettingsModal /
// SettingsHotspot consolidation (they now delegate here, and one is
// used inside an HTML attribute value).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, '../../public/js/utils/escapeHtml.js'),
    'utf8'
  );
  new Function('window', src)(window);
});

describe('canonical escapeHtml', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(window.escapeHtml(null)).toBe('');
    expect(window.escapeHtml(undefined)).toBe('');
    expect(window.escapeHtml('')).toBe('');
  });

  it('escapes the full OWASP set including quotes', () => {
    expect(window.escapeHtml(`a"b<c>&'d`)).toBe('a&quot;b&lt;c&gt;&amp;&#39;d');
  });

  it('escapes & first so entities are not double-encoded wrongly', () => {
    expect(window.escapeHtml('<')).toBe('&lt;');
    expect(window.escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('is safe in an attribute context (no quote breakout)', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const escaped = window.escapeHtml(evil);
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain('<');
    expect(escaped).toBe(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'
    );
  });

  it('coerces non-strings', () => {
    expect(window.escapeHtml(0)).toBe('0');
    expect(window.escapeHtml(42)).toBe('42');
  });
});
