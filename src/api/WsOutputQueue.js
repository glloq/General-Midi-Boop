/**
 * @file src/api/WsOutputQueue.js
 * @description Asynchronous output pipeline for the WebSocket server.
 *
 * Why this module exists
 * ----------------------
 * The MIDI hot path used to call `wsServer.broadcast(event, data)`
 * synchronously inside the scheduler tick. That path:
 *   - serialised JSON on every call
 *   - iterated over every client and pushed bytes into the libuv socket
 *     write buffer without checking backpressure
 *   - cumulated latency proportional to N_clients × payload_size
 *
 * `WsOutputQueue` decouples the producer (hot path) from the actual I/O.
 * Producers `enqueue()` (discrete events that must all be delivered) or
 * `enqueueLatest()` (high-frequency events where only the most recent
 * value matters). The queue flushes once per event-loop turn via
 * `setImmediate`, so the scheduler tick returns without doing socket I/O.
 *
 * Backpressure: before sending, we check `client.bufferedAmount`. Above
 * the high-water mark we skip this message for that client. Coalescable
 * events naturally recover (next state overwrites the dropped one);
 * discrete events get dropped with a counter increment.
 *
 * Binary frames: high-frequency event names go through
 * {@link BinaryFrameCodec}. All other events fall back to JSON.
 */
import { setImmediate as nodeSetImmediate } from 'node:timers';
import codec from '../../shared/BinaryFrameCodec.js';

/** Default backpressure thresholds (bytes). */
export const DEFAULT_HIGH_WATERMARK = 64 * 1024;       // skip this msg for slow client
export const DEFAULT_CRITICAL_WATERMARK = 1024 * 1024; // log + reset coalescing slot

/**
 * Discrete queue depth limit before we drop the oldest entry.
 * Lowered from 1000 to 200 (audit §5.2): a 1000-deep flush could
 * block the event loop 50-200 ms when serialising under load,
 * which stalls the MIDI scheduler. 200 keeps a reasonable safety
 * margin for normal bursts while bounding the worst-case flush cost.
 */
export const DEFAULT_MAX_QUEUE_DEPTH = 200;

/** Floor used by adaptive shrinking when event-loop lag is high. */
export const MIN_QUEUE_DEPTH_UNDER_LAG = 50;

/**
 * Event names that get coalesced (latest value wins).
 * Everything else goes through the discrete FIFO queue.
 */
export const COALESCABLE_EVENTS = new Set([
  'playback_position',
  'monitor_event',
  'tuner:pitch',
  'calibration:audio_level',
  'system_lag'
]);

/**
 * Asynchronous, coalescing, backpressure-aware broadcast queue.
 *
 * One instance per WebSocket server. Producers are non-blocking; the
 * single flush runs through `setImmediate` so it never preempts the
 * MIDI scheduler tick.
 */
