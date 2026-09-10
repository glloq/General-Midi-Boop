/**
 * @file public/js/features/transport/PlaybackResync.js
 * @description R20 / F-94 — reconcile the SPA's transport with the server's
 * real playback state at every (re)connection.
 *
 * Playback lives in the backend, on purpose: reloading the browser does not
 * stop the orchestra, which is exactly what you want on a stage appliance.
 * What you do NOT want is what the browser E2E harness measured before R20 —
 * the reloaded SPA came back believing nothing was playing: no file name, no
 * position, and a **disabled Stop button**. The music kept going and the only
 * way to silence it was to kill the service.
 *
 * This module holds the decision logic, deliberately free of DOM and of the
 * SPA's globals so it can be tested on its own:
 *
 *   - `remember()` / `read()` / `forget()` — a small note in `localStorage` of
 *     what THIS browser started. It exists only because `playback_status` does
 *     not carry the file identity yet (`MidiPlayer.getStatus()` knows
 *     `loadedFileId` but does not return it — one-line server diff proposed in
 *     `docs/audit/2026-09-07/WAVE4_R20.md`).
 *   - `plan(status, cached)` — what the header must show.
 *
 * **The server always wins on _whether_ something is playing.** The local note
 * is consulted only for the file's _name_, and only when it is consistent with
 * the duration the server reports — so a playback started from another tablet
 * can never be mislabelled with this browser's last file. When the identity
 * cannot be established the transport is still restored (`identity:
 * 'unknown'`): being able to stop the sound matters more than naming it.
 */
