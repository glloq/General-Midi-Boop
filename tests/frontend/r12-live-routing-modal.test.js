// tests/frontend/r12-live-routing-modal.test.js
//
// Audit R12 — F-138: "the live MIDI routing is entirely unreachable".
//
// Fifteen routing commands were registered, schema-validated, unit-tested and
// documented, and NONE of them had a caller in the SPA: there was no way to
// create a source → destination route from the interface.
//
// This suite pins the *surface* that closes the gap:
//   - it dispatches the real backend commands (no invented ones),
//   - it stays inside the accessibility contract L09 measured (dialog role,
//     Escape, focus trap, an accessible name on every field and every button),
//   - it leaks neither DOM nor document listeners over 50 open/close cycles,
//   - every i18n key it renders exists in all 28 locales.
//
// The proof that the surface is *reachable from the assembled application* is
// the browser scenario `tests/e2e/specs/05-live-routing.spec.mjs`; a unit test
// can only prove the component exists.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();
const LOCALES = join(ROOT, 'public', 'locales');
const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8'));

/** Resolve a dotted key inside a locale object. */
function lookup(obj, key) {
  return key.split('.').reduce((a, s) => (a && typeof a === 'object' ? a[s] : undefined), obj);
}

/** Minimal i18n that behaves like the real one for t()/tHtml(). */
function installI18n(missing) {
  const escape = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const t = (key, params = {}) => {
    const value = lookup(en, key);
    if (typeof value !== 'string') {
      missing.push(key);
      return key;
    }
    return value.replace(/\{(\w+)\}/g, (m, n) =>
      Object.hasOwn(params, n) ? String(params[n]) : m
    );
  };
  const i18n = {
    t,
    tHtml: (key, params = {}) => {
      const escaped = {};
      for (const k of Object.keys(params)) escaped[k] = escape(params[k]);
      return t(key, escaped);
    },
    onLocaleChange: () => () => {}
  };
  window.i18n = i18n;
  global.i18n = i18n;
  return i18n;
}

/** A fake BackendAPIClient recording every command it is handed. */
function makeApi(overrides = {}) {
  const calls = [];
  const responses = Object.assign(
    {
      device_list: {
        devices: [
          { id: 'usb_keys', name: 'USB Keys', type: 'usb', input: true, output: false },
          // Shaped like a real soft virtual instrument: output-only.
          {
            id: 'virtual_piano',
            name: 'Piano <script>',
            type: 'virtual',
            input: false,
            output: true
          }
        ]
      },
      route_list: {
        routes: [
          {
            id: 'route_1',
            source: 'usb_keys',
            destination: 'virtual_piano',
            channelMap: { 0: 3 },
            filter: { types: ['noteon'] },
            enabled: true
          }
        ]
      }
    },
    overrides
  );
  return {
    calls,
    sendCommand: vi.fn((command, data) => {
      calls.push({ command, data });
      const r = responses[command];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r === undefined ? { success: true } : r);
    })
  };
}

/** Commands sent, in order. */
const sent = (api) => api.calls.map((c) => c.command);
/** Last payload for a command. */
const payload = (api, command) => {
  const hits = api.calls.filter((c) => c.command === command);
  return hits.length ? hits[hits.length - 1].data : undefined;
};

let missingKeys;

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  delete window.BaseModal;
  delete window.LiveRoutingModal;
  delete window.installLiveRoutingLauncher;
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
  missingKeys = [];
  installI18n(missingKeys);
  evalFile('public/js/core/BaseModal.js');
  evalFile('public/js/features/routing/LiveRoutingModal.js');
});

afterEach(() => {
  delete window.i18n;
  delete global.i18n;
});

/** Open the modal and let its two initial commands settle. */
async function openModal(api) {
  const modal = new window.LiveRoutingModal(api);
  modal.open();
  await vi.waitFor(() => expect(sent(api)).toContain('route_list'));
  return modal;
}

// ───────────────────────────────────────────────────── reachability of the API

