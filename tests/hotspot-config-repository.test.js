// tests/hotspot-config-repository.test.js
// Audit A3 C4-M1: HotspotConfigRepository.update() must merge a patch onto the
// STORED config, and must NOT silently reset to factory defaults when the
// stored value is unreadable (that would knock the Pi off its own AP). Driven
// with a stubbed DB handle (no native SQLite binding needed).

import { describe, test, expect, jest } from '@jest/globals';
import HotspotConfigRepository from '../src/repositories/HotspotConfigRepository.js';

function makeRepo(getResult) {
  const runSpy = jest.fn();
  const db = {
    prepare: () => ({
      get: () => getResult,
      run: (...args) => runSpy(...args)
    })
  };
  return { repo: new HotspotConfigRepository(db), runSpy };
}

describe('HotspotConfigRepository.update — no silent reset (audit A3 C4-M1)', () => {
  test('a one-field patch merges onto the stored config, not defaults', () => {
    const stored = { ssid: 'MySSID', password: 'secret', band: 'a', channel: 6 };
    const { repo, runSpy } = makeRepo({ value: JSON.stringify(stored) });
    const merged = repo.update({ channel: 11 });
    expect(merged).toEqual({ ssid: 'MySSID', password: 'secret', band: 'a', channel: 11 });
    // The persisted blob (2nd run() arg: value) preserves the stored fields.
    const persisted = JSON.parse(runSpy.mock.calls[0][1]);
    expect(persisted.ssid).toBe('MySSID');
    expect(persisted.password).toBe('secret');
  });

  test('throws instead of resetting when the stored value is unparseable', () => {
    const { repo, runSpy } = makeRepo({ value: '{not valid json' });
    expect(() => repo.update({ password: 'new' })).toThrow(/unreadable hotspot config/);
    expect(runSpy).not.toHaveBeenCalled(); // nothing persisted
  });

  test('uses defaults as the base for the first write (no row yet)', () => {
    const { repo, runSpy } = makeRepo(undefined);
    const merged = repo.update({ ssid: 'FreshAP' });
    expect(merged).toEqual({ ssid: 'FreshAP', password: '', band: 'bg', channel: 0 });
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
