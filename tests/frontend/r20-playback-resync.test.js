// tests/frontend/r20-playback-resync.test.js
//
// Audit R20 — F-94: "reloading the page mid-playback: the orchestra keeps
// going, the UI loses every control".
//
// Playback lives in the backend, so a reload does not stop the music — that is
// a feature on a stage appliance. What was not a feature: the reloaded SPA came
// back believing nothing was playing, with Stop *disabled*, so the only way to
// silence the instruments was to kill the service.
//
// This suite pins the decision logic that closes the gap
// (public/js/features/transport/PlaybackResync.js):
//   - the server decides WHETHER something is playing, always;
//   - the browser's local note is only ever consulted for the file's NAME, and
//     only when it agrees with the duration the server reports — a playback
//     started from another tablet must never be mislabelled here;
//   - when the identity cannot be established the transport is STILL restored:
//     being able to stop the sound matters more than being able to name it.
//
// The proof that the assembled product recovers the transport is the browser
// scenario `tests/e2e/specs/04-resilience.spec.mjs`; a jsdom test can only show
// the logic is right.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();

/** A Storage-like double, so nothing here depends on jsdom's localStorage. */
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

/** A storage that throws on every access (Safari private mode, blocked cookies). */
const hostileStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  }
};

let PlaybackResync;

beforeEach(() => {
  delete window.PlaybackResync;
  evalFile('public/js/features/transport/PlaybackResync.js');
  PlaybackResync = window.PlaybackResync;
});

