/**
 * @file src/core/EventBus.js
 * @description In-process publish/subscribe bus used by every service in the
 * application (router, player, managers, API layer). Intentionally minimal —
 * no wildcards, no namespaces — to keep dispatch overhead negligible on the
 * hot MIDI path.
 *
 * Canonical events emitted across the codebase:
 *   - `midi_message`           ({ device, type, ... })
 *   - `midi_routed`            ({ route, ... })
 *   - `device_connected`       ({ deviceId, ... })
 *   - `device_disconnected`    ({ deviceId, ... })
 *   - `file_uploaded`          ({ filename, ... })
 *   - `playback_started`       ()
 *   - `playback_stopped`       ()
 *   - `error`                  (Error)
 */

/**
 * Threshold above which {@link EventBus#on} warns about a probable listener
 * leak. The limit is per-event-name; tune via the public field
 * `maxListenersPerEvent` if a legitimate use case needs more handlers.
 * @type {number}
 */
const MAX_LISTENERS_PER_EVENT = 50;

/**
 * Lightweight EventEmitter-like bus.
 *
 * Differences vs Node's `EventEmitter`:
 * - No `error` special-casing — handler exceptions are caught and logged.
 * - Iteration is backwards so `once()` handlers can self-detach without
 *   skipping siblings during emit.
 * - Optional logger injection for leak warnings and error reporting.
 */
class EventBus {
  /**
   * @param {?{warn:Function,error:Function}} [logger] - Optional logger; when
   *   omitted, warnings and handler errors fall back to `console`.
   */
  constructor(logger = null) {
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    this.maxListenersPerEvent = MAX_LISTENERS_PER_EVENT;
    this._logger = logger;
  }

  /**
   * Subscribe `callback` to `event`. Multiple registrations of the same
   * function are allowed — each registration receives its own emit call.
   *
   * Emits a warning (but does not throw) when more than
   * {@link EventBus#maxListenersPerEvent} listeners exist for `event`,
   * which usually indicates a forgotten `off()` somewhere.
   *
   * @param {string} event - Event name.
   * @param {Function} callback - Handler invoked with the emit payload.
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
   * Unsubscribe a previously registered `callback`. No-op if the handler is
   * not registered. The event entry is removed from the underlying Map when
   * the last listener is detached so {@link EventBus#eventNames} stays clean.
   *
   * @param {string} event - Event name.
   * @param {Function} callback - The exact function reference passed to `on`.
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
   *
   * @param {string} event - Event name.
   * @param {Function} callback - Handler invoked at most once.
   * @returns {void}
   */
  once(event, callback) {
    const onceWrapper = (...args) => {
      callback(...args);
      this.off(event, onceWrapper);
    };
    this.on(event, onceWrapper);
  }

  /**
   * Synchronously dispatch `data` to every listener registered for `event`.
   * Handler exceptions are caught and reported through the injected logger
   * (or `console.error`) to guarantee that one bad subscriber never breaks
   * sibling subscribers — important on the MIDI hot path.
   *
   * @param {string} event - Event name.
   * @param {*} [data] - Arbitrary payload forwarded as the single argument.
   * @returns {void}
   */
  emit(event, data) {
    if (!this.listeners.has(event)) {
      return;
    }

    // Iterate using index-based loop to avoid array copy overhead.
    // Loop backwards so once() handlers can safely splice without skipping.
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
   * Remove all listeners for `event`, or every listener for every event when
   * called with no argument. Useful in `Application.stop()` and tests to
   * guarantee no stale handlers survive a restart.
   *
   * @param {string} [event] - Specific event name; omit to clear everything.
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