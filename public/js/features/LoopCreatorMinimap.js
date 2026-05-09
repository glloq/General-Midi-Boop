/**
 * @file LoopCreatorMinimap.js
 * Standalone canvas minimap for the Loop Creator piano-roll editor.
 *
 * Renders a full-file overview with:
 *   - beat / bar grid lines and bar-number labels
 *   - note rectangles (pitch mapped vertically)
 *   - current viewport rectangle (piano-roll's visible window)
 *   - playhead line
 *
 * Click or drag = seek. Touch-enabled.
 *
 * Public API:
 *   const m = new LoopCreatorMinimap(canvas, {
 *       ppq, timeSigNum, bars, noteMin, noteMax,
 *       onSeek: (newXOffset) => { … }   // ticks
 *   });
 *   m.setNotes(sequence);                 // [{t, n, g?, l?}]
 *   m.setViewport(xoffset, xrange);       // ticks
 *   m.setPlayhead(cursorTick, isPlaying);
 *   m.setConfig({ ppq, timeSigNum, bars, noteMin, noteMax });
 *   m.draw();    // force immediate redraw
 *   m.destroy();
 */
(function() {
    'use strict';

    class LoopCreatorMinimap {
        constructor(canvas, opts = {}) {
            this.canvas     = canvas;
            this.ppq        = Number.isFinite(opts.ppq)        && opts.ppq        > 0 ? opts.ppq        : 480;
            this.timeSigNum = Number.isFinite(opts.timeSigNum) && opts.timeSigNum > 0 ? opts.timeSigNum : 4;
            this.bars       = Number.isFinite(opts.bars)       && opts.bars       > 0 ? opts.bars       : 2;
            this.noteMin    = Number.isFinite(opts.noteMin) ? opts.noteMin : 36;
            this.noteMax    = Number.isFinite(opts.noteMax) ? opts.noteMax : 84;
            this.onSeek     = typeof opts.onSeek === 'function' ? opts.onSeek : null;

            this._notes     = [];
            this._xoffset   = 0;
            this._xrange    = 0;
            this._cursor    = 0;
            this._isPlaying = false;
            this._dragging  = false;
            this._dirty     = false;
            this._rafHandle = null;

            if (canvas?.addEventListener) {
                this._onMouseDown  = (e) => { this._dragging = true;  this._seek(e.clientX); };
                this._onMouseMove  = (e) => { if (this._dragging) this._seek(e.clientX); };
                this._onMouseUp    = ()  => { this._dragging = false; };
                this._onMouseLeave = ()  => { this._dragging = false; };
                this._onTouchStart = (e) => { e.preventDefault(); this._dragging = true;  this._seek(e.touches[0].clientX); };
                this._onTouchMove  = (e) => { e.preventDefault(); if (this._dragging) this._seek(e.touches[0].clientX); };
                this._onTouchEnd   = ()  => { this._dragging = false; };
                this._onKeyDown    = (e) => this._handleKeyDown(e);

                canvas.addEventListener('mousedown',  this._onMouseDown);
                canvas.addEventListener('mousemove',  this._onMouseMove);
                canvas.addEventListener('mouseup',    this._onMouseUp);
                canvas.addEventListener('mouseleave', this._onMouseLeave);
                canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
                canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
                canvas.addEventListener('touchend',   this._onTouchEnd);
                canvas.addEventListener('keydown',    this._onKeyDown);
            }
        }

        // -----------------------------------------------------------------
        //  Public setters — each schedules a coalesced rAF draw
        // -----------------------------------------------------------------

        setNotes(seq) {
            this._notes = Array.isArray(seq) ? seq : [];
            this._scheduleDraw();
        }

        setViewport(xoffset, xrange) {
            this._xoffset = Number.isFinite(xoffset) ? xoffset : 0;
            this._xrange  = Number.isFinite(xrange)  ? xrange  : 0;
            this._scheduleDraw();
        }

        setPlayhead(cursor, isPlaying) {
            this._cursor    = Number.isFinite(cursor) ? cursor : 0;
            this._isPlaying = !!isPlaying;
            this._scheduleDraw();
        }

        setConfig({ ppq, timeSigNum, bars, noteMin, noteMax } = {}) {
            if (Number.isFinite(ppq)        && ppq        > 0) this.ppq        = ppq;
            if (Number.isFinite(timeSigNum) && timeSigNum > 0) this.timeSigNum = timeSigNum;
            if (Number.isFinite(bars)       && bars       > 0) this.bars       = bars;
            if (Number.isFinite(noteMin)) this.noteMin = noteMin;
            if (Number.isFinite(noteMax)) this.noteMax = noteMax;
            this._scheduleDraw();
        }

        // -----------------------------------------------------------------
        //  rAF coalescing
        // -----------------------------------------------------------------

        _scheduleDraw() {
            this._dirty = true;
            if (this._rafHandle != null) return;
            this._rafHandle = window.requestAnimationFrame(() => {
                this._rafHandle = null;
                if (this._dirty) this.draw();
            });
        }

        // -----------------------------------------------------------------
        //  Seek interaction
        // -----------------------------------------------------------------

        _seek(clientX) {
            if (!this.canvas || !this.onSeek) return;
            const rect  = this.canvas.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const total  = this._totalTicks();
            const xrange = this._xrange || total;
            const newOffset = Math.max(0, Math.min(total - xrange,
                Math.round(ratio * total - xrange / 2)));
            this.onSeek(newOffset);
        }

        // Keyboard navigation: Left/Right ±beat, Shift+Left/Right ±bar, Home/End extremes.
        _handleKeyDown(e) {
            if (!this.onSeek) return;
            const total  = this._totalTicks();
            const xrange = this._xrange || total;
            const maxOff = Math.max(0, total - xrange);
            const beat   = this.ppq;
            const bar    = beat * this.timeSigNum;
            const step   = e.shiftKey ? bar : beat;
            let next = this._xoffset;
            switch (e.key) {
                case 'ArrowLeft':  next = this._xoffset - step; break;
                case 'ArrowRight': next = this._xoffset + step; break;
                case 'Home':       next = 0; break;
                case 'End':        next = maxOff; break;
                default: return;
            }
            e.preventDefault();
            this.onSeek(Math.max(0, Math.min(maxOff, Math.round(next))));
        }

        _totalTicks() { return this.ppq * this.timeSigNum * this.bars; }

        // -----------------------------------------------------------------
        //  Draw
        // -----------------------------------------------------------------

        draw() {
            this._dirty = false;
            const canvas = this.canvas;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');

            const w = canvas.clientWidth  || canvas.offsetWidth  || 0;
            const h = canvas.clientHeight || canvas.offsetHeight || 0;
            if (w <= 0 || h <= 0) return;

            // DPR-aware canvas sizing (fixes rendering on retina screens)
            const dpr   = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const wantW = Math.round(w * dpr);
            const wantH = Math.round(h * dpr);
            if (canvas.width !== wantW || canvas.height !== wantH) {
                canvas.width  = wantW;
                canvas.height = wantH;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const total = this._totalTicks();
            const dark  = typeof document !== 'undefined'
                && document.body.classList.contains('theme-dark');

            ctx.fillStyle = dark ? '#0f0f22' : '#eef0f4';
            ctx.fillRect(0, 0, w, h);

            this._drawGrid(ctx, w, h, total, dark);
            this._drawNotes(ctx, w, h, total, dark);
            this._drawViewport(ctx, w, h, total);
            this._drawPlayhead(ctx, w, h, total);
        }

        _drawGrid(ctx, w, h, total, dark) {
            const ticksPerBeat = this.ppq;
            const ticksPerBar  = ticksPerBeat * this.timeSigNum;
            ctx.lineWidth = 1;
            for (let t = 0; t < total; t += ticksPerBeat) {
                const x     = (t / total) * w;
                const isBar = (t % ticksPerBar) === 0;
                ctx.strokeStyle = isBar
                    ? (dark ? 'rgba(150,150,220,0.35)' : 'rgba(100,110,140,0.3)')
                    : (dark ? 'rgba(100,100,180,0.12)' : 'rgba(160,170,200,0.15)');
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            ctx.fillStyle    = dark ? 'rgba(180,180,220,0.5)' : 'rgba(100,110,140,0.55)';
            ctx.font         = `${Math.min(10, h * 0.27)}px sans-serif`;
            ctx.textBaseline = 'top';
            for (let b = 0; b < this.bars; b++) {
                const x = (b * ticksPerBar / total) * w;
                ctx.fillText(b + 1, x + 2, 2);
            }
        }

        _drawNotes(ctx, w, h, total, dark) {
            const noteSpan = Math.max(this.noteMax - this.noteMin, 1);
            const noteH    = Math.max(2, h * 0.08);
            const noteArea = h * 0.78;
            ctx.fillStyle  = dark ? '#5b9bd5' : '#4a90d9';
            for (const note of this._notes) {
                const x  = (note.t / total) * w;
                const nw = Math.max(2, ((note.g || note.l || 120) / total) * w);
                const ny = h * 0.18 + noteArea - ((note.n - this.noteMin) / noteSpan) * noteArea;
                ctx.fillRect(x, ny - noteH, nw, noteH);
            }
        }

        _drawViewport(ctx, w, h, total) {
            const xrange = this._xrange || total;
            const vx     = (this._xoffset / total) * w;
            const vw     = Math.min(w, (xrange / total) * w);
            ctx.fillStyle   = 'rgba(74,144,217,0.12)';
            ctx.fillRect(vx, 0, vw, h);
            ctx.strokeStyle = 'rgba(74,144,217,0.7)';
            ctx.lineWidth   = 1.5;
            ctx.strokeRect(vx + 0.5, 0.5, Math.max(2, vw - 1), h - 1);
        }

        _drawPlayhead(ctx, w, h, total) {
            if (this._cursor <= 0 && !this._isPlaying) return;
            const px = (this._cursor / total) * w;
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth   = 1.5;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
        }

        // -----------------------------------------------------------------
        //  Lifecycle
        // -----------------------------------------------------------------

        destroy() {
            if (this._rafHandle) {
                cancelAnimationFrame(this._rafHandle);
                this._rafHandle = null;
            }
            const c = this.canvas;
            if (c?.removeEventListener) {
                c.removeEventListener('mousedown',  this._onMouseDown);
                c.removeEventListener('mousemove',  this._onMouseMove);
                c.removeEventListener('mouseup',    this._onMouseUp);
                c.removeEventListener('mouseleave', this._onMouseLeave);
                c.removeEventListener('touchstart', this._onTouchStart);
                c.removeEventListener('touchmove',  this._onTouchMove);
                c.removeEventListener('touchend',   this._onTouchEnd);
                c.removeEventListener('keydown',    this._onKeyDown);
            }
            this._notes = [];
            this.canvas = null;
            this.onSeek = null;
        }
    }

    if (typeof window !== 'undefined') {
        window.LoopCreatorMinimap = LoopCreatorMinimap;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopCreatorMinimap;
    }
})();
