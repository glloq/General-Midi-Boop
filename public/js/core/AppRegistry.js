/**
 * AppRegistry v1.0.0
 * Centralized service registry replacing scattered window.* globals.
 * Provides a structured way to register and resolve application services.
 *
 * Usage:
 *   AppRegistry.register('eventBus', new EventBus());
 *   const bus = AppRegistry.get('eventBus');
 *
 * Backward compatibility:
 *   All registered services are also exposed on window.* for legacy code.
 */
class AppRegistry {
    constructor() {
        if (AppRegistry._instance) {
            return AppRegistry._instance;
        }

        this._services = new Map();
        this._factories = new Map();
        this._initialized = false;

        AppRegistry._instance = this;
    }

    /**
     * Register a service instance
     * @param {string} name - Service name
     * @param {*} instance - Service instance
     * @param {Object} options
     * @param {boolean} options.exposeGlobal - Also set on window (default: true for backward compat)
     */
    register(name, instance, { exposeGlobal = true } = {}) {
        if (this._services.has(name)) {
            console.warn(`[AppRegistry] Overwriting existing service: ${name}`);
        }

        this._services.set(name, instance);

        if (exposeGlobal && typeof window !== 'undefined') {
            window[name] = instance;
        }

        return this;
    }

    /**
     * Register a lazy factory for deferred instantiation
     * @param {string} name - Service name
     * @param {Function} factory - Factory function that creates the instance
     */
    registerFactory(name, factory) {
        this._factories.set(name, factory);
        return this;
    }

    /**
     * Get a registered service
     * @param {string} name - Service name
     * @returns {*} The service instance, or undefined
     */
    get(name) {
        if (this._services.has(name)) {
            return this._services.get(name);
        }

        // Try lazy factory
        if (this._factories.has(name)) {
            const factory = this._factories.get(name);
            const instance = factory();
            this._services.set(name, instance);
            this._factories.delete(name);
            return instance;
        }

        // Backward compat: check window
        if (typeof window !== 'undefined' && window[name] !== undefined) {
            return window[name];
        }

        return undefined;
    }

    /**
     * Check if a service is registered
     */
    has(name) {
        return this._services.has(name) || this._factories.has(name);
    }

    /**
     * Unregister a service
     */
    unregister(name) {
        this._services.delete(name);
        this._factories.delete(name);
        return this;
    }

    /**
     * Get all registered service names
     */
    getRegisteredNames() {
        return [
            ...this._services.keys(),
            ...this._factories.keys()
        ];
    }

    /**
     * Reset the registry (for testing)
     */
    reset() {
        this._services.clear();
        this._factories.clear();
    }

    /**
     * Get the singleton instance
     */
    static getInstance() {
        if (!AppRegistry._instance) {
            new AppRegistry();
        }
        return AppRegistry._instance;
    }
}

AppRegistry._instance = null;

// Create and expose global instance
if (typeof window !== 'undefined') {
    window.AppRegistry = AppRegistry;
    window.appRegistry = AppRegistry.getInstance();
}
