// tests/frontend/realtime-status-toasts.test.js
// Frontend consumer for previously-orphaned backend WS events:
// system_lag (T2.3), reconnecting/reconnect_exhausted (T2.5),
// playlist_waiting (T2.8), settings_applied (T2.9).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/RealtimeStatusToasts.js'),
  'utf8'
);

function installStubApi() {
  const handlers = new Map();
  window.api = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    __emit(event, data) {
      (handlers.get(event) || []).forEach((h) => h(data));
    }
  };
  return window.api;
}

function loadModule() {
  new Function(src)();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  delete window.__realtimeStatusToastsInstalled;
  delete window.RealtimeStatusToasts;
  delete window.api;
  delete window.i18n;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeStatusToasts — system_lag (T2.3)', () => {
  it('shows a lag toast on system_lag', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('system_lag', { lagMs: 123, thresholdMs: 50 });
    const toasts = document.querySelectorAll('.rt-status-toast');
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toMatch(/123/);
  });

  it('throttles repeated lag events within the throttle window', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('system_lag', { lagMs: 100 });
    api.__emit('system_lag', { lagMs: 200 }); // within 5s → suppressed
    expect(document.querySelectorAll('.rt-status-toast').length).toBe(1);
    vi.advanceTimersByTime(5001);
    api.__emit('system_lag', { lagMs: 300 }); // window elapsed → shown
    // First toast auto-dismissed after 4s; the third is present.
    const texts = [...document.querySelectorAll('.rt-status-toast')].map((e) => e.textContent);
    expect(texts.some((t) => /300/.test(t))).toBe(true);
  });
});

describe('RealtimeStatusToasts — reconnection banner (T2.5)', () => {
  it('shows a reconnecting banner on reconnecting', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('reconnecting', { attempt: 3, delayMs: 1000 });
    const banner = document.getElementById('rt-connection-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/3/);
  });

  it('shows a lost-connection banner with a reload button on reconnect_exhausted', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('reconnect_exhausted', { attempts: 12 });
    const banner = document.getElementById('rt-connection-banner');
    expect(banner).not.toBeNull();
    expect(banner.querySelector('#rt-banner-reload')).not.toBeNull();
  });

  it('clears the banner once connected fires', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('reconnect_exhausted', { attempts: 12 });
    expect(document.getElementById('rt-connection-banner')).not.toBeNull();
    api.__emit('connected');
    expect(document.getElementById('rt-connection-banner')).toBeNull();
  });

  it('reuses a single banner element across successive states', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('reconnecting', { attempt: 1 });
    api.__emit('reconnecting', { attempt: 2 });
    api.__emit('reconnect_exhausted', { attempts: 12 });
    expect(document.querySelectorAll('#rt-connection-banner').length).toBe(1);
  });

  it('a reconnecting event after exhaustion does NOT downgrade the lost banner', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('reconnect_exhausted', { attempts: 12 });
    // The client keeps retrying → emits reconnecting again.
    api.__emit('reconnecting', { attempt: 13 });
    const banner = document.getElementById('rt-connection-banner');
    expect(banner).not.toBeNull();
    // Reload button must survive; banner must not revert to "reconnecting".
    expect(banner.querySelector('#rt-banner-reload')).not.toBeNull();
    // connected clears the latch so a later reconnecting shows normally again.
    api.__emit('connected');
    expect(document.getElementById('rt-connection-banner')).toBeNull();
    api.__emit('reconnecting', { attempt: 1 });
    const b2 = document.getElementById('rt-connection-banner');
    expect(b2).not.toBeNull();
    expect(b2.querySelector('#rt-banner-reload')).toBeNull();
  });
});

describe('RealtimeStatusToasts — playlist countdown (T2.8)', () => {
  it('shows a countdown chip on playlist_waiting', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playlist_waiting', { playlistId: 1, remainingSeconds: 8 });
    const chip = document.getElementById('rt-playlist-countdown');
    expect(chip).not.toBeNull();
    expect(chip.textContent).toMatch(/8s/);
  });

  it('updates the same chip and removes it at zero', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playlist_waiting', { remainingSeconds: 3 });
    api.__emit('playlist_waiting', { remainingSeconds: 2 });
    expect(document.querySelectorAll('#rt-playlist-countdown').length).toBe(1);
    api.__emit('playlist_waiting', { remainingSeconds: 0 });
    expect(document.getElementById('rt-playlist-countdown')).toBeNull();
  });

  it('clears the chip when the next track starts (playlist_item_changed)', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playlist_waiting', { remainingSeconds: 1 });
    expect(document.getElementById('rt-playlist-countdown')).not.toBeNull();
    api.__emit('playlist_item_changed', { index: 2 });
    expect(document.getElementById('rt-playlist-countdown')).toBeNull();
  });
});

describe('RealtimeStatusToasts — settings_applied (T2.9)', () => {
  it('shows a synced toast on settings_applied', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('settings_applied', { deferredCount: 2, timestamp: 1 });
    const toasts = document.querySelectorAll('.rt-status-toast');
    expect(toasts.length).toBe(1);
  });
});

describe('RealtimeStatusToasts — i18n', () => {
  it('uses window.i18n.t translations when available', () => {
    window.i18n = {
      t(key) {
        return key === 'connection.lost' ? 'Server connection lost' : key;
      }
    };
    const api = installStubApi();
    loadModule();
    api.__emit('reconnect_exhausted', { attempts: 12 });
    expect(document.getElementById('rt-connection-banner').textContent).toMatch(
      /Server connection lost/
    );
  });
});
