// tests/frontend/ism-sections-hands.test.js
// Guards the hands section of the instrument-settings modal:
//  - Visibility covers keyboards + strings (not drums, not winds)
//  - Mode dispatch: strings → frets, everything else → semitones
//  - Default config shapes match what the validator expects
//  - Render → DOM → collect round-trip is lossless for both modes

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const familiesSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/InstrumentFamilies.js'),
  'utf8'
);
const sectionsSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/ISMSections.js'),
  'utf8'
);

beforeAll(() => {
  new Function(familiesSrc)();
  // ISMSections references InstrumentSettingsModal.GM_CATEGORY_EMOJIS in
  // identity rendering; stub just enough for the IIFE to load.
  window.InstrumentSettingsModal = { GM_CATEGORY_EMOJIS: {} };
  new Function(sectionsSrc)();
});

describe('ISMSections._shouldShowHandsSection', () => {
  it('shows for keyboards (Acoustic Grand Piano)', () => {
    const tab = { settings: { gm_program: 0 }, channel: 0 };
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(true);
  });

  it('shows for plucked strings (Acoustic Guitar nylon)', () => {
    const tab = { settings: { gm_program: 24 }, channel: 0 };
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(true);
  });

  it('shows for bowed strings (Violin)', () => {
    const tab = { settings: { gm_program: 40 }, channel: 0 };
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(true);
  });

  it('hides for winds', () => {
    const tab = { settings: { gm_program: 73 }, channel: 0 }; // Flute
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(false);
  });

  it('hides for drum kit (channel 9)', () => {
    const tab = { settings: { gm_program: 0 }, channel: 9 };
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(false);
  });

  it('hides when gm_program is missing', () => {
    const tab = { settings: {}, channel: 0 };
    expect(window.ISMSections._shouldShowHandsSection(tab)).toBe(false);
  });
});

describe('ISMSections._handsModeForTab', () => {
  it('keyboard → semitones', () => {
    expect(window.ISMSections._handsModeForTab({ settings: { gm_program: 0 }, channel: 0 })).toBe('semitones');
  });

  it('plucked string → frets', () => {
    expect(window.ISMSections._handsModeForTab({ settings: { gm_program: 24 }, channel: 0 })).toBe('frets');
  });

  it('bowed string → frets', () => {
    expect(window.ISMSections._handsModeForTab({ settings: { gm_program: 40 }, channel: 0 })).toBe('frets');
  });

  it('organ → semitones', () => {
    expect(window.ISMSections._handsModeForTab({ settings: { gm_program: 16 }, channel: 0 })).toBe('semitones');
  });
});

describe('ISMSections._defaultHandsConfig', () => {
  it('semitones mode: two hands + assignment block', () => {
    const cfg = window.ISMSections._defaultHandsConfig('semitones');
    expect(cfg.mode).toBe('semitones');
    expect(cfg.enabled).toBe(true);
    expect(cfg.hands).toHaveLength(2);
    expect(cfg.hands.map(h => h.id).sort()).toEqual(['left', 'right']);
    expect(cfg.hands[0].hand_span_semitones).toBeGreaterThan(0);
    expect(cfg.hand_move_semitones_per_sec).toBeGreaterThan(0);
    expect(cfg.assignment).toEqual(expect.objectContaining({ mode: 'auto' }));
  });

  it('frets mode: single fretting hand, no assignment block', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets');
    expect(cfg.mode).toBe('frets');
    expect(cfg.enabled).toBe(true);
    expect(cfg.mechanism).toBe('string_sliding_fingers');
    expect(cfg.hands).toHaveLength(1);
    expect(cfg.hands[0].id).toBe('fretting');
    expect(cfg.hands[0].hand_span_frets).toBeGreaterThan(0);
    expect(cfg.hands[0].hand_span_mm).toBeGreaterThan(0);
    expect(cfg.hand_move_frets_per_sec).toBeGreaterThan(0);
    expect(cfg.hand_move_mm_per_sec).toBeGreaterThan(0);
    expect(cfg.assignment).toBeUndefined();
  });
});

// Build a minimal DOM shell that looks like the modal layout so
// `_collectHandsConfig` can scope its queries to the hands section.
function mountSection(innerHtml) {
  document.body.innerHTML = `
    <div class="ism-modal-root">
      <div class="ism-section" data-section="hands">${innerHtml}</div>
    </div>`;
  return document.querySelector('.ism-modal-root');
}

