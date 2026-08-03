// tests/frontend/keyboard/swipe-tracker.test.js
// Unit tests for SwipeTracker — pure module, no DOM.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(rel) {
  const src = readFileSync(resolve(__dirname, rel), 'utf8');
  new Function('window', src)(win);
}
beforeAll(() => {
  load('../../../public/js/features/keyboard/SwipeTracker.js');
});

const SwipeTracker = () => win.SwipeTracker;

/**
 * Build a tracker + recording sink with a hit-test that maps a 1D x
 * coordinate to a "key" at index Math.floor(x / 10) on a 100-key array.
 * Each cell is 10 px wide; key index is the note number; key DOM is
 * just the index (for assertion identity).
 */
function makeSink({ rafThrottle = false, disabledNotes = [] } = {}) {
  const events = []; // { type: 'on'|'off', note, key, pointer }
  const disabled = new Set(disabledNotes);
  const tracker = new (SwipeTracker())({
    hitTest: (x, _y) => {
      if (x < 0 || x >= 1000) return null; // outside keyboard
      const note = Math.floor(x / 10);
      if (disabled.has(note)) return null; // simulate .disabled key
      return { note, key: `key-${note}` };
    },
    onNoteOn: (note, key, pointer) => events.push({ type: 'on', note, key, pointer }),
    onNoteOff: (note, key, pointer) => events.push({ type: 'off', note, key, pointer }),
    rafThrottle,
    // Synchronous frame for deterministic tests.
    requestFrame: (cb) => cb()
  });
  return { tracker, events };
}

describe('SwipeTracker — construction', () => {
  it('requires hitTest + onNoteOn + onNoteOff', () => {
    let err = null;
    try {
      new (SwipeTracker())({});
    } catch (e) {
      err = e;
    }
    expect(err).not.toBe(null);
  });

  it('starts with 0 active pointers', () => {
    const { tracker } = makeSink();
    expect(tracker.activePointerCount).toBe(0);
  });
});

describe('SwipeTracker — basic lifecycle', () => {
  it('start emits a single note-on on the initial key', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50); // key 3
    expect(events).toEqual([{ type: 'on', note: 3, key: 'key-3', pointer: 1 }]);
    expect(tracker.activePointerCount).toBe(1);
  });

  it('end emits one note-off on the active key', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.end(1);
    expect(events).toEqual([{ type: 'off', note: 3, key: 'key-3', pointer: 1 }]);
    expect(tracker.activePointerCount).toBe(0);
  });

  it('end without a prior start is a no-op', () => {
    const { tracker, events } = makeSink();
    tracker.end(99);
    expect(events).toEqual([]);
  });
});

describe('SwipeTracker — move semantics', () => {
  it('move on the same key emits no event', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.move(1, 37, 50);
    tracker.move(1, 39, 50);
    expect(events).toEqual([]);
  });

  it('move onto adjacent key emits off-then-on in that order', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50); // key 3
    events.length = 0;
    tracker.move(1, 45, 50); // key 4
    expect(events).toEqual([
      { type: 'off', note: 3, key: 'key-3', pointer: 1 },
      { type: 'on', note: 4, key: 'key-4', pointer: 1 }
    ]);
  });

  it('move that skips 3 keys in one sample (the bug case) emits a single transition', () => {
    // Mouse went from x=35 (key 3) to x=85 (key 8) between two browser
    // samples. Strict policy: we emit off(3) + on(8), NOT the 4..7
    // intermediate notes.
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.move(1, 85, 50);
    expect(events).toEqual([
      { type: 'off', note: 3, key: 'key-3', pointer: 1 },
      { type: 'on', note: 8, key: 'key-8', pointer: 1 }
    ]);
  });

  it('move outside the keyboard releases the active note without a new note-on', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.move(1, -100, 50);
    expect(events).toEqual([{ type: 'off', note: 3, key: 'key-3', pointer: 1 }]);
  });

  it('re-entry after exit emits a note-on without orphan note-off', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    tracker.move(1, -100, 50); // exit
    events.length = 0;
    tracker.move(1, 75, 50); // re-enter on key 7
    expect(events).toEqual([{ type: 'on', note: 7, key: 'key-7', pointer: 1 }]);
  });

  it('move without prior start is ignored', () => {
    const { tracker, events } = makeSink();
    tracker.move(1, 50, 50);
    expect(events).toEqual([]);
    expect(tracker.activePointerCount).toBe(0);
  });

  it('start on a non-key position registers the pointer but emits nothing', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, -100, 50);
    expect(events).toEqual([]);
    expect(tracker.activePointerCount).toBe(1);
    // Subsequent move onto a key emits note-on.
    tracker.move(1, 25, 50);
    expect(events).toEqual([{ type: 'on', note: 2, key: 'key-2', pointer: 1 }]);
  });
});

