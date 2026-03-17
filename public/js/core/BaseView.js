// ============================================================================
// Fichier: frontend/js/core/BaseView.js
// Chemin réel: frontend/js/core/BaseView.js
// Version: v4.0.0 - RECONSTRUCTION COMPLÈTE
// Date: 2025-11-05
// ============================================================================
// RECONSTRUCTION v4.0.0:
// ✅ CRITIQUE: Recréation complète de BaseView (fichier corrompu)
// ✅ Signature standard: constructor(containerId, eventBus)
// ✅ Résolution container robuste
// ✅ Fallback EventBus minimal
// ✅ Méthodes essentielles: render(), show(), hide(), update(), emit()
// ✅ Gestion événements avec cleanup
// ✅ Validation et logging intégrés
// ============================================================================

class BaseView {
    /**
     * Constructeur de la vue de base
     * @param {string|HTMLElement} containerId - ID du conteneur ou élément DOM
     * @param {EventBus} eventBus - Instance EventBus pour communication
     */
    constructor(containerId, eventBus) {
        // ✅ EventBus avec fallback robuste
        this.eventBus = eventBus || window.eventBus;
        
        // ✅ CRITIQUE: Si EventBus toujours absent, créer fallback minimal
        if (!this.eventBus) {
            console.warn(
                `[${this.constructor.name}] EventBus not found - creating minimal fallback. ` +
                `Check that EventBus is initialized in main.js before Application.`
            );
            
            // Créer un EventBus minimal fonctionnel
            this.eventBus = {
                on: () => () => {},      // Retourne une fonction de désinscription vide
                once: () => () => {},    // Retourne une fonction de désinscription vide
                emit: () => {},          // Ne fait rien
                off: () => {},           // Ne fait rien
                _isFallback: true        // Marqueur pour identification
            };
        }
        
        // ✅ Résolution du container
        this.container = this.resolveContainer(containerId);
        this.containerId = typeof containerId === 'string' ? containerId : containerId?.id || 'unknown';
        
        // Services
        this.logger = window.logger || this.createFallbackLogger();
        this.backend = window.backendService || window.app?.services?.backend || null;
        
        // État de la vue
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
        
        // Cache d'éléments DOM
        this.elements = {};
        this.cachedElements = new Map();
        
        // Gestion des événements
        this.eventSubscriptions = [];
        this.domEventListeners = [];
        
        // Timers
        this._updateTimer = null;
        this._renderTimer = null;
        
        // Métriques
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
    // RÉSOLUTION CONTAINER
    // ========================================================================
    
    /**
     * Résout le container à partir d'un ID ou élément DOM
     * @param {string|HTMLElement} input - ID ou élément
     * @returns {HTMLElement|null} Élément DOM résolu
     */
    resolveContainer(input) {
        if (!input) {
            return null;
        }
        
        // Si déjà un élément DOM, le retourner
        if (input instanceof HTMLElement) {
            return input;
        }
        
        // Si string, chercher par ID ou sélecteur
        if (typeof input === 'string') {
            // Essayer avec #
            let element = document.querySelector(input.startsWith('#') ? input : `#${input}`);
            
            // Si pas trouvé, essayer comme sélecteur CSS
            if (!element) {
                element = document.querySelector(input);
            }
            
            return element;
        }
        
        return null;
    }
    
    // ========================================================================
    // CYCLE DE VIE
    // ========================================================================
    
    /**
     * Initialise la vue
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
     * Détruit la vue et nettoie les ressources
     */
    destroy() {
        this.log('debug', `Destroying ${this.constructor.name}`);
        
        // Nettoyer les timers
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
        
        if (this._renderTimer) {
            clearTimeout(this._renderTimer);
            this._renderTimer = null;
        }
        
        // Désinscrire tous les événements EventBus
        this.eventSubscriptions.forEach(unsub => {
            if (typeof unsub === 'function') {
                unsub();
            }
        });
        this.eventSubscriptions = [];
        
        // Retirer tous les event listeners DOM
        this.domEventListeners.forEach(({ element, event, handler, options }) => {
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler, options);
            }
        });
        this.domEventListeners = [];
        
        // Vider le cache
        this.cachedElements.clear();
        this.elements = {};
        
        // Réinitialiser l'état
        this.state.initialized = false;
        this.state.rendered = false;
        
