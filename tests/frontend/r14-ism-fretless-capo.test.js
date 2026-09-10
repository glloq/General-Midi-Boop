// tests/frontend/r14-ism-fretless-capo.test.js
//
// R14 — `is_fretless` must survive a save (F-140, P1).
// R15 — the capo surface must be gone from the modal, and the GM
//       capability reference must actually feed the polyphony default
//       (F-73).
//
// The bug this pins: `ISMSave._save` used to build
// `stringInstrumentPayload` with `is_fretless: 0, capo_fret: 0` HARD-CODED,
// so every save of a violin / cello / fretless-bass row silently reset the
// flag the engine reads (`TablatureConverter`, `MidiPlayer`,
// `CapabilityResolver`). Report: docs/audit/2026-09-07/WAVE3_R14_R15.md.
//
// Pure DOM — no SQLite, no full modal, no backend.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Load an IIFE module onto the real jsdom `window` (bare globals resolve). */
function load(rel) {
  new Function(readFileSync(resolve(__dirname, rel), 'utf8'))();
}

beforeAll(() => {
  window.InstrumentSettingsModal = {
    GM_CATEGORY_EMOJIS: {},
    GM_RECOMMENDED_CCS: {},
    OCTAVE_MODES: { chromatic: { count: 12, label: 'Chromatic' } },
    computePlayableNotes: () => []
  };
  // Faithful subset of index.html's GM_STRING_PROGRAM_RANGES.
  window.isGmStringInstrument = (p) => p != null && ((p >= 24 && p <= 43) || p === 105);
  window.getGMInstrumentName = () => 'Violin';
  window.selectValueToGmProgram = (v) => ({ program: v, isDrumKit: false });

  load('../../public/js/utils/MidiConstants.js');
  load('../../public/js/features/GmInstrumentCapabilities.js');
  load('../../public/js/features/instrument-settings/InstrumentFamilies.js');
  load('../../public/js/features/instrument-settings/ISMSections.js');
  load('../../public/js/features/instrument-settings/ISMListeners.js');
  load('../../public/js/features/instrument-settings/ISMSave.js');
});

const ctx = (tab) => ({
  _getActiveTab: () => tab,
  t: () => null, // force the inline fallback strings
  escape: (s) => String(s)
});

/**
 * Minimal modal surface for `ISMSave._save`. The DOM is whatever the test
 * mounted; every absent input degrades through the `?.value` chain exactly
 * as it does in the real modal when a lazy section was never opened.
 */
function modal(tab, opts = {}) {
  const sent = [];
  return {
    device: { id: 'dev-1', name: 'Fretless rig' },
    activeChannel: 0,
    instrumentTabs: [tab],
    api: {
      sendCommand: (command, payload) => {
        sent.push({ command, payload });
        return Promise.resolve({});
      }
    },
    sent,
    $: (sel) => document.querySelector(sel),
    $$: (sel) => Array.from(document.querySelectorAll(sel)),
    _getActiveTab: () => tab,
    _neckDiagram: null,
    t: () => null,
    close: () => {},
    ...opts
  };
}

const saveAll = (m) => m.sent.find((c) => c.command === 'instrument_save_all').payload;

/** `_save` reads the GM program from the Identity select, not from the tab. */
const gmSelect = (program) =>
  `<select id="gmProgramSelect"><option value="${program}" selected>x</option></select>`;

/** A violin tab: string family, fretless in the persisted config. */
const fretlessTab = () => ({
  channel: 0,
  settings: { gm_program: 40, polyphony: 4 },
  voices: [],
  stringInstrumentConfig: {
    num_strings: 4,
    num_frets: 0,
    tuning: [55, 62, 69, 76],
    is_fretless: true,
    cc_enabled: true
  }
});

beforeEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------
// R14 — the checkbox exists and reflects the persisted flag
// ---------------------------------------------------------------------
describe('R14 · the Strings subsection exposes is_fretless', () => {
  it('renders #ismIsFretless checked for a fretless config', () => {
    const html = window.ISMSections._renderStringsContent.call(ctx(fretlessTab()));
    document.body.innerHTML = html;
    const cb = document.getElementById('ismIsFretless');
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(true);
  });

  it('renders it unchecked for a fretted config', () => {
    const tab = fretlessTab();
    tab.stringInstrumentConfig.is_fretless = false;
    document.body.innerHTML = window.ISMSections._renderStringsContent.call(ctx(tab));
    expect(document.getElementById('ismIsFretless').checked).toBe(false);
  });

  it('the toggle writes straight into tab.stringInstrumentConfig', () => {
    const tab = fretlessTab();
    tab.stringInstrumentConfig.is_fretless = false;
    document.body.innerHTML = `<div class="ism-subsection" id="stringsSubsection">${window.ISMSections._renderStringsContent.call(
      ctx(tab)
    )}</div>`;
    const self = {
      ...ctx(tab),
      $: (sel) => document.querySelector(sel),
      $$: (sel) => Array.from(document.querySelectorAll(sel)),
      _renderStringsContent: window.ISMSections._renderStringsContent,
      _attachStringsSectionListeners: window.ISMListeners._attachStringsSectionListeners,
      _syncPolyphonyToNumStrings: () => {},
      _initNeckDiagram: () => {},
      dialog: document.body
    };
    window.ISMListeners._attachStringsSectionListeners.call(self);
    const cb = document.getElementById('ismIsFretless');
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change'));
    expect(tab.stringInstrumentConfig.is_fretless).toBe(true);
  });
});

