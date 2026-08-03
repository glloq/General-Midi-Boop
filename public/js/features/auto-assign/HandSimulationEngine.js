/**
 * @file HandSimulationEngine.js
 * @description Client-side scheduler that "plays" a channel's notes
 * against the routed instrument's hand-position model. Visualization-
 * only — no MIDI is emitted, no hardware is touched. The engine is
 * the bridge between the static `simulateHandWindows()` timeline
 * (E.6.2) and the live UI components (E.6.4 keyboard, E.6.5 look-
 * ahead, FretboardDiagram already wired in C.4).
 *
 * Design choices:
 *   - Pure EventTarget — no framework dependency. Listeners attach
 *     via `engine.on('tick', fn)` (alias for addEventListener).
 *   - Time advance via requestAnimationFrame; in tests we accept an
 *     injected `now()` clock so jest fake timers can drive the loop.
 *   - The simulation timeline is precomputed at `start()` time (cheap
 *     since we already have all notes in memory) so each tick is an
 *     O(log n) lookup, not a re-walk.
 *
 * Public API:
 *   const engine = new HandSimulationEngine({
 *     notes,            // [{tick, note, fret?, string?, channel?}]
 *     instrument,       // { hands_config, scale_length_mm? }
 *     ticksPerBeat,     // from midiData.header
 *     bpm,              // float
 *     overrides,        // optional, see E.6.1 schema
 *     simulator         // optional injected: window.HandPositionFeasibility
 *   });
 *   engine.on('tick', ({currentTick, currentSec, totalTicks}) => {});
 *   engine.on('chord', ({tick, notes, unplayable}) => {});
 *   engine.on('shift', ({tick, handId, fromAnchor, toAnchor, source}) => {});
 *   engine.on('end', () => {});
 *   engine.play();
 *   engine.pause();
 *   engine.seek(tick);   // jumps without re-emitting passed events
 *   engine.reset();      // returns to tick 0 + clears window state
 *   engine.dispose();
 */
