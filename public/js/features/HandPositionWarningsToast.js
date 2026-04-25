/**
 * @file HandPositionWarningsToast.js
 * @description Frontend consumer of the `playback_hand_position_warnings`
 * WebSocket event emitted by `MidiPlayer._injectHandPositionCCEvents`.
 * When a file starts playing and the hand-position planner raises any
 * feasibility concern (`move_too_fast`, `chord_span_exceeded`,
 * `too_many_fingers`, `out_of_range`, `finger_interval_violated`), we
 * surface an aggregated, dismissible toast so the operator can react
 * without cracking open the logs.
 *
 * Design choices:
 *   - Self-initializing: the module starts listening as soon as
 *     `window.api` is available. No manual wiring needed from pages.
 *   - Debounced: a warning burst at playback start becomes one toast,
 *     not N toasts.
 *   - Visual pattern borrowed from `InstrumentManagementPage.showToast`
 *     so the UX matches the rest of the app.
 *   - i18n-aware: uses `window.i18n.t` with a French fallback.
 */
(function() {
    'use strict';

    const TOAST_DURATION_MS = 5000;
    const AGGREGATE_WINDOW_MS = 400;
    const BURST_CAP = 20;

    function t(key, fallback) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    function summarize(warnings) {
        const counts = {};
        for (const w of warnings) {
            const code = w?.code || 'unknown';
            counts[code] = (counts[code] || 0) + 1;
        }
        const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const labels = {
            move_too_fast:            t('handPosition.warnMoveTooFast',   'déplacements trop rapides'),
            chord_span_exceeded:      t('handPosition.warnChordSpan',     'accords trop larges'),
            too_many_fingers:         t('handPosition.warnTooManyFingers','trop de doigts requis'),
            out_of_range:             t('handPosition.warnOutOfRange',    'notes hors plage'),
            finger_interval_violated: t('handPosition.warnFingerInterval','doigts trop rapprochés')
        };
        return ordered
            .map(([code, n]) => `${n}× ${labels[code] || code}`)
            .join(', ');
    }

    function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'hand-position-warnings-toast';
        toast.style.cssText = [
            'position: fixed',
            'top: 24px',
            'right: 24px',
            'z-index: 10010',
            'padding: 12px 20px',
            'border-radius: 8px',
            'background: #f59e0b',
            'color: white',
            'font-size: 14px',
            'box-shadow: 0 4px 12px rgba(0,0,0,0.2)',
            'display: flex',
            'align-items: center',
            'gap: 8px',
            'max-width: 420px',
            'line-height: 1.35'
        ].join(';');
        toast.innerHTML =
            `<span style="font-weight: bold; font-size: 16px;">⚠</span> ${escapeHtml(message)}`;
        toast.addEventListener('click', () => toast.remove());
        document.body.appendChild(toast);
        setTimeout(() => {
            if (!toast.isConnected) return;
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, TOAST_DURATION_MS);
    }

    /**
     * Aggregation buffer. Multiple bursts for different fileIds stay
     * separate; within one fileId, warnings arriving close in time are
     * merged so a 10-warning burst doesn't spam the UI.
     */
    function createAggregator() {
        const pending = new Map(); // fileId → { warnings, timer }
        return function push(ev) {
            if (!ev || !Array.isArray(ev.warnings) || ev.warnings.length === 0) return;
            const fileId = ev.fileId ?? '_';
            const existing = pending.get(fileId);
            const merged = existing ? existing.warnings.concat(ev.warnings) : ev.warnings.slice();
            if (existing) clearTimeout(existing.timer);
            const timer = setTimeout(() => {
                pending.delete(fileId);
                const all = merged.slice(0, BURST_CAP);
                const summary = summarize(all);
                const header = t('handPosition.toastPrefix', 'Faisabilité main') + ' :';
                showToast(`${header} ${summary}`);
            }, AGGREGATE_WINDOW_MS);
            pending.set(fileId, { warnings: merged, timer });
        };
    }

    function init() {
        if (window.__handPositionWarningsToastInstalled) return;
        const api = window.api;
        if (!api || typeof api.on !== 'function') return false;
        window.__handPositionWarningsToastInstalled = true;
        const push = createAggregator();
        api.on('playback_hand_position_warnings', push);
        return true;
    }

    // Try immediately; if the API client is not wired yet, poll until it
    // is. We stop polling after 30s to avoid leaking forever on pages
    // that never instantiate the API (e.g. static docs).
    if (!init()) {
        const started = Date.now();
        const iv = setInterval(() => {
            if (init() || Date.now() - started > 30000) clearInterval(iv);
        }, 250);
    }

    // Expose helpers for unit tests and for other modules that want to
    // surface warnings without going through the WS event.
    if (typeof window !== 'undefined') {
        window.HandPositionWarningsToast = {
            show: showToast,
            summarize,
            _createAggregator: createAggregator
        };
    }
})();
