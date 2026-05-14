/**
 * CCPitchbendEditorRenderer — Canvas paint pipeline for CCPitchbendEditor.
 * Extracted per audit §1.3 (god-class split).
 *
 * Owns:
 *   - `render()` — top-level frame paint (grid buffer + center line + data +
 *     selection-rect preview + line-tool preview).
 *   - `renderGridToBuffer()` — paints the static grid to an offscreen canvas
 *     (regenerated only when geometry / viewport / theme changes).
 *   - `renderCenterLine()` — the bipolar 0 line for pitch-bend / aftertouch.
 *   - `renderData()` — staircase polyline + event circles + per-event labels,
 *     with curve previews for the line tool.
 *
 * Accessed via `ccPitchbendEditor.renderer`. CCPitchbendEditor keeps thin
 * delegates (`render`, `_renderCenterLine`, `_renderData`, `_renderGridToBuffer`)
 * so internal callers (BaseLaneEditor RAF, setCC, resize…) are unchanged.
 */
class CCPitchbendEditorRenderer {
    /** @param {CCPitchbendEditor} parent */
    constructor(parent) {
        this.parent = parent;
    }

    render() {
        if (!this.parent.ctx || !this.parent.canvas) return;
        this.parent.ctx.clearRect(0, 0, this.parent.canvas.width, this.parent.canvas.height);

        if (this.parent.gridDirty || !this.parent.gridCanvas) {
            this.renderGridToBuffer();
            this.parent.gridDirty = false;
        }
        if (this.parent.gridCanvas) this.parent.ctx.drawImage(this.parent.gridCanvas, 0, 0);

        this.renderCenterLine();
        this.renderData();

        // Selection rect preview.
        if (this.parent.selectionStart && this.parent.lastMouseX !== undefined) {
            this.parent.ctx.strokeStyle = '#2196F3';
            this.parent.ctx.lineWidth = 1;
            this.parent.ctx.setLineDash([5, 5]);
            this.parent.ctx.strokeRect(this.parent.selectionStart.x, this.parent.selectionStart.y,
                                this.parent.lastMouseX - this.parent.selectionStart.x,
                                this.parent.lastMouseY - this.parent.selectionStart.y);
            this.parent.ctx.setLineDash([]);
        }

        // Line preview with curve.
        if (this.parent.lineStart && this.parent.lastMouseX !== undefined) {
            const endTicks = this.parent.xToTicks(this.parent.lastMouseX);
            const endValue = this.parent._yToValue(this.parent.lastMouseY);
            this.parent.ctx.strokeStyle = '#9E9E9E';
            this.parent.ctx.lineWidth = 1;
            this.parent.ctx.setLineDash([5, 5]);
            this.parent.ctx.beginPath();
            const segments = 30;
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const curveT = this.parent.applyCurve(t);
                const ticks = this.parent.lineStart.ticks + (endTicks - this.parent.lineStart.ticks) * t;
                const value = this.parent.lineStart.value + (endValue - this.parent.lineStart.value) * curveT;
                const x = this.parent.ticksToX(ticks);
                const y = this.parent._valueToY(value);
                if (i === 0) this.parent.ctx.moveTo(x, y);
                else        this.parent.ctx.lineTo(x, y);
            }
            this.parent.ctx.stroke();
            this.parent.ctx.setLineDash([]);
        }
    }

    renderCenterLine() {
        const filteredEvents = this.parent.getFilteredEvents();
        const labelMargin = this.parent._labelMargin();
        const isDark = document.body.classList.contains('dark-mode');

        if (this.parent.currentCC === 'pitchbend') {
            this.parent.ctx.strokeStyle = isDark ? '#888' : '#667eea';
            this.parent.ctx.lineWidth = 2;
            const y = this.parent._valueToY(0);
            this.parent.ctx.beginPath();
            this.parent.ctx.moveTo(labelMargin, y);
            this.parent.ctx.lineTo(this.parent.canvas.width, y);
            this.parent.ctx.stroke();
        } else if (filteredEvents.length === 0) {
            this.parent.ctx.strokeStyle = isDark ? '#666' : '#8898d8';
            this.parent.ctx.lineWidth = 2;
            this.parent.ctx.setLineDash([5, 5]);
            const y = this.parent._valueToY(0);
            this.parent.ctx.beginPath();
            this.parent.ctx.moveTo(labelMargin, y);
            this.parent.ctx.lineTo(this.parent.canvas.width, y);
            this.parent.ctx.stroke();
            this.parent.ctx.setLineDash([]);
        }
    }

    renderGridToBuffer() {
        if (!this.parent.gridCtx) return;
        const ctx = this.parent.gridCtx;
        const labelMargin = this.parent._labelMargin();
        const isDark = document.body.classList.contains('dark-mode');

        ctx.clearRect(0, 0, this.parent.gridCanvas.width, this.parent.gridCanvas.height);

        // Vertical (time) grid.
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;
        const gridSize = this.parent.options.grid;
        const startTick = Math.floor(this.parent.options.xoffset / gridSize) * gridSize;
        const endTick = this.parent.options.xoffset + this.parent.options.xrange;
        for (let t = startTick; t <= endTick; t += gridSize) {
            const x = this.parent.ticksToX(t);
            if (x >= 0 && x <= this.parent.gridCanvas.width) {
                ctx.beginPath();
                ctx.moveTo(Math.max(x, labelMargin), 0);
                ctx.lineTo(x, this.parent.gridCanvas.height);
                ctx.stroke();
            }
        }

        // Value-axis grid + labels.
        const values = this.parent.currentCC === 'pitchbend'
            ? [-8192, -4096, 0, 4096, 8191]
            : [0, 32, 64, 96, 127];
        ctx.strokeStyle = isDark ? '#3a3a3a' : '#d4daff';
        ctx.lineWidth = 1;
        values.forEach(value => {
            const y = this.parent._valueToY(value);
            ctx.beginPath();
            ctx.moveTo(labelMargin, y);
            ctx.lineTo(this.parent.gridCanvas.width, y);
            ctx.stroke();
            ctx.fillStyle = isDark ? '#1a1a1a' : '#f0f4ff';
            ctx.fillRect(0, y - 7, labelMargin - 2, 14);
            ctx.fillStyle = isDark ? '#aaa' : '#5a6089';
            ctx.font = '11px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(value.toString(), labelMargin - 5, y + 4);
        });

        // Label-area separator.
        ctx.strokeStyle = isDark ? '#555' : '#b0b8e8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelMargin, 0);
        ctx.lineTo(labelMargin, this.parent.gridCanvas.height);
        ctx.stroke();

        ctx.textAlign = 'left';
    }

    renderData() {
        const allEvents = this.parent.getFilteredEvents().sort((a, b) => a.ticks - b.ticks);

        // Viewport culling (+1 boundary event so connecting line stays).
        const visStart = this.parent.options.xoffset;
        const visEnd = this.parent.options.xoffset + this.parent.options.xrange;
        let firstVisible = 0;
        let lastVisible = allEvents.length - 1;
        for (let i = 0; i < allEvents.length; i++) {
            if (allEvents[i].ticks >= visStart) {
                firstVisible = Math.max(0, i - 1);
                break;
            }
        }
        for (let i = allEvents.length - 1; i >= 0; i--) {
            if (allEvents[i].ticks <= visEnd) {
                lastVisible = Math.min(allEvents.length - 1, i + 1);
                break;
            }
        }
        const events = allEvents.slice(firstVisible, lastVisible + 1);

        // Staircase polyline.
        if (events.length > 1) {
            this.parent.ctx.strokeStyle = '#4CAF50';
            this.parent.ctx.lineWidth = 2;
            this.parent.ctx.beginPath();
            events.forEach((event, i) => {
                const x = this.parent.ticksToX(event.ticks);
                const y = this.parent._valueToY(event.value);
                if (i === 0) {
                    this.parent.ctx.moveTo(x, y);
                } else {
                    const prev = events[i - 1];
                    const prevY = this.parent._valueToY(prev.value);
                    this.parent.ctx.lineTo(x, prevY);
                    this.parent.ctx.lineTo(x, y);
                }
            });
            this.parent.ctx.stroke();
        } else if (events.length === 1) {
            this.parent.ctx.strokeStyle = '#4CAF50';
            this.parent.ctx.lineWidth = 2;
            this.parent.ctx.beginPath();
            const x = this.parent.ticksToX(events[0].ticks);
            const y = this.parent._valueToY(events[0].value);
            this.parent.ctx.moveTo(x, y);
            this.parent.ctx.lineTo(this.parent.canvas.width, y);
            this.parent.ctx.stroke();
        }

        // Points.
        events.forEach(event => {
            const x = this.parent.ticksToX(event.ticks);
            const y = this.parent._valueToY(event.value);
            const isSelected = this.parent.selectedIds.has(event.id);
            this.parent.ctx.fillStyle = isSelected ? '#FFC107' : '#4CAF50';
            this.parent.ctx.beginPath();
            this.parent.ctx.arc(x, y, isSelected ? 5 : 3, 0, 2 * Math.PI);
            this.parent.ctx.fill();
        });
    }
}

if (typeof window !== 'undefined') {
    window.CCPitchbendEditorRenderer = CCPitchbendEditorRenderer;
}
