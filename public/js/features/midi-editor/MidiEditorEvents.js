// ============================================================================
// File: public/js/features/midi-editor/MidiEditorEvents.js
// Description: DOM event attachment + viewport / navigation / zoom / scroll.
//   Sub-component class ; called via `modal.events.<method>(...)`.
//   (P2-F.10f body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorEvents {
        constructor(modal) {
            this.modal = modal;
            // AbortController scoped to the current modal session. Listeners
            // attached on `document` / `window` should pass `{ signal }` so a
            // single `detachEvents()` call wipes them all (audit §7.1, §8.1).
            this._abortController = null;
        }

        /**
         * @returns {AbortSignal|undefined} Signal for cross-DOM listeners.
         *   `undefined` when called before `attachEvents()` — caller should
         *   skip the attach to avoid an unmanaged listener.
         */
        getAbortSignal() {
            return this._abortController?.signal;
        }

        /**
         * Abort every listener registered with this session's signal.
         * Called from `MidiEditorLifecycle.doClose()`.
         */
        detachEvents() {
            if (this._abortController) {
                try { this._abortController.abort(); } catch { /* best-effort */ }
                this._abortController = null;
            }
        }

    attachEvents() {
        if (!this.modal.container) return;
        // Fresh controller per attach so reopened modals don't reuse a
        // pre-aborted signal.
        if (this._abortController) {
            try { this._abortController.abort(); } catch { /* best-effort */ }
        }
        this._abortController = new AbortController();

    // No backdrop click-to-close for the MIDI editor
    // (prevents accidental dismissals during editing)

    // Action buttons
        this.modal.container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;

            switch (action) {
                case 'close':
                    this.modal.close();
                    break;
                case 'save':
                    this.modal.fileOps.saveMidiFile();
                    break;
                case 'save-as':
                    this.modal.fileOps.showSaveAsDialog();
                    break;
                case 'auto-assign':
                    this.modal.fileOps.showAutoAssignModal();
                    break;
                case 'zoom-h-in':
                    this.zoomHorizontal(0.8);
                    break;
                case 'zoom-h-out':
                    this.zoomHorizontal(1.25);
                    break;
                case 'zoom-v-in':
                    this.zoomVertical(0.8);
                    break;
                case 'zoom-v-out':
                    this.zoomVertical(1.25);
                    break;

    // New edit buttons
                case 'undo':
                    this.modal.editActions?.undo();
                    break;
                case 'redo':
                    this.modal.editActions?.redo();
                    break;
                case 'copy':
                    this.modal.editActions?.copy();
                    break;
                case 'paste':
                    this.modal.editActions?.paste();
                    break;
                case 'delete':
                    this.modal.editActions?.deleteSelectedNotes();
                    break;
                case 'select-all':
                    this.modal.editActions?.selectAll();
                    break;
                case 'change-channel':
                    this.modal.editActions?.changeChannel();
                    break;
                case 'apply-instrument':
                    this.modal.editActions?.applyInstrument();
                    break;
                case 'cycle-snap':
                    this.modal.editActions?.cycleSnap();
                    break;
                case 'show-info':
                    this.modal.infoModal?.show();
                    break;
                case 'rename-file':
                    this.modal.fileOps.showRenameDialog();
                    break;
                case 'toggle-settings-popover':
                    this.toggleSettingsPopover();
                    break;
                case 'toggle-preview-source':
                    this.modal.routingOps?.togglePreviewSource();
                    break;
    // configure-string-instrument removed — config is in instrument settings

    // Playback controls
                case 'playback-play':
                    this.modal.playbackPlay();
                    break;
                case 'playback-pause':
                    this.modal.playbackPause();
                    break;
                case 'playback-stop':
                    this.modal.playbackStop();
                    break;

    // Edit modes
                case 'mode-select':
                case 'mode-drag-notes':
                case 'mode-drag-view':
                case 'mode-add-note':
                case 'mode-resize-note':
                case 'mode-edit': {
                    const mode = btn.dataset.mode;
                    if (mode) {
                        this.modal.editActions?.setEditMode(mode);
                    }
                    break;
                }
            }
        });

    // Channel settings popover outside-click is now handled by a global
    // document listener attached/removed in _toggleChannelSettingsPopover /
    // _closeChannelSettingsPopover — no capture-phase container listener needed.

    // OPTIMIZATION: Event delegation for all channel buttons
    // Replaces 4 forEach loops × 16 buttons = ~64 listeners with a single listener
        this.modal.container.addEventListener('click', (e) => {
            const channelChip = e.target.closest('.channel-chip');
            if (channelChip) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(channelChip.dataset.channel);
                if (isNaN(channel)) return;

    // If a specialized editor (TAB/DRUM/WIND) or the piano-roll solo mode is
    // active, exit it and show the previously-active channels PLUS the newly
    // clicked channel in the normal piano roll.
                const wasSpecialized = this.modal.editActions?._isSpecializedEditorActive()
                    || this.modal._pianoRollSoloChannel != null;
                if (wasSpecialized) {
                    const previousActiveChannels = new Set(this.modal.activeChannels);
                    this.modal.tablatureOps._exitSpecializedEditor();
                    if (this.modal._savedActiveChannels) {
                        this.modal.activeChannels = new Set(this.modal._savedActiveChannels);
                        this.modal._savedActiveChannels = null;
                    }
                    this.modal.activeChannels.add(channel);
                    this.modal.channelDisabled.delete(channel);
                    this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
                    this.modal.routingOps.updateChannelButtons();
                    this.modal.renderer.updateInstrumentSelector();
                    this.modal.syncMutedChannels();
                    return;
                }
                this.modal.sequenceOps.toggleChannel(channel);
                return;
            }
            const settingsBtn = e.target.closest('.chip-settings-btn');
            if (settingsBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(settingsBtn.dataset.channel);
                if (!isNaN(channel)) this.modal.tablatureOps?._toggleChannelSettingsPopover(channel, settingsBtn);
                return;
            }
    // Global "Show All" button
            const showAllBtn = e.target.closest('.btn-show-all-channels');
            if (showAllBtn) {
                e.preventDefault();
                e.stopPropagation();
                const previousActiveChannels = new Set(this.modal.activeChannels);
    // Exit any specialized/solo editor and reset .active on every editor button
                this.modal.tablatureOps?._exitSpecializedEditor();
                this.modal._savedActiveChannels = null;
                this.modal.channels.forEach(ch => {
                    this.modal.activeChannels.add(ch.channel);
                    this.modal.channelDisabled.delete(ch.channel);
                });
                this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
                this.modal.routingOps.updateChannelButtons();
                this.modal.renderer.updateInstrumentSelector();
                this.modal.syncMutedChannels();
                return;
            }
            const tabBtn = e.target.closest('.channel-tab-btn');
            if (tabBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(tabBtn.dataset.channel);
                if (!isNaN(channel)) this.modal.tablatureOps?._openTablatureForChannel(channel);
                return;
            }
            const drumBtn = e.target.closest('.channel-drum-btn');
            if (drumBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(drumBtn.dataset.channel);
                if (!isNaN(channel)) this.modal.tablatureOps?._openDrumPatternForChannel(channel);
                return;
            }
            const windBtn = e.target.closest('.channel-wind-btn');
            if (windBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(windBtn.dataset.channel);
                if (!isNaN(channel)) this.modal.tablatureOps?._openWindEditorForChannel(channel);
                return;
            }
            const editBtn = e.target.closest('.channel-edit-btn');
            if (editBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(editBtn.dataset.channel);
                if (!isNaN(channel)) this.modal.tablatureOps?._openPianoRollForChannel(channel);
                return;
            }
        });

    // Double-click on channel chip = Solo (hide all others)
        this.modal.container.addEventListener('dblclick', (e) => {
            const channelChip = e.target.closest('.channel-chip');
            if (channelChip) {
                e.preventDefault();
                e.stopPropagation();
    // Block solo when a specialized editor is active
                if (this.modal.editActions?._isSpecializedEditorActive()) return;
                const channel = parseInt(channelChip.dataset.channel);
                if (!isNaN(channel)) {
                    const previousActiveChannels = new Set(this.modal.activeChannels);
                    this.modal.activeChannels.clear();
                    this.modal.activeChannels.add(channel);
                    this.modal.channels.forEach(ch => {
                        if (ch.channel === channel) {
                            this.modal.channelDisabled.delete(ch.channel);
                        } else {
                            this.modal.channelDisabled.add(ch.channel);
                        }
                    });
                    this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
                    this.modal.routingOps.updateChannelButtons();
                    this.modal.renderer.updateInstrumentSelector();
                    this.modal.syncMutedChannels();
                }
                return;
            }
        });

    // Toggle preview source (GM / Routed)
        const previewToggle = document.getElementById('preview-source-toggle');
        if (previewToggle) {
            previewToggle.addEventListener('click', () => this.modal.routingOps?.togglePreviewSource());
        }

    // Toggle playable notes global
        const playableToggle = document.getElementById('playable-notes-toggle');
        if (playableToggle) {
            playableToggle.addEventListener('click', () => this.modal.routingOps.togglePlayableNotesGlobal());
        }

    // Toggle touch mode — both the popover switch (#touch-mode-toggle) and
    // the inline toolbar button (#touch-mode-inline-toggle) flip the same
    // state. Loop/panel mode only renders the inline one.
        const touchModeToggle = document.getElementById('touch-mode-toggle');
        if (touchModeToggle) {
            touchModeToggle.addEventListener('click', () => this.modal.toggleTouchMode());
        }
        const touchModeInline = document.getElementById('touch-mode-inline-toggle');
        if (touchModeInline) {
            touchModeInline.addEventListener('click', () => this.modal.toggleTouchMode());
        }

    // Toggle keyboard playback
        const kbPlaybackToggle = document.getElementById('keyboard-playback-toggle');
        if (kbPlaybackToggle) {
            kbPlaybackToggle.addEventListener('click', () => this.modal.toggleKeyboardPlayback());
        }

    // Toggle drag playback
        const dragPlaybackToggle = document.getElementById('drag-playback-toggle');
        if (dragPlaybackToggle) {
            dragPlaybackToggle.addEventListener('click', () => this.modal.toggleDragPlayback());
        }

    // Tempo input
        const tempoInput = document.getElementById('tempo-input');
        if (tempoInput) {
            tempoInput.addEventListener('change', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
                    this.modal.setTempo(newTempo);
                } else {
    // Restore the previous value when invalid
                    e.target.value = this.modal.tempo || 120;
                }
            });
    // Also react to changes made while typing (input event)
            tempoInput.addEventListener('input', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
    // Real-time update (optional — can be removed if too chatty)
                    this.modal.setTempo(newTempo);
                }
            });
        }

    // CC section header (collapse/expand) — only on the title, not the channel tabs
        const ccSectionHeader = document.getElementById('cc-section-header');
        if (ccSectionHeader) {
            const ccTitle = ccSectionHeader.querySelector('.cc-section-title');
            if (ccTitle) {
                ccTitle.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.modal.ccOps.toggleCCSection();
                });
            }
    // Gear button for CC drawing settings
            const ccDrawSettingsBtn = ccSectionHeader.querySelector('#cc-draw-settings-btn');
            if (ccDrawSettingsBtn) {
                ccDrawSettingsBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.modal.drawSettings.toggleDrawSettingsPopover();
                });
            }
        }

    // CC type buttons (horizontal)
    // OPTIMIZATION: Event delegation for CC type, tool, and delete buttons
    // Replaces ~20+ individual listeners with a single delegated listener
        this.modal.container.addEventListener('click', (e) => {
            const ccTypeBtn = e.target.closest('.cc-type-btn');
            if (ccTypeBtn) {
                e.preventDefault();
                const ccType = ccTypeBtn.dataset.ccType;
                if (ccType) this.modal.ccOps.selectCCType(ccType);
                return;
            }
            const ccToolBtn = e.target.closest('.cc-tool-btn');
            if (ccToolBtn) {
                e.preventDefault();
                const tool = ccToolBtn.dataset.tool;
                if (tool) {
                    this.modal.container.querySelectorAll('.cc-tool-btn').forEach(b => b.classList.remove('active'));
                    ccToolBtn.classList.add('active');
                    if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
                        this.modal.tempoEditor.setTool(tool);
                    } else if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
                        this.modal.velocityEditor.setTool(tool);
                    } else if (this.modal.ccEditor) {
                        this.modal.ccEditor.setTool(tool);
                    }
                }
                return;
            }
            if (e.target.closest('#cc-delete-btn')) {
                e.preventDefault();
                this.modal.ccPicker.deleteSelectedCCVelocity();
                return;
            }
        });

    // "+" button to open the CC picker
        const ccAddBtn = document.getElementById('cc-add-btn');
        if (ccAddBtn) {
            ccAddBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.modal.ccPicker.openCCPicker();
            });
        }

    // Event listeners for channel buttons are attached
    // in attachEditorChannelListeners() called from updateEditorChannelSelector()
    // to avoid conflicts during dynamic channel updates


    // Instrument selector for new channels
        const instrumentSelector = document.getElementById('instrument-selector');
        if (instrumentSelector) {
            instrumentSelector.addEventListener('change', (e) => {
                this.modal.selectedInstrument = parseInt(e.target.value);
                this.modal.log('info', `Selected instrument changed to: ${this.modal.getInstrumentName(this.modal.selectedInstrument)} (${this.modal.selectedInstrument})`);
            });
        }

    // Drag bar to resize the CC/Velocity section
        const resizeBar = document.getElementById('cc-resize-btn');
        const notesSection = this.modal.container.querySelector('.notes-section');
        const ccSection = document.getElementById('cc-section');

        if (resizeBar && notesSection && ccSection) {
            this.modal.log('info', 'Resize bar found, attaching drag events');

    // Log on hover to verify the bar is accessible
            resizeBar.addEventListener('mouseenter', () => {
                this.modal.log('debug', 'Mouse entered resize bar');
            });

            let isResizing = false;
            let startY = 0;
            let startNotesHeight = 0;
            let availableHeight = 0;  // Actual space available for resizing
            let startNotesFlex = 3;
            let startCCFlex = 2;

            const startResize = (e) => {
                e.preventDefault();

                this.modal.log('info', '=== RESIZE MOUSEDOWN DETECTED ===');

    // Only allow resize if the CC section is expanded
                if (!this.modal.ccSectionExpanded || !ccSection.classList.contains('expanded')) {
                    this.modal.log('warn', 'Resize blocked: CC section not expanded');
                    return;
                }

                isResizing = true;
                startY = e.clientY;
                startNotesHeight = notesSection.clientHeight;

    // Capture the REAL available space — mode-agnostic. In loop/panel
    // mode the `.modal-dialog`, `.modal-header`, `.channels-toolbar`
    // elements don't exist (the panel skips that chrome), so the old
    // path (dialogHeight - header - toolbars) returned a negative
    // availableHeight and the resize produced nonsense rectangles.
    // The available vertical budget for the resize is just whatever
    // the two collapsible sections + the bar currently occupy ; we
    // redistribute that budget between them on drag.
                const resizeBarH0 = resizeBar?.clientHeight || 12;
                availableHeight = notesSection.clientHeight
                                + ccSection.clientHeight
                                + resizeBarH0;

                this.modal.log('info', `Resize: notes=${notesSection.clientHeight}px, cc=${ccSection.clientHeight}px, bar=${resizeBarH0}px, available=${availableHeight}px`);

    // Get the current flex-grow values
                const notesStyle = window.getComputedStyle(notesSection);
                const ccStyle = window.getComputedStyle(ccSection);
                startNotesFlex = parseFloat(notesStyle.flexGrow) || 3;
                startCCFlex = parseFloat(ccStyle.flexGrow) || 2;

                this.modal.log('info', `Initial flex: notes=${startNotesFlex}, cc=${startCCFlex}`);

    // Disable transitions during the resize to avoid animations
                notesSection.style.transition = 'none';
                ccSection.style.transition = 'none';

    // Disable the CSS min-height rules that cap the resize to ~50%
                notesSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('min-height', '0px', 'important');

    // Prevent content from overflowing above the CC section
                notesSection.style.setProperty('overflow', 'hidden', 'important');

                document.body.style.cursor = 'ns-resize';
                resizeBar.classList.add('dragging');
            };

            // RAF-coalesced resize: mousemove fires hundreds of times per
            // second, but the layout/reflow work below only needs to run
            // once per frame. Skip the body if a previous frame is still
            // pending; the latest `clientY` is captured into `_resizeLastY`
            // and consumed when the frame runs.
            let resizeRafId = 0;
            let resizeLastY = 0;

            const doResize = (e) => {
                if (!isResizing) return;
                resizeLastY = e.clientY;
                e.preventDefault();
                if (resizeRafId) return;
                resizeRafId = requestAnimationFrame(() => {
                    resizeRafId = 0;
                    if (!isResizing) return;
                    runResizeStep(resizeLastY);
                });
            };

            const runResizeStep = (clientY) => {
                const deltaY = clientY - startY;
                const resizeBarHeight = 12; // Bar height

    // Use the REAL available space captured at the start
                const totalFlexHeight = availableHeight - resizeBarHeight;

    // Very loose constraints: notes >= 20px (lets CC reach ~98%), cc >= 100px
                const minNotesHeight = 20;
                const minCCHeight = 100;
                const newNotesHeight = Math.max(minNotesHeight, Math.min(totalFlexHeight - minCCHeight, startNotesHeight + deltaY));
                const newCCHeight = totalFlexHeight - newNotesHeight;

                this.modal.log('debug', `Resize: deltaY=${deltaY}, availableH=${availableHeight}px, notesH=${newNotesHeight}px, ccH=${newCCHeight}px`);

    // Apply heights directly in pixels
    // Disable the CSS min-height rules that block the resize
                notesSection.style.setProperty('min-height', '0px', 'important');
                notesSection.style.setProperty('height', `${newNotesHeight}px`, 'important');
                notesSection.style.setProperty('flex', 'none', 'important');

                ccSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('height', `${newCCHeight}px`, 'important');
                ccSection.style.setProperty('flex', 'none', 'important');

    // Check whether the styles actually applied
                const actualNotesHeight = notesSection.clientHeight;
                const actualCCHeight = ccSection.clientHeight;
                this.modal.log('debug', `Applied styles - Expected: notes=${newNotesHeight}px cc=${newCCHeight}px, Actual: notes=${actualNotesHeight}px cc=${actualCCHeight}px`);

    // Resize the editors during drag so the grid stays visible
                requestAnimationFrame(() => {
    // SOLUTION 2.2: Force recalculation of the ENTIRE flex cascade (5 levels)
                    void ccSection.offsetHeight;
                    const ccContent = ccSection.querySelector('.cc-section-content');
                    const ccLayout = ccSection.querySelector('.cc-editor-layout');
                    const ccMain = ccSection.querySelector('.cc-editor-main');
                    void ccContent?.offsetHeight;
                    void ccLayout?.offsetHeight;
                    void ccMain?.offsetHeight;

                    if (this.modal.pianoRollRenderer?.isMounted()) {
                        this.modal.pianoRollRenderer.redraw();
                        this.modal.log('debug', 'Piano roll redraw called');
                    }

                    if (this.modal.ccEditor && typeof this.modal.ccEditor.resize === 'function') {
    // SOLUTION 2.1: fix the selector bug (.cc-pitchbend-editor, not -container)
                        const ccContainer = ccSection.querySelector('.cc-pitchbend-editor');
                        const ccHeight = ccContainer?.clientHeight || 0;
                        this.modal.log('debug', `CC editor resize called - container height: ${ccHeight}px`);

    // First resize call
                        this.modal.ccEditor.resize();

    // SOLUTION 2.3: double call after 2 frames for layout stabilization
                        setTimeout(() => {
                            if (this.modal.ccEditor && typeof this.modal.ccEditor.resize === 'function') {
                                this.modal.ccEditor.resize();
                                this.modal.log('debug', 'CC editor re-resize after layout stabilization');
                            }
                        }, 32);
                    }

                    if (this.modal.velocityEditor && typeof this.modal.velocityEditor.resize === 'function') {
                        this.modal.velocityEditor.resize();
                        this.modal.log('debug', 'Velocity editor resize called');

    // Double call for the velocity editor too
                        setTimeout(() => {
                            if (this.modal.velocityEditor && typeof this.modal.velocityEditor.resize === 'function') {
                                this.modal.velocityEditor.resize();
                            }
                        }, 32);
                    }
                });
            };

            const stopResize = () => {
                if (resizeRafId) { cancelAnimationFrame(resizeRafId); resizeRafId = 0; }
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = '';
                    resizeBar.classList.remove('dragging');

    // Re-enable transitions
                    notesSection.style.transition = '';
                    ccSection.style.transition = '';

    // KEEP overflow: hidden so the slider stays on top
    // Do not reset notesSection.style.overflow = '';

    // Resize the editors after the resize
                    requestAnimationFrame(() => {
                        this.modal.pianoRollRenderer?.redraw();

                        if (this.modal.ccEditor && typeof this.modal.ccEditor.resize === 'function') {
                            this.modal.ccEditor.resize();
                        }

                        if (this.modal.velocityEditor && typeof this.modal.velocityEditor.resize === 'function') {
                            this.modal.velocityEditor.resize();
                        }
                    });
                }
            };

            resizeBar.addEventListener('mousedown', startResize);
    // Bind document-level mousemove/mouseup via the session AbortSignal so
    // they are detached automatically in detachEvents() — no more manual
    // removeEventListener bookkeeping in MidiEditorLifecycle (audit §7.1).
            const signal = this.getAbortSignal();
            if (signal && !signal.aborted) {
                document.addEventListener('mousemove', doResize, { signal });
                document.addEventListener('mouseup',   stopResize, { signal });
            } else {
                // Fallback for the (very rare) case where attachEvents()
                // hasn't run yet. Store refs so doClose can clean up.
                this.modal._resizeDoResize = doResize;
                this.modal._resizeStopResize = stopResize;
                document.addEventListener('mousemove', doResize);
                document.addEventListener('mouseup',   stopResize);
            }
        }
    }

    reloadPianoRoll() {
        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.log('warn', 'Cannot reload piano roll: not initialized');
            return;
        }

        this.modal.log('info', `Reloading piano roll with ${this.modal.sequence.length} notes`);

    // Compute the tick range from the sequence
        let maxTick = 0;
        let minNote = 127;
        let maxNote = 0;

        if (this.modal.sequence && this.modal.sequence.length > 0) {
            this.modal.sequence.forEach(note => {
                const endTick = note.t + note.g;
                if (endTick > maxTick) maxTick = endTick;
                if (note.n < minNote) minNote = note.n;
                if (note.n > maxNote) maxNote = note.n;
            });
        }

    // Update the piano-roll attributes
        const xrange = Math.max(128, Math.ceil(maxTick / 128) * 128);
        const noteRange = Math.max(36, maxNote - minNote + 12);

        const renderer = this.modal.pianoRollRenderer;
        renderer?.setXRange(xrange).setYRange(noteRange)
                .setSequence(this.modal.sequence)
                .setChannelColors(this.modal.channelColors)
                .redraw();

    // Update the stats
        this.modal.routingOps?.updateStats();

        this.modal.log('info', `Piano roll reloaded: ${this.modal.sequence.length} notes, xrange=${xrange}, yrange=${noteRange}`);
    }

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

        this._scheduleWebaudioPianoRollRedraw(() => this.modal.ccPicker.syncAllEditors());
        this.modal.log('info', `Horizontal zoom: ${currentRange} -> ${newRange}`);
    }

    /**
     * Workaround for the third-party `<webaudio-pianoroll>` component: a
     * synchronous `.redraw()` right after an attribute change picks up
     * stale layout. The component needs at least one layout pass before
     * its internal geometry catches up. We defer the redraw to the next
     * macrotask (audit §2.5 — flagged as hack).
     *
     * TODO(audit §1.1): remove once the renderer is migrated off the
     * third-party component. Keep all calls funnelled through this
     * helper so the hack stays in one place.
     *
     * @param {Function} [afterRedraw] - optional follow-up (e.g. sync sub-editors).
     */
    _scheduleWebaudioPianoRollRedraw(afterRedraw) {
        // Capture the modal reference: by the time the timeout fires, the
        // modal may have been closed and `this.modal.pianoRoll` cleared.
        const modal = this.modal;
        setTimeout(() => {
            if (!modal.pianoRoll) return;
            if (typeof modal.pianoRoll.redraw === 'function') {
                modal.pianoRoll.redraw();
            }
            if (typeof afterRedraw === 'function') {
                try { afterRedraw(); } catch (_) { /* best-effort */ }
            }
        }, 50);
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

        this._scheduleWebaudioPianoRollRedraw();
        this.modal.log('info', `Vertical zoom: ${currentRange} -> ${newRange}`);
    }

    _initNavigationOverview(maxTick, xrange) {
        const overviewContainer = this.modal.container?.querySelector('#navigation-overview-container');
        if (!overviewContainer || typeof NavigationOverviewBar === 'undefined') return;

    // Clean up previous instance
        if (this.modal.navigationBar) {
            this.modal.navigationBar.destroy();
            this.modal.navigationBar = null;
        }

        this.modal.navigationBar = new NavigationOverviewBar(overviewContainer, {
            height: 20,
            onNavigate: (percentage) => {
                this.scrollHorizontal(percentage);
            },
            onZoom: (factor) => {
                this.zoomHorizontal(factor);
            }
        });

        this.modal.navigationBar.setViewport(0, xrange, maxTick);
        this._updateNavigationMinimap();
        this.modal.log('info', `Navigation overview bar initialized: maxTick=${maxTick}, xrange=${xrange}`);
    }

    _updateNavigationMinimap() {
        if (!this.modal.navigationBar) return;
        if (this.modal.activeChannels && this.modal.activeChannels.size === 1) {
            const ch = Array.from(this.modal.activeChannels)[0];
            const source = this.modal.fullSequence || this.modal.sequence || [];
            const notes = source.filter(n => n.c === ch);
            const color = (this.modal.channelColors && this.modal.channelColors[ch]) || '#888';
            this.modal.navigationBar.setMinimap(notes, color);
        } else {
            this.modal.navigationBar.setMinimap(null);
        }
    }

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

        // Route via the renderer abstraction — back-compat with the
        // current adapter (forwards to addEventListener under the hood).
        this.modal.pianoRollRenderer?.on('viewportchange', onViewportChange);
        // Store reference for cleanup
        this.modal._viewportChangeHandler = onViewportChange;
    }

    scrollHorizontal(percentage) {
    // Compute the offset based on the total range of the MIDI file
        const maxTick = this.modal.midiData?.maxTick || 0;

        const renderer = this.modal.pianoRollRenderer;
        if (renderer?.isMounted()) {
            const xrange = renderer.getXRange() || 128;
            const maxOffset = Math.max(0, maxTick - xrange);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setXOffset(newOffset);

    // Do not redraw the piano roll while it is hidden (wind editor active)
            if (!(this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)) {
                renderer.redraw();
            }
        }

    // Sync the tablature
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.tablatureEditor.renderer) {
            const renderer = this.modal.tablatureEditor.renderer;
            const canvasWidth = this.modal.tablatureEditor.tabCanvasEl?.width || 800;
            const visibleTicks = (canvasWidth - renderer.headerWidth) * renderer.ticksPerPixel;
            const maxOffset = Math.max(0, maxTick - visibleTicks);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setScrollX(newOffset);
        }

    // Sync the drum editor
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible && this.modal.drumPatternEditor.gridRenderer) {
            const renderer = this.modal.drumPatternEditor.gridRenderer;
            const canvasWidth = this.modal.drumPatternEditor.gridCanvasEl?.width || 800;
            const visibleTicks = (canvasWidth - (renderer.headerWidth || 0)) * (renderer.ticksPerPixel || 2);
            const maxOffset = Math.max(0, maxTick - visibleTicks);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setScrollX(newOffset);
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

    // Full MIDI range: notes 0-127
            const totalMidiRange = 128;
            const maxOffset = Math.max(0, totalMidiRange - yrange);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setYOffset(newOffset);

    // Do not redraw the piano roll while it is hidden (wind editor active)
            if (!(this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible)) {
                renderer.redraw();
            }
        }

    // Sync the wind editor
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
            this.modal.windInstrumentEditor.scrollVertical(percentage);
        }
    }

    _applyPianoRollTheme() {
        const renderer = this.modal.pianoRollRenderer;
        if (!renderer?.isMounted()) return;

        const isDark = document.body.classList.contains('dark-mode');
        renderer.setThemeColors(isDark ? {
            collt:          '#262830',
            coldk:          '#22242a',
            colgrid:        '#2e3038',
            colrulerbg:     '#1e2028',
            colrulerfg:     '#8890a0',
            colrulerborder: '#2e3038',
            colnoteborder:  'rgba(255,255,255,0.1)'
        } : {
            collt:          '#ddd6f3',
            coldk:          '#d2cae8',
            colgrid:        '#c8c0de',
            colrulerbg:     '#d5cdef',
            colrulerfg:     '#4a3f6b',
            colrulerborder: '#c0b8d8',
            colnoteborder:  'rgba(102,126,234,0.25)'
        });
    }

    toggleSettingsPopover() {
        const popover = this.modal.container.querySelector('#settings-popover');
        if (!popover) return;
        const isVisible = popover.style.display !== 'none';
        popover.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
            const signal = this.getAbortSignal();
            // No signal = modal closing; skip to avoid a permanent listener.
            if (!signal || signal.aborted) return;
            const closeHandler = (e) => {
                if (!popover.contains(e.target) &&
                    !e.target.closest('[data-action="toggle-settings-popover"]')) {
                    popover.style.display = 'none';
                    document.removeEventListener('click', closeHandler);
                }
            };
            // setTimeout defers the attach past the click that opened the
            // popover. Bail if the modal closed during that single tick.
            setTimeout(() => {
                if (signal.aborted) return;
                document.addEventListener('click', closeHandler, { signal });
            }, 0);
        }
    }

    _initTimelineBar(maxTick, ticksPerBeat, xrange) {
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
                const rangeEnd = this.modal.timelineBar.rangeEnd || (this.modal.midiData?.maxTick || 0);
                const clampedTick = Math.max(rangeStart, Math.min(tick, rangeEnd));
                this.modal.pianoRollRenderer?.setCursor(clampedTick);
                if (this.modal.synthesizer && typeof this.modal.synthesizer.seek === 'function') this.modal.synthesizer.seek(clampedTick);
                if (this.modal.timelineBar) this.modal.timelineBar.setPlayhead(clampedTick);
                if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) this.modal.tablatureEditor.updatePlayhead(clampedTick);
                if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) this.modal.drumPatternEditor.updatePlayhead(clampedTick);
                if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) this.modal.windInstrumentEditor.updatePlayhead(clampedTick);
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
                if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.tablatureEditor.renderer) this.modal.tablatureEditor.renderer.setScrollX(newScrollX);
                if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible && this.modal.drumPatternEditor.gridRenderer) this.modal.drumPatternEditor.gridRenderer.setScrollX(newScrollX);
                if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible && this.modal.windInstrumentEditor.renderer) this.modal.windInstrumentEditor.renderer.setScrollX(newScrollX);
                this.modal.ccPicker.syncCCEditor();
                this.modal.ccPicker.syncVelocityEditor();
                this.modal.ccPicker.syncTempoEditor();
            },
            onResize: () => {
    // Container width changed (modal resize, CC panel toggle, DPR change…) —
    // re-sync all editors so the timeline bar's ticksPerPixel tracks the
    // piano roll's xrange against the new width.
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
                    if (currentTick < start || currentTick > end) this.modal.synthesizer.currentTick = start;
                }
                if (this.modal.timelineBar) {
                    const playhead = this.modal.timelineBar.playheadTick;
                    if (playhead < start) { this.modal.timelineBar.setPlayhead(start); this.modal.pianoRollRenderer?.setCursor(start); }
                    else if (playhead > end) { this.modal.timelineBar.setPlayhead(end); this.modal.pianoRollRenderer?.setCursor(end); }
                }
                this.modal.log('debug', `Timeline range changed: ${start} - ${end}`);
            },
        });

        this.modal.timelineBar.setTotalTicks(maxTick);
        this.modal.timelineBar.setRange(0, maxTick);
        this.modal.timelineBar.setZoom(xrange / ((timelineContainer.clientWidth || 800) - pianoLeftOffset));
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorEvents = MidiEditorEvents;
    }
})();
