// tests/voice-selector.test.js
// Unit coverage for the Phase-8 multi-voice selection policy
// (src/midi/adaptation/VoiceSelector.js). Verifies the by-declared-note policy
// and, crucially, the zero-regression NO-OP path (voices_share_notes set, or no
// per-voice note capability => always the primary program).

import { describe, test, expect } from '@jest/globals';
import { selectVoiceProgram, planVoiceProgramChanges } from '../src/midi/adaptation/VoiceSelector.js';

const primary = 32; // e.g. acoustic bass (primary voice)

describe('selectVoiceProgram — no-op safety (zero regression)', () => {
  const voices = [
    { gm_program: 36, note_selection_mode: 'range', note_range_min: 28, note_range_max: 40 }
  ];

  test('sharesNotes defaults to true → always primary', () => {
    expect(selectVoiceProgram({ note: 30, primaryProgram: primary, voices })).toBe(primary);
  });

  test('sharesNotes true → always primary even when a voice would claim it', () => {
    expect(
      selectVoiceProgram({ note: 30, primaryProgram: primary, voices, sharesNotes: true })
    ).toBe(primary);
  });

  test('no voices → primary', () => {
    expect(
      selectVoiceProgram({ note: 30, primaryProgram: primary, voices: [], sharesNotes: false })
    ).toBe(primary);
  });

  test('voices that do not declare notes → primary (cannot discriminate)', () => {
    const shareless = [{ gm_program: 36 }, { gm_program: 40, note_selection_mode: null }];
    expect(
      selectVoiceProgram({ note: 30, primaryProgram: primary, voices: shareless, sharesNotes: false })
    ).toBe(primary);
  });

  test('a voice with an incomplete range declaration is ignored', () => {
    const bad = [{ gm_program: 36, note_selection_mode: 'range', note_range_min: 28 }];
    expect(
      selectVoiceProgram({ note: 30, primaryProgram: primary, voices: bad, sharesNotes: false })
    ).toBe(primary);
  });
});

describe('selectVoiceProgram — by declared range', () => {
  const voices = [
    { gm_program: 36, note_selection_mode: 'range', note_range_min: 28, note_range_max: 40 }
  ];

  test('note inside a secondary voice range → that voice', () => {
    expect(
      selectVoiceProgram({ note: 30, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(36);
  });

  test('note outside every secondary range → primary', () => {
    expect(
      selectVoiceProgram({ note: 60, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(primary);
  });

  test('range bounds are inclusive', () => {
    expect(
      selectVoiceProgram({ note: 28, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(36);
    expect(
      selectVoiceProgram({ note: 40, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(36);
  });
});

describe('selectVoiceProgram — by discrete selection', () => {
  const voices = [
    { gm_program: 45, note_selection_mode: 'discrete', selected_notes: [60, 62, 64] }
  ];

  test('note in the discrete set → that voice', () => {
    expect(
      selectVoiceProgram({ note: 62, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(45);
  });

  test('note not in the discrete set → primary', () => {
    expect(
      selectVoiceProgram({ note: 61, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(primary);
  });
});

describe('selectVoiceProgram — overlap resolution', () => {
  test('most specific (narrower span) voice wins an overlap', () => {
    const voices = [
      { gm_program: 10, note_selection_mode: 'range', note_range_min: 0, note_range_max: 127, display_order: 0 },
      { gm_program: 20, note_selection_mode: 'range', note_range_min: 60, note_range_max: 64, display_order: 1 }
    ];
    // 62 is in both; the tight [60,64] wins over the full-range voice.
    expect(
      selectVoiceProgram({ note: 62, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(20);
    // 50 is only in the wide voice.
    expect(
      selectVoiceProgram({ note: 50, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(10);
  });

  test('equal span → lowest display_order wins (stable)', () => {
    const voices = [
      { gm_program: 20, note_selection_mode: 'range', note_range_min: 60, note_range_max: 64, display_order: 5 },
      { gm_program: 21, note_selection_mode: 'range', note_range_min: 60, note_range_max: 64, display_order: 2 }
    ];
    expect(
      selectVoiceProgram({ note: 62, primaryProgram: primary, voices, sharesNotes: false })
    ).toBe(21);
  });
});

describe('planVoiceProgramChanges', () => {
  const voices = [
    { gm_program: 36, note_selection_mode: 'range', note_range_min: 28, note_range_max: 40, display_order: 0 }
  ];

  test('no-op when sharesNotes (default) → empty plan', () => {
    const seq = [{ note: 30 }, { note: 60 }];
    expect(planVoiceProgramChanges(seq, { primaryProgram: primary, voices })).toEqual([]);
  });

  test('emits a change only on transitions, collapsing runs', () => {
    // low(36) low(36) high(primary) high(primary) low(36)
    const seq = [{ note: 30 }, { note: 32 }, { note: 60 }, { note: 62 }, { note: 30 }];
    const plan = planVoiceProgramChanges(seq, {
      primaryProgram: primary,
      voices,
      sharesNotes: false
    });
    expect(plan).toEqual([
      { index: 0, note: 30, program: 36 }, // primary -> 36
      { index: 2, note: 60, program: primary }, // 36 -> primary
      { index: 4, note: 30, program: 36 } // primary -> 36
    ]);
  });

  test('startProgram lets a leading primary run emit nothing', () => {
    const seq = [{ note: 60 }, { note: 30 }];
    const plan = planVoiceProgramChanges(seq, {
      primaryProgram: primary,
      voices,
      sharesNotes: false,
      startProgram: primary
    });
    // First note is primary (already active) → no change; second switches to 36.
    expect(plan).toEqual([{ index: 1, note: 30, program: 36 }]);
  });

  test('empty sequence → empty plan', () => {
    expect(
      planVoiceProgramChanges([], { primaryProgram: primary, voices, sharesNotes: false })
    ).toEqual([]);
  });
});