describe('R12 · LiveRoutingModal — the routing commands finally have a caller', () => {
  it('loads devices and routes as soon as it opens', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    expect(sent(api)).toEqual(['device_list', 'route_list']);
    expect(modal.routes).toHaveLength(1);
    modal.close();
  });

  it('creates a route from the two selects (route_create) — the F-138 gap', async () => {
    const api = makeApi();
    const modal = await openModal(api);

    // A user picks a source and a destination and clicks the button.
    modal.$('#lrt-source').value = 'usb_keys';
    modal.$('#lrt-destination').value = 'virtual_piano';
    modal.$('#lrt-create').click();

    // and the list is re-read so the new route shows up
    await vi.waitFor(() =>
      expect(sent(api).filter((c) => c === 'route_list').length).toBeGreaterThan(1)
    );
    expect(payload(api, 'route_create')).toEqual({
      source: 'usb_keys',
      destination: 'virtual_piano',
      enabled: true
    });
    modal.close();
  });

  it('disables creation, and says so, when no MIDI device is available', async () => {
    const api = makeApi({ device_list: { devices: [] } });
    const modal = await openModal(api);
    await vi.waitFor(() => expect(modal.$('#lrt-create').disabled).toBe(true));
    expect(modal.$('#lrt-no-devices').hidden).toBe(false);
    modal.$('#lrt-create').click(); // a disabled button dispatches nothing
    await Promise.resolve();
    expect(sent(api)).not.toContain('route_create');
    modal.close();
  });

  it('offers every device in both selects, direction-appropriate ones first', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    // `virtual_piano` is output-only on the backend (input:false) but must stay
    // selectable as a source: the direction flags are a hint, and route_create
    // accepts any pair.
    const sourceOptions = [...modal.$$('#lrt-source option')].map((o) => o.value);
    expect(sourceOptions).toEqual(['usb_keys', 'virtual_piano']);
    const groups = [...modal.$$('#lrt-source optgroup')].map((g) => g.label);
    expect(groups).toEqual([en.liveRouting.groupInputs, en.liveRouting.groupOther]);
    // `usb_keys` is input-only, so the destination select groups it second.
    const destGroups = [...modal.$$('#lrt-destination optgroup')].map((g) => g.label);
    expect(destGroups).toEqual([en.liveRouting.groupOutputs, en.liveRouting.groupOther]);
    modal.close();
  });

  it('refuses to create a route when a select carries no value', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    // Simulate the degenerate case the guard exists for: a select whose value
    // is empty even though the button is enabled.
    modal.$('#lrt-source').innerHTML = '';
    modal.$('#lrt-create').click();
    await Promise.resolve();
    expect(sent(api)).not.toContain('route_create');
    expect(modal.$('#lrt-status').textContent).toBe(en.liveRouting.pickBoth);
    modal.close();
  });

  it('toggles a route on and off (route_enable)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const cb = modal.$('.lrt-enabled');
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(sent(api)).toContain('route_enable'));
    expect(payload(api, 'route_enable')).toEqual({ routeId: 'route_1', enabled: false });
    modal.close();
  });

  it('deletes a route only after a confirmation (route_delete)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const btn = modal.$('[data-lrt-action="delete"]');

    window.confirm = vi.fn(() => false);
    btn.click();
    await Promise.resolve();
    expect(sent(api)).not.toContain('route_delete');

    window.confirm = vi.fn(() => true);
    btn.click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_delete'));
    expect(payload(api, 'route_delete')).toEqual({ routeId: 'route_1' });
    modal.close();
  });

  it('duplicates, inspects, exports and tests a route', async () => {
    const api = makeApi({
      route_test: { success: true, destination: 'virtual_piano', note: 60, channel: 0 },
      route_export: { route: { id: 'route_1', source: 'usb_keys', destination: 'virtual_piano' } },
      route_info: { route: { id: 'route_1' } }
    });
    const modal = await openModal(api);

    modal.$('[data-lrt-action="duplicate"]').click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_duplicate'));

    modal.$('[data-lrt-action="test"]').click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_test'));
    expect(payload(api, 'route_test')).toEqual({ routeId: 'route_1' });

    modal.$('[data-lrt-action="info"]').click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_info'));

    modal.$('[data-lrt-action="export"]').click();
    await vi.waitFor(() => expect(modal.$('#lrt-import-json').value).toContain('usb_keys'));
    expect(JSON.parse(modal.$('#lrt-import-json').value).source).toBe('usb_keys');
    modal.close();
  });

  it('imports a pasted route and drops the exported id (route_import)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('#lrt-import-json').value = JSON.stringify({
      id: 'route_1',
      source: 'a',
      destination: 'b'
    });
    modal.$('#lrt-import').click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_import'));
    expect(payload(api, 'route_import')).toEqual({ route: { source: 'a', destination: 'b' } });
    modal.close();
  });

  it('rejects invalid JSON before it reaches the backend', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('#lrt-import-json').value = '{not json';
    modal.$('#lrt-import').click();
    await Promise.resolve();
    expect(sent(api)).not.toContain('route_import');
    expect(modal.$('#lrt-status').textContent).toBe(en.liveRouting.importInvalid);
    modal.close();
  });

  it('clears every route behind a confirmation (route_clear_all)', async () => {
    const api = makeApi({ route_clear_all: { success: true, deleted: 3 } });
    const modal = await openModal(api);
    window.confirm = vi.fn(() => true);
    modal.$('#lrt-clear-all').click();
    await vi.waitFor(() => expect(modal.$('#lrt-status').textContent).toContain('3'));
    expect(sent(api)).toContain('route_clear_all');
    modal.close();
  });

  it('edits the channel map of the selected route (channel_map)', async () => {
    const api = makeApi();
    const modal = await openModal(api);

    modal.$('[data-lrt-action="edit"]').click();
    expect(modal.$('#lrt-editor').hidden).toBe(false);
    // The stored map {0: 3} is reflected in the editor…
    expect(modal.$('#lrt-chmap-0').value).toBe('3');
    // …and a second channel can be added.
    modal.$('#lrt-chmap-5').value = '9';
    modal.$('#lrt-chmap-save').click();

    await vi.waitFor(() => expect(sent(api)).toContain('channel_map'));
    expect(payload(api, 'channel_map')).toEqual({
      routeId: 'route_1',
      mapping: { 0: 3, 5: 9 }
    });
    modal.close();
  });

  it('clears the channel map with an empty mapping', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('[data-lrt-action="edit"]').click();
    modal.$('#lrt-chmap-reset').click();
    await vi.waitFor(() => expect(sent(api)).toContain('channel_map'));
    expect(payload(api, 'channel_map')).toEqual({ routeId: 'route_1', mapping: {} });
    modal.close();
  });

  it('sets and clears the filter (filter_set / filter_clear)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('[data-lrt-action="edit"]').click();

    // The stored filter {types:['noteon']} is reflected…
    expect(modal.$('#lrt-filter-type-0').checked).toBe(true);
    // …and the operator narrows it further.
    modal.$('#lrt-filter-type-1').checked = true;
    modal.$('#lrt-note-min').value = '48';
    modal.$('#lrt-note-max').value = '72';
    modal.$('#lrt-vel-min').value = '10';
    modal.$('#lrt-filter-save').click();

    await vi.waitFor(() => expect(sent(api)).toContain('filter_set'));
    expect(payload(api, 'filter_set')).toEqual({
      routeId: 'route_1',
      filter: {
        types: ['noteon', 'noteoff'],
        noteRange: { min: 48, max: 72 },
        velocityRange: { min: 10, max: 127 }
      }
    });

    modal.$('#lrt-filter-clear').click();
    await vi.waitFor(() => expect(sent(api)).toContain('filter_clear'));
    expect(payload(api, 'filter_clear')).toEqual({ routeId: 'route_1' });
    modal.close();
  });

  it('never sends a routing command the backend does not register', async () => {
    // The registry of RoutingCommands.js, read from the source of truth.
    const src = readFileSync(resolve(ROOT, 'src/api/commands/RoutingCommands.js'), 'utf8');
    const registered = new Set(
      [...src.matchAll(/registry\.register\('([a-z0-9_]+)'/g)].map((m) => m[1])
    );
    const modalSrc = readFileSync(
      resolve(ROOT, 'public/js/features/routing/LiveRoutingModal.js'),
      'utf8'
    );
    const used = [...modalSrc.matchAll(/_send\('([a-z0-9_]+)'/g)].map((m) => m[1]);
    const unknown = used.filter((c) => c !== 'device_list' && !registered.has(c));
    expect(unknown, `commands with no backend handler: ${unknown.join(', ')}`).toEqual([]);
    expect(used.length).toBeGreaterThan(10);
  });

  it('reports a backend failure instead of throwing out of the click handler', async () => {
    const api = makeApi({ route_create: new Error('boom') });
    const modal = await openModal(api);
    modal.$('#lrt-source').value = 'usb_keys';
    modal.$('#lrt-destination').value = 'virtual_piano';
    modal.$('#lrt-create').click();
    await vi.waitFor(() => expect(modal.$('#lrt-status').textContent).toContain('boom'));
    modal.close();
  });
});