        this.log('info', `${this.constructor.name} destroyed`);
    }
    
    // ========================================================================
    // RENDU
    // ========================================================================
    
    /**
     * Rend la vue (à surcharger dans les classes filles)
     * @param {Object} data - Données optionnelles pour le rendu
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
            
            // Les classes filles doivent implémenter leur logique de rendu
            // this.container.innerHTML = this.template(data);
            
            // Émettre événement de rendu
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
     * Met à jour la vue avec de nouvelles données
     * @param {Object} data - Nouvelles données
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
     * Rafraîchit la vue
     */
    refresh() {
        this.render();
    }
    
    // ========================================================================
    // VISIBILITÉ
    // ========================================================================
    
    /**
     * Affiche la vue
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
     * Cache la vue
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
     * Toggle la visibilité
     */
    toggle() {
        if (this.state.visible) {
            this.hide();
        } else {
            this.show();
        }
    }
    
    // ========================================================================
    // GESTION DES ÉVÉNEMENTS
    // ========================================================================
    
    /**
     * Écoute un événement EventBus
     * @param {string} event - Nom de l'événement
     * @param {Function} handler - Fonction de gestion
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
     * Écoute un événement une seule fois
     * @param {string} event - Nom de l'événement
     * @param {Function} handler - Fonction de gestion
     */
    once(event, handler) {
        if (!this.eventBus || typeof this.eventBus.once !== 'function') {
            this.log('warn', `Cannot subscribe to ${event}: EventBus not available`);
            return () => {};
        }
        
        const unsub = this.eventBus.once(event, handler);
        this.eventSubscriptions.push(unsub);
        
        return unsub;
    }
    
    /**
     * Émet un événement EventBus
     * @param {string} event - Nom de l'événement
     * @param {*} data - Données de l'événement
     */
    emit(event, data = null) {
        if (!this.eventBus || typeof this.eventBus.emit !== 'function') {
            return;
        }
        
        this.eventBus.emit(event, data);
    }
    
    /**
     * Se désabonne d'un événement
     * @param {string} event - Nom de l'événement
     * @param {Function} handler - Fonction de gestion
     */
    off(event, handler) {
        if (!this.eventBus || typeof this.eventBus.off !== 'function') {
            return;
        }
        
        this.eventBus.off(event, handler);
    }
    
    /**
     * Ajoute un event listener DOM avec tracking
     * @param {HTMLElement} element - Élément DOM
     * @param {string} event - Type d'événement
     * @param {Function} handler - Gestionnaire
     * @param {Object} options - Options addEventListener
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
     * Cache un élément DOM par sélecteur
     * @param {string} selector - Sélecteur CSS
     * @param {HTMLElement} context - Contexte de recherche (défaut: container)
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
     * Récupère un élément du cache ou le cherche
     * @param {string} selector - Sélecteur CSS
     * @returns {HTMLElement|null}
     */
    $(selector) {
        return this.cacheElement(selector);
    }
    
    /**
     * Récupère tous les éléments correspondants
     * @param {string} selector - Sélecteur CSS
     * @param {HTMLElement} context - Contexte de recherche
     * @returns {NodeList}
     */
    $$(selector, context = null) {
        const searchContext = context || this.container;
        return searchContext ? searchContext.querySelectorAll(selector) : [];
    }
    
    /**
     * Vide le cache d'éléments DOM
     */
    clearCache() {
        this.cachedElements.clear();
        this.log('debug', `${this.constructor.name} cache cleared`);
    }
    
    // ========================================================================
    // ÉTAT ET DONNÉES
    // ========================================================================
    
    /**
     * Définit l'état de chargement
     * @param {boolean} loading - État de chargement
     */
    setLoading(loading) {
        this.state.loading = loading;
        this.emit('loading', { loading, view: this.constructor.name });
    }
    
    /**
     * Définit une erreur
     * @param {Error|string} error - Erreur
     */
    setError(error) {
        this.state.error = error;
        this.metrics.errorCount++;
        this.emit('error', { error, view: this.constructor.name });
    }
    
    /**
     * Efface l'erreur
     */
    clearError() {
        this.state.error = null;
    }
    
    // ========================================================================
    // GESTION DES ERREURS
    // ========================================================================
    
    /**
     * Gère une erreur
     * @param {string} context - Contexte de l'erreur
     * @param {Error} error - Erreur
     */
    handleError(context, error) {
        this.log('error', `${this.constructor.name} - ${context}:`, error);
        this.setError(error);
        
        // Notifier via EventBus
        this.emit('view:error', {
            view: this.constructor.name,
            context,
            error: error.message || String(error)
        });
    }
    
    // ========================================================================
    // UTILITAIRES
    // ========================================================================
    
    /**
     * Échappe du HTML pour prévenir XSS
     * @param {string} unsafe - Chaîne non sûre
     * @returns {string} Chaîne échappée
     */
    escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') {
            return String(unsafe);
        }
        
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    
    /**
     * Crée un élément DOM
     * @param {string} tag - Tag HTML
     * @param {Object} attributes - Attributs
     * @param {string|HTMLElement} content - Contenu
     * @returns {HTMLElement}
     */
    createElement(tag, attributes = {}, content = null) {
        const element = document.createElement(tag);
        
        // Définir les attributs
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
        
        // Ajouter le contenu
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
     * Débounce une fonction
     * @param {Function} func - Fonction à débouncer
     * @param {number} wait - Délai en ms
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
     * Crée un logger fallback
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
     * Log un message
     * @param {string} level - Niveau de log
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
    // MÉTRIQUES
    // ========================================================================
    
    /**
     * Obtient les métriques de la vue
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
     * Réinitialise les métriques
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