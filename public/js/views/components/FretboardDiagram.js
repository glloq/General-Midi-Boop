// ============================================================================
// Fichier: public/js/views/components/FretboardDiagram.js
// Description: Real-time fretboard visualization during playback
//   Shows current finger positions on a vertical fretboard diagram
//   Strings are vertical, frets are horizontal
// ============================================================================

class FretboardDiagram {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Instrument config (tuning array length is authoritative for string count)
        this.tuning = options.tuning || [40, 45, 50, 55, 59, 64];
        this.numStrings = this.tuning.length;
        this.numFrets = options.numFrets || 24;
        this.isFretless = options.isFretless || false;
        this.capoFret = options.capoFret || 0;
        this.visibleFrets = Math.min(options.visibleFrets || 12, this.numFrets || 12);

        // Layout
        this.topMargin = 30;     // Space for nut and open string labels
        this.bottomMargin = 10;
        this.leftMargin = 30;    // Space for fret numbers
        this.rightMargin = 10;

        // Active positions: array of { string (1-based), fret, velocity }
        this.activePositions = [];

        // Fret window (for scrolling along the neck)
        this.fretOffset = 0;  // First visible fret

        // Colors
        this.colors = {};
        this.updateTheme();

        // Fret markers (dots) on standard positions
        this.markerFrets = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
        this.doubleMarkerFrets = [12, 24];
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                fretboard: '#2d1f0e',
                fretWire: '#888888',
                nut: '#cccccc',
                string: '#b0b0b0',
                stringLabel: '#a0aec0',
                fretNumber: '#718096',
                fingerDot: '#667eea',
                fingerDotActive: '#ff4444',
                fingerText: '#ffffff',
                openString: '#28a745',
                mutedString: '#dc3545',
                marker: 'rgba(255,255,255,0.1)',
            };
        } else {
            this.colors = {
                background: '#f0f4ff',
                fretboard: '#c8b898',
                fretWire: '#a0a0b8',
                nut: '#e8e0d8',
                string: '#5a6089',
                stringLabel: '#5a6089',
                fretNumber: '#9498b8',
                fingerDot: '#667eea',
                fingerDotActive: '#ef476f',
                fingerText: '#ffffff',
                openString: '#06d6a0',
                mutedString: '#ef476f',
                marker: 'rgba(102,126,234,0.08)',
            };
        }
    }

    // ========================================================================
    // CONFIG
    // ========================================================================

    setInstrumentConfig(config) {
        this.tuning = config.tuning || [40, 45, 50, 55, 59, 64];
        this.numStrings = this.tuning.length;
        this.numFrets = config.num_frets || config.numFrets || 24;
        this.isFretless = config.is_fretless || config.isFretless || false;
        this.visibleFrets = Math.min(12, this.numFrets || 12);
        this.redraw();
    }

    /**
     * Set active finger positions for display
     * @param {Array<{string: number, fret: number, velocity: number}>} positions
     */
    setActivePositions(positions) {
        this.activePositions = positions || [];

        // Auto-scroll fret window to show active positions
        if (this.activePositions.length > 0) {
            const frettedPositions = this.activePositions.filter(p => p.fret > 0);
            if (frettedPositions.length > 0) {
                const minFret = Math.min(...frettedPositions.map(p => p.fret));
                const maxFret = Math.max(...frettedPositions.map(p => p.fret));

                // Adjust window if active frets are outside visible range
                if (minFret < this.fretOffset + 1 || maxFret > this.fretOffset + this.visibleFrets) {
                    this.fretOffset = Math.max(0, minFret - 2);
                }
            }
        }

        this.redraw();
    }

    clearActivePositions() {
        this.activePositions = [];
        this.redraw();
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

    redraw() {
        const { canvas, ctx } = this;
        const w = canvas.width;
        const h = canvas.height;

        // Clear
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        // Draw fretboard background
        this._drawFretboard(w, h);

        // Draw fret markers (dots)
        this._drawFretMarkers(w, h);

        // Draw frets
        this._drawFrets(w, h);

        // Draw nut (if visible)
        this._drawNut(w, h);

        // Draw strings
        this._drawStrings(w, h);

        // Draw string labels
        this._drawStringLabels(w, h);

        // Draw fret numbers
        this._drawFretNumbers(w, h);

        // Draw active positions (fingers)
        this._drawActivePositions(w, h);
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.redraw();
    }

    // ========================================================================
    // DRAWING
    // ========================================================================

    _getStringX(stringNum) {
        // stringNum is 1-based (1 = lowest pitch = left, numStrings = highest = right)
        const usableWidth = this.canvas.width - this.leftMargin - this.rightMargin;
        const spacing = usableWidth / (this.numStrings - 1 || 1);
        return this.leftMargin + (stringNum - 1) * spacing;
    }

    _getFretY(fretNum) {
        // fretNum relative to fretOffset
        const relativeFret = fretNum - this.fretOffset;
        const usableHeight = this.canvas.height - this.topMargin - this.bottomMargin;
        const fretSpacing = usableHeight / this.visibleFrets;
        return this.topMargin + relativeFret * fretSpacing;
    }

    _drawFretboard(w, h) {
        const ctx = this.ctx;
        const x1 = this._getStringX(1) - 5;
        const x2 = this._getStringX(this.numStrings) + 5;
        ctx.fillStyle = this.colors.fretboard;
        ctx.fillRect(x1, this.topMargin, x2 - x1, h - this.topMargin - this.bottomMargin);
    }

    _drawFrets(_w, _h) {
        const ctx = this.ctx;
        ctx.strokeStyle = this.colors.fretWire;

        for (let f = 0; f <= this.visibleFrets; f++) {
            const fretNum = f + this.fretOffset;
            if (fretNum > this.numFrets) break;

            const y = this._getFretY(fretNum);
            ctx.lineWidth = (fretNum === 0) ? 3 : 1;
            ctx.beginPath();
            ctx.moveTo(this._getStringX(1) - 5, y);
            ctx.lineTo(this._getStringX(this.numStrings) + 5, y);
            ctx.stroke();
        }
    }

    _drawNut(_w, _h) {
        if (this.fretOffset > 0) return;

        const ctx = this.ctx;
        const y = this._getFretY(0);
        ctx.fillStyle = this.colors.nut;
        ctx.fillRect(
            this._getStringX(1) - 5,
            y - 3,
            this._getStringX(this.numStrings) - this._getStringX(1) + 10,
            6
        );
    }

    _drawStrings(w, h) {
        const ctx = this.ctx;

        // Build set of active string numbers for highlight
        const activeStringSet = new Set();
        for (const pos of this.activePositions) {
            activeStringSet.add(pos.string);
        }

        for (let s = 1; s <= this.numStrings; s++) {
            const x = this._getStringX(s);
            const isActive = activeStringSet.has(s);

            // Active strings glow with accent color
            if (isActive) {
                // Glow effect behind the string
                ctx.strokeStyle = this.colors.fingerDot;
                ctx.lineWidth = 6 + (this.numStrings - s) * 0.5;
                ctx.globalAlpha = 0.25;
                ctx.beginPath();
                ctx.moveTo(x, this.topMargin);
                ctx.lineTo(x, h - this.bottomMargin);
                ctx.stroke();
                ctx.globalAlpha = 1.0;

                ctx.strokeStyle = this.colors.fingerDot;
            } else {
                ctx.strokeStyle = this.colors.string;
            }

            // String thickness varies (thicker for lower strings)
            ctx.lineWidth = 1 + (this.numStrings - s) * 0.3;
            ctx.beginPath();
            ctx.moveTo(x, this.topMargin);
            ctx.lineTo(x, h - this.bottomMargin);
            ctx.stroke();
        }
    }

    _drawStringLabels(_w, _h) {
        const ctx = this.ctx;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Build set of active string numbers for highlight
        const activeStringSet = new Set();
        for (const pos of this.activePositions) {
            activeStringSet.add(pos.string);
        }

        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        for (let s = 1; s <= this.numStrings; s++) {
            const x = this._getStringX(s);
            const midiNote = this.tuning[s - 1] + this.capoFret;
            const name = noteNames[midiNote % 12];

            if (activeStringSet.has(s)) {
                // Highlight active string label
                ctx.fillStyle = this.colors.fingerDot;
                ctx.font = 'bold 11px monospace';
                ctx.fillText(name, x, this.topMargin - 2);
                ctx.font = 'bold 10px monospace';
            } else {
                ctx.fillStyle = this.colors.stringLabel;
                ctx.fillText(name, x, this.topMargin - 2);
            }
        }
    }

    _drawFretNumbers(_w, _h) {
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.fretNumber;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let f = 1; f <= this.visibleFrets; f++) {
            const fretNum = f + this.fretOffset;
            if (fretNum > this.numFrets) break;

            const y1 = this._getFretY(fretNum - 1);
            const y2 = this._getFretY(fretNum);
            const midY = (y1 + y2) / 2;

            ctx.fillText(fretNum.toString(), this.leftMargin - 6, midY);
        }
    }

    _drawFretMarkers(_w, _h) {
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.marker;

        const centerX = (this._getStringX(1) + this._getStringX(this.numStrings)) / 2;

        for (let f = 1; f <= this.visibleFrets; f++) {
            const fretNum = f + this.fretOffset;
            if (!this.markerFrets.includes(fretNum)) continue;

            const y1 = this._getFretY(fretNum - 1);
            const y2 = this._getFretY(fretNum);
            const midY = (y1 + y2) / 2;
            const radius = 5;

            if (this.doubleMarkerFrets.includes(fretNum)) {
                // Double dot
                const offset = (this._getStringX(this.numStrings) - this._getStringX(1)) * 0.25;
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

    _drawActivePositions(_w, _h) {
        const ctx = this.ctx;

        for (const pos of this.activePositions) {
            const x = this._getStringX(pos.string);

            if (pos.muted) {
                // Muted string — draw X above nut
                ctx.fillStyle = this.colors.mutedString;
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('X', x, this.topMargin - 12);
            } else if (pos.fret === 0) {
                // Open string — draw circle above nut
                ctx.fillStyle = this.colors.openString;
                ctx.beginPath();
                ctx.arc(x, this.topMargin - 12, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = this.colors.fingerText;
                ctx.font = 'bold 9px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('O', x, this.topMargin - 12);
            } else {
                // Fretted position
                const relativeFret = pos.fret - this.fretOffset;
                if (relativeFret < 0 || relativeFret > this.visibleFrets) continue;

                const y1 = this._getFretY(pos.fret - 1);
                const y2 = this._getFretY(pos.fret);
                const midY = (y1 + y2) / 2;

                // Velocity maps to opacity
                const alpha = 0.5 + (pos.velocity || 100) / 254;

                ctx.globalAlpha = alpha;
                ctx.fillStyle = this.colors.fingerDot;
                ctx.beginPath();
                ctx.arc(x, midY, 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;

                // Fret number text
                ctx.fillStyle = this.colors.fingerText;
                ctx.font = 'bold 10px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(pos.fret.toString(), x, midY);
            }
        }

        ctx.textAlign = 'left'; // Reset
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        // No event listeners to remove for now
        this.activePositions = [];
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FretboardDiagram;
}
if (typeof window !== 'undefined') {
    window.FretboardDiagram = FretboardDiagram;
}