describe('ISMSections — frets render → collect round-trip', () => {
  it('default config survives a render→collect round-trip', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets');
    const html = window.ISMSections._renderHandsSectionFrets(cfg);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.mode).toBe('frets');
    expect(collected.enabled).toBe(true);
    expect(collected.mechanism).toBe('string_sliding_fingers');
    expect(collected.hand_move_frets_per_sec).toBe(cfg.hand_move_frets_per_sec);
    expect(collected.hands).toEqual([
      expect.objectContaining({
        id: 'fretting',
        cc_position_number: cfg.hands[0].cc_position_number,
        hand_span_frets: cfg.hands[0].hand_span_frets
      })
    ]);
    expect(collected.hand_move_semitones_per_sec).toBeUndefined();
  });

  it('custom values are preserved', () => {
    const cfg = {
      enabled: true,
      mode: 'frets',
      mechanism: 'string_sliding_fingers',
      hand_move_frets_per_sec: 20,
      hand_move_mm_per_sec: 250,
      hands: [{
        id: 'fretting', cc_position_number: 30,
        hand_span_frets: 5, hand_span_mm: 80
      }]
    };
    const html = window.ISMSections._renderHandsSectionFrets(cfg);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.hand_move_frets_per_sec).toBe(20);
    expect(collected.hands[0].cc_position_number).toBe(30);
    expect(collected.hands[0].hand_span_frets).toBe(5);
  });

  it('mechanism = fret_sliding_fingers exposes num_fingers + variable_height_fingers_count', () => {
    const cfg = {
      enabled: true,
      mode: 'frets',
      mechanism: 'fret_sliding_fingers',
      hand_move_mm_per_sec: 250,
      hand_move_frets_per_sec: 12,
      hands: [{
        id: 'fretting', cc_position_number: 22,
        hand_span_mm: 80, hand_span_frets: 4,
        num_fingers: 4, variable_height_fingers_count: 2
      }]
    };
    const html = window.ISMSections._renderHandsSectionFrets(cfg);
    expect(html).toMatch(/num_fingers/);
    expect(html).toMatch(/variable_height_fingers_count/);
    // string_sliding_fingers-specific max_fingers field is hidden.
    expect(html).not.toMatch(/data-field="max_fingers"/);

    const root = mountSection(html);
    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.mechanism).toBe('fret_sliding_fingers');
    expect(collected.hands[0].num_fingers).toBe(4);
    expect(collected.hands[0].variable_height_fingers_count).toBe(2);
  });
});

describe('ISMSections — frets render with physical model (scale length present)', () => {
  const tabWithScale = {
    settings: { gm_program: 24 },
    channel: 0,
    stringInstrumentConfig: { scale_length_mm: 650, num_strings: 6 }
  };

  it('renders mm inputs and the geometry section when scale_length_mm is present', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabWithScale);
    const html = window.ISMSections._renderHandsSectionFrets(cfg, tabWithScale);
    expect(html).toMatch(/hand_span_mm/);
    expect(html).toMatch(/handsMoveMmPerSec/);
    // Geometry section replaces the old in-line coverage hint with
    // editable scale-length / num-strings / num-frets inputs.
    expect(html).toMatch(/handsGeometryScaleLength/);
    expect(html).toMatch(/handsGeometryNumStrings/);
    expect(html).toMatch(/handsGeometryNumFrets/);
    // No more "Couverture: fr.X" line — removed because not easily
    // understandable.
    expect(html).not.toMatch(/handsCoverageHint/);
    expect(html).not.toMatch(/Couverture\s*:/);
    expect(html).not.toMatch(/Aucune longueur de corde renseignée/);
  });

  it('seeds default hand_span_mm and hand_move_mm_per_sec', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabWithScale);
    expect(cfg.hand_move_mm_per_sec).toBe(250);
    expect(cfg.hands[0].hand_span_mm).toBe(80);
    // Frets fallbacks are kept on the in-memory default so a later
    // round-trip through the hidden inputs preserves them.
    expect(cfg.hand_move_frets_per_sec).toBe(12);
    expect(cfg.hands[0].hand_span_frets).toBe(4);
  });

  it('seeds max_fingers from num_strings when known', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabWithScale);
    expect(cfg.hands[0].max_fingers).toBe(6);
  });

  it('round-trip preserves mm fields and max_fingers', () => {
    const cfg = {
      enabled: true, mode: 'frets',
      hand_move_mm_per_sec: 300,
      hand_move_frets_per_sec: 12,
      hands: [{
        id: 'fretting', cc_position_number: 22,
        hand_span_mm: 90, hand_span_frets: 4, max_fingers: 5
      }]
    };
    const html = window.ISMSections._renderHandsSectionFrets(cfg, tabWithScale);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.mode).toBe('frets');
    expect(collected.hand_move_mm_per_sec).toBe(300);
    expect(collected.hand_move_frets_per_sec).toBe(12);
    expect(collected.hands[0].hand_span_mm).toBe(90);
    expect(collected.hands[0].max_fingers).toBe(5);
  });

  it('coverage hint reports more frets at fret 14 than at fret 1', () => {
    // Sanity: physical model means upper-neck reach > nut-region reach.
    const at1 = window.ISMSections._approxFretsAt(650, 80, 1);
    const at14 = window.ISMSections._approxFretsAt(650, 80, 14);
    expect(at14).toBeGreaterThan(at1);
  });

  it('coverage hint string mentions the three reference positions', () => {
    const hint = window.ISMSections._fretCoverageHint(650, 80);
    expect(hint).toMatch(/fr\.1/);
    expect(hint).toMatch(/fr\.7/);
    expect(hint).toMatch(/fr\.14/);
  });

  it('_approxFretsAt returns Infinity when the hand spans past the bridge', () => {
    // 650 mm hand on a 650 mm scale at fret 0: term = 1 - 1 = 0 → unreachable.
    expect(window.ISMSections._approxFretsAt(650, 650, 0)).toBe(Infinity);
  });
});

