/**
 * @file RealtimeStatusToasts.js
 * @description Frontend consumer for backend WebSocket events that previously
 * had NO listener, so their information never reached the operator:
 *
 *   - `system_lag`         → event-loop lag warning (throttled toast).      [T2.3]
 *   - `reconnecting`       → persistent "reconnecting…" banner.            [T2.5]
 *   - `reconnect_exhausted`→ persistent "connection lost" banner + reload. [T2.5]
 *   - `connected`          → clears the banner once the socket is back.
 *   - `playlist_waiting`   → inter-track countdown chip.                   [T2.8]
 *   - `settings_applied`   → "settings synced" toast (multi-client).       [T2.9]
 *
 * Self-installing, matching HandPositionWarningsToast.js: as soon as
 * `window.api` exists it subscribes via `api.on(...)`. `BackendAPIClient.on`
 * pushes handlers (multi-listener), so adding a `connected` listener here does
 * NOT displace the bootstrap's own `connected` handler.
 *
 * All DOM is created by this module (no reliance on markup in index.html) and
 * the render helpers are exposed on `window.RealtimeStatusToasts` for unit
 * tests (see tests/frontend/realtime-status-toasts.test.js).
 */
(function () {
  'use strict';

  const LAG_THROTTLE_MS = 5000;

  function t(key, fallback) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  const escapeHtml = (s) => (window.escapeHtml ? window.escapeHtml(s) : s == null ? '' : String(s));

  /** Transient auto-dismissing toast (top-right stack). */
  function toast(message, { bg = '#3b82f6', icon = 'ℹ', durationMs = 4000 } = {}) {
    const el = document.createElement('div');
    el.className = 'rt-status-toast';
    el.style.cssText = [
      'position: fixed',
      'top: 24px',
      'right: 24px',
      'z-index: 10010',
      'padding: 12px 20px',
      'border-radius: 8px',
      `background: ${bg}`,
      'color: white',
      'font-size: 14px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.2)',
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'max-width: 420px',
      'line-height: 1.35'
    ].join(';');
    el.innerHTML = `<span style="font-weight:bold;font-size:16px;">${icon}</span> ${escapeHtml(
      message
    )}`;
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    if (durationMs > 0) {
      setTimeout(() => {
        if (!el.isConnected) return;
        el.style.transition = 'opacity 0.3s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
      }, durationMs);
    }
    return el;
  }

  // ── Persistent connection banner (singleton) ──────────────────────────────
  const BANNER_ID = 'rt-connection-banner';

  function showBanner(message, { showReload = false, bg = '#dc2626' } = {}) {
    let el = document.getElementById(BANNER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BANNER_ID;
      el.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 10020',
        'padding: 10px 16px',
        'text-align: center',
        'color: white',
        'font-size: 14px',
        'font-weight: 600',
        'box-shadow: 0 2px 8px rgba(0,0,0,0.25)'
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.background = bg;
    const reloadBtn = showReload
      ? ` <button type="button" id="rt-banner-reload" style="margin-left:12px;padding:3px 10px;border:1px solid rgba(255,255,255,0.7);background:transparent;color:white;border-radius:6px;cursor:pointer;font-weight:600;">${escapeHtml(
          t('common.reload', 'Recharger')
        )}</button>`
      : '';
    el.innerHTML = `${escapeHtml(message)}${reloadBtn}`;
    if (showReload) {
      const btn = el.querySelector('#rt-banner-reload');
      if (btn) btn.addEventListener('click', () => window.location.reload());
    }
    return el;
  }

  function clearBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  // ── Inter-track playlist countdown (singleton, self-clearing) ─────────────
  const COUNTDOWN_ID = 'rt-playlist-countdown';

  function showCountdown(remainingSeconds) {
    const secs = Number(remainingSeconds);
    if (!Number.isFinite(secs) || secs <= 0) {
      const existing = document.getElementById(COUNTDOWN_ID);
      if (existing) existing.remove();
      return null;
    }
    let el = document.getElementById(COUNTDOWN_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = COUNTDOWN_ID;
      el.style.cssText = [
        'position: fixed',
        'bottom: 24px',
        'left: 50%',
        'transform: translateX(-50%)',
        'z-index: 10010',
        'padding: 8px 16px',
        'border-radius: 20px',
        'background: rgba(17,24,39,0.92)',
        'color: white',
        'font-size: 13px',
        'font-weight: 600',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.3)'
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = `⏭ ${t('playlist.nextTrackIn', 'Piste suivante dans')} ${Math.ceil(secs)}s`;
    return el;
  }

  // ── system_lag (throttled) ────────────────────────────────────────────────
  let lastLagAt = 0;
  function showLag(lagMs, thresholdMs, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (now - lastLagAt < LAG_THROTTLE_MS) return null;
    lastLagAt = now;
    const lag = Math.round(Number(lagMs) || 0);
    return toast(`${t('system.lagWarning', 'Latence système')} : ${lag} ms`, {
      bg: '#f59e0b',
      icon: '⚠',
      durationMs: 4000
    });
  }

  function init() {
    if (window.__realtimeStatusToastsInstalled) return false;
    const api = window.api;
    if (!api || typeof api.on !== 'function') return false;
    window.__realtimeStatusToastsInstalled = true;

    // Once reconnection is exhausted (hard fail), the client keeps emitting
    // `reconnecting` on further attempts. Those must NOT downgrade the hard-fail
    // banner (which carries the Reload button); a `hardLost` latch keeps it until
    // `connected` clears everything (audit fix).
    let hardLost = false;
    api.on('system_lag', (d) => showLag(d && d.lagMs, d && d.thresholdMs));
    api.on('reconnecting', (d) => {
      if (hardLost) return; // keep the persistent lost-connection banner
      showBanner(
        t('connection.reconnecting', 'Reconnexion au serveur…') +
          (d && d.attempt ? ` (${d.attempt})` : ''),
        { bg: '#d97706' }
      );
    });
    api.on('reconnect_exhausted', () => {
      hardLost = true;
      showBanner(t('connection.lost', 'Connexion au serveur perdue'), {
        showReload: true,
        bg: '#dc2626'
      });
    });
    api.on('connected', () => {
      hardLost = false;
      clearBanner();
    });
    api.on('playlist_waiting', (d) => showCountdown(d && d.remainingSeconds));
    // Belt-and-suspenders: clear the countdown when the next track actually
    // starts, in case the terminal remainingSeconds:0 frame is missed.
    api.on('playlist_item_changed', () => showCountdown(0));
    api.on('settings_applied', () =>
      toast(t('settings.syncedFromAnotherClient', 'Réglages synchronisés'), {
        bg: '#10b981',
        icon: '✓',
        durationMs: 3000
      })
    );
    return true;
  }

  if (!init()) {
    const started = Date.now();
    const iv = setInterval(() => {
      if (init() || Date.now() - started > 30000) clearInterval(iv);
    }, 250);
  }

  if (typeof window !== 'undefined') {
    window.RealtimeStatusToasts = {
      toast,
      showBanner,
      clearBanner,
      showCountdown,
      showLag,
      _init: init
    };
  }
})();
