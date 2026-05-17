// ============================================================================
// File: public/js/features/midi-editor/MidiEditorTransport.js
// Description: Playback transport (play / pause / stop / toggle), playhead
//   cursor updates and on-complete handling — extracted from
//   MidiEditorPlayback per audit §1.3 (god-class split).
//
// Owns:
//   - `playbackPlay()` / `playbackPause()` / `playbackStop()` /
//     `togglePlayback()` — synthesizer transport control.
//   - `updatePlaybackCursor(tick)` — called from the synthesizer tick
//     callback, drives playhead position on the piano roll, timeline
//     bar and every visible specialized editor + auto-scroll.
//   - `onPlaybackComplete()` — end-of-sequence reset.
//   - `updatePlaybackButtons()` — refresh play/pause/stop button state.
//
// Accessed via `modal._playback.transport`. MidiEditorPlayback keeps
// thin delegate methods preserving the legacy names so external callers
// (MidiEditorModal.playbackPlay/Pause/Stop/Toggle) are unchanged.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorTransport {
        /** @param {MidiEditorPlayback} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
            // Audit §6.4 — central playback-sync RAF. The synthesizer fires
            // onTickUpdate at up to several hundred Hz under load; we coalesce
            // every burst onto a single rAF frame so piano roll, timeline bar,
            // tablature, drum and wind editors are repainted **once per
            // frame** instead of N×.
            this._cursorRafId   = 0;
            this._pendingTick   = null;
        }

    async playbackPlay() {
        const m = this.modal;

        if (!m.synthesizer) {
            const initialized = await this.parent.initSynthesizer();
            if (!initialized) {
                m.showNotification(m.t('midiEditor.synthInitError'), 'error');
                return;
            }
        }

        if (!m.isPlaying && !m.isPaused) {
            this.parent.loadSequenceForPlayback();

            // Determine start position: use cursor if within range, otherwise range start
            const cursorTick = m.pianoRollRenderer?.getCursor() || 0;
            const rangeStart = m.synthesizer.startTick || 0;
            const rangeEnd = m.synthesizer.endTick || 0;
            const startAt = (cursorTick >= rangeStart && cursorTick <= rangeEnd && cursorTick > 0)
                ? cursorTick : rangeStart;

            // seek() positions schedulePointer via binary search so scheduleNotes()
            // won't re-fire every note from t=0 through the cursor (which, on large
            // files, scheduled thousands of notes in the past and froze the tab).
            m.synthesizer.seek(startAt);
            m.synthesizer.isPaused = true; // Trick: play() will resume from currentTick
        } else if (m.isPaused) {
            // Resume from current cursor position
            const cursorTick = m.pianoRollRenderer?.getCursor() || 0;
            m.synthesizer.seek(cursorTick);
        }

        await m.synthesizer.play();

        m.isPlaying = true;
        m.isPaused = false;

        this.updatePlaybackButtons();

        m.log('info', 'Playback started');
    }

    /**
     * Mettre en pause la lecture
     */
    playbackPause() {
        const m = this.modal;
        if (!m.synthesizer || !m.isPlaying) return;

        m.synthesizer.pause();

        m.isPlaying = false;
        m.isPaused = true;

        this.updatePlaybackButtons();

        m.log('info', 'Playback paused');
    }

    /**
     * Arreter la lecture
     */
    playbackStop() {
        const m = this.modal;
        if (!m.synthesizer) return;

        m.synthesizer.stop();

        m.isPlaying = false;
        m.isPaused = false;
        // Cancel any pending playback-cursor rAF so it can't reapply the
        // pre-stop tick on top of the reset we are about to do (audit §6.4).
        if (this._cursorRafId) {
            cancelAnimationFrame(this._cursorRafId);
            this._cursorRafId = 0;
            this._pendingTick = null;
        }
        // Force the next updatePlaybackCursor() to apply even if the tick
        // equals the previous one (e.g. seek back to start).
        this._lastAppliedTick = undefined;

        const resetTick = m.playbackStartTick || 0;

        m.pianoRollRenderer?.setCursor(resetTick);

        // Reset PlaybackTimelineBar playhead so the red triangle returns to start
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(resetTick);
            if (m.pianoRollRenderer?.isMounted()) {
                m.timelineBar.setScrollX(m.pianoRollRenderer.getXOffset() || 0);
            }
        }

        // Reset tablature playhead and clear fretboard positions
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(resetTick);
            if (m.tablatureEditor.fretboard) {
                m.tablatureEditor.fretboard.clearActivePositions();
            }
        }

        // Reset drum pattern playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(resetTick);
        }

        // Reset wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(resetTick);
        }

        this.updatePlaybackButtons();

        m.log('info', 'Playback stopped');
    }

    /**
     * Basculer entre play et pause
     */
    togglePlayback() {
        const m = this.modal;
        if (m.isPlaying) {
            this.playbackPause();
        } else {
            this.playbackPlay();
        }
    }

    // ========================================================================
    // PLAYBACK CURSOR
    // ========================================================================

    /**
     * Mettre a jour le curseur pendant la lecture
     *
     * The synthesizer already drives this from a RAF loop, so we don't
     * need a second coalescing layer. We DO gate on tick delta: when the
     * tick hasn't moved since the previous frame (paused, or sub-tick
     * resolution), skip all the playhead writes/redraws downstream. This
     * is cheap and eliminates redundant repaints on slow pieces / long
     * notes (audit §6.4).
     *
     * @param {number} tick - Position actuelle en ticks
     */
    updatePlaybackCursor(tick) {
        // §6.4: coalesce per-tick callbacks onto a single rAF. The synthesizer
        // may fire many ticks per frame; we only need the latest position
        // when the next frame paints. Cursor / playhead drift caps at 16ms.
        this._pendingTick = tick;
        if (this._cursorRafId) return;
        this._cursorRafId = requestAnimationFrame(() => {
            this._cursorRafId = 0;
            const t = this._pendingTick;
            this._pendingTick = null;
            if (t == null) return;
            this._applyPlaybackCursor(t);
        });
    }

    /**
     * Synchronous body of updatePlaybackCursor — apply the tick to every
     * subscriber (piano roll, timeline bar, tab/drum/wind, nav overview).
     * Called from the rAF in updatePlaybackCursor, OR directly from seek /
     * onPlaybackComplete paths that need immediate state without waiting
     * for the next frame.
     */
    _applyPlaybackCursor(tick) {
        const m = this.modal;
        if (this._lastAppliedTick === tick) return;
        this._lastAppliedTick = tick;

        // Update piano roll cursor (even when hidden, keeps state consistent).
        // Routed via PianoRollRenderer (audit §1.1 — CanvasPianoRollRenderer).
        let scrolled = false;
        const renderer = m.pianoRollRenderer;
        if (renderer && renderer.isMounted()) {
            renderer.setCursor(tick);

            const xoffset = renderer.getXOffset() || 0;
            const xrange  = renderer.getXRange() || 1920;

            // Page-turn: trigger earlier (85%) and land further from the edge (30%)
            // so the cursor remains visible without brutal teleport.
            if (tick > xoffset + xrange * 0.85) {
                renderer.setXOffset(tick - xrange * 0.3);
                scrolled = true;
            } else if (tick < xoffset) {
                renderer.setXOffset(Math.max(0, tick - xrange * 0.1));
                scrolled = true;
            }

            // Force a synchronous redraw on scroll so the piano roll and the
            // timeline bar are painted in the same frame (the xoffset setter
            // normally throttles via RAF, which causes a one-frame misalignment).
            if (scrolled) renderer.redraw();
        }

        // Update PlaybackTimelineBar
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(tick);
            if (renderer && renderer.isMounted()) {
                m.timelineBar.setScrollX(renderer.getXOffset() || 0);
            }
        }

        // Re-sync all editors' zoom/scroll with the new viewport whenever the
        // piano roll has auto-scrolled. Handles any container resize/zoom drift.
        if (scrolled && m.ccPicker && typeof m.ccPicker.syncAllEditors === 'function') {
            m.ccPicker.syncAllEditors();
        }

        // Update tablature editor playhead, fretboard, and auto-scroll
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(tick);

            // Sync navigation overview bar with tablature scroll position
            if (m.navigationBar && m.tablatureEditor.renderer) {
                const maxTick = m.midiData?.maxTick || 0;
                const renderer = m.tablatureEditor.renderer;
                const canvasWidth = m.tablatureEditor.tabCanvasEl?.width || 800;
                const visibleTicks = (canvasWidth - renderer.headerWidth) * renderer.ticksPerPixel;
                m.navigationBar.setViewport(renderer.scrollX, visibleTicks, maxTick);
            }
        }

        // Update drum pattern editor playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(tick);
        }

        // Update wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(tick);
        }
    }

    /**
     * Callback quand la lecture est terminee
     */
    onPlaybackComplete() {
        const m = this.modal;
        m.isPlaying = false;
        m.isPaused = false;
        // Cancel pending cursor rAF — same rationale as playbackStop
        // (audit §6.4). Otherwise the end-of-sequence reset can be undone
        // visually one frame later by a queued tick.
        if (this._cursorRafId) {
            cancelAnimationFrame(this._cursorRafId);
            this._cursorRafId = 0;
            this._pendingTick = null;
        }

        m.pianoRollRenderer?.setCursor(m.playbackStartTick);

        const resetTick = m.playbackStartTick || 0;

        // Reset timeline bar
        if (m.timelineBar) {
            m.timelineBar.setPlayhead(resetTick);
            if (m.pianoRollRenderer?.isMounted()) {
                m.timelineBar.setScrollX(m.pianoRollRenderer.getXOffset() || 0);
            }
        }

        // Reset tablature playhead and clear fretboard positions
        if (m.tablatureEditor && m.tablatureEditor.isVisible) {
            m.tablatureEditor.updatePlayhead(resetTick);
            if (m.tablatureEditor.fretboard) {
                m.tablatureEditor.fretboard.clearActivePositions();
            }
        }

        // Reset drum pattern playhead
        if (m.drumPatternEditor && m.drumPatternEditor.isVisible) {
            m.drumPatternEditor.updatePlayhead(resetTick);
        }

        // Reset wind instrument editor playhead
        if (m.windInstrumentEditor && m.windInstrumentEditor.isVisible) {
            m.windInstrumentEditor.updatePlayhead(resetTick);
        }

        this.updatePlaybackButtons();

        m.log('info', 'Playback complete');
    }

    // ========================================================================
    // PLAYBACK BUTTONS
    // ========================================================================

    /**
     * Mettre a jour les boutons de playback
     */
    updatePlaybackButtons() {
        const m = this.modal;
        const playBtn = document.getElementById('play-btn');
        const pauseBtn = document.getElementById('pause-btn');
        const stopBtn = document.getElementById('stop-btn');

        if (m.isPlaying) {
            if (playBtn) playBtn.style.display = 'none';
            if (pauseBtn) pauseBtn.style.display = '';
            if (stopBtn) stopBtn.disabled = false;
        } else if (m.isPaused) {
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = false;
        } else {
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (stopBtn) stopBtn.disabled = true;
        }
    }

    }

    if (typeof window !== 'undefined') {
        window.MidiEditorTransport = MidiEditorTransport;
    }
})();
