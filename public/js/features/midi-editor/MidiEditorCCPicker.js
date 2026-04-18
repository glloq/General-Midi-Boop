// ============================================================================
// File: public/js/features/midi-editor/MidiEditorCCPicker.js
// Description: CC picker modal (sub-component class; P2-F.10c body rewrite).
//   Called via `modal.ccPicker.<method>(...)` — no longer a prototype mixin.
// ============================================================================

(function() {
    'use strict';

    class MidiEditorCCPicker {
        constructor(modal) {
            this.modal = modal;
        }

    openCCPicker() {
    // Close if already open
        let existing = this.modal.container?.querySelector('#cc-picker-modal');
        if (existing) {
            existing.remove();
            return;
        }

        const addBtn = this.modal.container?.querySelector('#cc-add-btn');
        if (!addBtn) return;

    // Determine which CCs are already visible (have data or are static buttons)
        const allUsedTypes = this.modal.ccOps.getAllUsedCCTypes();
        const staticCCNums = new Set([1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]);

    // Build the picker's HTML content, grouped by category
        let categoriesHTML = '';
        MidiEditorModal.CC_CATEGORIES.forEach(cat => {
            const buttonsHTML = cat.ccs.map(ccNum => {
                const ccName = this.modal.ccOps._getCCName(ccNum);
                const ccType = `cc${ccNum}`;
                const isUsed = allUsedTypes.has(ccType);
                const isStatic = staticCCNums.has(ccNum);
                const classes = ['cc-picker-item'];
                if (isUsed) classes.push('has-data');
                if (isStatic) classes.push('is-static');
                return `<button class="${classes.join(' ')}" data-cc-num="${ccNum}" title="CC${ccNum} - ${ccName}">
                    <span class="cc-picker-num">CC${ccNum}</span>
                    <span class="cc-picker-name">${ccName}</span>
                    ${isUsed ? '<span class="cc-picker-badge">●</span>' : ''}
                </button>`;
            }).join('');

            categoriesHTML += `
                <div class="cc-picker-category">
                    <div class="cc-picker-category-title">${cat.name}</div>
                    <div class="cc-picker-category-items">${buttonsHTML}</div>
                </div>
            `;
        });

    // Ajouter un champ de saisie libre en bas
        const customInputHTML = `
            <div class="cc-picker-custom">
                <label class="cc-picker-category-title">${this.modal.t('midiEditor.groupCustomCC') || 'CC# libre'}</label>
                <div class="cc-picker-custom-row">
                    <input type="number" id="cc-picker-custom-input" min="0" max="127" placeholder="0-127" class="cc-picker-custom-input">
                    <button class="cc-picker-custom-go" id="cc-picker-custom-go">OK</button>
                </div>
            </div>
        `;

        const picker = document.createElement('div');
        picker.id = 'cc-picker-modal';
        picker.className = 'cc-picker-modal';
        picker.innerHTML = `
            <div class="cc-picker-header">
                <span class="cc-picker-title">${this.modal.t('midiEditor.addCC') || 'Ajouter un CC'}</span>
                <button class="cc-picker-close" id="cc-picker-close">✕</button>
            </div>
            <div class="cc-picker-body">
                ${categoriesHTML}
                ${customInputHTML}
            </div>
        `;

    // Positionner le picker sous le bouton +
        const toolbar = this.modal.container?.querySelector('.cc-type-toolbar');
        if (toolbar) {
            toolbar.style.position = 'relative';
            toolbar.appendChild(picker);
        }

    // Event delegation: single listener on picker body for all CC items
        const pickerBody = picker.querySelector('.cc-picker-body') || picker;
        pickerBody.addEventListener('click', (e) => {
            const item = e.target.closest('.cc-picker-item');
            if (!item) return;
            e.preventDefault();
            e.stopPropagation();
            const ccNum = parseInt(item.dataset.ccNum);
            if (!isNaN(ccNum)) {
                this.modal.ccOps.selectCCType(`cc${ccNum}`);
                picker.remove();
                this.modal.log('info', `CC picker: CC${ccNum} selected`);
            }
        });

        const closeBtn = picker.querySelector('#cc-picker-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                picker.remove();
            });
        }

        const customInput = picker.querySelector('#cc-picker-custom-input');
        const customGo = picker.querySelector('#cc-picker-custom-go');
        const applyCustom = () => {
            if (!customInput) return;
            const ccNum = parseInt(customInput.value);
            if (!isNaN(ccNum) && ccNum >= 0 && ccNum <= 127) {
                this.modal.ccOps.selectCCType(`cc${ccNum}`);
                picker.remove();
                this.modal.log('info', `CC picker custom: CC${ccNum} selected`);
            }
        };
        if (customGo) customGo.addEventListener('click', (e) => { e.preventDefault(); applyCustom(); });
        if (customInput) customInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
            e.stopPropagation();
        });

    // Fermer en cliquant en dehors
        const closeOnOutside = (e) => {
            if (!picker.contains(e.target) && e.target !== addBtn) {
                picker.remove();
                document.removeEventListener('mousedown', closeOnOutside);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 0);
    }

    updateCCEditorChannel() {
        if (!this.modal.ccEditor) return;

    // Use the first active channel as the CC editor's channel
        const activeChannel = this.modal.activeChannels.size > 0
            ? Array.from(this.modal.activeChannels)[0]
            : 0;

        this.modal.ccEditor.setChannel(activeChannel);
        this.modal.log('info', `Canal CC mis à jour: ${activeChannel}`);
    }

    deleteSelectedCCVelocity() {
        if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
            const selectedIds = Array.from(this.modal.tempoEditor.selectedEvents);
            this.modal.tempoEditor.removeEvents(selectedIds);
        } else if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
            this.modal.velocityEditor.deleteSelected();
        } else if (this.modal.ccEditor) {
            this.modal.ccEditor.deleteSelected();
        }

    // Update the delete button state
        this.updateDeleteButtonState();
    }

    updateDeleteButtonState() {
        const deleteBtn = this.modal.container?.querySelector('#cc-delete-btn');
        if (!deleteBtn) return;

        let hasSelection = false;
        if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
            hasSelection = this.modal.tempoEditor.selectedEvents.size > 0;
        } else if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
            hasSelection = this.modal.velocityEditor.selectedNotes.size > 0;
        } else if (this.modal.ccEditor) {
            hasSelection = this.modal.ccEditor.selectedEvents.size > 0;
        }

        deleteBtn.disabled = !hasSelection;
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
            timebase: this.modal.pianoRoll?.timebase || 480,
            xrange: this.modal.pianoRoll?.xrange || 1920,
            xoffset: this.modal.pianoRoll?.xoffset || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            onChange: () => {
    // Mark as dirty on CC/pitch-bend changes
                this.modal.isDirty = true;
                this.modal.updateSaveButton();
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
            setTimeout(() => this.updateDeleteButtonState(), 0);
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
            timebase: this.modal.pianoRoll?.timebase
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
            timebase: this.modal.pianoRoll?.timebase || 480,
            xrange: this.modal.pianoRoll?.xrange || 1920,
            xoffset: this.modal.pianoRoll?.xoffset || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            onChange: (sequence) => {
    // Mark as dirty on velocity changes
                this.modal.isDirty = true;
                this.modal.updateSaveButton();
    // Synchroniser vers fullSequence et sequence
                this.syncSequenceFromVelocityEditor(sequence);
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
            setTimeout(() => this.updateDeleteButtonState(), 0);
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
            timebase: this.modal.pianoRoll?.timebase || 480,
            xrange: this.modal.pianoRoll?.xrange || 1920,
            xoffset: this.modal.pianoRoll?.xoffset || 0,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
    // Mark as dirty on tempo changes
                this.modal.isDirty = true;
                this.modal.updateSaveButton();
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

    syncTempoEditor() {
        if (!this.modal.tempoEditor || !this.modal.pianoRoll) return;

        this.modal.tempoEditor.setXRange(this.modal.pianoRoll.xrange);
        this.modal.tempoEditor.setXOffset(this.modal.pianoRoll.xoffset);
        this.modal.tempoEditor.setGrid(this.modal.snapValues[this.modal.currentSnapIndex].ticks);
    }

    showCurveButtons() {
    // Create the buttons once if they do not exist
        let curveSection = this.modal.container.querySelector('.curve-section');
        if (!curveSection) {
    // Trouver la toolbar
            const toolbar = this.modal.container.querySelector('.cc-type-toolbar');
            if (!toolbar) return;

    // Create the curve-buttons section
            const curveHTML = `
                <div class="cc-toolbar-divider"></div>
                <div class="curve-section">
                    <label class="cc-toolbar-label">${this.modal.t('midiEditor.curveType')}</label>
                    <div class="cc-curve-buttons-horizontal">
                        <button class="cc-curve-btn active" data-curve="linear" title="${this.modal.t('midiEditor.curveLinear')}">━</button>
                        <button class="cc-curve-btn" data-curve="exponential" title="${this.modal.t('midiEditor.curveExponential')}">⌃</button>
                        <button class="cc-curve-btn" data-curve="logarithmic" title="${this.modal.t('midiEditor.curveLogarithmic')}">⌄</button>
                        <button class="cc-curve-btn" data-curve="sine" title="${this.modal.t('midiEditor.curveSine')}">∿</button>
                    </div>
                </div>
            `;

    // Insert before the divider preceding the delete button
            const deleteBtn = this.modal.container.querySelector('#cc-delete-btn');
            if (deleteBtn && deleteBtn.previousElementSibling) {
                deleteBtn.previousElementSibling.insertAdjacentHTML('beforebegin', curveHTML);

    // Attach events
                const ccCurveButtons = this.modal.container.querySelectorAll('.cc-curve-btn');
                ccCurveButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const curveType = btn.dataset.curve;
                        if (curveType) {
    // Disable all buttons
                            ccCurveButtons.forEach(b => b.classList.remove('active'));
    // Enable the clicked button
                            btn.classList.add('active');
    // Change the curve type for the active editor
                            if (this.modal.currentCCType === 'tempo' && this.modal.tempoEditor) {
                                this.modal.tempoEditor.setCurveType(curveType);
                            } else if (this.modal.ccEditor) {
                                this.modal.ccEditor.setCurveType(curveType);
                            }
                        }
                    });
                });
            }
        } else {
    // The buttons already exist — show them
            curveSection.style.display = 'flex';
            curveSection.previousElementSibling.style.display = 'block'; // divider
        }
    }

    hideCurveButtons() {
        const curveSection = this.modal.container.querySelector('.curve-section');
        if (curveSection) {
            curveSection.style.display = 'none';
            if (curveSection.previousElementSibling && curveSection.previousElementSibling.classList.contains('cc-toolbar-divider')) {
                curveSection.previousElementSibling.style.display = 'none';
            }
        }
    }

    syncVelocityEditor() {
        if (!this.modal.velocityEditor || !this.modal.pianoRoll) return;

        this.modal.velocityEditor.syncWith({
            xrange: this.modal.pianoRoll.xrange,
            xoffset: this.modal.pianoRoll.xoffset,
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            timebase: this.modal.pianoRoll.timebase
        });
    }

    syncSequenceFromVelocityEditor(velocitySequence) {
        if (!velocitySequence) return;

    // Update fullSequence and sequence with the new velocities
        this.modal.fullSequence.forEach(note => {
            const velocityNote = velocitySequence.find(vn =>
                vn.t === note.t && vn.n === note.n && vn.c === note.c
            );
            if (velocityNote) {
                note.v = velocityNote.v || 100;
            }
        });

    // Rebuild the filtered sequence
        this.modal.sequence = this.modal.fullSequence.filter(note => this.modal.activeChannels.has(note.c));

    // Update the piano roll
        if (this.modal.pianoRoll) {
            this.modal.pianoRoll.sequence = this.modal.sequence;
            if (typeof this.modal.pianoRoll.redraw === 'function') {
                this.modal.pianoRoll.redraw();
            }
        }

        this.modal.log('debug', 'Synchronized velocities from velocity editor to sequence');
    }

    updateChannelsFromSequence() {
        const channelNoteCount = new Map();
        const channelPrograms = new Map();

    // Count notes per channel and preserve existing programs
        this.modal.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

    // Trouver le programme pour ce canal (depuis this.modal.channels existants)
            if (!channelPrograms.has(channel)) {
                const existingChannel = this.modal.channels.find(ch => ch.channel === channel);
                if (existingChannel) {
                    channelPrograms.set(channel, existingChannel.program);
                } else {
    // New channel: use the selected program
                    channelPrograms.set(channel, this.modal.selectedInstrument || 0);
                }
            }
        });

    // Reconstruire this.modal.channels
        this.modal.channels = [];
        channelNoteCount.forEach((count, channel) => {
            const program = channelPrograms.get(channel) || 0;
            const instrumentName = channel === 9 ? this.modal.t('midiEditor.drumKit') : this.modal.getInstrumentName(program);

            this.modal.channels.push({
                channel: channel,
                program: program,
                instrument: instrumentName,
                noteCount: count
            });
        });

    // Sort by channel number
        this.modal.channels.sort((a, b) => a.channel - b.channel);

        this.modal.log('debug', `Updated channels: ${this.modal.channels.length} channels found`);
    }

    brightenColor(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, (num >> 8 & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorCCPicker = MidiEditorCCPicker;
    }
})();