// ─────────────────────────────────────────────────────────────── XSS / escaping

describe('R12 · LiveRoutingModal — untrusted device names', () => {
  it('escapes a device name carrying markup (tHtml, not t, into innerHTML)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const path = modal.$('.lrt-route-path');
    expect(path.textContent).toContain('Piano <script>');
    expect(modal.$('#lrt-routes').innerHTML).not.toContain('<script>');
    expect(modal.dialog.querySelector('script')).toBeNull();
    modal.close();
  });

  it('escapes a hostile route id used as a DOM attribute', async () => {
    const api = makeApi({
      route_list: {
        routes: [{ id: 'x" onclick="alert(1)', source: 'a', destination: 'b', enabled: true }]
      }
    });
    const modal = await openModal(api);
    const btn = modal.$('[data-lrt-action="delete"]');
    expect(btn.getAttribute('data-lrt-id')).toBe('x" onclick="alert(1)');
    expect(btn.hasAttribute('onclick')).toBe(false);
    modal.close();
  });
});

// ────────────────────────────────────────────────────────── accessibility (L09)

describe('R12 · LiveRoutingModal — accessibility contract (F-103, F-104)', () => {
  it('is a dialog that Escape closes', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    expect(modal.container.getAttribute('role')).toBe('dialog');
    expect(modal.container.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('live-routing-modal-title')).not.toBeNull();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isOpen).toBe(false);
  });

  it('traps Tab inside the dialog', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const focusable = [
      ...modal.dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      )
    ];
    const last = focusable[focusable.length - 1];
    last.focus();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);
    modal.close();
  });

  it('gives every form control an accessible name (F-104)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('[data-lrt-action="edit"]').click();

    const labels = [...modal.dialog.querySelectorAll('label[for]')].map((l) =>
      l.getAttribute('for')
    );
    const nameless = [];
    modal.dialog.querySelectorAll('input, select, textarea').forEach((el) => {
      const labelled =
        (el.id && labels.includes(el.id)) ||
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.closest('label');
      if (!labelled) nameless.push(el.outerHTML.slice(0, 90));
    });
    expect(nameless, nameless.join('\n')).toEqual([]);
    // …and the panel really is populated (16 channel selects + 7 type toggles).
    expect(modal.$$('#lrt-chmap select').length).toBe(16);
    expect(modal.$$('#lrt-filter-types input').length).toBe(7);
    modal.close();
  });

  it('has no icon-only button (nothing added to the F-104 ratchet)', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('[data-lrt-action="edit"]').click();
    const anonymous = [];
    modal.dialog.querySelectorAll('button').forEach((b) => {
      if (b.classList.contains('modal-close')) return; // BaseModal's own, aria-labelled
      const text = (b.textContent || '').trim();
      if (!/[A-Za-zÀ-ɏЀ-ӿͰ-Ͽ一-鿿ぁ-ヿ가-힯]/.test(text) && !b.getAttribute('aria-label')) {
        anonymous.push(b.outerHTML.slice(0, 90));
      }
    });
    expect(anonymous, anonymous.join('\n')).toEqual([]);
    modal.close();
  });

  it('has a polite live region for its result messages', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const status = modal.$('#lrt-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    modal.close();
  });
});

