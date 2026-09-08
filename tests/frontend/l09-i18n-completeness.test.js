// tests/frontend/l09-i18n-completeness.test.js
//
// Audit L09 — §AS. `tests/audit-i18n.test.js` already proves STRUCTURAL parity
// (2 737 keys × 28 locales, 0 missing, 0 extra). Structural parity is not
// translation: a key whose value is byte-identical to the English reference is
// shipped untranslated even though it "exists".
//
// This suite measures actual translation coverage per locale and ratchets it,
// so a locale can never silently regress and the "28 languages" claim stays
// backed by a number instead of a file count.
//
// Estimator (documented in docs/audit/2026-09-07/09_FRONTEND_UX.md §2):
//   floor   = (total - identical) / total          — every identical value
//             counted as untranslated (pessimistic, this is what the
//             2026-08-22 audit reported)
//   ceiling = floor + legitimately-identical / total
//             TECH  : the value is only technical tokens / digits / symbols /
//                     emoji / standard GM drum abbreviations — it legitimately
//                     stays in Latin script in EVERY locale
//             LOAN  : Latin-script locales only, a shared musical/technical
//                     loanword that may legitimately be identical
//   The published figure is the midpoint, the margin is half the band width.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '..', '..', 'public', 'locales');

const NON_LATIN = ['ru', 'uk', 'el', 'ja', 'ko', 'zh-CN', 'th', 'hi', 'bn'];

const TECH = new Set([
  'midi',
  'usb',
  'ble',
  'bluetooth',
  'wifi',
  'wi-fi',
  'rtp',
  'applemidi',
  'osc',
  'mqtt',
  'artnet',
  'art-net',
  'sacn',
  'e1.31',
  'dmx',
  'gpio',
  'uart',
  'spi',
  'i2c',
  'led',
  'leds',
  'ws2812',
  'neopixel',
  'wled',
  'tasmota',
  'esphome',
  'hue',
  'philips',
  'qlc+',
  'qlc',
  'touchdesigner',
  'raspberry',
  'pi',
  'rgb',
  'rgbw',
  'http',
  'https',
  'rest',
  'tcp',
  'udp',
  'ip',
  'ipv4',
  'mac',
  'url',
  'id',
  'uuid',
  'api',
  'json',
  'xml',
  'csv',
  'sf2',
  'sfz',
  'soundfont',
  'gm',
  'gm2',
  'gs',
  'xg',
  'sysex',
  'nrpn',
  'rpn',
  'pb',
  'cc',
  'bpm',
  'ms',
  'hz',
  'khz',
  'db',
  'rssi',
  'azerty',
  'qwerty',
  'ok',
  'on',
  'off',
  'tab',
  'edit',
  'wind',
  'drum',
  'tap',
  'pwm',
  'ssid',
  'lan',
  'wlan',
  'dhcp',
  'ssh',
  'cpu',
  'ram',
  'sd',
  'os',
  'ui',
  'pdf',
  'png',
  'svg',
  'ntp',
  'mdns',
  'dns',
  'vpn',
  'ac',
  'dc',
  'v',
  'ma',
  'a',
  'w',
  'fps',
  'px',
  'hh',
  'ch',
  'vel',
  'vol',
  'min',
  'max',
  'num',
  'no.',
  'msgs',
  'sec',
  's',
  'm',
  'h',
  'ko',
  'mo',
  'go',
  'kb',
  'mb',
  'gb',
  'ms.',
  'set',
  'din',
  'trs',
  'jack',
  'xlr',
  'ttl',
  'rx',
  'tx',
  'sn',
  'fw',
  'hw',
  'sw',
  'bt',
  'do',
  're',
  'ré',
  'mi',
  'fa',
  'sol',
  'la',
  'si',
  'ti',
  'c',
  'd',
  'e',
  'f',
  'g',
  'b',
  'x',
  'y',
  'z',
  'n',
  't',
  'staccato',
  'legato',
  'glissando',
  'tremolo',
  'vibrato',
  'portamento',
  'crescendo',
  'arpeggio',
  'ostinato',
  'ackick',
  'kick',
  'stick',
  'snare',
  'clap',
  'esnare',
  'lflrtom',
  'clhh',
  'hflrtom',
  'pdlhh',
  'lowtom',
  'ophh',
  'lmtom',
  'hmtom',
  'crash',
  'crash1',
  'hitom',
  'ride',
  'ride1',
  'china',
  'rdbell',
  'tamb',
  'splash',
  'cowbell',
  'crash2',
  'vibra',
  'ride2',
  'hibong',
  'lobong',
  'mtcnga',
  'opcnga',
  'locnga',
  'hitimb',
  'lotimb',
  'hiago',
  'loago',
  'cabasa',
  'maraca',
  'swhstl',
  'lwhstl',
  'sguiro',
  'lguiro',
  'claves',
  'hiwdbk',
  'lowdbk',
  'mtcuic',
  'opcuic',
  'mttri',
  'optri',
  'ctrl',
  'multi',
  'universe',
  'subnet',
  'port',
  'segment'
]);

