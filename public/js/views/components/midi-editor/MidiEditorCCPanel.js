// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorCCPanel.js
// Description: CC/Pitchbend/Velocity/Tempo section for the MIDI Editor
//   - CC type buttons
//   - CC tool buttons (select, move, line, draw)
//   - Channel selector for CC
//   - CC/Velocity/Tempo editor initialization and synchronization
// ============================================================================

class MidiEditorCCPanel {
    constructor(modal) {
        this.modal = modal;
    }

    // ========================================================================
    // CC CHANNELS
    // ========================================================================

    /**
     * Obtenir les types CC utilises sur un canal donne
     */
    getUsedCCTypesForChannel(channel) {
        const m = this.modal;
        const usedTypes = new Set();
        m.ccEvents.forEach(event => {
            if (event.channel === channel) {
                usedTypes.add(event.type);
            }
        });
        // Verifier aussi velocity (notes presentes sur ce canal)
        if (m.fullSequence && m.fullSequence.some(note => note.c === channel)) {
            usedTypes.add('velocity');
        }
        return usedTypes;
    }

    /**
     * Mettre a jour le highlight des boutons CC selon les donnees presentes sur le canal actif
     */
    highlightUsedCCButtons() {
        const m = this.modal;
        if (!m.container) return;

        // Determiner le canal actif depuis les editeurs ou les canaux disponibles
        let activeChannel = null;
        if (m.currentCCType === 'velocity' && m.velocityEditor) {
            activeChannel = m.velocityEditor.currentChannel;
        } else if (m.ccEditor) {
            activeChannel = m.ccEditor.currentChannel;
        }

        // Fallback: premier canal disponible
        if (activeChannel === null) {
            const allChannels = this.getAllCCChannels();
            if (allChannels.length > 0) {
                activeChannel = allChannels[0];
            } else if (m.channels && m.channels.length > 0) {
                activeChannel = m.channels[0].channel;
            } else {
                activeChannel = 0;
            }
        }

        const usedTypes = this.getUsedCCTypesForChannel(activeChannel);

        const ccTypeButtons = m.container.querySelectorAll('.cc-type-btn');
        ccTypeButtons.forEach(btn => {
            const ccType = btn.dataset.ccType;
            if (usedTypes.has(ccType)) {
                btn.classList.add('has-data');
            } else {
                btn.classList.remove('has-data');
            }
        });

        // Mettre a jour l'indicateur CC + Canal actif
        this.updateActiveIndicator(activeChannel);
    }

    /**
     * Mettre a jour l'indicateur CC + Canal actif dans la toolbar
     */
    updateActiveIndicator(activeChannel) {
        const m = this.modal;
        const label = document.getElementById('cc-active-label');
        if (!label) return;

        // Formater le nom du CC actif
        let ccName;
        const ccType = m.currentCCType;
        if (ccType === 'velocity') {
            ccName = 'VEL';
        } else if (ccType === 'tempo') {
            ccName = 'TEMPO';
            label.textContent = ccName;
            return;
        } else if (ccType === 'pitchbend') {
            ccName = 'PB';
        } else if (ccType === 'aftertouch') {
            ccName = 'AT';
        } else if (ccType === 'polyAftertouch') {
            ccName = 'PAT';
        } else if (ccType.startsWith('cc')) {
            ccName = ccType.toUpperCase();
        } else {
            ccName = ccType;
        }

        // Compter les evenements pour ce CC + canal
        let eventCount = 0;
        if (ccType === 'velocity') {
            eventCount = m.fullSequence ? m.fullSequence.filter(n => n.c === activeChannel).length : 0;
        } else {
            eventCount = m.ccEvents ? m.ccEvents.filter(e => e.type === ccType && e.channel === activeChannel).length : 0;
        }

        const countStr = eventCount > 0 ? ` (${eventCount})` : '';
        label.textContent = `${ccName} · Ch${activeChannel + 1}${countStr}`;
    }

