/**
 * ServiceContainer v1.0.0
 * Lightweight Dependency Injection container for Ma-est-tro backend.
 * Replaces the Application-as-service-locator anti-pattern.
 *
 * Each service receives only the dependencies it actually needs,
 * instead of the entire Application object.
 *
 * Usage:
 *   const container = new ServiceContainer();
 *   container.register('logger', logger);
 *   container.register('database', () => new Database(container.resolve('logger')));
 *   const db = container.resolve('database');
 */
class ServiceContainer {
    constructor() {
        this._instances = new Map();
        this._factories = new Map();
        this._resolving = new Set(); // Circular dependency detection
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
        // Check instances first
        if (this._instances.has(name)) {
            return this._instances.get(name);
        }

        // Check factories
        if (this._factories.has(name)) {
            // Circular dependency detection
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
     * Remove a service
     * @param {string} name
     */
    unregister(name) {
        this._instances.delete(name);
        this._factories.delete(name);
    }
}

export default ServiceContainer;
