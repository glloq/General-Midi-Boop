// =============================================================================
// SwipeTracker.js — Pure helper: pointer drag → note-on/note-off transitions.
// =============================================================================
// Replaces the historical mouseenter/mouseleave delegation that missed
// keys during fast swipes (browser samples mouse position ~60 Hz; a fast
// drag can teleport across 5 keys between two samples, so mouseenter never
// fires on the intermediate elements).
//
// The tracker is hit-test driven: on every move sample it asks the caller
// "what key is at (x, y)?" via the injected hitTest function, compares
// with the last known key for that pointer, and emits transitions. Each
// sample re-evaluates the position with full DOM hit-testing, so the
// only theoretical limit is the browser's sample rate (typically 60 Hz),
// not the number of keys crossed between samples.
//
// Pure: no DOM, no globals. The integrator (KeyboardPiano._setupPianoDelegation)
// owns the DOM listeners and supplies hitTest/onNoteOn/onNoteOff callbacks.
// Multi-pointer aware (one independent state per pointerId) so touch with
// 2+ fingers works correctly.
//
// Throttling: a per-pointer requestAnimationFrame coalesces bursts of move
// events; the last (x, y) wins for that frame. Caller can disable by
// passing `rafThrottle: false` in the options (useful for tests).
// =============================================================================
(function () {
    'use strict';

    const _global = (typeof globalThis !== 'undefined' ? globalThis : null);

    class SwipeTracker {
        /**
         * @param {Object} opts
         * @param {(x:number, y:number) => ({note:number, key:HTMLElement}|null)} opts.hitTest
         *     Maps a screen position to the key currently under it.
         *     Return null when the point is not on a playable key.
         * @param {(note:number, key:HTMLElement, pointerId:number|string) => void} opts.onNoteOn
         *     Called when the tracker transitions to a new key for a pointer.
         * @param {(note:number, key:HTMLElement, pointerId:number|string) => void} opts.onNoteOff
         *     Called when the tracker leaves a key (transition or end/cancel).
         * @param {boolean} [opts.rafThrottle=true]
         *     When true (default), coalesce moves via requestAnimationFrame.
         * @param {Function} [opts.requestFrame]
         *     Inject requestAnimationFrame for tests. Defaults to the
         *     ambient `requestAnimationFrame` if available, otherwise a
         *     synchronous shim (no throttling).
         */
        constructor(opts) {
            if (!opts || typeof opts.hitTest !== 'function'
                || typeof opts.onNoteOn !== 'function'
                || typeof opts.onNoteOff !== 'function') {
                throw new Error('SwipeTracker: hitTest, onNoteOn, onNoteOff are required');
            }
            this._hitTest    = opts.hitTest;
            this._onNoteOn   = opts.onNoteOn;
            this._onNoteOff  = opts.onNoteOff;
            this._rafThrottle = opts.rafThrottle !== false;
            this._raf        = opts.requestFrame
                || (_global && typeof _global.requestAnimationFrame === 'function'
                    ? _global.requestAnimationFrame.bind(_global)
                    : (cb) => cb());
            // pointerId -> { lastNote, lastKey, pendingX, pendingY, rafScheduled }
            this._pointers   = new Map();
        }

        /** Start tracking a new pointer (mousedown / pointerdown / touchstart). */
        start(pointerId, x, y) {
            // Defensive: clean up any stale state for this pointerId.
            this._endInternal(pointerId);
            const hit = this._hitTest(x, y);
            const state = { lastNote: null, lastKey: null,
                            pendingX: x, pendingY: y, rafScheduled: false };
            this._pointers.set(pointerId, state);
            if (hit) {
                state.lastNote = hit.note;
                state.lastKey  = hit.key;
                this._onNoteOn(hit.note, hit.key, pointerId);
            }
        }

        /** Update a pointer's position. May emit a note-off + note-on if the
         *  underlying key changed since the last sample. */
        move(pointerId, x, y) {
            const state = this._pointers.get(pointerId);
            if (!state) return; // move without start = ignore
            state.pendingX = x;
            state.pendingY = y;
            if (!this._rafThrottle) {
                this._flush(pointerId);
                return;
            }
            if (state.rafScheduled) return;
            state.rafScheduled = true;
            this._raf(() => this._flush(pointerId));
        }

        _flush(pointerId) {
            const state = this._pointers.get(pointerId);
            if (!state) return;
            state.rafScheduled = false;
            const hit = this._hitTest(state.pendingX, state.pendingY);
            const newNote = hit ? hit.note : null;
            const newKey  = hit ? hit.key  : null;

            if (newNote === state.lastNote) {
                // Same key (or still no key): no transition.
                return;
            }
            // Transition: release old, attach new.
            if (state.lastNote !== null) {
                this._onNoteOff(state.lastNote, state.lastKey, pointerId);
            }
            state.lastNote = newNote;
            state.lastKey  = newKey;
            if (newNote !== null) {
                this._onNoteOn(newNote, newKey, pointerId);
            }
        }

        /** End a pointer tracking (mouseup / pointerup / touchend).
         *  Emits the final note-off if a note was active. */
        end(pointerId) {
            this._endInternal(pointerId);
        }

        /** Cancel a pointer (pointercancel / window blur). Same as end for
         *  now; kept distinct so callers can attach undo semantics later. */
        cancel(pointerId) {
            this._endInternal(pointerId);
        }

        _endInternal(pointerId) {
            const state = this._pointers.get(pointerId);
            if (!state) return;
            if (state.lastNote !== null) {
                this._onNoteOff(state.lastNote, state.lastKey, pointerId);
            }
            this._pointers.delete(pointerId);
        }

        /** Number of currently tracked pointers (tests / debugging). */
        get activePointerCount() { return this._pointers.size; }

        /** Release every pointer (e.g. when the host modal closes). */
        endAll() {
            for (const id of [...this._pointers.keys()]) this._endInternal(id);
        }
    }

    if (typeof window !== 'undefined') window.SwipeTracker = SwipeTracker;
    if (typeof module !== 'undefined') module.exports = SwipeTracker;
})();
