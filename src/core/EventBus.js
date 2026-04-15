// src/core/EventBus.js

const MAX_LISTENERS_PER_EVENT = 50;

class EventBus {
  constructor(logger = null) {
    this.listeners = new Map();
    this.maxListenersPerEvent = MAX_LISTENERS_PER_EVENT;
    this._logger = logger;
  }

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

  once(event, callback) {
    const onceWrapper = (...args) => {
      callback(...args);
      this.off(event, onceWrapper);
    };
    this.on(event, onceWrapper);
  }

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

  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount(event) {
    if (!this.listeners.has(event)) {
      return 0;
    }
    return this.listeners.get(event).length;
  }

  eventNames() {
    return Array.from(this.listeners.keys());
  }
}

export default EventBus;