// ─────────────────────────────────────────────────────────────────── i18n (L13)

describe('R12 · LiveRoutingModal — i18n', () => {
  it('renders without a single missing translation key', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.$('[data-lrt-action="edit"]').click();
    expect(missingKeys, missingKeys.join(', ')).toEqual([]);
    // No raw key leaked into the rendered markup either.
    expect(modal.dialog.innerHTML).not.toContain('liveRouting.');
    modal.close();
  });

  it('declares every liveRouting key in all 28 locales', () => {
    const flat = (o, p = '') =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [p + k]
      );
    const reference = flat(en.liveRouting).sort();
    expect(reference.length).toBeGreaterThan(50);
    const files = readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(28);
    for (const f of files) {
      const data = JSON.parse(readFileSync(join(LOCALES, f), 'utf8'));
      expect(data.liveRouting, `${f} has no liveRouting namespace`).toBeTruthy();
      expect(flat(data.liveRouting).sort(), `${f} drifted`).toEqual(reference);
      for (const key of reference) {
        expect(typeof lookup(data.liveRouting, key), `${f}:${key}`).toBe('string');
        expect(lookup(data.liveRouting, key), `${f}:${key}`).not.toBe('');
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────── memory (L09)

describe('R12 · LiveRoutingModal — 50 open/close cycles leave nothing behind', () => {
  it('balances every document/window listener and removes its DOM', async () => {
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
    const api = makeApi();
    for (let i = 0; i < 50; i++) {
      const modal = new window.LiveRoutingModal(api);
      modal.open();
      modal.close();
    }
    for (const [type, delta] of net) expect(delta, `listener ${type}`).toBe(0);
    expect(document.body.children.length).toBe(0);
    expect(document.body.style.overflow).toBe('');
  });
});

// ───────────────────────────────────────────────────────────── the entry point

describe('R12 · LiveRoutingLauncher — the surface is actually reachable', () => {
  beforeEach(() => {
    document.body.innerHTML = '<header><div class="header-tools-right"></div></header>';
    evalFile('public/js/features/routing/LiveRoutingLauncher.js');
  });

  it('injects a named header button', () => {
    const btn = document.getElementById('liveRoutingBtn');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe(en.liveRouting.title);
    expect(btn.title).toBe(en.liveRouting.title);
    expect(btn.closest('.header-tools-right')).not.toBeNull();
  });

  it('is idempotent — a second install does not duplicate the button', () => {
    window.installLiveRoutingLauncher();
    window.installLiveRoutingLauncher();
    expect(document.querySelectorAll('#liveRoutingBtn').length).toBe(1);
  });

  it('opens the routing modal on click, which then talks to the backend', async () => {
    const api = makeApi();
    window.api = api;
    document.getElementById('liveRoutingBtn').click();
    await vi.waitFor(() => expect(sent(api)).toContain('route_list'));
    const overlay = document.getElementById('live-routing-modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('dialog');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('live-routing-modal-overlay')).toBeNull();
    delete window.api;
  });

  it('sits next to the other header tools when one is present', () => {
    document.body.innerHTML =
      '<header><div class="header-tools-right"><button id="systemAdminBtn">x</button></div></header>';
    window.installLiveRoutingLauncher();
    const tools = [...document.querySelectorAll('.header-tools-right > button')].map((b) => b.id);
    expect(tools).toEqual(['systemAdminBtn', 'liveRoutingBtn']);
  });
});
