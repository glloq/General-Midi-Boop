// ============================================================================
// EventBus — observer pub/sub with priority queues, throttle/debounce, "once".
// Event-driven processing: queued events drain on a microtask (no polling
// timer). Exposes a global singleton on window.eventBus.
// ============================================================================

const EventPriority = {
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low'
};

const PRIORITY_ORDER = [EventPriority.HIGH, EventPriority.NORMAL, EventPriority.LOW];

class EventBus {
  constructor() {
    this.listeners = new Map();

    this.queues = {
      [EventPriority.HIGH]: [],
      [EventPriority.NORMAL]: [],
      [EventPriority.LOW]: []
    };

    this.config = {
      enablePriorities: true,
      enableMetrics: false, // Disabled in production for performance
      enableThrottling: true,
      maxQueueSize: 1000,
      processingInterval: 10
    };

    this.metrics = {
      eventsEmitted: 0,
      eventsProcessed: 0,
      eventsDropped: 0,
      averageLatency: { high: 0, normal: 0, low: 0 }
    };

    // Incremental event ID counter (cheaper than Date.now() + Math.random())
    this._nextEventId = 0;

    this.throttleCache = new Map();
    this.debounceTimers = new Map();
    this.processingTimer = null;

    this.eventDocumentation = this.initEventDocumentation();

    this.init();
  }

  init() {
    this._processingScheduled = false;
    console.log('✓ EventBus initialized');
  }

  // ========================================================================
  // MAIN METHODS
  // ========================================================================

  on(event, callback, options = {}) {
    if (!event || typeof callback !== 'function') {
      console.error('EventBus.on: Invalid event or callback');
      return () => {};
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }

    const listener = {
      callback,
      priority: options.priority || EventPriority.NORMAL,
      once: options.once || false,
      throttle: options.throttle || 0,
      debounce: options.debounce || 0,
      context: options.context || null,
      filter: options.filter || null,
      id: `${event}_${Date.now()}_${Math.random()}`
    };

    const list = this.listeners.get(event);
    list.push(listener);

    if (list.length > 50) {
      console.warn(
        `EventBus: possible memory leak — ${list.length} listeners for "${event}" (max 50)`
      );
    }

    return () => this.off(event, callback);
  }

  once(event, callback, options = {}) {
    return this.on(event, callback, { ...options, once: true });
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;

    if (!callback) {
      // Bulk-removing every listener for this event must also cancel their
      // pending debounce timers; otherwise a debounced callback still fires
      // after the caller detached all of them (e.g. a view torn down within
      // the debounce window), touching state it already released (audit C M3).
      for (const l of this.listeners.get(event)) {
        const key = `${event}_${l.id}`;
        if (this.debounceTimers.has(key)) {
          clearTimeout(this.debounceTimers.get(key));
          this.debounceTimers.delete(key);
        }
      }
      this.listeners.delete(event);
      return;
    }

    const listeners = this.listeners.get(event);
    const index = listeners.findIndex((l) => l.callback === callback);

    if (index !== -1) {
      const removed = listeners[index];
      listeners.splice(index, 1);
      // Cancel any pending debounce timer for the removed listener; otherwise a
      // queued debounced callback still fires after the caller unsubscribed
      // (e.g. a view torn down within the debounce window), touching state it
      // already released.
      const key = `${event}_${removed.id}`;
      if (this.debounceTimers.has(key)) {
        clearTimeout(this.debounceTimers.get(key));
        this.debounceTimers.delete(key);
      }
    }

    if (listeners.length === 0) {
      this.listeners.delete(event);
    }
  }

  emit(event, data = {}, priority = EventPriority.NORMAL) {
    if (!event) {
      console.error('EventBus.emit: Event name required');
      return;
    }

    this.metrics.eventsEmitted++;

    const eventData = {
      event,
      data,
      priority,
      timestamp: Date.now(),
      id: ++this._nextEventId
    };

    if (this.config.enablePriorities && priority === EventPriority.HIGH) {
      // Process HIGH priority events immediately
      this.processEvent(eventData);
      return;
    }

    const queue = this.queues[priority] || this.queues[EventPriority.NORMAL];

    if (queue.length >= this.config.maxQueueSize) {
      this.metrics.eventsDropped++;
      console.warn(`EventBus: Queue full for priority ${priority}, event dropped`);
      return;
    }

    queue.push(eventData);
    this._scheduleProcessing();
  }

  /**
   * Schedule queue processing via microtask (event-driven; replaces a
   * polling timer that consumed CPU continuously).
   */
  _scheduleProcessing() {
    if (this._processingScheduled) return;
    this._processingScheduled = true;

    Promise.resolve().then(() => {
      this._processingScheduled = false;
      this._drainQueues();
    });
  }

