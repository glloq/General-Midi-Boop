// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorCCPicker.js
// Description: CC picker modal
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
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
    // Fermer si déjà ouvert
        let existing = this.container?.querySelector('#cc-picker-modal');
        if (existing) {
            existing.remove();
            return;
        }

        const addBtn = this.container?.querySelector('#cc-add-btn');
        if (!addBtn) return;

    // Déterminer quels CC sont déjà visibles (ont des données ou sont des boutons statiques)
        const allUsedTypes = this.getAllUsedCCTypes();
        const staticCCNums = new Set([1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]);

    // Construire le contenu HTML du picker par catégories
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

    // Utiliser le premier canal actif comme canal pour l'édition CC
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

    // Mettre à jour l'état du bouton de suppression
        this.updateDeleteButtonState();
    }

    /**
    * Mettre à jour l'état du bouton de suppression
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

    // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: () => {
    // Marquer comme modifié lors des changements CC/Pitchbend
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

    // Créer l'éditeur
        this.ccEditor = new CCPitchbendEditor(container, options);
        this.ccEditor.setCC(this.currentCCType);

    // Charger les événements existants AVANT de mettre à jour le sélecteur
        if (this.ccEvents.length > 0) {
            this.ccEditor.loadEvents(this.ccEvents);
            this.log('info', `Loaded ${this.ccEvents.length} CC events into editor`);
        }

    // Mettre à jour le sélecteur de canal pour afficher uniquement les canaux utilisés
        this.updateCCChannelSelector();

    // Obtenir le canal actif (premier canal du fichier, ou premier canal avec CC, ou 0)
        const fileChannels = this.channels.map(ch => ch.channel).sort((a, b) => a - b);
        const usedChannels = this.getCCChannelsUsed();
        const activeChannel = fileChannels.length > 0 ? fileChannels[0] : (usedChannels.length > 0 ? usedChannels[0] : 0);
        this.ccEditor.setChannel(activeChannel);

    // Auto-sélectionner un CC type qui a des données sur ce canal
        this.selectBestCCTypeForChannel(activeChannel);

        this.highlightUsedCCButtons();

        this.log('info', `CC Editor initialized - Type: ${this.currentCCType}, Channel: ${activeChannel + 1}, File channels: [${fileChannels.map(c => c + 1).join(', ')}]`);

    // Ajouter un écouteur pour mettre à jour le bouton de suppression lors des interactions
        container.addEventListener('mouseup', () => {
    // Utiliser setTimeout pour laisser la sélection se mettre à jour d'abord
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

    // Attendre que le layout flex soit complètement calculé avant de resize
    // Utiliser requestAnimationFrame en boucle jusqu'à ce que l'élément ait une hauteur valide
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
    // Le layout est prêt, on peut resize
            this.ccEditor.resize();
    // Resume rendering for the active sub-editor
            if (typeof this.ccEditor.resume === 'function') this.ccEditor.resume();
            if (this.velocityEditor && typeof this.velocityEditor.resume === 'function') this.velocityEditor.resume();
            if (this.tempoEditor && typeof this.tempoEditor.resume === 'function') this.tempoEditor.resume();
            this.log('info', `CC Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Le layout n'est pas encore prêt, réessayer au prochain frame
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
        if (!this.ccEditor || !this.pianoRoll) return;

        this.ccEditor.syncWith({
            xrange: this.pianoRoll.xrange,
            xoffset: this.pianoRoll.xoffset,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            timebase: this.pianoRoll.timebase
        });
    }

    /**
    * Synchroniser tous les éditeurs (CC et Velocity) avec le piano roll
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

    // Sync PlaybackTimelineBar with active editor scroll/zoom
        if (this.timelineBar && this.pianoRoll) {
            const xoffset = this.pianoRoll.xoffset || 0;
            const xrange = this.pianoRoll.xrange || 1920;
            const containerWidth = this.container?.querySelector('#playback-timeline-container')?.clientWidth || 800;
            const activeLeftOffset = this._getActiveEditorHeaderWidth();
            this.timelineBar.setLeftOffset(activeLeftOffset);
            this.timelineBar.setScrollX(xoffset);
            this.timelineBar.setZoom(xrange / Math.max(1, containerWidth - activeLeftOffset));
        }
    }

    /**
    * Synchroniser les événements depuis l'éditeur CC vers this.ccEvents
    * Appelé avant la sauvegarde pour récupérer les modifications
    */
    MidiEditorCCPickerMixin.syncCCEventsFromEditor = function() {
        if (!this.ccEditor) {
    // Si l'éditeur CC n'a jamais été ouvert, garder les événements extraits du fichier original
            this.log('info', `syncCCEventsFromEditor: CC editor not initialized, keeping ${this.ccEvents.length} original events`);
            return;
        }

    // Récupérer tous les événements depuis l'éditeur
        const editorEvents = this.ccEditor.getEvents();

        if (!editorEvents || editorEvents.length === 0) {
            this.log('info', 'syncCCEventsFromEditor: No CC events in editor');
            this.ccEvents = [];
            return;
        }

    // Les événements de l'éditeur sont déjà au bon format
    // { type: 'cc1'|'cc7'|'cc10'|'cc11'|'pitchbend', ticks: number, value: number, channel: number }
        this.ccEvents = editorEvents.map(e => ({
            type: e.type,
            ticks: e.ticks,
            channel: e.channel,
            value: e.value,
            id: e.id
        }));

        this.log('info', `Synchronized ${this.ccEvents.length} CC/pitchbend events from editor`);

    // Log d'échantillon pour debugging
        if (this.ccEvents.length > 0) {
            const sample = this.ccEvents.slice(0, 3);
            this.log('debug', 'Sample synchronized events:', sample);
        }
    }

    /**
    * Synchroniser les événements de tempo depuis l'éditeur de tempo
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

    // Mettre à jour le tempo global avec le premier événement
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

    // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            onChange: (sequence) => {
    // Marquer comme modifié lors des changements de vélocité
                this.isDirty = true;
                this.updateSaveButton();
    // Synchroniser vers fullSequence et sequence
                this.syncSequenceFromVelocityEditor(sequence);
            }
        };

    // Créer l'éditeur
        this.velocityEditor = new VelocityEditor(container, options);

    // Charger la séquence complète (non filtrée) pour la vélocité
        this.velocityEditor.setSequence(this.fullSequence);

    // Définir le premier canal utilisé comme canal actif par défaut
        const firstChannel = this.channels.length > 0 ? this.channels[0].channel : 0;
        this.velocityEditor.setChannel(firstChannel);

        this.highlightUsedCCButtons();

        this.log('info', `Velocity Editor initialized with ${this.fullSequence.length} notes, default channel: ${firstChannel + 1}`);

    // Mettre à jour le sélecteur de canal
        this.updateEditorChannelSelector();

    // Ajouter un écouteur pour mettre à jour le bouton de suppression lors des interactions
        container.addEventListener('mouseup', () => {
    // Utiliser setTimeout pour laisser la sélection se mettre à jour d'abord
            setTimeout(() => this.updateDeleteButtonState(), 0);
        });

    // Attendre que le layout soit prêt
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
    // Le layout est prêt, on peut resize
            this.velocityEditor.resize();
            this.log('info', `Velocity Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Le layout n'est pas encore prêt, réessayer au prochain frame
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

    // Obtenir les paramètres du piano roll
        const options = {
            timebase: this.pianoRoll?.timebase || 480,
            xrange: this.pianoRoll?.xrange || 1920,
            xoffset: this.pianoRoll?.xoffset || 0,
            grid: this.snapValues[this.currentSnapIndex].ticks,
            minTempo: 20,
            maxTempo: 300,
            onChange: () => {
    // Marquer comme modifié lors des changements de tempo
                this.isDirty = true;
                this.updateSaveButton();
            }
        };

    // Créer l'éditeur
        this.tempoEditor = new TempoEditor(container, options);

    // Charger les événements de tempo existants
        this.tempoEditor.setEvents(this.tempoEvents);

        this.log('info', `Tempo Editor initialized with ${this.tempoEvents.length} events`);

    // Attendre que le layout soit prêt
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
    // Le layout est prêt, on peut resize
            this.tempoEditor.resize();
            this.log('info', `Tempo Editor layout ready after ${attempts} attempts (height=${height})`);
        } else if (attempts < maxAttempts) {
    // Le layout n'est pas encore prêt, réessayer au prochain frame
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
    // Créer les boutons s'ils n'existent pas (une seule fois)
        let curveSection = this.container.querySelector('.curve-section');
        if (!curveSection) {
    // Trouver la toolbar
            const toolbar = this.container.querySelector('.cc-type-toolbar');
            if (!toolbar) return;

    // Créer la section de boutons de courbes
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

    // Insérer avant le divider qui précède le bouton de suppression
            const deleteBtn = this.container.querySelector('#cc-delete-btn');
            if (deleteBtn && deleteBtn.previousElementSibling) {
                deleteBtn.previousElementSibling.insertAdjacentHTML('beforebegin', curveHTML);

    // Attacher les événements
                const ccCurveButtons = this.container.querySelectorAll('.cc-curve-btn');
                ccCurveButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const curveType = btn.dataset.curve;
                        if (curveType) {
    // Désactiver tous les boutons
                            ccCurveButtons.forEach(b => b.classList.remove('active'));
    // Activer le bouton cliqué
                            btn.classList.add('active');
    // Changer le type de courbe pour l'éditeur actif
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
    // Les boutons existent déjà, les afficher
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

    // Mettre à jour fullSequence et sequence avec les nouvelles vélocités
        this.fullSequence.forEach(note => {
            const velocityNote = velocitySequence.find(vn =>
                vn.t === note.t && vn.n === note.n && vn.c === note.c
            );
            if (velocityNote) {
                note.v = velocityNote.v || 100;
            }
        });

    // Reconstruire la sequence filtrée
        this.sequence = this.fullSequence.filter(note => this.activeChannels.has(note.c));

    // Mettre à jour le piano roll
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

    // Compter les notes par canal et préserver les programmes existants
        this.fullSequence.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            channelNoteCount.set(channel, (channelNoteCount.get(channel) || 0) + 1);

    // Trouver le programme pour ce canal (depuis this.channels existants)
            if (!channelPrograms.has(channel)) {
                const existingChannel = this.channels.find(ch => ch.channel === channel);
                if (existingChannel) {
                    channelPrograms.set(channel, existingChannel.program);
                } else {
    // Nouveau canal : utiliser l'instrument sélectionné
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

    // Trier par numéro de canal
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

    /**
    * Convertir la sequence en données MIDI pour le backend
    * Format compatible avec la bibliothèque 'midi-file'
    */
    MidiEditorCCPickerMixin.convertSequenceToMidi = function() {
    // Utiliser fullSequence qui contient toutes les notes à jour
        const fullSequenceToSave = this.fullSequence;

        if (!fullSequenceToSave || fullSequenceToSave.length === 0) {
            this.log('warn', 'No sequence to convert');
            return null;
        }

        const ticksPerBeat = this.midiData?.header?.ticksPerBeat || 480;

        this.log('info', `Converting ${fullSequenceToSave.length} notes to MIDI`);

    // Convertir la sequence en événements MIDI
        const events = [];

    // Ajouter les événements de tempo (tempo map complète ou tempo global)
        if (this.tempoEvents && this.tempoEvents.length > 0) {
            this.tempoEvents.forEach(tempoEvent => {
                const usPerBeat = Math.round(60000000 / tempoEvent.tempo);
                events.push({
                    absoluteTime: tempoEvent.ticks,
                    type: 'setTempo',
                    microsecondsPerBeat: usPerBeat
                });
            });
            this.log('debug', `Added ${this.tempoEvents.length} tempo events from tempo map`);
        } else {
    // Fallback: tempo global unique
            const tempo = this.tempo || 120;
            const microsecondsPerBeat = Math.round(60000000 / tempo);
            events.push({
                absoluteTime: 0,
                type: 'setTempo',
                microsecondsPerBeat: microsecondsPerBeat
            });
            this.log('debug', `Added single tempo event: ${tempo} BPM (${microsecondsPerBeat} μs/beat)`);
        }

    // Déterminer quels canaux sont utilisés et leurs instruments
        const usedChannels = new Map(); // canal -> program
        fullSequenceToSave.forEach(note => {
            const channel = note.c !== undefined ? note.c : 0;
            if (!usedChannels.has(channel)) {
    // Trouver l'instrument pour ce canal
                const channelInfo = this.channels.find(ch => ch.channel === channel);
                const program = channelInfo ? channelInfo.program : this.selectedInstrument || 0;
                usedChannels.set(channel, program);
            }
        });

    // Ajouter les événements programChange au début (tick 0) pour chaque canal
        usedChannels.forEach((program, channel) => {
            if (channel !== 9) { // Canal 10 (index 9) est pour drums, pas de programChange
                events.push({
                    absoluteTime: 0,
                    type: 'programChange',
                    channel: channel,
                    programNumber: program
                });
                this.log('debug', `Added programChange for channel ${channel}: ${this.getInstrumentName(program)}`);
            }
        });

    // Ajouter les événements de note
        fullSequenceToSave.forEach(note => {
            const tick = note.t;
            const noteNumber = note.n;
            const gate = note.g;
            const channel = note.c !== undefined ? note.c : 0;
            const velocity = note.v || 100; // velocity par défaut si non présente

    // Note On
            events.push({
                absoluteTime: tick,
                type: 'noteOn',
                channel: channel,
                noteNumber: noteNumber,
                velocity: velocity
            });

    // Note Off
            events.push({
                absoluteTime: tick + gate,
                type: 'noteOff',
                channel: channel,
                noteNumber: noteNumber,
                velocity: 0
            });
        });

    // Ajouter les événements CC et pitchbend
        if (this.ccEvents && this.ccEvents.length > 0) {
            this.log('info', `Adding ${this.ccEvents.length} CC/pitchbend events to MIDI file`);

            let ccCount = 0, pbCount = 0, atCount = 0;
            this.ccEvents.forEach(ccEvent => {
    // Convertir le type de l'éditeur (cc1, cc2, cc5, cc7, cc10, cc11, cc74) en numéro de contrôleur
                if (ccEvent.type.startsWith('cc')) {
    // Extraire le numéro du type (cc1 -> 1, cc7 -> 7, etc.)
                    const controllerNumber = parseInt(ccEvent.type.replace('cc', ''));
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'controller',
                        channel: ccEvent.channel,
                        controllerType: controllerNumber,
                        value: ccEvent.value
                    });
                    ccCount++;
                } else if (ccEvent.type === 'pitchbend') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'pitchBend',
                        channel: ccEvent.channel,
                        value: ccEvent.value
                    });
                    pbCount++;
                } else if (ccEvent.type === 'aftertouch') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'channelAftertouch',
                        channel: ccEvent.channel,
                        amount: ccEvent.value
                    });
                    atCount++;
                } else if (ccEvent.type === 'polyAftertouch') {
                    events.push({
                        absoluteTime: ccEvent.ticks || ccEvent.tick,
                        type: 'polyAftertouch',
                        channel: ccEvent.channel,
                        noteNumber: ccEvent.note || 0,
                        pressure: ccEvent.value
                    });
                    atCount++;
                }
            });

            this.log('info', `Converted to MIDI: ${ccCount} CC, ${pbCount} pitchbend, ${atCount} aftertouch events`);
        } else {
            this.log('warn', 'No CC/Pitchbend events to save');
        }

    // Trier par temps absolu
        events.sort((a, b) => a.absoluteTime - b.absoluteTime);

    // Convertir temps absolu en deltaTime
        let lastTime = 0;
        const trackEvents = events.map(event => {
            const deltaTime = event.absoluteTime - lastTime;
            lastTime = event.absoluteTime;

            const trackEvent = {
                deltaTime: deltaTime,
                type: event.type,
                channel: event.channel
            };

    // Ajouter les champs spécifiques selon le type d'événement
            if (event.type === 'programChange') {
                trackEvent.programNumber = event.programNumber;
            } else if (event.type === 'noteOn' || event.type === 'noteOff') {
                trackEvent.noteNumber = event.noteNumber;
                trackEvent.velocity = event.velocity;
            } else if (event.type === 'controller') {
                trackEvent.controllerType = event.controllerType;
                trackEvent.value = event.value;
            } else if (event.type === 'pitchBend') {
                trackEvent.value = event.value;
            } else if (event.type === 'setTempo') {
                trackEvent.microsecondsPerBeat = event.microsecondsPerBeat;
    // Les événements setTempo n'ont pas de channel
                delete trackEvent.channel;
            }

            return trackEvent;
        });

    // Ajouter End of Track
        trackEvents.push({
            deltaTime: 0,
            type: 'endOfTrack'
        });

    // Structure MIDI compatible avec midi-file
        return {
            header: {
                format: this.midiData?.header?.format || 1,
                numTracks: 1,
                ticksPerBeat: ticksPerBeat
            },
            tracks: [trackEvents]
        };
    }

    /**
    * Sauvegarder le fichier MIDI
    */
    MidiEditorCCPickerMixin.saveMidiFile = async function() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file: ${this.currentFile}`);

    // Synchroniser fullSequence avec le piano roll actuel (gère les canaux, ajouts, suppressions, etc.)
            this.syncFullSequenceFromPianoRoll();

    // Synchroniser les événements CC/Pitchbend depuis l'éditeur
            this.syncCCEventsFromEditor();

    // Synchroniser les événements de tempo depuis l'éditeur
            this.syncTempoEventsFromEditor();

    // Mettre à jour la liste des canaux pour refléter la séquence actuelle
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

    // Convertir en format MIDI
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Échec de conversion en format MIDI');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Envoyer au backend
            const response = await this.api.writeMidiFile(this.currentFile, midiData);

            if (response && response.success) {
                this.isDirty = false;
                this.updateSaveButton();
                this.showNotification(this.t('midiEditor.saveSuccess'), 'success');

    // Émettre événement
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved', {
                        filePath: this.currentFile
                    });
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.log('error', 'Failed to save MIDI file:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
    * Show Save As dialog to save the file with a new name
    */
    MidiEditorCCPickerMixin.showSaveAsDialog = function() {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

    // Extract current name without extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Create the Save As dialog
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>📄 ${this.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${this.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

    // Select name without extension for easy editing
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

    // Cancel
        cancelBtn.addEventListener('click', () => {
            dialog.remove();
        });

    // Confirm - Save As
        confirmBtn.addEventListener('click', async () => {
            const newBaseName = input.value.trim();
            if (!newBaseName) {
                this.showError(this.t('midiEditor.emptyFilename'));
                return;
            }

            const newFilename = newBaseName + extension;
            dialog.remove();

    // Call saveAsFile with the new filename
            await this.saveAsFile(newFilename);
        });

    // Enter to confirm
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            } else if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });

    // Click outside to cancel
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    /**
    * Save the current file with a new name (export)
    */
    MidiEditorCCPickerMixin.saveAsFile = async function(newFilename) {
        if (!this.currentFile || !this.pianoRoll) {
            this.log('error', 'Cannot save as: no file or piano roll');
            this.showError(this.t('midiEditor.cannotSave'));
            return;
        }

        try {
            this.log('info', `Saving MIDI file as: ${newFilename}`);

    // Synchronize data from piano roll
            this.syncFullSequenceFromPianoRoll();
            this.syncCCEventsFromEditor();
            this.updateChannelsFromSequence();

            this.log('info', `Saving ${this.fullSequence.length} notes across ${this.channels.length} channels`);

    // Convert to MIDI format
            const midiData = this.convertSequenceToMidi();

            if (!midiData) {
                throw new Error('Failed to convert to MIDI format');
            }

            this.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);

    // Send to backend with new filename
            const response = await this.api.sendCommand('file_save_as', {
                fileId: this.currentFile,
                newFilename: newFilename,
                midiData: midiData
            });

            if (response && response.success) {
                this.showNotification(
                    this.t('midiEditor.saveAsSuccess', { filename: newFilename }),
                    'success'
                );

    // Emit event
                if (this.eventBus) {
                    this.eventBus.emit('midi_editor:saved_as', {
                        originalFile: this.currentFile,
                        newFile: response.newFileId,
                        newFilename: newFilename
                    });
                }

    // Optionally reload file list in parent
                if (window.loadFiles) {
                    window.loadFiles();
                }
            } else {
                throw new Error('Server response indicates failure');
            }

        } catch (error) {
            this.log('error', 'Failed to save file as:', error);
            this.showError(`${this.t('errors.saveFailed')}: ${error.message}`);
        }
    }

    /**
    * Show routing modal (RoutingSummaryPage)
    */
    MidiEditorCCPickerMixin.showAutoAssignModal = async function() {
        if (!this.currentFile) {
            this.showErrorModal(this.t('midiEditor.noFileLoaded'));
            return;
        }

        if (!window.RoutingSummaryPage) {
            this.showErrorModal(this.t('autoAssign.componentNotLoaded'));
            return;
        }

        const routingPage = new window.RoutingSummaryPage(this.api);
        routingPage.show(this.currentFile, this.currentFilename || '', this.channels || [], (result) => {
            if (result && window.eventBus) {
                window.eventBus.emit('routing:changed', result);
            }
        });
    }

    /**
    * Dynamically load a script if not already loaded
    * @param {string} src - Script path relative to root
    * @returns {Promise<void>}
    */
    MidiEditorCCPickerMixin.loadScript = function(src) {
        return new Promise((resolve, reject) => {
    // Check if already loaded
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
    // Script tag exists but maybe failed - remove and reload
                existing.remove();
            }
            const script = document.createElement('script');
            script.src = src + '?v=' + Date.now();
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
    * Afficher la boîte de dialogue pour renommer le fichier
    */
    MidiEditorCCPickerMixin.showRenameDialog = function() {
    // Extraire le nom sans extension
        const currentName = this.currentFilename || this.currentFile || '';
        const baseName = currentName.replace(/\.(mid|midi)$/i, '');
        const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

    // Créer le dialogue de renommage (modal centré)
        const dialog = document.createElement('div');
        dialog.className = 'rename-dialog-overlay';
        dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>✏️ ${this.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.t('common.save')}</button>
                </div>
            </div>
        `;

    // Ajouter au body pour être au premier plan de tout
        document.body.appendChild(dialog);

        const input = dialog.querySelector('.rename-input');
        const cancelBtn = dialog.querySelector('.rename-cancel');
        const confirmBtn = dialog.querySelector('.rename-confirm');

    // Focus et sélection du texte
        input.focus();
        input.select();

    // Fonction de fermeture
        const closeDialog = () => {
            dialog.remove();
        };

    // Fonction de validation
        const confirmRename = async () => {
            const newName = input.value.trim();
            if (!newName) {
                this.showError(this.t('midiEditor.renameEmpty'));
                return;
            }

            const newFilename = newName + extension;

            try {
    // Appeler l'API pour renommer le fichier
                const response = await this.api.sendCommand('file_rename', {
                    fileId: this.currentFile,
                    newFilename: newFilename
                });

                if (response && response.success) {
    // Mettre à jour le nom affiché
                    this.currentFilename = newFilename;
                    const fileNameSpan = this.container.querySelector('#editor-file-name');
                    if (fileNameSpan) {
                        fileNameSpan.textContent = newFilename;
                    }

                    this.showNotification(this.t('midiEditor.renameSuccess'), 'success');

    // Émettre événement pour rafraîchir la liste des fichiers
                    if (this.eventBus) {
                        this.eventBus.emit('midi_editor:file_renamed', {
                            fileId: this.currentFile,
                            oldFilename: currentName,
                            newFilename: newFilename
                        });
                    }
                } else {
                    throw new Error(response?.error || 'Rename failed');
                }
            } catch (error) {
                this.log('error', 'Failed to rename file:', error);
                this.showError(`${this.t('midiEditor.renameFailed')}: ${error.message}`);
            }

            closeDialog();
        };

    // Événements
        cancelBtn.addEventListener('click', closeDialog);
        confirmBtn.addEventListener('click', confirmRename);
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) closeDialog();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmRename();
            if (e.key === 'Escape') closeDialog();
        });
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorCCPickerMixin = MidiEditorCCPickerMixin;
    }
})();
