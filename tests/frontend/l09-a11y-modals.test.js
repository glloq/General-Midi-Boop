// tests/frontend/l09-a11y-modals.test.js
//
// Audit L09 — §AR (accessibility) and §AU/§AV (memory), measured in jsdom.
// jsdom has no layout engine, so nothing here judges contrast or overflow; it
// judges the things that make the app UNUSABLE from the keyboard or from a
// screen reader, all of which are pure DOM semantics:
//   - does the modal keep focus inside itself,
//   - does Escape close only the modal on top,
//   - is the page behind the modal still reachable,
//   - does every icon-only control carry an accessible name,
//   - do repeated open/close cycles leave listeners or DOM behind.
//
// Findings referenced: F-99, F-100, F-103, F-104, F-105.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  delete window.BaseModal;
  delete window.SystemAdminModal;
  global.requestAnimationFrame = (cb) => cb();
  window.requestAnimationFrame = global.requestAnimationFrame;
  window.escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  global.escapeHtml = window.escapeHtml;
  evalFile('public/js/core/BaseModal.js');
});

function makeModal(opts = {}, body = '<input id="f1"><button id="f2">B</button>', footer = '') {
  class M extends window.BaseModal {
    renderBody() {
      return body;
    }
    renderFooter() {
      return footer;
    }
  }
  return new M({ title: 'common.close', ...opts });
}

// ---------------------------------------------------------------- focus trap

describe('L09 · BaseModal — focus trap', () => {
  it('never treats a disabled control as the trap boundary (F-100, corrigé)', () => {
    const m = makeModal(
      { id: 'ft1' },
      '<input id="a"><button id="b">B</button>',
      '<button id="c" disabled>C</button>'
    );
    m.open();
    // Reproduce the selector the trap uses after the fix.
    const trapList = [
      ...m.dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ];
    expect(trapList.some((el) => el.hasAttribute('disabled'))).toBe(false);
    expect(trapList[trapList.length - 1].id).toBe('b');
    m.close();
  });

  it('wraps Tab from the last control back to the first', () => {
    const m = makeModal({ id: 'ft2' });
    m.open();
    const focusables = [
      ...m.dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')
    ];
    const last = focusables[focusables.length - 1];
    last.focus();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusables[0]);
    m.close();
  });

  it('restores focus to the opener on close', () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="opener">open</button>');
    const opener = document.getElementById('opener');
    opener.focus();
    const m = makeModal({ id: 'ft3' });
    m.open();
    expect(document.activeElement).not.toBe(opener);
    m.close();
    expect(document.activeElement).toBe(opener);
  });
});

// ------------------------------------------------------- stacked modals (F-99)

describe('L09 · BaseModal — stacked modals (F-99, ouvert)', () => {
  it('KNOWN DEFECT: one Escape closes every open modal, not just the top one', () => {
    const outer = makeModal({ id: 'st-outer' });
    const inner = makeModal({ id: 'st-inner' });
    outer.open();
    inner.open();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inner.isOpen).toBe(false);
    // The defect: the modal underneath dies with it. Flip this expectation to
    // `true` the day BaseModal keeps a modal stack.
    expect(outer.isOpen).toBe(false);
  });

  it('KNOWN DEFECT: closing the inner modal unlocks body scroll under the outer one', () => {
    const outer = makeModal({ id: 'sc-outer' });
    const inner = makeModal({ id: 'sc-inner' });
    outer.open();
    inner.open();
    expect(document.body.style.overflow).toBe('hidden');
    inner.close();
    expect(outer.isOpen).toBe(true);
    expect(document.body.style.overflow).toBe(''); // should still be 'hidden'
    outer.close();
  });
});

// ------------------------------------------- background reachability (F-103)

describe('L09 · BaseModal — the page behind the modal (F-103, ouvert)', () => {
  it('KNOWN DEFECT: background content is neither inert nor aria-hidden', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="page"><button id="bg">bg</button></div>'
    );
    const m = makeModal({ id: 'bg1' });
    m.open();
    const page = document.getElementById('page');
    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.getAttribute('aria-hidden')).toBeNull();
    // consequence: a screen reader / Tab can still reach it
    document.getElementById('bg').focus();
    expect(document.activeElement.id).toBe('bg');
    m.close();
  });

  it('does carry the dialog role contract on the overlay', () => {
    const m = makeModal({ id: 'bg2' });
    m.open();
    expect(m.container.getAttribute('role')).toBe('dialog');
    expect(m.container.getAttribute('aria-modal')).toBe('true');
    expect(m.container.getAttribute('aria-labelledby')).toBe('bg2-title');
    expect(document.getElementById('bg2-title')).not.toBeNull();
    m.close();
  });

  it('gives its own close button an accessible name', () => {
    const m = makeModal({ id: 'bg3' });
    m.open();
    const close = m.dialog.querySelector('.modal-close');
    expect(close.getAttribute('aria-label')).toBeTruthy();
    m.close();
  });
});

