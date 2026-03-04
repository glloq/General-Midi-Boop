// src/core/EventBus.js

class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
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

    // Copy the array to avoid mutation issues when once() handlers remove themselves during iteration
    const callbacks = [...this.listeners.get(event)];
    callbacks.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`EventBus error in ${event} handler:`, error);
      }
    });
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