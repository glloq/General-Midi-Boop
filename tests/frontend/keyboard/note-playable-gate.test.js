// tests/frontend/keyboard/note-playable-gate.test.js
// Locks the isNotePlayable() contract that the chord strum/sustain paths
// now rely on (KeyboardChords.js): notes are gated by the device's actual
// capabilities instead of the old hardcoded 21..108 piano clamp. With no
// capabilities the full MIDI range must be allowed; a declared range must
// be honoured; discrete selections must be respected.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/KeyboardPiano.js');
});

const playable = (caps, note) =>
  win.KeyboardPianoMixin.isNotePlayable.call({ selectedDeviceCapabilities: caps }, note);

describe('isNotePlayable — the chord-range gate', () => {
  it('no capabilities → entire 0..127 MIDI range is allowed', () => {
    for (const n of [0, 20, 21, 60, 108, 109, 127]) {
      expect(playable(null, n)).toBe(true);
    }
  });

  it('range mode honours note_range_min/max (incl. notes below the old 21 floor)', () => {
    const caps = { note_range_min: 12, note_range_max: 96 };
    expect(playable(caps, 11)).toBe(false);
    expect(playable(caps, 12)).toBe(true); // would be dropped by the old >=21 clamp
    expect(playable(caps, 60)).toBe(true);
    expect(playable(caps, 96)).toBe(true);
    expect(playable(caps, 97)).toBe(false);
  });

  it('only one bound set → the other side stays open', () => {
    expect(playable({ note_range_min: 40 }, 39)).toBe(false);
    expect(playable({ note_range_min: 40 }, 120)).toBe(true);
    expect(playable({ note_range_max: 70 }, 5)).toBe(true);
    expect(playable({ note_range_max: 70 }, 71)).toBe(false);
  });

  it('discrete mode restricts to the selected notes only', () => {
    const caps = { note_selection_mode: 'discrete', selected_notes: [36, 60, 72] };
    expect(playable(caps, 60)).toBe(true);
    expect(playable(caps, 61)).toBe(false);
    // empty / absent selection in discrete mode → allow all
    expect(playable({ note_selection_mode: 'discrete', selected_notes: [] }, 99)).toBe(true);
  });
});
