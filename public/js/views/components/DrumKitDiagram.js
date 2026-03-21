// ============================================================================
// Fichier: public/js/views/components/DrumKitDiagram.js
// Description: Real-time drum kit visualization during playback
//   Shows a visual drum kit layout with hit animations
//   Drum pads light up when notes are played, with velocity-based intensity
// ============================================================================

class DrumKitDiagram {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Active hits: array of { note, velocity, timestamp }
        this.activeHits = [];
        this.hitDecayMs = options.hitDecayMs || 300;

        // Colors
        this.colors = {};
        this.updateTheme();

        // Drum pad layout — visual positions on a kit
        // Each pad: { note, label, shortLabel, x, y, w, h, shape, category }
        // Coordinates are in normalized 0-1 space, mapped to canvas size
        this.pads = this._buildPadLayout();

        // Animation frame
        this._animFrame = null;
        this._isAnimating = false;
    }

    // ========================================================================
    // THEME
    // ========================================================================

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        const isColored = document.body.classList.contains('theme-colored');
        if (isColored) {
            this.colors = {
                background: '#f0f4ff',
                padBg: '#e0e4f0',
                padBorder: '#b0b8e8',
                padText: '#5a6089',
                kick: '#667eea',
                snare: '#ef476f',
                hihat: '#06d6a0',
                tom: '#ffd166',
                crash: '#118ab2',
                ride: '#073b4c',
                latin: '#9b59b6',
                misc: '#8e99a4',
                hitGlow: 'rgba(102,126,234,0.4)',
                label: '#5a6089',
            };
        } else if (isDark) {
            this.colors = {
                background: '#1a1a2e',
                padBg: '#2d3748',
                padBorder: '#4a5568',
                padText: '#a0aec0',
                kick: '#667eea',
                snare: '#ff4444',
                hihat: '#28a745',
                tom: '#ffc107',
                crash: '#17a2b8',
                ride: '#6c757d',
                latin: '#9b59b6',
                misc: '#6c757d',
                hitGlow: 'rgba(102,126,234,0.5)',
                label: '#a0aec0',
            };
        } else {
            this.colors = {
                background: '#f5f0e8',
                padBg: '#e8e0d8',
                padBorder: '#c0b8a8',
                padText: '#555555',
                kick: '#667eea',
                snare: '#dc3545',
                hihat: '#28a745',
                tom: '#fd7e14',
                crash: '#0dcaf0',
                ride: '#6c757d',
                latin: '#9b59b6',
                misc: '#adb5bd',
                hitGlow: 'rgba(102,126,234,0.3)',
                label: '#666666',
            };
        }
    }

    // ========================================================================
    // PAD LAYOUT
    // ========================================================================

    _buildPadLayout() {
        // Visual drum kit layout (normalized coordinates 0-1)
        // Top row: crashes/rides
        // Middle row: hi-hat, toms, ride
        // Bottom row: snare, kick
        return [
            // Crashes (top)
            { note: 49, label: 'Crash 1', shortLabel: 'CR1', x: 0.12, y: 0.02, w: 0.18, h: 0.14, shape: 'circle', category: 'crash' },
            { note: 57, label: 'Crash 2', shortLabel: 'CR2', x: 0.70, y: 0.02, w: 0.18, h: 0.14, shape: 'circle', category: 'crash' },
            { note: 55, label: 'Splash', shortLabel: 'SPL', x: 0.41, y: 0.00, w: 0.14, h: 0.11, shape: 'circle', category: 'crash' },
            { note: 52, label: 'China', shortLabel: 'CHN', x: 0.88, y: 0.05, w: 0.11, h: 0.10, shape: 'circle', category: 'crash' },

            // Hi-hat (left)
            { note: 42, label: 'Closed HH', shortLabel: 'HH', x: 0.02, y: 0.20, w: 0.16, h: 0.14, shape: 'circle', category: 'hihat' },
            { note: 46, label: 'Open HH', shortLabel: 'OH', x: 0.02, y: 0.36, w: 0.14, h: 0.12, shape: 'circle', category: 'hihat' },
            { note: 44, label: 'Pedal HH', shortLabel: 'PH', x: 0.04, y: 0.50, w: 0.12, h: 0.10, shape: 'rect', category: 'hihat' },

            // Rides (right)
            { note: 51, label: 'Ride 1', shortLabel: 'RD1', x: 0.72, y: 0.18, w: 0.18, h: 0.14, shape: 'circle', category: 'ride' },
            { note: 59, label: 'Ride 2', shortLabel: 'RD2', x: 0.84, y: 0.34, w: 0.14, h: 0.12, shape: 'circle', category: 'ride' },
            { note: 53, label: 'Ride Bell', shortLabel: 'RB', x: 0.78, y: 0.28, w: 0.10, h: 0.09, shape: 'circle', category: 'ride' },

            // Toms (middle row)
            { note: 50, label: 'High Tom', shortLabel: 'HT', x: 0.28, y: 0.18, w: 0.16, h: 0.15, shape: 'circle', category: 'tom' },
            { note: 48, label: 'Hi-Mid Tom', shortLabel: 'MT', x: 0.48, y: 0.17, w: 0.16, h: 0.15, shape: 'circle', category: 'tom' },
            { note: 47, label: 'Lo-Mid Tom', shortLabel: 'LM', x: 0.60, y: 0.36, w: 0.16, h: 0.16, shape: 'circle', category: 'tom' },
            { note: 45, label: 'Low Tom', shortLabel: 'LT', x: 0.66, y: 0.54, w: 0.17, h: 0.17, shape: 'circle', category: 'tom' },
            { note: 43, label: 'Hi Floor Tom', shortLabel: 'FT1', x: 0.72, y: 0.72, w: 0.17, h: 0.17, shape: 'circle', category: 'tom' },
            { note: 41, label: 'Lo Floor Tom', shortLabel: 'FT2', x: 0.80, y: 0.82, w: 0.17, h: 0.17, shape: 'circle', category: 'tom' },

            // Snare (center-left)
            { note: 38, label: 'Snare', shortLabel: 'SN', x: 0.22, y: 0.40, w: 0.20, h: 0.18, shape: 'circle', category: 'snare' },
            { note: 40, label: 'Elec Snare', shortLabel: 'ES', x: 0.22, y: 0.40, w: 0.20, h: 0.18, shape: 'circle', category: 'snare' },
            { note: 37, label: 'Side Stick', shortLabel: 'SS', x: 0.18, y: 0.58, w: 0.12, h: 0.10, shape: 'rect', category: 'snare' },
            { note: 39, label: 'Hand Clap', shortLabel: 'CLP', x: 0.32, y: 0.58, w: 0.12, h: 0.10, shape: 'rect', category: 'snare' },

            // Kick (bottom center)
            { note: 36, label: 'Bass Drum', shortLabel: 'BD', x: 0.30, y: 0.70, w: 0.28, h: 0.26, shape: 'circle', category: 'kick' },
            { note: 35, label: 'Acoustic Kick', shortLabel: 'AK', x: 0.30, y: 0.70, w: 0.28, h: 0.26, shape: 'circle', category: 'kick' },

            // Misc percussion (bottom row)
            { note: 54, label: 'Tambourine', shortLabel: 'TMB', x: 0.02, y: 0.65, w: 0.12, h: 0.10, shape: 'rect', category: 'misc' },
            { note: 56, label: 'Cowbell', shortLabel: 'CB', x: 0.02, y: 0.78, w: 0.12, h: 0.10, shape: 'rect', category: 'misc' },
            { note: 70, label: 'Maracas', shortLabel: 'MRC', x: 0.02, y: 0.88, w: 0.12, h: 0.10, shape: 'rect', category: 'misc' },
        ];
    }

    // ========================================================================
    // HIT MANAGEMENT
    // ========================================================================

    /**
     * Trigger a hit on a drum pad
     * @param {number} note - MIDI note number
     * @param {number} velocity - Hit velocity (0-127)
     */
    hit(note, velocity = 100) {
        this.activeHits.push({
            note,
            velocity,
            timestamp: performance.now()
        });

        if (!this._isAnimating) {
            this._startAnimation();
        }
    }

    /**
     * Set multiple active notes at once (for playback cursor sync)
     * @param {Array<{note: number, velocity: number}>} notes
     */
    setActiveNotes(notes) {
        const now = performance.now();
        // Clear old hits and add new ones
        this.activeHits = (notes || []).map(n => ({
            note: n.note || n.n,
            velocity: n.velocity || n.v || 100,
            timestamp: now
        }));

        if (!this._isAnimating && this.activeHits.length > 0) {
            this._startAnimation();
        }
        this.redraw();
    }

    clearActiveNotes() {
        this.activeHits = [];
        this.redraw();
    }

    // ========================================================================
    // ANIMATION
    // ========================================================================

    _startAnimation() {
        this._isAnimating = true;
        const animate = () => {
            const now = performance.now();
            // Remove expired hits
            this.activeHits = this.activeHits.filter(h => now - h.timestamp < this.hitDecayMs);

            this.redraw();

            if (this.activeHits.length > 0) {
                this._animFrame = requestAnimationFrame(animate);
            } else {
                this._isAnimating = false;
            }
        };
        this._animFrame = requestAnimationFrame(animate);
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

        const now = performance.now();

        // Build active note map: note → max intensity (0-1)
        const activeMap = new Map();
        for (const hit of this.activeHits) {
            const age = now - hit.timestamp;
            const decay = 1 - (age / this.hitDecayMs);
            const intensity = decay * (hit.velocity / 127);
            const existing = activeMap.get(hit.note) || 0;
            activeMap.set(hit.note, Math.max(existing, intensity));
        }

        // Draw each pad
        for (const pad of this.pads) {
            this._drawPad(pad, w, h, activeMap.get(pad.note) || 0);
        }
    }

    _drawPad(pad, canvasW, canvasH, intensity) {
        const ctx = this.ctx;
        const x = pad.x * canvasW;
        const y = pad.y * canvasH;
        const pw = pad.w * canvasW;
        const ph = pad.h * canvasH;
        const cx = x + pw / 2;
        const cy = y + ph / 2;
        const radius = Math.min(pw, ph) / 2;

        const categoryColor = this.colors[pad.category] || this.colors.misc;

        // Draw pad shape
        if (pad.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);

            if (intensity > 0) {
                // Active: glow + fill with category color
                ctx.fillStyle = categoryColor;
                ctx.globalAlpha = 0.3 + intensity * 0.7;
                ctx.fill();
                ctx.globalAlpha = 1.0;

                // Glow ring
                ctx.strokeStyle = categoryColor;
                ctx.lineWidth = 2 + intensity * 3;
                ctx.globalAlpha = intensity;
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            } else {
                // Inactive
                ctx.fillStyle = this.colors.padBg;
                ctx.fill();
                ctx.strokeStyle = this.colors.padBorder;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        } else {
            // Rectangle (for pedals, misc)
            const rx = x;
            const ry = y;
            const rr = 4;

            ctx.beginPath();
            ctx.roundRect(rx, ry, pw, ph, rr);

            if (intensity > 0) {
                ctx.fillStyle = categoryColor;
                ctx.globalAlpha = 0.3 + intensity * 0.7;
                ctx.fill();
                ctx.globalAlpha = 1.0;

                ctx.strokeStyle = categoryColor;
                ctx.lineWidth = 2 + intensity * 2;
                ctx.globalAlpha = intensity;
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            } else {
                ctx.fillStyle = this.colors.padBg;
                ctx.fill();
                ctx.strokeStyle = this.colors.padBorder;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // Label
        const fontSize = Math.max(8, Math.min(12, radius * 0.6));
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = intensity > 0.3 ? '#ffffff' : this.colors.padText;
        ctx.globalAlpha = intensity > 0 ? 1 : 0.8;
        ctx.fillText(pad.shortLabel, cx, cy);
        ctx.globalAlpha = 1.0;

        ctx.textAlign = 'left'; // Reset
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.redraw();
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
        }
        this.activeHits = [];
        this._isAnimating = false;
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DrumKitDiagram;
}
if (typeof window !== 'undefined') {
    window.DrumKitDiagram = DrumKitDiagram;
}
