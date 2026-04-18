// ============================================================================
// Fichier: public/js/features/FretboardDiagram.js
// Description: Real-time fretboard visualization during playback
//   Shows current finger positions on a vertical fretboard diagram
//   Strings are vertical, frets are horizontal
//   Realistic fret spacing (higher frets are smaller)
//   Scrollable when all frets don't fit on screen
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

        // Layout
        this.topMargin = 30;     // Space for nut and open string labels
        this.bottomMargin = 10;
        this.leftMargin = 30;    // Space for fret numbers
        this.rightMargin = 10;

        // Scroll state
        this.scrollY = 0;       // Pixel scroll offset

        // Active positions: array of { string (1-based), fret, velocity }
        this.activePositions = [];

        // Colors
        this.colors = {};
        this.updateTheme();

        // Fret markers (dots) on standard positions
        this.markerFrets = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
        this.doubleMarkerFrets = [12, 24];

        // Precompute fret positions
        this._fretYCache = null;

        // Click handler for playing notes
        this.canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
        this.canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
    }

    // ========================================================================
    // FRET SPACING — realistic proportional spacing
    // ========================================================================

    /**
     * Compute cumulative Y positions for each fret (0..numFrets).
     * Uses the 12th-root-of-2 rule: each fret is ~5.6% shorter than the previous.
     * Returns array where index = fret number, value = Y pixel position (relative to topMargin).
     */
    _computeFretPositions() {
        const n = this.numFrets;
        // Relative distances from nut for each fret (scale length = 1.0)
        // fretDistance(i) = 1 - 1 / (2^(i/12))
        const positions = [0]; // fret 0 = nut = 0
        for (let i = 1; i <= n; i++) {
            positions.push(1 - 1 / Math.pow(2, i / 12));
        }
        // Total relative length
        const totalRelative = positions[n];

        // Scale to total pixel height
        const minFretH = 14; // Minimum pixel height for the last fret
        const lastFretRelH = (positions[n] - positions[n - 1]) / totalRelative;
        const totalPixels = Math.max(minFretH / lastFretRelH, 200);

        const result = new Array(n + 1);
        for (let i = 0; i <= n; i++) {
            result[i] = (positions[i] / totalRelative) * totalPixels;
        }
        this._totalFretboardHeight = totalPixels;
        this._fretYCache = result;
        return result;
    }

    /**
     * Get pixel Y for a fret number, accounting for scroll
     */
    _getFretY(fretNum) {
        if (!this._fretYCache) this._computeFretPositions();
        const f = Math.max(0, Math.min(this.numFrets, fretNum));
        return this.topMargin + this._fretYCache[f] - this.scrollY;
    }

    /**
     * Total fretboard pixel height (may exceed canvas)
     */
    _getTotalHeight() {
        if (!this._fretYCache) this._computeFretPositions();
        return this._totalFretboardHeight;
    }

    /**
     * Max scroll value
     */
    _getMaxScroll() {
        const viewH = this.canvas.height - this.topMargin - this.bottomMargin;
        return Math.max(0, this._getTotalHeight() - viewH);
    }

    // ========================================================================
    // MOUSE INTERACTION
    // ========================================================================

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Find closest string
        let closestString = 1;
        let minDist = Infinity;
        for (let s = 1; s <= this.numStrings; s++) {
            const sx = this._getStringX(s);
            const dist = Math.abs(mx - sx);
            if (dist < minDist) {
                minDist = dist;
                closestString = s;
            }
        }

        // Determine fret: find which space between two fret wires the click falls in
        let clickedFret = 0;
        if (my < this._getFretY(0)) {
            clickedFret = 0; // Above nut = open string
        } else {
            // Check each fret space from fret 1 to numFrets
            for (let f = 1; f <= this.numFrets; f++) {
                const yTop = this._getFretY(f - 1);
                const yBot = this._getFretY(f);
                if (my >= yTop && my < yBot) {
                    clickedFret = f;
                    break;
                }
            }
            // If below the last fret, use the last fret
            if (clickedFret === 0 && my >= this._getFretY(0)) {
                clickedFret = this.numFrets;
            }
        }

        // Calculate MIDI note
        const openNote = this.tuning[closestString - 1] + this.capoFret;
        const midiNote = openNote + clickedFret;

        if (midiNote >= 0 && midiNote <= 127) {
            this.canvas.dispatchEvent(new CustomEvent('fretboard:click', {
                detail: { string: closestString, fret: clickedFret, midiNote },
                bubbles: false
            }));
        }
    }

    _onWheel(e) {
        e.preventDefault();
        const maxScroll = this._getMaxScroll();
        if (maxScroll <= 0) return;

        this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY + e.deltaY));
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
        this._fretYCache = null; // Invalidate cache
        this.scrollY = 0;
        this.redraw();
    }

    /**
     * Set active finger positions for display
     * @param {Array<{string: number, fret: number, velocity: number}>} positions
     */
    setActivePositions(positions) {
        this.activePositions = positions || [];

        // Auto-scroll to show active positions
        if (this.activePositions.length > 0) {
            const frettedPositions = this.activePositions.filter(p => p.fret > 0);
            if (frettedPositions.length > 0) {
                const minFret = Math.min(...frettedPositions.map(p => p.fret));
                const maxFret = Math.max(...frettedPositions.map(p => p.fret));
                const yMin = this._fretYCache ? this._fretYCache[Math.max(0, minFret - 1)] : 0;
                const yMax = this._fretYCache ? this._fretYCache[Math.min(this.numFrets, maxFret)] : 0;
                const viewH = this.canvas.height - this.topMargin - this.bottomMargin;

                if (yMin - this.scrollY < 0 || yMax - this.scrollY > viewH) {
                    this.scrollY = Math.max(0, yMin - 20);
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
        if (!this._fretYCache) this._computeFretPositions();

        const { canvas, ctx } = this;
        const w = canvas.width;
        const h = canvas.height;

        // Clear
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(0, 0, w, h);

        // Clip to content area (below top margin)
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, this.topMargin, w, h - this.topMargin - this.bottomMargin);
        ctx.clip();

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

        // Draw fret numbers
        this._drawFretNumbers(w, h);

        // Draw active positions (fingers)
        this._drawActivePositions(w, h);

        ctx.restore();

        // Draw string labels (above clip region)
        this._drawStringLabels(w, h);

        // Draw scrollbar if needed
        this._drawScrollbar(w, h);
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

        for (let f = 0; f <= this.numFrets; f++) {
            const y = this._getFretY(f);
            ctx.lineWidth = (f === 0) ? 3 : 1;
            ctx.beginPath();
            ctx.moveTo(this._getStringX(1) - 5, y);
            ctx.lineTo(this._getStringX(this.numStrings) + 5, y);
            ctx.stroke();
        }
    }

    _drawNut(_w, _h) {
        const y = this._getFretY(0);
        if (y < this.topMargin - 10 || y > this.canvas.height) return;

        const ctx = this.ctx;
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

        for (let f = 1; f <= this.numFrets; f++) {
            const y1 = this._getFretY(f - 1);
            const y2 = this._getFretY(f);
            const midY = (y1 + y2) / 2;

            ctx.fillText(f.toString(), this.leftMargin - 6, midY);
        }
    }

    _drawFretMarkers(_w, _h) {
        const ctx = this.ctx;
        ctx.fillStyle = this.colors.marker;

        const centerX = (this._getStringX(1) + this._getStringX(this.numStrings)) / 2;

        for (let f = 1; f <= this.numFrets; f++) {
            if (!this.markerFrets.includes(f)) continue;

            const y1 = this._getFretY(f - 1);
            const y2 = this._getFretY(f);
            const midY = (y1 + y2) / 2;
            const fretH = y2 - y1;
            const radius = Math.min(5, fretH * 0.3);

            if (this.doubleMarkerFrets.includes(f)) {
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
                ctx.fillStyle = this.colors.mutedString;
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('X', x, this.topMargin - 12);
            } else if (pos.fret === 0) {
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
                const y1 = this._getFretY(pos.fret - 1);
                const y2 = this._getFretY(pos.fret);
                const midY = (y1 + y2) / 2;
                const fretH = y2 - y1;
                const dotR = Math.min(8, fretH * 0.35);

                const alpha = 0.5 + (pos.velocity || 100) / 254;

                ctx.globalAlpha = alpha;
                ctx.fillStyle = this.colors.fingerDot;
                ctx.beginPath();
                ctx.arc(x, midY, dotR, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;

                ctx.fillStyle = this.colors.fingerText;
                ctx.font = `bold ${Math.min(10, fretH * 0.5)}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(pos.fret.toString(), x, midY);
            }
        }

        ctx.textAlign = 'left'; // Reset
    }

    _drawScrollbar(w, h) {
        const maxScroll = this._getMaxScroll();
        if (maxScroll <= 0) return;

        const ctx = this.ctx;
        const viewH = h - this.topMargin - this.bottomMargin;
        const totalH = this._getTotalHeight();
        const barH = Math.max(20, (viewH / totalH) * viewH);
        const barY = this.topMargin + (this.scrollY / maxScroll) * (viewH - barH);

        ctx.fillStyle = 'rgba(128, 128, 128, 0.3)';
        ctx.fillRect(w - 5, barY, 4, barH);
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
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
