/**
 * @file src/infrastructure/monitoring/EventLoopMonitor.js
 * @description Measures Node.js event loop lag at runtime.
 *
 * Runs a 10ms `setInterval` and compares expected vs actual elapsed time.
 * Any excess (lag) above `threshold` ms is logged as a warning and broadcast
 * as a `system_lag` WebSocket event so the debug console can surface it.
 *
 * Usage: start() after the WS server is up, stop() during shutdown.
 * The monitor is intentionally lightweight — one setInterval, no deps beyond
 * logger and wsServer.
 */
import { performance } from 'perf_hooks';

const TICK_MS = 10;

export class EventLoopMonitor {
  /**
   * @param {Object} opts
   * @param {Object} opts.logger
   * @param {Object} [opts.wsServer]      - WebSocket server (optional; broadcast skipped when absent).
   * @param {number} [opts.threshold=50]  - Lag threshold in ms above which a warning is emitted.
   */
  constructor({ logger, wsServer, threshold = 50 }) {
    this._log = logger;
    this._ws = wsServer;
    this._threshold = threshold;
    this._interval = null;
    /** Last observed lag (ms). Readable by callers (e.g. PlaybackScheduler). */
    this.currentLag = 0;
  }

  /**
   * Start the event-loop lag probe. No-op if already running.
   * @returns {void}
   */
  start() {
    if (this._interval) return;
    let last = performance.now();
    this._interval = setInterval(() => {
      const now = performance.now();
      const lag = now - last - TICK_MS;
      this.currentLag = lag > 0 ? lag : 0;
      if (lag > this._threshold) {
        this._log.warn(`Event loop lag: ${lag.toFixed(1)}ms (threshold: ${this._threshold}ms)`);
        this._ws?.broadcast('system_lag', {
          lagMs: Math.round(lag),
          thresholdMs: this._threshold
        });
      }
      last = now;
    }, TICK_MS);
    this._interval.unref();
  }

  /**
   * Stop the probe and reset the lag counter.
   * @returns {void}
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.currentLag = 0;
  }
}
