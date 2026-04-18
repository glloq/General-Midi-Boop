// tests/frontend/routing-summary-renderers.test.js
// Unit tests for pure HTML renderers extracted in P2-F.4/F.4c/F.4d.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};

function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../public/js/features/auto-assign/RoutingSummaryConstants.js');
  load('../../public/js/features/auto-assign/RoutingSummaryRenderers.js');
});

const R = () => win.RoutingSummaryRenderers;

describe('renderMiniKeyboard', () => {
  it('returns empty when range is invalid', () => {
    expect(R().renderMiniKeyboard(70, 60)).toBe('');
    expect(R().renderMiniKeyboard(NaN, 60)).toBe('');
  });

  it('renders white/black keys and a C label', () => {
    const html = R().renderMiniKeyboard(60, 72); // C4 to C5
    expect(html).toContain('rs-kb-keyboard');
    expect(html).toContain('rs-kb-white');
    expect(html).toContain('rs-kb-black');
    expect(html).toContain('C4');
    expect(html).toContain('C5');
  });
});

describe('renderChannelHistogram', () => {
  it('returns empty when no note range', () => {
    expect(R().renderChannelHistogram(null)).toBe('');
    expect(R().renderChannelHistogram({ noteRange: { min: null } })).toBe('');
  });

  it('renders histogram bars when distribution is present', () => {
    const html = R().renderChannelHistogram({
      noteRange: { min: 60, max: 64 },
      noteDistribution: { 60: 10, 62: 5, 64: 1 }
    });
    expect(html).toContain('rs-split-viz-ch-track');
    expect(html.match(/rs-split-viz-histo-bar/g)).toHaveLength(3);
  });

  it('applies transposition to histogram keys', () => {
    const html = R().renderChannelHistogram(
      { noteRange: { min: 60, max: 72 }, noteDistribution: { 60: 1, 72: 1 } },
      0
    );
    // Transposed +12 should shift the range so more notes map to new positions.
    const htmlShifted = R().renderChannelHistogram(
      { noteRange: { min: 60, max: 72 }, noteDistribution: { 60: 1, 72: 1 } },
      12
    );
    // Both return valid markup. They differ in title (note names) due to shift.
    expect(html).toContain('rs-split-viz-ch-track');
    expect(htmlShifted).toContain('rs-split-viz-ch-track');
    expect(htmlShifted).not.toBe(html);
  });
});

describe('renderMiniRange', () => {
  it('returns empty when analysis has no noteRange', () => {
    expect(R().renderMiniRange(null)).toBe('');
    expect(R().renderMiniRange({ noteRange: { min: null } })).toBe('');
  });

  it('renders channel range without assignment overlay', () => {
    const html = R().renderMiniRange({ noteRange: { min: 60, max: 72 } });
    expect(html).toContain('rs-mini-range');
    expect(html).toContain('rs-range-channel');
    expect(html).not.toContain('rs-range-inst');
  });

  it('renders instrument range overlay when assignment is provided', () => {
    const html = R().renderMiniRange(
      { noteRange: { min: 60, max: 72 } },
      { noteRangeMin: 48, noteRangeMax: 84 }
    );
    expect(html).toContain('rs-range-channel');
    expect(html).toContain('rs-range-inst');
  });
});

describe('renderDetailPlaceholder', () => {
  it('contains the placeholder wrapper', () => {
    const html = R().renderDetailPlaceholder();
    expect(html).toContain('rs-detail-placeholder');
    expect(html).toContain('<p>');
  });
});

describe('renderHeaderButtons', () => {
  it('renders all 5 buttons + filename tag', () => {
    const html = R().renderHeaderButtons({ selectedChannel: 0, filename: 'test.mid' });
    expect(html).toContain('rsPreviewAllBtn');
    expect(html).toContain('rsPreviewChBtn');
    expect(html).toContain('rsPreviewOrigBtn');
    expect(html).toContain('rsPreviewPauseBtn');
    expect(html).toContain('rsPreviewStopBtn');
    expect(html).toContain('test.mid');
  });

  it('disables the channel button when selectedChannel is null', () => {
    const html = R().renderHeaderButtons({ selectedChannel: null, filename: 'a.mid' });
    expect(html).toMatch(/rsPreviewChBtn.*disabled/);
    expect(html).toContain('?');
  });

  it('shows channel label = channel+1 (1-based)', () => {
    const html = R().renderHeaderButtons({ selectedChannel: 5, filename: 'a.mid' });
    // Display label mentions "6" somewhere in a previewChannel span.
    expect(html).toContain('6');
  });

  it('truncates long filenames to 30 chars with ellipsis', () => {
    const long = 'a'.repeat(50) + '.mid';
    const html = R().renderHeaderButtons({ selectedChannel: 0, filename: long });
    expect(html).toContain('\u2026');
  });

  it('uses the injected escape helper for the filename', () => {
    const html = R().renderHeaderButtons({
      selectedChannel: 0,
      filename: '<a>.mid',
      escape: (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    });
    expect(html).toContain('&lt;a&gt;.mid');
    expect(html).not.toContain('<a>.mid');
  });
});
