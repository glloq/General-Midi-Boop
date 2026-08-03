/**
 * @file public/js/utils/Toast.js
 * @description Lightweight global toast helpers. Two flavours:
 *
 *   - `window.showToast(message, type, opts)` — a transient, self-dismissing
 *     notification (info / success / error / warning). This also backfills
 *     the previously-dangling `window.showToast` reference used by
 *     RoutingSummaryPage and other features (it was never defined, so those
 *     toasts silently never appeared).
 *
 *   - `window.withProgressToast(promise, message, { thresholdMs })` — wraps an
 *     awaitable. A non-blocking spinner toast appears ONLY if the operation
 *     runs longer than `thresholdMs` (default 500 ms), so fast paths never
 *     flash a toast while genuinely incompressible waits (server-side
 *     auto-assign analysis, MIDI adaptation/file write) get clear feedback.
 *
 * Visual style mirrors InstrumentLoadingToast / HandPositionWarningsToast
 * (same corner, sizing, elevation) so the UX stays consistent. Self-contained
 * (inline keyframes) so it works on pages without a dedicated stylesheet.
 */
(function () {
  'use strict';

  function esc(s) {
    return window.escapeHtml ? window.escapeHtml(s) : s == null ? '' : String(s);
  }

  function ensureStyle() {
    const id = 'gm-toast-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent =
      '@keyframes gm-toast-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
      '@keyframes gm-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}';
    document.head.appendChild(style);
  }

  const PALETTE = {
    info: { bg: '#334155', fg: '#f1f5f9' },
    success: { bg: '#15803d', fg: '#f0fdf4' },
    error: { bg: '#b91c1c', fg: '#fef2f2' },
    warning: { bg: '#b45309', fg: '#fffbeb' }
  };

  const ICONS = { info: 'ℹ', success: '✓', error: '✗', warning: '⚠' };

  function baseStyle(bottomOffset) {
    return [
      'position: fixed',
      'right: 24px',
      `bottom: ${bottomOffset}px`,
      'z-index: 10010',
      'padding: 10px 16px',
      'border-radius: 8px',
      'font-size: 13px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
      'display: flex',
      'align-items: center',
      'gap: 10px',
      'max-width: 360px',
      'line-height: 1.35',
      'pointer-events: none',
      'animation: gm-toast-in 0.18s ease'
    ];
  }

  /**
   * Transient self-dismissing toast.
   * @param {string} message
   * @param {'info'|'success'|'error'|'warning'} [type='info']
   * @param {{duration?:number}} [opts]
   * @returns {HTMLElement}
   */
  function showToast(message, type = 'info', opts = {}) {
    ensureStyle();
    const pal = PALETTE[type] || PALETTE.info;
    const el = document.createElement('div');
    el.className = 'gm-toast';
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.style.cssText = baseStyle(24).join(';') + `;background:${pal.bg};color:${pal.fg}`;
    el.innerHTML =
      `<span aria-hidden="true" style="font-weight:bold;font-size:15px">${ICONS[type] || ICONS.info}</span>` +
      `<span>${esc(message)}</span>`;
    document.body.appendChild(el);
    const duration = opts.duration != null ? opts.duration : 3200;
    setTimeout(() => {
      el.style.transition = 'opacity 0.25s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, duration);
    return el;
  }

  /**
   * Non-blocking spinner toast. Caller owns its lifecycle.
   * @param {string} message
   * @returns {{ update:(m:string)=>void, done:()=>void }}
   */
  function showProgressToast(message) {
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'gm-progress-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = baseStyle(24).join(';') + ';background:#334155;color:#f1f5f9';
    el.innerHTML =
      '<span aria-hidden="true" style="display:inline-block;width:14px;height:14px;' +
      'border:2px solid rgba(255,255,255,0.25);border-top-color:#f1f5f9;' +
      'border-radius:50%;animation:gm-toast-spin 0.8s linear infinite"></span>' +
      `<span class="gm-pt-msg">${esc(message)}</span>`;
    document.body.appendChild(el);
    let removed = false;
    return {
      update(m) {
        const span = el.querySelector('.gm-pt-msg');
        if (span) span.textContent = m;
      },
      done() {
        if (removed) return;
        removed = true;
        el.style.transition = 'opacity 0.2s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 220);
      }
    };
  }

  /**
   * Show a progress toast only if `promiseOrFn` takes longer than the
   * threshold. Resolves/rejects exactly like the wrapped awaitable.
   * @template T
   * @param {Promise<T>|(()=>Promise<T>)} promiseOrFn
   * @param {string} message
   * @param {{thresholdMs?:number}} [opts]
   * @returns {Promise<T>}
   */
  function withProgressToast(promiseOrFn, message, opts = {}) {
    const threshold = opts.thresholdMs != null ? opts.thresholdMs : 500;
    const p =
      typeof promiseOrFn === 'function'
        ? Promise.resolve().then(promiseOrFn)
        : Promise.resolve(promiseOrFn);
    let handle = null;
    const timer = setTimeout(() => {
      handle = showProgressToast(message);
    }, threshold);
    const cleanup = () => {
      clearTimeout(timer);
      if (handle) handle.done();
    };
    return p.then(
      (v) => {
        cleanup();
        return v;
      },
      (e) => {
        cleanup();
        throw e;
      }
    );
  }

  // Backfill the dangling global; don't clobber a richer impl if one exists.
  if (typeof window.showToast !== 'function') window.showToast = showToast;
  window.showProgressToast = showProgressToast;
  window.withProgressToast = withProgressToast;
})();