const LOAN = new Set([
  'piano',
  'tempo',
  'solo',
  'pan',
  'modulation',
  'expression',
  'test',
  'instrument',
  'instruments',
  'transposition',
  'version',
  'format',
  'formats',
  'import',
  'export',
  'note',
  'notes',
  'volume',
  'interface',
  'mode',
  'position',
  'configuration',
  'total',
  'application',
  'options',
  'option',
  'filter',
  'filtre',
  'standard',
  'normal',
  'type',
  'global',
  'local',
  'audio',
  'video',
  'stereo',
  'mono',
  'master',
  'pulse',
  'flash',
  'effect',
  'effets',
  'reset',
  'stop',
  'pause',
  'play',
  'start',
  'signal',
  'scanner',
  'firmware',
  'action',
  'accent',
  'chorus',
  'reverb',
  'delay',
  'sustain',
  'attack',
  'release',
  'decay',
  'tension',
  'contact',
  'base',
  'sequence',
  'panel',
  'console',
  'micro',
  'metronome',
  'gamme',
  'octave',
  'tonic',
  'accord',
  'texture',
  'harmonica',
  'banjo',
  'guitare',
  'guitar',
  'violin',
  'viola',
  'cello',
  'trombone',
  'trumpet',
  'clarinet',
  'saxophone',
  'flute',
  'tuba',
  'timbre',
  'tone',
  'tonal',
  'tutorial',
  'info',
  'description',
  'notation',
  'instant',
  'table',
  'menu',
  'canal',
  'general',
  'service',
  'status',
  'sensor',
  'moderato',
  'allegro',
  'adagio',
  'presto',
  'de'
]);

const LETTER = /[A-Za-zÀ-ɏ]/;

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      Object.assign(out, flatten(v, full));
    else if (typeof v === 'string') out[full] = v;
    else if (Array.isArray(v)) out[full] = JSON.stringify(v);
  }
  return out;
}

/** @returns {'TECH'|'LOAN'|'TEXT'} */
export function classify(value, locale) {
  if (!LETTER.test(value)) return 'TECH';
  const toks = value
    .split(/[^A-Za-zÀ-ɏ+#.]+/)
    .filter((t) => t && LETTER.test(t))
    .map((t) => t.toLowerCase().replace(/\.+$/, ''));
  if (toks.every((t) => TECH.has(t))) return 'TECH';
  if (!NON_LATIN.includes(locale) && toks.every((t) => TECH.has(t) || LOAN.has(t))) return 'LOAN';
  return 'TEXT';
}

const locales = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))
  .sort();
const data = Object.fromEntries(
  locales.map((l) => [
    l,
    flatten(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${l}.json`), 'utf-8')))
  ])
);
const en = data.en;
const keys = Object.keys(en);
const nonEn = locales.filter((l) => l !== 'en');

function measure(locale, keySet = keys) {
  let identical = 0;
  let legit = 0;
  for (const k of keySet) {
    if (data[locale][k] !== en[k]) continue;
    identical++;
    if (classify(en[k], locale) !== 'TEXT') legit++;
  }
  const total = keySet.length;
  const floor = ((total - identical) / total) * 100;
  const ceiling = ((total - identical + legit) / total) * 100;
  return {
    identical,
    legit,
    floor,
    ceiling,
    mid: (floor + ceiling) / 2,
    margin: (ceiling - floor) / 2
  };
}

// Measured 2026-09-07 at commit 8dc170e. Floor of the published midpoint,
// rounded DOWN to the nearest whole point: a locale may improve, never regress.
const RATCHET = {
  fr: 91,
  eo: 88,
  bn: 87,
  th: 87,
  es: 85,
  de: 84,
  it: 82,
  vi: 80,
  id: 79,
  pl: 78,
  cs: 78,
  sv: 77,
  pt: 77,
  fi: 77,
  no: 77,
  hu: 77,
  nl: 77,
  tr: 77,
  da: 77,
  uk: 76,
  ja: 76,
  ko: 76,
  'zh-CN': 76,
  ru: 76,
  el: 75,
  tl: 72,
  hi: 71
};

describe('L09 · i18n — reference corpus', () => {
  it('measures 28 locales against a 2 737-key English reference', () => {
    expect(locales).toHaveLength(28);
    expect(keys.length).toBe(2737);
  });
});

describe('L09 · i18n — real translation coverage per locale (ratchet)', () => {
  for (const l of nonEn) {
    it(`${l} stays at or above ${RATCHET[l]} %`, () => {
      const m = measure(l);
      expect(Math.round(m.mid)).toBeGreaterThanOrEqual(RATCHET[l]);
      // the band must stay narrow enough for the figure to mean something
      expect(m.margin).toBeLessThan(6);
    });
  }
});

describe('L09 · i18n — the estimator itself', () => {
  it('classifies pure technical tokens as legitimately identical everywhere', () => {
    for (const v of ['MIDI', '1/16T', 'BPM', 'RSSI', 'AZERTY', 'USB', '🔊 GM', 'Crash1']) {
      expect(classify(v, 'ja')).toBe('TECH');
    }
  });

  it('does NOT excuse ordinary prose in a non-Latin-script locale', () => {
    for (const v of ['Add a rule', 'No files found', 'Turn off', 'Solid colour']) {
      expect(classify(v, 'ja')).toBe('TEXT');
    }
  });

  it('excuses a shared loanword only for Latin-script locales', () => {
    expect(classify('Piano', 'it')).toBe('LOAN');
    expect(classify('Piano', 'ja')).toBe('TEXT');
  });
});

describe('L09 · i18n — the lighting feature ships untranslated (F-96)', () => {
  const lightingKeys = keys.filter(
    (k) => k.startsWith('lighting.') || k.startsWith('instrumentSettings.lumiere')
  );

  it('accounts for 358 of the 2 737 keys (13.1 % of the interface)', () => {
    expect(lightingKeys.length).toBe(358);
  });

  it('at most 17 locales have ZERO lighting key translated', () => {
    const zero = nonEn.filter((l) => lightingKeys.every((k) => data[l][k] === en[k]));
    expect(zero.length).toBeLessThanOrEqual(17);
  });

  it('excluding lighting lifts every locale above 75 %', () => {
    const rest = keys.filter((k) => !lightingKeys.includes(k));
    for (const l of nonEn) {
      expect(measure(l, rest).mid, `${l} hors lighting`).toBeGreaterThan(75);
    }
  });
});
