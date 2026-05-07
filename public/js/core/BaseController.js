/* ======================================================================================
   BASE CONTROLLER - MVC CONTROLLER PATTERN
   ======================================================================================
   File: frontend/js/core/BaseController.js
   Version: v3.5.0 - BACKEND NULL SAFETY
   Date: 2025-11-04
   ======================================================================================
   FIXES v3.5.0:
   ✦ CRITICAL: Added ensureBackendAvailable() method for backend check
   ✦ CRITICAL: Added isBackendReady() method to check connection state
   ✦ Full protection against backend null/undefined
   ✦ Offline-mode handling with appropriate messages

   FIXES v3.4.0:
   ✦ CRITICAL: Added backend parameter to the constructor
   ✦ CRITICAL: this.backend initialized with window.backendService fallback
   ✦ Protection against null backend
   ✦ Consistent signature for all controllers
   ====================================================================================== */

class BaseController {
    constructor(eventBus, models = {}, views = {}, notifications = null, debugConsole = null, backend = null) {
        // ✦ CRITICAL: EventBus with robust fallback
        this.eventBus = eventBus || window.eventBus || null;

        // EventBus validation
        if (!this.eventBus) {
            console.error(`[${this.constructor.name}] CRITIQUE: EventBus non disponible!`);
            // Create a minimal fallback to avoid crashes
            this.eventBus = {
                on: () => () => {},
                once: () => () => {},
                emit: () => {},
                off: () => {}
            };
        }
        
        // ✦ CRITICAL: Backend with robust fallback
        this.backend = backend || window.backendService || window.app?.services?.backend || null;

        // Backend validation (warning only, not a critical error)
        if (!this.backend) {
            console.warn(`[${this.constructor.name}] Backend service not available - offline mode`);
        }
        
        // References to main components
        this.models = models;
        this.views = views;
        this.notifications = notifications;
        this.debugConsole = debugConsole;
        
        // Controller state
        this.state = {
            isInitialized: false,
            isActive: false,
            isDestroyed: false,
            lastAction: null,
            errors: []
        };
        
        // Configuration
        this.config = {
            autoInitialize: true,
            handleErrors: true,
            logActions: true,
            validateInputs: true,
            debounceActions: {},
            cacheTTL: 5 * 60 * 1000 // 5 minutes
        };
        
        // Event handling
        this.eventSubscriptions = [];
        this.actionQueue = [];
        
        // Metrics and monitoring
        this.metrics = {
            actionsExecuted: 0,
            errorsHandled: 0,
            notificationsSent: 0,
            startTime: Date.now()
        };
        
        // Cache for optimization
        this.cache = new Map();
        this.cacheTimestamps = new Map();
        this._lastCacheClean = null;
		
        // Input validators
        this.validators = {};
        
        // Debounced actions
        this.debouncedActions = new Map();
        
        // Automatic initialization if configured
        if (this.config.autoInitialize) {
            this.initialize();
        }
    }

    /**
     * ✦ NEW v3.5.0: Check whether the backend is available and connected
     * @returns {boolean} true if backend is available and ready
     */
    isBackendReady() {
        if (!this.backend) {
            return false;
        }
        
        // Check whether the backend has an isConnected method
        if (typeof this.backend.isConnected === 'function') {
            return this.backend.isConnected();
        }
        
        // Check whether the backend has a connected property
        if (this.backend.connected !== undefined) {
            return this.backend.connected;
        }
        
        // If no check method, consider it ready if it exists
        return true;
    }

    /**
     * ✦ NEW v3.5.0: Ensures the backend is available
     * Throws an appropriate error if the backend is unavailable
     * @param {string} operation - Name of the operation that requires the backend
     * @throws {Error} If backend is not available
     */
    ensureBackendAvailable(operation = 'operation') {
        if (!this.backend) {
            const error = new Error(`Backend not available - cannot perform ${operation} (offline mode)`);
            error.code = 'BACKEND_NOT_AVAILABLE';
            error.offline = true;
            throw error;
        }
        
        if (!this.isBackendReady()) {
            const error = new Error(`Backend not connected - cannot perform ${operation}`);
            error.code = 'BACKEND_NOT_CONNECTED';
            error.offline = true;
            throw error;
        }
    }