(function () {
  'use strict';

  const DEFAULT_TICKS_PER_BEAT = 480;
  const DEFAULT_BPM = 120;

  // Resolve the directory this script was served from so the worker
  // (a sibling file) is reachable wherever the app is mounted. Null
  // in non-browser test envs (node/jsdom) — those take the synchronous
  // path automatically since `Worker` is undefined there.
  const _SCRIPT_DIR =
    typeof document !== 'undefined' && document.currentScript && document.currentScript.src
      ? document.currentScript.src.replace(/[^/]+$/, '')
      : null;

  // Absolute URL of the already-loaded HandPositionFeasibility
  // solver. Prefer the real <script> tag (survives bundler filename
  // hashing, e.g. `HandPositionFeasibility-ab12.js`); fall back to
  // the sibling guess from this script's directory.
  function _resolveSolverUrl() {
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      for (const s of document.querySelectorAll('script[src]')) {
        if (/HandPositionFeasibility[^/]*\.js(\?|$)/.test(s.src)) return s.src;
      }
    }
    return _SCRIPT_DIR ? _SCRIPT_DIR + 'HandPositionFeasibility.js' : null;
  }

  class HandSimulationEngine extends EventTarget {
    constructor(opts = {}) {
      super();
      this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
      this.instrument = opts.instrument || null;
      this.ticksPerBeat =
        Number.isFinite(opts.ticksPerBeat) && opts.ticksPerBeat > 0
          ? opts.ticksPerBeat
          : DEFAULT_TICKS_PER_BEAT;
      this.bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : DEFAULT_BPM;
      this.overrides = opts.overrides || null;

      // DI for tests: inject a clock + raf shim. Defaults pull
      // from window so production stays self-contained.
      this._now =
        opts.now ||
        (typeof performance !== 'undefined' && performance.now
          ? performance.now.bind(performance)
          : Date.now);
      this._raf =
        opts.requestAnimationFrame ||
        (typeof window !== 'undefined' && window.requestAnimationFrame
          ? window.requestAnimationFrame.bind(window)
          : (cb) => setTimeout(() => cb(this._now()), 16));
      this._caf =
        opts.cancelAnimationFrame ||
        (typeof window !== 'undefined' && window.cancelAnimationFrame
          ? window.cancelAnimationFrame.bind(window)
          : clearTimeout);

      this.totalTicks = this.notes.length > 0 ? Math.max(...this.notes.map((n) => n.tick)) : 0;

      this._currentTick = 0;
      this._cursor = 0; // index of next event to emit (stable per `seek` reset)
      this._playing = false;
      this._lastFrameNow = 0;
      this._rafHandle = null;

      // Timeline readiness: callers may attach listeners / drive
      // playback before the (potentially off-thread) computation
      // lands. Until then `_timeline` is empty — every reader
      // (`_drainUpTo`, `getHandTrajectories`, `getTimeline`)
      // already degrades to a no-op on an empty array, so the UI
      // simply shows nothing until the `ready` event fires.
      this._timeline = [];
      this._ready = false;
      this._worker = null;
      this._readyResolve = null;
      this._readyPromise = new Promise((res) => {
        this._readyResolve = res;
      });

      // Per-(channel,instrument,transpose,overrides) result reuse.
      // A re-open of the same tuple skips the solver entirely.
      this._timelineCache = opts.timelineCache instanceof Map ? opts.timelineCache : null;
      this._cacheKey = typeof opts.cacheKey === 'string' ? opts.cacheKey : null;

      const passThrough = () =>
        this.notes
          .slice()
          .sort((a, b) => a.tick - b.tick)
          .map((n) => ({ type: 'chord', tick: n.tick, notes: [n], unplayable: [] }));

      const finish = (timeline) => {
        this._timeline = Array.isArray(timeline) ? timeline : passThrough();
        if (this._timelineCache && this._cacheKey) {
          this._timelineCache.set(this._cacheKey, this._timeline);
        }
        this._markReady();
      };

      // 1. Cache hit — instant, synchronous.
      if (this._timelineCache && this._cacheKey && this._timelineCache.has(this._cacheKey)) {
        this._timeline = this._timelineCache.get(this._cacheKey);
        // Defer the emit so listeners attached right after
        // construction (HandsPreviewPanel._wireEngine) still fire.
        Promise.resolve().then(() => this._markReady());
        return;
      }

      const injected = opts.simulator;
      const simulator =
        injected || (typeof window !== 'undefined' ? window.HandPositionFeasibility : null);

      // 2. Worker path — production browsers only. Disabled when a
      //    simulator is injected (tests), explicitly opted out, or
      //    `Worker`/script URL is unavailable (node/jsdom) so the
      //    test + SSR paths stay fully synchronous.
      const canWork =
        opts.useWorker !== false &&
        !injected &&
        typeof Worker !== 'undefined' &&
        _SCRIPT_DIR != null;
      if (canWork) {
        try {
          // Build the worker from a Blob that pulls in the
          // existing HandPositionFeasibility solver via its
          // absolute sibling URL. Going through a Blob (rather
          // than a standalone worker file) means nothing extra
          // has to be referenced from index.html / copied by
          // the bundler — only HandPositionFeasibility.js,
          // which the app already loads, must be reachable.
          // It is a browser IIFE that publishes itself on
          // `window` and only touches `window.i18n` from
          // `renderBadge` (never from `simulateHandWindows`),
          // so a `self.window = self` shim loads it unchanged.
          const solverUrl = _resolveSolverUrl();
          if (!solverUrl) throw new Error('solver url unresolved');
          const hpfUrl = JSON.stringify(solverUrl);
          const src =
            'self.window=self;' +
            'try{importScripts(' +
            hpfUrl +
            ');}catch(err){' +
            'self.onmessage=function(e){self.postMessage({id:e&&e.data&&e.data.id,error:"import-failed"});};}' +
            'self.onmessage=function(e){var d=e&&e.data;if(!d)return;' +
            'try{var h=self.HandPositionFeasibility;' +
            'if(!h||typeof h.simulateHandWindows!=="function"){self.postMessage({id:d.id,error:"unavailable"});return;}' +
            'var t=h.simulateHandWindows(d.notes||[],d.instrument||{},d.options||{});' +
            'self.postMessage({id:d.id,timeline:t});}' +
            'catch(err){self.postMessage({id:d.id,error:(err&&err.message)||String(err)});}};';
          this._workerUrl = URL.createObjectURL(
            new Blob([src], { type: 'application/javascript' })
          );
          this._worker = new Worker(this._workerUrl);
          const jobId = ++HandSimulationEngine._jobSeq;
          this._worker.onmessage = (e) => {
            const d = e && e.data;
            if (!d || d.id !== jobId) return;
            if (d.error) {
              // Solver failed in the worker — degrade to the
              // pass-through so the UI still shows chords.
              finish(passThrough());
            } else {
              finish(d.timeline);
            }
            this._terminateWorker();
          };
          this._worker.onerror = () => {
            finish(passThrough());
            this._terminateWorker();
          };
          this._worker.postMessage({
            id: jobId,
            notes: this.notes,
            instrument: this.instrument || {},
            options: {
              overrides: this.overrides,
              ticksPerBeat: this.ticksPerBeat,
              bpm: this.bpm
            }
          });
          return;
        } catch (_) {
          // Worker construction blocked (CSP, etc.) — fall
          // through to the synchronous path below.
          this._worker = null;
        }
      }

      // 3. Synchronous path — tests, SSR, or worker unavailable.
      const timeline = simulator?.simulateHandWindows
        ? simulator.simulateHandWindows(this.notes, this.instrument || {}, {
            overrides: this.overrides,
            ticksPerBeat: this.ticksPerBeat,
            bpm: this.bpm
          })
        : passThrough();
      this._timeline = timeline;
      if (this._timelineCache && this._cacheKey) {
        this._timelineCache.set(this._cacheKey, this._timeline);
      }
      // Emit on a microtask so listeners attached immediately
      // after `new` (the common case) observe `ready` uniformly
      // with the async path.
      Promise.resolve().then(() => this._markReady());
    }

    _markReady() {
      if (this._ready) return;
      this._ready = true;
      if (this._readyResolve) this._readyResolve();
      this._emit('ready', { totalTicks: this.totalTicks });
    }

    _terminateWorker() {
      if (this._worker) {
        try {
          this._worker.terminate();
        } catch (_) {
          /* ignore */
        }
        this._worker = null;
      }
      if (this._workerUrl) {
        try {
          URL.revokeObjectURL(this._workerUrl);
        } catch (_) {
          /* ignore */
        }
        this._workerUrl = null;
      }
    }

    /** True once the timeline is computed and events are meaningful. */
    isReady() {
      return this._ready === true;
    }

    /** Resolves when the timeline is ready (immediately if already). */
    whenReady() {
      return this._readyPromise;
    }

    /** Convert a tick distance to seconds at the configured tempo. */
    ticksToSeconds(ticks) {
      return (ticks / this.ticksPerBeat) * (60 / this.bpm);
    }

    currentSec() {
      return this.ticksToSeconds(this._currentTick);
    }

    currentTick() {
      return this._currentTick;
    }

    get isPlaying() {
      return this._playing;
    }

    on(eventName, handler) {
      this.addEventListener(eventName, handler);
      return () => this.removeEventListener(eventName, handler);
    }

    _emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    /**
     * Walk the timeline from `_cursor` up to (and including) any
     * event at `targetTick`. Useful both for the rAF loop and for
     * `seek(tick)` which fast-forwards silently to the new
     * position before resuming.
     */
    _drainUpTo(targetTick, { silent = false } = {}) {
      while (this._cursor < this._timeline.length) {
        const ev = this._timeline[this._cursor];
        if (ev.tick > targetTick) break;
        if (!silent) this._emit(ev.type, ev);
        this._cursor++;
      }
    }

    /** Start advancing the playhead. No-op if already playing. */
    play() {
      if (this._playing) return;
      if (this._currentTick >= this.totalTicks && this.totalTicks > 0) {
        // Restart from the beginning when play() is called at end.
        this.reset();
      }
      this._playing = true;
      this._lastFrameNow = this._now();
      this._scheduleFrame();
    }

    /** Stop the rAF loop without resetting the playhead. */
    pause() {
      this._playing = false;
      if (this._rafHandle != null) {
        this._caf(this._rafHandle);
        this._rafHandle = null;
      }
    }

    /** Jump to `tick`. Drains passed events silently so the new
     *  hand state is consistent without spamming the UI. */
    seek(tick) {
      const safe = Math.max(0, Math.min(this.totalTicks, Math.round(tick) || 0));
      if (safe < this._currentTick) {
        // Backward seek: rewind cursor to the start, then drain
        // silently up to the target. Cheap because timeline is
        // already in memory.
        this._cursor = 0;
      }
      this._currentTick = safe;
      this._drainUpTo(safe, { silent: true });
      this._emit('tick', {
        currentTick: this._currentTick,
        currentSec: this.currentSec(),
        totalTicks: this.totalTicks
      });
    }

    /**
     * Externally-driven advance. Walks from current to `tick`
     * EMITTING every chord/shift event in between so a host that
     * already owns a clock (e.g. RoutingSummaryPage's audio
     * preview) can drive the visualization without spinning our
     * own rAF loop. Backward jumps fall back to silent seek.
     */
    advanceTo(tick) {
      const safe = Math.max(0, Math.min(this.totalTicks, Math.round(tick) || 0));
      if (safe < this._currentTick) {
        this.seek(safe);
        return;
      }
      this._currentTick = safe;
      this._drainUpTo(safe, { silent: false });
      this._emit('tick', {
        currentTick: this._currentTick,
        currentSec: this.currentSec(),
        totalTicks: this.totalTicks
      });
      if (safe >= this.totalTicks && this.totalTicks > 0) {
        this._emit('end', { totalTicks: this.totalTicks });
      }
    }

    /** Convenience wrapper for callers that work in seconds. */
    advanceToSec(sec) {
      const ticksPerSec = this.ticksPerBeat * (this.bpm / 60);
      this.advanceTo(sec * ticksPerSec);
    }

    /**
     * Build a per-hand trajectory from the precomputed timeline:
     *
     *   Map<handId, [{tick, anchor, prevAnchor, releaseTick, motion}]>
     *
     * Each trajectory point describes a shift the simulator emitted:
     *   - `tick` / `anchor`: when the hand arrives at this position.
     *   - `prevAnchor`: the position the hand came from (= the
     *     shift's `fromAnchor`).
     *   - `releaseTick`: when THIS hand's notes in the matching
     *     chord stop ringing (per-hand from `chord.releaseByHand`,
     *     falling back to chord-wide release, then to `tick`).
     *   - `motion`: `{ requiredSec, availableSec, feasible }` —
     *     the speed-limit envelope for the travel.
     *
     * The lookahead strip uses these fields to hold the band on
     * the previous anchor until `prevPoint.releaseTick`, then
     * slide diagonally to the new anchor — and to colour the
     * transition red when `motion.feasible === false`.
     *
     * @returns {Map<string, Array<{tick:number, anchor:number,
     *                              prevAnchor:number, releaseTick:number,
     *                              motion:{requiredSec:number,
     *                                      availableSec:number,
     *                                      feasible:boolean}}>>}
     */
    /** Read-only access to the precomputed event timeline. */
    getTimeline() {
      return this._timeline || [];
    }

    getHandTrajectories() {
      // Index chords by tick so each shift can look up its
      // matching chord's per-hand release time in O(1).
      const chordsByTick = new Map();
      for (const ev of this._timeline) {
        if (ev.type === 'chord') chordsByTick.set(ev.tick, ev);
      }
      const out = new Map();
      for (const ev of this._timeline) {
        if (ev.type !== 'shift' || ev.handId == null || !Number.isFinite(ev.toAnchor)) continue;
        if (!out.has(ev.handId)) out.set(ev.handId, []);
        const chord = chordsByTick.get(ev.tick);
        let releaseTick = ev.tick;
        if (chord) {
          if (chord.releaseByHand && Number.isFinite(chord.releaseByHand[ev.handId])) {
            releaseTick = chord.releaseByHand[ev.handId];
          } else if (Number.isFinite(chord.releaseTick)) {
            releaseTick = chord.releaseTick;
          }
        }
        const motion = ev.motion || { requiredSec: 0, availableSec: Infinity, feasible: true };
        out.get(ev.handId).push({
          tick: ev.tick,
          anchor: ev.toAnchor,
          prevAnchor: Number.isFinite(ev.fromAnchor) ? ev.fromAnchor : ev.toAnchor,
          releaseTick,
          motion
        });
      }
      // Sort defensively — the timeline is already ordered but
      // a future caller might inject extra entries.
      for (const points of out.values()) {
        points.sort((a, b) => a.tick - b.tick);
      }
      return out;
    }

    /** Return to tick 0 and clear cursor state. */
    reset() {
      this.pause();
      this._currentTick = 0;
      this._cursor = 0;
      this._emit('tick', { currentTick: 0, currentSec: 0, totalTicks: this.totalTicks });
    }

    /** Stop the engine and detach all listeners (best-effort). */
    dispose() {
      this.pause();
      this._terminateWorker();
      this._timeline = [];
      this.notes = [];
    }

    // -------------------------------------------------------------
    //  rAF-driven loop
    // -------------------------------------------------------------

    _scheduleFrame() {
      if (!this._playing) return;
      this._rafHandle = this._raf(() => this._onFrame());
    }

    _onFrame() {
      if (!this._playing) return;
      const now = this._now();
      const dtMs = Math.max(0, now - this._lastFrameNow);
      this._lastFrameNow = now;

      // Convert wall-clock ms → tick advance at current tempo.
      const ticksPerSec = this.ticksPerBeat * (this.bpm / 60);
      const advance = (dtMs / 1000) * ticksPerSec;
      const next = Math.min(this.totalTicks, this._currentTick + advance);
      this._currentTick = next;

      this._drainUpTo(this._currentTick, { silent: false });
      this._emit('tick', {
        currentTick: this._currentTick,
        currentSec: this.currentSec(),
        totalTicks: this.totalTicks
      });

      if (this._currentTick >= this.totalTicks) {
        this._playing = false;
        this._emit('end', { totalTicks: this.totalTicks });
        return;
      }
      this._scheduleFrame();
    }
  }

  // Monotonic id so a stale worker message from a disposed engine is
  // ignored (each engine instance owns exactly one job).
  HandSimulationEngine._jobSeq = 0;

  if (typeof window !== 'undefined') {
    window.HandSimulationEngine = HandSimulationEngine;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HandSimulationEngine;
  }
})();
