// ============================================================================
// File: public/js/features/midi-editor/MidiEditorResize.js
// Description: Drag-to-resize between the notes section and the CC section —
//   extracted from MidiEditorEvents.attachEvents() per audit §1.3 (god-class
//   split). Concentrates the resize anti-pattern hacks (audit §2.5 / §7.2):
//   double-call resize() with 32 ms timeout for layout stabilization,
//   forced reflow chain across 5 flex levels, RAF-coalesced mousemove.
//
// TODO(audit §2.5): once the V2 Canvas renderer is the default and the
// CC/Velocity editors share a BaseLaneEditor with proper ResizeObserver,
// the double-call timeouts should disappear.
//
// Accessed via `modal.events.resize`. The only entry point is
// `attachHandler()` invoked from MidiEditorEvents.attachEvents().
// ============================================================================

(function () {
    'use strict';

    class MidiEditorResize {
        /** @param {MidiEditorEvents} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

        attachHandler() {
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
            const signal = this.parent.getAbortSignal();
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
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorResize = MidiEditorResize;
    }
})();
