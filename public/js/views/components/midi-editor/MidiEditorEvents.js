// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorEvents.js
// Description: Event handlers and resize management
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorEventsMixin = {};

    // ========================================================================
    // ÉVÉNEMENTS
    // ========================================================================

    MidiEditorEventsMixin.attachEvents = function() {
        if (!this.container) return;

    // Pas de fermeture au clic sur le fond pour l'éditeur MIDI
    // (évite les fermetures accidentelles pendant l'édition)

    // Boutons d'action
        this.container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;

            switch (action) {
                case 'close':
                    this.close();
                    break;
                case 'save':
                    this.saveMidiFile();
                    break;
                case 'save-as':
                    this.showSaveAsDialog();
                    break;
                case 'auto-assign':
                    this.showAutoAssignModal();
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

    // Nouveaux boutons d'édition
                case 'undo':
                    this.undo();
                    break;
                case 'redo':
                    this.redo();
                    break;
                case 'copy':
                    this.copy();
                    break;
                case 'paste':
                    this.paste();
                    break;
                case 'delete':
                    this.deleteSelectedNotes();
                    break;
                case 'select-all':
                    this.selectAll();
                    break;
                case 'change-channel':
                    this.changeChannel();
                    break;
                case 'apply-instrument':
                    this.applyInstrument();
                    break;
                case 'cycle-snap':
                    this.cycleSnap();
                    break;
                case 'rename-file':
                    this.showRenameDialog();
                    break;
                case 'toggle-settings-popover':
                    this.toggleSettingsPopover();
                    break;
                case 'toggle-preview-source':
                    this.togglePreviewSource();
                    break;
    // configure-string-instrument removed — config is in instrument settings

    // Playback controls
                case 'playback-play':
                    this.playbackPlay();
                    break;
                case 'playback-pause':
                    this.playbackPause();
                    break;
                case 'playback-stop':
                    this.playbackStop();
                    break;

    // Modes d'édition
                case 'mode-select':
                case 'mode-drag-notes':
                case 'mode-drag-view':
                case 'mode-add-note':
                case 'mode-resize-note':
                case 'mode-edit': {
                    const mode = btn.dataset.mode;
                    if (mode) {
                        this.setEditMode(mode);
                    }
                    break;
                }
            }
        });

    // Channel settings popover outside-click is now handled by a global
    // document listener attached/removed in _toggleChannelSettingsPopover /
    // _closeChannelSettingsPopover — no capture-phase container listener needed.

    // OPTIMISATION: Event delegation pour tous les boutons de canal
    // Remplace 4 boucles forEach × 16 boutons = ~64 listeners par 1 seul listener
        this.container.addEventListener('click', (e) => {
            const channelChip = e.target.closest('.channel-chip');
            if (channelChip) {
                e.preventDefault();
                e.stopPropagation();
    // Block channel toggle when a specialized editor is active
                if (this._isSpecializedEditorActive()) {
                    this.showNotification(this.t('midiEditor.closeEditorFirst') || 'Close the specialized editor first', 'info');
                    return;
                }
                const channel = parseInt(channelChip.dataset.channel);
                if (!isNaN(channel)) this.toggleChannel(channel);
                return;
            }
            const settingsBtn = e.target.closest('.chip-settings-btn');
            if (settingsBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(settingsBtn.dataset.channel);
                if (!isNaN(channel)) this._toggleChannelSettingsPopover(channel, settingsBtn);
                return;
            }
    // Global "Show All" button
            const showAllBtn = e.target.closest('.btn-show-all-channels');
            if (showAllBtn) {
                e.preventDefault();
                e.stopPropagation();
    // Block "Show All" when a specialized editor is active
                if (this._isSpecializedEditorActive()) {
                    this.showNotification(this.t('midiEditor.closeEditorFirst') || 'Close the specialized editor first', 'info');
                    return;
                }
                const previousActiveChannels = new Set(this.activeChannels);
                this.channels.forEach(ch => {
                    this.activeChannels.add(ch.channel);
                    this.channelDisabled.delete(ch.channel);
                });
                this.updateSequenceFromActiveChannels(previousActiveChannels);
                this.updateChannelButtons();
                this.updateInstrumentSelector();
                this.syncMutedChannels();
                return;
            }
            const tabBtn = e.target.closest('.channel-tab-btn');
            if (tabBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(tabBtn.dataset.channel);
                if (!isNaN(channel)) this._openTablatureForChannel(channel);
                return;
            }
            const drumBtn = e.target.closest('.channel-drum-btn');
            if (drumBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(drumBtn.dataset.channel);
                if (!isNaN(channel)) this._openDrumPatternForChannel(channel);
                return;
            }
            const windBtn = e.target.closest('.channel-wind-btn');
            if (windBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(windBtn.dataset.channel);
                if (!isNaN(channel)) this._openWindEditorForChannel(channel);
                return;
            }
            const editBtn = e.target.closest('.channel-edit-btn');
            if (editBtn) {
                e.preventDefault();
                e.stopPropagation();
                const channel = parseInt(editBtn.dataset.channel);
                if (!isNaN(channel)) this._openPianoRollForChannel(channel);
                return;
            }
        });

    // Double-click on channel chip = Solo (hide all others)
        this.container.addEventListener('dblclick', (e) => {
            const channelChip = e.target.closest('.channel-chip');
            if (channelChip) {
                e.preventDefault();
                e.stopPropagation();
    // Block solo when a specialized editor is active
                if (this._isSpecializedEditorActive()) return;
                const channel = parseInt(channelChip.dataset.channel);
                if (!isNaN(channel)) {
                    const previousActiveChannels = new Set(this.activeChannels);
                    this.activeChannels.clear();
                    this.activeChannels.add(channel);
                    this.channels.forEach(ch => {
                        if (ch.channel === channel) {
                            this.channelDisabled.delete(ch.channel);
                        } else {
                            this.channelDisabled.add(ch.channel);
                        }
                    });
                    this.updateSequenceFromActiveChannels(previousActiveChannels);
                    this.updateChannelButtons();
                    this.updateInstrumentSelector();
                    this.syncMutedChannels();
                }
                return;
            }
        });

    // Toggle preview source (GM / Routé)
        const previewToggle = document.getElementById('preview-source-toggle');
        if (previewToggle) {
            previewToggle.addEventListener('click', () => this.togglePreviewSource());
        }

    // Toggle playable notes global
        const playableToggle = document.getElementById('playable-notes-toggle');
        if (playableToggle) {
            playableToggle.addEventListener('click', () => this.togglePlayableNotesGlobal());
        }

    // Toggle touch mode
        const touchModeToggle = document.getElementById('touch-mode-toggle');
        if (touchModeToggle) {
            touchModeToggle.addEventListener('click', () => this.toggleTouchMode());
        }

    // Toggle keyboard playback
        const kbPlaybackToggle = document.getElementById('keyboard-playback-toggle');
        if (kbPlaybackToggle) {
            kbPlaybackToggle.addEventListener('click', () => this.toggleKeyboardPlayback());
        }

    // Toggle drag playback
        const dragPlaybackToggle = document.getElementById('drag-playback-toggle');
        if (dragPlaybackToggle) {
            dragPlaybackToggle.addEventListener('click', () => this.toggleDragPlayback());
        }

    // Input de tempo
        const tempoInput = document.getElementById('tempo-input');
        if (tempoInput) {
            tempoInput.addEventListener('change', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
                    this.setTempo(newTempo);
                } else {
    // Restaurer la valeur précédente si invalide
                    e.target.value = this.tempo || 120;
                }
            });
    // Aussi gérer le changement pendant la saisie (input event)
            tempoInput.addEventListener('input', (e) => {
                const newTempo = parseInt(e.target.value);
                if (!isNaN(newTempo) && newTempo >= 20 && newTempo <= 300) {
    // Mise à jour en temps réel (optionnel, peut être retiré si trop de mises à jour)
                    this.setTempo(newTempo);
                }
            });
        }

    // Header de la section CC (collapse/expand) — uniquement sur le titre, pas les onglets canal
        const ccSectionHeader = document.getElementById('cc-section-header');
        if (ccSectionHeader) {
            const ccTitle = ccSectionHeader.querySelector('.cc-section-title');
            if (ccTitle) {
                ccTitle.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.toggleCCSection();
                });
            }
    // Bouton engrenage pour réglages de dessin CC
            const ccDrawSettingsBtn = ccSectionHeader.querySelector('#cc-draw-settings-btn');
            if (ccDrawSettingsBtn) {
                ccDrawSettingsBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleDrawSettingsPopover();
                });
            }
        }

    // Boutons de type CC (horizontaux)
    // OPTIMISATION: Event delegation pour boutons CC type, outils et suppression
    // Remplace ~20+ listeners individuels par 1 seul listener délégué
        this.container.addEventListener('click', (e) => {
            const ccTypeBtn = e.target.closest('.cc-type-btn');
            if (ccTypeBtn) {
                e.preventDefault();
                const ccType = ccTypeBtn.dataset.ccType;
                if (ccType) this.selectCCType(ccType);
                return;
            }
            const ccToolBtn = e.target.closest('.cc-tool-btn');
            if (ccToolBtn) {
                e.preventDefault();
                const tool = ccToolBtn.dataset.tool;
                if (tool) {
                    this.container.querySelectorAll('.cc-tool-btn').forEach(b => b.classList.remove('active'));
                    ccToolBtn.classList.add('active');
                    if (this.currentCCType === 'tempo' && this.tempoEditor) {
                        this.tempoEditor.setTool(tool);
                    } else if (this.currentCCType === 'velocity' && this.velocityEditor) {
                        this.velocityEditor.setTool(tool);
                    } else if (this.ccEditor) {
                        this.ccEditor.setTool(tool);
                    }
                }
                return;
            }
            if (e.target.closest('#cc-delete-btn')) {
                e.preventDefault();
                this.deleteSelectedCCVelocity();
                return;
            }
        });

    // Bouton + pour ouvrir le CC picker
        const ccAddBtn = document.getElementById('cc-add-btn');
        if (ccAddBtn) {
            ccAddBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openCCPicker();
            });
        }

    // Les event listeners pour les boutons de canal sont attachés
    // dans attachEditorChannelListeners() appelé depuis updateEditorChannelSelector()
    // pour éviter les conflits lors de la mise à jour dynamique des canaux


    // Sélecteur d'instrument pour nouveaux canaux
        const instrumentSelector = document.getElementById('instrument-selector');
        if (instrumentSelector) {
            instrumentSelector.addEventListener('change', (e) => {
                this.selectedInstrument = parseInt(e.target.value);
                this.log('info', `Selected instrument changed to: ${this.getInstrumentName(this.selectedInstrument)} (${this.selectedInstrument})`);
            });
        }

    // Barre de drag pour redimensionner la section CC/Velocity
        const resizeBar = document.getElementById('cc-resize-btn');
        const notesSection = this.container.querySelector('.notes-section');
        const ccSection = document.getElementById('cc-section');

        if (resizeBar && notesSection && ccSection) {
            this.log('info', 'Resize bar found, attaching drag events');

    // Log quand on survole la barre pour vérifier qu'elle est accessible
            resizeBar.addEventListener('mouseenter', () => {
                this.log('debug', 'Mouse entered resize bar');
            });

            let isResizing = false;
            let startY = 0;
            let startNotesHeight = 0;
            let availableHeight = 0;  // Espace disponible réel pour le resize
            let startNotesFlex = 3;
            let startCCFlex = 2;

            const startResize = (e) => {
                e.preventDefault();

                this.log('info', '=== RESIZE MOUSEDOWN DETECTED ===');

    // Ne permettre le resize que si la section CC est expanded
                if (!this.ccSectionExpanded || !ccSection.classList.contains('expanded')) {
                    this.log('warn', 'Resize blocked: CC section not expanded');
                    return;
                }

                isResizing = true;
                startY = e.clientY;
                startNotesHeight = notesSection.clientHeight;

    // Capturer l'espace disponible RÉEL depuis modal-dialog (hauteur fixe 95vh)
                const modalDialog = this.container.querySelector('.modal-dialog');  // ENFANT, pas parent !
                const modalHeader = this.container.querySelector('.modal-header');
                const toolbarHeight = this.container.querySelector('.editor-toolbar')?.clientHeight || 0;
                const channelsToolbarHeight = this.container.querySelector('.channels-toolbar')?.clientHeight || 0;

                const modalDialogHeight = modalDialog?.clientHeight || 0;
                const modalHeaderHeight = modalHeader?.clientHeight || 0;

    // Espace disponible = hauteur totale du dialog - header - toolbars
                availableHeight = modalDialogHeight - modalHeaderHeight - toolbarHeight - channelsToolbarHeight;

                this.log('info', `Resize: modalDialog=${modalDialogHeight}px, modalHeader=${modalHeaderHeight}px, toolbars=${toolbarHeight + channelsToolbarHeight}px, available=${availableHeight}px`);

    // Obtenir les flex-grow actuels
                const notesStyle = window.getComputedStyle(notesSection);
                const ccStyle = window.getComputedStyle(ccSection);
                startNotesFlex = parseFloat(notesStyle.flexGrow) || 3;
                startCCFlex = parseFloat(ccStyle.flexGrow) || 2;

                this.log('info', `Initial flex: notes=${startNotesFlex}, cc=${startCCFlex}`);

    // Désactiver les transitions pendant le resize pour éviter les animations
                notesSection.style.transition = 'none';
                ccSection.style.transition = 'none';

    // Désactiver les min-height CSS qui bloquent le resize à ~50%
                notesSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('min-height', '0px', 'important');

    // Empêcher le contenu de déborder au-dessus de la section CC
                notesSection.style.setProperty('overflow', 'hidden', 'important');

                document.body.style.cursor = 'ns-resize';
                resizeBar.classList.add('dragging');
            };

            const doResize = (e) => {
                if (!isResizing) return;

                const deltaY = e.clientY - startY;
                const resizeBarHeight = 12; // Hauteur de la barre

    // Utiliser l'espace disponible RÉEL capturé au début
                const totalFlexHeight = availableHeight - resizeBarHeight;

    // Contraintes très assouplies: notes min 20px (permet à CC d'atteindre ~98%), cc min 100px
                const minNotesHeight = 20;
                const minCCHeight = 100;
                const newNotesHeight = Math.max(minNotesHeight, Math.min(totalFlexHeight - minCCHeight, startNotesHeight + deltaY));
                const newCCHeight = totalFlexHeight - newNotesHeight;

                this.log('debug', `Resize: deltaY=${deltaY}, availableH=${availableHeight}px, notesH=${newNotesHeight}px, ccH=${newCCHeight}px`);

    // Appliquer les hauteurs directement en pixels
    // Désactiver les min-height CSS qui bloquent le resize
                notesSection.style.setProperty('min-height', '0px', 'important');
                notesSection.style.setProperty('height', `${newNotesHeight}px`, 'important');
                notesSection.style.setProperty('flex', 'none', 'important');

                ccSection.style.setProperty('min-height', '0px', 'important');
                ccSection.style.setProperty('height', `${newCCHeight}px`, 'important');
                ccSection.style.setProperty('flex', 'none', 'important');

    // Vérifier si les styles sont réellement appliqués
                const actualNotesHeight = notesSection.clientHeight;
                const actualCCHeight = ccSection.clientHeight;
                this.log('debug', `Applied styles - Expected: notes=${newNotesHeight}px cc=${newCCHeight}px, Actual: notes=${actualNotesHeight}px cc=${actualCCHeight}px`);

    // Redimensionner les éditeurs pendant le drag pour que la grille soit visible
                requestAnimationFrame(() => {
    // SOLUTION 2.2: Forcer recalcul de TOUTE la cascade flex (5 niveaux)
                    void ccSection.offsetHeight;
                    const ccContent = ccSection.querySelector('.cc-section-content');
                    const ccLayout = ccSection.querySelector('.cc-editor-layout');
                    const ccMain = ccSection.querySelector('.cc-editor-main');
                    void ccContent?.offsetHeight;
                    void ccLayout?.offsetHeight;
                    void ccMain?.offsetHeight;

                    if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                        this.pianoRoll.redraw();
                        this.log('debug', 'Piano roll redraw called');
                    }

                    if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
    // SOLUTION 2.1: Corriger le bug du sélecteur (.cc-pitchbend-editor, pas -container)
                        const ccContainer = ccSection.querySelector('.cc-pitchbend-editor');
                        const ccHeight = ccContainer?.clientHeight || 0;
                        this.log('debug', `CC editor resize called - container height: ${ccHeight}px`);

    // Premier appel resize
                        this.ccEditor.resize();

    // SOLUTION 2.3: Double appel après 2 frames pour stabilisation layout
                        setTimeout(() => {
                            if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
                                this.ccEditor.resize();
                                this.log('debug', 'CC editor re-resize after layout stabilization');
                            }
                        }, 32);
                    }

                    if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                        this.velocityEditor.resize();
                        this.log('debug', 'Velocity editor resize called');

    // Double appel pour velocity editor aussi
                        setTimeout(() => {
                            if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                                this.velocityEditor.resize();
                            }
                        }, 32);
                    }
                });

                e.preventDefault();
            };

            const stopResize = () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = '';
                    resizeBar.classList.remove('dragging');

    // Réactiver les transitions
                    notesSection.style.transition = '';
                    ccSection.style.transition = '';

    // GARDER overflow: hidden pour que le slider reste au-dessus
    // Ne pas réinitialiser: notesSection.style.overflow = '';

    // Redimensionner les éditeurs après le resize
                    requestAnimationFrame(() => {
                        if (this.pianoRoll && typeof this.pianoRoll.redraw === 'function') {
                            this.pianoRoll.redraw();
                        }

                        if (this.ccEditor && typeof this.ccEditor.resize === 'function') {
                            this.ccEditor.resize();
                        }

                        if (this.velocityEditor && typeof this.velocityEditor.resize === 'function') {
                            this.velocityEditor.resize();
                        }
                    });
                }
            };

            resizeBar.addEventListener('mousedown', startResize);
    // Stocker les refs pour cleanup dans doClose()
            this._resizeDoResize = doResize;
            this._resizeStopResize = stopResize;
            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
        }
    }

    /**
    * Recharger le piano roll avec la séquence actuelle
    */
    MidiEditorEventsMixin.reloadPianoRoll = function() {
        if (!this.pianoRoll) {
            this.log('warn', 'Cannot reload piano roll: not initialized');
            return;
        }

        this.log('info', `Reloading piano roll with ${this.sequence.length} notes`);

    // Calculer la plage de ticks depuis la séquence
        let maxTick = 0;
        let minNote = 127;
        let maxNote = 0;

        if (this.sequence && this.sequence.length > 0) {
            this.sequence.forEach(note => {
                const endTick = note.t + note.g;
                if (endTick > maxTick) maxTick = endTick;
                if (note.n < minNote) minNote = note.n;
                if (note.n > maxNote) maxNote = note.n;
            });
        }

    // Mettre à jour les attributs du piano roll
        const xrange = Math.max(128, Math.ceil(maxTick / 128) * 128);
        const noteRange = Math.max(36, maxNote - minNote + 12);

        this.pianoRoll.setAttribute('xrange', xrange.toString());
        this.pianoRoll.setAttribute('yrange', noteRange.toString());

    // Recharger la séquence
        this.pianoRoll.sequence = this.sequence;

    // S'assurer que les couleurs sont toujours définies
        this.pianoRoll.channelColors = this.channelColors;

    // Forcer le redraw
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }

    // Mettre à jour les stats
        this.updateStats();

        this.log('info', `Piano roll reloaded: ${this.sequence.length} notes, xrange=${xrange}, yrange=${noteRange}`);
    }

    /**
    * Zoom horizontal
    */
    MidiEditorEventsMixin.zoomHorizontal = function(factor) {
    // Dispatch to specialized editor if active
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer && typeof specializedRenderer.setZoom === 'function') {
            const currentTPP = specializedRenderer.ticksPerPixel || 2;
    // factor < 1 = zoom in (reduce ticksPerPixel), factor > 1 = zoom out
            specializedRenderer.setZoom(currentTPP * factor);
            this.syncAllEditors();
            return;
        }

        if (!this.pianoRoll) {
            this.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

    // Essayer d'accéder à la propriété directement
        const currentRange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;
        const newRange = Math.max(16, Math.min(100000, Math.round(currentRange * factor)));

    // Essayer les deux méthodes
        this.pianoRoll.setAttribute('xrange', newRange.toString());
        if (this.pianoRoll.xrange !== undefined) {
            this.pianoRoll.xrange = newRange;
        }

    // Forcer le redraw avec un court délai, puis synchroniser les éditeurs
        setTimeout(() => {
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
            this.syncAllEditors();
        }, 50);

        this.log('info', `Horizontal zoom: ${currentRange} -> ${newRange}`);
    }

    /**
    * Zoom vertical
    */
    MidiEditorEventsMixin.zoomVertical = function(factor) {
    // Dispatch to specialized editor if active
        const specializedRenderer = this._getActiveSpecializedRenderer();
        if (specializedRenderer && typeof specializedRenderer.setVerticalZoom === 'function') {
            specializedRenderer.setVerticalZoom(factor);
            this.syncAllEditors();
            return;
        }

        if (!this.pianoRoll) {
            this.log('warn', 'Cannot zoom: piano roll not initialized');
            return;
        }

    // Essayer d'accéder à la propriété directement
        const currentRange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;
        const newRange = Math.max(12, Math.min(88, Math.round(currentRange * factor)));

    // Essayer les deux méthodes
        this.pianoRoll.setAttribute('yrange', newRange.toString());
        if (this.pianoRoll.yrange !== undefined) {
            this.pianoRoll.yrange = newRange;
        }

    // Forcer le redraw avec un court délai
        setTimeout(() => {
            if (typeof this.pianoRoll.redraw === 'function') {
                this.pianoRoll.redraw();
            }
        }, 50);

        this.log('info', `Vertical zoom: ${currentRange} -> ${newRange}`);
    }

    /**
    * Initialiser la barre de navigation overview
    */
    MidiEditorEventsMixin._initNavigationOverview = function(maxTick, xrange) {
        const overviewContainer = this.container?.querySelector('#navigation-overview-container');
        if (!overviewContainer || typeof NavigationOverviewBar === 'undefined') return;

    // Clean up previous instance
        if (this.navigationBar) {
            this.navigationBar.destroy();
            this.navigationBar = null;
        }

        this.navigationBar = new NavigationOverviewBar(overviewContainer, {
            height: 20,
            onNavigate: (percentage) => {
                this.scrollHorizontal(percentage);
            },
            onZoom: (factor) => {
                this.zoomHorizontal(factor);
            }
        });

        this.navigationBar.setViewport(0, xrange, maxTick);
        this.log('info', `Navigation overview bar initialized: maxTick=${maxTick}, xrange=${xrange}`);
    }

    /**
    * Synchroniser la barre de navigation overview avec le piano roll
    */
    MidiEditorEventsMixin.setupScrollSynchronization = function() {
        if (!this.pianoRoll) return;

        let syncScheduled = false;

        const onViewportChange = (e) => {
            if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) return;

            const { xoffset, xrange } = e.detail;

            // Update navigation overview bar
            const maxTick = this.midiData?.maxTick || 0;
            this.navigationBar?.setViewport(xoffset, xrange, maxTick);

            if (!syncScheduled) {
                syncScheduled = true;
                requestAnimationFrame(() => {
                    this.syncAllEditors();
                    syncScheduled = false;
                });
            }
        };

        this.pianoRoll.addEventListener('viewportchange', onViewportChange);
        // Store reference for cleanup
        this._viewportChangeHandler = onViewportChange;
    }


    /**
    * Défilement horizontal (0-100%)
    */
    MidiEditorEventsMixin.scrollHorizontal = function(percentage) {
    // Calculer l'offset en fonction de la plage totale du fichier MIDI
        const maxTick = this.midiData?.maxTick || 0;

        if (this.pianoRoll) {
            const xrange = this.pianoRoll.xrange || parseInt(this.pianoRoll.getAttribute('xrange')) || 128;
            const maxOffset = Math.max(0, maxTick - xrange);
            const newOffset = Math.round((percentage / 100) * maxOffset);

            this.pianoRoll.xoffset = newOffset;
            this.pianoRoll.setAttribute('xoffset', newOffset.toString());

    // Ne pas redraw le piano roll s'il est caché (wind editor actif)
            if (typeof this.pianoRoll.redraw === 'function' &&
                !(this.windInstrumentEditor && this.windInstrumentEditor.isVisible)) {
                this.pianoRoll.redraw();
            }
        }

    // Synchroniser la tablature
        if (this.tablatureEditor && this.tablatureEditor.isVisible && this.tablatureEditor.renderer) {
            const renderer = this.tablatureEditor.renderer;
            const canvasWidth = this.tablatureEditor.tabCanvasEl?.width || 800;
            const visibleTicks = (canvasWidth - renderer.headerWidth) * renderer.ticksPerPixel;
            const maxOffset = Math.max(0, maxTick - visibleTicks);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setScrollX(newOffset);
        }

    // Synchroniser l'éditeur drum
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible && this.drumPatternEditor.gridRenderer) {
            const renderer = this.drumPatternEditor.gridRenderer;
            const canvasWidth = this.drumPatternEditor.gridCanvasEl?.width || 800;
            const visibleTicks = (canvasWidth - (renderer.headerWidth || 0)) * (renderer.ticksPerPixel || 2);
            const maxOffset = Math.max(0, maxTick - visibleTicks);
            const newOffset = Math.round((percentage / 100) * maxOffset);
            renderer.setScrollX(newOffset);
        }

    // Synchroniser l'éditeur vent
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
            this.windInstrumentEditor.scrollHorizontal(percentage);
        }

    // Synchroniser l'éditeur CC
        this.syncCCEditor();
    }

    /**
    * Défilement vertical (0-100%)
    */
    MidiEditorEventsMixin.scrollVertical = function(percentage) {
        if (this.pianoRoll) {
            const yrange = this.pianoRoll.yrange || parseInt(this.pianoRoll.getAttribute('yrange')) || 36;

    // Plage complète MIDI: 0-127 notes
            const totalMidiRange = 128;
            const maxOffset = Math.max(0, totalMidiRange - yrange);
            const newOffset = Math.round((percentage / 100) * maxOffset);

            this.pianoRoll.yoffset = newOffset;
            this.pianoRoll.setAttribute('yoffset', newOffset.toString());

    // Ne pas redraw le piano roll s'il est caché (wind editor actif)
            if (typeof this.pianoRoll.redraw === 'function' &&
                !(this.windInstrumentEditor && this.windInstrumentEditor.isVisible)) {
                this.pianoRoll.redraw();
            }
        }

    // Synchroniser l'éditeur vent
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
            this.windInstrumentEditor.scrollVertical(percentage);
        }
    }



    // === METHODS RESTORED FROM PLAYBACK SECTION ===

    /**
     * Apply clean, modern colors to the piano roll based on the current theme.
     */
    MidiEditorEventsMixin._applyPianoRollTheme = function() {
        if (!this.pianoRoll) return;

        const isDark = document.body.classList.contains('dark-mode');

        if (isDark) {
            this.pianoRoll.setAttribute('collt', '#262830');
            this.pianoRoll.setAttribute('coldk', '#22242a');
            this.pianoRoll.setAttribute('colgrid', '#2e3038');
            this.pianoRoll.setAttribute('colrulerbg', '#1e2028');
            this.pianoRoll.setAttribute('colrulerfg', '#8890a0');
            this.pianoRoll.setAttribute('colrulerborder', '#2e3038');
            this.pianoRoll.setAttribute('colnoteborder', 'rgba(255,255,255,0.1)');
        } else {
            this.pianoRoll.setAttribute('collt', '#ddd6f3');
            this.pianoRoll.setAttribute('coldk', '#d2cae8');
            this.pianoRoll.setAttribute('colgrid', '#c8c0de');
            this.pianoRoll.setAttribute('colrulerbg', '#d5cdef');
            this.pianoRoll.setAttribute('colrulerfg', '#4a3f6b');
            this.pianoRoll.setAttribute('colrulerborder', '#c0b8d8');
            this.pianoRoll.setAttribute('colnoteborder', 'rgba(102,126,234,0.25)');
        }
    }

    /**
     * Ouvrir/fermer le popover de parametres (Canal, Instrument, Device)
     */
    MidiEditorEventsMixin.toggleSettingsPopover = function() {
        const popover = this.container.querySelector('#settings-popover');
        if (!popover) return;
        const isVisible = popover.style.display !== 'none';
        popover.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
            const closeHandler = (e) => {
                if (!popover.contains(e.target) &&
                    !e.target.closest('[data-action="toggle-settings-popover"]')) {
                    popover.style.display = 'none';
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        }
    }

    /**
     * Initialize the PlaybackTimelineBar for the piano editor.
     */
    MidiEditorEventsMixin._initTimelineBar = function(maxTick, ticksPerBeat, xrange) {
        const timelineContainer = this.container?.querySelector('#playback-timeline-container');
        if (!timelineContainer || typeof PlaybackTimelineBar === 'undefined') return;

        if (this.timelineBar) {
            this.timelineBar.destroy();
            this.timelineBar = null;
        }

        const pianoLeftOffset = this._getActiveEditorHeaderWidth();

        this.timelineBar = new PlaybackTimelineBar(timelineContainer, {
            ticksPerBeat: ticksPerBeat,
            beatsPerMeasure: 4,
            leftOffset: pianoLeftOffset,
            height: 30,
            onSeek: (tick) => {
                const rangeStart = this.timelineBar.rangeStart || 0;
                const rangeEnd = this.timelineBar.rangeEnd || (this.midiData?.maxTick || 0);
                const clampedTick = Math.max(rangeStart, Math.min(tick, rangeEnd));
                if (this.pianoRoll) this.pianoRoll.cursor = clampedTick;
                if (this.synthesizer && typeof this.synthesizer.seek === 'function') this.synthesizer.seek(clampedTick);
                if (this.timelineBar) this.timelineBar.setPlayhead(clampedTick);
                if (this.tablatureEditor && this.tablatureEditor.isVisible) this.tablatureEditor.updatePlayhead(clampedTick);
                if (this.drumPatternEditor && this.drumPatternEditor.isVisible) this.drumPatternEditor.updatePlayhead(clampedTick);
                if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) this.windInstrumentEditor.updatePlayhead(clampedTick);
                this.log('debug', `Timeline seek to tick ${clampedTick}`);
            },
            onPan: (newScrollX) => {
                if (this.pianoRoll) {
                    this.pianoRoll.xoffset = newScrollX;
                    if (typeof this.pianoRoll.redraw === 'function' &&
                        !(this.windInstrumentEditor && this.windInstrumentEditor.isVisible)) {
                        this.pianoRoll.redraw();
                    }
                }
                const maxTick2 = this.midiData?.maxTick || 0;
                const xrange2 = this.pianoRoll?.xrange || 1920;
                this.navigationBar?.setViewport(newScrollX, xrange2, maxTick2);
                if (this.tablatureEditor && this.tablatureEditor.isVisible && this.tablatureEditor.renderer) this.tablatureEditor.renderer.setScrollX(newScrollX);
                if (this.drumPatternEditor && this.drumPatternEditor.isVisible && this.drumPatternEditor.gridRenderer) this.drumPatternEditor.gridRenderer.setScrollX(newScrollX);
                if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible && this.windInstrumentEditor.renderer) this.windInstrumentEditor.renderer.setScrollX(newScrollX);
                this.syncCCEditor();
                this.syncVelocityEditor();
                this.syncTempoEditor();
            },
            onRangeChange: (start, end) => {
                if (this.pianoRoll) {
                    this.pianoRoll.setAttribute('markstart', start.toString());
                    this.pianoRoll.setAttribute('markend', end.toString());
                }
                this.playbackStartTick = start;
                this.playbackEndTick = end;
                if (this.synthesizer) {
                    const currentTick = this.synthesizer.currentTick || 0;
                    this.synthesizer.startTick = Math.max(0, start);
                    this.synthesizer.endTick = end;
                    if (currentTick < start || currentTick > end) this.synthesizer.currentTick = start;
                }
                if (this.timelineBar) {
                    const playhead = this.timelineBar.playheadTick;
                    if (playhead < start) { this.timelineBar.setPlayhead(start); if (this.pianoRoll) this.pianoRoll.cursor = start; }
                    else if (playhead > end) { this.timelineBar.setPlayhead(end); if (this.pianoRoll) this.pianoRoll.cursor = end; }
                }
                this.log('debug', `Timeline range changed: ${start} - ${end}`);
            },
        });

        this.timelineBar.setTotalTicks(maxTick);
        this.timelineBar.setRange(0, maxTick);
        this.timelineBar.setZoom(xrange / ((timelineContainer.clientWidth || 800) - pianoLeftOffset));
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorEventsMixin = MidiEditorEventsMixin;
    }
})();