describe('R20 · PlaybackResync — the note this browser leaves about what it started', () => {
  it('exposes itself on window for the classic-script SPA', () => {
    expect(typeof PlaybackResync.plan).toBe('function');
    expect(typeof PlaybackResync.remember).toBe('function');
    expect(PlaybackResync.STORAGE_KEY).toBe('gmboop_now_playing');
  });

  it('remembers a file, reads it back, and forgets it', () => {
    const storage = fakeStorage();
    const written = PlaybackResync.remember(
      { fileId: 12, filename: 'ouverture.mid', duration: 128.5 },
      { storage, now: 1000 }
    );
    expect(written).toEqual({ fileId: 12, filename: 'ouverture.mid', duration: 128.5, at: 1000 });

    expect(PlaybackResync.read({ storage })).toEqual({
      fileId: 12,
      filename: 'ouverture.mid',
      duration: 128.5,
      at: 1000
    });

    PlaybackResync.forget({ storage });
    expect(PlaybackResync.read({ storage })).toBeNull();
  });

  it('does not rewrite the same note on every status broadcast', () => {
    const storage = fakeStorage();
    PlaybackResync.remember({ fileId: 3, filename: 'a.mid', duration: 10 }, { storage, now: 0 });
    // playback_status arrives several times a second: an unchanged note must
    // not mean a localStorage write each time.
    const again = PlaybackResync.remember(
      { fileId: 3, filename: 'a.mid', duration: 10 },
      { storage, now: 5000 }
    );
    expect(again).toBeNull();
    expect(PlaybackResync.read({ storage }).at).toBe(0);

    // …but a genuinely new duration (or a stale note) is written through.
    const updated = PlaybackResync.remember(
      { fileId: 3, filename: 'a.mid', duration: 11 },
      { storage, now: 5000 }
    );
    expect(updated.duration).toBe(11);
  });

  it('refuses to note anything without a file identity', () => {
    const storage = fakeStorage();
    expect(PlaybackResync.remember(null, { storage })).toBeNull();
    expect(PlaybackResync.remember({ filename: 'x.mid' }, { storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('survives corrupted, empty and hostile storage', () => {
    expect(PlaybackResync.read({ storage: fakeStorage({ gmboop_now_playing: '{oops' }) })).toBeNull();
    expect(PlaybackResync.read({ storage: fakeStorage({ gmboop_now_playing: '{}' }) })).toBeNull();
    expect(PlaybackResync.read({ storage: hostileStorage })).toBeNull();
    expect(PlaybackResync.remember({ fileId: 1 }, { storage: hostileStorage })).toBeNull();
    expect(() => PlaybackResync.forget({ storage: hostileStorage })).not.toThrow();
  });
});

describe('R20 · PlaybackResync.plan — the server decides what is playing', () => {
  const note = { fileId: 7, filename: 'e2e-two-channel.mid', duration: 15.98, at: 1_000_000 };
  const now = 1_000_500;

  it('treats a missing or malformed status as "nothing is playing"', () => {
    for (const status of [null, undefined, 'playing', 42, {}]) {
      const p = PlaybackResync.plan(status, note, { now });
      expect(p.active).toBe(false);
      expect(p.playing).toBe(false);
      expect(p.identity).toBe('none');
    }
  });

  it('never invents a playback from a truthy-but-not-true flag', () => {
    // The header must not claim the orchestra is running because a field was
    // the string "false" or the number 1.
    expect(PlaybackResync.plan({ playing: 'false' }, note, { now }).active).toBe(false);
    expect(PlaybackResync.plan({ playing: 1 }, note, { now }).active).toBe(false);
    expect(PlaybackResync.plan({ playing: true }, note, { now }).active).toBe(true);
  });

  it('restores a running transport from the local note', () => {
    const p = PlaybackResync.plan(
      { playing: true, paused: false, position: 6.15, duration: 15.98, tempo: 120 },
      note,
      { now }
    );
    expect(p).toEqual({
      active: true,
      playing: true,
      paused: false,
      fileId: 7,
      filename: 'e2e-two-channel.mid',
      position: 6.15,
      duration: 15.98,
      tempo: 120,
      identity: 'cache'
    });
  });

  it('keeps `playing` true and `paused` true apart (MidiPlayer.pause keeps playing)', () => {
    const p = PlaybackResync.plan(
      { playing: true, paused: true, position: 3, duration: 15.98 },
      note,
      { now }
    );
    expect(p.active).toBe(true);
    expect(p.playing).toBe(false);
    expect(p.paused).toBe(true);
    // Paused is still a live transport: Stop has to be offered.
    expect(p.identity).toBe('cache');
  });

  it('prefers the server when it names the file, and stays forward compatible', () => {
    // getStatus() does not return fileId today; the one-line server diff is in
    // WAVE4_R20.md. When it lands, the client must switch to it with no other
    // change — including for a file this browser never started.
    const p = PlaybackResync.plan(
      { playing: true, position: 1, duration: 300, fileId: 42, filename: 'symphonie.mid' },
      note,
      { now }
    );
    expect(p.identity).toBe('backend');
    expect(p.fileId).toBe(42);
    expect(p.filename).toBe('symphonie.mid');
  });

  it('completes a server-provided id with the local name when they are the same file', () => {
    const p = PlaybackResync.plan({ playing: true, duration: 15.98, fileId: '7' }, note, { now });
    expect(p.identity).toBe('backend');
    expect(p.filename).toBe('e2e-two-channel.mid');
  });

  it('refuses to label a playback whose duration contradicts the note', () => {
    // Another operator started a different piece from another tablet: the
    // transport must still be operable, but never under the wrong name.
    const p = PlaybackResync.plan({ playing: true, position: 4, duration: 240 }, note, { now });
    expect(p.active).toBe(true);
    expect(p.identity).toBe('unknown');
    expect(p.fileId).toBeNull();
    expect(p.filename).toBeNull();
  });

  it('refuses a note older than the trust window', () => {
    const stale = { ...note, at: 1 };
    const p = PlaybackResync.plan({ playing: true, duration: 15.98 }, stale, {
      now: 1 + PlaybackResync.DEFAULT_MAX_AGE_MS + 1
    });
    expect(p.identity).toBe('unknown');
  });

  it('accepts a note within the duration tolerance', () => {
    const p = PlaybackResync.plan({ playing: true, duration: 15.98 + 1 }, note, { now });
    expect(p.identity).toBe('cache');
  });

  it('normalises hostile numbers instead of propagating them into the header', () => {
    const p = PlaybackResync.plan(
      { playing: true, position: 'NaN', duration: -12, tempo: 0 },
      null,
      { now }
    );
    expect(p.position).toBe(0);
    expect(p.duration).toBe(0);
    expect(p.tempo).toBeNull();
    expect(p.identity).toBe('unknown');
  });

  it('clamps a position that overruns the duration', () => {
    const p = PlaybackResync.plan({ playing: true, position: 99, duration: 15.98 }, note, { now });
    expect(p.position).toBe(15.98);
  });

  it('reports the tempo so the playback popover comes back on the right value', () => {
    const p = PlaybackResync.plan({ playing: true, duration: 15.98, tempo: 96 }, note, { now });
    expect(p.tempo).toBe(96);
  });
});
