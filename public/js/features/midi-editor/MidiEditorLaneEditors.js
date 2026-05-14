// ============================================================================
// File: public/js/features/midi-editor/MidiEditorLaneEditors.js
// Description: Lane-editor lifecycle (CC / Velocity / Tempo) + cross-editor
//   viewport synchronization — extracted from MidiEditorCCPicker per
//   audit §1.3 (god-class split).
//
// Owns:
//   - `initCCEditor()` / `waitForCCEditorLayout()`
//   - `initVelocityEditor()` / `waitForVelocityEditorLayout()`
//   - `initTempoEditor()` / `waitForTempoEditorLayout()`
//   - `syncCCEditor()` / `syncCCEventsFromEditor()` / `syncTempoEventsFromEditor()`
//   - `syncAllEditors()` — push xrange/xoffset to every visible lane editor
//   - `_getActiveEditorHeaderWidth()` — left-gutter width used by the
//     PlaybackTimelineBar.
//
// Accessed via `modal.ccPicker.laneEditors`. MidiEditorCCPicker keeps
// thin delegate methods preserving the legacy names so external
// callers (MidiEditorCC, MidiEditorViewport, DrumPatternEditor,
// WindInstrumentEditor, TablatureEditor, MidiEditorPlayback) are
// unchanged.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorLaneEditors {
        /** @param {MidiEditorCCPicker} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

    initCCEditor() {
        const container = document.getElementById('cc-editor-container');
        if (!container) {
            this.modal.log('warn', 'Container cc-editor-container not found');
            return;
        }

        if (this.modal.ccEditor) {
            this.modal.log('info', 'CC Editor already initialized');
            return;
        }

        this.modal.log('info', `Initializing CC Editor with ${this.modal.ccEvents.length} total CC events`);

    // Read the piano-roll parameters
        const options = {
            timebase: this.modal.pianoRollRenderer?.getTimebase() || 480,
            xrange: this.modal.pianoRollRenderer?.getXRange() || 1920,
            xoffset: this.modal.pianoRollRenderer?.getXOffset() || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            onChange: () => {
    // Mark as dirty on CC/pitch-bend changes
                this.modal.isDirty = true;
                this.modal.routingOps?.updateSaveButton();
            }
        };

    // Create the editor
        this.modal.ccEditor = new CCPitchbendEditor(container, options);
        this.modal.ccEditor.setCC(this.modal.currentCCType);

    // Load existing events BEFORE refreshing the selector
        if (this.modal.ccEvents.length > 0) {
            this.modal.ccEditor.loadEvents(this.modal.ccEvents);
            this.modal.log('info', `Loaded ${this.modal.ccEvents.length} CC events into editor`);
        }

    // Update the channel selector to show only used channels
        this.modal.ccOps.updateEditorChannelSelector();

    // When editing a single channel, use that channel; otherwise fall back to first channel
        let activeChannel;
        if (this.modal.activeChannels && this.modal.activeChannels.size === 1) {
            activeChannel = Array.from(this.modal.activeChannels)[0];
        } else {
            const fileChannels = this.modal.channels.map(ch => ch.channel).sort((a, b) => a - b);
            const usedChannels = this.modal.ccOps.getCCChannelsUsed();
            activeChannel = fileChannels.length > 0 ? fileChannels[0] : (usedChannels.length > 0 ? usedChannels[0] : 0);
        }
        this.modal.ccEditor.setChannel(activeChannel);

    // Auto-select a CC type that has data on this channel
        this.modal.ccOps.selectBestCCTypeForChannel(activeChannel);

        this.modal.ccOps.highlightUsedCCButtons();

        this.modal.log('info', `CC Editor initialized - Type: ${this.modal.currentCCType}, Channel: ${activeChannel + 1}, File channels: [${fileChannels.map(c => c + 1).join(', ')}]`);

    // Add a listener that refreshes the delete button on interactions
        container.addEventListener('mouseup', () => {
    // Use setTimeout so the selection updates first
            setTimeout(() => this.parent.updateDeleteButtonState(), 0);
        });

    // Wait for the flex layout to settle before resizing
    // Use requestAnimationFrame in a loop until the element has a valid height
        this.waitForCCEditorLayout();
    }

    waitForCCEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.modal.ccEditor || !this.modal.ccEditor.element) {
            this.modal.log('warn', 'waitForCCEditorLayout: ccEditor or element not found');
            return;
        }

        const height = this.modal.ccEditor.element.getBoundingClientRect().height;
        this.modal.log('debug', `waitForCCEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.modal.ccEditor.resize();
    // Resume rendering for the active sub-editor
            if (typeof this.modal.ccEditor.resume === 'function') this.modal.ccEditor.resume();
            if (this.modal.velocityEditor && typeof this.modal.velocityEditor.resume === 'function') this.modal.velocityEditor.resume();
            if (this.modal.tempoEditor && typeof this.modal.tempoEditor.resume === 'function') this.modal.tempoEditor.resume();
            this.modal.log('info', `CC Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForCCEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.modal.log('error', `waitForCCEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    syncCCEditor() {
        if (!this.modal.ccEditor) return;

        const viewport = this.modal.editActions._getActiveViewportState();
        this.modal.ccEditor.syncWith({
            xrange: viewport.xrange,
            xoffset: viewport.xoffset,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            timebase: this.modal.pianoRollRenderer?.getTimebase()
        });
    }

    _getActiveEditorHeaderWidth() {
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.tablatureEditor.renderer) {
            return this.modal.tablatureEditor.renderer.headerWidth || 40;
        }
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible && this.modal.windInstrumentEditor.renderer) {
            return this.modal.windInstrumentEditor.renderer.headerWidth || 50;
        }
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible && this.modal.drumPatternEditor.gridRenderer) {
            return this.modal.drumPatternEditor.gridRenderer.headerWidth || 80;
        }
    // Default: piano roll (yruler 24 + kbwidth 40)
        return 64;
    }

    syncAllEditors() {
        this.syncCCEditor();
        this.syncVelocityEditor();
        this.syncTempoEditor();

        const viewport = this.modal.editActions._getActiveViewportState();
        const activeLeftOffset = this._getActiveEditorHeaderWidth();

    // Sync PlaybackTimelineBar with active editor scroll/zoom
        if (this.modal.timelineBar) {
            const containerWidth = this.modal.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;
            this.modal.timelineBar.setLeftOffset(activeLeftOffset);
            this.modal.timelineBar.setScrollX(viewport.xoffset);
            this.modal.timelineBar.setZoom(viewport.xrange / Math.max(1, containerWidth - activeLeftOffset));
        }

    // Sync NavigationOverviewBar with active editor viewport
        if (this.modal.navigationBar) {
            const maxTick = this.modal.midiData?.maxTick || 0;
            this.modal.navigationBar.setViewport(viewport.xoffset, viewport.xrange, maxTick);
        }
    }

    syncCCEventsFromEditor() {
        if (!this.modal.ccEditor) {
    // The CC editor was never opened — ccEditor is the only editing path,
    // so events extracted from the original file remain up to date.
            this.modal.log('debug', `syncCCEventsFromEditor: editor not opened, preserving ${this.modal.ccEvents.length} original events`);
            return;
        }

    // Grab every event from the editor
        const editorEvents = this.modal.ccEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.modal.log('info', 'syncCCEventsFromEditor: No CC events in editor');
            this.modal.ccEvents = [];
            return;
        }

    // Editor events are already in the correct format
    // { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
        this.modal.ccEvents = editorEvents.map(e => ({
            type: e.type,
            ticks: e.ticks,
            channel: e.channel,
            value: e.value,
            id: e.id
        }));

        this.modal.log('info', `Synchronized ${this.modal.ccEvents.length} CC/pitchbend events from editor`);

    // Sample log for debugging
        if (this.modal.ccEvents.length > 0) {
            const sample = this.modal.ccEvents.slice(0, 3);
            this.modal.log('debug', 'Sample synchronized events:', sample);
        }
    }

    syncTempoEventsFromEditor() {
        if (!this.modal.tempoEditor) {
            this.modal.log('info', `syncTempoEventsFromEditor: Tempo editor not initialized, keeping ${this.modal.tempoEvents.length} original events`);
            return;
        }

        const editorEvents = this.modal.tempoEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.modal.log('info', 'syncTempoEventsFromEditor: No tempo events in editor');
            this.modal.tempoEvents = [];
            return;
        }

        this.modal.tempoEvents = editorEvents.map(e => ({
            ticks: e.ticks,
            tempo: e.tempo,
            id: e.id
        }));

    // Update the global tempo with the first event
        if (this.modal.tempoEvents.length > 0) {
            this.modal.tempo = this.modal.tempoEvents[0].tempo;
        }

        this.modal.log('info', `Synchronized ${this.modal.tempoEvents.length} tempo events from editor`);
    }

    initVelocityEditor() {
        const container = document.getElementById('velocity-editor-container');
        if (!container) {
            this.modal.log('warn', 'Container velocity-editor-container not found');
            return;
        }

        if (this.modal.velocityEditor) {
            this.modal.log('info', 'Velocity Editor already initialized');
            return;
        }

        this.modal.log('info', `Initializing Velocity Editor with ${this.modal.sequence.length} notes`);

    // Read the piano-roll parameters
        const options = {
            timebase: this.modal.pianoRollRenderer?.getTimebase() || 480,
            xrange: this.modal.pianoRollRenderer?.getXRange() || 1920,
            xoffset: this.modal.pianoRollRenderer?.getXOffset() || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            onChange: (sequence) => {
    // Mark as dirty on velocity changes
                this.modal.isDirty = true;
                this.modal.routingOps?.updateSaveButton();
    // Synchroniser vers fullSequence et sequence
                this.parent.syncSequenceFromVelocityEditor(sequence);
            }
        };

    // Create the editor
        this.modal.velocityEditor = new VelocityEditor(container, options);

    // Load the full (unfiltered) sequence for the velocity editor
        this.modal.velocityEditor.setSequence(this.modal.fullSequence);

    // When editing a single channel, use that channel; otherwise first channel
        const firstChannel = (this.modal.activeChannels && this.modal.activeChannels.size === 1)
            ? Array.from(this.modal.activeChannels)[0]
            : (this.modal.channels.length > 0 ? this.modal.channels[0].channel : 0);
        this.modal.velocityEditor.setChannel(firstChannel);

        this.modal.ccOps.highlightUsedCCButtons();

        this.modal.log('info', `Velocity Editor initialized with ${this.modal.fullSequence.length} notes, default channel: ${firstChannel + 1}`);

    // Update the channel selector
        this.modal.ccOps.updateEditorChannelSelector();

    // Add a listener that refreshes the delete button on interactions
        container.addEventListener('mouseup', () => {
    // Use setTimeout so the selection updates first
            setTimeout(() => this.parent.updateDeleteButtonState(), 0);
        });

    // Wait for the layout to be ready
        this.waitForVelocityEditorLayout();
    }

    waitForVelocityEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.modal.velocityEditor || !this.modal.velocityEditor.element) {
            this.modal.log('warn', 'waitForVelocityEditorLayout: velocityEditor or element not found');
            return;
        }

        const height = this.modal.velocityEditor.element.getBoundingClientRect().height;
        this.modal.log('debug', `waitForVelocityEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.modal.velocityEditor.resize();
            this.modal.log('info', `Velocity Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForVelocityEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.modal.log('error', `waitForVelocityEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    initTempoEditor() {
        const container = document.getElementById('tempo-editor-container');
        if (!container) {
            this.modal.log('warn', 'Container tempo-editor-container not found');
            return;
        }

        if (this.modal.tempoEditor) {
            this.modal.log('info', 'Tempo Editor already initialized');
            return;
        }

        this.modal.log('info', 'Initializing Tempo Editor');

    // Read the piano-roll parameters
        const options = {
            timebase: this.modal.pianoRollRenderer?.getTimebase() || 480,
            xrange: this.modal.pianoRollRenderer?.getXRange() || 1920,
            xoffset: this.modal.pianoRollRenderer?.getXOffset() || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
    // Mark as dirty on tempo changes
                this.modal.isDirty = true;
                this.modal.routingOps?.updateSaveButton();
            }
        };

    // Create the editor
        this.modal.tempoEditor = new TempoEditor(container, options);

    // Load existing tempo events
        this.modal.tempoEditor.setEvents(this.modal.tempoEvents);

        this.modal.log('info', `Tempo Editor initialized with ${this.modal.tempoEvents.length} events`);

    // Wait for the layout to be ready
        this.waitForTempoEditorLayout();
    }

    waitForTempoEditorLayout(attempts = 0, maxAttempts = 60) {
        if (!this.modal.tempoEditor || !this.modal.tempoEditor.element) {
            this.modal.log('warn', 'waitForTempoEditorLayout: tempoEditor or element not found');
            return;
        }

        const height = this.modal.tempoEditor.element.getBoundingClientRect().height;
        this.modal.log('debug', `waitForTempoEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.modal.tempoEditor.resize();
            this.modal.log('info', `Tempo Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForTempoEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.modal.log('error', `waitForTempoEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorLaneEditors = MidiEditorLaneEditors;
    }
})();
