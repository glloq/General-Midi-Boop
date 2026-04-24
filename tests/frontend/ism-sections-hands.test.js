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
    expect(cfg.hands).toHaveLength(1);
    expect(cfg.hands[0].id).toBe('fretting');
    expect(cfg.hands[0].hand_span_frets).toBeGreaterThan(0);
    expect(cfg.hand_move_frets_per_sec).toBeGreaterThan(0);
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
      hand_move_frets_per_sec: 20,
      hands: [{ id: 'fretting', cc_position_number: 30, hand_span_frets: 5 }]
    };
    const html = window.ISMSections._renderHandsSectionFrets(cfg);
    const root = mountSection(html);

    const collected = window.ISMSections._collectHandsConfig(root);
    expect(collected.hand_move_frets_per_sec).toBe(20);
    expect(collected.hands[0].cc_position_number).toBe(30);
    expect(collected.hands[0].hand_span_frets).toBe(5);
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
