// =============================================================================
// NoteSlider.js — Slider horizontal de sélection de note avec gamme
// =============================================================================
// Module UI autonome : X = note, Y = velocity.
// Ne connaît pas le backend ni l'instrument. Émet des événements.
//
// Événements émis :
//   'notechange' (note: int|float, velocity: int, continuous: bool)
//   'noteoff'    (note: int)
//
// Usage :
//   const engine = new NoteEngine();
//   engine.setScale(0, 'major');
//   const slider = new NoteSlider(container, engine, { minNote: 36, maxNote: 84 });
//   slider.on('notechange', (note, vel, cont) => playNote(note, vel));
//   slider.on('noteoff',    (note) => stopNote(note));
// =============================================================================
(function () {
    'use strict';

    // ── Constantes ────────────────────────────────────────────────────────────
    const THROTTLE_MS      = 16;   // ~60 fps max sur mousemove
    const DEFAULT_HEIGHT   = 72;   // px
    const THUMB_RADIUS     = 14;
    const GRADUATION_COLOR = '#555';
    const ACTIVE_COLOR     = '#3B82F6';
    const SCALE_TICK_MAJOR = 8;
    const SCALE_TICK_MINOR = 4;

    class NoteSlider {
        /**
         * @param {HTMLElement} container   Élément hôte (recevra un <canvas>)
         * @param {NoteEngine}  noteEngine  Moteur de gamme (NoteEngine.js)
         * @param {object}      [options]
         * @param {number}      [options.minNote=36]
         * @param {number}      [options.maxNote=84]
         * @param {'discrete'|'continuous'} [options.mode='discrete']
         * @param {number}      [options.height=72]
         * @param {'english'|'solfege'|'midi'} [options.labelFormat='english']
         */
        constructor(container, noteEngine, options = {}) {
            this._container   = container;
            this._engine      = noteEngine;
            this._mode        = options.mode        || 'discrete';
            this._height      = options.height      || DEFAULT_HEIGHT;
            this._labelFormat = options.labelFormat || 'english';
            this._listeners   = { notechange: [], noteoff: [] };

            this._currentNote = null;   // dernière note émise (int)
            this._velocity    = 100;
            this._dragging    = false;
            this._lastEmit    = 0;

            if (options.minNote != null || options.maxNote != null) {
                noteEngine.setRange(
                    options.minNote ?? noteEngine.minNote,
                    options.maxNote ?? noteEngine.maxNote
                );
            }

            this._build();
            this.render();
        }

        // ── API publique ───────────────────────────────────────────────────────

        /** @param {'english'|'solfege'|'midi'} format */
        setLabelFormat(format) {
            this._labelFormat = format;
            this.render();
        }

        /**
         * Deléguer à NoteEngine + re-render.
         * @param {number} root  0–11
         * @param {string} type  'chromatic'|'major'|'minor'|'pentatonic'|'blues'
         */
        setScale(root, type) {
            this._engine.setScale(root, type);
            this.render();
        }

        /** @param {number} minNote @param {number} maxNote */
        setRange(minNote, maxNote) {
            this._engine.setRange(minNote, maxNote);
            this.render();
        }

        /** @param {'discrete'|'continuous'} mode */
        setMode(mode) {
            this._mode = mode;
        }

        /** @param {number} velocity  0–127 */
        setVelocity(velocity) {
            this._velocity = Math.max(0, Math.min(127, Math.round(velocity)));
        }

        /**
         * Abonner un listener.
         * @param {'notechange'|'noteoff'} event
         * @param {Function} fn
         */
        on(event, fn) {
            if (this._listeners[event]) this._listeners[event].push(fn);
            return this;
        }

        /** Désabonner un listener. */
        off(event, fn) {
            if (this._listeners[event]) {
                this._listeners[event] = this._listeners[event].filter(f => f !== fn);
            }
            return this;
        }

        /** Supprimer le canvas et les listeners. */
        destroy() {
            this._detachEvents();
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
        }

        // ── Construction DOM ──────────────────────────────────────────────────

        _build() {
            const canvas = document.createElement('canvas');
            canvas.className   = 'note-slider-canvas';
            canvas.style.width  = '100%';
            canvas.style.height = this._height + 'px';
            canvas.style.cursor = 'crosshair';
            canvas.style.touchAction = 'none';
            this._container.appendChild(canvas);
            this._canvas = canvas;
            this._ctx    = canvas.getContext('2d');
            this._attachEvents();
            this._resizeObserver = new ResizeObserver(() => this.render());
            this._resizeObserver.observe(this._container);
        }

        // ── Rendu ─────────────────────────────────────────────────────────────

        render() {
            const canvas = this._canvas;
            const dpr    = window.devicePixelRatio || 1;
            const w      = this._container.clientWidth  || 300;
            const h      = this._height;

            canvas.width  = w * dpr;
            canvas.height = h * dpr;
            const ctx = this._ctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.clearRect(0, 0, w, h);

            this._drawBackground(ctx, w, h);
            this._drawGraduation(ctx, w, h);
            if (this._currentNote != null) {
                this._drawThumb(ctx, w, h, this._currentNote);
            }
        }

        _drawBackground(ctx, w, h) {
            // Dégradé de fond : grave (sombre) → aigu (clair)
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0,   '#1e1e2e');
            grad.addColorStop(1,   '#2d2d44');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.roundRect(0, 0, w, h, 6);
            ctx.fill();
        }

        _drawGraduation(ctx, w, h) {
            const scaleNotes = this._engine.getScaleNotes();
            if (scaleNotes.length === 0) return;

            const n    = scaleNotes.length;
            const step = w / n;

            scaleNotes.forEach((note, idx) => {
                const x       = (idx + 0.5) * step;
                const cls     = this._engine.noteClass(note);
                const isRoot  = cls === this._engine.root;
                const isFifth = cls === (this._engine.root + 7) % 12;
                const isThird = cls === (this._engine.root + 4) % 12 ||
                                cls === (this._engine.root + 3) % 12;

                // Trait de graduation
                const tickH = isRoot ? SCALE_TICK_MAJOR + 4 :
                              (isFifth || isThird) ? SCALE_TICK_MAJOR :
                              SCALE_TICK_MINOR;
                ctx.strokeStyle = isRoot ? '#F97316' :
                                  isFifth ? '#22C55E' :
                                  isThird ? '#60A5FA' :
                                  GRADUATION_COLOR;
                ctx.lineWidth = isRoot ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x, h - tickH - 6);
                ctx.lineTo(x, h - 6);
                ctx.stroke();

                // Label (octave 0, première occurrence de la classe)
                if (isRoot || (n <= 24 && (isRoot || isFifth || isThird))) {
                    const label = this._engine.noteName(note, this._labelFormat);
                    ctx.fillStyle = isRoot ? '#F97316' : '#888';
                    ctx.font = isRoot ? 'bold 9px sans-serif' : '8px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(label, x, h - 10 - tickH - 1);
                }
            });
        }

        _drawThumb(ctx, w, h, note) {
            const scaleNotes = this._engine.getScaleNotes();
            const n = scaleNotes.length;
            if (n === 0) return;

            const idx  = scaleNotes.indexOf(note);
            const x    = idx >= 0
                ? (idx + 0.5) * (w / n)
                : ((note - this._engine.minNote) / (this._engine.maxNote - this._engine.minNote + 1)) * w;
            const y    = h / 2;

            // Halo
            ctx.beginPath();
            ctx.arc(x, y, THUMB_RADIUS + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(59,130,246,0.25)';
            ctx.fill();

            // Disque principal
            ctx.beginPath();
            ctx.arc(x, y, THUMB_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = ACTIVE_COLOR;
            ctx.fill();

            // Label note
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this._engine.noteName(note, this._labelFormat), x, y);
            ctx.textBaseline = 'alphabetic';
        }

        // ── Événements souris / tactile ────────────────────────────────────────

        _attachEvents() {
            const c = this._canvas;
            this._onMouseDown  = (e) => this._startDrag(e.clientX, e.clientY);
            this._onMouseMove  = (e) => this._moveDrag(e.clientX, e.clientY);
            this._onMouseUp    = ()  => this._endDrag();
            this._onTouchStart = (e) => { e.preventDefault(); this._startDrag(e.touches[0].clientX, e.touches[0].clientY); };
            this._onTouchMove  = (e) => { e.preventDefault(); this._moveDrag(e.touches[0].clientX, e.touches[0].clientY); };
            this._onTouchEnd   = ()  => this._endDrag();

            c.addEventListener('mousedown',  this._onMouseDown);
            c.addEventListener('touchstart', this._onTouchStart, { passive: false });
        }

        _detachEvents() {
            const c = this._canvas;
            if (!c) return;
            c.removeEventListener('mousedown',  this._onMouseDown);
            c.removeEventListener('touchstart', this._onTouchStart);
            document.removeEventListener('mousemove', this._onMouseMove);
            document.removeEventListener('mouseup',   this._onMouseUp);
            c.removeEventListener('touchmove', this._onTouchMove);
            c.removeEventListener('touchend',  this._onTouchEnd);
            if (this._resizeObserver) this._resizeObserver.disconnect();
        }

        _startDrag(clientX, clientY) {
            this._dragging = true;
            document.addEventListener('mousemove', this._onMouseMove);
            document.addEventListener('mouseup',   this._onMouseUp);
            this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
            this._canvas.addEventListener('touchend',  this._onTouchEnd);
            this._processPosition(clientX, clientY);
        }

        _moveDrag(clientX, clientY) {
            if (!this._dragging) return;
            const now = performance.now();
            if (now - this._lastEmit < THROTTLE_MS) return;
            this._lastEmit = now;
            this._processPosition(clientX, clientY);
        }

        _endDrag() {
            if (!this._dragging) return;
            this._dragging = false;
            document.removeEventListener('mousemove', this._onMouseMove);
            document.removeEventListener('mouseup',   this._onMouseUp);
            this._canvas.removeEventListener('touchmove', this._onTouchMove);
            this._canvas.removeEventListener('touchend',  this._onTouchEnd);

            if (this._currentNote != null) {
                this._emit('noteoff', this._currentNote);
                this._currentNote = null;
                this.render();
            }
        }

        _processPosition(clientX, clientY) {
            const rect  = this._canvas.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const velRatio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
            this._velocity = Math.round(velRatio * 127);

            let note;
            if (this._mode === 'continuous') {
                note = this._engine.noteFromRatioContinuous(ratio);
                this._currentNote = Math.round(note);
            } else {
                note = this._engine.noteFromRatio(ratio);
                this._currentNote = note;
            }

            this.render();
            this._emit('notechange', note, this._velocity, this._mode === 'continuous');
        }

        // ── Émission d'événements ─────────────────────────────────────────────

        _emit(event, ...args) {
            for (const fn of (this._listeners[event] || [])) {
                try { fn(...args); } catch (err) { /* isoler les erreurs utilisateur */ }
            }
        }
    }

    if (typeof window !== 'undefined') window.NoteSlider = NoteSlider;
    if (typeof module !== 'undefined') module.exports = NoteSlider;
})();
