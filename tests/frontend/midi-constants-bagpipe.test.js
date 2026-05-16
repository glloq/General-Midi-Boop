// tests/frontend/midi-constants-bagpipe.test.js
// MidiConstants.normalizeBagpipeDrones — the single shared normalizer
// used by ISMSections (render/collect), KeyboardModal.getBagpipeConfig
// and BagpipeView. Accepts the legacy number[] shape and the
// {note,enabled} object shape; drops out-of-range / non-integer notes;
// never injects a default (callers do that).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, '../../public/js/utils/MidiConstants.js'), 'utf8');
  new Function(src)();
});

const norm = (...a) => window.MidiConstants.normalizeBagpipeDrones(...a);

describe('MidiConstants.normalizeBagpipeDrones', () => {
  it('legacy number[] → enabled objects', () => {
    expect(norm([45, 33])).toEqual([
      { note: 45, enabled: true }, { note: 33, enabled: true }]);
  });

  it('object shape preserves enabled and drops out-of-range', () => {
    expect(norm([{ note: 45, enabled: false }, { note: 200 }]))
      .toEqual([{ note: 45, enabled: false }]);
  });

  it('rounds non-integers and treats missing enabled as true', () => {
    expect(norm([45.4, { note: 33.6 }]))
      .toEqual([{ note: 45, enabled: true }, { note: 34, enabled: true }]);
  });

  it('non-array → []', () => {
    expect(norm('x')).toEqual([]);
    expect(norm(undefined)).toEqual([]);
    expect(norm(null)).toEqual([]);
  });

  it('empty array → [] (no default injected)', () => {
    expect(norm([])).toEqual([]);
  });
});
