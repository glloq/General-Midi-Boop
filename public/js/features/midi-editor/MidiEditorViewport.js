// ============================================================================
// File: public/js/features/midi-editor/MidiEditorViewport.js
// Description: Zoom + scroll + navigation overview bar — extracted from
//   MidiEditorEvents per audit §1.3 (god-class split).
//
// Owns:
//   - `zoomHorizontal(factor)` / `zoomVertical(factor)` — dispatch to the
//     active specialized renderer if any, else the piano roll renderer.
//   - `scheduleRedraw(after)` — defer a redraw a macrotask so layout
//     settles before the renderer measures the container.
//   - `initNavigationOverview()` / `updateNavigationMinimap()` — the
//     overview bar at the bottom of the modal.
//   - `setupScrollSynchronization()` — viewportchange listener that
//     propagates xoffset/xrange to the nav bar and sub-editors.
//   - `scrollHorizontal(pct)` / `scrollVertical(pct)` — drive the piano
//     roll + every visible specialized editor from a single % slider.
//
// Accessed via `modal.events.viewport`. MidiEditorEvents keeps thin
// delegate methods preserving the legacy names so external callers
// (MidiEditorPianoRollBoot, MidiEditorSequence, MidiEditorToolbar
// dispatch in attachEvents) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorViewport {
    /** @param {MidiEditorEvents} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    // ----------------------------------------------------------------
    // Zoom
    // ----------------------------------------------------------------

    zoomHorizontal(factor) {
      // Dispatch to specialized editor if active
      const specializedRenderer = this.modal.editActions?._getActiveSpecializedRenderer();
      if (specializedRenderer && typeof specializedRenderer.setZoom === 'function') {
        const currentTPP = specializedRenderer.ticksPerPixel || 2;
        // factor < 1 = zoom in (reduce ticksPerPixel), factor > 1 = zoom out
        specializedRenderer.setZoom(currentTPP * factor);
        this.modal.ccPicker.syncAllEditors();
        return;
      }

      const renderer = this.modal.pianoRollRenderer;
      if (!renderer?.isMounted()) {
        this.modal.log('warn', 'Cannot zoom: piano roll not initialized');
        return;
      }

      const currentRange = renderer.getXRange() || 128;
      const newRange = Math.max(16, Math.min(100000, Math.round(currentRange * factor)));
      renderer.setXRange(newRange);

      this.scheduleRedraw(() => this.modal.ccPicker.syncAllEditors());
      this.modal.log('info', `Horizontal zoom: ${currentRange} -> ${newRange}`);
    }

    zoomVertical(factor) {
      // Dispatch to specialized editor if active
      const specializedRenderer = this.modal.editActions?._getActiveSpecializedRenderer();
      if (specializedRenderer && typeof specializedRenderer.setVerticalZoom === 'function') {
        specializedRenderer.setVerticalZoom(factor);
        this.modal.ccPicker.syncAllEditors();
        return;
      }

      const renderer = this.modal.pianoRollRenderer;
      if (!renderer?.isMounted()) {
        this.modal.log('warn', 'Cannot zoom: piano roll not initialized');
        return;
      }

      const currentRange = renderer.getYRange() || 36;
      const newRange = Math.max(12, Math.min(88, Math.round(currentRange * factor)));
      renderer.setYRange(newRange);

      this.scheduleRedraw();
      this.modal.log('info', `Vertical zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Defer a redraw to a later macrotask so any pending container /
     * attribute layout has settled before the renderer measures it,
     * then run an optional `afterRedraw` callback.
     */
    scheduleRedraw(afterRedraw) {
      const modal = this.modal;
      setTimeout(() => {
        if (!modal.pianoRollRenderer?.isMounted()) return;
        modal.pianoRollRenderer.redraw();
        if (typeof afterRedraw === 'function') {
          try {
            afterRedraw();
          } catch (_) {
            /* best-effort */
          }
        }
      }, 50);
    }

    // ----------------------------------------------------------------
    // Navigation overview bar
    // ----------------------------------------------------------------

    initNavigationOverview(maxTick, xrange) {
      const overviewContainer = this.modal.container?.querySelector(
        '#navigation-overview-container'
      );
      if (!overviewContainer || typeof NavigationOverviewBar === 'undefined') return;

      if (this.modal.navigationBar) {
        this.modal.navigationBar.destroy();
        this.modal.navigationBar = null;
      }

      this.modal.navigationBar = new NavigationOverviewBar(overviewContainer, {
        height: 20,
        onNavigate: (percentage) => this.scrollHorizontal(percentage),
        onZoom: (factor) => this.zoomHorizontal(factor)
      });

      this.modal.navigationBar.setViewport(0, xrange, maxTick);
      this.updateNavigationMinimap();
      this.modal.log(
        'info',
        `Navigation overview bar initialized: maxTick=${maxTick}, xrange=${xrange}`
      );
    }

    updateNavigationMinimap() {
      if (!this.modal.navigationBar) return;
      if (this.modal.activeChannels && this.modal.activeChannels.size === 1) {
        const ch = Array.from(this.modal.activeChannels)[0];
        const source = this.modal.fullSequence || this.modal.sequence || [];
        const notes = source.filter((n) => n.c === ch);
        const color = (this.modal.channelColors && this.modal.channelColors[ch]) || '#888';
        this.modal.navigationBar.setMinimap(notes, color);
      } else {
        this.modal.navigationBar.setMinimap(null);
      }
    }

    // ----------------------------------------------------------------
    // Scroll synchronization
    // ----------------------------------------------------------------

    setupScrollSynchronization() {
      if (!this.modal.pianoRollRenderer?.isMounted()) return;

      let syncScheduled = false;

      const onViewportChange = (e) => {
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) return;

        const { xoffset, xrange } = e.detail;

        // Update navigation overview bar
        const maxTick = this.modal.midiData?.maxTick || 0;
        this.modal.navigationBar?.setViewport(xoffset, xrange, maxTick);

        if (!syncScheduled) {
          syncScheduled = true;
          requestAnimationFrame(() => {
            this.modal.ccPicker.syncAllEditors();
            syncScheduled = false;
          });
        }
      };

      this.modal.pianoRollRenderer?.on('viewportchange', onViewportChange);
      this.modal._viewportChangeHandler = onViewportChange;
    }

    scrollHorizontal(percentage) {
      const maxTick = this.modal.midiData?.maxTick || 0;

      const renderer = this.modal.pianoRollRenderer;
      if (renderer?.isMounted()) {
        const xrange = renderer.getXRange() || 128;
        const maxOffset = Math.max(0, maxTick - xrange);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        renderer.setXOffset(newOffset);

        if (!(this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)) {
          renderer.redraw();
        }
      }

      // Sync the tablature
      if (
        this.modal.tablatureEditor &&
        this.modal.tablatureEditor.isVisible &&
        this.modal.tablatureEditor.renderer
      ) {
        const tabR = this.modal.tablatureEditor.renderer;
        const canvasWidth = this.modal.tablatureEditor.tabCanvasEl?.width || 800;
        const visibleTicks = (canvasWidth - tabR.headerWidth) * tabR.ticksPerPixel;
        const maxOffset = Math.max(0, maxTick - visibleTicks);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        tabR.setScrollX(newOffset);
      }

      // Sync the drum editor
      if (
        this.modal.drumPatternEditor &&
        this.modal.drumPatternEditor.isVisible &&
        this.modal.drumPatternEditor.gridRenderer
      ) {
        const drumR = this.modal.drumPatternEditor.gridRenderer;
        const canvasWidth = this.modal.drumPatternEditor.gridCanvasEl?.width || 800;
        const visibleTicks = (canvasWidth - (drumR.headerWidth || 0)) * (drumR.ticksPerPixel || 2);
        const maxOffset = Math.max(0, maxTick - visibleTicks);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        drumR.setScrollX(newOffset);
      }

      // Sync the wind editor
      if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
        this.modal.windInstrumentEditor.scrollHorizontal(percentage);
      }

      // Sync the CC editor
      this.modal.ccPicker.syncCCEditor();
    }

    scrollVertical(percentage) {
      const renderer = this.modal.pianoRollRenderer;
      if (renderer?.isMounted()) {
        const yrange = renderer.getYRange() || 36;

        const totalMidiRange = 128;
        const maxOffset = Math.max(0, totalMidiRange - yrange);
        const newOffset = Math.round((percentage / 100) * maxOffset);
        renderer.setYOffset(newOffset);

        if (!(this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)) {
          renderer.redraw();
        }
      }

      // Sync the wind editor
      if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
        this.modal.windInstrumentEditor.scrollVertical(percentage);
      }
    }

    // ----------------------------------------------------------------
    // Playback timeline bar
    // ----------------------------------------------------------------

    initTimelineBar(maxTick, ticksPerBeat, xrange) {
      const timelineContainer = this.modal.container?.querySelector('#playback-timeline-container');
      if (!timelineContainer || typeof PlaybackTimelineBar === 'undefined') return;

      if (this.modal.timelineBar) {
        this.modal.timelineBar.destroy();
        this.modal.timelineBar = null;
      }

      const pianoLeftOffset = this.modal.ccPicker._getActiveEditorHeaderWidth();

      this.modal.timelineBar = new PlaybackTimelineBar(timelineContainer, {
        ticksPerBeat: ticksPerBeat,
        beatsPerMeasure: 4,
        leftOffset: pianoLeftOffset,
        height: 30,
        onSeek: (tick) => {
          const rangeStart = this.modal.timelineBar.rangeStart || 0;
          const rangeEnd = this.modal.timelineBar.rangeEnd || this.modal.midiData?.maxTick || 0;
          const clampedTick = Math.max(rangeStart, Math.min(tick, rangeEnd));
          this.modal.pianoRollRenderer?.setCursor(clampedTick);
          if (this.modal.synthesizer && typeof this.modal.synthesizer.seek === 'function')
            this.modal.synthesizer.seek(clampedTick);
          // Drop any queued playback-cursor rAF and rebase the
          // dedup-tick so the next coalesced tick from the synth
          // does NOT briefly snap the cursor back to the pre-seek
          // position (audit §6.4 follow-up).
          const transport = this.modal._playback?.transport;
          if (transport) {
            if (transport._cursorRafId) {
              cancelAnimationFrame(transport._cursorRafId);
              transport._cursorRafId = 0;
            }
            transport._pendingTick = null;
            transport._lastAppliedTick = clampedTick;
          }
          if (this.modal.timelineBar) this.modal.timelineBar.setPlayhead(clampedTick);
          if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible)
            this.modal.tablatureEditor.updatePlayhead(clampedTick);
          if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible)
            this.modal.drumPatternEditor.updatePlayhead(clampedTick);
          if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)
            this.modal.windInstrumentEditor.updatePlayhead(clampedTick);
          this.modal.log('debug', `Timeline seek to tick ${clampedTick}`);
        },
        onPan: (newScrollX) => {
          const renderer = this.modal.pianoRollRenderer;
          if (renderer?.isMounted()) {
            renderer.setXOffset(newScrollX);
            if (!(this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)) {
              renderer.redraw();
            }
          }
          const maxTick2 = this.modal.midiData?.maxTick || 0;
          const xrange2 = this.modal.pianoRollRenderer?.getXRange() || 1920;
          this.modal.navigationBar?.setViewport(newScrollX, xrange2, maxTick2);
          if (
            this.modal.tablatureEditor &&
            this.modal.tablatureEditor.isVisible &&
            this.modal.tablatureEditor.renderer
          )
            this.modal.tablatureEditor.renderer.setScrollX(newScrollX);
          if (
            this.modal.drumPatternEditor &&
            this.modal.drumPatternEditor.isVisible &&
            this.modal.drumPatternEditor.gridRenderer
          )
            this.modal.drumPatternEditor.gridRenderer.setScrollX(newScrollX);
          if (
            this.modal.windInstrumentEditor &&
            this.modal.windInstrumentEditor.isVisible &&
            this.modal.windInstrumentEditor.renderer
          )
            this.modal.windInstrumentEditor.renderer.setScrollX(newScrollX);
          this.modal.ccPicker.syncCCEditor();
          this.modal.ccPicker.syncVelocityEditor();
          this.modal.ccPicker.syncTempoEditor();
        },
        onResize: () => {
          if (this.modal.ccPicker && typeof this.modal.ccPicker.syncAllEditors === 'function') {
            this.modal.ccPicker.syncAllEditors();
          }
        },
        onRangeChange: (start, end) => {
          this.modal.pianoRollRenderer?.setMarkers(start, end);
          this.modal.playbackStartTick = start;
          this.modal.playbackEndTick = end;
          if (this.modal.synthesizer) {
            const currentTick = this.modal.synthesizer.currentTick || 0;
            this.modal.synthesizer.startTick = Math.max(0, start);
            this.modal.synthesizer.endTick = end;
            if (currentTick < start || currentTick > end)
              this.modal.synthesizer.currentTick = start;
          }
          if (this.modal.timelineBar) {
            const playhead = this.modal.timelineBar.playheadTick;
            if (playhead < start) {
              this.modal.timelineBar.setPlayhead(start);
              this.modal.pianoRollRenderer?.setCursor(start);
            } else if (playhead > end) {
              this.modal.timelineBar.setPlayhead(end);
              this.modal.pianoRollRenderer?.setCursor(end);
            }
          }
          this.modal.log('debug', `Timeline range changed: ${start} - ${end}`);
        }
      });

      this.modal.timelineBar.setTotalTicks(maxTick);
      this.modal.timelineBar.setRange(0, maxTick);
      this.modal.timelineBar.setZoom(
        xrange / ((timelineContainer.clientWidth || 800) - pianoLeftOffset)
      );
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorViewport = MidiEditorViewport;
  }
})();