export class WsOutputQueue {
  /**
   * @param {Object} opts
   * @param {Set} opts.clients - Shared reference to WebSocketServer.clients.
   * @param {Object} opts.logger
   * @param {Object} [opts.eventLoopMonitor] - When `currentLag` is high, tighten the drop threshold.
   * @param {number} [opts.highWatermark=DEFAULT_HIGH_WATERMARK]
   * @param {number} [opts.criticalWatermark=DEFAULT_CRITICAL_WATERMARK]
   * @param {number} [opts.maxQueueDepth=DEFAULT_MAX_QUEUE_DEPTH]
   * @param {Set<string>} [opts.coalescableEvents]
   * @param {boolean} [opts.enableBinary=true] - When false, every event is sent as JSON.
   * @param {Function} [opts.scheduleFlush=setImmediate] - Test seam.
   * @param {number} [opts.openReadyState=1] - ws OPEN constant (test seam).
   */
  constructor({
    clients,
    logger,
    eventLoopMonitor = null,
    highWatermark = DEFAULT_HIGH_WATERMARK,
    criticalWatermark = DEFAULT_CRITICAL_WATERMARK,
    maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH,
    coalescableEvents = COALESCABLE_EVENTS,
    enableBinary = true,
    scheduleFlush = nodeSetImmediate,
    openReadyState = 1
  }) {
    if (!clients) throw new Error('WsOutputQueue: clients Set is required');
    if (!logger) throw new Error('WsOutputQueue: logger is required');

    this._clients = clients;
    this._logger = logger;
    this._loopMon = eventLoopMonitor;
    this._highWm = highWatermark;
    this._critWm = criticalWatermark;
    this._maxDepth = maxQueueDepth;
    this._coalescable = coalescableEvents;
    this._binary = enableBinary;
    this._scheduleFlush = scheduleFlush;
    this._openReady = openReadyState;

    // FIFO of discrete events: { eventType, payload }
    this._queue = [];
    // eventType -> latest payload (overwritten on each enqueue)
    this._latest = new Map();
    // setImmediate already scheduled — flushing is idempotent.
    this._flushScheduled = false;
    this._closed = false;

    this._stats = {
      enqueued: 0,
      coalesced: 0,
      sent: 0,
      droppedByClient: 0,   // skipped due to bufferedAmount
      droppedByDepth: 0,    // oldest pruned because queue full
      criticalEvents: 0,    // bufferedAmount > critical threshold
      jsonFallback: 0,      // binary event with encoder error
      flushes: 0
    };
  }

  /**
   * Enqueue a discrete event (every client must see it, unless overflowing).
   * @param {string} eventType
   * @param {*} payload
   */
  enqueue(eventType, payload) {
    if (this._closed) return;
    const effectiveDepth = this._effectiveQueueDepth();
    while (this._queue.length >= effectiveDepth) {
      this._queue.shift();
      this._stats.droppedByDepth++;
    }
    this._queue.push({ eventType, payload });
    this._stats.enqueued++;
    this._maybeScheduleFlush();
  }

  /**
   * When the event loop is lagging, shrink the queue cap so a flush
   * cannot pile up hundreds of serialisations on top of an already
   * struggling loop. The lag threshold mirrors `_effectiveHighWatermark`.
   * @returns {number}
   */
  _effectiveQueueDepth() {
    const lag = this._loopMon?.currentLag ?? 0;
    if (lag > 10) return Math.max(MIN_QUEUE_DEPTH_UNDER_LAG, Math.floor(this._maxDepth / 2));
    return this._maxDepth;
  }

  /**
   * Enqueue a coalescable event: only the latest value will be sent.
   * @param {string} eventType
   * @param {*} payload
   */
  enqueueLatest(eventType, payload) {
    if (this._closed) return;
    if (this._latest.has(eventType)) {
      this._stats.coalesced++;
    } else {
      this._stats.enqueued++;
    }
    this._latest.set(eventType, payload);
    this._maybeScheduleFlush();
  }

  /**
   * Convenience: route to {@link WsOutputQueue#enqueueLatest} or
   * {@link WsOutputQueue#enqueue} based on the coalescable set. This is
   * the entry point used by `WebSocketServer.broadcast`.
   * @param {string} eventType
   * @param {*} payload
   */
  broadcast(eventType, payload) {
    if (this._coalescable.has(eventType)) {
      this.enqueueLatest(eventType, payload);
    } else {
      this.enqueue(eventType, payload);
    }
  }

  /**
   * @returns {Object} Snapshot of counters.
   */
  getStats() {
    return {
      ...this._stats,
      queueDepth: this._queue.length,
      latestSlots: this._latest.size,
      clients: this._clients.size
    };
  }

  /**
   * Drain pending entries and stop accepting new ones. Called from
   * WebSocketServer.close().
   */
  close() {
    this._closed = true;
    this._queue.length = 0;
    this._latest.clear();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  _maybeScheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    this._scheduleFlush(() => this._flushOnce());
  }

