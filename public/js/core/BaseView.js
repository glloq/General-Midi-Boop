// ============================================================================
// File: frontend/js/core/BaseView.js
// Actual path: frontend/js/core/BaseView.js
// Version: v4.0.0 - FULL REBUILD
// Date: 2025-11-05
// ============================================================================
// REBUILD v4.0.0:
// ✅ CRITICAL: Complete re-creation of BaseView (corrupted file)
// ✅ Standard signature: constructor(containerId, eventBus)
// ✅ Robust container resolution
// ✅ Minimal EventBus fallback
// ✅ Essential methods: render(), show(), hide(), update(), emit()
// ✅ Event handling with cleanup
// ✅ Built-in validation and logging
// ============================================================================

class BaseView {
    /**
     * Base view constructor
     * @param {string|HTMLElement} containerId - Container ID or DOM element
     * @param {EventBus} eventBus - EventBus instance for communication
     */
    constructor(containerId, eventBus) {
        // ✅ EventBus with robust fallback
        this.eventBus = eventBus || window.eventBus;

        // ✅ CRITICAL: If EventBus is still missing, create minimal fallback
        if (!this.eventBus) {
            console.warn(
                `[${this.constructor.name}] EventBus not found - creating minimal fallback. ` +
                `Check that EventBus is initialized in main.js before Application.`
            );
            
            // Create a minimal functional EventBus
            this.eventBus = {
                on: () => () => {},      // Returns an empty unsubscribe function
                once: () => () => {},    // Returns an empty unsubscribe function
                emit: () => {},          // Does nothing
                off: () => {},           // Does nothing
                _isFallback: true        // Marker for identification
            };
        }
        
        // ✅ Container resolution
        this.container = this.resolveContainer(containerId);
        this.containerId = typeof containerId === 'string' ? containerId : containerId?.id || 'unknown';
        
        // Services
        this.logger = window.logger || this.createFallbackLogger();
        this.backend = window.backendService || window.app?.services?.backend || null;
        
        // View state
        this.state = {
            initialized: false,
            visible: false,
            rendered: false,
            loading: false,
            error: null,
            lastUpdate: null
        };
        
        // Configuration
        this.config = {
            autoRender: false,
            cacheDOM: true,
            enableLogging: true,
            updateOnChange: true,
            debounceMs: 100
        };
        
        // DOM element cache
        this.elements = {};
        this.cachedElements = new Map();
        
        // Event handling
        this.eventSubscriptions = [];
        this.domEventListeners = [];
        
        // Timers
        this._updateTimer = null;
        this._renderTimer = null;
        
        // Metrics
        this.metrics = {
            renderCount: 0,
            updateCount: 0,
            errorCount: 0,
            lastRenderTime: 0
        };
        
        // Validation
        if (!this.container) {
            this.log('warn', `Container not found for ${this.constructor.name}: ${containerId}`);
        }
        
        this.log('debug', `${this.constructor.name} view created`);
    }
    
    // ========================================================================
    // CONTAINER RESOLUTION
    // ========================================================================
    
    /**
     * Resolves the container from an ID or DOM element
     * @param {string|HTMLElement} input - ID or element
     * @returns {HTMLElement|null} Resolved DOM element
     */
    resolveContainer(input) {
        if (!input) {
            return null;
        }
        
        // If already a DOM element, return it
        if (input instanceof HTMLElement) {
            return input;
        }
        
        // If a string, search by ID or selector
        if (typeof input === 'string') {
            // Try with #
            let element = document.querySelector(input.startsWith('#') ? input : `#${input}`);
            
            // If not found, try as a CSS selector
            if (!element) {
                element = document.querySelector(input);
            }
            
            return element;
        }
        
        return null;
    }
    
    // ========================================================================
    // LIFECYCLE
    // ========================================================================
    
    /**
     * Initializes the view
     */
    init() {
        if (this.state.initialized) {
            this.log('warn', `${this.constructor.name} already initialized`);
            return;
        }
        
        this.state.initialized = true;
        this.state.lastUpdate = Date.now();
        
        this.log('info', `${this.constructor.name} initialized`);
        
        if (this.config.autoRender) {
            this.render();
        }
    }
    