(function () {
  'use strict';

  /** localStorage key holding this browser's "what I started" note. */
  const STORAGE_KEY = 'gmboop_now_playing';

  /** Beyond this age a note is not trusted to describe what is playing now. */
  const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  /** Duration agreement (seconds) required before a note names the file. */
  const DEFAULT_DURATION_TOLERANCE_S = 1.5;

  /** Below this age a `remember()` of the same file is a no-op (write churn). */
  const DEFAULT_REFRESH_AFTER_MS = 30 * 1000;

  /**
   * @param {any} value
   * @returns {number} a finite, non-negative number — 0 for anything else.
   */
  function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * @param {any} value
   * @returns {boolean} true when the value can identify a file.
   */
  function hasIdentity(value) {
    return value !== undefined && value !== null && value !== '';
  }

  /**
   * Resolve the storage to use. A browser in private mode can throw on the
   * mere access to `localStorage`, so every use goes through here.
   *
   * @param {{storage?:Object}} [opts]
   * @returns {?Object} a Storage-like object, or null when unavailable.
   */
  function resolveStorage(opts) {
    if (opts && opts.storage) return opts.storage;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Read this browser's note about what it started.
   *
   * @param {{storage?:Object}} [opts]
   * @returns {?{fileId:(string|number), filename:?string, duration:number, at:number}}
   */
  function read(opts) {
    const storage = resolveStorage(opts);
    if (!storage) return null;
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (_e) {
      return null;
    }
    if (!raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || !hasIdentity(parsed.fileId)) return null;
    return {
      fileId: parsed.fileId,
      filename: typeof parsed.filename === 'string' && parsed.filename ? parsed.filename : null,
      duration: positiveNumber(parsed.duration),
      at: Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0
    };
  }

  /**
   * Note what this browser just started playing.
   *
   * Idempotent on purpose: the playback status broadcast arrives several times
   * a second, and rewriting the same note that often would be pointless I/O.
   *
   * @param {{fileId:(string|number), filename?:?string, duration?:number}} entry
   * @param {{storage?:Object, now?:number, refreshAfterMs?:number}} [opts]
   * @returns {?Object} the entry written, or null when nothing was written.
   */
  function remember(entry, opts) {
    if (!entry || !hasIdentity(entry.fileId)) return null;
    const storage = resolveStorage(opts);
    if (!storage) return null;
    const now = opts && opts.now !== undefined ? opts.now : Date.now();
    const refreshAfterMs =
      opts && opts.refreshAfterMs !== undefined ? opts.refreshAfterMs : DEFAULT_REFRESH_AFTER_MS;
    const filename = typeof entry.filename === 'string' && entry.filename ? entry.filename : null;
    const duration = positiveNumber(entry.duration);

    const previous = read(opts);
    if (
      previous &&
      String(previous.fileId) === String(entry.fileId) &&
      previous.filename === filename &&
      previous.duration === duration &&
      now - previous.at < refreshAfterMs
    ) {
      return null;
    }

    const written = { fileId: entry.fileId, filename, duration, at: now };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(written));
    } catch (_e) {
      return null;
    }
    return written;
  }

  /**
   * Drop the note.
   * @param {{storage?:Object}} [opts]
   * @returns {void}
   */
  function forget(opts) {
    const storage = resolveStorage(opts);
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (_e) {
      /* nothing to clean up */
    }
  }

  /**
   * Is the local note trustworthy enough to name what the server is playing?
   *
   * @param {?Object} cached
   * @param {{now:number, maxAgeMs:number, toleranceS:number, duration:number}} ctx
   * @returns {boolean}
   */
  function noteMatches(cached, ctx) {
    if (!cached || !hasIdentity(cached.fileId)) return false;
    // A note from another session (or from a clock that jumped) says nothing
    // about the piece playing right now.
    if (cached.at > 0 && ctx.now - cached.at > ctx.maxAgeMs) return false;
    // The strong check: two different files rarely share a duration to the
    // second. When both durations are known they must agree, otherwise the
    // server is playing something this browser did not start.
    if (cached.duration > 0 && ctx.duration > 0) {
      return Math.abs(cached.duration - ctx.duration) <= ctx.toleranceS;
    }
    return true;
  }

  /**
   * Decide what the transport must show, given the server's answer to
   * `playback_status` and this browser's note.
   *
   * @param {?Object} status raw `playback_status` payload.
   * @param {?Object} [cached] result of {@link read}.
   * @param {{now?:number, maxAgeMs?:number, durationToleranceS?:number}} [opts]
   * @returns {{active:boolean, playing:boolean, paused:boolean,
   *   fileId:?(string|number), filename:?string, position:number,
   *   duration:number, tempo:?number, identity:('backend'|'cache'|'unknown'|'none')}}
   */
  function plan(status, cached, opts) {
    const options = opts || {};
    const now = options.now !== undefined ? options.now : Date.now();
    const maxAgeMs = options.maxAgeMs !== undefined ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
    const toleranceS =
      options.durationToleranceS !== undefined
        ? options.durationToleranceS
        : DEFAULT_DURATION_TOLERANCE_S;

    const s = status && typeof status === 'object' ? status : null;
    // `playing` stays true while paused (MidiPlayer.pause() only raises
    // `paused`), so "the backend holds a live transport" is exactly
    // `playing === true`. Anything else — false, missing, a truthy string —
    // means there is nothing to take back control of.
    const active = !!s && s.playing === true;
    const paused = active && s.paused === true;
    const duration = s ? positiveNumber(s.duration) : 0;
    const rawPosition = s ? positiveNumber(s.position) : 0;
    const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition;
    const tempoNumber = s ? Number(s.tempo) : NaN;
    const tempo = Number.isFinite(tempoNumber) && tempoNumber > 0 ? tempoNumber : null;

    const result = {
      active,
      playing: active && !paused,
      paused,
      fileId: null,
      filename: null,
      position,
      duration,
      tempo,
      identity: 'none'
    };
    if (!active) return result;

    // 1. The server names the file. `getStatus()` does not do it today; when
    //    it does, this branch takes over from the local note with no further
    //    change to the client.
    if (hasIdentity(s.fileId)) {
      result.fileId = s.fileId;
      result.identity = 'backend';
      if (typeof s.filename === 'string' && s.filename) {
        result.filename = s.filename;
      } else if (cached && String(cached.fileId) === String(s.fileId) && cached.filename) {
        result.filename = cached.filename;
      }
      return result;
    }

    // 2. Fall back to what this browser noted when it hit Play.
    if (noteMatches(cached, { now, maxAgeMs, toleranceS, duration })) {
      result.fileId = cached.fileId;
      result.filename = cached.filename || null;
      result.identity = 'cache';
      return result;
    }

    // 3. Something is playing and we cannot say what. The transport is still
    //    restored — Stop must work even when the label cannot be filled in.
    result.identity = 'unknown';
    return result;
  }

  const PlaybackResync = {
    STORAGE_KEY,
    DEFAULT_MAX_AGE_MS,
    DEFAULT_DURATION_TOLERANCE_S,
    DEFAULT_REFRESH_AFTER_MS,
    read,
    remember,
    forget,
    plan
  };

  if (typeof window !== 'undefined') {
    window.PlaybackResync = PlaybackResync;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaybackResync;
  }
})();
