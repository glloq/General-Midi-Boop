/**
 * @file src/core/ServiceContainer.js
 * @description Lightweight DI container. `register` stores a ready instance;
 * `factory` stores a lazy singleton factory built on first `resolve` and
 * then promoted to the instance map. Circular dependencies are detected at
 * resolve-time and surfaced as a descriptive Error.
 */
class ServiceContainer {
  constructor() {
    /** @type {Map<string, *>} Resolved/registered service instances. */
    this._instances = new Map();
    /** @type {Map<string, Function>} Pending factories awaiting resolve. */
    this._factories = new Map();
    /**
     * Names currently being resolved — used to detect cycles like
     * A -> B -> A. Cleared in `finally` after each resolve.
     * @type {Set<string>}
     */
    this._resolving = new Set();
  }

  /**
   * Register a service instance directly
   * @param {string} name - Service name
   * @param {*} instance - Service instance
   * @returns {ServiceContainer} this (for chaining)
   */
  register(name, instance) {
    this._instances.set(name, instance);
    return this;
  }

  /**
   * Register a factory for lazy instantiation
   * @param {string} name - Service name
   * @param {Function} factory - Factory function receiving the container
   * @returns {ServiceContainer} this (for chaining)
   */
  factory(name, factory) {
    this._factories.set(name, factory);
    return this;
  }

  /**
   * Resolve a service by name
   * @param {string} name - Service name
   * @returns {*} The resolved service
   * @throws {Error} If service not found or circular dependency detected
   */
  resolve(name) {
    // Already-built instance — fast path.
    if (this._instances.has(name)) {
      return this._instances.get(name);
    }

    // Lazy factory — build, memoize, then drop the factory entry.
    if (this._factories.has(name)) {
      if (this._resolving.has(name)) {
        throw new Error(`Circular dependency detected while resolving: ${name}`);
      }

      this._resolving.add(name);
      try {
        const factory = this._factories.get(name);
        const instance = factory(this);
        this._instances.set(name, instance);
        this._factories.delete(name);
        return instance;
      } finally {
        this._resolving.delete(name);
      }
    }

    // Intentional: callers like Application use `?.` and `has()` checks,
    // so silently returning undefined keeps optional services optional.
    return undefined;
  }

  /**
   * Check if a service is registered
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._instances.has(name) || this._factories.has(name);
  }

  /**
   * Remove a service (factory + instance maps). Does NOT call any teardown
   * on the instance — callers must stop the service first.
   * @param {string} name
   * @returns {void}
   */
  unregister(name) {
    this._instances.delete(name);
    this._factories.delete(name);
  }
}

export default ServiceContainer;