    /**
     * Destroys the view and cleans up resources
     */
    destroy() {
        this.log('debug', `Destroying ${this.constructor.name}`);
        
        // Clear timers
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
        
        if (this._renderTimer) {
            clearTimeout(this._renderTimer);
            this._renderTimer = null;
        }
        
        // Unsubscribe all EventBus events
        this.eventSubscriptions.forEach(unsub => {
            if (typeof unsub === 'function') {
                unsub();
            }
        });
        this.eventSubscriptions = [];
        
        // Remove all DOM event listeners
        this.domEventListeners.forEach(({ element, event, handler, options }) => {
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler, options);
            }
        });
        this.domEventListeners = [];
        
        // Clear the cache
        this.cachedElements.clear();
        this.elements = {};
        
        // Reset state
        this.state.initialized = false;
        this.state.rendered = false;
        
        this.log('info', `${this.constructor.name} destroyed`);
    }
    
    // ========================================================================
    // RENDER
    // ========================================================================
    
    /**
     * Renders the view (override in subclasses)
     * @param {Object} data - Optional data for rendering
     */
    render(data = null) {
        if (!this.container) {
            this.log('error', `Cannot render ${this.constructor.name}: container not found`);
            return;
        }
        
        const startTime = performance.now();
        
        try {
            this.state.rendered = true;
            this.state.lastUpdate = Date.now();
            this.metrics.renderCount++;
            
            // Subclasses should implement their own render logic
            // this.container.innerHTML = this.template(data);
            
            // Emit render event
            this.emit('render', { 
                view: this.constructor.name,
                data 
            });
            
            const renderTime = performance.now() - startTime;
            this.metrics.lastRenderTime = renderTime;
            
            this.log('debug', `${this.constructor.name} rendered in ${renderTime.toFixed(2)}ms`);
            
        } catch (error) {
            this.handleError('Render failed', error);
        }
    }
    
    /**
     * Updates the view with new data
     * @param {Object} data - New data
     */
    update(data = null) {
        if (!this.state.initialized) {
            this.log('warn', `Cannot update ${this.constructor.name}: not initialized`);
            return;
        }
        
        this.metrics.updateCount++;
        
        if (this.config.updateOnChange) {
            this.render(data);
        }
        
        this.emit('update', {
            view: this.constructor.name,
            data
        });
    }
    
    /**
     * Refreshes the view
     */
    refresh() {
        this.render();
    }
    
    // ========================================================================
    // VISIBILITY
    // ========================================================================
    
    /**
     * Shows the view
     */
    show() {
        if (!this.container) {
            this.log('error', `Cannot show ${this.constructor.name}: container not found`);
            return;
        }
        
        this.container.style.display = '';
        this.state.visible = true;
        
        this.emit('show', { view: this.constructor.name });
        this.log('debug', `${this.constructor.name} shown`);
    }
    
    /**
     * Hides the view
     */
    hide() {
        if (!this.container) {
            this.log('error', `Cannot hide ${this.constructor.name}: container not found`);
            return;
        }
        
        this.container.style.display = 'none';
        this.state.visible = false;
        
        this.emit('hide', { view: this.constructor.name });
        this.log('debug', `${this.constructor.name} hidden`);
    }
    
    /**
     * Toggles visibility
     */
    toggle() {
        if (this.state.visible) {
            this.hide();
        } else {
            this.show();
        }
    }
    
    // ========================================================================
    // EVENT HANDLING
    // ========================================================================
    
    /**
     * Listen to an EventBus event
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    on(event, handler) {
        if (!this.eventBus || typeof this.eventBus.on !== 'function') {
            this.log('warn', `Cannot subscribe to ${event}: EventBus not available`);
            return () => {};
        }
        
        const unsub = this.eventBus.on(event, handler);
        this.eventSubscriptions.push(unsub);
        
        return unsub;
    }
    
    /**
     * Listen to an event only once
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    once(event, handler) {
        if (!this.eventBus || typeof this.eventBus.once !== 'function') {
            this.log('warn', `Cannot subscribe to ${event}: EventBus not available`);
            return () => {};
        }

        let unsub;
        const wrappedHandler = (data) => {
            const idx = this.eventSubscriptions.indexOf(unsub);
            if (idx !== -1) this.eventSubscriptions.splice(idx, 1);
            handler(data);
        };
        unsub = this.eventBus.once(event, wrappedHandler);
        this.eventSubscriptions.push(unsub);

        return unsub;
    }
    
    /**
     * Emits an EventBus event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data = null) {
        if (!this.eventBus || typeof this.eventBus.emit !== 'function') {
            return;
        }
        
        this.eventBus.emit(event, data);
    }
    
    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    off(event, handler) {
        if (!this.eventBus || typeof this.eventBus.off !== 'function') {
            return;
        }
        
        this.eventBus.off(event, handler);
    }
    
    /**
     * Add a DOM event listener with tracking
     * @param {HTMLElement} element - DOM element
     * @param {string} event - Event type
     * @param {Function} handler - Handler
     * @param {Object} options - addEventListener options
     */
    addDOMListener(element, event, handler, options = {}) {
        if (!element || typeof element.addEventListener !== 'function') {
            this.log('warn', `Cannot add DOM listener: invalid element`);
            return;
        }
        
        element.addEventListener(event, handler, options);
        this.domEventListeners.push({ element, event, handler, options });
    }
    
    // ========================================================================
    // CACHE DOM
    // ========================================================================
    
    /**
     * Cache a DOM element by selector
     * @param {string} selector - CSS selector
     * @param {HTMLElement} context - Search context (default: container)
     * @returns {HTMLElement|null}
     */
    cacheElement(selector, context = null) {
        const searchContext = context || this.container;
        
        if (!searchContext) {
            return null;
        }
        
        if (this.cachedElements.has(selector)) {
            return this.cachedElements.get(selector);
        }
        
        const element = searchContext.querySelector(selector);
        
        if (element) {
            this.cachedElements.set(selector, element);
        }
        
        return element;
    }
    
    /**
     * Retrieve an element from the cache or search for it
     * @param {string} selector - CSS selector
     * @returns {HTMLElement|null}
     */
    $(selector) {
        return this.cacheElement(selector);
    }
    
    /**
     * Retrieve all matching elements
     * @param {string} selector - CSS selector
     * @param {HTMLElement} context - Search context
     * @returns {NodeList}
     */
    $$(selector, context = null) {
        const searchContext = context || this.container;
        return searchContext ? searchContext.querySelectorAll(selector) : [];
    }
    
    /**
     * Clears the DOM element cache
     */
    clearCache() {
        this.cachedElements.clear();
        this.log('debug', `${this.constructor.name} cache cleared`);
    }
    
    // ========================================================================
    // STATE AND DATA
    // ========================================================================
    
    /**
     * Set the loading state
     * @param {boolean} loading - Loading state
     */
    setLoading(loading) {
        this.state.loading = loading;
        this.emit('loading', { loading, view: this.constructor.name });
    }
    
    /**
     * Sets an error
     * @param {Error|string} error - Error
     */
    setError(error) {
        this.state.error = error;
        this.metrics.errorCount++;
        this.emit('error', { error, view: this.constructor.name });
    }
    
    /**
     * Clears the error
     */
    clearError() {
        this.state.error = null;
    }
    
    // ========================================================================
    // ERROR HANDLING
    // ========================================================================
    
    /**
     * Handles an error
     * @param {string} context - Error context
     * @param {Error} error - Error
     */
    handleError(context, error) {
        this.log('error', `${this.constructor.name} - ${context}:`, error);
        this.setError(error);
        
        // Notify via EventBus
        this.emit('view:error', {
            view: this.constructor.name,
            context,
            error: error.message || String(error)
        });
    }
    
    // ========================================================================
    // UTILITIES
    // ========================================================================
    
    /**
     * Escapes HTML to prevent XSS
     * @param {string} unsafe - Unsafe string
     * @returns {string} Escaped string
     */
    escapeHtml(unsafe) {
        return window.escapeHtml(unsafe);
    }
    
    /**
     * Creates a DOM element
     * @param {string} tag - HTML tag
     * @param {Object} attributes - Attributes
     * @param {string|HTMLElement} content - Content
     * @returns {HTMLElement}
     */
    createElement(tag, attributes = {}, content = null) {
        const element = document.createElement(tag);
        
        // Set attributes
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === 'className') {
                element.className = value;
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(element.style, value);
            } else if (key.startsWith('data-')) {
                element.setAttribute(key, value);
            } else {
                element[key] = value;
            }
        });
        
        // Add content
        if (content !== null) {
            if (typeof content === 'string') {
                element.textContent = content;
            } else if (content instanceof HTMLElement) {
                element.appendChild(content);
            }
        }
        
        return element;
    }
    
    /**
     * Debounce a function
     * @param {Function} func - Function to debounce
     * @param {number} wait - Delay in ms
     * @returns {Function}
     */
    debounce(func, wait = this.config.debounceMs) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    // ========================================================================
    // LOGGING
    // ========================================================================
    
    /**
     * Creates a fallback logger
     * @returns {Object}
     */
    createFallbackLogger() {
        if (window.logger && typeof window.logger.log === 'function') {
            return window.logger;
        }
        
        return {
            log: (level, ...args) => {
                if (this.config.enableLogging) {
                    console.log(`[${level.toUpperCase()}]`, ...args);
                }
            },
            debug: (...args) => this.config.enableLogging && console.debug(...args),
            info: (...args) => this.config.enableLogging && console.info(...args),
            warn: (...args) => console.warn(...args),
            error: (...args) => console.error(...args)
        };
    }
    
    /**
     * Log a message
     * @param {string} level - Log level
     * @param {...any} args - Arguments
     */
    log(level, ...args) {
        if (!this.config.enableLogging && level === 'debug') {
            return;
        }
        
        if (this.logger && typeof this.logger.log === 'function') {
            this.logger.log(level, `[${this.constructor.name}]`, ...args);
        } else if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level](`[${this.constructor.name}]`, ...args);
        }
    }
    
    // ========================================================================
    // METRICS
    // ========================================================================
    
    /**
     * Gets the view metrics
     * @returns {Object}
     */
    getMetrics() {
        return {
            ...this.metrics,
            initialized: this.state.initialized,
            visible: this.state.visible,
            rendered: this.state.rendered,
            hasContainer: !!this.container,
            eventSubscriptions: this.eventSubscriptions.length,
            domListeners: this.domEventListeners.length,
            cachedElements: this.cachedElements.size
        };
    }
    
    /**
     * Reset metrics
     */
    resetMetrics() {
        this.metrics = {
            renderCount: 0,
            updateCount: 0,
            errorCount: 0,
            lastRenderTime: 0
        };
    }
}

// ============================================================================
// EXPORT GLOBAL
// ============================================================================

if (typeof window !== 'undefined') {
    window.BaseView = BaseView;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BaseView;
}