    /**
     * Obtenir l'ensemble de TOUS les canaux ayant des evenements CC/Pitchbend
     */
    getAllCCChannels() {
        const m = this.modal;
        const channels = new Set();
        m.ccEvents.forEach(event => {
            if (event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    /**
     * Obtenir l'ensemble des canaux utilises par le type CC/Pitchbend actuel
     */
    getCCChannelsUsed() {
        const m = this.modal;
        const channels = new Set();
        m.ccEvents.forEach(event => {
            if (event.type === m.currentCCType && event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    // ========================================================================
    // EDITOR CHANNEL SELECTOR
    // ========================================================================

    /**
     * Mettre a jour le selecteur de canal pour afficher uniquement les canaux presents dans le fichier
     */
    updateEditorChannelSelector() {
        const m = this.modal;
        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        if (m.currentCCType === 'tempo') {
            channelSelector.innerHTML = '';
            return;
        }

        let channelsToShow = [];
        let activeChannel = 0;

        if (m.currentCCType === 'velocity') {
            channelsToShow = m.channels.map(ch => ch.channel).sort((a, b) => a - b);
            activeChannel = m.velocityEditor ? m.velocityEditor.currentChannel : 0;
        } else {
            const usedChannels = this.getCCChannelsUsed();
            channelsToShow = usedChannels.length > 0 ? usedChannels : this.getAllCCChannels();
            activeChannel = m.ccEditor ? m.ccEditor.currentChannel : 0;
        }

        if (channelsToShow.length === 0) {
            const message = m.currentCCType === 'velocity' ? m.t('midiEditor.noNotesInFile') : m.t('midiEditor.noCCInFile');
            channelSelector.innerHTML = `<div class="cc-no-channels">${message}</div>`;
            m.log('info', message);
            return;
        }

        // Déterminer quels canaux ont des données pour le CC actif
        const channelsWithData = this.getCCChannelsUsed();

        channelSelector.innerHTML = channelsToShow.map(channel => {
            const classes = ['cc-channel-btn'];
            if (channel === activeChannel) classes.push('active');
            if (channelsWithData.includes(channel)) classes.push('has-cc-data');
            return `<button class="${classes.join(' ')}" data-channel="${channel}" title="${m.t('midiEditor.channelTip', { channel: channel + 1 })}">${channel + 1}</button>`;
        }).join('');

        this.attachEditorChannelListeners();
        this.highlightUsedCCButtons();

        m.log('info', `Selecteur de canal mis a jour - Type ${m.currentCCType}: ${channelsToShow.length} canaux`);
    }

    /**
     * DEPRECATED: Use updateEditorChannelSelector() instead
     */
    updateCCChannelSelector() {
        this.updateEditorChannelSelector();
    }

    /**
     * Attacher les event listeners aux boutons de canal pour CC ou Velocity
     */
    attachEditorChannelListeners() {
        const m = this.modal;
        if (!m.container) return;

        const channelButtons = m.container.querySelectorAll('.cc-channel-btn');
        channelButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const channel = parseInt(btn.dataset.channel);

                if (!isNaN(channel)) {
                    channelButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    if (m.currentCCType === 'velocity' && m.velocityEditor) {
                        m.velocityEditor.setChannel(channel);
                        m.log('info', `Canal velocite selectionne: ${channel + 1}`);
                    } else if (m.ccEditor) {
                        m.ccEditor.setChannel(channel);
                        m.log('info', `Canal CC selectionne: ${channel + 1}`);
                    }

                    this.highlightUsedCCButtons();
                }
            });
        });
    }

    /**
     * DEPRECATED: Use attachEditorChannelListeners() instead
     */
    attachCCChannelListeners() {
        this.attachEditorChannelListeners();
    }

    // ========================================================================
    // CC SECTION TOGGLE
    // ========================================================================

    /**
     * Basculer l'etat collapsed/expanded de la section CC
     */
    toggleCCSection() {
        const m = this.modal;
        m.ccSectionExpanded = !m.ccSectionExpanded;

        const ccSection = document.getElementById('cc-section');
        const ccContent = document.getElementById('cc-section-content');
        const ccHeader = document.getElementById('cc-section-header');
        const resizeBar = document.getElementById('cc-resize-btn');

        if (ccSection && ccContent && ccHeader) {
            if (m.ccSectionExpanded) {
                ccSection.classList.add('expanded');
                ccSection.classList.remove('collapsed');
                ccHeader.classList.add('expanded');
                ccHeader.classList.remove('collapsed');

                if (resizeBar) {
                    resizeBar.classList.add('visible');
                    m.log('debug', 'Resize bar shown');
                }

                const onTransitionEnd = (e) => {
                    if (e.target !== ccSection) return;

                    ccSection.removeEventListener('transitionend', onTransitionEnd);

                    m.log('debug', 'CC Section transition ended');

                    if (!m.ccEditor) {
                        this.initCCEditor();
                    } else {
                        this.waitForCCEditorLayout();
                    }
                };

                ccSection.addEventListener('transitionend', onTransitionEnd);

                setTimeout(() => {
                    if (!m.ccEditor) {
                        this.initCCEditor();
                    }
                }, 400);
            } else {
                ccSection.classList.remove('expanded');
                ccSection.classList.add('collapsed');
                ccHeader.classList.remove('expanded');
                ccHeader.classList.add('collapsed');

                ccSection.style.removeProperty('height');
                ccSection.style.removeProperty('flex');
                ccSection.style.removeProperty('min-height');

                const notesSection = m.container?.querySelector('.notes-section');
                if (notesSection) {
                    notesSection.style.removeProperty('height');
                    notesSection.style.removeProperty('flex');
                    notesSection.style.removeProperty('min-height');
                }

                if (resizeBar) {
                    resizeBar.classList.remove('visible');
                    m.log('debug', 'Resize bar hidden');
                }

                requestAnimationFrame(() => {
                    if (m.pianoRoll && typeof m.pianoRoll.redraw === 'function') {
                        m.pianoRoll.redraw();
                    }
                });
            }
        }

        m.log('info', `Section CC ${m.ccSectionExpanded ? 'expanded' : 'collapsed'}`);
    }

    // ========================================================================
    // SELECT CC TYPE
    // ========================================================================

    /**
     * Selectionner le type de CC/Velocity a editer
     */
    selectCCType(ccType) {
        const m = this.modal;
        m.currentCCType = ccType;
        m.log('info', `Type selectionne: ${ccType}`);

        const ccTypeButtons = m.container?.querySelectorAll('.cc-type-btn');
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
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'flex';

            if (!m.tempoEditor) {
                this.initTempoEditor();
            } else {
                this.syncTempoEditor();
                requestAnimationFrame(() => {
                    if (m.tempoEditor && m.tempoEditor.resize) {
                        m.tempoEditor.resize();
                    }
                });
            }

            this.showCurveButtons();
        } else if (ccType === 'velocity') {
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'flex';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            if (!m.velocityEditor) {
                this.initVelocityEditor();
            } else {
                m.velocityEditor.setSequence(m.fullSequence);
                this.syncVelocityEditor();
                requestAnimationFrame(() => {
                    if (m.velocityEditor && m.velocityEditor.resize) {
                        m.velocityEditor.resize();
                    }
                });
            }

            this.updateEditorChannelSelector();
            this.hideCurveButtons();
        } else {
            if (ccEditorContainer) ccEditorContainer.style.display = 'flex';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            if (!m.ccEditor) {
                this.initCCEditor();
            } else {
                m.ccEditor.setCC(ccType);
                requestAnimationFrame(() => {
                    if (m.ccEditor && m.ccEditor.resize) {
                        m.ccEditor.resize();
                    }
                });
                this.updateEditorChannelSelector();
            }

            this.showCurveButtons();

            // Afficher/masquer le sélecteur de note pour poly aftertouch
            this.updateNoteSelectorVisibility(ccType);
        }

        this.updateDeleteButtonState();
        this.highlightUsedCCButtons();
    }

    // ========================================================================
    // CC EDITOR CHANNEL
    // ========================================================================

    /**
     * Mettre a jour le canal actif pour l'edition CC
     */
    updateCCEditorChannel() {
        const m = this.modal;
        if (!m.ccEditor) return;

        const activeChannel = m.activeChannels.size > 0
            ? Array.from(m.activeChannels)[0]
            : 0;

        m.ccEditor.setChannel(activeChannel);
        m.log('info', `Canal CC mis a jour: ${activeChannel}`);
    }

    // ========================================================================
    // DELETE CC/VELOCITY
    // ========================================================================

    /**
     * Supprimer les elements selectionnes (CC/Velocity)
     */
    deleteSelectedCCVelocity() {
        const m = this.modal;
        if (m.currentCCType === 'tempo' && m.tempoEditor) {
            const selectedIds = Array.from(m.tempoEditor.selectedEvents);
            m.tempoEditor.removeEvents(selectedIds);
        } else if (m.currentCCType === 'velocity' && m.velocityEditor) {
            m.velocityEditor.deleteSelected();
        } else if (m.ccEditor) {
            m.ccEditor.deleteSelected();
        }

        this.updateDeleteButtonState();
    }

    /**
     * Mettre a jour l'etat du bouton de suppression
     */
    updateDeleteButtonState() {
        const m = this.modal;
        const deleteBtn = m.container?.querySelector('#cc-delete-btn');
        if (!deleteBtn) return;

        let hasSelection = false;
        if (m.currentCCType === 'tempo' && m.tempoEditor) {
            hasSelection = m.tempoEditor.selectedEvents.size > 0;
        } else if (m.currentCCType === 'velocity' && m.velocityEditor) {
            hasSelection = m.velocityEditor.selectedNotes.size > 0;
        } else if (m.ccEditor) {
            hasSelection = m.ccEditor.selectedEvents.size > 0;
        }

        deleteBtn.disabled = !hasSelection;
    }

    // ========================================================================
    // INIT CC EDITOR
    // ========================================================================

    /**
     * Initialiser l'editeur CC/Pitchbend
     */
    initCCEditor() {
        const m = this.modal;
        const container = document.getElementById('cc-editor-container');
        if (!container) {
            m.log('warn', 'Container cc-editor-container not found');
            return;
        }

        if (m.ccEditor) {
            m.log('info', 'CC Editor already initialized');
            return;
        }

        m.log('info', `Initializing CC Editor with ${m.ccEvents.length} total CC events`);

        const options = {
            timebase: m.pianoRoll?.timebase || 480,
            xrange: m.pianoRoll?.xrange || 1920,
            xoffset: m.pianoRoll?.xoffset || 0,
            grid: m.snapValues[m.currentSnapIndex].ticks,
            onChange: () => {
                m.isDirty = true;
                m.updateSaveButton();
            }
        };

        m.ccEditor = new CCPitchbendEditor(container, options);
        m.ccEditor.setCC(m.currentCCType);

        if (m.ccEvents.length > 0) {
            m.ccEditor.loadEvents(m.ccEvents);
            m.log('info', `Loaded ${m.ccEvents.length} CC events into editor`);
        }

        this.updateCCChannelSelector();

        const usedChannels = this.getCCChannelsUsed();
        const allChannels = this.getAllCCChannels();
        const activeChannel = usedChannels.length > 0 ? usedChannels[0] : (allChannels.length > 0 ? allChannels[0] : 0);
        m.ccEditor.setChannel(activeChannel);

        this.highlightUsedCCButtons();

        m.log('info', `CC Editor initialized - Type: ${m.currentCCType}, Channel: ${activeChannel + 1}, Type channels: [${usedChannels.map(c => c + 1).join(', ')}], All CC channels: [${allChannels.map(c => c + 1).join(', ')}]`);

        container.addEventListener('mouseup', () => {
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

        this.waitForCCEditorLayout();
    }

    /**
     * Attendre que l'editeur CC ait une hauteur valide avant de le redimensionner
     */
    waitForCCEditorLayout(attempts = 0, maxAttempts = 60) {
        const m = this.modal;
        if (!m.ccEditor || !m.ccEditor.element) {
            m.log('warn', 'waitForCCEditorLayout: ccEditor or element not found');
            return;
        }

        const height = m.ccEditor.element.getBoundingClientRect().height;
        m.log('debug', `waitForCCEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            m.ccEditor.resize();
            m.log('info', `CC Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            requestAnimationFrame(() => {
                this.waitForCCEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            m.log('error', `waitForCCEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    // ========================================================================
    // SYNC CC EDITOR
    // ========================================================================

    /**
     * Synchroniser l'editeur CC avec le piano roll
     */
    syncCCEditor() {
        const m = this.modal;
        if (!m.ccEditor || !m.pianoRoll) return;

        m.ccEditor.syncWith({
            xrange: m.pianoRoll.xrange,
            xoffset: m.pianoRoll.xoffset,
            grid: m.snapValues[m.currentSnapIndex].ticks,
            timebase: m.pianoRoll.timebase
        });
    }

    /**
     * Synchroniser tous les editeurs (CC et Velocity) avec le piano roll
     */
    syncAllEditors() {
        this.syncCCEditor();
        this.syncVelocityEditor();
        this.syncTempoEditor();
    }

    /**
     * Synchroniser les evenements depuis l'editeur CC vers this.ccEvents
     */
    syncCCEventsFromEditor() {
        const m = this.modal;
        if (!m.ccEditor) {
            m.log('info', `syncCCEventsFromEditor: CC editor not initialized, keeping ${m.ccEvents.length} original events`);
            return;
        }

        const editorEvents = m.ccEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            m.log('info', 'syncCCEventsFromEditor: No CC events in editor');
            m.ccEvents = [];
            return;
        }

        m.ccEvents = editorEvents.map(e => {
            const evt = {
                type: e.type,
                ticks: e.ticks,
                channel: e.channel,
                value: e.value,
                id: e.id
            };
            // Préserver le champ note pour poly aftertouch
            if (e.note !== undefined) {
                evt.note = e.note;
            }
            return evt;
        });

        m.log('info', `Synchronized ${m.ccEvents.length} CC/pitchbend events from editor`);

        if (m.ccEvents.length > 0) {
            const sample = m.ccEvents.slice(0, 3);
            m.log('debug', 'Sample synchronized events:', sample);
        }
    }

    // ========================================================================
    // TEMPO EDITOR
    // ========================================================================

    /**
     * Synchroniser les evenements de tempo depuis l'editeur de tempo
     */
    syncTempoEventsFromEditor() {
        const m = this.modal;
        if (!m.tempoEditor) {
            m.log('info', `syncTempoEventsFromEditor: Tempo editor not initialized, keeping ${m.tempoEvents.length} original events`);
            return;
        }

        const editorEvents = m.tempoEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            m.log('info', 'syncTempoEventsFromEditor: No tempo events in editor');
            m.tempoEvents = [];
            return;
        }

        m.tempoEvents = editorEvents.map(e => ({
            ticks: e.ticks,
            tempo: e.tempo,
            id: e.id
        }));

        if (m.tempoEvents.length > 0) {
            m.tempo = m.tempoEvents[0].tempo;
        }

        m.log('info', `Synchronized ${m.tempoEvents.length} tempo events from editor`);
    }

    /**
     * Initialiser l'editeur de tempo
     */
    initTempoEditor() {
        const m = this.modal;
        const container = document.getElementById('tempo-editor-container');
        if (!container) {
            m.log('warn', 'Container tempo-editor-container not found');
            return;
        }

        if (m.tempoEditor) {
            m.log('info', 'Tempo Editor already initialized');
            return;
        }

        m.log('info', 'Initializing Tempo Editor');

        const options = {
            timebase: m.pianoRoll?.timebase || 480,
            xrange: m.pianoRoll?.xrange || 1920,
            xoffset: m.pianoRoll?.xoffset || 0,
            grid: m.snapValues[m.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
                m.isDirty = true;
                m.updateSaveButton();
            }
        };

        m.tempoEditor = new TempoEditor(container, options);
        m.tempoEditor.setEvents(m.tempoEvents);

        m.log('info', `Tempo Editor initialized with ${m.tempoEvents.length} events`);

        this.waitForTempoEditorLayout();
    }

    /**
     * Attendre que l'editeur de tempo ait une hauteur valide
     */
    waitForTempoEditorLayout(attempts = 0, maxAttempts = 60) {
        const m = this.modal;
        if (!m.tempoEditor || !m.tempoEditor.element) {
            m.log('warn', 'waitForTempoEditorLayout: tempoEditor or element not found');
            return;
        }

        const height = m.tempoEditor.element.getBoundingClientRect().height;
        m.log('debug', `waitForTempoEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            m.tempoEditor.resize();
            m.log('info', `Tempo Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            requestAnimationFrame(() => {
                this.waitForTempoEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            m.log('error', `waitForTempoEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
     * Synchroniser l'editeur de tempo avec le piano roll
     */
    syncTempoEditor() {
        const m = this.modal;
        if (!m.tempoEditor || !m.pianoRoll) return;

        m.tempoEditor.setXRange(m.pianoRoll.xrange);
        m.tempoEditor.setXOffset(m.pianoRoll.xoffset);
        m.tempoEditor.setGrid(m.snapValues[m.currentSnapIndex].ticks);
    }

    // ========================================================================
    // CURVE BUTTONS
    // ========================================================================

    /**
     * Afficher les boutons de courbes
     */
    showCurveButtons() {
        const m = this.modal;
        let curveSection = m.container.querySelector('.curve-section');
        if (!curveSection) {
            const toolbar = m.container.querySelector('.cc-type-toolbar');
            if (!toolbar) return;

            const curveHTML = `
                <div class="cc-toolbar-divider"></div>
                <div class="curve-section">
                    <label class="cc-toolbar-label">${m.t('midiEditor.curveType')}</label>
                    <div class="cc-curve-buttons-horizontal">
                        <button class="cc-curve-btn active" data-curve="linear" title="${m.t('midiEditor.curveLinear')}">━</button>
                        <button class="cc-curve-btn" data-curve="exponential" title="${m.t('midiEditor.curveExponential')}">⌃</button>
                        <button class="cc-curve-btn" data-curve="logarithmic" title="${m.t('midiEditor.curveLogarithmic')}">⌄</button>
                        <button class="cc-curve-btn" data-curve="sine" title="${m.t('midiEditor.curveSine')}">∿</button>
                    </div>
                </div>
            `;

            const deleteBtn = m.container.querySelector('#cc-delete-btn');
            if (deleteBtn && deleteBtn.previousElementSibling) {
                deleteBtn.previousElementSibling.insertAdjacentHTML('beforebegin', curveHTML);

                const ccCurveButtons = m.container.querySelectorAll('.cc-curve-btn');
                ccCurveButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const curveType = btn.dataset.curve;
                        if (curveType) {
                            ccCurveButtons.forEach(b => b.classList.remove('active'));
                            btn.classList.add('active');
                            // Appliquer au bon éditeur selon le type actif
                            if (m.currentCCType === 'tempo' && m.tempoEditor) {
                                m.tempoEditor.setCurveType(curveType);
                            } else if (m.ccEditor) {
                                m.ccEditor.setCurveType(curveType);
                            }
                        }
                    });
                });
            }
        } else {
            curveSection.style.display = 'flex';
            curveSection.previousElementSibling.style.display = 'block';
        }
    }

    /**
     * Masquer les boutons de courbes
     */
    hideCurveButtons() {
        const m = this.modal;
        const curveSection = m.container.querySelector('.curve-section');
        if (curveSection) {
            curveSection.style.display = 'none';
            if (curveSection.previousElementSibling && curveSection.previousElementSibling.classList.contains('cc-toolbar-divider')) {
                curveSection.previousElementSibling.style.display = 'none';
            }
        }
    }

    // ========================================================================
    // VELOCITY EDITOR
    // ========================================================================

    /**
     * Initialiser l'editeur de velocite
     */
    initVelocityEditor() {
        const m = this.modal;
        const container = document.getElementById('velocity-editor-container');
        if (!container) {
            m.log('warn', 'Container velocity-editor-container not found');
            return;
        }

        if (m.velocityEditor) {
            m.log('info', 'Velocity Editor already initialized');
            return;
        }

        m.log('info', `Initializing Velocity Editor with ${m.sequence.length} notes`);

        const options = {
            timebase: m.pianoRoll?.timebase || 480,
            xrange: m.pianoRoll?.xrange || 1920,
            xoffset: m.pianoRoll?.xoffset || 0,
            grid: m.snapValues[m.currentSnapIndex].ticks,
            onChange: (sequence) => {
                m.isDirty = true;
                m.updateSaveButton();
                this.syncSequenceFromVelocityEditor(sequence);
            }
        };

        m.velocityEditor = new VelocityEditor(container, options);
        m.velocityEditor.setSequence(m.fullSequence);

        const firstChannel = m.channels.length > 0 ? m.channels[0].channel : 0;
        m.velocityEditor.setChannel(firstChannel);

        this.highlightUsedCCButtons();

        m.log('info', `Velocity Editor initialized with ${m.fullSequence.length} notes, default channel: ${firstChannel + 1}`);

        this.updateEditorChannelSelector();

        container.addEventListener('mouseup', () => {
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

        this.waitForVelocityEditorLayout();
    }

    /**
     * Attendre que l'editeur de velocite ait une hauteur valide
     */
    waitForVelocityEditorLayout(attempts = 0, maxAttempts = 60) {
        const m = this.modal;
        if (!m.velocityEditor || !m.velocityEditor.element) {
            m.log('warn', 'waitForVelocityEditorLayout: velocityEditor or element not found');
            return;
        }

        const height = m.velocityEditor.element.getBoundingClientRect().height;
        m.log('debug', `waitForVelocityEditorLayout attempt ${attempts}: height=${height}`);

        if (height > 100) {
            m.velocityEditor.resize();
            m.log('info', `Velocity Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
            requestAnimationFrame(() => {
                this.waitForVelocityEditorLayout(attempts + 1, maxAttempts);
            });
        } else {
            m.log('error', `waitForVelocityEditorLayout: Max attempts reached (${maxAttempts}), height still ${height}px`);
        }
    }

    /**
     * Synchroniser l'editeur de velocite avec le piano roll
     */
    syncVelocityEditor() {
        const m = this.modal;
        if (!m.velocityEditor || !m.pianoRoll) return;

        m.velocityEditor.syncWith({
            xrange: m.pianoRoll.xrange,
            xoffset: m.pianoRoll.xoffset,
            grid: m.snapValues[m.currentSnapIndex].ticks,
            timebase: m.pianoRoll.timebase
        });
    }

    /**
     * Synchroniser la sequence depuis l'editeur de velocite
     */
    syncSequenceFromVelocityEditor(velocitySequence) {
        const m = this.modal;
        if (!velocitySequence) return;

        m.fullSequence.forEach(note => {
            const velocityNote = velocitySequence.find(vn =>
                vn.t === note.t && vn.n === note.n && vn.c === note.c
            );
            if (velocityNote) {
                note.v = velocityNote.v || 100;
            }
        });

        m.sequence = m.fullSequence.filter(note => m.activeChannels.has(note.c));

        if (m.pianoRoll) {
            m.pianoRoll.sequence = m.sequence;
            if (typeof m.pianoRoll.redraw === 'function') {
                m.pianoRoll.redraw();
            }
        }

        m.log('debug', 'Synchronized velocities from velocity editor to sequence');
    }

    // ========================================================================
    // EXTRACT CC AND PITCHBEND
    // ========================================================================

    /**
     * Extraire les evenements CC et pitchbend de toutes les pistes
     */
    extractCCAndPitchbend() {
        const m = this.modal;
        m.ccEvents = [];

        if (!m.midiData || !m.midiData.tracks) {
            m.log('warn', 'No MIDI tracks to extract CC/pitchbend');
            return;
        }

        m.midiData.tracks.forEach((track, trackIndex) => {
            if (!track.events) {
                return;
            }

            let currentTick = 0;

            track.events.forEach((event) => {
                currentTick += event.deltaTime || 0;

                if (event.type === 'controller') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    const controller = event.controllerType;

                    if (controller !== undefined && controller >= 0 && controller <= 127) {
                        m.ccEvents.push({
                            type: `cc${controller}`,
                            ticks: currentTick,
                            channel: channel,
                            value: event.value,
                            id: Date.now() + Math.random() + m.ccEvents.length
                        });
                    }
                }

                if (event.type === 'pitchBend') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    m.ccEvents.push({
                        type: 'pitchbend',
                        ticks: currentTick,
                        channel: channel,
                        value: event.value,
                        id: Date.now() + Math.random() + m.ccEvents.length
                    });
                }

                // Channel Aftertouch events
                if (event.type === 'channelAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    m.ccEvents.push({
                        type: 'aftertouch',
                        ticks: currentTick,
                        channel: channel,
                        value: event.amount !== undefined ? event.amount : (event.value || 0),
                        id: Date.now() + Math.random() + m.ccEvents.length
                    });
                }

                // Polyphonic Aftertouch events (polyAftertouch from CustomMidiParser, noteAftertouch from midi-file lib)
                if (event.type === 'polyAftertouch' || event.type === 'noteAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    m.ccEvents.push({
                        type: 'polyAftertouch',
                        ticks: currentTick,
                        channel: channel,
                        note: event.noteNumber,
                        value: event.pressure !== undefined ? event.pressure : (event.amount !== undefined ? event.amount : (event.value || 0)),
                        id: Date.now() + Math.random() + m.ccEvents.length
                    });
                }
            });
        });

        m.ccEvents.sort((a, b) => a.ticks - b.ticks);

        m.log('info', `Extracted ${m.ccEvents.length} CC/pitchbend events`);

        const typeCounts = {};
        m.ccEvents.forEach(e => {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        });
        const summary = Object.entries(typeCounts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        if (summary) {
            m.log('info', `  - ${summary}`);
        }

        const usedChannels = this.getCCChannelsUsed();
        if (usedChannels.length > 0) {
            m.log('info', `  - Canaux utilises: ${usedChannels.map(c => c + 1).join(', ')}`);
        }

        this.highlightUsedCCButtons();
    }

    // ========================================================================
    // DYNAMIC CC BUTTONS
    // ========================================================================

    /**
     * Mettre a jour les boutons CC dynamiques selon les CC presents dans le fichier
     */
    updateDynamicCCButtons() {
        const m = this.modal;
        const dynamicContainer = m.container?.querySelector('#cc-dynamic-buttons');
        const dynamicGroup = m.container?.querySelector('.cc-dynamic-group');
        if (!dynamicContainer || !dynamicGroup) return;

        const staticCCs = new Set(['cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'aftertouch', 'polyAftertouch']);

        const detectedCCs = new Set();
        m.ccEvents.forEach(e => {
            if (!staticCCs.has(e.type) && e.type.startsWith('cc')) {
                detectedCCs.add(e.type);
            }
        });

        dynamicContainer.innerHTML = '';

        if (detectedCCs.size === 0) {
            dynamicGroup.style.display = 'none';
            return;
        }

        dynamicGroup.style.display = '';

        const sortedCCs = Array.from(detectedCCs).sort((a, b) => {
            return parseInt(a.replace('cc', '')) - parseInt(b.replace('cc', ''));
        });

        sortedCCs.forEach(ccType => {
            const ccNum = parseInt(ccType.replace('cc', ''));
            const ccName = MidiEditorModal.CC_NAMES[ccNum] || `Ctrl ${ccNum}`;
            const count = m.ccEvents.filter(e => e.type === ccType).length;

            const btn = document.createElement('button');
            btn.className = 'cc-type-btn dynamic';
            btn.dataset.ccType = ccType;
            btn.title = `${ccName} (${count} events)`;
            btn.textContent = `CC${ccNum}`;

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectCCType(ccType);
            });

            dynamicContainer.appendChild(btn);
        });

        m.log('info', `Added ${sortedCCs.length} dynamic CC buttons: ${sortedCCs.join(', ')}`);

        this.highlightUsedCCButtons();
    }

    // ========================================================================
    // POLY AFTERTOUCH NOTE SELECTOR
    // ========================================================================

    /**
     * Obtenir les notes ayant des evenements polyAftertouch sur un canal donne
     */
    getPolyAftertouchNotes(channel) {
        const m = this.modal;
        const notes = new Set();
        m.ccEvents.forEach(event => {
            if (event.type === 'polyAftertouch' && event.channel === channel && event.note !== undefined) {
                notes.add(event.note);
            }
        });
        return Array.from(notes).sort((a, b) => a - b);
    }

    /**
     * Afficher/masquer le selecteur de note selon le type CC actif
     */
    updateNoteSelectorVisibility(ccType) {
        const m = this.modal;
        let noteSelector = m.container?.querySelector('#poly-note-selector');

        if (ccType === 'polyAftertouch') {
            if (!noteSelector) {
                // Créer le sélecteur de note
                const channelSelector = document.getElementById('editor-channel-selector');
                if (!channelSelector) return;

                const noteSelectorHTML = `
                    <div id="poly-note-selector" class="cc-note-selector" style="display: flex; align-items: center; gap: 4px; margin-left: 8px;">
                        <label class="cc-toolbar-label">${m.t('midiEditor.noteSelector')}</label>
                        <div id="poly-note-buttons" style="display: flex; gap: 2px; flex-wrap: wrap;"></div>
                    </div>
                `;
                channelSelector.insertAdjacentHTML('afterend', noteSelectorHTML);
            } else {
                noteSelector.style.display = 'flex';
            }
            this.updateNoteSelectorButtons();
        } else {
            if (noteSelector) {
                noteSelector.style.display = 'none';
            }
        }
    }

    /**
     * Mettre a jour les boutons de note pour poly aftertouch
     */
    updateNoteSelectorButtons() {
        const m = this.modal;
        const container = document.getElementById('poly-note-buttons');
        if (!container) return;

        const channel = m.ccEditor ? m.ccEditor.currentChannel : 0;
        const notes = this.getPolyAftertouchNotes(channel);

        if (notes.length === 0) {
            container.innerHTML = `<span class="cc-no-channels">${m.t('midiEditor.noAftertouchInFile')}</span>`;
            return;
        }

        // Noms de notes MIDI
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const currentNote = m.ccEditor ? m.ccEditor.currentNote : null;

        container.innerHTML = notes.map(note => {
            const octave = Math.floor(note / 12) - 1;
            const name = noteNames[note % 12] + octave;
            return `<button class="cc-channel-btn ${note === currentNote ? 'active' : ''}" data-note="${note}" title="MIDI ${note}">${name}</button>`;
        }).join('');

        // Attacher les listeners
        container.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const note = parseInt(btn.dataset.note);
                if (!isNaN(note) && m.ccEditor) {
                    container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    m.ccEditor.setNote(note);
                    m.log('info', `Note poly aftertouch selectionnee: ${note}`);
                }
            });
        });

        // Sélectionner la première note si aucune n'est sélectionnée
        if (currentNote === null && notes.length > 0 && m.ccEditor) {
            m.ccEditor.setNote(notes[0]);
            const firstBtn = container.querySelector('button');
            if (firstBtn) firstBtn.classList.add('active');
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MidiEditorCCPanel;
}

if (typeof window !== 'undefined') {
    window.MidiEditorCCPanel = MidiEditorCCPanel;
}
