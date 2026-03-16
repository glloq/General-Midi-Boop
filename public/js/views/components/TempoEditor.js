/**
 * TempoEditor - Éditeur de courbes de tempo synchronisé avec le piano roll
 *
 * Fonctionnalités :
 * - Édition des changements de tempo au fil du temps (tempo map)
 * - Outils : sélection, déplacement, ligne avec courbes, dessin continu
 * - Types de courbes : linéaire, exponentielle, logarithmique, sinusoïdale
 * - Synchronisation horizontale avec le piano roll
 * - Respect de la grille temporelle et du zoom
 */

class TempoEditor {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            height: options.height || 150,
            timebase: options.timebase || 480, // PPQ
            xrange: options.xrange || 1920,
            xoffset: options.xoffset || 0,
            grid: options.grid || 15,
            minTempo: options.minTempo || 20,
            maxTempo: options.maxTempo || 300,
            onChange: options.onChange || null, // Callback appelé lors des changements
            ...options
        };

        // État de l'éditeur
        this.events = []; // Événements de tempo {ticks, tempo}
        this.selectedEvents = new Set();
        this.currentTool = 'select'; // 'select', 'move', 'line', 'draw'
        this.curveType = 'linear'; // Type de courbe : 'linear', 'exponential', 'logarithmic', 'sine'
        this.isDrawing = false;
        this.lastDrawPosition = null;
        this.lastDrawTicks = null;

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
        this.element.className = 'tempo-editor';
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

        this.element.appendChild(this.canvas);
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

        if (width > 0 && height > 0) {
            this.canvas.width = width;
            this.canvas.height = height;

            // Créer le canvas de buffer pour la grille
            if (!this.gridCanvas) {
                this.gridCanvas = document.createElement('canvas');
                this.gridCanvas.width = width;
                this.gridCanvas.height = height;
                this.gridCtx = this.gridCanvas.getContext('2d');
            } else if (this.gridCanvas.width !== width || this.gridCanvas.height !== height) {
                this.gridCanvas.width = width;
                this.gridCanvas.height = height;
            }

            this.gridDirty = true;
            this.renderThrottled();
        }
    }

    // === Gestion de l'état ===

    saveState() {
        // Debounce: max 1 sauvegarde par 100ms pour éviter le lag en dessin continu
        if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
        this._saveStateTimer = setTimeout(() => {
            this._doSaveState();
        }, 100);
    }

    _doSaveState() {
        const state = JSON.stringify(this.events);

        // Supprimer les états futurs si on est au milieu de l'historique
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.history.push(state);
        this.historyIndex++;

        // Limiter l'historique à 50 états
        if (this.history.length > 50) {
            this.history.shift();
            this.historyIndex--;
        }

        this.notifyChange();
    }

    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();
            this.notifyChange();
            return true;
        }
        return false;
    }

    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.events = JSON.parse(this.history[this.historyIndex]);
            this.selectedEvents.clear();
            this.renderThrottled();
            this.notifyChange();
            return true;
        }
        return false;
    }

    notifyChange() {
        if (this.options.onChange) {
            this.options.onChange();
        }
    }

    // === Gestion des outils ===

    setTool(tool) {
        this.currentTool = tool;
        this.canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
    }

    setCurveType(curveType) {
        this.curveType = curveType;
        console.log(`TempoEditor: Curve type set to ${curveType}`);
    }

    cancelInteractions() {
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

    tempoToY(tempo) {
        const normalized = (tempo - this.options.minTempo) / (this.options.maxTempo - this.options.minTempo);
        return this.canvas.height - (normalized * this.canvas.height);
    }

    yToTempo(y) {
        const normalized = 1 - (y / this.canvas.height);
        return Math.round(normalized * (this.options.maxTempo - this.options.minTempo) + this.options.minTempo);
    }

    snapToGrid(ticks) {
        const gridSize = this.options.grid;
        return Math.round(ticks / gridSize) * gridSize;
    }

    clampTempo(tempo) {
        return Math.max(this.options.minTempo, Math.min(this.options.maxTempo, tempo));
    }

    // === Gestion des événements ===

    addEvent(ticks, tempo, autoSave = true) {
        const snappedTicks = this.snapToGrid(ticks);

        // Vérifier si un événement existe déjà à ce tick
        const existingEvent = this.events.find(e => e.ticks === snappedTicks);

        if (existingEvent) {
            existingEvent.tempo = this.clampTempo(tempo);
            if (autoSave) {
                this.saveState();
                this.renderThrottled();
            }
            return existingEvent;
        }

        const event = {
            ticks: snappedTicks,
            tempo: this.clampTempo(tempo),
            id: Date.now() + Math.random()
        };
        this.events.push(event);

        // Trier par ticks
        this.events.sort((a, b) => a.ticks - b.ticks);

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

    moveEvents(eventIds, deltaTicks, deltaTempo) {
        eventIds.forEach(id => {
            const event = this.events.find(e => e.id === id);
            if (event) {
                event.ticks = this.snapToGrid(Math.max(0, event.ticks + deltaTicks));
                event.tempo = this.clampTempo(event.tempo + deltaTempo);
            }
        });
        // Trier par ticks après déplacement
        this.events.sort((a, b) => a.ticks - b.ticks);
        this.saveState();
        this.renderThrottled();
    }

    // === Outils d'édition ===

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const tempo = this.yToTempo(y);

        switch (this.currentTool) {
            case 'draw':
                this.isDrawing = true;
                this.lastDrawPosition = { x, y };
                this.lastDrawTicks = this.snapToGrid(ticks);
                this.addEvent(ticks, tempo, false);
                this.renderThrottled();
                break;

            case 'line':
                if (!this.lineStart) {
                    this.lineStart = { ticks, tempo };
                } else {
                    this.createLine(this.lineStart.ticks, this.lineStart.tempo, ticks, tempo);
                    this.lineStart = null;
                }
                break;

            case 'select':
                // Chercher un événement proche
                const clickedEvent = this.findEventAt(ticks, tempo);
                if (clickedEvent) {
                    if (e.shiftKey) {
                        this.selectedEvents.add(clickedEvent.id);
                    } else {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(clickedEvent.id);
                    }
                } else {
                    if (!e.shiftKey) {
                        this.selectedEvents.clear();
                    }
                }
                this.renderThrottled();
                break;

            case 'move':
                const eventToMove = this.findEventAt(ticks, tempo);
                if (eventToMove) {
                    if (!this.selectedEvents.has(eventToMove.id)) {
                        this.selectedEvents.clear();
                        this.selectedEvents.add(eventToMove.id);
                    }
                    this.dragStart = { ticks, tempo };
                }
                break;
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ticks = this.xToTicks(x);
        const tempo = this.yToTempo(y);

        if (this.isDrawing && this.currentTool === 'draw') {
            const snappedTicks = this.snapToGrid(ticks);
            if (snappedTicks !== this.lastDrawTicks) {
                this.addEvent(ticks, tempo, false);
                this.lastDrawTicks = snappedTicks;
                this.renderThrottled();
            }
        } else if (this.dragStart && this.currentTool === 'move') {
            const deltaTicks = this.snapToGrid(ticks - this.dragStart.ticks);
            const deltaTempo = Math.round(tempo - this.dragStart.tempo);

            if (deltaTicks !== 0 || deltaTempo !== 0) {
                this.moveEvents(Array.from(this.selectedEvents), deltaTicks, deltaTempo);
                this.dragStart = { ticks, tempo };
            }
        }
    }

    handleMouseUp(e) {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.saveState();
        }
        if (this.dragStart) {
            this.dragStart = null;
        }
    }

    handleMouseLeave(e) {
        this.handleMouseUp(e);
    }

    handleKeyDown(e) {
        // Ne traiter les raccourcis que si l'éditeur est visible
        if (!this.element || this.element.offsetParent === null) return;

        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedEvents.size > 0) {
            e.preventDefault();
            this.removeEvents(Array.from(this.selectedEvents));
        } else if (e.key === 'Escape') {
            this.cancelInteractions();
            this.selectedEvents.clear();
            this.renderThrottled();
        } else if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                this.undo();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
                e.preventDefault();
                this.redo();
            }
        }
    }

    findEventAt(ticks, tempo) {
        const threshold = 20; // pixels

        for (const event of this.events) {
            const ex = this.ticksToX(event.ticks);
            const ey = this.tempoToY(event.tempo);
            const distance = Math.sqrt(Math.pow(ex - this.ticksToX(ticks), 2) + Math.pow(ey - this.tempoToY(tempo), 2));

            if (distance < threshold) {
                return event;
            }
        }
        return null;
    }

    // === Création de ligne avec courbes ===

    createLine(startTicks, startTempo, endTicks, endTempo) {
        const minTicks = Math.min(startTicks, endTicks);
        const maxTicks = Math.max(startTicks, endTicks);
        const ticksRange = maxTicks - minTicks;
        const tempoRange = endTempo - startTempo;

        // Créer des points le long de la ligne selon la grille
        for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
            const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
            const curveProgress = this.applyCurve(progress);
            const tempo = Math.round(startTempo + tempoRange * curveProgress);
            this.addEvent(t, tempo, false);
        }

        this.saveState();
        this.renderThrottled();
    }

    /**
     * Applique une courbe d'interpolation sur un progrès linéaire [0..1]
     * @param {number} t - Progrès linéaire (0 à 1)
     * @returns {number} - Progrès avec courbe appliquée (0 à 1)
     */
    applyCurve(t) {
        switch (this.curveType) {
            case 'linear':
                return t;

            case 'exponential':
                // Courbe exponentielle (ease-in) : démarrage lent, fin rapide
                return t * t;

            case 'logarithmic':
                // Courbe logarithmique (ease-out) : démarrage rapide, fin lente
                return Math.sqrt(t);

            case 'sine':
                // Courbe sinusoïdale (ease-in-out) : démarrage et fin en douceur
                return (1 - Math.cos(t * Math.PI)) / 2;

            default:
                return t;
        }
    }

    // === Rendu ===

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
            return;
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Grille de fond
        this.renderGrid();

        // Ligne de tempo par défaut (120 BPM)
        this.renderDefaultTempoLine();

        // Événements
        this.renderEvents();

        this.isDirty = false;
    }

    renderGrid() {
        if (this.gridDirty || !this.gridCanvas) {
            this.renderGridToBuffer();
            this.gridDirty = false;
        }

        this.ctx.drawImage(this.gridCanvas, 0, 0);
    }

    renderGridToBuffer() {
        if (!this.gridCtx) return;

        const ctx = this.gridCtx;
        const labelMargin = 50;
        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);

        // Fond de la zone de labels
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, labelMargin, this.gridCanvas.height);

        // Grille verticale (temps) — synchronisée avec xoffset
        const ticksPerBeat = this.options.timebase;
        const gridSize = this.options.grid || ticksPerBeat;
        const startTick = Math.floor(this.options.xoffset / ticksPerBeat) * ticksPerBeat;
        const endTick = this.options.xoffset + this.options.xrange;

        for (let t = startTick; t <= endTick; t += gridSize) {
            const x = this.ticksToX(t);
            if (x < labelMargin || x > this.gridCanvas.width) continue;

            // Trait plus marqué sur les temps forts (noire)
            const isBeat = (t % ticksPerBeat) === 0;
            ctx.strokeStyle = isBeat ? '#383838' : '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.gridCanvas.height);
            ctx.stroke();
        }

        // Grille horizontale (tempo) — labels avec marge
        const tempoStep = 20; // 20 BPM par ligne
        const numLines = Math.ceil((this.options.maxTempo - this.options.minTempo) / tempoStep);

        for (let i = 0; i <= numLines; i++) {
            const tempo = this.options.minTempo + i * tempoStep;
            const y = this.tempoToY(tempo);

            // Ligne plus marquée à 120 BPM (tempo standard)
            const isDefault = tempo === 120;
            ctx.strokeStyle = isDefault ? '#444' : '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(labelMargin, y);
            ctx.lineTo(this.gridCanvas.width, y);
            ctx.stroke();

            // Label dans la marge
            ctx.fillStyle = isDefault ? '#aaa' : '#666';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`${tempo}`, labelMargin - 5, y + 4);
        }
        ctx.textAlign = 'left';
    }

    renderDefaultTempoLine() {
        const defaultTempo = 120;
        const y = this.tempoToY(defaultTempo);

        this.ctx.strokeStyle = '#555';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]);
        this.ctx.beginPath();
        this.ctx.moveTo(0, y);
        this.ctx.lineTo(this.canvas.width, y);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    renderEvents() {
        if (this.events.length === 0) return;

        // Dessiner les lignes entre les événements
        this.ctx.strokeStyle = '#00bfff';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();

        this.events.forEach((event, index) => {
            const x = this.ticksToX(event.ticks);
            const y = this.tempoToY(event.tempo);

            if (index === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        });

        this.ctx.stroke();

        // Dessiner les points
        this.events.forEach(event => {
            const x = this.ticksToX(event.ticks);
            const y = this.tempoToY(event.tempo);
            const isSelected = this.selectedEvents.has(event.id);

            this.ctx.fillStyle = isSelected ? '#ffff00' : '#00bfff';
            this.ctx.beginPath();
            this.ctx.arc(x, y, isSelected ? 6 : 4, 0, Math.PI * 2);
            this.ctx.fill();

            // Border pour les points sélectionnés
            if (isSelected) {
                this.ctx.strokeStyle = '#ffffff';
                this.ctx.lineWidth = 2;
                this.ctx.stroke();
            }
        });
    }

    // === Synchronisation ===

    setXRange(xrange) {
        this.options.xrange = xrange;
        this.gridDirty = true;
        this.renderThrottled();
    }

    setXOffset(xoffset) {
        this.options.xoffset = xoffset;
        this.gridDirty = true;
        this.renderThrottled();
    }

    setGrid(grid) {
        this.options.grid = grid;
        this.renderThrottled();
    }

    setEvents(events) {
        this.events = events || [];
        this.selectedEvents.clear();
        this.renderThrottled();
    }

    getEvents() {
        return this.events;
    }

    // === Nettoyage ===

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