  /** Drain queues in priority order (all batched in the same microtask). */
  _drainQueues() {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues[priority];
      while (queue.length > 0) {
        this.processEvent(queue.shift());
      }
    }
  }

  // ========================================================================
  // PROCESSING
  // ========================================================================

  processEvent(eventData) {
    const { event, data, timestamp, priority } = eventData;

    if (!this.listeners.has(event)) return;

    // Iterate a SNAPSHOT: a callback may add/remove listeners for this same
    // event during dispatch (re-entrant on()/off(), or a synchronous HIGH-
    // priority re-emit). Iterating the live array and removing `once` listeners
    // by post-hoc index skipped listeners and spliced the WRONG ones once the
    // array shifted (audit C M2).
    const listeners = [...this.listeners.get(event)];
    const onceFired = [];

    for (const listener of listeners) {
      try {
        if (listener.filter && !listener.filter(data)) {
          continue;
        }

        if (listener.throttle > 0) {
          const key = `${event}_${listener.id}`;
          const lastExec = this.throttleCache.get(key) || 0;
          const now = Date.now();

          if (now - lastExec < listener.throttle) {
            continue;
          }

          this.throttleCache.set(key, now);
          if (this.throttleCache.size > 100) {
            this.cleanCaches();
          }
        }

        if (listener.debounce > 0) {
          const key = `${event}_${listener.id}`;

          if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key));
          }

          const timer = setTimeout(() => {
            this.executeCallback(listener, data);
            this.debounceTimers.delete(key);
            // A `once` listener that also debounces must still be removed after
            // it fires; the `continue` below skips the normal once-removal path,
            // so handle it here or it would fire (debounced) on every emit.
            if (listener.once) {
              this.off(event, listener.callback);
            }
          }, listener.debounce);

          this.debounceTimers.set(key, timer);
          continue;
        }

        this.executeCallback(listener, data);

        if (listener.once) {
          onceFired.push(listener);
        }
      } catch (error) {
        console.error(`EventBus: Error in listener for ${event}:`, error);
      }
    }

    // Remove fired `once` listeners from the LIVE array by identity (not by the
    // snapshot index, which no longer maps after any re-entrant mutation).
    if (onceFired.length) {
      const live = this.listeners.get(event);
      if (live) {
        for (const l of onceFired) {
          const idx = live.indexOf(l);
          if (idx !== -1) live.splice(idx, 1);
        }
        if (live.length === 0) this.listeners.delete(event);
      }
    }

    this.metrics.eventsProcessed++;

    if (this.config.enableMetrics && priority) {
      this.updateLatencyMetrics(priority, Date.now() - timestamp);
    }
  }

  executeCallback(listener, data) {
    if (listener.context) {
      listener.callback.call(listener.context, data);
    } else {
      listener.callback(data);
    }
  }

  startProcessing() {
    // Event-driven mode: no timer needed. Kept for backwards compatibility.
  }

  stopProcessing() {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================

  updateLatencyMetrics(priority, latency) {
    // Exponential moving average with alpha=0.05 (no array traversal)
    const prev = this.metrics.averageLatency[priority] || 0;
    this.metrics.averageLatency[priority] = Math.round((prev * 0.95 + latency * 0.05) * 100) / 100;
  }

  cleanCaches() {
    const now = Date.now();
    // Keep only the last 5 seconds of throttle timestamps
    for (const [key, timestamp] of this.throttleCache.entries()) {
      if (now - timestamp > 5000) {
        this.throttleCache.delete(key);
      }
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  getListenerCount(event = null) {
    if (event) {
      return this.listeners.has(event) ? this.listeners.get(event).length : 0;
    }

    let total = 0;
    for (const listeners of this.listeners.values()) {
      total += listeners.length;
    }
    return total;
  }

  clear() {
    this.listeners.clear();
    for (const priority of PRIORITY_ORDER) {
      this.queues[priority] = [];
    }
    this.throttleCache.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  destroy() {
    this.stopProcessing();
    this.clear();
  }

  initEventDocumentation() {
    return {
      // Device events
      'device:connected': 'Device connected',
      'device:disconnected': 'Device disconnected',
      'device:list': 'Device list updated',
      'device:error': 'Device error occurred',

      // MIDI events
      'midi:note-on': 'MIDI note on received',
      'midi:note-off': 'MIDI note off received',
      'midi:cc': 'MIDI control change received',
      'midi:message': 'Generic MIDI message received',

      // Playback events
      'playback:play': 'Playback started',
      'playback:pause': 'Playback paused',
      'playback:stop': 'Playback stopped',
      'playback:time': 'Playback time updated',

      // System events
      'app:ready': 'Application ready',
      'app:error': 'Application error',
      'backend:connected': 'Backend connected',
      'backend:disconnected': 'Backend disconnected'
    };
  }
}

// ============================================================================
// EXPORT & GLOBAL INITIALIZATION
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EventBus, EventPriority };
}

if (typeof window !== 'undefined') {
  window.EventBus = EventBus;
  window.EventPriority = EventPriority;

  if (!window.eventBus) {
    window.eventBus = new EventBus();
    console.log('✓ Global EventBus instance created');
  }
}
