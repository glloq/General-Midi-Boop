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
      ctx({ bagpipe_config: { drones: [45, 33], enabled: false } }));
    mountSection('bagpipe', html);
    expect(document.getElementById('bagpipeEnabled').checked).toBe(false);
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

  it('defaults (no config) → A2 drone, enabled', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    expect(document.getElementById('bagpipeEnabled').checked).toBe(true);
    expect(drones()).toEqual([{ note: 45, enabled: true }]);
  });

  it('collect round-trips the JSON state + reads enabled', () => {
    mountSection('bagpipe', S()._renderBagpipeSection.call(ctx({})));
    document.getElementById('bagpipeDrones').value = JSON.stringify(
      [{ note: 45, enabled: true }, { note: 33, enabled: false }]);
    document.getElementById('bagpipeEnabled').checked = false;
    expect(S()._collectBagpipeConfig(document.body)).toEqual({
      drones: [{ note: 45, enabled: true }, { note: 33, enabled: false }],
      enabled: false
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
      bass_range: { min: 48, max: 55 }
    });
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