    /**
     * ✦ NEW v3.5.0: Execute a backend operation with error handling
     * @param {Function} operation - Async function that uses the backend
     * @param {string} operationName - Operation name for logs
     * @param {*} defaultValue - Default value if backend is unavailable
     * @returns {Promise<*>} Operation result or defaultValue
     */
    async withBackend(operation, operationName = 'operation', defaultValue = null) {
        try {
            this.ensureBackendAvailable(operationName);
            return await operation();
        } catch (error) {
            if (error.offline) {
                this.log('warn', this.constructor.name, `${operationName} skipped - offline mode`);
                return defaultValue;
            }
            throw error;
        }
    }

    /**
     * Controller initialization
     */
    initialize() {
        if (this.state.isInitialized) {
            this.log('warn', this.constructor.name, 'Already initialized');
            return;
        }
        
        try {
            this.log('info', this.constructor.name, 'Initializing...');
            
            // Hook for custom initialization
            if (typeof this.onInitialize === 'function') {
                this.onInitialize();
            }
            
            this.state.isInitialized = true;
            this.log('info', this.constructor.name, '✓ Initialized');
            
        } catch (error) {
            this.handleError('Initialization failed', error);
        }
    }

    /**
     * Activates the controller
     */
    activate() {
        if (this.state.isDestroyed) {
            this.log('error', this.constructor.name, 'Cannot activate - destroyed');
            return;
        }
        
        if (this.state.isActive) {
            return;
        }
        
        this.state.isActive = true;
        
        // Hook for custom activation
        if (typeof this.onActivate === 'function') {
            this.onActivate();
        }
        
        this.log('info', this.constructor.name, 'Activated');
    }

    /**
     * Deactivates the controller
     */
    deactivate() {
        if (!this.state.isActive) {
            return;
        }
        
        this.state.isActive = false;
        
        // Hook for custom deactivation
        if (typeof this.onDeactivate === 'function') {
            this.onDeactivate();
        }
        
        this.log('info', this.constructor.name, 'Deactivated');
    }

    /**
     * Unified error handling
     */
    handleError(context, error, showNotification = true) {
        this.metrics.errorsHandled++;
        if (this.state.errors.length >= 100) this.state.errors.shift();
        this.state.errors.push({
            context,
            error,
            timestamp: Date.now()
        });
        
        // Log
        this.log('error', this.constructor.name, context, error);
        
        // Notification if enabled
        if (showNotification && this.notifications) {
            const message = error.message || 'An error occurred';
            this.notifications.show(`${context}: ${message}`, 'error', 5000);
            this.metrics.notificationsSent++;
        }
        
        // Event
        if (this.eventBus) {
            this.eventBus.emit('controller:error', {
                controller: this.constructor.name,
                context,
                error
            });
        }
        
        // Custom hook
        if (typeof this.onError === 'function') {
            this.onError(context, error);
        }
    }

    /**
     * Log helper
     */
    log(level, source, ...args) {
        const prefix = `[${source}]`;
        
        // Try debugConsole if the method exists
        if (this.debugConsole && typeof this.debugConsole[level] === 'function') {
            this.debugConsole[level](prefix, ...args);
        } 
        // Otherwise try window.logger if the method exists
        else if (window.logger && typeof window.logger[level] === 'function') {
            window.logger[level](prefix, ...args);
        } 
        // Fallback to standard console
        else if (typeof console[level] === 'function') {
            console[level](prefix, ...args);
        } else {
            // Last resort: console.log
            console.log(prefix, ...args);
        }
    }

