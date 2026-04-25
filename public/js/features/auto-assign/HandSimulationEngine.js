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
(function() {
    'use strict';

    const DEFAULT_TICKS_PER_BEAT = 480;
    const DEFAULT_BPM = 120;

    class HandSimulationEngine extends EventTarget {
        constructor(opts = {}) {
            super();
            this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
            this.instrument = opts.instrument || null;
            this.ticksPerBeat = Number.isFinite(opts.ticksPerBeat) && opts.ticksPerBeat > 0
                ? opts.ticksPerBeat : DEFAULT_TICKS_PER_BEAT;
            this.bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : DEFAULT_BPM;
            this.overrides = opts.overrides || null;

            // DI for tests: inject a clock + raf shim. Defaults pull
            // from window so production stays self-contained.
            this._now = opts.now || (typeof performance !== 'undefined' && performance.now
                ? performance.now.bind(performance)
                : Date.now);
            this._raf = opts.requestAnimationFrame
                || (typeof window !== 'undefined' && window.requestAnimationFrame
                    ? window.requestAnimationFrame.bind(window)
                    : (cb) => setTimeout(() => cb(this._now()), 16));
            this._caf = opts.cancelAnimationFrame
                || (typeof window !== 'undefined' && window.cancelAnimationFrame
                    ? window.cancelAnimationFrame.bind(window)
                    : clearTimeout);

            // Pre-compute the timeline; if the simulator helper isn't
            // available (e.g. tests forgot to expose it) fall back to a
            // pass-through that just emits chords without windows.
            const simulator = opts.simulator
                || (typeof window !== 'undefined' ? window.HandPositionFeasibility : null);
            this._timeline = simulator?.simulateHandWindows
                ? simulator.simulateHandWindows(this.notes, this.instrument || {}, { overrides: this.overrides })
                : this.notes
                    .slice()
                    .sort((a, b) => a.tick - b.tick)
                    .map(n => ({ type: 'chord', tick: n.tick, notes: [n], unplayable: [] }));

            this.totalTicks = this.notes.length > 0
                ? Math.max(...this.notes.map(n => n.tick))
                : 0;

            this._currentTick = 0;
            this._cursor = 0; // index of next event to emit (stable per `seek` reset)
            this._playing = false;
            this._lastFrameNow = 0;
            this._rafHandle = null;
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

    if (typeof window !== 'undefined') {
        window.HandSimulationEngine = HandSimulationEngine;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HandSimulationEngine;
    }
})();
