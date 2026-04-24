// tests/hand-position-planner.test.js
// HandPositionPlanner: CC emission + feasibility warnings.

import { describe, test, expect } from '@jest/globals';
import HandPositionPlanner from '../src/midi/adaptation/HandPositionPlanner.js';

const pianoCfg = {
  enabled: true,
  hands: [
    {
      id: 'left',
      cc_position_number: 23,
      note_range_min: 21,
      note_range_max: 72,
      hand_span_semitones: 14,
      polyphony: 5,
      finger_min_interval_ms: 40,
      hand_move_semitones_per_sec: 60
    },
    {
      id: 'right',
      cc_position_number: 24,
      note_range_min: 48,
      note_range_max: 108,
      hand_span_semitones: 14,
      polyphony: 5,
      finger_min_interval_ms: 40,
      hand_move_semitones_per_sec: 60
    }
  ]
};

const note = (time, pitch, hand, extra = {}) => ({
  time, note: pitch, channel: 0, velocity: 80, hand, ...extra
});

describe('HandPositionPlanner — basic emission', () => {
  test('emits initial CC just before first note per hand', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const { ccEvents } = p.plan([note(1.0, 40, 'left'), note(1.0, 72, 'right')]);
    // One CC per hand.
    expect(ccEvents).toHaveLength(2);
    const left = ccEvents.find(e => e.hand === 'left');
    const right = ccEvents.find(e => e.hand === 'right');
    expect(left.controller).toBe(23);
    expect(left.value).toBe(40);
    expect(left.time).toBeLessThan(1.0);
    expect(right.controller).toBe(24);
    expect(right.value).toBe(72);
    expect(right.time).toBeLessThan(1.0);
  });

  test('no CC shift when consecutive notes stay inside the window', () => {
    const p = new HandPositionPlanner(pianoCfg);
    // Left hand walking around C3 (48) — stays within 14-semitone span.
    const notes = [
      note(0.0, 48, 'left'),
      note(0.5, 52, 'left'),
      note(1.0, 55, 'left'),
      note(1.5, 60, 'left')
    ];
    const { ccEvents, stats } = p.plan(notes);
    // Only the initial CC.
    expect(ccEvents).toHaveLength(1);
    expect(stats.shifts.left).toBe(1);
  });

  test('shifts window when next note goes above span', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const notes = [
      note(0.0, 48, 'left'),
      note(2.0, 70, 'left')  // +22 semitones > span 14 → shift
    ];
    const { ccEvents, stats } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    expect(stats.shifts.left).toBe(2);
    // Monophonic shift up: anchor CC at the note itself.
    expect(ccEvents[1].value).toBe(70);
  });

  test('shift for a chord anchors so the chord fits at the top of the window', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const notes = [
      note(0.0, 40, 'left'),
      note(5.0, 62, 'left'),
      note(5.0, 68, 'left') // chord width 6 → fits in span 14; top at 68
    ];
    const { ccEvents } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    // Anchor = max(groupLow=62, groupHigh-span=68-14=54) = 62.
    expect(ccEvents[1].value).toBe(62);
  });

  test('shifts window when next note goes below window', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const notes = [
      note(0.0, 60, 'left'),
      note(2.0, 40, 'left')
    ];
    const { ccEvents } = p.plan(notes);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents[1].value).toBe(40);
  });

  test('CC value is always the anchor lowest note, raw (0-127)', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const { ccEvents } = p.plan([note(0, 21, 'left')]);
    expect(ccEvents[0].value).toBe(21);
  });
});

describe('HandPositionPlanner — chord handling', () => {
  test('simultaneous notes on same hand merge into one chord group', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const chord = [48, 52, 55].map(pitch => note(0, pitch, 'left'));
    const { ccEvents, stats } = p.plan(chord);
    // One CC for the initial placement of the chord.
    expect(ccEvents).toHaveLength(1);
    expect(stats.shifts.left).toBe(1);
    expect(ccEvents[0].value).toBe(48);
  });

  test('interleaved L/R at same time produces two CCs (one per hand)', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(0, 40, 'left'),
      note(0, 72, 'right'),
      note(0, 45, 'left'),   // still left-hand chord
      note(0, 76, 'right')
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(2);
    expect(ccEvents.find(e => e.hand === 'left').value).toBe(40);
    expect(ccEvents.find(e => e.hand === 'right').value).toBe(72);
  });

  test('chord wider than span flags chord_span_exceeded', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(0, 40, 'left'),
      note(0, 60, 'left')  // span 20 > 14
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'chord_span_exceeded')).toBe(true);
  });
});

describe('HandPositionPlanner — feasibility warnings', () => {
  test('move_too_fast fires when shift does not fit in available time', () => {
    const p = new HandPositionPlanner(pianoCfg);
    // 20-semitone shift at 60 semitones/sec needs 333ms. We give 50ms.
    const events = [
      note(0.0, 40, 'left'),
      note(0.05, 60, 'left')
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'move_too_fast')).toBe(true);
  });

  test('move_too_fast does not fire when there is enough time', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(0.0, 40, 'left'),
      note(5.0, 60, 'left')
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'move_too_fast')).toBe(false);
  });

  test('overpolyphony_hand fires when chord exceeds fingers', () => {
    const p = new HandPositionPlanner(pianoCfg);
    // 6 simultaneous notes on one hand (>5 fingers default).
    const chord = [48, 50, 52, 54, 56, 58].map(pitch => note(0, pitch, 'left'));
    const { warnings } = p.plan(chord);
    expect(warnings.some(w => w.code === 'overpolyphony_hand')).toBe(true);
  });

  test('finger_interval_violated fires when two notes are too close', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(0.000, 48, 'left'),
      note(0.010, 50, 'left')  // 10ms < 40ms min
    ];
    const { warnings } = p.plan(events);
    expect(warnings.some(w => w.code === 'finger_interval_violated')).toBe(true);
  });

  test('out_of_range fires for notes outside hand reach', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(0, 20, 'left'),  // below min 21
      note(1, 80, 'left')   // above max 72
    ];
    const { warnings } = p.plan(events);
    const codes = warnings.map(w => w.code);
    expect(codes.filter(c => c === 'out_of_range').length).toBe(2);
  });
});

describe('HandPositionPlanner — CC emission timing', () => {
  test('subsequent shift CC is scheduled right after previous note-on', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      note(1.0, 40, 'left'),
      note(5.0, 70, 'left')
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(2);
    // Second CC right after first note (at 1.0), not just before the new one.
    expect(ccEvents[1].time).toBeGreaterThan(1.0);
    expect(ccEvents[1].time).toBeLessThan(1.01);
  });

  test('first CC per hand is emitted just before the first note', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [note(2.0, 60, 'left')];
    const { ccEvents } = p.plan(events);
    expect(ccEvents[0].time).toBeLessThan(2.0);
    expect(ccEvents[0].time).toBeGreaterThan(1.99);
  });
});

describe('HandPositionPlanner — edge cases', () => {
  test('empty notes list returns empty plan', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const { ccEvents, warnings } = p.plan([]);
    expect(ccEvents).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('note with unknown hand id is skipped (defensive)', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const { ccEvents } = p.plan([note(0, 60, 'middle')]);
    expect(ccEvents).toHaveLength(0);
  });

  test('velocity-0 note-ons (logical note-offs) are ignored', () => {
    const p = new HandPositionPlanner(pianoCfg);
    const events = [
      { time: 0, note: 60, hand: 'right', channel: 0, velocity: 0 }
    ];
    const { ccEvents } = p.plan(events);
    expect(ccEvents).toHaveLength(0);
  });
});
