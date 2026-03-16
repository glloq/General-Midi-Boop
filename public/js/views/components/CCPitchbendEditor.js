/**
 * CCPitchbendEditor - Éditeur de Control Change et Pitchbend synchronisé avec le piano roll
 *
 * Fonctionnalités :
 * - Édition de CC1, CC2, CC5, CC7, CC10, CC11, CC74, pitchbend
 * - Outils : sélection, déplacement, ligne, dessin continu
 * - Synchronisation horizontale avec le piano roll
 * - Respect de la grille temporelle et du zoom
 * - Filtre par canal sélectionné
 */

class CCPitchbendEditor {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            height: options.height || 150,
            timebase: options.timebase || 480, // PPQ
            xrange: options.xrange || 1920,
            xoffset: options.xoffset || 0,
            grid: options.grid || 15,
            onChange: options.onChange || null, // Callback appelé lors des changements
            ...options
        };

        // État de l'éditeur
        this.events = []; // CC et pitchbend events
        this.selectedEvents = new Set();
        this.currentTool = 'select'; // 'select', 'move', 'line', 'draw'
        this.currentCC = 'cc1'; // 'cc1', 'cc2', 'cc5', 'cc7', 'cc10', 'cc11', 'cc74', 'pitchbend'
        this.currentChannel = 0;
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null; // Dernier tick où un point a été créé en mode dessin

        // Historique pour undo/redo
        this.history = [];
        this.historyIndex = -1;

        // OPTIMISATION: Système de throttling pour le rendu
        this.pendingRender = false;
        this.renderScheduled = false;
        this.isDirty = false;

        // Canvas de buffer pour la grille (statique)
        this.gridCanvas = null;
        this.gridCtx = null;
        this.gridDirty = true;

        // Initialisation
        this.init();
    }

    init() {
        this.createUI();
        this.setupEventListeners();
    }

    createUI() {
        // Conteneur principal
        this.element = document.createElement('div');
        this.element.className = 'cc-pitchbend-editor';
        this.element.style.cssText = `
            width: 100%;
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #1a1a1a;
            border-top: 1px solid #333;
            position: relative;
            overflow: hidden;
            min-height: 0;
        `;

        // Canvas pour le rendu
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            cursor: crosshair;
        `;
        this.ctx = this.canvas.getContext('2d');

        // Overlay pour les interactions
        this.overlay = document.createElement('div');
        this.overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            pointer-events: none;
        `;

        this.element.appendChild(this.canvas);
        this.element.appendChild(this.overlay);
        this.container.appendChild(this.element);

        // Redimensionner le canvas
        this.resize();
    }

    setupEventListeners() {
        // Stocker les références bindées pour pouvoir les retirer dans destroy()
        this._boundMouseDown = this.handleMouseDown.bind(this);
        this._boundMouseMove = (e) => {
            if (this._mouseMoveRAF) return;
            this._mouseMoveRAF = requestAnimationFrame(() => {
                this._mouseMoveRAF = null;
                this.handleMouseMove(e);
            });
        };
        this._boundMouseUp = this.handleMouseUp.bind(this);
        this._boundMouseLeave = this.handleMouseLeave.bind(this);
        this._boundKeyDown = this.handleKeyDown.bind(this);
        this._boundResize = this.resize.bind(this);

        // Événements souris (mousemove throttlé via rAF)
        this.canvas.addEventListener('mousedown', this._boundMouseDown);
        this.canvas.addEventListener('mousemove', this._boundMouseMove);
        this.canvas.addEventListener('mouseup', this._boundMouseUp);
        this.canvas.addEventListener('mouseleave', this._boundMouseLeave);

        // Événements clavier
        document.addEventListener('keydown', this._boundKeyDown);

        // Redimensionnement
        window.addEventListener('resize', this._boundResize);
    }

    resize() {
        // CORRECTION: Forcer reflow de la cascade complète (container parents + element)
        if (this.container) {
            void this.container.offsetHeight;
        }
        if (this.container && this.container.parentElement) {
            void this.container.parentElement.offsetHeight;
        }
        void this.element.offsetHeight;

        const rect = this.element.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // Ne redimensionner que si on a des dimensions valides
        if (width > 0 && height > 100) {
            // Stocker l'ancienne hauteur pour détecter les changements importants
            const oldHeight = this.canvas.height;

            this.canvas.width = width;
            this.canvas.height = height;

            // OPTIMISATION: Recréer le canvas de buffer pour la grille
            if (!this.gridCanvas) {
                this.gridCanvas = document.createElement('canvas');
                this.gridCtx = this.gridCanvas.getContext('2d');
            }
            this.gridCanvas.width = width;
            this.gridCanvas.height = height;
            this.gridDirty = true;

            // Canvas redimensionné

            this.renderThrottled();

            // CORRECTION: Vérification que la hauteur est stable après 1 frame
            if (oldHeight > 0 && Math.abs(height - oldHeight) > 50) {
                // Changement important détecté, vérifier la stabilité
                requestAnimationFrame(() => {
                    const newHeight = this.element.getBoundingClientRect().height;
                    if (Math.abs(newHeight - height) > 2) {
                        this.resize();  // Rappeler avec la vraie hauteur
                    }
                });
            }
        }
    }

    // === Gestion des outils ===

    setTool(tool) {
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
    }

    setCC(ccType) {
        this.currentCC = ccType;
        this.cancelInteractions(); // Annuler actions en cours lors changement type CC
        this.gridDirty = true; // Forcer le re-rendu de la grille (labels différents CC vs pitchbend)
        this.isDirty = true;
        this.renderThrottled();
    }

    setChannel(channel) {
        this.currentChannel = channel;
        this.cancelInteractions(); // Annuler actions en cours lors changement canal
        this.isDirty = true;
        this.renderThrottled();
    }

    cancelInteractions() {
        // Annuler toutes les interactions en cours
        this.lineStart = null;
        this.selectionStart = null;
        this.dragStart = null;
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;
    }

    // === Conversion coordonnées ===

    ticksToX(ticks) {
        return ((ticks - this.options.xoffset) / this.options.xrange) * this.canvas.width;
    }

    xToTicks(x) {
        return Math.round((x / this.canvas.width) * this.options.xrange + this.options.xoffset);
    }

    valueToY(value) {
        // Pour CC: 0-127 → bottom to top
        // Pour pitchbend: -8192 to 8191 → bottom to top (16384 valeurs)
        let normalized;
        if (this.currentCC === 'pitchbend') {
            normalized = (value + 8192) / 16384; // -8192..8191 → 0..~1
        } else {
            normalized = value / 127; // 0..127 → 0..1
        }
        return this.canvas.height - (normalized * this.canvas.height);
    }

    yToValue(y) {
        const normalized = 1 - (y / this.canvas.height);
        if (this.currentCC === 'pitchbend') {
            return Math.max(-8192, Math.min(8191, Math.round(normalized * 16384 - 8192)));
        } else {
            return Math.max(0, Math.min(127, Math.round(normalized * 127)));
        }
    }

    snapToGrid(ticks) {
        const gridSize = this.options.grid;
        return Math.round(ticks / gridSize) * gridSize;
    }

    // === Gestion des événements ===

    addEvent(ticks, value, channel = this.currentChannel, autoSave = true) {
        const snappedTicks = this.snapToGrid(ticks);

        // Vérifier si un événement existe déjà à ce tick (pour éviter les doublons)
        const existingEvent = this.events.find(e =>
            e.ticks === snappedTicks &&
            e.type === this.currentCC &&
            e.channel === channel
        );

        if (existingEvent) {
            // Mettre à jour la valeur existante
            existingEvent.value = this.clampValue(value);
            if (autoSave) {
                this.renderThrottled();
            }
            return existingEvent;
        }

        const event = {
            type: this.currentCC,
            ticks: snappedTicks,
            value: this.clampValue(value),
            channel: channel,
            id: Date.now() + Math.random()
        };
        this.events.push(event);

        if (autoSave) {
            this.saveState();
            this.renderThrottled();
        }

        return event;
    }

    removeEvents(eventIds) {
        this.events = this.events.filter(e => !eventIds.includes(e.id));
        this.selectedEvents.clear();
        this.saveState();
        this.renderThrottled();
    }

    moveEvents(eventIds, deltaTicks, deltaValue) {
        eventIds.forEach(id => {
            const event = this.events.find(e => e.id === id);
            if (event) {
                event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                event.value = this.clampValue(event.value + deltaValue);
            }
        });
        this.saveState();
        this.renderThrottled();
    }

    clampValue(value) {
        if (this.currentCC === 'pitchbend') {
            return Math.max(-8192, Math.min(8191, value));
        } else {
            return Math.max(0, Math.min(127, value));
        }
    }

    // === Outils d'édition ===

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const value = this.yToValue(y);

        switch (this.currentTool) {
            case 'draw':
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                this.addEvent(ticks, value, this.currentChannel, false); // Ne pas sauvegarder immédiatement
                this.renderThrottled();
                break;

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, value };
                } else {
                    this.createLine(this.lineStart.ticks, this.lineStart.value, ticks, value);
                    this.lineStart = null;
                }
                break;

            case 'select':
                const clickedEvent = this.getEventAtPosition(x, y);
                if (clickedEvent) {
                    if (e.shiftKey) {
                        if (this.selectedEvents.has(clickedEvent.id)) {
                            this.selectedEvents.delete(clickedEvent.id);
                        } else {
                            this.selectedEvents.add(clickedEvent.id);
                        }
                    } else {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(clickedEvent.id);
                    }
                    this.dragStart = { x, y, ticks, value };
                } else {
                    if (!e.shiftKey) {
                        this.selectedEvents.clear();
                    }
                    this.selectionStart = { x, y };
                }
                this.renderThrottled();
                break;

            case 'move':
                const moveEvent = this.getEventAtPosition(x, y);
                if (moveEvent) {
                    if (!this.selectedEvents.has(moveEvent.id)) {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(moveEvent.id);
                    }
                    this.dragStart = { x, y, ticks, value };
                }
                this.renderThrottled();
                break;
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const value = this.yToValue(y);

        if (this.isDrawing && this.currentTool === 'draw') {
            // Dessin continu - créer un point seulement si on a avancé d'au moins un tick de grille
            const snappedTicks = this.snapToGrid(ticks);
            if (this.lastDrawTicks === null || Math.abs(snappedTicks - this.lastDrawTicks) >= this.options.grid) {
                this.addEvent(ticks, value, this.currentChannel, false); // Ne pas sauvegarder immédiatement
                this.lastDrawTicks = snappedTicks;
                this.lastDrawPosition = { x, y };
                this.renderThrottled();
            }
        } else if (this.dragStart && (this.currentTool === 'select' || this.currentTool === 'move')) {
            // Déplacement des événements sélectionnés
            if (this.selectedEvents.size > 0) {
                const deltaTicks = this.xToTicks(x) - this.dragStart.ticks;
                const deltaValue = this.yToValue(y) - this.dragStart.value;

                Array.from(this.selectedEvents).forEach(id => {
                    const event = this.events.find(e => e.id === id);
                    if (event) {
                        event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
                        event.value = this.clampValue(event.value + deltaValue);
                    }
                });

                this.dragStart = { x, y, ticks, value };
                this.renderThrottled();
            }
        } else if (this.selectionStart) {
            // Rectangle de sélection
            this.renderSelectionRect(this.selectionStart.x, this.selectionStart.y, x, y);
        } else if (this.lineStart) {
            // Prévisualisation de la ligne
            this.renderLinePreview(this.lineStart, { ticks, value });
        }
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastDrawPosition = null;
            this.lastDrawTicks = null;
            // Sauvegarder l'état après avoir fini de dessiner
            this.saveState();
        }

        if (this.selectionStart) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this.selectInRect(this.selectionStart.x, this.selectionStart.y, x, y);
            this.selectionStart = null;
        }

        if (this.dragStart) {
            this.saveState();
            this.dragStart = null;
        }

        this.renderThrottled();
    }

    handleMouseLeave(e) {
        this.handleMouseUp(e);
    }

    handleKeyDown(e) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selectedEvents.size > 0) {
                this.removeEvents(Array.from(this.selectedEvents));
            }
        } else if (e.key === 'Escape') {
            this.selectedEvents.clear();
            this.lineStart = null;
            this.renderThrottled();
        } else if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                this.undo();
                e.preventDefault();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
                this.redo();
                e.preventDefault();
            } else if (e.key === 'a') {
                this.selectAll();
                e.preventDefault();
            }
        }
    }

    // === Utilitaires de sélection ===

    getEventAtPosition(x, y, threshold = 5) {
        const ticks = this.xToTicks(x);
        const value = this.yToValue(y);

        return this.getFilteredEvents().find(event => {
            const ex = this.ticksToX(event.ticks);
            const ey = this.valueToY(event.value);
            return Math.abs(ex - x) <= threshold && Math.abs(ey - y) <= threshold;
        });
    }

    selectInRect(x1, y1, x2, y2) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);

        this.getFilteredEvents().forEach(event => {
            const ex = this.ticksToX(event.ticks);
            const ey = this.valueToY(event.value);
            if (ex >= left && ex <= right && ey >= top && ey <= bottom) {
                this.selectedEvents.add(event.id);
            }
        });
    }

    selectAll() {
        this.selectedEvents.clear();
        this.getFilteredEvents().forEach(event => {
            this.selectedEvents.add(event.id);
        });
        this.renderThrottled();
    }

    deleteSelected() {
        if (this.selectedEvents.size === 0) return;

        // Supprimer les événements sélectionnés
        this.events = this.events.filter(event => !this.selectedEvents.has(event.id));

        // Effacer la sélection
        this.selectedEvents.clear();

        // Sauvegarder l'état et notifier le changement
        this.saveState();
        if (this.options.onChange) {
            this.options.onChange();
        }
        this.renderThrottled();
    }

    // === Outil ligne ===

    createLine(startTicks, startValue, endTicks, endValue) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const ticksRange = maxTicks - minTicks;
        const valueRange = endValue - startValue;

        // Créer des points le long de la ligne selon la grille
        // Utiliser autoSave=false pour ne pas sauvegarder à chaque point
        for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
            const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
            const value = Math.round(startValue + valueRange * progress);
            this.addEvent(t, value, this.currentChannel, false);
        }

        // S'assurer que le endpoint exact est créé (peut ne pas tomber sur la grille)
        const lastGridTick = Math.floor((maxTicks - minTicks) / this.options.grid) * this.options.grid + minTicks;
        if (lastGridTick < maxTicks) {
            this.addEvent(maxTicks, Math.round(startValue + valueRange * (ticksRange > 0 ? 1 : 0)), this.currentChannel, false);
        }

        // Sauvegarder l'état une seule fois à la fin
        this.saveState();
        this.renderThrottled();
    }

    // === Rendu ===

    // OPTIMISATION: Fonction throttled pour le rendu
    renderThrottled() {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                this.renderScheduled = false;
            });
        }
    }

    render() {
        if (!this.ctx || !this.canvas) {
            console.warn('CCPitchbendEditor: Canvas context not ready');
            return;
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // OPTIMISATION: Utiliser le canvas de buffer pour la grille
        // Grille de fond
        this.renderGrid();

        // Ligne médiane (0 pour pitchbend, 64 pour CC)
        this.renderCenterLine();

        // Événements
        this.renderEvents();

        // Réinitialiser le dirty flag
        this.isDirty = false;

        // Render complete
    }

    renderGrid() {
        const labelMargin = 50; // Marge pour les labels à gauche

        // OPTIMISATION: Vérifier si la grille doit être redessinée
        // La grille change si xoffset, xrange, grid, ou currentCC changent
        if (this.gridDirty || !this.gridCanvas) {
            this.renderGridToBuffer();
            this.gridDirty = false;
        }

        // Copier le buffer de grille sur le canvas principal
        this.ctx.drawImage(this.gridCanvas, 0, 0);
    }

    renderGridToBuffer() {
        if (!this.gridCtx) return;

        const labelMargin = 50; // Marge pour les labels à gauche
        const ctx = this.gridCtx;

        // Effacer le buffer
        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

        // Grille verticale (temps)
        ctx.strokeStyle = '#3a3a3a'; // Plus clair pour être visible
        ctx.lineWidth = 1;

        const gridSize = this.options.grid;
        const startTick = Math.floor(this.options.xoffset / gridSize) * gridSize;
        const endTick = this.options.xoffset + this.options.xrange;

        for (let t = startTick; t <= endTick; t += gridSize) {
            const x = this.ticksToX(t);
            if (x >= 0 && x <= this.gridCanvas.width) {
                ctx.beginPath();
                ctx.moveTo(Math.max(x, labelMargin), 0);
                ctx.lineTo(x, this.gridCanvas.height);
                ctx.stroke();
            }
        }

        // Grille horizontale (valeurs)
        if (this.currentCC === 'pitchbend') {
            // Pour pitchbend : lignes aux valeurs -8192, -4096, 0, 4096, 8191
            const values = [-8192, -4096, 0, 4096, 8191];
            ctx.strokeStyle = '#3a3a3a'; // Plus clair
            ctx.lineWidth = 1;

            values.forEach(value => {
                const y = this.valueToY(value);

                // Ligne de grille
                ctx.beginPath();
                ctx.moveTo(labelMargin, y);
                ctx.lineTo(this.gridCanvas.width, y);
                ctx.stroke();

                // Zone de label (fond)
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(0, y - 7, labelMargin - 2, 14);

                // Label
                ctx.fillStyle = '#aaa'; // Plus clair
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(value.toString(), labelMargin - 5, y + 4);
            });
        } else {
            // Pour CC : lignes aux valeurs 0, 32, 64, 96, 127
            const values = [0, 32, 64, 96, 127];
            ctx.strokeStyle = '#3a3a3a'; // Plus clair
            ctx.lineWidth = 1;

            values.forEach(value => {
                const y = this.valueToY(value);

                // Ligne de grille
                ctx.beginPath();
                ctx.moveTo(labelMargin, y);
                ctx.lineTo(this.gridCanvas.width, y);
                ctx.stroke();

                // Zone de label (fond)
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(0, y - 7, labelMargin - 2, 14);

                // Label
                ctx.fillStyle = '#aaa'; // Plus clair
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(value.toString(), labelMargin - 5, y + 4);
            });
        }

        // Bordure verticale séparant la zone de labels
        ctx.strokeStyle = '#555'; // Plus clair
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelMargin, 0);
        ctx.lineTo(labelMargin, this.gridCanvas.height);
        ctx.stroke();

        // Réinitialiser l'alignement du texte
        ctx.textAlign = 'left';
    }

    renderCenterLine() {
        const filteredEvents = this.getFilteredEvents();
        const labelMargin = 50;

        if (this.currentCC === 'pitchbend') {
            // Pour pitchbend : toujours afficher une barre centrale à 0
            this.ctx.strokeStyle = '#888';
            this.ctx.lineWidth = 2;
            const y = this.valueToY(0);
            this.ctx.beginPath();
            this.ctx.moveTo(labelMargin, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        } else {
            // Pour CC : afficher une barre à 0 si pas d'événements
            if (filteredEvents.length === 0) {
                this.ctx.strokeStyle = '#666';
                this.ctx.lineWidth = 2;
                this.ctx.setLineDash([5, 5]);
                const y = this.valueToY(0);
                this.ctx.beginPath();
                this.ctx.moveTo(labelMargin, y);
                this.ctx.lineTo(this.canvas.width, y);
                this.ctx.stroke();
                this.ctx.setLineDash([]);
            }
        }
    }

    renderEvents() {
        const events = this.getFilteredEvents();

        // Trier par ticks
        events.sort((a, b) => a.ticks - b.ticks);

        // Dessiner les lignes connectant les événements
        if (events.length > 1) {
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;

            // CC et Pitchbend : courbe en escalier (valeurs discrètes)
            this.ctx.beginPath();
            events.forEach((event, i) => {
                const x = this.ticksToX(event.ticks);
                const y = this.valueToY(event.value);

                if (i === 0) {
                    this.ctx.moveTo(x, y);
                } else {
                    const prevEvent = events[i - 1];
                    const prevX = this.ticksToX(prevEvent.ticks);
                    const prevY = this.valueToY(prevEvent.value);

                    // Ligne horizontale depuis le point précédent jusqu'à l'abscisse du point actuel
                    this.ctx.lineTo(x, prevY);
                    // Ligne verticale jusqu'au point actuel
                    this.ctx.lineTo(x, y);
                }
            });
            this.ctx.stroke();
        } else if (events.length === 1) {
            // Si un seul événement, afficher une ligne horizontale
            this.ctx.strokeStyle = '#4CAF50';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            const x = this.ticksToX(events[0].ticks);
            const y = this.valueToY(events[0].value);
            this.ctx.moveTo(x, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }

        // Dessiner les points
        events.forEach(event => {
            const x = this.ticksToX(event.ticks);
            const y = this.valueToY(event.value);
            const isSelected = this.selectedEvents.has(event.id);

            this.ctx.fillStyle = isSelected ? '#FFC107' : '#4CAF50';
            this.ctx.beginPath();
            this.ctx.arc(x, y, isSelected ? 5 : 3, 0, 2 * Math.PI);
            this.ctx.fill();
        });
    }

    // OPTIMISATION: Utiliser requestAnimationFrame pour les rendus temporaires
    renderSelectionRect(x1, y1, x2, y2) {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                // Dessiner le rectangle de sélection par-dessus
                this.ctx.strokeStyle = '#2196F3';
                this.ctx.lineWidth = 1;
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                this.ctx.setLineDash([]);
                this.renderScheduled = false;
            });
        }
    }

    renderLinePreview(start, end) {
        if (!this.renderScheduled) {
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.render();
                // Dessiner la ligne de prévisualisation par-dessus
                this.ctx.strokeStyle = '#9E9E9E';
                this.ctx.lineWidth = 1;
                this.ctx.setLineDash([5, 5]);
                this.ctx.beginPath();
                this.ctx.moveTo(this.ticksToX(start.ticks), this.valueToY(start.value));
                this.ctx.lineTo(this.ticksToX(end.ticks), this.valueToY(end.value));
                this.ctx.stroke();
                this.ctx.setLineDash([]);
                this.renderScheduled = false;
            });
        }
    }

    // === Filtrage ===

    getFilteredEvents() {
        return this.events.filter(event =>
            event.type === this.currentCC &&
            event.channel === this.currentChannel
        );
    }

    // === Synchronisation ===

    syncWith(pianoRoll) {
        // Synchroniser avec les paramètres du piano roll
        const oldXRange = this.options.xrange;
        const oldXOffset = this.options.xoffset;
        const oldGrid = this.options.grid;

        this.options.xrange = pianoRoll.xrange || this.options.xrange;
        this.options.xoffset = pianoRoll.xoffset || this.options.xoffset;
        this.options.grid = pianoRoll.grid || this.options.grid;
        this.options.timebase = pianoRoll.timebase || this.options.timebase;

        // OPTIMISATION: Marquer la grille comme dirty si les paramètres ont changé
        if (oldXRange !== this.options.xrange ||
            oldXOffset !== this.options.xoffset ||
            oldGrid !== this.options.grid) {
            this.gridDirty = true;
        }

        this.renderThrottled();
    }

    // === Undo/Redo ===

    saveState() {
        // Debounce: max 1 sauvegarde par 100ms pour éviter le lag en dessin continu
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this._saveStateTimer = setTimeout(() => {
            this._doSaveState();
        }, 100);
    }

    _doSaveState() {
        const state = JSON.stringify(this.events);
        if (this.history[this.historyIndex] !== state) {
            this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(state);
            this.historyIndex++;

            // Limiter l'historique
            if (this.history.length > 50) {
                this.history.shift();
                this.historyIndex--;
            }

            // Notifier le changement
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    undo() {
        // Annuler tout timer de saveState en cours pour éviter corruption de l'historique
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();

            // Notifier le changement
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    redo() {
        // Annuler tout timer de saveState en cours pour éviter corruption de l'historique
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();

            // Notifier le changement
            if (this.options.onChange && typeof this.options.onChange === 'function') {
                this.options.onChange();
            }
        }
    }

    // === Import/Export ===

    loadEvents(events) {
        console.log(`CCPitchbendEditor: Loading ${events.length} events`);
        this.events = events.map(e => ({
            ...e,
            id: e.id || (Date.now() + Math.random())
        }));

        // Log des événements par type et canal
        const eventsByType = {};
        this.events.forEach(e => {
            const key = `${e.type}-ch${e.channel}`;
            eventsByType[key] = (eventsByType[key] || 0) + 1;
        });
        console.log('CCPitchbendEditor: Events by type/channel:', eventsByType);

        // CORRECTION: Initialiser l'historique sans déclencher onChange
        // (car charger les événements existants n'est pas une modification utilisateur)
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;

        this.renderThrottled();
    }

    getEvents() {
        return this.events;
    }

    clear() {
        this.events = [];
        this.selectedEvents.clear();

        // Réinitialiser l'historique
        this.history = [JSON.stringify(this.events)];
        this.historyIndex = 0;

        this.renderThrottled();

        // Notifier le changement (car clear est une action utilisateur)
        if (this.options.onChange && typeof this.options.onChange === 'function') {
            this.options.onChange();
        }
    }

    // === Cleanup ===

    destroy() {
        if (this._mouseMoveRAF) cancelAnimationFrame(this._mouseMoveRAF);
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this._boundMouseDown);
            this.canvas.removeEventListener('mousemove', this._boundMouseMove);
            this.canvas.removeEventListener('mouseup', this._boundMouseUp);
            this.canvas.removeEventListener('mouseleave', this._boundMouseLeave);
        }
        document.removeEventListener('keydown', this._boundKeyDown);
        window.removeEventListener('resize', this._boundResize);

        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

// Export pour utilisation
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CCPitchbendEditor;
}
