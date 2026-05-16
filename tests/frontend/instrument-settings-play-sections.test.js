// tests/frontend/instrument-settings-play-sections.test.js
// ISM modal: the bagpipe / accordion sections (QA #3/#4 UI). Covers the
// conditional show predicates, the rendered form fields, and the
// collectors that build bagpipe_config / accordion_config for
// instrument_save_all. Pure DOM — no SQLite, no full modal.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}
beforeAll(() => {
  // MidiConstants must load first: the bagpipe render/collect now
  // depend on win.MidiConstants.normalizeBagpipeDrones.
  load('../../public/js/utils/MidiConstants.js');
  load('../../public/js/features/instrument-settings/ISMSections.js');
  load('../../public/js/features/instrument-settings/ISMListeners.js');
});

const S = () => win.ISMSections;
// Minimal `this` for the render fns (mirrors the modal's surface).
const ctx = (settings) => ({
  _getActiveTab: () => ({ channel: 0, settings }),
  t: () => null,                         // force fallback strings
  escape: (s) => String(s)
});
// Bagpipe / accordion are now subsections of Notes & Capacités — the
// collectors look up #bagpipeSubsection / #accordionSubsection.
const mountSection = (id, html) => {
  document.body.innerHTML = `<div class="ism-subsection" id="${id}Subsection">${html}</div>`;
  return document.body;
};

describe('ISM — section visibility predicates', () => {
  it('bagpipe shows only for GM 109 on a non-drum channel', () => {
    expect(S()._shouldShowBagpipeSection({ channel: 0, settings: { gm_program: 109 } })).toBe(true);
    expect(S()._shouldShowBagpipeSection({ channel: 9, settings: { gm_program: 109 } })).toBe(false);
    expect(S()._shouldShowBagpipeSection({ channel: 0, settings: { gm_program: 0 } })).toBe(false);
    expect(S()._shouldShowBagpipeSection(null)).toBe(false);
  });

  it('accordion shows for GM 21 / 23 only', () => {
    expect(S()._shouldShowAccordionSection({ channel: 0, settings: { gm_program: 21 } })).toBe(true);
    expect(S()._shouldShowAccordionSection({ channel: 0, settings: { gm_program: 23 } })).toBe(true);
    expect(S()._shouldShowAccordionSection({ channel: 0, settings: { gm_program: 22 } })).toBe(false);
    expect(S()._shouldShowAccordionSection({ channel: 0, settings: { gm_program: 24 } })).toBe(false);
  });
});

describe('ISM — bagpipe section render + collect', () => {
  const drones = () => JSON.parse(document.getElementById('bagpipeDrones').value);

  it('renders piano + list + preset; legacy number[] → enabled objects', () => {
    const html = S()._renderBagpipeSection.call(
      ctx({ bagpipe_config: { drones: [45, 33] } }));
    mountSection('bagpipe', html);
    expect(document.getElementById('bagpipeEnabled')).toBeNull();   // no startup toggle
    expect(drones()).toEqual([{ note: 45, enabled: true }, { note: 33, enabled: true }]);
    expect(document.getElementById('bagpipeDronePiano')).not.toBeNull();
    expect(document.getElementById('bagpipeDroneList')).not.toBeNull();
    const presetSel = document.getElementById('bagpipePreset');
    expect(presetSel).not.toBeNull();
    const ids = [...presetSel.querySelectorAll('option')]
      .map(o => o.value).filter(Boolean);
    expect(ids).toEqual(S()._BAGPIPE_PRESETS.map(p => p.id));
  });

  it('renders new object shape, preserving per-drone enabled', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(
      ctx({ bagpipe_config: { drones: [{ note: 33, enabled: false }] } })));
    expect(drones()).toEqual([{ note: 33, enabled: false }]);
  });

  it('defaults (no config) → A2 drone', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    expect(document.getElementById('bagpipeEnabled')).toBeNull();
    expect(drones()).toEqual([{ note: 45, enabled: true }]);
  });

  it('collect round-trips the JSON state (no startup flag)', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    document.getElementById('bagpipeDrones').value = JSON.stringify(
      [{ note: 45, enabled: true }, { note: 33, enabled: false }]);
    expect(S()._collectBagpipeConfig(document.body)).toEqual({
      drones: [{ note: 45, enabled: true }, { note: 33, enabled: false }]
    });
  });

  it('collect with invalid JSON falls back to [{note:45,enabled:true}]', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    document.getElementById('bagpipeDrones').value = 'not json';
    expect(S()._collectBagpipeConfig(document.body).drones)
      .toEqual([{ note: 45, enabled: true }]);
  });

  it('collect → undefined when section absent or not visited', () => {
    document.body.innerHTML = '';
    expect(S()._collectBagpipeConfig(document.body)).toBeUndefined();
    document.body.innerHTML = '<div class="ism-subsection" id="bagpipeSubsection"></div>';
    expect(S()._collectBagpipeConfig(document.body)).toBeUndefined();
  });

  it('empty drones array falls back to [{note:45,enabled:true}]', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    document.getElementById('bagpipeDrones').value = '[]';
    expect(S()._collectBagpipeConfig(document.body).drones)
      .toEqual([{ note: 45, enabled: true }]);
  });
});

