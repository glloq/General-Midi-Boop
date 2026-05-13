import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  WsOutputQueue,
  COALESCABLE_EVENTS,
  DEFAULT_HIGH_WATERMARK
} from '../../src/api/WsOutputQueue.js';
import codec from '../../shared/BinaryFrameCodec.js';

// --- Test doubles -----------------------------------------------------------

function makeClient({ readyState = 1, bufferedAmount = 0, failSend = false } = {}) {
  return {
    readyState,
    bufferedAmount,
    sent: [],
    send(frame, opts) {
      if (failSend) throw new Error('send failure');
      this.sent.push({ frame, opts: opts || null });
    }
  };
}

function makeLogger() {
  return {
    debugCalls: [],
    warnCalls: [],
    errorCalls: [],
    isDebugEnabled() { return false; },
    isInfoEnabled() { return true; },
    isWarnEnabled() { return true; },
    debug(msg) { this.debugCalls.push(msg); },
    info() {},
    warn(msg) { this.warnCalls.push(msg); },
    error(msg) { this.errorCalls.push(msg); }
  };
}

/**
 * Build a queue with a manual scheduler so we can trigger flushes
 * deterministically inside tests.
 */
function makeQueue(opts = {}) {
  const clients = new Set(opts.clients || []);
  const logger = opts.logger || makeLogger();
  const scheduled = [];
  const { clients: _ignored, logger: _ignored2, ...rest } = opts;
  const queue = new WsOutputQueue({
    clients,
    logger,
    scheduleFlush: (cb) => { scheduled.push(cb); },
    ...rest
  });
  const drain = () => {
    while (scheduled.length) scheduled.shift()();
  };
  return { queue, clients, logger, drain, scheduled };
}

// --- Tests ------------------------------------------------------------------

