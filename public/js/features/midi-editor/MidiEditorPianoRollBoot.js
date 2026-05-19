// ============================================================================
// File: public/js/features/midi-editor/MidiEditorPianoRollBoot.js
// Description: Piano-roll boot + container size sync — extracted from
//   MidiEditorRouting per audit §1.3 (god-class split).
//
// Owns:
//   - `initPianoRoll()` — picks the renderer (Webaudio adapter / Canvas V2),
//     mounts it, computes viewport defaults, wires change / selection /
//     piano-key / drag-move listeners, ResizeObserver, theme apply.
//   - `refreshSize()` — re-queries the container clientWidth/clientHeight
//     and pushes it to the renderer.
//
// Accessed via `modal.routingOps.pianoRollBoot`. MidiEditorRouting keeps
// thin delegates (`initPianoRoll`, `_refreshPianoRollSize`) so external
// callers (MidiEditorModal, LoopEditorModal) are unchanged.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorPianoRollBoot {
        /** @param {MidiEditorRouting} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

        // ----------------------------------------------------------------
        // Container size sync
        // ----------------------------------------------------------------

        refreshSize() {
            const renderer = this.modal.pianoRollRenderer;
            if (!renderer?.isMounted()) return false;
            const container = this.modal.container?.querySelector('#piano-roll-container');
            if (!container) return false;
            const w = container.clientWidth  || 0;
            const h = container.clientHeight || 0;
            if (w <= 0 || h <= 0) return false;
            renderer.setSize(w, h);
            return true;
        }

        // ----------------------------------------------------------------
        // Piano-roll boot
        // ----------------------------------------------------------------

        async initPianoRoll() {
            const m = this.modal;
            const container = document.getElementById('piano-roll-container');
            if (!container) {
                m.log('error', 'Piano roll container not found');
                return;
            }

            if (typeof CanvasPianoRollRenderer === 'undefined') {
                m.showError(m.t('midiEditor.libraryNotLoaded'));
                return;
            }

            // Piano roll renderer (audit §1.1) — Canvas 2D: viewport
            // culling + grid-bucket spatial index. The invariant
            // `modal.pianoRoll === modal.pianoRollRenderer.getElement()`
            // is maintained so non-migrated call sites keep working
            // unchanged.
            m.pianoRollRenderer = new CanvasPianoRollRenderer({
                container,
                width:  container.clientWidth  || 1000,
                height: container.clientHeight || 400,
                ppq:    m.ticksPerBeat || 480,
                tempo:  m.tempo || 120,
                mode:   'dragpoly'
            });
            m.pianoRollRenderer.mount();
            m.pianoRoll = m.pianoRollRenderer.getElement();
            m.log('info', 'Piano roll renderer: CanvasPianoRollRenderer');

            // Configuration
            const width = container.clientWidth || 1000;
            const height = container.clientHeight || 400;

            // Compute the tick range from the sequence
            let maxTick = 0;
            let minNote = 127;
            let maxNote = 0;

            if (m.sequence && m.sequence.length > 0) {
                m.sequence.forEach(note => {
                    const endTick = note.t + note.g;
                    if (endTick > maxTick) maxTick = endTick;
                    if (note.n < minNote) minNote = note.n;
                    if (note.n > maxNote) maxNote = note.n;
                });

                m.log('info', `Sequence range: ticks 0-${maxTick}, notes ${minNote}-${maxNote}`);
            }

            // Store maxTick for the sliders
            if (!m.midiData) m.midiData = {};
            m.midiData.maxTick = maxTick;

            // Default zoom — loop mode fits the whole loop (bars × timeSig × ppq)
            // into the view since that's the unit of work. Standard (file) mode
            // keeps the legacy "first 20 seconds" framing.
            const ticksPerBeat = m.midiData.header?.ticksPerBeat || 480;
            const twentySeconds = ticksPerBeat * 40; // ~20 seconds at 120 BPM
            // Loop length in ticks — the loop's end boundary. Independent of
            // the sequence extent so an empty/short loop still shows where it
            // stops. (maxTick above was overwritten with the note extent.)
            const tsNum = m.midiData.header?.timeSignature?.[0] || 4;
            const loopEndTick = (m.ticksPerBeat || ticksPerBeat) * tsNum * (m.loopBars || 2);
            const xrange = m.loopMode
                ? loopEndTick
                : Math.min(maxTick > 0 ? maxTick : twentySeconds, twentySeconds);

            // Vertically centered view that keeps every note of visible channels onscreen
            const noteRange = Math.max(24, maxNote - minNote + 4);
            const centerNote = Math.floor((minNote + maxNote) / 2);
            const yoffset = Math.max(0, centerNote - Math.floor(noteRange / 2));

            const renderer = m.pianoRollRenderer;
            renderer.setSize(width, height)
                    .setEditMode('dragpoly')
                    .setXRange(xrange).setYRange(noteRange).setYOffset(yoffset)
                    .setAttribute('wheelzoom', '1')
                    .setAttribute('xscroll', '1')
                    .setAttribute('yscroll', '1')
                    .setAttribute('xruler', m.loopMode ? '1' : '0')
                    .setMarkers(0, m.loopMode ? loopEndTick : maxTick)
                    .setCursor(0);

            m.events._applyPianoRollTheme();

            m.log('info', `Piano roll configured: xrange=${xrange}, yrange=${noteRange}, yoffset=${yoffset} (centered), tempo=${m.tempo || 120} BPM, timebase=${m.ticksPerBeat || 480} ticks/beat`);

            renderer.attachToContainer();

            // OPTIMIZATION: batch property assignments to avoid multiple redraws
            const currentSnap = m.snapValues[m.currentSnapIndex];
            renderer.beginBatchUpdate()
                    .setTempo(m.tempo || 120)
                    .setTimebase(m.ticksPerBeat || 480)
                    .setGrid(120)
                    .setSnap(currentSnap.ticks)
                    .endBatchUpdate();

            m.log('info', `Piano roll grid/snap: grid=120 ticks, snap=${currentSnap.ticks} ticks (${currentSnap.label})`);

            // Wait one RAF for the component to layout
            await new Promise(resolve => requestAnimationFrame(resolve));

            renderer.setChannelColors(m.channelColors);

            if (m.activeChannels.size > 0) {
                renderer.setDefaultChannel(Array.from(m.activeChannels)[0]);
            }

            m.events._initNavigationOverview(maxTick, xrange);
            m.events.setupScrollSynchronization();
            m.events._initTimelineBar(maxTick, ticksPerBeat, xrange);

            if (m.sequence && m.sequence.length > 0) {
                m.log('info', `Loading ${m.sequence.length} notes into piano roll`);
                m.log('debug', 'First 3 notes:', JSON.stringify(m.sequence.slice(0, 3)));
                renderer.setSequence(m.sequence).redraw();
                m.log('info', 'Piano roll redrawn with channel colors');
                m.log('debug', `Piano roll sequence length: ${renderer.getSequence().length}`);
            } else {
                m.log('info', 'No notes to display in piano roll — starting empty');
                renderer.setSequence([]).redraw();
            }

            // Store a sequence copy to detect changes
            let previousSequence = [];
            let changeTimeout = null;
            const handleChange = () => {
                m.handleNoteFeedback(previousSequence);

                if (changeTimeout) clearTimeout(changeTimeout);
                changeTimeout = setTimeout(() => {
                    m.isDirty = true;
                    this.parent.updateSaveButton();
                    m.sequenceOps.syncFullSequenceFromPianoRoll();
                    m.editActions?.updateUndoRedoButtonsState();
                    m.editActions?.updateEditButtons();
                    previousSequence = this.parent.copySequence(renderer.getSequence());
                }, 100);
            };

            previousSequence = this.parent.copySequence(renderer.getSequence());

            renderer.on('change', handleChange);
            renderer.on('selectionchange', () => {
                m.editActions?.updateEditButtons();
            });

            // The renderer can move selected notes to another channel from
            // its right-click menu. `change` alone re-syncs the sequence but
            // does NOT register a brand-new channel in the panel, so the
            // moved notes would render with a colour yet no chip / active
            // entry. Run the same bookkeeping pipeline as the toolbar's
            // ChannelOps.changeChannel() (sync → rebuild channels → prune
            // empties → activate target → reload → refresh chips).
            renderer.on('channelchange', (e) => {
                const newChannel = e.detail?.channel;
                if (newChannel == null) return;
                // `changeChannelSelection` also emitted `change`, which
                // scheduled a 100ms-debounced syncFullSequenceFromPianoRoll.
                // We run the full pipeline synchronously here, so cancel that
                // pending debounce to avoid a second, racing sync against a
                // now-reloaded sequence.
                if (changeTimeout) { clearTimeout(changeTimeout); changeTimeout = null; }
                m.isDirty = true;
                this.parent.updateSaveButton();
                m.sequenceOps.syncFullSequenceFromPianoRoll();
                m.ccPicker.updateChannelsFromSequence();
                const existing = new Set(m.channels.map(ch => ch.channel));
                [...m.activeChannels].forEach(ch => {
                    if (!existing.has(ch)) m.activeChannels.delete(ch);
                });
                if (!m.activeChannels.has(newChannel)) m.activeChannels.add(newChannel);
                m.sequenceOps.updateSequenceFromActiveChannels(null, true);
                m.editActions?.refreshChannelButtons();
                m.renderer.updateInstrumentSelector();
                m.editActions?.updateEditButtons();
                m.editActions?.updateUndoRedoButtonsState();
                // Refresh the change-detection baseline so the next genuine
                // edit is diffed against the post-pipeline sequence.
                previousSequence = this.parent.copySequence(renderer.getSequence());
            });

            // Auto-resize the canvas whenever its container changes size —
            // coalesced onto a single RAF per resize burst.
            if (typeof ResizeObserver !== 'undefined') {
                m._pianoRollContainerObs?.disconnect?.();
                let lastW = 0, lastH = 0;
                let scheduled = false;
                m._pianoRollContainerObs = new ResizeObserver(() => {
                    const w = container.clientWidth, h = container.clientHeight;
                    if (w === lastW && h === lastH) return;
                    lastW = w; lastH = h;
                    if (scheduled) return;
                    scheduled = true;
                    requestAnimationFrame(() => {
                        scheduled = false;
                        this.refreshSize();
                    });
                });
                m._pianoRollContainerObs.observe(container);
            }

            renderer.on('pianokey', (e) => {
                if (!m.keyboardPlaybackEnabled) return;
                const note = e.detail.note;
                const channel = renderer.getDefaultChannel() || 0;
                m.playNoteHold(note, 100, channel);
            });
            renderer.on('pianokeyup', (e) => {
                const note = e.detail.note;
                const channel = renderer.getDefaultChannel() || 0;
                m.releaseNote(note, channel);
            });

            // Drag feedback throttle + dedup (audit P1.2). notedragmove fires
            // at up to ~60 Hz; each playNoteFeedback is an async synth call.
            // Stay silent while a note only moves in time (same pitch), and
            // cap re-triggers at ~30 Hz so a held drag doesn't spam the synth.
            let dragFbKeys = new Set();
            let dragFbAt = 0;
            renderer.on('notedragmove', (e) => {
                if (!m.dragPlaybackEnabled) return;
                const notes = e.detail.notes;
                if (!notes || notes.length === 0 || notes.length > 6) return;
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                const nextKeys = new Set();
                const fresh = [];
                for (const note of notes) {
                    const key = `${note.c || 0}:${note.n}`;
                    nextKeys.add(key);
                    if (!dragFbKeys.has(key)) fresh.push(note);
                }
                dragFbKeys = nextKeys;
                if (fresh.length === 0) return;       // pitch unchanged → silent
                if (now - dragFbAt < 33) return;      // ~30 Hz cap
                dragFbAt = now;
                fresh.forEach(note => {
                    m.playNoteFeedback(note.n, note.v || 100, note.c || 0);
                });
            });

            this.parent.updateStats();
            m.editActions?.updateEditButtons();
            m.editActions?.updateUndoRedoButtonsState();
            m.renderer.updateInstrumentSelector();

            if (renderer?.isMounted()) {
                renderer.setUIMode(m.editMode);
                m.log('info', `Piano roll UI mode set to: ${m.editMode}`);
            }

            await this.parent.loadConnectedDevices();
            await m.tablatureOps?._loadSavedRoutings();

            if (m.channelPanel) {
                m.channelPanel.updateTablatureButton();
            }

            // Pre-warm the synth + soundbank in the background (audit P1.1) so
            // the first note feedback is instant. Fire-and-forget, off the
            // critical open path. The handle + canceller are stored on the
            // modal so the lifecycle close can abort a still-pending warm-up
            // (otherwise it would re-create an AudioContext for a modal that
            // is already torn down). `requestIdleCallback` is bound — calling
            // it detached from `window` throws "Illegal invocation".
            const hasRIC = (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function');
            const scheduleIdle = hasRIC ? window.requestIdleCallback.bind(window) : ((cb) => setTimeout(cb, 0));
            m._warmupIdleCancel = hasRIC ? window.cancelIdleCallback.bind(window) : clearTimeout;
            m._warmupIdleHandle = scheduleIdle(() => {
                m._warmupIdleHandle = null;
                m._playback?.warmUpSynth?.();
            });
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorPianoRollBoot = MidiEditorPianoRollBoot;
    }
})();