    /**
     * Shortcut logging methods
     */
    logDebug(...args) {
        this.log('debug', this.constructor.name, ...args);
    }

    logInfo(...args) {
        this.log('info', this.constructor.name, ...args);
    }

    logWarn(...args) {
        this.log('warn', this.constructor.name, ...args);
    }

    logError(...args) {
        this.log('error', this.constructor.name, ...args);
    }

    /**
     * Input validation
     */
    validate(data, validatorName) {
        if (!this.config.validateInputs) {
            return { valid: true };
        }
        
        const validator = this.validators[validatorName];
        if (!validator) {
            this.log('warn', this.constructor.name, `No validator found: ${validatorName}`);
            return { valid: true };
        }
        
        return validator(data);
    }

    /**
     * Event emission
     */
    emit(eventName, data = {}) {
        if (!this.eventBus) return;
        
        const enrichedData = {
            ...data,
            source: this.constructor.name,
            timestamp: Date.now()
        };
        
        this.eventBus.emit(eventName, enrichedData);
    }

    /**
     * Event subscription
     */
    on(eventName, handler) {
        if (!this.eventBus) return () => {};
        
        const unsubscribe = this.eventBus.on(eventName, handler);
        this.eventSubscriptions.push({ eventName, unsubscribe });
        
        return unsubscribe;
    }

    /**
     * Cache management
     */
    getCached(key) {
        const timestamp = this.cacheTimestamps.get(key);
        if (!timestamp || Date.now() - timestamp > this.config.cacheTTL) {
            return null;
        }
        return this.cache.get(key);
    }

    setCached(key, value) {
        this.cache.set(key, value);
        this.cacheTimestamps.set(key, Date.now());
        
        // Periodic cleanup
        this.cleanCache();
    }

    cleanCache() {
        const now = Date.now();
        
        // Clean only every 60 seconds at most
        if (this._lastCacheClean && now - this._lastCacheClean < 60000) {
            return;
        }
        
        this._lastCacheClean = now;
        
        for (const [key, timestamp] of this.cacheTimestamps.entries()) {
            if (now - timestamp > this.config.cacheTTL) {
                this.cache.delete(key);
                this.cacheTimestamps.delete(key);
            }
        }
    }

    clearCache() {
        this.cache.clear();
        this.cacheTimestamps.clear();
    }

    /**
     * Notification helper
     */
    notify(message, type = 'info', duration = 3000) {
        if (this.notifications) {
            this.notifications.show(message, type, duration);
            this.metrics.notificationsSent++;
        }
    }

    /**
     * Debounce helper
     */
    debounce(actionName, delay = 300) {
        if (this.debouncedActions.has(actionName)) {
            clearTimeout(this.debouncedActions.get(actionName));
        }
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.debouncedActions.delete(actionName);
                resolve();
            }, delay);
            
            this.debouncedActions.set(actionName, timeout);
        });
    }

    /**
     * Metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            uptime: Date.now() - this.metrics.startTime,
            cacheSize: this.cache.size,
            subscriptions: this.eventSubscriptions.length
        };
    }

    /**
     * Destruction
     */
    destroy() {
        if (this.state.isDestroyed) {
            return;
        }
        
        this.log('info', this.constructor.name, 'Destroying...');
        
        // Unsubscribe all events
        this.eventSubscriptions.forEach(({ unsubscribe }) => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        });
        this.eventSubscriptions = [];
        
        // Clear debounce timers
        this.debouncedActions.forEach((timeout) => clearTimeout(timeout));
        this.debouncedActions.clear();
        
        // Clear the cache
        this.clearCache();
        
        // Custom hook
        if (typeof this.onDestroy === 'function') {
            this.onDestroy();
        }
        
        this.state.isDestroyed = true;
        this.state.isActive = false;
        
        this.log('info', this.constructor.name, '✓ Destroyed');
    }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BaseController;
}

window.BaseController = BaseController;