// ============================================================================
// Fichier: public/js/features/NeckDiagramConfig.js
// Description: Interactive canvas-based neck diagram for configuring
//   per-string fret counts. Draws a vertical guitar neck with draggable
//   markers on each string to set the number of playable frets.
//   Strings run along X-axis (left=string 1), frets along Y-axis (top=nut).
// ============================================================================

class NeckDiagramConfig {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} options
     * @param {number} options.numStrings - Number of strings
     * @param {number} options.numFrets - Default/max fret count
     * @param {number[]} [options.fretsPerString] - Per-string fret counts (null = uniform)
     * @param {number[]} [options.tuning] - MIDI note numbers per string
     * @param {boolean} [options.isFretless] - Whether instrument is fretless
     * @param {Function} [options.onChange] - Callback when frets change: onChange(fretsPerString)
     */
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        this.numStrings = options.numStrings || 6;
        this.numFrets = options.numFrets || 24;
        this.tuning = options.tuning || [];
        this.isFretless = options.isFretless || false;
        this.onChange = options.onChange || null;

        // Per-string fret counts (initialized from options or uniform)
        this.fretsPerString = options.fretsPerString
            ? [...options.fretsPerString]
            : new Array(this.numStrings).fill(this.numFrets);

        // Layout constants (vertical orientation)
        this.headHeight = 30;    // Guitar head area (top)
        this.bodyHeight = 20;    // Simplified body (bottom)
        this.topMargin = 4;      // Small top margin (labels are in HTML above)
        this.bottomMargin = 10;
        this.leftMargin = 30;    // Space for fret numbers
        this.rightMargin = 10;

        // Fret markers
        this.markerFrets = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
        this.doubleMarkerFrets = [12, 24];

        // Interaction state
        this.dragging = null; // { stringIndex }
        this.hoveredString = -1;

        // Note names for string labels
        this.NOTE_NAMES = MidiConstants.NOTE_NAMES;

        // Colors
        this.colors = {};
        this.updateTheme();

        // Bind events
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onMouseLeave = this._onMouseLeave.bind(this);

        canvas.addEventListener('mousedown', this._onMouseDown);
        canvas.addEventListener('mousemove', this._onMouseMove);
        canvas.addEventListener('mouseup', this._onMouseUp);
        canvas.addEventListener('mouseleave', this._onMouseLeave);

        // Touch support
        this._onTouchStart = this._onTouchStart.bind(this);
        this._onTouchMove = this._onTouchMove.bind(this);
        this._onTouchEnd = this._onTouchEnd.bind(this);
        canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        canvas.addEventListener('touchend', this._onTouchEnd);

        this.redraw();
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');

        if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                neck: '#2d1f0e',
                fretWire: '#555555',
                nut: '#999999',
                string: '#888888',
                stringLabel: '#a0aec0',
                fretNumber: '#718096',
                marker: 'rgba(255,255,255,0.06)',
                markerDot: 'rgba(255,255,255,0.15)',
                handle: '#667eea',
                handleHover: '#8899ff',
                handleText: '#ffffff',
                bodyFill: '#1f1508',
                bodyStroke: '#3d2f1a',
                inactiveZone: 'rgba(255,255,255,0.04)',
            };
        } else {
            this.colors = {
                background: '#f0f4ff',
                neck: '#c8b898',
                fretWire: '#a0a0b8',
                nut: '#e8e0d8',
                string: '#5a6089',
                stringLabel: '#5a6089',
                fretNumber: '#9498b8',
                marker: 'rgba(102,126,234,0.1)',
                markerDot: 'rgba(102,126,234,0.25)',
                handle: '#667eea',
                handleHover: '#5a6fd6',
                handleText: '#ffffff',
                bodyFill: '#b8a888',
                bodyStroke: '#a09878',
                inactiveZone: 'rgba(102,126,234,0.06)',
            };
        }
    }

    // ========================================================================
    // CONFIG
    // ========================================================================

    setConfig(options) {
        if (options.numStrings !== undefined) this.numStrings = options.numStrings;
        if (options.numFrets !== undefined) this.numFrets = options.numFrets;
        if (options.tuning !== undefined) this.tuning = options.tuning;
        if (options.isFretless !== undefined) this.isFretless = options.isFretless;

        if (options.fretsPerString) {
            this.fretsPerString = [...options.fretsPerString];
        }

        // Ensure fretsPerString matches numStrings
        while (this.fretsPerString.length < this.numStrings) {
            this.fretsPerString.push(this.numFrets);
        }
        while (this.fretsPerString.length > this.numStrings) {
            this.fretsPerString.pop();
        }

        this.redraw();
    }

    setUniformFrets(numFrets) {
        this.numFrets = numFrets;
        this.fretsPerString = new Array(this.numStrings).fill(numFrets);
        this.redraw();
        if (this.onChange) this.onChange(null); // null = uniform
    }

    getFretsPerString() {
        // If all equal to numFrets, return null (uniform mode)
        if (this.fretsPerString.every(f => f === this.numFrets)) return null;
        return [...this.fretsPerString];
    }

    // ========================================================================
    // LAYOUT HELPERS (vertical orientation)
    // ========================================================================

    _getNeckBounds() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        return {
            x: this.leftMargin,
            y: this.topMargin + this.headHeight,
            width: w - this.leftMargin - this.rightMargin,
            height: h - this.topMargin - this.headHeight - this.bodyHeight - this.bottomMargin
        };
    }

    _getStringX(stringIndex) {
        const neck = this._getNeckBounds();
        const spacing = neck.width / (this.numStrings + 1);
        // String 0 = lowest pitch = leftmost
        return neck.x + (stringIndex + 1) * spacing;
    }

    _getFretY(fretNum) {
        const neck = this._getNeckBounds();
        if (this.numFrets === 0) return neck.y;
        return neck.y + (fretNum / this.numFrets) * neck.height;
    }

    _yToFret(y) {
        const neck = this._getNeckBounds();
        if (this.numFrets === 0) return 0;
        const fret = Math.round(((y - neck.y) / neck.height) * this.numFrets);
        return Math.max(0, Math.min(this.numFrets, fret));
    }

    _getStringAtX(x) {
        const neck = this._getNeckBounds();
        const spacing = neck.width / (this.numStrings + 1);
        for (let i = 0; i < this.numStrings; i++) {
            const sx = this._getStringX(i);
            if (Math.abs(x - sx) < spacing * 0.45) return i;
        }
        return -1;
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

    redraw() {
        const { canvas, ctx } = this;
        const w = canvas.width;
        const h = canvas.height;
        const neck = this._getNeckBounds();

        // Clear
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        // Draw simplified guitar head (top)
        this._drawHead(neck, w);

        // Draw neck background
        ctx.fillStyle = this.colors.neck;
        ctx.fillRect(neck.x, neck.y, neck.width, neck.height);

        // Draw simplified body (bottom)
        this._drawBody(neck, w);

        // Draw fret markers
        this._drawFretMarkers(neck);

        // Draw frets (horizontal lines)
        this._drawFrets(neck);

        // Draw nut (horizontal bar at top)
        this._drawNut(neck);

        // Draw inactive zones per string
        this._drawInactiveZones(neck);

        // Draw strings (vertical lines)
        this._drawStrings(neck);

        // Draw fret numbers (left margin)
        this._drawFretNumbers(neck);

        // Draw draggable handles
        this._drawHandles(neck);
    }

    _drawHead(neck, _w) {
        const ctx = this.ctx;
        const headY = this.topMargin;

        // Simplified head shape (horizontal, at top)
        ctx.fillStyle = this.colors.bodyFill;
        ctx.strokeStyle = this.colors.bodyStroke;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(neck.x - 2, neck.y);
        ctx.lineTo(neck.x + 5, headY + 8);
        ctx.lineTo(neck.x + 12, headY);
        ctx.lineTo(neck.x + neck.width - 12, headY);
        ctx.lineTo(neck.x + neck.width - 5, headY + 8);
        ctx.lineTo(neck.x + neck.width + 2, neck.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    _drawBody(neck, _w) {
        const ctx = this.ctx;
        const bodyY = neck.y + neck.height;
        const bh = this.bodyHeight;
        const centerX = neck.x + neck.width / 2;

        ctx.fillStyle = this.colors.bodyFill;
        ctx.strokeStyle = this.colors.bodyStroke;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(neck.x - 2, bodyY);
        ctx.quadraticCurveTo(neck.x + neck.width * 0.15, bodyY + bh * 0.8, centerX - neck.width * 0.05, bodyY + bh);
        ctx.quadraticCurveTo(centerX, bodyY + bh * 0.7, centerX + neck.width * 0.05, bodyY + bh);
        ctx.quadraticCurveTo(neck.x + neck.width * 0.85, bodyY + bh * 0.8, neck.x + neck.width + 2, bodyY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Sound hole
        ctx.fillStyle = this.colors.background;
        ctx.beginPath();
        ctx.arc(centerX, bodyY + bh * 0.4, Math.min(bh * 0.25, neck.width * 0.12), 0, Math.PI * 2);
        ctx.fill();
    }

    _drawFrets(neck) {
        const ctx = this.ctx;
        ctx.strokeStyle = this.colors.fretWire;

        for (let f = 0; f <= this.numFrets; f++) {
            const y = this._getFretY(f);
            ctx.lineWidth = (f === 0) ? 3 : 1;
            ctx.beginPath();
            ctx.moveTo(neck.x, y);
            ctx.lineTo(neck.x + neck.width, y);
            ctx.stroke();
        }
    }

    _drawNut(neck) {
        const ctx = this.ctx;
        const y = this._getFretY(0);
        ctx.fillStyle = this.colors.nut;
        ctx.fillRect(neck.x, y - 2, neck.width, 5);
    }

    _drawFretMarkers(neck) {
        const ctx = this.ctx;
        const centerX = neck.x + neck.width / 2;

        for (const fretNum of this.markerFrets) {
            if (fretNum > this.numFrets) continue;

            const y1 = this._getFretY(fretNum - 1);
            const y2 = this._getFretY(fretNum);
            const midY = (y1 + y2) / 2;
            const radius = 3;

            ctx.fillStyle = this.colors.markerDot;

            if (this.doubleMarkerFrets.includes(fretNum)) {
                const offset = neck.width * 0.2;
                ctx.beginPath();
                ctx.arc(centerX - offset, midY, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(centerX + offset, midY, radius, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.arc(centerX, midY, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    _drawInactiveZones(neck) {
        const ctx = this.ctx;

        const spacing = neck.width / (this.numStrings + 1);

        for (let i = 0; i < this.numStrings; i++) {
            const fretCount = this.fretsPerString[i];
            if (fretCount >= this.numFrets) continue;

            const stringX = this._getStringX(i);
            const startY = this._getFretY(fretCount);
            const endY = neck.y + neck.height;

            // Draw semi-transparent overlay on inactive zone
            ctx.fillStyle = this.colors.inactiveZone;
            ctx.fillRect(stringX - spacing * 0.4, startY, spacing * 0.8, endY - startY);

            // Dashed border at the boundary
            ctx.strokeStyle = this.colors.handle;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(stringX - spacing * 0.4, startY);
            ctx.lineTo(stringX + spacing * 0.4, startY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    _drawStrings(neck) {
        const ctx = this.ctx;

        for (let i = 0; i < this.numStrings; i++) {
            const x = this._getStringX(i);
            const fretCount = this.fretsPerString[i];
            const endY = this._getFretY(fretCount);

            // Active portion of string (from head through nut to fretCount)
            ctx.strokeStyle = this.colors.string;
            ctx.lineWidth = 1 + (this.numStrings - 1 - i) * 0.4;
            ctx.beginPath();
            ctx.moveTo(x, neck.y - this.headHeight + 10);
            ctx.lineTo(x, endY);
            ctx.stroke();

            // Inactive portion (dimmed)
            if (fretCount < this.numFrets) {
                ctx.strokeStyle = this.colors.string;
                ctx.globalAlpha = 0.2;
                ctx.beginPath();
                ctx.moveTo(x, endY);
                ctx.lineTo(x, neck.y + neck.height + this.bodyHeight * 0.3);
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            } else {
                ctx.beginPath();
                ctx.moveTo(x, endY);
                ctx.lineTo(x, neck.y + neck.height + this.bodyHeight * 0.3);
                ctx.stroke();
            }
        }
    }

    _drawFretNumbers(neck) {
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.fretNumber;
        ctx.font = '8px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        // Show fret numbers at certain intervals
        const step = this.numFrets <= 12 ? 1 : (this.numFrets <= 24 ? 2 : 3);
        for (let f = step; f <= this.numFrets; f += step) {
            const y1 = this._getFretY(f - 1);
            const y2 = this._getFretY(f);
            const midY = (y1 + y2) / 2;
            ctx.fillText(f.toString(), neck.x - 6, midY);
        }
    }

    _drawHandles(_neck) {
        if (this.isFretless) return;

        const ctx = this.ctx;
        const handleRadius = 7;

        for (let i = 0; i < this.numStrings; i++) {
            const x = this._getStringX(i);
            const fretCount = this.fretsPerString[i];
            const y = this._getFretY(fretCount);

            const isHovered = this.hoveredString === i;
            const isDragging = this.dragging && this.dragging.stringIndex === i;

            // Handle circle
            ctx.fillStyle = (isHovered || isDragging) ? this.colors.handleHover : this.colors.handle;
            ctx.globalAlpha = isDragging ? 1.0 : (isHovered ? 0.9 : 0.75);
            ctx.beginPath();
            ctx.arc(x, y, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;

            // Fret number in handle
            ctx.fillStyle = this.colors.handleText;
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(fretCount.toString(), x, y);
        }
    }

    // ========================================================================
    // INTERACTION
    // ========================================================================

    _getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    _onMouseDown(e) {
        const pos = this._getCanvasPos(e);
        const stringIdx = this._getStringAtX(pos.x);
        if (stringIdx < 0 || this.isFretless) return;

        // Check if near the handle
        const handleX = this._getStringX(stringIdx);
        const handleY = this._getFretY(this.fretsPerString[stringIdx]);
        const dist = Math.sqrt((pos.x - handleX) ** 2 + (pos.y - handleY) ** 2);

        if (dist < 14) {
            this.dragging = { stringIndex: stringIdx };
            this.canvas.style.cursor = 'grabbing';
            e.preventDefault();
        }
    }

    _onMouseMove(e) {
        const pos = this._getCanvasPos(e);

        if (this.dragging) {
            const newFret = this._yToFret(pos.y);
            const idx = this.dragging.stringIndex;
            if (newFret !== this.fretsPerString[idx]) {
                this.fretsPerString[idx] = newFret;
                this.redraw();
                if (this.onChange) this.onChange(this.getFretsPerString());
            }
            return;
        }

        // Hover detection
        const stringIdx = this._getStringAtX(pos.x);
        let newHover = -1;
        if (stringIdx >= 0 && !this.isFretless) {
            const handleX = this._getStringX(stringIdx);
            const handleY = this._getFretY(this.fretsPerString[stringIdx]);
            const dist = Math.sqrt((pos.x - handleX) ** 2 + (pos.y - handleY) ** 2);
            if (dist < 14) {
                newHover = stringIdx;
                this.canvas.style.cursor = 'grab';
            } else {
                this.canvas.style.cursor = 'default';
            }
        } else {
            this.canvas.style.cursor = 'default';
        }

        if (newHover !== this.hoveredString) {
            this.hoveredString = newHover;
            this.redraw();
        }
    }

    _onMouseUp() {
        if (this.dragging) {
            this.dragging = null;
            this.canvas.style.cursor = 'default';
            this.redraw();
        }
    }

    _onMouseLeave() {
        if (this.dragging) {
            this.dragging = null;
            this.canvas.style.cursor = 'default';
        }
        if (this.hoveredString >= 0) {
            this.hoveredString = -1;
            this.redraw();
        }
    }

    // Touch events
    _onTouchStart(e) {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        this._onMouseDown({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => e.preventDefault() });
    }

    _onTouchMove(e) {
        if (!this.dragging || e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        this._onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    }

    _onTouchEnd() {
        this._onMouseUp();
    }

    // ========================================================================
    // RESIZE
    // ========================================================================

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.redraw();
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('mouseleave', this._onMouseLeave);
        this.canvas.removeEventListener('touchstart', this._onTouchStart);
        this.canvas.removeEventListener('touchmove', this._onTouchMove);
        this.canvas.removeEventListener('touchend', this._onTouchEnd);
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NeckDiagramConfig;
}
if (typeof window !== 'undefined') {
    window.NeckDiagramConfig = NeckDiagramConfig;
}