describe('WsOutputQueue', () => {
  describe('queue management', () => {
    test('enqueue is non-blocking — no client.send during enqueue', () => {
      const c = makeClient();
      const { queue } = makeQueue({ clients: [c] });
      queue.enqueue('device_connected', { id: 'foo' });
      expect(c.sent).toHaveLength(0);
    });

    test('flush sends to every OPEN client', () => {
      const a = makeClient();
      const b = makeClient();
      const { queue, drain } = makeQueue({ clients: [a, b] });
      queue.enqueue('device_connected', { id: 'foo' });
      drain();
      expect(a.sent).toHaveLength(1);
      expect(b.sent).toHaveLength(1);
    });

    test('coalescable events: only latest payload is sent', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.enqueueLatest('playback_position', { position: 1, percentage: 1 });
      queue.enqueueLatest('playback_position', { position: 2, percentage: 2 });
      queue.enqueueLatest('playback_position', { position: 3, percentage: 3 });
      drain();
      expect(c.sent).toHaveLength(1);
      // Decode the binary frame
      const decoded = codec.decode(c.sent[0].frame);
      expect(decoded.payload.position).toBeCloseTo(3, 5);
    });

    test('coalesced counter increments on overwrite', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.enqueueLatest('playback_position', { position: 1, percentage: 1 });
      queue.enqueueLatest('playback_position', { position: 2, percentage: 2 });
      drain();
      expect(queue.getStats().coalesced).toBe(1);
    });

    test('multiple coalescable events flush in order', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.enqueueLatest('playback_position', { position: 1, percentage: 1 });
      queue.enqueueLatest('system_lag', { lagMs: 5, thresholdMs: 50 });
      drain();
      expect(c.sent).toHaveLength(2);
    });

    test('broadcast() routes to enqueueLatest for coalescable events', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      // 3 broadcasts -> 1 frame after coalescing
      queue.broadcast('playback_position', { position: 1, percentage: 1 });
      queue.broadcast('playback_position', { position: 2, percentage: 2 });
      queue.broadcast('playback_position', { position: 3, percentage: 3 });
      drain();
      expect(c.sent).toHaveLength(1);
    });

    test('broadcast() routes to enqueue for discrete events', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.broadcast('device_connected', { id: 'a' });
      queue.broadcast('device_connected', { id: 'b' });
      drain();
      expect(c.sent).toHaveLength(2);
    });
  });

  describe('backpressure', () => {
    test('skips clients above high watermark', () => {
      const fast = makeClient();
      const slow = makeClient({ bufferedAmount: DEFAULT_HIGH_WATERMARK + 1 });
      const { queue, drain } = makeQueue({ clients: [fast, slow] });
      queue.broadcast('device_connected', { id: 'foo' });
      drain();
      expect(fast.sent).toHaveLength(1);
      expect(slow.sent).toHaveLength(0);
      expect(queue.getStats().droppedByClient).toBe(1);
    });

    test('coalescable events recover automatically (next state overwrites)', () => {
      const slow = makeClient({ bufferedAmount: DEFAULT_HIGH_WATERMARK + 1 });
      const { queue, drain } = makeQueue({ clients: [slow] });
      queue.broadcast('playback_position', { position: 1, percentage: 1 });
      drain();
      expect(slow.sent).toHaveLength(0);
      // Slow client recovers; next state goes through
      slow.bufferedAmount = 0;
      queue.broadcast('playback_position', { position: 2, percentage: 2 });
      drain();
      expect(slow.sent).toHaveLength(1);
      const decoded = codec.decode(slow.sent[0].frame);
      expect(decoded.payload.position).toBeCloseTo(2, 5);
    });

    test('critical watermark triggers warning + drop', () => {
      const dead = makeClient({ bufferedAmount: 2 * 1024 * 1024 });
      const logger = makeLogger();
      const { queue, drain } = makeQueue({ clients: [dead], logger });
      queue.broadcast('device_connected', { id: 'foo' });
      drain();
      expect(dead.sent).toHaveLength(0);
      expect(queue.getStats().criticalEvents).toBe(1);
      expect(queue.getStats().droppedByClient).toBe(1);
      expect(logger.warnCalls.length).toBeGreaterThan(0);
    });

    test('event loop lag tightens threshold', () => {
      const c = makeClient({ bufferedAmount: 40 * 1024 }); // below default 64 KiB
      const loopMon = { currentLag: 50 }; // > 10 ms -> threshold halved to 32 KiB
      const { queue, drain } = makeQueue({ clients: [c], eventLoopMonitor: loopMon });
      queue.broadcast('device_connected', { id: 'foo' });
      drain();
      expect(c.sent).toHaveLength(0);
      expect(queue.getStats().droppedByClient).toBe(1);
    });
  });

  describe('queue depth', () => {
    test('drops oldest discrete event when queue full', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c], maxQueueDepth: 3 });
      for (let i = 0; i < 5; i++) {
        queue.enqueue('device_connected', { i });
      }
      drain();
      // 2 oldest dropped
      expect(c.sent).toHaveLength(3);
      expect(queue.getStats().droppedByDepth).toBe(2);
    });

    test('latest slot count never exceeds the coalescable event set', () => {
      const c = makeClient();
      const { queue } = makeQueue({ clients: [c] });
      for (const ev of COALESCABLE_EVENTS) {
        queue.enqueueLatest(ev, {});
      }
      expect(queue.getStats().latestSlots).toBe(COALESCABLE_EVENTS.size);
    });
  });

  describe('encoding', () => {
    test('binary path used for high-frequency events', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.broadcast('playback_position', { position: 1, percentage: 1 });
      drain();
      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].opts).toEqual({ binary: true });
      expect(c.sent[0].frame).toBeInstanceOf(ArrayBuffer);
    });

    test('JSON fallback for non-binary events', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.broadcast('device_connected', { id: 'foo' });
      drain();
      expect(typeof c.sent[0].frame).toBe('string');
      expect(c.sent[0].opts).toBeNull();
      const parsed = JSON.parse(c.sent[0].frame);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('device_connected');
      expect(parsed.data).toEqual({ id: 'foo' });
    });

    test('binary disabled => everything goes JSON', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c], enableBinary: false });
      queue.broadcast('playback_position', { position: 1, percentage: 1 });
      drain();
      expect(typeof c.sent[0].frame).toBe('string');
    });

    test('binary encoder error falls back to JSON', () => {
      const c = makeClient();
      const logger = makeLogger();
      const { queue, drain } = makeQueue({ clients: [c], logger });
      // playback_position with NaN -> encoder throws
      queue.broadcast('playback_position', { position: NaN, percentage: NaN });
      drain();
      expect(c.sent).toHaveLength(1);
      expect(typeof c.sent[0].frame).toBe('string');
      expect(queue.getStats().jsonFallback).toBe(1);
    });
  });

  describe('client state', () => {
    test('skips non-OPEN clients', () => {
      const closing = makeClient({ readyState: 2 });
      const closed = makeClient({ readyState: 3 });
      const open = makeClient({ readyState: 1 });
      const { queue, clients, drain } = makeQueue({ clients: [closing, closed, open] });
      queue.broadcast('device_connected', { id: 'x' });
      drain();
      expect(open.sent).toHaveLength(1);
      // Stale (state > OPEN) get pruned from the set
      expect(clients.has(closing)).toBe(false);
      expect(clients.has(closed)).toBe(false);
    });

    test('handles send() throwing', () => {
      const ok = makeClient();
      const bad = makeClient({ failSend: true });
      const logger = makeLogger();
      const { queue, drain } = makeQueue({ clients: [ok, bad], logger });
      queue.broadcast('device_connected', { id: 'x' });
      drain();
      expect(ok.sent).toHaveLength(1);
      // failure logged, queue keeps running
      expect(logger.warnCalls.length).toBeGreaterThan(0);
    });
  });

  describe('lifecycle', () => {
    test('close() drains pending and refuses further enqueues', () => {
      const c = makeClient();
      const { queue, drain } = makeQueue({ clients: [c] });
      queue.enqueue('device_connected', { id: 'a' });
      queue.close();
      // The flush callback may still fire, but it must be a no-op.
      drain();
      expect(c.sent).toHaveLength(0);
      queue.enqueue('device_connected', { id: 'b' });
      drain();
      expect(c.sent).toHaveLength(0);
    });

    test('schedules exactly one flush per burst', () => {
      const c = makeClient();
      const { queue, scheduled, drain } = makeQueue({ clients: [c] });
      queue.enqueue('a', {});
      queue.enqueue('b', {});
      queue.enqueueLatest('playback_position', { position: 0, percentage: 0 });
      // One callback scheduled, regardless of enqueue count.
      expect(scheduled.length).toBe(1);
      drain();
      expect(c.sent).toHaveLength(3);
    });
  });
});
