// ============================================================================
// File: public/js/views/components/midi-editor/MidiEditorCCPicker.js
// Description: CC picker modal
//   Mixin: methods added to MidiEditorModal.prototype
// ============================================================================

(function() {
    'use strict';

    const MidiEditorCCPickerMixin = {};

    // ========================================================================
    // CC PICKER MODAL
    // ========================================================================

    /**
    * Ouvrir le picker de CC pour ajouter un CC à la liste
    */
    MidiEditorCCPickerMixin.openCCPicker = function() {
    // Close if already open
        let existing = this.container?.querySelector('#cc-picker-modal');
        if (existing) {
            existing.remove();
            return;
        }

        const addBtn = this.container?.querySelector('#cc-add-btn');
        if (!addBtn) return;

    // Determine which CCs are already visible (have data or are static buttons)
        const allUsedTypes = this.getAllUsedCCTypes();
        const staticCCNums = new Set([1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]);

    // Build the picker's HTML content, grouped by category
        let categoriesHTML = '';
        MidiEditorModal.CC_CATEGORIES.forEach(cat => {
            const buttonsHTML = cat.ccs.map(ccNum => {
                const ccName = this._getCCName(ccNum);
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
                <label class="cc-picker-category-title">${this.t('midiEditor.groupCustomCC') || 'CC# libre'}</label>
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
                <span class="cc-picker-title">${this.t('midiEditor.addCC') || 'Ajouter un CC'}</span>
                <button class="cc-picker-close" id="cc-picker-close">✕</button>
            </div>
            <div class="cc-picker-body">
                ${categoriesHTML}
                ${customInputHTML}
            </div>
        `;

    // Positionner le picker sous le bouton +
        const toolbar = this.container?.querySelector('.cc-type-toolbar');
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
                this.selectCCType(`cc${ccNum}`);
                picker.remove();
                this.log('info', `CC picker: CC${ccNum} selected`);
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
                this.selectCCType(`cc${ccNum}`);
                picker.remove();
                this.log('info', `CC picker custom: CC${ccNum} selected`);
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

    /**
    * Mettre à jour le canal actif pour l'édition CC
    */
    MidiEditorCCPickerMixin.updateCCEditorChannel = function() {
        if (!this.ccEditor) return;

    // Use the first active channel as the CC editor's channel
        const activeChannel = this.activeChannels.size > 0
            ? Array.from(this.activeChannels)[0]
            : 0;

        this.ccEditor.setChannel(activeChannel);
        this.log('info', `Canal CC mis à jour: ${activeChannel}`);
    }

    /**
    * Supprimer les éléments sélectionnés (CC/Velocity)
    */
    MidiEditorCCPickerMixin.deleteSelectedCCVelocity = function() {
        if (this.currentCCType === 'tempo' && this.tempoEditor) {
            const selectedIds = Array.from(this.tempoEditor.selectedEvents);
            this.tempoEditor.removeEvents(selectedIds);
        } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
            this.velocityEditor.deleteSelected();
        } else if (this.ccEditor) {
            this.ccEditor.deleteSelected();
        }

    // Update the delete button state
        this.updateDeleteButtonState();
    }

    /**
    * Update the delete button state
    */
    MidiEditorCCPickerMixin.updateDeleteButtonState = function() {
        const deleteBtn = this.container?.querySelector('#cc-delete-btn');
        if (!deleteBtn) return;

        let hasSelection = false;
        if (this.currentCCType === 'tempo' && this.tempoEditor) {
            hasSelection = this.tempoEditor.selectedEvents.size > 0;
        } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
            hasSelection = this.velocityEditor.selectedNotes.size > 0;
        } else if (this.ccEditor) {
            hasSelection = this.ccEditor.selectedEvents.size > 0;
        }

        deleteBtn.disabled = !hasSelection;
    }

    /**
    * Initialiser l'éditeur CC/Pitchbend
    */
    MidiEditorCCPickerMixin.initCCEditor = function() {
        const container = document.getElementById('cc-editor-container');
        if (!container) {
            this.log('warn', 'Container cc-editor-container not found');
            return;
        }

        if (this.ccEditor) {
            this.log('info', 'CC Editor already initialized');
            return;
        }

        this.log('info', `Initializing CC Editor with ${this.ccEvents.length} total CC events`);

    // Read the piano-roll parameters
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: () => {
    // Mark as dirty on CC/pitch-bend changes
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

    // Create the editor
        this.ccEditor = new CCPitchbendEditor(container, options);
        this.ccEditor.setCC(this.currentCCType);

    // Load existing events BEFORE refreshing the selector
        if (this.ccEvents.length > 0) {
            this.ccEditor.loadEvents(this.ccEvents);
            this.log('info', `Loaded ${this.ccEvents.length} CC events into editor`);
        }

    // Update the channel selector to show only used channels
        this.updateEditorChannelSelector();

    // When editing a single channel, use that channel; otherwise fall back to first channel
        let activeChannel;
        if (this.activeChannels && this.activeChannels.size === 1) {
            activeChannel = Array.from(this.activeChannels)[0];
        } else {
            const fileChannels = this.channels.map(ch => ch.channel).sort((a, b) => a - b);
            const usedChannels = this.getCCChannelsUsed();
            activeChannel = fileChannels.length > 0 ? fileChannels[0] : (usedChannels.length > 0 ? usedChannels[0] : 0);
        }
        this.ccEditor.setChannel(activeChannel);

    // Auto-select a CC type that has data on this channel
        this.selectBestCCTypeForChannel(activeChannel);

        this.highlightUsedCCButtons();

        this.log('info', `CC Editor initialized - Type: ${this.currentCCType}, Channel: ${activeChannel + 1}, File channels: [${fileChannels.map(c => c + 1).join(', ')}]`);

    // Add a listener that refreshes the delete button on interactions
        container.addEventListener('mouseup', () => {
    // Use setTimeout so the selection updates first
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

    // Wait for the flex layout to settle before resizing
    // Use requestAnimationFrame in a loop until the element has a valid height
        this.waitForCCEditorLayout();
    }

    /**
    * Attendre que l'éditeur CC ait une hauteur valide avant de le redimensionner
    */
    MidiEditorCCPickerMixin.waitForCCEditorLayout = function(attempts = 0, maxAttempts = 60) {
        if (!this.ccEditor || !this.ccEditor.element) {
            this.log('warn', 'waitForCCEditorLayout: ccEditor or element not found');
            return;
        }

        const height = this.ccEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForCCEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.ccEditor.resize();
    // Resume rendering for the active sub-editor
            if (typeof this.ccEditor.resume === 'function') this.ccEditor.resume();
            if (this.velocityEditor && typeof this.velocityEditor.resume === 'function') this.velocityEditor.resume();
            if (this.tempoEditor && typeof this.tempoEditor.resume === 'function') this.tempoEditor.resume();
            this.log('info', `CC Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForCCEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForCCEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
    * Synchroniser l'éditeur CC avec le piano roll
    */
    MidiEditorCCPickerMixin.syncCCEditor = function() {
        if (!this.ccEditor) return;

        const viewport = this._getActiveViewportState();
        this.ccEditor.syncWith({
            xrange: viewport.xrange,
            xoffset: viewport.xoffset,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            timebase: this.pianoRoll?.timebase
        });
    }

    /**
    * Sync every editor (CC et Velocity) avec le piano roll
    */
    /**
    * Get the header width (left offset) of the currently active editor view.
    * This is needed to align the PlaybackTimelineBar with the active editor.
    */
    MidiEditorCCPickerMixin._getActiveEditorHeaderWidth = function() {
        if (this.tablatureEditor && this.tablatureEditor.isVisible && this.tablatureEditor.renderer) {
            return this.tablatureEditor.renderer.headerWidth || 40;
        }
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible && this.windInstrumentEditor.renderer) {
            return this.windInstrumentEditor.renderer.headerWidth || 50;
        }
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible && this.drumPatternEditor.gridRenderer) {
            return this.drumPatternEditor.gridRenderer.headerWidth || 80;
        }
    // Default: piano roll (yruler 24 + kbwidth 40)
        return 64;
    }

    MidiEditorCCPickerMixin.syncAllEditors = function() {
        this.syncCCEditor();
        this.syncVelocityEditor();
        this.syncTempoEditor();

        const viewport = this._getActiveViewportState();
        const activeLeftOffset = this._getActiveEditorHeaderWidth();

    // Sync PlaybackTimelineBar with active editor scroll/zoom
        if (this.timelineBar) {
            const containerWidth = this.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;
            this.timelineBar.setLeftOffset(activeLeftOffset);
            this.timelineBar.setScrollX(viewport.xoffset);
            this.timelineBar.setZoom(viewport.xrange / Math.max(1, containerWidth - activeLeftOffset));
        }

    // Sync NavigationOverviewBar with active editor viewport
        if (this.navigationBar) {
            const maxTick = this.midiData?.maxTick || 0;
            this.navigationBar.setViewport(viewport.xoffset, viewport.xrange, maxTick);
        }
    }

    /**
    * Synchroniser les événements depuis l'éditeur CC vers this.ccEvents
    * Appelé avant la sauvegarde pour récupérer les modifications
    */
    MidiEditorCCPickerMixin.syncCCEventsFromEditor = function() {
        if (!this.ccEditor) {
    // The CC editor was never opened — ccEditor is the only editing path,
    // so events extracted from the original file remain up to date.
            this.log('debug', `syncCCEventsFromEditor: editor not opened, preserving ${this.ccEvents.length} original events`);
            return;
        }

    // Grab every event from the editor
        const editorEvents = this.ccEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.log('info', 'syncCCEventsFromEditor: No CC events in editor');
            this.ccEvents = [];
            return;
        }

    // Editor events are already in the correct format
    // { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
        this.ccEvents = editorEvents.map(e => ({
            type: e.type,
            ticks: e.ticks,
            channel: e.channel,
            value: e.value,
            id: e.id
        }));

        this.log('info', `Synchronized ${this.ccEvents.length} CC/pitchbend events from editor`);

    // Sample log for debugging
        if (this.ccEvents.length > 0) {
            const sample = this.ccEvents.slice(0, 3);
            this.log('debug', 'Sample synchronized events:', sample);
        }
    }

    /**
    * Sync tempo events from the editor de tempo
    */
    MidiEditorCCPickerMixin.syncTempoEventsFromEditor = function() {
        if (!this.tempoEditor) {
            this.log('info', `syncTempoEventsFromEditor: Tempo editor not initialized, keeping ${this.tempoEvents.length} original events`);
            return;
        }

        const editorEvents = this.tempoEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.log('info', 'syncTempoEventsFromEditor: No tempo events in editor');
            this.tempoEvents = [];
            return;
        }

        this.tempoEvents = editorEvents.map(e => ({
            ticks: e.ticks,
            tempo: e.tempo,
            id: e.id
        }));

    // Update the global tempo with the first event
        if (this.tempoEvents.length > 0) {
            this.tempo = this.tempoEvents[0].tempo;
        }

        this.log('info', `Synchronized ${this.tempoEvents.length} tempo events from editor`);
    }

    /**
    * Initialiser l'éditeur de vélocité
    */
    MidiEditorCCPickerMixin.initVelocityEditor = function() {
        const container = document.getElementById('velocity-editor-container');
        if (!container) {
            this.log('warn', 'Container velocity-editor-container not found');
            return;
        }

        if (this.velocityEditor) {
            this.log('info', 'Velocity Editor already initialized');
            return;
        }

        this.log('info', `Initializing Velocity Editor with ${this.sequence.length} notes`);

    // Read the piano-roll parameters
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: (sequence) => {
    // Mark as dirty on velocity changes
                this.isDirty = true;
                this.updateSaveButton();
    // Synchroniser vers fullSequence et sequence
                this.syncSequenceFromVelocityEditor(sequence);
            }
        };

    // Create the editor
        this.velocityEditor = new VelocityEditor(container, options);

    // Load the full (unfiltered) sequence for the velocity editor
        this.velocityEditor.setSequence(this.fullSequence);

    // When editing a single channel, use that channel; otherwise first channel
        const firstChannel = (this.activeChannels && this.activeChannels.size === 1)
            ? Array.from(this.activeChannels)[0]
            : (this.channels.length > 0 ? this.channels[0].channel : 0);
        this.velocityEditor.setChannel(firstChannel);

        this.highlightUsedCCButtons();

        this.log('info', `Velocity Editor initialized with ${this.fullSequence.length} notes, default channel: ${firstChannel + 1}`);

    // Update the channel selector
        this.updateEditorChannelSelector();

    // Add a listener that refreshes the delete button on interactions
        container.addEventListener('mouseup', () => {
    // Use setTimeout so the selection updates first
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

    // Wait for the layout to be ready
        this.waitForVelocityEditorLayout();
    }

    /**
    * Attendre que l'éditeur de vélocité ait une hauteur valide
    */
    MidiEditorCCPickerMixin.waitForVelocityEditorLayout = function(attempts = 0, maxAttempts = 60) {
        if (!this.velocityEditor || !this.velocityEditor.element) {
            this.log('warn', 'waitForVelocityEditorLayout: velocityEditor or element not found');
            return;
        }

        const height = this.velocityEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForVelocityEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.velocityEditor.resize();
            this.log('info', `Velocity Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForVelocityEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForVelocityEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
    * Initialiser l'éditeur de tempo
    */
    MidiEditorCCPickerMixin.initTempoEditor = function() {
        const container = document.getElementById('tempo-editor-container');
        if (!container) {
            this.log('warn', 'Container tempo-editor-container not found');
            return;
        }

        if (this.tempoEditor) {
            this.log('info', 'Tempo Editor already initialized');
            return;
        }

        this.log('info', 'Initializing Tempo Editor');

    // Read the piano-roll parameters
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
    // Mark as dirty on tempo changes
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

    // Create the editor
        this.tempoEditor = new TempoEditor(container, options);

    // Load existing tempo events
        this.tempoEditor.setEvents(this.tempoEvents);

        this.log('info', `Tempo Editor initialized with ${this.tempoEvents.length} events`);

    // Wait for the layout to be ready
        this.waitForTempoEditorLayout();
    }

    /**
    * Attendre que l'éditeur de tempo ait une hauteur valide
    */
    MidiEditorCCPickerMixin.waitForTempoEditorLayout = function(attempts = 0, maxAttempts = 60) {
        if (!this.tempoEditor || !this.tempoEditor.element) {
            this.log('warn', 'waitForTempoEditorLayout: tempoEditor or element not found');
            return;
        }

        const height = this.tempoEditor.element.getBoundingClientRect().height;
        this.log('debug', `waitForTempoEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
    // Layout is ready, we can resize
            this.tempoEditor.resize();
            this.log('info', `Tempo Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Layout is not ready yet, retry on the next frame
            requestAnimationFrame(() => {
                this.waitForTempoEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            this.log('error', `waitForTempoEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
    * Synchroniser l'éditeur de tempo avec le piano roll
    */
    MidiEditorCCPickerMixin.syncTempoEditor = function() {
        if (!this.tempoEditor || !this.pianoRoll) return;

        this.tempoEditor.setXRange(this.pianoRoll.xrange);
        this.tempoEditor.setXOffset(this.pianoRoll.xoffset);
        this.tempoEditor.setGrid(this.snapValues[this.currentSnapIndex].ticks);
    }

    /**
    * Afficher les boutons de courbes
    */
    MidiEditorCCPickerMixin.showCurveButtons = function() {
    // Create the buttons once if they do not exist
        let curveSection = this.container.querySelector('.curve-section');
        if (!curveSection) {
    // Trouver la toolbar
            const toolbar = this.container.querySelector('.cc-type-toolbar');
            if (!toolbar) return;

    // Create the curve-buttons section
            const curveHTML = `
                <div class="cc-toolbar-divider"></div>
                <div class="curve-section">
                    <label class="cc-toolbar-label">${this.t('midiEditor.curveType')}</label>
                    <div class="cc-curve-buttons-horizontal">
                        <button class="cc-curve-btn active" data-curve="linear" title="${this.t('midiEditor.curveLinear')}">━</button>
                        <button class="cc-curve-btn" data-curve="exponential" title="${this.t('midiEditor.curveExponential')}">⌃</button>
                        <button class="cc-curve-btn" data-curve="logarithmic" title="${this.t('midiEditor.curveLogarithmic')}">⌄</button>
                        <button class="cc-curve-btn" data-curve="sine" title="${this.t('midiEditor.curveSine')}">∿</button>
                    </div>
                </div>
            `;

    // Insert before the divider preceding the delete button
            const deleteBtn = this.container.querySelector('#cc-delete-btn');
            if (deleteBtn && deleteBtn.previousElementSibling) {
                deleteBtn.previousElementSibling.insertAdjacentHTML('beforebegin', curveHTML);

    // Attach events
                const ccCurveButtons = this.container.querySelectorAll('.cc-curve-btn');
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
                            if (this.currentCCType === 'tempo' && this.tempoEditor) {
                                this.tempoEditor.setCurveType(curveType);
                            } else if (this.ccEditor) {
                                this.ccEditor.setCurveType(curveType);
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

    /**
    * Masquer les boutons de courbes
    */
    MidiEditorCCPickerMixin.hideCurveButtons = function() {
        const curveSection = this.container.querySelector('.curve-section');
        if (curveSection) {
            curveSection.style.display = 'none';
            if (curveSection.previousElementSibling && curveSection.previousElementSibling.classList.contains('cc-toolbar-divider')) {
                curveSection.previousElementSibling.style.display = 'none';
            }
        }
    }

    /**
    * Synchroniser l'éditeur de vélocité avec le piano roll
    */
    MidiEditorCCPickerMixin.syncVelocityEditor = function() {
        if (!this.velocityEditor || !this.pianoRoll) return;

        this.velocityEditor.syncWith({
            xrange: this.pianoRoll.xrange,
            xoffset: this.pianoRoll.xoffset,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            timebase: this.pianoRoll.timebase
        });
    }

    /**
    * Synchroniser la séquence depuis l'éditeur de vélocité
    */
    MidiEditorCCPickerMixin.syncSequenceFromVelocityEditor = function(velocitySequence) {
        if (!velocitySequence) return;

    // Update fullSequence and sequence with the new velocities
        this.fullSequence.forEach(note => {
            const velocityNote = velocitySequence.find(vn =>
                vn.t === note.t && vn.n === note.n && vn.c === note.c
            );
            if (velocityNote) {
                note.v = velocityNote.v || 100;
            }
        });

    // Rebuild the filtered sequence
        this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));

    // Update the piano roll
        if (this.pianoRoll) {
            this.pianoRoll.sequence = this.sequence;
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }

        this.log('debug', 'Synchronized velocities from velocity editor to sequence');
    }

    /**
    * Mettre à jour la liste des canaux basée sur fullSequence
    */
    MidiEditorCCPickerMixin.updateChannelsFromSequence = function() {
        const channelNoteCount = new Map();
        const channelPrograms = new Map();

    // Count notes per channel and preserve existing programs
        this.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

    // Trouver le programme pour ce canal (depuis this.channels existants)
            if (!channelPrograms.has(channel)) {
                const existingChannel = this.channels.find(ch => ch.channel === channel);
                if (existingChannel) {
                    channelPrograms.set(channel, existingChannel.program);
                } else {
    // New channel: use the selected program
                    channelPrograms.set(channel, this.selectedInstrument || 0);
                }
            }
        });

    // Reconstruire this.channels
        this.channels = [];
        channelNoteCount.forEach((count, channel) => {
            const program = channelPrograms.get(channel) || 0;
            const instrumentName = channel === 9 ? this.t('midiEditor.drumKit') : this.getInstrumentName(program);

            this.channels.push({
                channel: channel,
                program: program,
                instrument: instrumentName,
                noteCount: count
            });
        });

    // Sort by channel number
        this.channels.sort((a, b) => a.channel - b.channel);

        this.log('debug', `Updated channels: ${this.channels.length} channels found`);
    }

    /**
    * Éclaircir/éclairer une couleur hexadécimale pour la rendre plus éclatante
    */
    MidiEditorCCPickerMixin.brightenColor = function(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, (num >> 8 & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorCCPickerMixin = MidiEditorCCPickerMixin;
    }
})();