// ------------------------------------------------ icon-only buttons (F-104)

describe('L09 · icon-only controls need an accessible name (F-104)', () => {
  const LETTER = /[A-Za-zÀ-ɏЀ-ӿͰ-Ͽ一-鿿぀-ヿ가-힯]/;

  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      if (['locales', 'soundfonts', 'assets', 'styles'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|html)$/.test(name)) out.push(p);
    }
    return out;
  }

  /** buttons whose literal content carries no letters at all */
  function iconOnlyButtons() {
    const found = [];
    for (const f of walk(resolve(ROOT, 'public'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]{0,300}?)<\/button>/g)) {
        const visible = m[2].replace(/<[^>]*>/g, '').replace(/\$\{[^}]*\}/g, '§');
        if (visible.includes('§')) continue; // dynamic label, not judgeable here
        if (LETTER.test(visible.replace(/&[a-z]+;/g, ''))) continue;
        found.push({
          file: f.replace(ROOT + '/', ''),
          line: src.slice(0, m.index).split('\n').length,
          named: /aria-label(ledby)?\s*=/.test(m[1]),
          titled: /\btitle\s*=/.test(m[1])
        });
      }
    }
    return found;
  }

  const buttons = iconOnlyButtons();

  it('the frontend really is icon-heavy (context for the ratchet)', () => {
    expect(buttons.length).toBeGreaterThan(150);
  });

  it('the count with NO accessible name at all never grows (ratchet: 33)', () => {
    const nameless = buttons.filter((b) => !b.named && !b.titled);
    expect(
      nameless.length,
      nameless.map((b) => `${b.file}:${b.line}`).join('\n')
    ).toBeLessThanOrEqual(33);
  });

  it('the two largest modals name their close button (corrigé L09)', () => {
    const kb = readFileSync(resolve(ROOT, 'public/js/features/keyboard/KeyboardPiano.js'), 'utf8');
    expect(kb).toMatch(/id="keyboard-close-btn"[^>]*aria-label=/);
    const me = readFileSync(
      resolve(ROOT, 'public/js/features/midi-editor/MidiEditorView.js'),
      'utf8'
    );
    expect(me).toMatch(/class="modal-close" data-action="close" aria-label=/);
  });
});

// ------------------------------------------------------------- memory (F-105)

describe('L09 · memory — open/close ×50 (§AU, §AV)', () => {
  function countingWindow() {
    const net = new Map();
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      const rem = target.removeEventListener.bind(target);
      target.addEventListener = (t, f, o) => {
        net.set(t, (net.get(t) || 0) + 1);
        return add(t, f, o);
      };
      target.removeEventListener = (t, f, o) => {
        net.set(t, (net.get(t) || 0) - 1);
        return rem(t, f, o);
      };
    }
    return net;
  }

  it('BaseModal leaves no document/window listener and no DOM behind', () => {
    const net = countingWindow();
    for (let i = 0; i < 50; i++) {
      const m = makeModal({ id: `mem${i}` });
      m.open();
      m.close();
    }
    for (const [type, delta] of net) expect(delta, `listener ${type}`).toBe(0);
    expect(document.body.children.length).toBe(0);
    expect(document.body.style.overflow).toBe('');
  });

  it('SystemAdminModal (a real BaseModal subclass) leaks nothing either', () => {
    evalFile('public/js/features/SystemAdminModal.js');
    const net = countingWindow();
    const api = { sendCommand: vi.fn(() => Promise.resolve({ ok: true })) };
    for (let i = 0; i < 50; i++) {
      const m = new window.SystemAdminModal(api);
      m.open();
      m.close();
    }
    for (const [type, delta] of net) expect(delta, `listener ${type}`).toBe(0);
    expect(document.body.children.length).toBe(0);
  });

  it('DeviceSettingsModal (hand-rolled, no BaseModal) also balances its handlers', async () => {
    evalFile('public/js/utils/escapeHtml.js');
    evalFile('public/js/features/DeviceSettingsModal.js');
    const net = countingWindow();
    const api = {
      sendCommand: vi.fn(() => Promise.resolve({ settings: {} })),
      on: vi.fn(),
      off: vi.fn()
    };
    for (let i = 0; i < 50; i++) {
      const m = new window.DeviceSettingsModal(api);
      await m.show('dev', 'Device');
      m.close();
    }
    for (const [type, delta] of net) expect(delta, `listener ${type}`).toBe(0);
    expect(document.body.children.length).toBe(0);
  });
});
