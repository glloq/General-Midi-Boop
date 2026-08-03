// tests/audit-i18n.test.js
// Comprehensive i18n audit: validates all locale files against the English reference

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// Helpers
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCALES_DIR = path.resolve(__dirname, '..', 'public', 'locales');

const EXPECTED_LOCALES = [
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'eo',
  'es',
  'fi',
  'fr',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'th',
  'tl',
  'tr',
  'uk',
  'vi',
  'zh-CN'
];

/**
 * Recursively flatten a nested object into dot-separated key paths.
 * Array values are treated as leaf nodes (not recursed into).
 */
function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Recursively collect all values that are plain strings (not inside arrays).
 * Returns an array of { key, value } objects.
 */
function flattenStringValues(obj, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenStringValues(value, fullKey));
    } else if (typeof value === 'string') {
      entries.push({ key: fullKey, value });
    }
  }
  return entries;
}

/**
 * Build a "structure signature" that captures nesting and types but ignores
 * concrete values. Arrays are represented by their length so we can compare
 * array sizes across locales.
 */
function structureSignature(obj) {
  const sig = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sig[key] = structureSignature(value);
    } else if (Array.isArray(value)) {
      sig[key] = `[Array:${value.length}]`;
    } else {
      sig[key] = typeof value;
    }
  }
  return sig;
}

/**
 * Resolve a dot-separated path inside a nested object.
 */
function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[part];
  }, obj);
}

// ============================================================
// Load locales
// ============================================================

const localeData = {};
for (const code of EXPECTED_LOCALES) {
  const filePath = path.join(LOCALES_DIR, `${code}.json`);
  localeData[code] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const referenceLocale = localeData['en'];
const referenceKeys = new Set(flattenKeys(referenceLocale));
const nonEnglishLocales = EXPECTED_LOCALES.filter((c) => c !== 'en');

// ============================================================
// Tests
// ============================================================

describe('i18n audit', () => {
  // ----------------------------------------------------------
  // 1. All expected locale files exist
  // ----------------------------------------------------------
  describe('locale file inventory', () => {
    it('should have all 28 expected locale files', () => {
      const existing = fs
        .readdirSync(LOCALES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort();

      const missing = EXPECTED_LOCALES.filter((c) => !existing.includes(c));
      const unexpected = existing.filter((c) => !EXPECTED_LOCALES.includes(c));

      expect(missing).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(existing.length).toBe(28);
    });
  });

  // ----------------------------------------------------------
  // 2 & 3. Missing and extra keys per locale
  // ----------------------------------------------------------
  describe('key completeness vs en.json reference', () => {
    for (const code of nonEnglishLocales) {
      describe(`locale: ${code}`, () => {
        const localeKeys = new Set(flattenKeys(localeData[code]));

        it('should have no missing keys', () => {
          const missing = [...referenceKeys].filter((k) => !localeKeys.has(k));
          expect(missing).toEqual([]);
        });

        it('should have no extra keys not present in en.json', () => {
          const extra = [...localeKeys].filter((k) => !referenceKeys.has(k));
          expect(extra).toEqual([]);
        });
      });
    }
  });

  // ----------------------------------------------------------
  // 4. No empty-string translations
  // ----------------------------------------------------------
  describe('no empty string values', () => {
    for (const code of EXPECTED_LOCALES) {
      it(`${code} should contain no empty string values`, () => {
        const allStrings = flattenStringValues(localeData[code]);
        const empties = allStrings.filter((entry) => entry.value === '').map((entry) => entry.key);

        expect(empties).toEqual([]);
      });
    }
  });

  // ----------------------------------------------------------
  // 5. instruments.list has exactly 128 entries
  // ----------------------------------------------------------
  describe('instruments.list has 128 GM program names', () => {
    for (const code of EXPECTED_LOCALES) {
      it(`${code} instruments.list should have exactly 128 entries`, () => {
        const list = getNestedValue(localeData[code], 'instruments.list');
        expect(list).toBeDefined();
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBe(128);
      });
    }
  });

  // ----------------------------------------------------------
  // 6. Identical key structure (same nesting shape) across locales
  // ----------------------------------------------------------
  describe('identical key structure across all locales', () => {
    for (const code of nonEnglishLocales) {
      it(`${code} should have the same nesting structure as en.json`, () => {
        // Compare structures; on mismatch Jest's diff shows the divergence
        expect(structureSignature(localeData[code])).toEqual(structureSignature(referenceLocale));
      });
    }
  });
});
