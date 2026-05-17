// tests/frontend/keyboard/virtual-instrument-list.test.js
// Regression guard: loadDevices() must surface EVERY (device_id, channel)
// virtual instrument as its own selectable entry. The previous dedup-by-
// device_id collapsed all channels of a multi-timbral virtual port to a
// single entry, hiding every instrument past the first (e.g. 19 virtual
// instruments showed up as ~6), which made special views (accordion gm21,
// harmonica gm22) unreachable.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = { addEventListener() {}, removeEventListener() {} };
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/KeyboardEvents.js');
  load('../../../public/js/features/keyboard/KeyboardControls.js');
  load('../../../public/js/features/KeyboardModal.js');
  // The new Function sandbox defeats KeyboardModal.js's `typeof Mixin`
  // guards, so attach the mixins explicitly (same as create-modal-dom).
  for (const name of ['KeyboardEventsMixin', 'KeyboardControlsMixin']) {
    if (win[name]) Object.assign(win.KeyboardModal.prototype, win[name]);
  }
});

const SETTINGS_KEY = 'gmboop_settings';

function makeModal({ listDevices, instruments, virtualEnabled = true }) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ virtualInstrument: virtualEnabled }));
  const m = new (win.KeyboardModal)();
  m.logger = { info() {}, warn() {}, debug() {}, error() {} };
  m.backend = {
    listDevices: async () => listDevices,
    sendCommand: async (cmd) =>
      cmd === 'instrument_list_capabilities' ? { instruments } : {},
  };
  return m;
}

const keyOf = (d) => `${d.device_id || d.id}::${d.channel ?? 0}`;

describe('loadDevices — virtual instruments surface per (device_id, channel)', () => {
  beforeEach(() => localStorage.clear());

  it('multi-timbral virtual port → one selectable entry per channel', async () => {
    const m = makeModal({
      listDevices: [], // nothing from the backend device list
      instruments: [
        { device_id: 'virtual_a', channel: 0, gm_program: 21, custom_name: 'Accordion', id: 1 },
        { device_id: 'virtual_a', channel: 1, gm_program: 22, custom_name: 'Harmonica', id: 2 },
        { device_id: 'virtual_a', channel: 2, gm_program: 0,  custom_name: 'Piano', id: 3 },
        { device_id: 'virtual_b', channel: 0, gm_program: 46, custom_name: 'Harp', id: 4 },
      ],
    });

    await m.loadDevices();

    const virt = m.devices.filter(d => d.isVirtual);
    expect(virt).toHaveLength(4);
    // No collapsed/duplicate (device_id, channel) pairs.
    expect(new Set(virt.map(keyOf)).size).toBe(4);

    const accordion = virt.find(d => d.device_id === 'virtual_a' && d.channel === 0);
    const harmonica = virt.find(d => d.device_id === 'virtual_a' && d.channel === 1);
    expect(accordion).toBeTruthy();
    expect(accordion.gm_program).toBe(21);
    expect(accordion._multiInstrument).toBe(true);
    expect(harmonica).toBeTruthy();
    expect(harmonica.gm_program).toBe(22);   // previously hidden behind ch0
    expect(harmonica._multiInstrument).toBe(true);
  });

  it('does not duplicate channels already expanded from the backend device list', async () => {
    const m = makeModal({
      listDevices: [{
        id: 'virtual_a', device_id: 'virtual_a', name: 'Virtual A',
        status: 2, type: 'virtual',
        instruments: [
          { channel: 0, gm_program: 21, name: 'Accordion', id: 1 },
          { channel: 1, gm_program: 22, name: 'Harmonica', id: 2 },
        ],
      }],
      instruments: [
        { device_id: 'virtual_a', channel: 0, gm_program: 21, custom_name: 'Accordion', id: 1 },
        { device_id: 'virtual_a', channel: 1, gm_program: 22, custom_name: 'Harmonica', id: 2 },
        { device_id: 'virtual_a', channel: 2, gm_program: 0,  custom_name: 'Piano', id: 3 },
        { device_id: 'virtual_b', channel: 0, gm_program: 46, custom_name: 'Harp', id: 4 },
      ],
    });

    await m.loadDevices();

    const keys = m.devices.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);          // no dup (dev,ch)
    expect(keys).toContain('virtual_a::0');
    expect(keys).toContain('virtual_a::1');
    expect(keys).toContain('virtual_a::2');                // added by caps merge
    expect(keys).toContain('virtual_b::0');                // added by caps merge
    expect(keys.filter(k => k === 'virtual_a::1')).toHaveLength(1);
  });

  it('respects the virtualInstrument setting (disabled → no virtual entries)', async () => {
    const m = makeModal({
      virtualEnabled: false,
      listDevices: [],
      instruments: [
        { device_id: 'virtual_a', channel: 0, gm_program: 21, custom_name: 'Accordion', id: 1 },
        { device_id: 'virtual_a', channel: 1, gm_program: 22, custom_name: 'Harmonica', id: 2 },
      ],
    });

    await m.loadDevices();

    expect(m.devices.filter(d => d.isVirtual)).toHaveLength(0);
  });
});
