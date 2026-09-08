// tests/frontend/l09-css-contracts.test.js
//
// Audit L09 — §AT (CSS) and the theming half of §AR. jsdom cannot lay a page
// out, so this suite checks the things that are decidable from the source and
// that silently break rendering:
//   - a `var(--x)` with no fallback whose custom property is never declared
//     makes the whole declaration invalid at computed-value time, so the
//     property falls back to its inherited/initial value (usually transparent),
//   - a token declared for the light theme but not for the dark one keeps its
//     light value under `body.dark-mode`,
//   - the WCAG contrast of the token pairs the interface actually uses.
//
// Findings referenced: F-101, F-102, F-106.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname2, '..', '..');
const STYLES = path.join(ROOT, 'public', 'styles');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['locales', 'soundfonts', 'assets'].includes(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

const ALL_SOURCE = walk(path.join(ROOT, 'public'))
  .map((f) => fs.readFileSync(f, 'utf-8'))
  .join('\n');

const declared = new Set([...ALL_SOURCE.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
const uses = [...ALL_SOURCE.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,|\))/g)];

describe('L09 · CSS custom properties (F-101)', () => {
  it('no var() without a fallback references an undeclared token', () => {
    const broken = [
      ...new Set(uses.filter((m) => m[2] === ')' && !declared.has(m[1])).map((m) => m[1]))
    ];
    expect(broken, `tokens jamais déclarés et sans valeur de repli : ${broken.join(', ')}`).toEqual(
      []
    );
  });

  it('keyboard.css no longer emits bare var(--bg-medium|--bg-light|--bg-dark)', () => {
    const css = fs.readFileSync(path.join(STYLES, 'keyboard.css'), 'utf-8');
    expect(css).not.toMatch(/var\(\s*--bg-(medium|light|dark)\s*\)/);
  });
});

describe('L09 · dark theme token parity (F-102)', () => {
  const variables = fs.readFileSync(path.join(STYLES, 'variables.css'), 'utf-8');

  function block(re) {
    const m = variables.match(re);
    return m ? m[0] : '';
  }
  const root = block(/:root\s*\{[\s\S]*?\n\}/);
  const dark = block(/body\.dark-mode\s*\{[\s\S]*?\n\}/);
  const names = (src) => new Set([...src.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));

  // Tokens that carry a THEME-DEPENDENT surface or text colour: if :root sets
  // them and body.dark-mode does not, the dark theme inherits a light value.
  const THEME_TOKENS = [
    '--bg-primary',
    '--bg-primary-flat',
    '--bg-secondary',
    '--bg-tertiary',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--border-color',
    '--card-bg'
  ];

  it('every surface/text token declared in :root is re-declared for dark mode', () => {
    const inRoot = names(root);
    const inDark = names(dark);
    const missing = THEME_TOKENS.filter((t) => inRoot.has(t) && !inDark.has(t));
    expect(missing, `tokens clairs conservés en thème sombre : ${missing.join(', ')}`).toEqual([]);
  });

  it('the prefers-color-scheme block covers the same surfaces', () => {
    const media = block(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/);
    expect(names(media).has('--bg-primary-flat')).toBe(true);
  });
});

describe('L09 · WCAG contrast of the shipped token pairs (F-106)', () => {
  const hex = (h) => {
    h = h.replace('#', '');
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
  };
  const lum = (rgb) =>
    rgb
      .map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      })
      .reduce((a, c, i) => a + [0.2126, 0.7152, 0.0722][i] * c, 0);
  const ratio = (a, b) => {
    const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it('body text passes AA in both themes', () => {
    expect(ratio('#1a1040', '#eae4f7')).toBeGreaterThanOrEqual(4.5); // clair
    expect(ratio('#e0e0e0', '#1a1a1a')).toBeGreaterThanOrEqual(4.5); // sombre
  });

  it('KNOWN DEFECT: --text-muted fails AA on the surfaces it is used on', () => {
    expect(ratio('#8078a0', '#eae4f7')).toBeLessThan(4.5); // clair, fond page
    expect(ratio('#718096', '#2d3748')).toBeLessThan(4.5); // sombre, fond carte
  });

  it('KNOWN DEFECT: the routing status palette fails AA as text on white', () => {
    expect(ratio('#27ae60', '#ffffff')).toBeLessThan(4.5); // --status-ok
    expect(ratio('#f39c12', '#ffffff')).toBeLessThan(4.5); // --status-warning
  });

  it('the dark-mode regression that F-102 fixed stays fixed', () => {
    // --bg-primary-flat used to keep its light value under body.dark-mode while
    // --text-primary flipped to #e0e0e0 → 1.06:1, invisible text.
    expect(ratio('#e0e0e0', '#eae4f7')).toBeLessThan(1.5);
    const variables = fs.readFileSync(path.join(STYLES, 'variables.css'), 'utf-8');
    const dark = variables.match(/body\.dark-mode\s*\{[\s\S]*?\n\}/)[0];
    const value = dark.match(/--bg-primary-flat\s*:\s*([^;]+);/)[1].trim();
    expect(ratio('#e0e0e0', value)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('L09 · focus visibility safety net (§AR)', () => {
  it('accessibility-focus.css is the LAST stylesheet loaded', () => {
    const links = [...INDEX.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(links[links.length - 1]).toBe('styles/accessibility-focus.css');
  });

  it('it reasserts a focus ring for the generic interactive elements', () => {
    const css = fs.readFileSync(path.join(STYLES, 'accessibility-focus.css'), 'utf-8');
    for (const sel of [
      'button:focus-visible',
      'input:focus-visible',
      '[role="button"]:focus-visible'
    ]) {
      expect(css).toContain(sel);
    }
    expect(css).toMatch(/outline:\s*2px solid[^;]*!important/);
  });

  it('the skip link exists and targets a real element', () => {
    expect(INDEX).toMatch(
      /class="sr-only sr-only-focusable"[^>]*href="#app"|href="#app"[^>]*class="sr-only sr-only-focusable"/
    );
    expect(INDEX).toMatch(/id="app"/);
  });
});
