// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorCC.js
// Description: CC/Pitchbend extraction, channel selectors, and mode management
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorCCMixin = {};

    MidiEditorCCMixin.getAllCCChannels = function() {
        const channels = new Set();
        this.ccEvents.forEach(event => {
            if (event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    /**
     * Obtenir l'ensemble des canaux utilisés par le type CC/Pitchbend actuel
     */
    MidiEditorCCMixin.getCCChannelsUsed = function() {
        const channels = new Set();
        this.ccEvents.forEach(event => {
            // Filtrer uniquement les événements du type CC actuellement sélectionné
            if (event.type === this.currentCCType && event.channel !== undefined) {
                channels.add(event.channel);
            }
        });
        return Array.from(channels).sort((a, b) => a - b);
    }

    /**
     * Mettre à jour le sélecteur de canal pour afficher uniquement les canaux présents dans le fichier
     */
    MidiEditorCCMixin.updateEditorChannelSelector = function() {
        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        // Le tempo est global - afficher tous les canaux comme actifs
        if (this.currentCCType === 'tempo') {
            const allChannels = this.channels.map(ch => ch.channel).sort((a, b) => a - b);
            if (allChannels.length === 0) {
                channelSelector.innerHTML = '';
                return;
            }
            channelSelector.innerHTML = allChannels.map(channel =>
                `<button class="cc-channel-btn active" data-channel="${channel}" title="${this.t('midiEditor.channelTip', { channel: channel + 1 })}" disabled>${channel + 1}</button>`
            ).join('');
            return;
        }

        let channelsToShow = [];
        let activeChannel = 0;

        // Toujours afficher tous les canaux du fichier (velocity ou CC/Pitchbend)
        channelsToShow = this.channels.map(ch => ch.channel).sort((a, b) => a - b);

        // Si un seul canal est en cours d'edition, le selectionner automatiquement
        if (this.activeChannels && this.activeChannels.size === 1) {
            activeChannel = Array.from(this.activeChannels)[0];
            if (this.currentCCType === 'velocity' && this.velocityEditor) {
                this.velocityEditor.setChannel(activeChannel);
            } else if (this.ccEditor) {
                this.ccEditor.setChannel(activeChannel);
            }
        } else if (this.currentCCType === 'velocity') {
            activeChannel = this.velocityEditor ? this.velocityEditor.currentChannel : -1;
        } else {
            activeChannel = this.ccEditor ? this.ccEditor.currentChannel : -1;
        }

        // Si aucun canal, afficher un message
        if (channelsToShow.length === 0) {
            const message = this.currentCCType === 'velocity' ? this.t('midiEditor.noNotesInFile') : this.t('midiEditor.noCCInFile');
            channelSelector.innerHTML = `<div class="cc-no-channels">${message}</div>`;
            this.log('info', message);
            return;
        }

        // S'assurer que le canal actif est dans la liste, sinon prendre le premier
        if (!channelsToShow.includes(activeChannel)) {
            activeChannel = channelsToShow[0];
            // Appliquer le canal dans l'éditeur
            if (this.currentCCType === 'velocity' && this.velocityEditor) {
                this.velocityEditor.setChannel(activeChannel);
            } else if (this.ccEditor) {
                this.ccEditor.setChannel(activeChannel);
            }
        }

        // Déterminer quels canaux ont des données pour le CC actif
        const channelsWithData = this.getCCChannelsUsed ? this.getCCChannelsUsed() : [];

        // Générer les boutons uniquement pour les canaux présents
        channelSelector.innerHTML = channelsToShow.map(channel => {
            const classes = ['cc-channel-btn'];
            if (channel === activeChannel) classes.push('active');
            if (channelsWithData.includes(channel)) classes.push('has-cc-data');
            return `<button class="${classes.join(' ')}" data-channel="${channel}" title="${this.t('midiEditor.channelTip', { channel: channel + 1 })}">${channel + 1}</button>`;
        }).join('');

        // Réattacher les event listeners
        this.attachEditorChannelListeners();
        this.highlightUsedCCButtons();

        this.log('info', `Sélecteur de canal mis à jour - Type ${this.currentCCType}: ${channelsToShow.length} canaux`);
    }

    /**
     * DEPRECATED: Use updateEditorChannelSelector() instead
     */
    MidiEditorCCMixin.updateCCChannelSelector = function() {
        this.updateEditorChannelSelector();
    }

    /**
     * Attacher les event listeners aux boutons de canal pour CC ou Velocity
     */
    MidiEditorCCMixin.attachEditorChannelListeners = function() {
        // OPTIMISATION: Event delegation au lieu de listeners individuels
        // Les boutons .cc-channel-btn sont recréés dynamiquement, l'event delegation
        // sur le container parent évite de réattacher des listeners à chaque update
        if (this._ccChannelDelegationAttached) return;

        const channelSelector = document.getElementById('editor-channel-selector');
        if (!channelSelector) return;

        this._ccChannelDelegationAttached = true;

        channelSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.cc-channel-btn');
            if (!btn) return;
            e.preventDefault();
            const channel = parseInt(btn.dataset.channel);
            if (isNaN(channel)) return;

            channelSelector.querySelectorAll('.cc-channel-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (this.currentCCType === 'velocity' && this.velocityEditor) {
                this.velocityEditor.setChannel(channel);
                this.log('info', `Canal vélocité sélectionné: ${channel + 1}`);
            } else if (this.ccEditor) {
                this.ccEditor.setChannel(channel);
                this.log('info', `Canal CC sélectionné: ${channel + 1}`);
                // Auto-sélectionner un CC type avec données sur ce canal
                this.selectBestCCTypeForChannel(channel);
            }

            // Mettre à jour le highlight des CC et les boutons dynamiques
            this.highlightUsedCCButtons();
            this.updateDynamicCCButtons();
        });
    }

    /**
     * DEPRECATED: Use attachEditorChannelListeners() instead
     */
    MidiEditorCCMixin.attachCCChannelListeners = function() {
        this.attachEditorChannelListeners();
    }

    /**
     * Extraire les événements CC et pitchbend de toutes les pistes
     * Format de sortie attendu par CCPitchbendEditor:
     * { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
     */
    MidiEditorCCMixin.extractCCAndPitchbend = function() {
        this.ccEvents = [];

        if (!this.midiData || !this.midiData.tracks) {
            this.log('warn', 'No MIDI tracks to extract CC/pitchbend');
            return;
        }

        this.midiData.tracks.forEach((track, _trackIndex) => {
            if (!track.events) {
                return;
            }

            let currentTick = 0;

            track.events.forEach((event) => {
                currentTick += event.deltaTime || 0;

                // Control Change events — capturer TOUS les CC (0-127)
                // Accepter 'controller' (midi-file lib) et 'controlChange' (MidiParser.js) pour robustesse
                if (event.type === 'controller' || event.type === 'controlChange') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    const controller = event.controllerType;

                    if (controller !== undefined && controller >= 0 && controller <= 127) {
                        this.ccEvents.push({
                            type: `cc${controller}`,
                            ticks: currentTick,
                            channel: channel,
                            value: event.value,
                            id: Date.now() + Math.random() + this.ccEvents.length
                        });
                    }
                }

                // Pitch Bend events
                if (event.type === 'pitchBend') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.ccEvents.push({
                        type: 'pitchbend',
                        ticks: currentTick,
                        channel: channel,
                        value: event.value,
                        id: Date.now() + Math.random() + this.ccEvents.length
                    });
                }

                // Channel Aftertouch events
                if (event.type === 'channelAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.ccEvents.push({
                        type: 'aftertouch',
                        ticks: currentTick,
                        channel: channel,
                        value: event.amount !== undefined ? event.amount : (event.value || 0),
                        id: Date.now() + Math.random() + this.ccEvents.length
                    });
                }

                // Polyphonic Aftertouch events (polyAftertouch from CustomMidiParser, noteAftertouch from midi-file lib)
                if (event.type === 'polyAftertouch' || event.type === 'noteAftertouch') {
                    const channel = event.channel !== undefined ? event.channel : 0;
                    this.ccEvents.push({
                        type: 'polyAftertouch',
                        ticks: currentTick,
                        channel: channel,
                        note: event.noteNumber,
                        value: event.pressure !== undefined ? event.pressure : (event.amount !== undefined ? event.amount : (event.value || 0)),
                        id: Date.now() + Math.random() + this.ccEvents.length
                    });
                }
            });
        });

        // Trier par tick
        this.ccEvents.sort((a, b) => a.ticks - b.ticks);

        this.log('info', `Extracted ${this.ccEvents.length} CC/pitchbend events`);

        // Log summary by type (compter dynamiquement)
        const typeCounts = {};
        this.ccEvents.forEach(e => {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        });
        const summary = Object.entries(typeCounts)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        if (summary) {
            this.log('info', `  - ${summary}`);
        }

        // Log des canaux utilisés
        const usedChannels = this.getCCChannelsUsed();
        if (usedChannels.length > 0) {
            this.log('info', `  - Canaux utilisés: ${usedChannels.map(c => c + 1).join(', ')}`);
        }

        this.highlightUsedCCButtons();
    }

    /**
     * Noms standards des CC MIDI (pour l'affichage des CC dynamiques)
     */
    MidiEditorCCMixin.CC_NAMES = {
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

    /**
     * Categories de CC pour le picker (groupes logiques)
     */
    MidiEditorCCMixin.CC_CATEGORIES = [
        { name: 'Performance', ccs: [1, 2, 4, 11, 64, 65, 66, 67, 68] },
        { name: 'Mix', ccs: [7, 10, 8, 91, 92, 93, 94, 95] },
        { name: 'Tone / Timbre', ccs: [71, 72, 73, 74, 75, 76, 77, 78, 70] },
        { name: 'Portamento', ccs: [5, 84] },
        { name: 'Data / Bank', ccs: [0, 6, 32, 38, 96, 97, 98, 99, 100, 101] },
        { name: 'General Purpose', ccs: [16, 17, 18, 19, 80, 81, 82, 83] },
        { name: 'Channel Mode', ccs: [120, 121, 122, 123, 124, 125, 126, 127] }
    ];

    MidiEditorCCMixin._getCCName = function(ccNum) {
        const key = 'ccNames.' + ccNum;
        const translated = this.t(key);
        if (translated !== key) return translated;
        return MidiEditorModal.CC_NAMES[ccNum] || this.t('ccNames.fallback', { num: ccNum });
    }

    /**
     * Mettre à jour les boutons CC dynamiques selon les CC présents dans le fichier
     * Ajoute des boutons pour les CC non couverts par les boutons statiques
     */
    MidiEditorCCMixin.updateDynamicCCButtons = function() {
        const dynamicContainer = this.container?.querySelector('#cc-dynamic-buttons');
        const dynamicGroup = this.container?.querySelector('.cc-dynamic-group');
        if (!dynamicContainer || !dynamicGroup) return;

        // CC couverts par les boutons statiques
        const staticCCs = new Set(['cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'cc76', 'cc77', 'cc78', 'cc91', 'pitchbend', 'aftertouch', 'polyAftertouch']);

        // Trouver les CC présents dans le fichier mais pas en statique (tous canaux)
        const detectedCCs = new Set();
        this.ccEvents.forEach(e => {
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

        // Déterminer le canal actif pour le filtrage visuel
        const activeBtn = this.container.querySelector('#editor-channel-selector .cc-channel-btn.active');
        const activeChannel = activeBtn ? parseInt(activeBtn.dataset.channel) :
            (this.channels && this.channels.length > 0 ? this.channels[0].channel : 0);
        const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);

        // Trier les CC détectés numériquement
        const sortedCCs = Array.from(detectedCCs).sort((a, b) => {
            return parseInt(a.replace('cc', '')) - parseInt(b.replace('cc', ''));
        });

        // OPTIMISATION: Pré-calculer les counts en un seul passage au lieu de O(n) par CC type
        const ccCounts = new Map();
        this.ccEvents.forEach(e => ccCounts.set(e.type, (ccCounts.get(e.type) || 0) + 1));

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
            btn.title = `${ccName} (${this.t('midiEditor.events', { count })})`;
            btn.textContent = `CC${ccNum}`;

            fragment.appendChild(btn);
        });
        dynamicContainer.appendChild(fragment);

        this.log('info', `Added ${sortedCCs.length} dynamic CC buttons: ${sortedCCs.join(', ')}`);

        this.highlightUsedCCButtons();
    }

    /**
     * Basculer l'affichage d'un canal

    // === CC/PITCHBEND MODE MANAGEMENT ===

    // ========================================================================
    // GESTION DU MODE CC/PITCHBEND
    // ========================================================================

    /**
     * Basculer l'état collapsed/expanded de la section CC
     */
    MidiEditorCCMixin.toggleCCSection = function() {
        this.ccSectionExpanded = !this.ccSectionExpanded;

        const ccSection = document.getElementById('cc-section');
        const ccContent = document.getElementById('cc-section-content');
        const ccHeader = document.getElementById('cc-section-header');
        const resizeBar = document.getElementById('cc-resize-btn');

        if (ccSection && ccContent && ccHeader) {
            if (this.ccSectionExpanded) {
                ccSection.classList.add('expanded');
                ccSection.classList.remove('collapsed');
                ccHeader.classList.add('expanded');
                ccHeader.classList.remove('collapsed');

                // Afficher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.add('visible');
                    this.log('debug', 'Resize bar shown');
                }

                // Écouter la fin de la transition CSS
                const onTransitionEnd = (e) => {
                    // S'assurer que c'est bien la transition de la section CC
                    if (e.target !== ccSection) return;

                    ccSection.removeEventListener('transitionend', onTransitionEnd);

                    this.log('debug', 'CC Section transition ended');

                    // Initialiser l'éditeur CC s'il n'existe pas encore
                    if (!this.ccEditor) {
                        this.initCCEditor();
                    } else {
                        // L'éditeur existe déjà, attendre que le layout soit prêt puis redimensionner
                        this.waitForCCEditorLayout();
                    }
                };

                ccSection.addEventListener('transitionend', onTransitionEnd);

                // Fallback si pas de transition (déjà expanded, etc.)
                setTimeout(() => {
                    if (!this.ccEditor) {
                        this.initCCEditor();
                    }
                }, 400);
            } else {
                ccSection.classList.remove('expanded');
                ccSection.classList.add('collapsed');
                ccHeader.classList.remove('expanded');
                ccHeader.classList.add('collapsed');

                // Nettoyer les styles inline posés par le drag resize
                // pour que les classes CSS (flex, min-height) reprennent le contrôle
                ccSection.style.removeProperty('height');
                ccSection.style.removeProperty('flex');
                ccSection.style.removeProperty('min-height');

                const notesSection = this.container?.querySelector('.notes-section');
                if (notesSection) {
                    notesSection.style.removeProperty('height');
                    notesSection.style.removeProperty('flex');
                    notesSection.style.removeProperty('min-height');
                }

                // Cacher la barre de resize
                if (resizeBar) {
                    resizeBar.classList.remove('visible');
                    this.log('debug', 'Resize bar hidden');
                }

                // Suspend sub-editors to save CPU when collapsed
                if (this.ccEditor && typeof this.ccEditor.suspend === 'function') this.ccEditor.suspend();
                if (this.velocityEditor && typeof this.velocityEditor.suspend === 'function') this.velocityEditor.suspend();
                if (this.tempoEditor && typeof this.tempoEditor.suspend === 'function') this.tempoEditor.suspend();

                // Redimensionner le piano roll pour occuper tout l'espace
                requestAnimationFrame(() => {
                    if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                        this.pianoRoll.redraw();
                    }
                });
            }
        }

        this.log('info', `Section CC ${this.ccSectionExpanded ? 'expanded' : 'collapsed'}`);
    }

    /**
     * Sélectionner le meilleur type CC pour un canal donné
     * Si le type actuel n'a pas de données sur le canal, sélectionner le premier type avec données
     * Si aucun CC sur le canal, afficher un message
     */
    MidiEditorCCMixin.selectBestCCTypeForChannel = function(channel) {
        // Ne rien faire si on est en mode velocity ou tempo
        if (this.currentCCType === 'velocity' || this.currentCCType === 'tempo') return;

        const usedTypes = this.getUsedCCTypesForChannel(channel);
        const ccTypes = Array.from(usedTypes).filter(t => t !== 'velocity' && t !== 'tempo');

        // Masquer le message "aucun CC" s'il existe
        const ccEditorContainer = document.getElementById('cc-editor-container');
        const existingMsg = ccEditorContainer?.querySelector('.cc-no-data-message');
        if (existingMsg) existingMsg.remove();

        if (ccTypes.length === 0) {
            // Aucun CC sur ce canal — déselectionner tous les boutons CC
            this.container?.querySelectorAll('.cc-type-btn').forEach(btn => {
                const type = btn.dataset.ccType;
                if (type && type !== 'velocity' && type !== 'tempo') {
                    btn.classList.remove('active');
                }
            });

            // Afficher un message dans l'éditeur
            if (ccEditorContainer) {
                const msg = document.createElement('div');
                msg.className = 'cc-no-data-message';
                msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:13px;pointer-events:none;z-index:1;';
                msg.textContent = this.t('midiEditor.noCCOnChannel') || 'No CC on this channel';
                ccEditorContainer.appendChild(msg);
            }
            return;
        }

        // Si le type actuel a des données sur ce canal, le garder
        if (usedTypes.has(this.currentCCType)) return;

        // Sinon sélectionner le premier CC type avec données sur ce canal
        this.selectCCType(ccTypes[0]);
    }

    /**
     * Sélectionner le type de CC/Velocity à éditer
     */
    MidiEditorCCMixin.selectCCType = function(ccType) {
        this.currentCCType = ccType;
        this.log('info', `Type sélectionné: ${ccType}`);

        // Retirer le message "aucun CC" s'il existe
        const noDataMsg = document.querySelector('.cc-no-data-message');
        if (noDataMsg) noDataMsg.remove();

        // Mettre à jour les boutons
        const ccTypeButtons = this.container?.querySelectorAll('.cc-type-btn');
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
            // Afficher l'éditeur de tempo
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'flex';

            // Initialiser l'éditeur de tempo s'il n'existe pas
            if (!this.tempoEditor) {
                this.initTempoEditor();
            } else {
                // Synchroniser avec le piano roll actuel
                this.syncTempoEditor();
                // OPTIMISATION: Simple RAF au lieu de double RAF (-1 frame de délai)
                requestAnimationFrame(() => {
                    if (this.tempoEditor && this.tempoEditor.resize) {
                        this.tempoEditor.resize();
                    }
                });
            }

            // Afficher les boutons de courbes pour tempo
            this.showCurveButtons();
        } else if (ccType === 'velocity') {
            // Afficher l'éditeur de vélocité
            if (ccEditorContainer) ccEditorContainer.style.display = 'none';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'flex';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialiser l'éditeur de vélocité s'il n'existe pas
            if (!this.velocityEditor) {
                this.initVelocityEditor();
            } else {
                // Recharger la séquence complète (le filtrage par canal se fait dans l'éditeur)
                this.velocityEditor.setSequence(this.fullSequence);
                this.syncVelocityEditor();
                // OPTIMISATION: Simple RAF au lieu de double RAF (-1 frame de délai)
                requestAnimationFrame(() => {
                    if (this.velocityEditor && this.velocityEditor.resize) {
                        this.velocityEditor.resize();
                    }
                });
            }

            // Mettre à jour le sélecteur de canal pour la vélocité
            this.updateEditorChannelSelector();
            // Masquer les boutons de courbes
            this.hideCurveButtons();
        } else {
            // Afficher l'éditeur CC
            if (ccEditorContainer) ccEditorContainer.style.display = 'flex';
            if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
            if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

            // Initialiser l'éditeur CC s'il n'existe pas
            if (!this.ccEditor) {
                this.initCCEditor();
            } else {
                this.ccEditor.setCC(ccType);
                // OPTIMISATION: Simple RAF au lieu de double RAF
                requestAnimationFrame(() => {
                    if (this.ccEditor && this.ccEditor.resize) {
                        this.ccEditor.resize();
                    }
                });
                // Mettre à jour le sélecteur de canal car les canaux utilisés peuvent varier selon le type CC
                this.updateEditorChannelSelector();
            }

            // Afficher les boutons de courbes pour les CC aussi
            this.showCurveButtons();
        }

        // Mettre à jour l'état du bouton de suppression après le changement de type
        this.updateDeleteButtonState();
        this.highlightUsedCCButtons();
    }

    /**
     * Obtenir les types CC utilises sur un canal donne
     */
    MidiEditorCCMixin.getUsedCCTypesForChannel = function(channel) {
        const usedTypes = new Set();
        this.ccEvents.forEach(event => {
            if (event.channel === channel) {
                usedTypes.add(event.type);
            }
        });
        if (this.fullSequence && this.fullSequence.some(note => note.c === channel)) {
            usedTypes.add('velocity');
        }
        return usedTypes;
    }

    /**
     * Obtenir l'ensemble de tous les types CC utilises dans le fichier (tous canaux confondus)
     */
    MidiEditorCCMixin.getAllUsedCCTypes = function() {
        const allTypes = new Set();
        this.ccEvents.forEach(event => {
            allTypes.add(event.type);
        });
        if (this.fullSequence && this.fullSequence.length > 0) {
            allTypes.add('velocity');
        }
        return allTypes;
    }

    /**
     * Mettre a jour la visibilite des boutons CC selon les donnees presentes sur le canal actif
     * Masque les boutons CC sans donnees dans le fichier, montre en attenue les CC d'autres canaux
     */
    MidiEditorCCMixin.highlightUsedCCButtons = function() {
        if (!this.container) return;

        // Source de vérité : le bouton canal actif dans le DOM
        const activeBtn = this.container.querySelector('#editor-channel-selector .cc-channel-btn.active');
        const activeChannel = activeBtn ? parseInt(activeBtn.dataset.channel) :
            (this.channels && this.channels.length > 0 ? this.channels[0].channel : 0);

        const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);
        const allUsedTypes = this.getAllUsedCCTypes();
        const alwaysVisible = new Set(['velocity', 'tempo']);

        this.container.querySelectorAll('.cc-type-btn').forEach(btn => {
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
        this.container.querySelectorAll('.cc-btn-group:not(.cc-dynamic-group)').forEach(group => {
            if (group.dataset.group === 'custom') return;
            const visibleBtns = group.querySelectorAll('.cc-type-btn:not([style*="display: none"])');
            group.style.display = visibleBtns.length > 0 ? '' : 'none';
        });
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorCCMixin = MidiEditorCCMixin;
    }
})();
