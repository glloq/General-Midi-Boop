// tests/sf2-quota-sentinel.test.js
// Audit B2 M1: getTotalStoredSize must exclude the id=0 built-in-default
// sentinel, whose `size` column is repurposed to hold the default.sf2 mtime
// (~1.75e12). Counting it made totalStored exceed the 1 GB quota forever, so
// every custom SF2 upload was rejected with 413 in the default deployment.

import { describe, test, expect } from '@jest/globals';
import { SF2PresetService } from '../src/files/SF2PresetService.js';

// getTotalStoredSize only touches this.db.customSF2DB.listAll(), so drive it via
// prototype-call with a stub (avoids the constructor's filesystem side effects).
const totalFor = (rows) =>
  SF2PresetService.prototype.getTotalStoredSize.call({
    db: { customSF2DB: { listAll: () => rows } }
  });

describe('SF2PresetService.getTotalStoredSize — sentinel excluded (audit B2 M1)', () => {
  test('the id=0 sentinel (mtime-in-size) is not counted', () => {
    const rows = [
      { id: 0, size: 1_750_000_000_000 }, // sentinel: size repurposed as mtime
      { id: 1, size: 1000 },
      { id: 2, size: 2000 }
    ];
    expect(totalFor(rows)).toBe(3000);
  });

  test('with only the sentinel present, the total is 0 (uploads allowed)', () => {
    expect(totalFor([{ id: 0, size: 1_750_000_000_000 }])).toBe(0);
  });

  test('normal rows sum correctly', () => {
    expect(
      totalFor([
        { id: 3, size: 500 },
        { id: 4, size: 250 }
      ])
    ).toBe(750);
  });
});
