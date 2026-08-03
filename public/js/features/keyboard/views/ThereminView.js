// =============================================================================
// ThereminView.js — Theremin (custom: instrument_type === 'theremin').
// =============================================================================
// A continuous 2-D pad: X = pitch (chromatic C3..C6), Y = volume (CC#7).
// pointerdown starts a note, drag re-pitches (retrigger when crossing a
// semitone) and re-sends volume, pointerup stops. No standard GM program
// exists for a theremin, so it is selected via instrument_type and never
// hijacks a GM patch. Self-owned DOM.
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.InstrumentView) return;
  const InstrumentView = window.InstrumentView;

  const NOTE_LO = 48,
    NOTE_HI = 84; // C3..C6
  const PAD_W = 480,
    PAD_H = 300; // fallback geometry (jsdom has no layout)

  class ThereminView extends InstrumentView {
    static viewKind = 'theremin';
    static iconUrl = null; // no instrument SVG — emoji fallback
    static emoji = '📡';
    static labelKey = 'keyboard.viewTheremin';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      if (!modal) return;
      const canvas = document.getElementById('keyboard-canvas-container');
      if (!canvas) return;
      document.getElementById('theremin-container')?.remove();

      const root = document.createElement('div');
      root.id = 'theremin-container';
      root.className = 'theremin-view';
      root.style.cssText =
        'position:relative;width:480px;height:300px;margin:auto;' +
        'border-radius:8px;cursor:crosshair;touch-action:none;' +
        'background:linear-gradient(90deg,#1b2735,#34495e);' +
        'overflow:hidden;';
      const hint = document.createElement('div');
      hint.className = 'theremin-hint';
      hint.textContent = this._t('keyboard.thereminHint', '← grave · aigu →   /   ↑ fort · doux ↓');
      hint.style.cssText =
        'position:absolute;top:6px;left:0;right:0;text-align:center;' +
        'color:#9fb3c8;font:11px sans-serif;pointer-events:none;';
      root.appendChild(hint);
      const cursor = document.createElement('div');
      cursor.className = 'theremin-cursor';
      cursor.style.cssText =
        'position:absolute;width:14px;height:14px;border-radius:50%;' +
        'background:#e74c3c;transform:translate(-50%,-50%);' +
        'pointer-events:none;display:none;';
      root.appendChild(cursor);
      canvas.appendChild(root);

      this._root = root;
      this._cursor = cursor;
      this._active = false;
      this._note = null;

      this._onDown = (e) => this._start(e);
      this._onMove = (e) => {
        if (this._active) this._update(e);
      };
      this._onDocUp = () => this._stop();
      root.addEventListener('pointerdown', this._onDown);
      root.addEventListener('pointermove', this._onMove);
      document.addEventListener('pointerup', this._onDocUp);
      document.addEventListener('pointercancel', this._onDocUp);
    }

    _xyRatio(e) {
      const r = this._root.getBoundingClientRect
        ? this._root.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      const w = r.width || PAD_W;
      const h = r.height || PAD_H;
      const x = Math.max(0, Math.min(1, ((e.clientX || 0) - (r.left || 0)) / w));
      const y = Math.max(0, Math.min(1, ((e.clientY || 0) - (r.top || 0)) / h));
      return { x, y };
    }

    _noteFromX(x) {
      return Math.round(NOTE_LO + x * (NOTE_HI - NOTE_LO));
    }

    _start(e) {
      if (e.cancelable) e.preventDefault();
      const { x, y } = this._xyRatio(e);
      const note = this._noteFromX(x);
      this._active = true;
      this._note = note;
      this._moveCursor(x, y);
      const modal = this.ctx && this.ctx.modal;
      if (!modal) return;
      if (typeof modal.playNote === 'function') modal.playNote(note);
      this._sendVolume(y, modal);
    }

    _update(e) {
      const { x, y } = this._xyRatio(e);
      this._moveCursor(x, y);
      const modal = this.ctx && this.ctx.modal;
      if (!modal) return;
      const note = this._noteFromX(x);
      if (note !== this._note) {
        if (typeof modal.stopNote === 'function') modal.stopNote(this._note);
        if (typeof modal.playNote === 'function') modal.playNote(note);
        this._note = note;
      }
      this._sendVolume(y, modal);
    }

    _sendVolume(y, modal) {
      const vol = Math.max(0, Math.min(127, Math.round((1 - y) * 127)));
      if (typeof modal.sendCC === 'function') modal.sendCC(7, vol);
    }

    _moveCursor(x, y) {
      if (!this._cursor) return;
      this._cursor.style.display = 'block';
      this._cursor.style.left = x * 100 + '%';
      this._cursor.style.top = y * 100 + '%';
    }

    _stop() {
      if (!this._active) return;
      this._active = false;
      const modal = this.ctx && this.ctx.modal;
      if (modal && this._note != null && typeof modal.stopNote === 'function') {
        modal.stopNote(this._note);
      }
      this._note = null;
      if (this._cursor) this._cursor.style.display = 'none';
    }

    unmount() {
      this._stop();
      if (this._root) {
        this._root.removeEventListener('pointerdown', this._onDown);
        this._root.removeEventListener('pointermove', this._onMove);
        this._root.remove();
        this._root = null;
      }
      document.removeEventListener('pointerup', this._onDocUp);
      document.removeEventListener('pointercancel', this._onDocUp);
      this._cursor = null;
      super.unmount();
    }
  }

  if (typeof window !== 'undefined') window.ThereminView = ThereminView;
  if (typeof module !== 'undefined') module.exports = ThereminView;
})();
