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
            // Sub-feature: lane-editor lifecycle + viewport sync (audit §1.3).
            this.laneEditors = typeof MidiEditorLaneEditors !== 'undefined'
                ? new MidiEditorLaneEditors(this)
                : null;
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

    // Delegates to laneEditors sub-feature (extracted per audit §1.3)
    initCCEditor()                                 { return this.laneEditors?.initCCEditor(); }
    waitForCCEditorLayout(attempts, maxAttempts)   { return this.laneEditors?.waitForCCEditorLayout(attempts, maxAttempts); }
    syncCCEditor()                                 { return this.laneEditors?.syncCCEditor(); }
    _getActiveEditorHeaderWidth()                  { return this.laneEditors?._getActiveEditorHeaderWidth() ?? 0; }
    syncAllEditors()                               { return this.laneEditors?.syncAllEditors(); }
    syncCCEventsFromEditor()                       { return this.laneEditors?.syncCCEventsFromEditor(); }
    syncTempoEventsFromEditor()                    { return this.laneEditors?.syncTempoEventsFromEditor(); }
    initVelocityEditor()                           { return this.laneEditors?.initVelocityEditor(); }
    waitForVelocityEditorLayout(a, m)              { return this.laneEditors?.waitForVelocityEditorLayout(a, m); }
    initTempoEditor()                              { return this.laneEditors?.initTempoEditor(); }
    waitForTempoEditorLayout(a, m)                 { return this.laneEditors?.waitForTempoEditorLayout(a, m); }

    syncTempoEditor() {
        if (!this.modal.tempoEditor || !this.modal.pianoRollRenderer?.isMounted()) return;

        this.modal.tempoEditor.setXRange(this.modal.pianoRollRenderer?.getXRange());
        this.modal.tempoEditor.setXOffset(this.modal.pianoRollRenderer?.getXOffset());
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
        if (!this.modal.velocityEditor || !this.modal.pianoRollRenderer?.isMounted()) return;

        this.modal.velocityEditor.syncWith({
            xrange: this.modal.pianoRollRenderer?.getXRange(),
            xoffset: this.modal.pianoRollRenderer?.getXOffset(),
            grid: this.modal.snapValues[this.modal.currentSnapIndex].ticks,
            timebase: this.modal.pianoRollRenderer?.getTimebase()
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
        if (this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.pianoRollRenderer?.setSequence(this.modal.sequence);
            if (true) {
                this.modal.pianoRollRenderer?.redraw();
            }
        }

        this.modal.log('debug', 'Synchronized velocities from velocity editor to sequence');
    }

    updateChannelsFromSequence() {
        const channelNoteCount = new Map();
        const channelPrograms = new Map();
        const channelExplicit = new Map();

    // Snapshot existing channel metadata before the rebuild so it survives the clear below
        const existingByChannel = new Map();
        this.modal.channels.forEach(ch => existingByChannel.set(ch.channel, ch));

    // Count notes per channel and preserve existing programs
        this.modal.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

            if (!channelPrograms.has(channel)) {
                const existing = existingByChannel.get(channel);
                if (existing) {
                    channelPrograms.set(channel, existing.program);
                    channelExplicit.set(channel, !!existing.hasExplicitProgram);
                } else {
                    const si = this.modal.selectedInstrument;
                    channelPrograms.set(channel, si || 0);
                    channelExplicit.set(channel, si !== null && si !== undefined && si !== 0);
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
                noteCount: count,
                hasExplicitProgram: channelExplicit.get(channel) ?? false
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
