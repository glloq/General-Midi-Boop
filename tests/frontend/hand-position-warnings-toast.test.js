// tests/frontend/hand-position-warnings-toast.test.js
// Frontend consumer of the `playback_hand_position_warnings` WS event.
// Verifies: aggregation within the debounce window, toast content,
// summary formatter, dedup of bursts, no-op on empty payloads.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/HandPositionWarningsToast.js'),
  'utf8'
);

// Minimal API stub that records handlers and allows manual firing.
function installStubApi() {
  const handlers = new Map();
  window.api = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    __emit(event, data) {
      (handlers.get(event) || []).forEach(h => h(data));
    }
  };
  return window.api;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  delete window.__handPositionWarningsToastInstalled;
  delete window.HandPositionWarningsToast;
  delete window.api;
  delete window.i18n;
});

afterEach(() => {
  vi.useRealTimers();
});

function loadModule() {
  new Function(src)();
}

describe('HandPositionWarningsToast — summarize()', () => {
  it('aggregates and orders warning codes by count', () => {
    installStubApi();
    loadModule();
    const out = window.HandPositionWarningsToast.summarize([
      { code: 'move_too_fast' },
      { code: 'move_too_fast' },
      { code: 'too_many_fingers' },
      { code: 'move_too_fast' }
    ]);
    expect(out).toMatch(/3×/);
    expect(out).toMatch(/1×/);
    expect(out.indexOf('3×')).toBeLessThan(out.indexOf('1×'));
  });

  it('falls back to the raw code label for unknown codes', () => {
    installStubApi();
    loadModule();
    const out = window.HandPositionWarningsToast.summarize([{ code: 'mystery_code' }]);
    expect(out).toMatch(/mystery_code/);
  });
});

describe('HandPositionWarningsToast — event aggregation', () => {
  it('shows one toast for a burst of warnings on the same fileId', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playback_hand_position_warnings', {
      fileId: 42,
      warnings: [
        { code: 'move_too_fast', time: 1 },
        { code: 'move_too_fast', time: 2 },
        { code: 'chord_span_exceeded', time: 3 }
      ]
    });
    api.__emit('playback_hand_position_warnings', {
      fileId: 42,
      warnings: [{ code: 'too_many_fingers', time: 4 }]
    });

    // Still within the debounce window → no toast yet.
    expect(document.querySelectorAll('.hand-position-warnings-toast').length).toBe(0);

    vi.advanceTimersByTime(500);
    const toasts = document.querySelectorAll('.hand-position-warnings-toast');
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toMatch(/Faisabilit/);
    expect(toasts[0].textContent).toMatch(/move_too_fast|déplacements|moves too fast/i);
  });

  it('produces independent toasts for different fileIds', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playback_hand_position_warnings', {
      fileId: 1,
      warnings: [{ code: 'move_too_fast' }]
    });
    api.__emit('playback_hand_position_warnings', {
      fileId: 2,
      warnings: [{ code: 'chord_span_exceeded' }]
    });

    vi.advanceTimersByTime(500);
    const toasts = document.querySelectorAll('.hand-position-warnings-toast');
    expect(toasts.length).toBe(2);
  });

  it('is a no-op on empty warnings arrays', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playback_hand_position_warnings', { fileId: 1, warnings: [] });
    api.__emit('playback_hand_position_warnings', { fileId: 2 });
    api.__emit('playback_hand_position_warnings', null);

    vi.advanceTimersByTime(500);
    expect(document.querySelectorAll('.hand-position-warnings-toast').length).toBe(0);
  });

  it('caps the aggregated burst at BURST_CAP warnings', () => {
    const api = installStubApi();
    loadModule();
    const warnings = Array.from({ length: 50 }, () => ({ code: 'move_too_fast' }));
    api.__emit('playback_hand_position_warnings', { fileId: 1, warnings });

    vi.advanceTimersByTime(500);
    const toast = document.querySelector('.hand-position-warnings-toast');
    expect(toast).not.toBeNull();
    // 20 is the hard cap hard-coded in BURST_CAP.
    expect(toast.textContent).toMatch(/20×/);
  });

  it('auto-dismisses the toast after the display duration', () => {
    const api = installStubApi();
    loadModule();
    api.__emit('playback_hand_position_warnings', {
      fileId: 1,
      warnings: [{ code: 'move_too_fast' }]
    });
    vi.advanceTimersByTime(500);
    expect(document.querySelectorAll('.hand-position-warnings-toast').length).toBe(1);

    vi.advanceTimersByTime(5500);
    expect(document.querySelectorAll('.hand-position-warnings-toast').length).toBe(0);
  });
});

describe('HandPositionWarningsToast — i18n integration', () => {
  it('uses window.i18n.t translations when available', () => {
    window.i18n = {
      t(key) {
        const map = {
          'handPosition.toastPrefix': 'Hand feasibility',
          'handPosition.warnMoveTooFast': 'moves too fast'
        };
        return map[key] || key;
      }
    };
    const api = installStubApi();
    loadModule();
    api.__emit('playback_hand_position_warnings', {
      fileId: 1,
      warnings: [{ code: 'move_too_fast' }]
    });
    vi.advanceTimersByTime(500);
    const toast = document.querySelector('.hand-position-warnings-toast');
    expect(toast.textContent).toMatch(/Hand feasibility/);
    expect(toast.textContent).toMatch(/moves too fast/);
  });
});
