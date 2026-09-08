/**
 * @file public/js/features/routing/LiveRoutingLauncher.js
 * @description Entry point that makes {@link LiveRoutingModal} reachable from
 * the application shell.
 *
 * Audit R12 / F-138: the live-routing commands had no caller because they had
 * no *affordance* — proving the component exists is not the same as proving a
 * user can reach it. This module injects a real header button (`#liveRoutingBtn`)
 * next to the other header tools and opens the modal on click, so the feature is
 * reachable from the assembled application and can be exercised by the browser
 * E2E harness (`tests/e2e/specs/05-live-routing.spec.mjs`).
 *
 * It lives in JS rather than in `index.html` on purpose: the button, its label,
 * its i18n binding and its handler stay in one file that owns the feature.
 *
 * The button is created once, is idempotent (a second call is a no-op), and
 * degrades silently when the header or the modal class is absent.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const BUTTON_ID = 'liveRoutingBtn';

  /**
   * Create (once) the header button and wire it to a lazily-built modal.
   * @param {Object} [options]
   * @param {Object} [options.apiClient] - defaults to `window.api` at click time.
   * @returns {?HTMLElement} the button, or null when there is nowhere to put it.
   */
  function installLiveRoutingLauncher(options) {
    const opts = options || {};
    const existing = document.getElementById(BUTTON_ID);
    if (existing) return existing;

    const host =
      document.querySelector('.header-tools-right') ||
      (document.getElementById('systemAdminBtn') || {}).parentNode ||
      null;
    if (!host) return null;

    const label =
      window.i18n && typeof window.i18n.t === 'function'
        ? window.i18n.t('liveRouting.title')
        : 'liveRouting.title';
    const text = label === 'liveRouting.title' ? 'Live MIDI routing' : label;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BUTTON_ID;
    btn.className = 'btn-settings-toggle';
    // `.title` / setAttribute are NOT innerHTML sinks: plain t(), no escaping.
    btn.title = text;
    btn.setAttribute('aria-label', text);
    btn.setAttribute('data-i18n-title', 'liveRouting.title');
    btn.setAttribute('data-i18n-aria-label', 'liveRouting.title');
    btn.textContent = '🔀';

    const anchor = document.getElementById('systemAdminBtn');
    if (anchor && anchor.parentNode === host) host.insertBefore(btn, anchor.nextSibling);
    else host.appendChild(btn);

    let modal = null;
    btn.addEventListener('click', () => {
      const api = opts.apiClient || window.api;
      if (typeof window.LiveRoutingModal !== 'function') return;
      if (!modal) modal = new window.LiveRoutingModal(api);
      // A locale change between two openings must not show a stale label.
      if (!modal.isOpen) modal.open();
    });

    // Keep the accessible name in sync with the locale. `i18n.updatePageTranslations()`
    // handles `data-i18n-title` but not `aria-label`, so refresh it here.
    if (window.i18n && typeof window.i18n.onLocaleChange === 'function') {
      window.i18n.onLocaleChange(() => {
        const next = window.i18n.t('liveRouting.title');
        if (next && next !== 'liveRouting.title') {
          btn.title = next;
          btn.setAttribute('aria-label', next);
        }
      });
    }

    return btn;
  }

  window.installLiveRoutingLauncher = installLiveRoutingLauncher;

  // Self-install as soon as the shell exists. `index.html` loads this script at
  // the end of <body>, so the header is already parsed in the common case; the
  // DOMContentLoaded fallback covers a deferred/async load.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => installLiveRoutingLauncher(), {
      once: true
    });
  } else {
    installLiveRoutingLauncher();
  }
})();