// ---------------------------------------------------------------------
// R14 — the save payload
// ---------------------------------------------------------------------
describe('R14 · is_fretless survives instrument_save_all', () => {
  it('sends is_fretless: 1 when the checkbox is checked', async () => {
    const tab = fretlessTab();
    document.body.innerHTML =
      gmSelect(40) + window.ISMSections._renderStringsContent.call(ctx(tab));
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).string_instrument.is_fretless).toBe(1);
  });

  it('sends is_fretless: 0 when the user unchecks it', async () => {
    const tab = fretlessTab();
    document.body.innerHTML =
      gmSelect(40) + window.ISMSections._renderStringsContent.call(ctx(tab));
    document.getElementById('ismIsFretless').checked = false;
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).string_instrument.is_fretless).toBe(0);
  });

  it('preserves the stored flag when the Strings subsection was never rendered', async () => {
    // The regression that made F-140 a P1: saving from another tab (no
    // strings DOM at all) used to write 0 unconditionally.
    const tab = fretlessTab();
    document.body.innerHTML = gmSelect(40);
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).string_instrument.is_fretless).toBe(1);
  });

  it('a fretless preset applied in-session is not reset on save', async () => {
    const tab = fretlessTab();
    tab.stringInstrumentConfig.is_fretless = false;
    document.body.innerHTML =
      gmSelect(40) + window.ISMSections._renderStringsContent.call(ctx(tab));
    // Simulate ISMListeners' preset handler (cfg.is_fretless = !!preset.fretless)
    tab.stringInstrumentConfig.is_fretless = true;
    document.body.innerHTML =
      gmSelect(40) + window.ISMSections._renderStringsContent.call(ctx(tab));
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).string_instrument.is_fretless).toBe(1);
  });
});

// ---------------------------------------------------------------------
// R15 — the capo surface is gone
// ---------------------------------------------------------------------
describe('R15 · the capo surface is removed from the modal', () => {
  it('the save payload carries no capo_fret at all', async () => {
    const tab = fretlessTab();
    document.body.innerHTML =
      gmSelect(40) + window.ISMSections._renderStringsContent.call(ctx(tab));
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).string_instrument).not.toHaveProperty('capo_fret');
  });

  it('the Strings subsection renders no capo control', () => {
    const html = window.ISMSections._renderStringsContent.call(ctx(fretlessTab()));
    expect(html.toLowerCase()).not.toContain('capo');
  });
});

// ---------------------------------------------------------------------
// R15 / F-73 — the GM capability reference is no longer dead data
// ---------------------------------------------------------------------
describe('R15 · GM reference feeds the polyphony default (F-73)', () => {
  it('_gmDefaultPolyphony answers 1 for a monophonic wind, 16 for a piano', () => {
    expect(window.ISMSections._gmDefaultPolyphony(73)).toBe(1); // Flute
    expect(window.ISMSections._gmDefaultPolyphony(56)).toBe(1); // Trumpet
    expect(window.ISMSections._gmDefaultPolyphony(0)).toBe(16); // Grand Piano
  });

  it('answers null for a drum kit and for an out-of-range program', () => {
    expect(window.ISMSections._gmDefaultPolyphony(0, true)).toBeNull();
    expect(window.ISMSections._gmDefaultPolyphony(200)).toBeNull();
    expect(window.ISMSections._gmDefaultPolyphony(null)).toBeNull();
  });

  it('a flute saved with an empty polyphony field is persisted monophonic', async () => {
    // Before R15 this row went to the DB with `polyphony: null` and the
    // engine sent it whole chords.
    const tab = { channel: 0, settings: { gm_program: 73 }, voices: [] };
    document.body.innerHTML = gmSelect(73) + '<input type="number" id="polyphonyInput" value="">';
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).polyphony).toBe(1);
  });

  it('a hand-typed polyphony always wins over the GM default', async () => {
    const tab = { channel: 0, settings: { gm_program: 73 }, voices: [] };
    document.body.innerHTML = gmSelect(73) + '<input type="number" id="polyphonyInput" value="3">';
    const m = modal(tab);
    await window.ISMSave._save.call(m);
    expect(saveAll(m).polyphony).toBe(3);
  });

  it('the rendered Notes field is pre-filled with the family default', () => {
    const tab = { channel: 0, settings: { gm_program: 73 }, voices: [] };
    // `_renderNotesSection` composes a dozen sibling renderers; only the
    // polyphony field is under test, so every other `_render*` answers ''.
    const base = {
      ...ctx(tab),
      activeChannel: 0,
      _getGmCategoryKey: () => null,
      _getActiveNotesTarget: () => ({ kind: 'primary', idx: null, obj: tab.settings })
    };
    const self = new Proxy(base, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === 'string' && key.startsWith('_render')) return () => '';
        return undefined;
      },
      has: () => true
    });
    document.body.innerHTML = window.ISMSections._renderNotesSection.call(self);
    expect(document.getElementById('polyphonyInput').value).toBe('1');
  });
});