describe('SwipeTracker — end / cancel', () => {
  it('end after a move emits a final note-off on the most recent key', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    tracker.move(1, 85, 50);
    events.length = 0;
    tracker.end(1);
    expect(events).toEqual([{ type: 'off', note: 8, key: 'key-8', pointer: 1 }]);
  });

  it('end outside any key still cleans up state silently', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    tracker.move(1, -100, 50); // off emitted here
    events.length = 0;
    tracker.end(1);
    expect(events).toEqual([]);
    expect(tracker.activePointerCount).toBe(0);
  });

  it('cancel behaves like end', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.cancel(1);
    expect(events).toEqual([{ type: 'off', note: 3, key: 'key-3', pointer: 1 }]);
  });

  it('endAll releases every pointer', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    tracker.start(2, 85, 50);
    events.length = 0;
    tracker.endAll();
    expect(events.length).toBe(2);
    expect(tracker.activePointerCount).toBe(0);
  });

  it('start on the same pointerId twice releases the previous note first', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    events.length = 0;
    tracker.start(1, 85, 50);
    expect(events).toEqual([
      { type: 'off', note: 3, key: 'key-3', pointer: 1 },
      { type: 'on', note: 8, key: 'key-8', pointer: 1 }
    ]);
    expect(tracker.activePointerCount).toBe(1);
  });
});

describe('SwipeTracker — multi-pointer', () => {
  it('two pointers keep independent lastNote state', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50); // pointer 1 → key 3
    tracker.start(2, 85, 50); // pointer 2 → key 8
    events.length = 0;
    tracker.move(1, 45, 50); // pointer 1 → key 4
    tracker.move(2, 95, 50); // pointer 2 → key 9
    expect(events).toEqual([
      { type: 'off', note: 3, key: 'key-3', pointer: 1 },
      { type: 'on', note: 4, key: 'key-4', pointer: 1 },
      { type: 'off', note: 8, key: 'key-8', pointer: 2 },
      { type: 'on', note: 9, key: 'key-9', pointer: 2 }
    ]);
  });

  it('ending one pointer does not affect the other', () => {
    const { tracker, events } = makeSink();
    tracker.start(1, 35, 50);
    tracker.start(2, 85, 50);
    events.length = 0;
    tracker.end(1);
    expect(events).toEqual([{ type: 'off', note: 3, key: 'key-3', pointer: 1 }]);
    expect(tracker.activePointerCount).toBe(1);
  });
});

describe('SwipeTracker — disabled keys (hitTest returns null)', () => {
  it('treats disabled key like outside-keyboard: emits off but no on', () => {
    const { tracker, events } = makeSink({ disabledNotes: [4] });
    tracker.start(1, 35, 50); // key 3
    events.length = 0;
    tracker.move(1, 45, 50); // key 4 disabled → null
    expect(events).toEqual([{ type: 'off', note: 3, key: 'key-3', pointer: 1 }]);
  });
});

describe('SwipeTracker — rAF throttling', () => {
  it('with rafThrottle=true, bursts of move() collapse to one hit-test per frame', () => {
    let hitTestCalls = 0;
    let scheduled = null;
    const tracker = new (SwipeTracker())({
      hitTest: (x, _y) => {
        hitTestCalls++;
        if (x < 0 || x >= 1000) return null;
        const note = Math.floor(x / 10);
        return { note, key: `key-${note}` };
      },
      onNoteOn: () => {},
      onNoteOff: () => {},
      rafThrottle: true,
      // Capture the callback so we control when the "frame" runs.
      requestFrame: (cb) => {
        scheduled = cb;
      }
    });
    tracker.start(1, 35, 50); // synchronous hit-test
    expect(hitTestCalls).toBe(1);

    // 5 move()s in the same "frame" → one schedule, one flush.
    tracker.move(1, 45, 50);
    tracker.move(1, 55, 50);
    tracker.move(1, 65, 50);
    tracker.move(1, 75, 50);
    tracker.move(1, 85, 50);
    expect(hitTestCalls).toBe(1); // not yet flushed

    // Run the deferred frame: only one extra hit-test on the latest x.
    scheduled();
    expect(hitTestCalls).toBe(2);
  });

  it('synchronous mode (rafThrottle=false) hit-tests every move', () => {
    let hitTestCalls = 0;
    const tracker = new (SwipeTracker())({
      hitTest: (x, _y) => {
        hitTestCalls++;
        const note = Math.floor(x / 10);
        return { note, key: `key-${note}` };
      },
      onNoteOn: () => {},
      onNoteOff: () => {},
      rafThrottle: false
    });
    tracker.start(1, 35, 50);
    tracker.move(1, 45, 50);
    tracker.move(1, 55, 50);
    expect(hitTestCalls).toBe(3);
  });
});
