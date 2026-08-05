// tests/devicemanager-descriptor-revision-skip.test.js
// §7 step 4: the handshake/notification revision is an ETag — once a descriptor
// has been applied, an unchanged revision must NOT trigger another block 0x10
// transfer; a changed revision must. Invoked via prototype.call with stubs.

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

const P = DeviceManager.prototype;
const VALID = '{"gmb_descriptor":2,"instruments":[{"channel":0}]}';

function makeCtx() {
  return {
    outputs: new Map([['dev', { send: jest.fn() }]]),
    descriptorService: { applyDescriptor: jest.fn(() => ({ applied: true })) },
    logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
    _descriptorFetches: new Map(),
    _descriptorRevisions: new Map(),
    _startDescriptorFetch: P._startDescriptorFetch,
    _requestNextDescriptorChunk: P._requestNextDescriptorChunk,
    _onDescriptorChunk: P._onDescriptorChunk,
    _finishDescriptorFetch: P._finishDescriptorFetch
  };
}
const sends = (ctx) => ctx.outputs.get('dev').send;

describe('descriptor revision ETag skip', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('records the applied revision, then skips an unchanged one and re-fetches a changed one', () => {
    const ctx = makeCtx();

    // First fetch (revision 42) → transfers and applies.
    ctx._startDescriptorFetch('dev', 42);
    expect(sends(ctx)).toHaveBeenCalledTimes(1);
    ctx._onDescriptorChunk('dev', { total: 1, index: 0, payload: VALID });
    expect(ctx.descriptorService.applyDescriptor).toHaveBeenCalledTimes(1);
    expect(ctx._descriptorRevisions.get('dev')).toBe(42);

    // Same revision → no transfer.
    sends(ctx).mockClear();
    ctx._startDescriptorFetch('dev', 42);
    expect(sends(ctx)).not.toHaveBeenCalled();
    expect(ctx._descriptorFetches.has('dev')).toBe(false);

    // Changed revision → transfers again.
    ctx._startDescriptorFetch('dev', 43);
    expect(sends(ctx)).toHaveBeenCalledTimes(1);
  });

  test('a null revision (unknown) never skips', () => {
    const ctx = makeCtx();
    ctx._descriptorRevisions.set('dev', 42);
    ctx._startDescriptorFetch('dev', null);
    expect(sends(ctx)).toHaveBeenCalledTimes(1);
  });

  test('the revision is not recorded when the apply is rejected', () => {
    const ctx = makeCtx();
    ctx.descriptorService.applyDescriptor.mockReturnValueOnce({ applied: false, errors: ['x'] });
    ctx._startDescriptorFetch('dev', 42);
    ctx._onDescriptorChunk('dev', { total: 1, index: 0, payload: VALID });
    expect(ctx._descriptorRevisions.has('dev')).toBe(false);
  });
});