  /**
   * Build the wire frame for an event. Returns either a Buffer/ArrayBuffer
   * (binary) or a string (JSON). The caller decides which sends to which
   * client (binary frames go to `ws.send(buffer)` directly).
   * @param {string} eventType
   * @param {*} payload
   * @returns {{ frame: any, isBinary: boolean }}
   */
  _encode(eventType, payload) {
    if (this._binary && codec.isBinaryEvent(eventType)) {
      try {
        const frame = codec.encodeByEvent(eventType, payload);
        if (frame) return { frame, isBinary: true };
      } catch (err) {
        this._stats.jsonFallback++;
        if (this._logger.isWarnEnabled?.() ?? true) {
          this._logger.warn(`WsOutputQueue: binary encode failed for ${eventType}: ${err.message}`);
        }
      }
    }
    // Fallback to JSON wire format (same shape as legacy broadcast).
    const text = JSON.stringify({
      type: 'event',
      event: eventType,
      data: payload,
      timestamp: Date.now()
    });
    return { frame: text, isBinary: false };
  }

  /**
   * Tighten threshold when event loop is lagging. The intuition: under
   * lag we'd rather drop a few payloads than let the socket buffers grow
   * and compound the problem.
   * @returns {number} Effective high watermark in bytes.
   */
  _effectiveHighWatermark() {
    const lag = this._loopMon?.currentLag ?? 0;
    if (lag > 10) return Math.max(8192, Math.floor(this._highWm / 2));
    return this._highWm;
  }

  /**
   * Send one encoded frame to every eligible client. Implements the
   * backpressure drop policy.
   *
   * @param {string} eventType
   * @param {*} payload
   * @returns {number} Number of clients sent to.
   */
  _send(eventType, payload) {
    const { frame, isBinary } = this._encode(eventType, payload);
    const threshold = this._effectiveHighWatermark();
    let sent = 0;
    const stale = [];
    this._clients.forEach((client) => {
      if (client.readyState !== this._openReady) {
        if (client.readyState > this._openReady) stale.push(client);
        return;
      }
      const buffered = client.bufferedAmount || 0;
      if (buffered > this._critWm) {
        this._stats.criticalEvents++;
        if (this._logger.isWarnEnabled?.() ?? true) {
          this._logger.warn(
            `WsOutputQueue: client bufferedAmount=${buffered}B exceeds critical threshold, dropping ${eventType}`
          );
        }
        this._stats.droppedByClient++;
        return;
      }
      if (buffered > threshold) {
        this._stats.droppedByClient++;
        return;
      }
      try {
        client.send(frame, isBinary ? { binary: true } : undefined);
        sent++;
      } catch (err) {
        // A synchronous throw from ws.send() means the socket is in a
        // bad state (CLOSED race or internal corruption). Drop it from
        // the live set so subsequent flushes don't keep paying for it.
        stale.push(client);
        if (this._logger.isWarnEnabled?.() ?? true) {
          this._logger.warn(`WsOutputQueue: client.send failed, dropping client: ${err.message}`);
        }
      }
    });
    if (stale.length) {
      for (const c of stale) this._clients.delete(c);
    }
    this._stats.sent += sent;
    return sent;
  }

  /**
   * One flush pass: send every latest-slot, then every queued discrete
   * event. Order: coalescables first so position updates aren't starved
   * by a burst of discrete events.
   */
  _flushOnce() {
    this._flushScheduled = false;
    if (this._closed) return;
    this._stats.flushes++;

    if (this._latest.size > 0) {
      // Iteration order on Map is insertion order; that's fine for our
      // use (latest playback_position before latest monitor_event, etc.).
      // We move into a local then clear so a re-entrant enqueueLatest()
      // call (theoretically possible if a client error handler emits an
      // event synchronously) doesn't lose data.
      const snapshot = this._latest;
      this._latest = new Map();
      for (const [eventType, payload] of snapshot) {
        this._send(eventType, payload);
      }
    }

    if (this._queue.length > 0) {
      const drained = this._queue;
      this._queue = [];
      for (const { eventType, payload } of drained) {
        this._send(eventType, payload);
      }
    }
  }
}

export default WsOutputQueue;
