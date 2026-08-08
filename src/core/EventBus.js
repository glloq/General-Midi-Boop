/**
 * @file src/core/EventBus.js
 * @description Minimal in-process pub/sub bus used by every backend service.
 * No wildcards/namespaces to keep dispatch cheap on the hot MIDI path.
 * Canonical events: midi_message, midi_routed, device_connected,
 * device_disconnected, file_uploaded, playback_started, playback_stopped,
 * error.
 */

/** Per-event-name listener count above which a leak warning is emitted. */
const MAX_LISTENERS_PER_EVENT = 50;

/**
 * Lightweight EventEmitter-like bus. Differs from Node's EventEmitter: no
 * `error` special-casing (handler exceptions are caught/logged), emit
 * iterates backwards so `once()` can self-detach safely, optional logger.
 */
class EventBus {
  /**
   * @param {?{warn:Function,error:Function}} [logger] - Optional; falls back
   *   to `console` for warnings/handler errors.
   */
  constructor(logger = null) {
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    this.maxListenersPerEvent = MAX_LISTENERS_PER_EVENT;
    this._logger = logger;
  }

  /**
   * Subscribe `callback` to `event` (duplicates allowed). Warns (does not
   * throw) past {@link EventBus#maxListenersPerEvent} — likely a missing
   * `off()`.
   * @param {string} event
   * @param {Function} callback
   * @returns {void}
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    const list = this.listeners.get(event);
    list.push(callback);
    if (list.length > this.maxListenersPerEvent) {
      const msg = `EventBus: possible memory leak — ${list.length} listeners for "${event}" (max ${this.maxListenersPerEvent})`;
      if (this._logger) {
        this._logger.warn(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn(msg);
      }
    }
  }

  /**
   * Unsubscribe `callback` (no-op if absent). Removes the event entry when
   * its last listener is detached so {@link EventBus#eventNames} stays clean.
   * @param {string} event
   * @param {Function} callback - Exact reference passed to `on`.
   * @returns {void}
   */
  off(event, callback) {
    if (!this.listeners.has(event)) {
      return;
    }

    const callbacks = this.listeners.get(event);
    const index = callbacks.indexOf(callback);

    if (index > -1) {
      callbacks.splice(index, 1);
    }

    if (callbacks.length === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Subscribe a one-shot listener that auto-detaches after its first call.
   * @param {string} event
   * @param {Function} callback
   * @returns {void}
   */
  once(event, callback) {
    const onceWrapper = (...args) => {
      // Detach in `finally` so a throwing callback still auto-removes the
      // listener — otherwise it stays registered and fires again (no longer
      // "once"); emit()'s try/catch would just keep swallowing the throw
      // (audit B3 m1).
      try {
        callback(...args);
      } finally {
        this.off(event, onceWrapper);
      }
    };
    this.on(event, onceWrapper);
  }

  /**
   * Synchronously dispatch `data` to every listener for `event`. Handler
   * exceptions are caught/logged so one bad subscriber can't break siblings.
   * @param {string} event
   * @param {*} [data] - Forwarded as the single handler argument.
   * @returns {void}
   */
  emit(event, data) {
    if (!this.listeners.has(event)) {
      return;
    }

    // Backwards index loop: no array copy, and once() can splice safely.
    const callbacks = this.listeners.get(event);
    for (let i = callbacks.length - 1; i >= 0; i--) {
      try {
        callbacks[i](data);
      } catch (error) {
        if (this._logger) {
          this._logger.error(`EventBus error in ${event} handler:`, error);
        } else {
          // eslint-disable-next-line no-console
          console.error(`EventBus error in ${event} handler:`, error);
        }
      }
    }
  }

  /**
   * Remove all listeners for `event`, or for every event when called with
   * no argument (used by `Application.stop()` and tests).
   * @param {string} [event] - Omit to clear everything.
   * @returns {void}
   */
  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * @param {string} event - Event name.
   * @returns {number} Number of currently registered listeners for `event`.
   */
  listenerCount(event) {
    if (!this.listeners.has(event)) {
      return 0;
    }
    return this.listeners.get(event).length;
  }

  /**
   * @returns {string[]} Snapshot of every event name with at least one
   *   active listener.
   */
  eventNames() {
    return Array.from(this.listeners.keys());
  }
}

export default EventBus;