describe('ISM — bagpipe drone picker wiring (_wireBagpipeListeners)', () => {
  const L = () => win.ISMListeners;
  // `this` surface used by _wireBagpipeListeners: $ is scoped to the modal.
  const lctx = () => ({
    $: (sel) => document.querySelector(sel),
    t: () => null,
    escape: (s) => String(s),
  });
  const drones = () => JSON.parse(document.getElementById('bagpipeDrones').value);

  it('renders the mini-piano + list once the subsection is mounted', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(
      ctx({ bagpipe_config: { drones: [45] } })));
    L()._wireBagpipeListeners.call(lctx());
    expect(document.querySelectorAll('#bagpipeDronePiano .piano-key').length)
      .toBeGreaterThan(0);
    // the configured drone (45) is preselected on the piano + listed
    expect(document.querySelector('#bagpipeDronePiano .piano-key[data-note="45"]')
      .classList.contains('selected')).toBe(true);
    expect(document.querySelectorAll('#bagpipeDroneList .bagpipe-drone-row').length)
      .toBe(1);
  });

  it('clicking a piano key adds/removes a drone', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    L()._wireBagpipeListeners.call(lctx());
    const key = () =>
      document.querySelector('#bagpipeDronePiano .piano-key[data-note="33"]');
    key().dispatchEvent(new Event('click', { bubbles: true }));   // add
    expect(drones().some(d => d.note === 33)).toBe(true);
    key().dispatchEvent(new Event('click', { bubbles: true }));   // re-query: piano re-rendered
    expect(drones().some(d => d.note === 33)).toBe(false);
  });

  it('selecting a preset fills the drone notes', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    L()._wireBagpipeListeners.call(lctx());
    const preset = S()._BAGPIPE_PRESETS[0];   // Great Highland: [33,45,45]
    const sel = document.getElementById('bagpipePreset');
    sel.value = preset.id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(drones().map(d => d.note).sort((a, b) => a - b))
      .toEqual([...preset.drones].sort((a, b) => a - b));
  });
});

