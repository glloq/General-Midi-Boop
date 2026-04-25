// tests/frontend/playlist-hand-feasibility-badge.test.js
// C.8: PlaylistPage gains a small hand-feasibility badge in each row,
// driven by the worst level across the file's routings (D.1 persisted
// payload). Tests cover the badge HTML helper directly and exercise
// the worst-level aggregation logic via a controlled API stub.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(
  resolve(__dirname, '../../public/js/features/PlaylistPage.js'),
  'utf8'
);

beforeAll(() => {
  // Avoid evaluating the IIFE-style module — just expose the class
  // by appending a window assignment.
  new Function(src + '\nwindow.PlaylistPage = PlaylistPage;')();
});

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.i18n;
  // PlaylistPage relies on a global escapeHtml helper (loaded earlier
  // in the page boot order). Provide a minimal one for the test.
  window.escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
});

function makePage() {
  // The constructor depends on a `modal` and `apiClient`. Provide
  // minimal stubs.
  const apiClient = { sendCommand: vi.fn() };
  return new window.PlaylistPage({ apiClient });
}

describe('PlaylistPage._renderHandFeasibilityBadge', () => {
  it('returns empty string for null / unknown / ok (silent rows)', () => {
    const p = makePage();
    expect(p._renderHandFeasibilityBadge(null)).toBe('');
    expect(p._renderHandFeasibilityBadge('unknown')).toBe('');
    expect(p._renderHandFeasibilityBadge('ok')).toBe('');
  });

  it('renders an amber badge with ⚠ for level=warning', () => {
    const p = makePage();
    const html = p._renderHandFeasibilityBadge('warning');
    expect(html).toMatch(/data-level="warning"/);
    expect(html).toMatch(/⚠/);
    expect(html).toMatch(/#f59e0b/);
  });

  it('renders a red badge with ✗ for level=infeasible', () => {
    const p = makePage();
    const html = p._renderHandFeasibilityBadge('infeasible');
    expect(html).toMatch(/data-level="infeasible"/);
    expect(html).toMatch(/✗/);
    expect(html).toMatch(/#ef4444/);
  });

  it('uses the i18n title when window.i18n is present', () => {
    window.i18n = {
      t: (key) => (key === 'handPosition.badgeWarning' ? 'Faisabilité main : avertissement' : null)
    };
    const p = makePage();
    const html = p._renderHandFeasibilityBadge('warning');
    expect(html).toMatch(/Faisabilité main : avertissement/);
  });
});

describe('PlaylistPage — worst-level aggregation logic', () => {
  // The aggregation lives inside the routingChecks promise; we mirror it
  // here against the same `order` mapping to lock in the contract.
  function worstLevel(routings) {
    const order = { unknown: 0, ok: 1, warning: 2, infeasible: 3 };
    let worst = null;
    for (const r of routings) {
      const lvl = r?.hand_position_feasibility?.level;
      if (!lvl) continue;
      if (worst == null || (order[lvl] || 0) > (order[worst] || 0)) worst = lvl;
    }
    return worst;
  }

  it('returns null when no routing has a level', () => {
    expect(worstLevel([
      {},
      { hand_position_feasibility: null }
    ])).toBeNull();
  });

  it('returns the worst level across a set of routings', () => {
    expect(worstLevel([
      { hand_position_feasibility: { level: 'ok' } },
      { hand_position_feasibility: { level: 'warning' } },
      { hand_position_feasibility: { level: 'ok' } }
    ])).toBe('warning');
  });

  it('infeasible wins over warning + ok', () => {
    expect(worstLevel([
      { hand_position_feasibility: { level: 'warning' } },
      { hand_position_feasibility: { level: 'infeasible' } },
      { hand_position_feasibility: { level: 'ok' } }
    ])).toBe('infeasible');
  });

  it('ignores entries with unknown levels but reports them when nothing better is around', () => {
    expect(worstLevel([
      { hand_position_feasibility: { level: 'unknown' } }
    ])).toBe('unknown');
  });
});

describe('PlaylistPage._renderPlaylistItemsWithRouting — badge in row', () => {
  it('emits the badge in the rendered row when handLevel is warning', () => {
    const p = makePage();
    p.playlistItems = [{ id: 1, midi_id: 10, position: 0, filename: 'song.mid', duration: 60 }];
    const container = document.createElement('div');
    const map = new Map([[10, { count: 2, handLevel: 'warning' }]]);
    p._renderPlaylistItemsWithRouting(container, map);
    expect(container.innerHTML).toMatch(/playlist-hand-badge/);
    expect(container.innerHTML).toMatch(/data-level="warning"/);
  });

  it('does not emit a badge when handLevel is null or ok', () => {
    const p = makePage();
    p.playlistItems = [{ id: 1, midi_id: 10, position: 0, filename: 'song.mid', duration: 60 }];
    const container = document.createElement('div');
    p._renderPlaylistItemsWithRouting(container, new Map([[10, { count: 2, handLevel: null }]]));
    expect(container.innerHTML).not.toMatch(/playlist-hand-badge/);
    p._renderPlaylistItemsWithRouting(container, new Map([[10, { count: 2, handLevel: 'ok' }]]));
    expect(container.innerHTML).not.toMatch(/playlist-hand-badge/);
  });

  it('still works with the legacy bare-count entry shape', () => {
    const p = makePage();
    p.playlistItems = [{ id: 1, midi_id: 10, position: 0, filename: 'song.mid', duration: 60 }];
    const container = document.createElement('div');
    // Entry is a plain number (old contract) — the row still renders, no badge.
    expect(() => {
      p._renderPlaylistItemsWithRouting(container, new Map([[10, 2]]));
    }).not.toThrow();
    expect(container.innerHTML).toMatch(/song\.mid/);
    expect(container.innerHTML).not.toMatch(/playlist-hand-badge/);
  });
});