describe('ISMSections — frets render WITHOUT scale length', () => {
  const tabNoScale = {
    settings: { gm_program: 24 },
    channel: 0,
    stringInstrumentConfig: { num_strings: 6, scale_length_mm: null }
  };

  it('still renders mm inputs (defaults) and shows the warning banner', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabNoScale);
    const html = window.ISMSections._renderHandsSectionFrets(cfg, tabNoScale);
    // mm row is now always rendered with sane defaults so the user
    // can save a valid mm-based config even before picking a preset.
    expect(html).toMatch(/handsMoveMmPerSec/);
    expect(html).toMatch(/hand_span_mm/);
    expect(html).toMatch(/Aucune longueur de corde renseignée/);
    // Legacy fret-fallback fields are kept as hidden inputs only.
    expect(html).toMatch(/hand_span_frets/);
  });

  it('default still seeds mm fields when scale length is absent', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabNoScale);
    expect(cfg.hand_move_mm_per_sec).toBe(250);
    expect(cfg.hands[0].hand_span_mm).toBe(80);
  });

  it('round-trip preserves max_fingers when fallback only', () => {
    const cfg = window.ISMSections._defaultHandsConfig('frets', tabNoScale);
    const html = window.ISMSections._renderHandsSectionFrets(cfg, tabNoScale);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.hands[0].max_fingers).toBe(6);
    expect(collected.hand_move_mm_per_sec).toBe(250);
  });
});

describe('ISMSections — semitones render → collect round-trip', () => {
  it('default config survives a render→collect round-trip', () => {
    const cfg = window.ISMSections._defaultHandsConfig('semitones');
    const html = window.ISMSections._renderHandsSectionSemitones(cfg);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.mode).toBe('semitones');
    expect(collected.enabled).toBe(true);
    expect(collected.hand_move_semitones_per_sec).toBe(cfg.hand_move_semitones_per_sec);
    expect(collected.hands.map(h => h.id).sort()).toEqual(['left', 'right']);
    expect(collected.hand_move_frets_per_sec).toBeUndefined();
    expect(collected.assignment.mode).toBe('auto');
  });

  it('preserves assignment and pitch-split values', () => {
    const cfg = {
      enabled: true,
      mode: 'semitones',
      hand_move_semitones_per_sec: 90,
      assignment: { mode: 'pitch_split', pitch_split_note: 64, pitch_split_hysteresis: 3 },
      hands: [
        { id: 'left',  cc_position_number: 23, hand_span_semitones: 12 },
        { id: 'right', cc_position_number: 24, hand_span_semitones: 16 }
      ]
    };
    const html = window.ISMSections._renderHandsSectionSemitones(cfg);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.hand_move_semitones_per_sec).toBe(90);
    expect(collected.assignment).toEqual({
      mode: 'pitch_split',
      pitch_split_note: 64,
      pitch_split_hysteresis: 3
    });
    expect(collected.hands.find(h => h.id === 'left').hand_span_semitones).toBe(12);
    expect(collected.hands.find(h => h.id === 'right').hand_span_semitones).toBe(16);
  });
});
