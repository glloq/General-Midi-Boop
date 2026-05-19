// public/js/features/auto-assign/RoutingSummaryPreviewControls.js
//
// Audio-preview + minimap control surface for RoutingSummaryPage.
// Extracted to thin the parent file (AUDIT 2026-05-10 §32). Methods are
// attached to `RoutingSummaryPage.prototype` via `Object.assign` inside
// RoutingSummaryPage.js, so they freely use `this` for state and rely on
// the parent class for the helpers they call (`_getChannelVolume`,
// `_resolveSegmentGmProgram`, `_handsPreviewPanel`, ...).
//
// Globals consumed:
//   - window.RoutingSummaryConstants (SPLIT_COLORS)
//   - window.RoutingSummaryRenderers (renderHeaderButtons)
//   - window.RoutingSummaryMinimapRenderer
//   - window.RoutingSummaryMinimapNotes
//   - window.RoutingSummaryPreview (allocateFreeChannels,
//     redistributeSplitChannel, collectUsedChannels)
//   - window.escapeHtml

(function() {
  'use strict';

  const SPLIT_COLORS = (window.RoutingSummaryConstants || {}).SPLIT_COLORS || [];

  const PreviewControls = {

    _renderHeaderButtons() {
      return window.RoutingSummaryRenderers.renderHeaderButtons({
        selectedChannel: this.selectedChannel,
        filename: this.filename,
        escape: window.escapeHtml
      });
    },

    _bindPreviewEvents() {
      const modal = this.modal;
      if (!modal) return;

      modal.querySelector('#rsPreviewAllBtn')?.addEventListener('click', () => this._previewAll());
      modal.querySelector('#rsPreviewChBtn')?.addEventListener('click', () => this._previewChannel(this.selectedChannel));
      modal.querySelector('#rsPreviewOrigBtn')?.addEventListener('click', () => this._previewOriginal(this.selectedChannel));
      modal.querySelector('#rsPreviewPauseBtn')?.addEventListener('click', () => {
        if (this._previewState === 'paused') this._resumePreview();
        else this._pausePreview();
      });
      modal.querySelector('#rsPreviewStopBtn')?.addEventListener('click', () => this._stopPreview());

      // Minimap click → seek (audio + hands-preview panel together).
      const container = modal.querySelector('#rsMinimapContainer');
      if (container) {
        container.addEventListener('click', (e) => {
          const rect = container.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const totalSec = this.audioPreview?.totalDuration || 0;
          if (totalSec > 0 && this.audioPreview?.seek) {
            this.audioPreview.seek(pct * totalSec);
          }
          // Mirror the seek into the hands preview panel — onProgress
          // would catch up eventually, but this avoids a one-frame lag
          // when the audio preview isn't actively playing.
          if (this._handsPreviewPanel && typeof this._handsPreviewPanel.setCurrentTime === 'function') {
            this._handsPreviewPanel.setCurrentTime(pct * totalSec);
          }
        });
      }

      // Render minimap after layout paint (double-rAF to ensure container has dimensions)
      requestAnimationFrame(() => requestAnimationFrame(() => this._renderMinimap()));
    },

    _renderMinimap() {
      const container = this.modal?.querySelector('#rsMinimapContainer');
      if (!container || !this.midiData) return;

      let canvas = this._minimapCanvas;
      if (!canvas || !canvas.parentNode) {
        canvas = document.createElement('canvas');
        canvas.className = 'rs-minimap-canvas';
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.cursor = 'pointer';
        container.textContent = '';
        container.appendChild(canvas);
        this._minimapCanvas = canvas;
      }

      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth || 400;

      // Determine channel filter based on active preview mode
      let channelFilter = null;
      if (this._previewMode === 'channel') {
        channelFilter = this._previewingChannel;
      } else if (this._previewMode === 'all' || this._previewMode === 'original') {
        channelFilter = null; // show all channels
      } else {
        channelFilter = (this.selectedChannel !== null) ? this.selectedChannel : null;
      }

      // Detect split mode: single channel with multiple instrument segments
      const isSplitView = channelFilter != null
        && this.splitChannels.has(channelFilter)
        && this.splitAssignments[channelFilter]?.segments?.length > 1;

      // Adapt height: taller when showing multiple instrument rows in split mode
      const splitSegCount = isSplitView ? (this.splitAssignments[channelFilter].segments.length) : 0;
      const h = splitSegCount > 1 ? Math.max(24, splitSegCount * 12) : 24;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.height = h + 'px';

      const skipRangeFilter = this._previewMode === 'original';
      const notes = this._extractNotesForMinimap(channelFilter, skipRangeFilter);

      // Bucket aggregation delegated to RoutingSummaryMinimapNotes (P2-F.4g).
      const bucketState = window.RoutingSummaryMinimapNotes.buildMinimapBuckets({
        notes,
        width: w,
        isSplitView,
        splitSegmentCount: isSplitView ? this.splitAssignments[channelFilter].segments.length : 0
      });

      this._minimapWidth = w;
      this._minimapHeight = h;
      this._minimapTotalTicks = bucketState.totalTicks;
      this._minimapSplitMode = bucketState.splitMode;
      this._minimapSegments = bucketState.segments;
      this._minimapChannels = bucketState.channels;
      this._minimapMultiChannel = bucketState.multiChannel;
      this._minimapBuckets = bucketState.buckets;

      this._drawMinimapFrame(0);
    },

    _drawMinimapFrame(playheadPct) {
      // Canvas rendering delegated to RoutingSummaryMinimapRenderer (P2-F.4f).
      window.RoutingSummaryMinimapRenderer.drawMinimapFrame({
        canvas: this._minimapCanvas,
        width: this._minimapWidth || 400,
        height: this._minimapHeight || 32,
        splitMode: this._minimapSplitMode,
        segments: this._minimapSegments,
        channels: this._minimapChannels,
        multiChannel: this._minimapMultiChannel,
        buckets: this._minimapBuckets,
        playheadPct,
        splitColors: SPLIT_COLORS
      });
    },

    _extractNotesForMinimap(channelFilter, skipRangeFilter = false) {
      // Pure extraction delegated to RoutingSummaryMinimapNotes (P2-F.4e).
      // The whole-file note scan is cached per loaded MIDI: it used to
      // re-walk + re-sort every track/event on EVERY channel click,
      // which froze the modal for tens of seconds on large files
      // (the rAF that runs it fires before the browser paints, so the
      // detail panel only appeared once the scan finished). The raw
      // scan is now done once; each click only re-applies the cheap
      // range/split/channel filter over the cached array.
      const Notes = window.RoutingSummaryMinimapNotes;
      if (this._minimapRawForMidi !== this.midiData) {
        this._minimapRawNotes = Notes.extractRawNotes(this.midiData);
        this._minimapRawForMidi = this.midiData;
      }
      return Notes.extractNotesForMinimap({
        rawNotes: this._minimapRawNotes,
        selectedAssignments: this.selectedAssignments,
        splitChannels: this.splitChannels,
        splitAssignments: this.splitAssignments,
        adaptationSettings: this.adaptationSettings,
        channelFilter,
        skipRangeFilter
      });
    },

    // ============================================================================
    // Audio preview playback
    // ============================================================================

    /**
     * Apply per-channel volume overrides (CC7) to the preview synthesizer.
     */
    _applyPreviewVolumes() {
      if (!this.audioPreview?.synthesizer) return;
      for (let ch = 0; ch < 16; ch++) {
        this.audioPreview.synthesizer.setChannelVolume(ch, this._getChannelVolume(ch));
      }
    },

    async _previewAll() {
      if (!this.audioPreview || !this.midiData) {
        console.warn('[Preview] No audioPreview or midiData available');
        return;
      }
      this._safeStopPreview();
      this._previewMode = 'all';
      this._previewingChannel = null;

      const channelConfigs = {};
      const splitChannelMappings = [];
      for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
        const chNum = parseInt(ch);
        if (this.skippedChannels.has(chNum)) { channelConfigs[ch] = { skipped: true }; continue; }

        const adapt = this.adaptationSettings[ch] || {};
        const semitones = adapt.transpositionSemitones || 0;

        // Build full instrument constraints from assignment
        const constraints = assignment ? {
          gmProgram: assignment.gmProgram,
          noteRangeMin: assignment.noteRangeMin,
          noteRangeMax: assignment.noteRangeMax,
          noteSelectionMode: assignment.noteSelectionMode || undefined,
          selectedNotes: assignment.selectedNotes || undefined,
          suppressOutOfRange: adapt.oorHandling === 'suppress',
          noteCompression: adapt.oorHandling === 'compress'
        } : null;

        // For split channels, route each segment to a different synth channel
        if (this.splitChannels.has(chNum) && this.splitAssignments[chNum]) {
          const segs = this.splitAssignments[chNum].segments || [];
          if (segs.length > 1) {
            // Segment 0 keeps the source channel; segments 1..N get free channels
            splitChannelMappings.push({ sourceChannel: chNum, segments: segs, semitones });
          } else if (segs.length === 1) {
            channelConfigs[ch] = {
              transposition: { semitones },
              instrumentConstraints: {
                gmProgram: segs[0].gmProgram ?? (constraints?.gmProgram),
                noteRangeMin: segs[0].noteRange?.min ?? 0,
                noteRangeMax: segs[0].noteRange?.max ?? 127
              }
            };
          }
          continue;
        }

        // Apply custom drum mappings for channel 9
        const chTransposition = { semitones };
        if (chNum === 9) {
          const baseRemap = assignment?.noteRemapping || {};
          const customMap = this.customDrumMappings[chNum] || {};
          const mutedNotes = this.mutedDrumNotes[chNum] || new Set();
          const mergedRemap = { ...baseRemap, ...customMap };
          for (const note of mutedNotes) mergedRemap[note] = -1;
          if (Object.keys(mergedRemap).length > 0) {
            chTransposition.noteRemapping = mergedRemap;
          }
        }

        channelConfigs[ch] = {
          transposition: chTransposition,
          instrumentConstraints: constraints
        };
      }

      // Pre-process split channels: redistribute notes to virtual channels
      let previewMidi = this.midiData;
      if (splitChannelMappings.length > 0) {
        previewMidi = JSON.parse(JSON.stringify(this.midiData));
        // Find all used channels
        const usedCh = new Set();
        for (const [c] of Object.entries(channelConfigs)) usedCh.add(Number(c));
        for (const m of splitChannelMappings) usedCh.add(m.sourceChannel);

        for (const mapping of splitChannelMappings) {
          const { sourceChannel, segments, semitones } = mapping;
          const free = window.RoutingSummaryPreview.allocateFreeChannels({
            count: segments.length - 1,
            usedChannels: usedCh,
            excluded: new Set([sourceChannel])
          });
          for (const c of free) usedCh.add(c);
          const segChannels = [sourceChannel, ...free];

          window.RoutingSummaryPreview.redistributeSplitChannel({
            midiData: previewMidi,
            sourceChannel,
            segments,
            segChannels,
            overlapStrategy: this.splitAssignments[sourceChannel]?.overlapStrategy,
            chRemap: this.ccRemapping[String(sourceChannel)] || {},
            chSegMute: this.ccSegmentMute[sourceChannel] || {}
          });

          segments.forEach((seg, i) => {
            if (i >= segChannels.length) return;
            channelConfigs[segChannels[i]] = {
              transposition: { semitones },
              instrumentConstraints: {
                gmProgram: this._resolveSegmentGmProgram(seg),
                noteRangeMin: seg.noteRange?.min ?? 0,
                noteRangeMax: seg.noteRange?.max ?? 127
              }
            };
          });
        }
      }

      try {
        this._connectPreviewCallbacks();
        await this.audioPreview.initSynthesizer();
        this._applyPreviewVolumes();
        await this.audioPreview.previewAllChannels(previewMidi, channelConfigs, 0);
        this._previewState = 'playing';
        this._updatePreviewUI();
        this._renderMinimap();
      } catch (err) {
        console.error('[Preview] previewAll failed:', err);
        this._previewState = 'stopped';
        this._updatePreviewUI();
        this._showPreviewError(err.message);
      }
    },

    async _previewChannel(channel) {
      if (!this.audioPreview || !this.midiData) {
        console.warn('[Preview] No audioPreview or midiData available');
        return;
      }
      if (channel === null || channel === undefined) {
        console.warn('[Preview] No channel selected');
        return;
      }
      this._safeStopPreview();
      this._previewMode = 'channel';
      this._previewingChannel = channel;

      const ch = String(channel);
      const assignment = this.selectedAssignments[ch];
      const adapt = this.adaptationSettings[ch] || {};
      const transposition = { semitones: adapt.transpositionSemitones || 0 };

      // Split channels: route notes to different synth voices per segment
      if (this.splitChannels.has(channel) && this.splitAssignments[channel]) {
        const segs = this.splitAssignments[channel].segments || [];
        if (segs.length > 1) {
          const usedChannels = window.RoutingSummaryPreview.collectUsedChannels(this.midiData);
          const freeChannels = window.RoutingSummaryPreview.allocateFreeChannels({
            count: segs.length - 1,
            usedChannels,
            excluded: new Set([channel])
          });
          const segChannels = [channel, ...freeChannels];

          const splitMidi = JSON.parse(JSON.stringify(this.midiData));
          window.RoutingSummaryPreview.redistributeSplitChannel({
            midiData: splitMidi,
            sourceChannel: channel,
            segments: segs,
            segChannels,
            overlapStrategy: this.splitAssignments[channel]?.overlapStrategy,
            chRemap: this.ccRemapping[ch] || {},
            chSegMute: this.ccSegmentMute[channel] || {}
          });

          // Build configs: one per segment with its own gmProgram and range
          // Mark all other channels as skipped so only segments are heard
          const channelConfigs = {};
          for (let c = 0; c < 16; c++) channelConfigs[c] = { skipped: true };
          segs.forEach((seg, i) => {
            if (i >= segChannels.length) return;
            channelConfigs[segChannels[i]] = {
              transposition: { semitones: transposition.semitones },
              instrumentConstraints: {
                gmProgram: this._resolveSegmentGmProgram(seg) ?? assignment?.gmProgram,
                noteRangeMin: seg.noteRange?.min ?? 0,
                noteRangeMax: seg.noteRange?.max ?? 127
              }
            };
          });

          try {
            this._connectPreviewCallbacks();
            await this.audioPreview.initSynthesizer();
            this._applyPreviewVolumes();
            await this.audioPreview.previewAllChannels(splitMidi, channelConfigs, 0);
            this._previewState = 'playing';
            this._updatePreviewUI();
            this._renderMinimap();
          } catch (err) {
            console.error('[Preview] split preview failed:', err);
            this._previewState = 'stopped';
            this._updatePreviewUI();
            this._showPreviewError(err.message);
          }
          return;
        }
      }

      // Single instrument: standard preview
      const constraints = assignment ? {
        gmProgram: assignment.gmProgram,
        noteRangeMin: assignment.noteRangeMin,
        noteRangeMax: assignment.noteRangeMax,
        noteSelectionMode: assignment.noteSelectionMode || undefined,
        selectedNotes: assignment.selectedNotes || undefined
      } : {};

      // Apply custom drum mappings and muted notes to the transposition's noteRemapping
      const isDrumChannel = channel === 9;
      if (isDrumChannel) {
        const baseRemap = assignment?.noteRemapping || {};
        const customMap = this.customDrumMappings[channel] || {};
        const mutedNotes = this.mutedDrumNotes[channel] || new Set();
        const mergedRemap = { ...baseRemap, ...customMap };
        // Muted notes: map to -1 (will be filtered out by note filter)
        for (const note of mutedNotes) mergedRemap[note] = -1;
        if (Object.keys(mergedRemap).length > 0) {
          transposition.noteRemapping = mergedRemap;
        }
      }

      try {
        this._connectPreviewCallbacks();
        await this.audioPreview.initSynthesizer();
        this._applyPreviewVolumes();
        await this.audioPreview.previewSingleChannel(
          this.midiData, channel, transposition, constraints, 0, 0, true
        );
        this._previewState = 'playing';
        this._updatePreviewUI();
        this._renderMinimap();
      } catch (err) {
        console.error('[Preview] previewChannel failed:', err);
        this._previewState = 'stopped';
        this._updatePreviewUI();
        this._showPreviewError(err.message);
      }
    },

    async _previewOriginal(channel) {
      if (!this.audioPreview || !this.midiData) {
        console.warn('[Preview] No audioPreview or midiData available');
        return;
      }
      this._safeStopPreview();
      this._previewMode = 'original';
      this._previewingChannel = null;

      try {
        this._connectPreviewCallbacks();
        await this.audioPreview.previewOriginal(this.midiData, 0, 0, true);
        this._previewState = 'playing';
        this._updatePreviewUI();
        this._renderMinimap();
      } catch (err) {
        console.error('[Preview] previewOriginal failed:', err);
        this._previewState = 'stopped';
        this._updatePreviewUI();
        this._showPreviewError(err.message);
      }
    },

    _pausePreview() {
      if (!this.audioPreview) return;
      try { this.audioPreview.pause(); } catch (e) { /* ignore */ }
      this._previewState = 'paused';
      this._updatePreviewUI();
    },

    _resumePreview() {
      if (!this.audioPreview) return;
      try { this.audioPreview.resume(); } catch (e) { /* ignore */ }
      this._previewState = 'playing';
      this._updatePreviewUI();
    },

    _safeStopPreview() {
      if (this.audioPreview?.isPreviewing || this.audioPreview?.isPlaying) {
        try { this.audioPreview.stop(); } catch (e) { /* ignore */ }
      }
      this._previewState = 'stopped';
      this._previewMode = null;
    },

    _stopPreview() {
      this._safeStopPreview();
      this._updatePreviewUI();
    },

    _showPreviewError(msg) {
      const timeEl = this.modal?.querySelector('#rsPreviewTime');
      if (timeEl) {
        timeEl.textContent = msg || 'Preview error';
        timeEl.style.color = '#e74c3c';
        setTimeout(() => { if (timeEl) { timeEl.textContent = ''; timeEl.style.color = ''; } }, 4000);
      }
    },

    _connectPreviewCallbacks() {
      if (!this.audioPreview) return;
      this.audioPreview.onProgress = (currentTick, totalTicks, currentSec, totalSec) => {
        // Update time display
        const timeEl = this.modal?.querySelector('#rsPreviewTime');
        if (timeEl) {
          const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
          timeEl.textContent = `${fmt(currentSec)} / ${fmt(totalSec)}`;
        }
        // Update minimap playhead
        const pct = totalTicks > 0 ? currentTick / totalTicks : 0;
        this._drawMinimapFrame(pct);
        // Drive the hands preview panel from the same clock the audio
        // preview uses — the panel has no transport buttons of its
        // own (per the unified-navigation spec), so this is what
        // makes its keyboard / look-ahead / fretboard tick.
        if (this._handsPreviewPanel && typeof this._handsPreviewPanel.setCurrentTime === 'function') {
          this._handsPreviewPanel.setCurrentTime(currentSec);
        }
      };
      this.audioPreview.onPlaybackEnd = () => {
        this._previewState = 'stopped';
        this._updatePreviewUI();
        this._drawMinimapFrame(0);
        // Reset the panel back to tick 0 so the next preview starts
        // with clean hand bands instead of the last tick's state.
        if (this._handsPreviewPanel && typeof this._handsPreviewPanel.reset === 'function') {
          this._handsPreviewPanel.reset();
        }
      };
    },

    _updatePreviewUI() {
      const modal = this.modal;
      if (!modal) return;
      const playing = this._previewState === 'playing';
      const paused = this._previewState === 'paused';
      const active = playing || paused;

      const allBtn = modal.querySelector('#rsPreviewAllBtn');
      const chBtn = modal.querySelector('#rsPreviewChBtn');
      const origBtn = modal.querySelector('#rsPreviewOrigBtn');
      const pauseBtn = modal.querySelector('#rsPreviewPauseBtn');
      const stopBtn = modal.querySelector('#rsPreviewStopBtn');

      if (allBtn) allBtn.style.display = active ? 'none' : '';
      if (chBtn) chBtn.style.display = active ? 'none' : '';
      if (origBtn) origBtn.style.display = active ? 'none' : '';
      if (pauseBtn) { pauseBtn.style.display = active ? '' : 'none'; pauseBtn.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;'; }
      if (stopBtn) stopBtn.style.display = active ? '' : 'none';
    }
  };

  window.RoutingSummaryPreviewControls = Object.freeze(PreviewControls);
})();
