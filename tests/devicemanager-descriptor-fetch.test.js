// tests/devicemanager-descriptor-fetch.test.js
// Block 0x10 descriptor transfer (docs/SYSEX_IDENTITY.md §3/§7): parse a chunk
// response frame, and the sequential fetch state machine that requests chunks,
// reassembles, and hands the parsed descriptor to DescriptorService. Invoked
// via prototype.call with fake timers + stubs (no MIDI stack / DB).

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

const PAST_TIMEOUT = 5200; // > DESCRIPTOR_CHUNK_TIMEOUT_MS (5000)

const P = DeviceManager.prototype;

function chunkFrame({ total, index, payload }) {
  return [
    0xf0,
    0x7d,
    0x00,
    0x10,
    0x01,
    total & 0x7f,
    (total >> 7) & 0x7f,
    index & 0x7f,
    (index >> 7) & 0x7f,
    ...Array.from(payload, (c) => c.charCodeAt(0) & 0x7f),
    0xf7
  ];
}

function makeCtx(overrides = {}) {
  return {
    outputs: new Map([['dev', { send: jest.fn() }]]),
    descriptorService: { applyDescriptor: jest.fn() },
    logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
    _descriptorFetches: new Map(),
    parseDescriptorChunk: P.parseDescriptorChunk,
    _startDescriptorFetch: P._startDescriptorFetch,
    _requestNextDescriptorChunk: P._requestNextDescriptorChunk,
    _onDescriptorChunk: P._onDescriptorChunk,
    _finishDescriptorFetch: P._finishDescriptorFetch,
    ...overrides
  };
}
const sends = (ctx) => ctx.outputs.get('dev').send;

describe('parseDescriptorChunk', () => {
  test('decodes total/index (14-bit LE) and ASCII payload', () => {
    const r = P.parseDescriptorChunk.call(
      {},
      chunkFrame({ total: 200, index: 130, payload: 'hi' })
    );
    expect(r).toEqual({ total: 200, index: 130, payload: 'hi' });
  });

  test('rejects non-0x10 frames and short frames', () => {
    // a 24-byte handshake is block 0x01, not 0x10
    expect(P.parseDescriptorChunk.call({}, [0xf0, 0x7d, 0x00, 0x01, 0x01, 0xf7])).toBeNull();
    expect(P.parseDescriptorChunk.call({}, [0xf0, 0x7d, 0x00, 0x10, 0x01, 0xf7])).toBeNull(); // too short
    expect(P.parseDescriptorChunk.call({}, 'nope')).toBeNull();
  });
});

describe('descriptor fetch state machine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('requests chunk 0 on start', () => {
    const ctx = makeCtx();
    ctx._startDescriptorFetch('dev');
    expect(sends(ctx)).toHaveBeenCalledWith('sysex', [0xf0, 0x7d, 0x00, 0x10, 0x00, 0, 0, 0xf7]);
  });

  test('collects chunks in order and applies the parsed descriptor', () => {
    const ctx = makeCtx();
    ctx._startDescriptorFetch('dev');
    ctx._onDescriptorChunk('dev', { total: 2, index: 0, payload: '{"gmb_descriptor":2,' });
    // requested chunk 1 next
    expect(sends(ctx)).toHaveBeenCalledWith('sysex', [0xf0, 0x7d, 0x00, 0x10, 0x00, 1, 0, 0xf7]);
    ctx._onDescriptorChunk('dev', {
      total: 2,
      index: 1,
      payload: '"instruments":[{"channel":0}]}'
    });

    expect(ctx.descriptorService.applyDescriptor).toHaveBeenCalledWith('dev', {
      gmb_descriptor: 2,
      instruments: [{ channel: 0 }]
    });
    expect(ctx._descriptorFetches.has('dev')).toBe(false); // fetch cleared
  });

  test('retries a silent chunk up to the cap, then aborts', () => {
    const ctx = makeCtx();
    ctx._startDescriptorFetch('dev'); // send #1 (index 0)
    jest.advanceTimersByTime(PAST_TIMEOUT); // → retry, send #2
    jest.advanceTimersByTime(PAST_TIMEOUT); // → retry, send #3
    jest.advanceTimersByTime(PAST_TIMEOUT); // → cap reached → abort
    expect(sends(ctx)).toHaveBeenCalledTimes(3);
    expect(ctx._descriptorFetches.has('dev')).toBe(false);
  });

  test('invalid JSON falls back to level 0 (no apply, no crash)', () => {
    const ctx = makeCtx();
    ctx._startDescriptorFetch('dev');
    ctx._onDescriptorChunk('dev', { total: 1, index: 0, payload: '{not json' });
    expect(ctx.descriptorService.applyDescriptor).not.toHaveBeenCalled();
    expect(ctx._descriptorFetches.has('dev')).toBe(false);
  });

  test('no-op without an output, without a descriptor service, or when already fetching', () => {
    const noOut = makeCtx({ outputs: new Map() });
    noOut._startDescriptorFetch('dev');
    expect(noOut._descriptorFetches.has('dev')).toBe(false);

    const noSvc = makeCtx({ descriptorService: undefined });
    noSvc._startDescriptorFetch('dev');
    expect(noSvc._descriptorFetches.has('dev')).toBe(false);

    const ctx = makeCtx();
    ctx._startDescriptorFetch('dev');
    expect(sends(ctx)).toHaveBeenCalledTimes(1);
    ctx._startDescriptorFetch('dev'); // already fetching → no new request
    expect(sends(ctx)).toHaveBeenCalledTimes(1);
  });
});