describe('ISM — accordion section render + collect (no hands)', () => {
  it('renders 2 bass options (no chromatic) + current values', () => {
    const html = S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'free', right_display: 'keyboard' } }));
    mountSection('accordion', html);
    expect(document.getElementById('accordionBassSystem').value).toBe('free');
    const opts = [...document.querySelectorAll('#accordionBassSystem option')]
      .map(o => o.value);
    expect(opts).toEqual(['stradella', 'free']);   // chromatic removed
    expect(document.getElementById('accordionRightDisplay').value).toBe('keyboard');
    expect(document.getElementById('accordionHands')).toBeNull();
  });

  it('legacy chromatic normalized → free on render', () => {
    mountSection('accordion', S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'chromatic' } })));
    expect(document.getElementById('accordionBassSystem').value).toBe('free');
  });

  it('defaults → stradella + buttons + C2..C4 range (inputs disabled)', () => {
    mountSection('accordion', S()._renderAccordionSection.call(ctx({})));
    expect(document.getElementById('accordionBassSystem').value).toBe('stradella');
    expect(document.getElementById('accordionRightDisplay').value).toBe('buttons');
    expect(document.getElementById('accordionBassRangeMin').value).toBe('36');
    expect(document.getElementById('accordionBassRangeMax').value).toBe('60');
    expect(document.getElementById('accordionBassRangeMin').disabled).toBe(true);
    expect(document.getElementById('accordionBassRangeMax').disabled).toBe(true);
  });

  it('free → range inputs enabled with stored span', () => {
    mountSection('accordion', S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'free', bass_range: { min: 48, max: 55 } } })));
    expect(document.getElementById('accordionBassRangeMin').value).toBe('48');
    expect(document.getElementById('accordionBassRangeMax').value).toBe('55');
    expect(document.getElementById('accordionBassRangeMin').disabled).toBe(false);
  });

  it('collect returns bass_system + right_display + bass_range', () => {
    mountSection('accordion', S()._renderAccordionSection.call(ctx({})));
    document.getElementById('accordionBassSystem').value = 'free';
    document.getElementById('accordionRightDisplay').value = 'keyboard';
    document.getElementById('accordionBassRangeMin').value = '48';
    document.getElementById('accordionBassRangeMax').value = '55';
    expect(S()._collectAccordionConfig(document.body)).toEqual({
      bass_system: 'free', right_display: 'keyboard',
      bass_range: { min: 48, max: 55 },
      bass_cols: 12, bass_base: 36,
      bass_funcs: ['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7']
    });
  });

  it('collect returns configurable Stradella geometry', () => {
    mountSection('accordion', S()._renderAccordionSection.call(ctx({})));
    document.getElementById('accordionBassCols').value = '8';
    document.getElementById('accordionBassBase').value = '41';
    const cbs = [...document.querySelectorAll('.accordionFuncCb')];
    cbs.forEach((cb) => { cb.checked = ['bass', 'major'].includes(cb.value); });
    const out = S()._collectAccordionConfig(document.body);
    expect(out.bass_cols).toBe(8);
    expect(out.bass_base).toBe(41);
    expect(out.bass_funcs).toEqual(['bass', 'major']);
    // empty selection normalizes to all six
    cbs.forEach((cb) => { cb.checked = false; });
    expect(S()._collectAccordionConfig(document.body).bass_funcs)
      .toEqual(['counterbass', 'bass', 'major', 'minor', 'dom7', 'dim7']);
  });

  it('render: Stradella inputs disabled under free, enabled under stradella', () => {
    mountSection('accordion', S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'free' } })));
    expect(document.getElementById('accordionBassCols').disabled).toBe(true);
    expect(document.querySelector('.accordionFuncCb').disabled).toBe(true);
    mountSection('accordion', S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'stradella' } })));
    expect(document.getElementById('accordionBassCols').disabled).toBe(false);
    expect(document.querySelector('.accordionFuncCb').disabled).toBe(false);
  });

  it('normalize maps legacy chromatic → free', () => {
    expect(S()._normalizeBassSystem('chromatic')).toBe('free');
    expect(S()._normalizeBassSystem('bogus')).toBe('stradella');
  });

  it('collect: inverted range swapped, NaN → C2..C4 default', () => {
    mountSection('accordion', S()._renderAccordionSection.call(ctx({})));
    document.getElementById('accordionBassSystem').value = 'free';
    document.getElementById('accordionBassRangeMin').value = '70';
    document.getElementById('accordionBassRangeMax').value = '40';
    expect(S()._collectAccordionConfig(document.body).bass_range)
      .toEqual({ min: 40, max: 70 });
    document.getElementById('accordionBassRangeMin').value = '';
    document.getElementById('accordionBassRangeMax').value = 'abc';
    expect(S()._collectAccordionConfig(document.body).bass_range)
      .toEqual({ min: 36, max: 60 });
  });

  it('collect: bass_range persisted even under stradella', () => {
    mountSection('accordion', S()._renderAccordionSection.call(ctx({})));
    document.getElementById('accordionBassSystem').value = 'stradella';
    const out = S()._collectAccordionConfig(document.body);
    expect(out.bass_system).toBe('stradella');
    expect(out.bass_range).toEqual({ min: 36, max: 60 });
  });

  it('collect → undefined when not rendered/visited', () => {
    document.body.innerHTML = '<div class="ism-subsection" id="accordionSubsection"></div>';
    expect(S()._collectAccordionConfig(document.body)).toBeUndefined();
  });

  it('_syncAccordionBassRange toggles disabled live', () => {
    mountSection('accordion', S()._renderAccordionSection.call(
      ctx({ accordion_config: { bass_system: 'free' } })));
    const min = document.getElementById('accordionBassRangeMin');
    expect(min.disabled).toBe(false);
    document.getElementById('accordionBassSystem').value = 'stradella';
    S()._syncAccordionBassRange(document.body);
    expect(min.disabled).toBe(true);
    document.getElementById('accordionBassSystem').value = 'free';
    S()._syncAccordionBassRange(document.body);
    expect(min.disabled).toBe(false);
  });
});
