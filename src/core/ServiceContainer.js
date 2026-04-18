/**
 * @file src/core/ServiceContainer.js
 * @description ServiceContainer v1.0.0 — lightweight dependency-injection
 * container for the MidiMind backend. Replaces the legacy
 * "Application-as-service-locator" anti-pattern by giving each service only
 * the dependencies it actually needs instead of the entire Application
 * instance.
 *
 * Two registration styles are supported:
 *   - {@link ServiceContainer#register} stores a ready instance.
 *   - {@link ServiceContainer#factory} stores a lazy factory; the instance
 *     is built on the first {@link ServiceContainer#resolve} and then
 *     promoted to the instance map (singleton semantics).
 *
 * Circular dependencies are detected at resolve-time and surfaced as a
 * descriptive Error rather than a stack overflow.
 *
 * @example
 *   const container = new ServiceContainer();
 *   container.register('logger', logger);
 *   container.factory('database', (c) => new Database(c.resolve('logger')));
 *   const db = container.resolve('database');
 *
 * TODO: add scoped (per-request) factories once a use case appears — every
 * service today is a process-wide singleton.
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
     * Get all registered service names
     * @returns {string[]}
     */
    getNames() {
        return [
            ...this._instances.keys(),
            ...this._factories.keys()
        ];
    }

    /**
     * Create a dependency bag for a service constructor.
     * Instead of passing `app`, pass only what the service needs.
     * @param {string[]} names - List of service names needed
     * @returns {Object} Object with named dependencies
     */
    inject(...names) {
        const deps = {};
        for (const name of names) {
            deps[name] = this.resolve(name);
            if (deps[name] === undefined) {
                throw new Error(`Cannot inject '${name}': service not registered`);
            }
        }
        return deps;
    }

    /**
     * Remove a service from the container (both factory and instance maps).
     * Used by tests and shutdown paths to drop singletons that hold OS
     * handles. Does NOT call any teardown method on the instance — callers
     * are responsible for stopping the service before unregistering it.
     *
     * @param {string} name
     * @returns {void}
     */
    unregister(name) {
        this._instances.delete(name);
        this._factories.delete(name);
    }
}

export default ServiceContainer;
