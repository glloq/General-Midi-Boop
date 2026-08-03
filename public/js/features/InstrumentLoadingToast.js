/**
 * @file public/js/features/InstrumentLoadingToast.js
 * @description Non-blocking, ref-counted "Loading instrument samples…" toast
 * shown while one or more SF2 preset fetches are in flight.
 *
 * Why a ref-counted singleton rather than per-call toasts:
 *   - The predictive preload at end of `MidiSynthesizer.initialize()` and
 *     `setSoundBank()` can fire many concurrent `_loadSF2MelodicPreset()`
 *     calls (one per distinct channel program). One toast that stays up
 *     while ANY load is pending is far less noisy than N separate toasts.
 *   - Threshold-gated: callers wait ~600 ms before incrementing the ref
 *     count. A warm L1/L2 hit (< 50 ms) never reaches the threshold and
 *     therefore never causes a toast flash, while a true cold load on the
 *     Pi 3B+ (~2-5 s) gets visible feedback.
 *
 * Public API on `window.InstrumentLoadingToast`:
 *   - `show(message)`     — bump the ref count; render or update the toast.
 *   - `hide()`            — drop one ref; remove the DOM node when it hits 0.
 *   - `_getCount()`       — diagnostic accessor for tests.
 *
 * Visual style: mirrors HandPositionWarningsToast (same corner, same
 * sizing, same elevation) so the UX is consistent. Distinct accent color
 * (slate-grey vs amber warning) so the user reads it as an informational
 * progress indicator rather than a problem.
 */
(function () {
  'use strict';

  let refCount = 0;
  let toastEl = null;

  function t(key, fallback) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function escapeHtml(s) {
    return window.escapeHtml ? window.escapeHtml(s) : s == null ? '' : String(s);
  }

  function render(message) {
    if (toastEl) {
      // Just update the text — keep the element so the user doesn't
      // see a flicker when subsequent loads bump the message.
      const span = toastEl.querySelector('.ilt-msg');
      if (span) span.textContent = message;
      return;
    }
    toastEl = document.createElement('div');
    toastEl.className = 'instrument-loading-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.style.cssText = [
      'position: fixed',
      'bottom: 24px',
      'right: 24px',
      'z-index: 10010',
      'padding: 10px 16px',
      'border-radius: 8px',
      'background: #334155', // slate-700
      'color: #f1f5f9', // slate-100
      'font-size: 13px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
      'display: flex',
      'align-items: center',
      'gap: 10px',
      'max-width: 360px',
      'line-height: 1.35',
      'pointer-events: none' // never blocks clicks on the UI
    ].join(';');
    // CSS spinner using inline keyframes so the module is self-contained
    // and works on pages that don't import a separate stylesheet.
    const styleId = 'instrument-loading-toast-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent =
        '@keyframes ilt-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    toastEl.innerHTML =
      '<span aria-hidden="true" style="display:inline-block;width:14px;height:14px;' +
      'border:2px solid rgba(255,255,255,0.25);border-top-color:#f1f5f9;' +
      'border-radius:50%;animation:ilt-spin 0.8s linear infinite"></span>' +
      `<span class="ilt-msg">${escapeHtml(message)}</span>`;
    document.body.appendChild(toastEl);
  }

  function remove() {
    if (!toastEl) return;
    // Brief fade so it doesn't pop out abruptly on fast follow-up loads.
    toastEl.style.transition = 'opacity 0.2s ease';
    toastEl.style.opacity = '0';
    const el = toastEl;
    toastEl = null;
    setTimeout(() => el.remove(), 220);
  }

  window.InstrumentLoadingToast = {
    show(message) {
      refCount++;
      const msg = message || t('instrumentLoading.message', 'Loading instrument samples…');
      render(msg);
    },
    hide() {
      if (refCount <= 0) return;
      refCount--;
      if (refCount === 0) remove();
    },
    _getCount() {
      return refCount;
    }
  };
})();
