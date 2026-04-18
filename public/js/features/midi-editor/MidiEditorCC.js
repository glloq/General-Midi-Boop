// ============================================================================
// File: public/js/features/midi-editor/MidiEditorCC.js
// Description: CC/pitchbend channel + editor management for the MIDI editor.
//   Sub-component class ; called via `modal.ccOps.<method>(...)`.
//   CC_NAMES / CC_CATEGORIES are exposed as class statics and mirrored on
//   `MidiEditorModal.CC_NAMES` / `.CC_CATEGORIES` for legacy consumers
//   (CCPicker, CCPanel, RoutingSummaryPage — all read from the modal static).
//   (P2-F.10h body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorCC {
        constructor(modal) {
            this.modal = modal;
        }

    getAllCCChannels() {
        const channels = new Set();
        this.modal.ccEvents.forEach(event => {
            if (event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    getCCChannelsUsed() {
        const channels = new Set();
        this.modal.ccEvents.forEach(event => {
            // Keep only the events of the currently selected CC type
            if (event.type === this.modal.currentCCType && event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    updateEditorChannelSelector() {
        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        // Le tempo est global - afficher tous les canaux comme actifs
        if (this.modal.currentCCType === 'tempo') {
            const allChannels = this.modal.channels.map(ch => ch.channel).sort((a, b) => a - b);
            if (allChannels.length === 0) {
                channelSelector.innerHTML = '';
                return;
            }
            channelSelector.innerHTML = allChannels.map(channel =>
                `<button class="cc-channel-btn active" data-channel="${channel}" title="${this.modal.t('midiEditor.channelTip', { channel: channel + 1 })}" disabled>${channel + 1}</button>`
            ).join('');
            return;
        }

        let channelsToShow = [];
        let activeChannel = 0;

        // Toujours afficher tous les canaux du fichier (velocity ou CC/Pitchbend)
        channelsToShow = this.modal.channels.map(ch => ch.channel).sort((a, b) => a - b);

        // Si un seul canal est en cours d'edition, le selectionner automatiquement
        if (this.modal.activeChannels && this.modal.activeChannels.size === 1) {
            activeChannel = Array.from(this.modal.activeChannels)[0];
            if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
                this.modal.velocityEditor.setChannel(activeChannel);
            } else if (this.modal.ccEditor) {
                this.modal.ccEditor.setChannel(activeChannel);
            }
        } else if (this.modal.currentCCType === 'velocity') {
            activeChannel = this.modal.velocityEditor ? this.modal.velocityEditor.currentChannel : -1;
        } else {
            activeChannel = this.modal.ccEditor ? this.modal.ccEditor.currentChannel : -1;
        }

        // Si aucun canal, afficher un message
        if (channelsToShow.length === 0) {
            const message = this.modal.currentCCType === 'velocity' ? this.modal.t('midiEditor.noNotesInFile') : this.modal.t('midiEditor.noCCInFile');
            channelSelector.innerHTML = `<div class="cc-no-channels">${message}</div>`;
            this.modal.log('info', message);
            return;
        }

        // S'assurer que le canal actif est dans la liste, sinon prendre le premier
        if (!channelsToShow.includes(activeChannel)) {
            activeChannel = channelsToShow[0];
            // Apply the channel to the editor
            if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
                this.modal.velocityEditor.setChannel(activeChannel);
            } else if (this.modal.ccEditor) {
                this.modal.ccEditor.setChannel(activeChannel);
            }
        }

        // Determine which channels have data for the active CC
        const channelsWithData = this.getCCChannelsUsed ? this.getCCChannelsUsed() : [];

        // Render buttons only for channels that are present
        channelSelector.innerHTML = channelsToShow.map(channel => {
            const classes = ['cc-channel-btn'];
            if (channel === activeChannel) classes.push('active');
            if (channelsWithData.includes(channel)) classes.push('has-cc-data');
            return `<button class="${classes.join(' ')}" data-channel="${channel}" title="${this.modal.t('midiEditor.channelTip', { channel: channel + 1 })}">${channel + 1}</button>`;
        }).join('');

        // Re-attach the event listeners
        this.attachEditorChannelListeners();
        this.highlightUsedCCButtons();

        this.modal.log('info', `Sélecteur de canal mis à jour - Type ${this.modal.currentCCType}: ${channelsToShow.length} canaux`);
    }

    attachEditorChannelListeners() {
        // OPTIMISATION: Event delegation au lieu de listeners individuels
        // The .cc-channel-btn buttons are recreated dynamically — event delegation
        // on the parent container avoids rebinding listeners on every update
        if (this.modal._ccChannelDelegationAttached) return;

        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        this.modal._ccChannelDelegationAttached = true;

        channelSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.cc-channel-btn');
            if (!btn) return;
            e.preventDefault();
            const channel = parseInt(btn.dataset.channel);
            if (isNaN(channel)) return;

            channelSelector.querySelectorAll('.cc-channel-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (this.modal.currentCCType === 'velocity' && this.modal.velocityEditor) {
                this.modal.velocityEditor.setChannel(channel);
                this.modal.log('info', `Canal vélocité sélectionné: ${channel + 1}`);
            } else if (this.modal.ccEditor) {
                this.modal.ccEditor.setChannel(channel);
                this.modal.log('info', `Canal CC sélectionné: ${channel + 1}`);
                // Auto-select a CC type that has data on this channel
                this.selectBestCCTypeForChannel(channel);
            }

            // Update CC highlighting and the dynamic buttons
            this.highlightUsedCCButtons();
            this.updateDynamicCCButtons();
        });
    }

    extractCCAndPitchbend() {
        this.modal.ccEvents = [];

        if (!this.modal.midiData || !this.modal.midiData.tracks) {
            this.modal.log('warn', 'No MIDI tracks to extract CC/pitchbend');
            return;
        }

        this.modal.midiData.tracks.forEach((track, _trackIndex) => {
            if (!track.events) {
                return;
            }

            let currentTick = 0;

            track.events.forEach((event) => {
                currentTick += event.deltaTime || 0;

                // Control Change events — capture every CC (0-127)
                // Accepter 'controller' (midi-file lib) et 'controlChange' (MidiParser.js) pour robustesse
                if (event.type === 'controller' || event.type === 'controlChange') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    const controller = event.controllerType;

                    if (controller !== undefined && controller >= 0 && controller <= 127) {
                        this.modal.ccEvents.push({
                            type: `cc${controller}`,
                            ticks: currentTick,
                            channel: channel,
                            value: event.value,
                            id: Date.now() + Math.random() + this.modal.ccEvents.length
                        });
                    }
                }

                // Pitch Bend events
                if (event.type === 'pitchBend') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.modal.ccEvents.push({
                        type: 'pitchbend',
                        ticks: currentTick,
                        channel: channel,
                        value: event.value,
                        id: Date.now() + Math.random() + this.modal.ccEvents.length
                    });
                }

                // Channel Aftertouch events
                if (event.type === 'channelAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.modal.ccEvents.push({
                        type: 'aftertouch',
                        ticks: currentTick,
                        channel: channel,
                        value: event.amount !== undefined ? event.amount : (event.value || 0),
                        id: Date.now() + Math.random() + this.modal.ccEvents.length
                    });
                }

                // Polyphonic Aftertouch events (polyAftertouch from CustomMidiParser, noteAftertouch from midi-file lib)
                if (event.type === 'polyAftertouch' || event.type === 'noteAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.modal.ccEvents.push({
                        type: 'polyAftertouch',
                        ticks: currentTick,
                        channel: channel,
                        note: event.noteNumber,
                        value: event.pressure !== undefined ? event.pressure : (event.amount !== undefined ? event.amount : (event.value || 0)),
                        id: Date.now() + Math.random() + this.modal.ccEvents.length
                    });
                }
            });
        });

        // Trier par tick
        this.modal.ccEvents.sort((a, b) => a.ticks - b.ticks);

        this.modal.log('info', `Extracted ${this.modal.ccEvents.length} CC/pitchbend events`);

        // Log summary by type (compter dynamiquement)
        const typeCounts = {};
        this.modal.ccEvents.forEach(e => {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        });
        const summary = Object.entries(typeCounts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        if (summary) {
            this.modal.log('info', `  - ${summary}`);
        }

        // Log the channels in use
        const usedChannels = this.getCCChannelsUsed();
        if (usedChannels.length > 0) {
            this.modal.log('info', `  - Canaux utilisés: ${usedChannels.map(c => c + 1).join(', ')}`);
        }

        this.highlightUsedCCButtons();
    }

    _getCCName(ccNum) {
        const key = 'ccNames.' + ccNum;
        const translated = this.modal.t(key);
        if (translated !== key) return translated;
        return MidiEditorModal.CC_NAMES[ccNum] || this.modal.t('ccNames.fallback', { num: ccNum });
    }

    updateDynamicCCButtons() {
        const dynamicContainer = this.modal.container?.querySelector('#cc-dynamic-buttons');
        const dynamicGroup = this.modal.container?.querySelector('.cc-dynamic-group');
        if (!dynamicContainer || !dynamicGroup) return;

        // CC couverts par les boutons statiques
        const staticCCs = new Set(['cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'aftertouch', 'polyAftertouch']);

        // Find CCs present in the file that are not in the static list (all channels)
        const detectedCCs = new Set();
        this.modal.ccEvents.forEach(e => {
            if (!staticCCs.has(e.type) && e.type.startsWith('cc')) {
                detectedCCs.add(e.type);
            }
        });

        // Vider les anciens boutons dynamiques
        dynamicContainer.innerHTML = '';

        if (detectedCCs.size === 0) {
            dynamicGroup.style.display = 'none';
            return;
        }

        // Afficher le groupe dynamique
        dynamicGroup.style.display = '';

        // Determine the active channel for visual filtering
        const activeBtn = this.modal.container.querySelector('#editor-channel-selector .cc-channel-btn.active');
        const activeChannel = activeBtn ? parseInt(activeBtn.dataset.channel) :
            (this.modal.channels && this.modal.channels.length > 0 ? this.modal.channels[0].channel : 0);
        const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);

        // Sort detected CCs numerically
        const sortedCCs = Array.from(detectedCCs).sort((a, b) => {
            return parseInt(a.replace('cc', '')) - parseInt(b.replace('cc', ''));
        });

        // OPTIMIZATION: precompute counts in a single pass instead of O(n) per CC type
        const ccCounts = new Map();
        this.modal.ccEvents.forEach(e => ccCounts.set(e.type, (ccCounts.get(e.type) || 0) + 1));

        // OPTIMISATION: DocumentFragment pour un seul reflow DOM au lieu d'un par bouton
        const fragment = document.createDocumentFragment();
        sortedCCs.forEach(ccType => {
            const ccNum = parseInt(ccType.replace('cc', ''));
            const ccName = this._getCCName(ccNum);
            const count = ccCounts.get(ccType) || 0;
            const hasDataOnChannel = usedTypesOnChannel.has(ccType);

            const btn = document.createElement('button');
            btn.className = 'cc-type-btn dynamic';
            if (hasDataOnChannel) btn.classList.add('has-data');
            if (!hasDataOnChannel) btn.classList.add('has-data-other');
            btn.dataset.ccType = ccType;
            btn.title = `${ccName} (${this.modal.t('midiEditor.events', { count })})`;
            btn.textContent = `CC${ccNum}`;

            fragment.appendChild(btn);
        });
        dynamicContainer.appendChild(fragment);

        this.modal.log('info', `Added ${sortedCCs.length} dynamic CC buttons: ${sortedCCs.join(', ')}`);

        this.highlightUsedCCButtons();
    }

    toggleCCSection() {
        this.modal.ccSectionExpanded = !this.modal.ccSectionExpanded;

        const ccSection = document.getElementById('cc-section');
        const ccContent = document.getElementById('cc-section-content');
        const ccHeader = document.getElementById('cc-section-header');
        const resizeBar = document.getElementById('cc-resize-btn');

        if (ccSection && ccContent && ccHeader) {
            if (this.modal.ccSectionExpanded) {
                ccSection.classList.add('expanded');
                ccSection.classList.remove('collapsed');
                ccHeader.classList.add('expanded');
                ccHeader.classList.remove('collapsed');

                // Afficher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.add('visible');
                    this.modal.log('debug', 'Resize bar shown');
                }

                // Listen for the CSS transition to finish
                const onTransitionEnd = (e) => {
                    // S'assurer que c'est bien la transition de la section CC
                    if (e.target !== ccSection) return;

                    ccSection.removeEventListener('transitionend', onTransitionEnd);

                    this.modal.log('debug', 'CC Section transition ended');

                    // Initialize the CC editor if it does not exist yet
                    if (!this.modal.ccEditor) {
                        this.modal.ccPicker.initCCEditor();
                    } else {
                        // The editor already exists — wait for its layout then resize
                        this.modal.ccPicker.waitForCCEditorLayout();
                    }
                };

                ccSection.addEventListener('transitionend', onTransitionEnd);

                // Fallback when there is no transition (already expanded, etc.)
                setTimeout(() => {
                    if (!this.modal.ccEditor) {
                        this.modal.ccPicker.initCCEditor();
                    }
                }, 400);
            } else {
                ccSection.classList.remove('expanded');
                ccSection.classList.add('collapsed');
                ccHeader.classList.remove('expanded');
                ccHeader.classList.add('collapsed');

                // Clean up inline styles set by the drag-resize handler
                // so the CSS classes (flex, min-height) can take over
                ccSection.style.removeProperty('height');
                ccSection.style.removeProperty('flex');
                ccSection.style.removeProperty('min-height');

                const notesSection = this.modal.container?.querySelector('.notes-section');
                if (notesSection) {
                    notesSection.style.removeProperty('height');
                    notesSection.style.removeProperty('flex');
                    notesSection.style.removeProperty('min-height');
                }

                // Cacher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.remove('visible');
                    this.modal.log('debug', 'Resize bar hidden');
                }

                // Suspend sub-editors to save CPU when collapsed
                if (this.modal.ccEditor && typeof this.modal.ccEditor.suspend === 'function') this.modal.ccEditor.suspend();
                if (this.modal.velocityEditor && typeof this.modal.velocityEditor.suspend === 'function') this.modal.velocityEditor.suspend();
                if (this.modal.tempoEditor && typeof this.modal.tempoEditor.suspend === 'function') this.modal.tempoEditor.suspend();

                // Redimensionner le piano roll pour occuper tout l'espace
                requestAnimationFrame(() => {
                    if (this.modal.pianoRoll && typeof this.modal.pianoRoll.redraw === 'function') {
                        this.modal.pianoRoll.redraw();
                    }
                });
            }
        }

        this.modal.log('info', `Section CC ${this.modal.ccSectionExpanded ? 'expanded' : 'collapsed'}`);
    }

    selectBestCCTypeForChannel(channel) {
        // Ne rien faire si on est en mode velocity ou tempo
        if (this.modal.currentCCType === 'velocity' || this.modal.currentCCType === 'tempo') return;

        const usedTypes = this.getUsedCCTypesForChannel(channel);
        const ccTypes = Array.from(usedTypes).filter(t => t !== 'velocity' && t !== 'tempo');

        // Masquer le message "aucun CC" s'il existe
        const ccEditorContainer = document.getElementById('cc-editor-container');
        const existingMsg = ccEditorContainer?.querySelector('.cc-no-data-message');
        if (existingMsg) existingMsg.remove();

        if (ccTypes.length === 0) {
            // No CC on this channel — deselect all CC buttons
            this.modal.container?.querySelectorAll('.cc-type-btn').forEach(btn => {
                const type = btn.dataset.ccType;
                if (type && type !== 'velocity' && type !== 'tempo') {
                    btn.classList.remove('active');
                }
            });

            // Display a message inside the editor
            if (ccEditorContainer) {
                const msg = document.createElement('div');
                msg.className = 'cc-no-data-message';
                msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:13px;pointer-events:none;z-index:1;';
                msg.textContent = this.modal.t('midiEditor.noCCOnChannel') || 'No CC on this channel';
                ccEditorContainer.appendChild(msg);
            }
            return;
        }

        // Keep the current type if it has data on this channel
        if (usedTypes.has(this.modal.currentCCType)) return;

        // Otherwise pick the first CC type that has data on this channel
        this.selectCCType(ccTypes[0]);
    }

    selectCCType(ccType) {
        this.modal.currentCCType = ccType;
        this.modal.log('info', `Type sélectionné: ${ccType}`);

        // Retirer le message "aucun CC" s'il existe
        const noDataMsg = document.querySelector('.cc-no-data-message');
        if (noDataMsg) noDataMsg.remove();

        // Update the buttons
        const ccTypeButtons = this.modal.container?.querySelectorAll('.cc-type-btn');
        ccTypeButtons?.forEach(btn => {
            if (btn.dataset.ccType === ccType) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        const ccEditorContainer = document.getElementById('cc-editor-container');
        const velocityEditorContainer = document.getElementById('velocity-editor-container');
        const tempoEditorContainer = document.getElementById('tempo-editor-container');

        if (ccType === 'tempo') {
            // Show the tempo editor
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'flex';

            // Initialize the tempo editor if it does not exist
            if (!this.modal.tempoEditor) {
                this.modal.ccPicker.initTempoEditor();
            } else {
                // Synchroniser avec le piano roll actuel
                this.modal.ccPicker.syncTempoEditor();
                // OPTIMIZATION: single RAF instead of double RAF (saves one frame)
                requestAnimationFrame(() => {
                    if (this.modal.tempoEditor && this.modal.tempoEditor.resize) {
                        this.modal.tempoEditor.resize();
                    }
                });
            }

            // Afficher les boutons de courbes pour tempo
            this.modal.ccPicker.showCurveButtons();
        } else if (ccType === 'velocity') {
            // Show the velocity editor
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'flex';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialize the velocity editor if it does not exist
            if (!this.modal.velocityEditor) {
                this.modal.ccPicker.initVelocityEditor();
            } else {
                // Reload the full sequence (per-channel filtering happens inside the editor)
                this.modal.velocityEditor.setSequence(this.modal.fullSequence);
                this.modal.ccPicker.syncVelocityEditor();
                // OPTIMIZATION: single RAF instead of double RAF (saves one frame)
                requestAnimationFrame(() => {
                    if (this.modal.velocityEditor && this.modal.velocityEditor.resize) {
                        this.modal.velocityEditor.resize();
                    }
                });
            }

            // Update the channel selector for the velocity editor
            this.updateEditorChannelSelector();
            // Masquer les boutons de courbes
            this.modal.ccPicker.hideCurveButtons();
        } else {
            // Show the CC editor
            if (ccEditorContainer) ccEditorContainer.style.display = 'flex';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialize the CC editor if it does not exist
            if (!this.modal.ccEditor) {
                this.modal.ccPicker.initCCEditor();
            } else {
                this.modal.ccEditor.setCC(ccType);
                // OPTIMISATION: Simple RAF au lieu de double RAF
                requestAnimationFrame(() => {
                    if (this.modal.ccEditor && this.modal.ccEditor.resize) {
                        this.modal.ccEditor.resize();
                    }
                });
                // Update the channel selector because used channels vary per CC type
                this.updateEditorChannelSelector();
            }

            // Afficher les boutons de courbes pour les CC aussi
            this.modal.ccPicker.showCurveButtons();
        }

        // Update the delete button state after the type change
        this.modal.ccPicker.updateDeleteButtonState();
        this.highlightUsedCCButtons();
    }

    getUsedCCTypesForChannel(channel) {
        const usedTypes = new Set();
        this.modal.ccEvents.forEach(event => {
            if (event.channel === channel) {
                usedTypes.add(event.type);
            }
        });
        if (this.modal.fullSequence && this.modal.fullSequence.some(note => note.c === channel)) {
            usedTypes.add('velocity');
        }
        return usedTypes;
    }

    getAllUsedCCTypes() {
        const allTypes = new Set();
        this.modal.ccEvents.forEach(event => {
            allTypes.add(event.type);
        });
        if (this.modal.fullSequence && this.modal.fullSequence.length > 0) {
            allTypes.add('velocity');
        }
        return allTypes;
    }

    highlightUsedCCButtons() {
        if (!this.modal.container) return;

        // Source of truth: the active channel button in the DOM
        const activeBtn = this.modal.container.querySelector('#editor-channel-selector .cc-channel-btn.active');
        const activeChannel = activeBtn ? parseInt(activeBtn.dataset.channel) :
            (this.modal.channels && this.modal.channels.length > 0 ? this.modal.channels[0].channel : 0);

        const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);
        const allUsedTypes = this.getAllUsedCCTypes();
        const alwaysVisible = new Set(['velocity', 'tempo']);

        this.modal.container.querySelectorAll('.cc-type-btn').forEach(btn => {
            const ccType = btn.dataset.ccType;
            if (!ccType) return; // bouton GO du custom CC

            const hasDataOnChannel = usedTypesOnChannel.has(ccType);
            const hasDataInFile = allUsedTypes.has(ccType);
            const isActive = btn.classList.contains('active');
            const isAlwaysVisible = alwaysVisible.has(ccType);

            btn.classList.toggle('has-data', hasDataOnChannel);
            btn.classList.toggle('has-data-other', !hasDataOnChannel && hasDataInFile);

            // Visible si: donnees sur le canal actif, OU donnees dans le fichier, OU toujours visible, OU actif
            btn.style.display = (isAlwaysVisible || hasDataOnChannel || hasDataInFile || isActive) ? '' : 'none';
        });

        // Masquer les groupes CC entierement vides
        this.modal.container.querySelectorAll('.cc-btn-group:not(.cc-dynamic-group)').forEach(group => {
            if (group.dataset.group === 'custom') return;
            const visibleBtns = group.querySelectorAll('.cc-type-btn:not([style*="display: none"])');
            group.style.display = visibleBtns.length > 0 ? '' : 'none';
        });
    }
    }

    MidiEditorCC.CC_NAMES = {
        0: 'Bank Select', 1: 'Modulation', 2: 'Breath', 3: 'Ctrl 3', 4: 'Foot',
        5: 'Portamento', 6: 'Data Entry', 7: 'Volume', 8: 'Balance', 9: 'Ctrl 9',
        10: 'Pan', 11: 'Expression', 12: 'FX Ctrl 1', 13: 'FX Ctrl 2',
        14: 'Ctrl 14', 15: 'Ctrl 15', 16: 'GP Ctrl 1', 17: 'GP Ctrl 2',
        18: 'GP Ctrl 3', 19: 'GP Ctrl 4', 20: 'Ctrl 20', 21: 'Ctrl 21',
        22: 'Ctrl 22', 23: 'Ctrl 23', 24: 'Ctrl 24', 25: 'Ctrl 25',
        26: 'Ctrl 26', 27: 'Ctrl 27', 28: 'Ctrl 28', 29: 'Ctrl 29',
        30: 'Ctrl 30', 31: 'Ctrl 31',
        32: 'Bank Select LSB', 33: 'Mod Wheel LSB', 34: 'Breath LSB',
        35: 'Ctrl 35', 36: 'Foot LSB', 37: 'Porta LSB', 38: 'Data Entry LSB',
        39: 'Volume LSB', 40: 'Balance LSB', 41: 'Ctrl 41', 42: 'Pan LSB',
        43: 'Expression LSB',
        64: 'Sustain', 65: 'Portamento On', 66: 'Sostenuto', 67: 'Soft Pedal',
        68: 'Legato', 69: 'Hold 2', 70: 'Variation', 71: 'Resonance',
        72: 'Release', 73: 'Attack', 74: 'Brightness', 75: 'Decay',
        76: 'Vib Rate', 77: 'Vib Depth', 78: 'Vib Delay',
        79: 'Ctrl 79', 80: 'GP Ctrl 5', 81: 'GP Ctrl 6', 82: 'GP Ctrl 7',
        83: 'GP Ctrl 8', 84: 'Porta Ctrl', 85: 'Ctrl 85', 86: 'Ctrl 86',
        87: 'Ctrl 87', 88: 'Velocity Prefix', 89: 'Ctrl 89', 90: 'Ctrl 90',
        91: 'Reverb', 92: 'Tremolo', 93: 'Chorus', 94: 'Detune', 95: 'Phaser',
        96: 'Data Inc', 97: 'Data Dec', 98: 'NRPN LSB', 99: 'NRPN MSB',
        100: 'RPN LSB', 101: 'RPN MSB',
        120: 'All Sound Off', 121: 'Reset All', 122: 'Local Ctrl',
        123: 'All Notes Off', 124: 'Omni Off', 125: 'Omni On',
        126: 'Mono On', 127: 'Poly On'
    };

    MidiEditorCC.CC_CATEGORIES = [
        { name: 'Performance', ccs: [1, 2, 4, 11, 64, 65, 66, 67, 68] },
        { name: 'Mix', ccs: [7, 10, 8, 91, 92, 93, 94, 95] },
        { name: 'Tone / Timbre', ccs: [71, 72, 73, 74, 75, 76, 77, 78, 70] },
        { name: 'Portamento', ccs: [5, 84] },
        { name: 'Data / Bank', ccs: [0, 6, 32, 38, 96, 97, 98, 99, 100, 101] },
        { name: 'General Purpose', ccs: [16, 17, 18, 19, 80, 81, 82, 83] },
        { name: 'Channel Mode', ccs: [120, 121, 122, 123, 124, 125, 126, 127] }
    ];

    if (typeof window !== 'undefined') {
        window.MidiEditorCC = MidiEditorCC;
    }
})();
