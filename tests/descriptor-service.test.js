// tests/descriptor-service.test.js
// DescriptorService.applyDescriptor orchestrates §7 steps 6-10: validate → map
// each declared instrument onto the capability store → honour `configured` →
// compute §6 override purges + §9 lookahead → broadcast. Tested with a mock
// repository / event bus (no DB).

import { describe, test, expect, jest } from '@jest/globals';
import { DescriptorService } from '../src/midi/instrument/DescriptorService.js';

function makeService() {
  const repo = { updateCapabilities: jest.fn() };
  const eventBus = { emit: jest.fn() };
  const svc = new DescriptorService({
    instrumentRepository: repo,
    eventBus,
    logger: { info() {}, warn() {}, debug() {} }
  });
  return { svc, repo, eventBus };
}

const twoInstruments = {
  gmb_descriptor: 2,
  revision: 42,
  instruments: [
    { channel: 0, configured: true, gm_program: 24, notes: { mode: 'range', min: 60, max: 88 } },
    {
      channel: 1,
      configured: true,
      notes: { mode: 'discrete', list: [36, 38] },
      polyphony: { max: 2 }
    }
  ]
};

describe('DescriptorService.applyDescriptor', () => {
  test('applies each configured instrument to the repository', () => {
    const { svc, repo, eventBus } = makeService();
    const res = svc.applyDescriptor('dev', twoInstruments);

    expect(res.applied).toBe(true);
    expect(repo.updateCapabilities).toHaveBeenCalledTimes(2);
    expect(repo.updateCapabilities).toHaveBeenCalledWith(
      'dev',
      0,
      expect.objectContaining({
        note_range_min: 60,
        note_range_max: 88,
        capabilities_source: 'auto'
      })
    );
    expect(repo.updateCapabilities).toHaveBeenCalledWith(
      'dev',
      1,
      expect.objectContaining({
        note_selection_mode: 'discrete',
        selected_notes: [36, 38],
        polyphony: 2
      })
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'instruments_configured',
      expect.objectContaining({ deviceId: 'dev', count: 2 })
    );
  });

  test('an unconfigured instrument is skipped (manual entry, nothing written)', () => {
    const { svc, repo } = makeService();
    const d = {
      gmb_descriptor: 2,
      instruments: [
        { channel: 0, configured: false, notes: { mode: 'range', min: 60, max: 72 } },
        { channel: 1, configured: true, notes: { mode: 'range', min: 40, max: 60 } }
      ]
    };
    const res = svc.applyDescriptor('dev', d);
    expect(repo.updateCapabilities).toHaveBeenCalledTimes(1);
    expect(repo.updateCapabilities).toHaveBeenCalledWith('dev', 1, expect.any(Object));
    expect(res.instruments.find((i) => i.channel === 0)).toMatchObject({
      configured: false,
      applied: false
    });
  });

  test('an invalid descriptor is rejected — nothing written, no broadcast', () => {
    const { svc, repo, eventBus } = makeService();
    const res = svc.applyDescriptor('dev', { gmb_descriptor: 1, instruments: [] });
    expect(res.applied).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(repo.updateCapabilities).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  test('override diff: only fields the device moved are purged (§6)', () => {
    const { svc } = makeService();
    const previous = {
      gmb_descriptor: 2,
      instruments: [
        { channel: 0, configured: true, gm_program: 24, notes: { mode: 'range', min: 60, max: 88 } }
      ]
    };
    const next = {
      gmb_descriptor: 2,
      instruments: [
        { channel: 0, configured: true, gm_program: 25, notes: { mode: 'range', min: 60, max: 88 } }
      ]
    };
    const res = svc.applyDescriptor('dev', next, {
      previousDescriptor: previous,
      overriddenFieldsByChannel: { 0: ['gm_program', 'notes'] }
    });
    const inst0 = res.instruments.find((i) => i.channel === 0);
    expect(inst0.purgedOverrides).toEqual(['gm_program']); // device moved gm_program
    expect(inst0.keptOverrides).toEqual(['notes']); // notes unchanged → override kept
  });

  test('lookahead is reported from timing.prepare.max_ms', () => {
    const { svc, eventBus } = makeService();
    const d = {
      gmb_descriptor: 2,
      instruments: [{ channel: 0, configured: true, timing: { prepare: { max_ms: 150 } } }]
    };
    const res = svc.applyDescriptor('dev', d);
    expect(res.lookaheadMs).toBe(150);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'instruments_configured',
      expect.objectContaining({ lookaheadMs: 150 })
    );
  });

  test('a repository failure isolates to that instrument', () => {
    const { svc, repo } = makeService();
    repo.updateCapabilities.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const res = svc.applyDescriptor('dev', twoInstruments);
    expect(res.applied).toBe(true); // overall still applied
    expect(res.instruments.find((i) => i.channel === 0)).toMatchObject({ applied: false });
    expect(res.instruments.find((i) => i.channel === 1)).toMatchObject({ applied: true });
  });
});
