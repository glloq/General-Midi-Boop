/**
 * BaseModal v1.0.0
 * Base class for all modal dialogs, eliminating duplication across modals.
 *
 * Provides:
 * - Modal DOM structure (overlay > dialog > header + body + footer)
 * - ESC key to close
 * - Click outside to close
 * - i18n support with locale change subscription
 * - HTML escaping
 * - Focus trap for accessibility
 * - ARIA attributes
 *
 * Usage:
 *   class MyModal extends BaseModal {
 *     constructor() {
 *       super({ id: 'my-modal', size: 'lg', title: 'My Modal' });
 *     }
 *     renderBody() { return '<p>Content</p>'; }
 *     renderFooter() { return '<button>OK</button>'; }
 *     onOpen() { // attach events }
 *     onClose() { // cleanup }
 *   }
 */
class BaseModal {
    /**
     * @param {Object} options
     * @param {string} options.id - Unique modal ID
     * @param {string} [options.size='md'] - Modal size: 'sm', 'md', 'lg', 'xl', 'full'
     * @param {string} [options.title=''] - Modal title (i18n key or plain text)
     * @param {boolean} [options.closeOnEscape=true] - Close on ESC key
     * @param {boolean} [options.closeOnOverlay=true] - Close on overlay click
     * @param {boolean} [options.showCloseButton=true] - Show X close button
     * @param {string} [options.customClass=''] - Additional CSS class for the dialog
     */
    constructor(options = {}) {
        this.options = {
            id: options.id || 'modal-' + Date.now(),
            size: options.size || 'md',
            title: options.title || '',
            closeOnEscape: options.closeOnEscape !== false,
            closeOnOverlay: options.closeOnOverlay !== false,
            showCloseButton: options.showCloseButton !== false,
            customClass: options.customClass || ''
        };

        this.container = null;
        this.dialog = null;
        this.isOpen = false;

        // Internal handlers for cleanup
        this._escHandler = null;
        this._overlayHandler = null;
        this._localeUnsubscribe = null;
        this._focusTrapHandler = null;
        this._previousFocus = null;
    }

    // ============================================
    // I18N SUPPORT
    // ============================================

    /**
     * Translate a key using the global i18n system
     * @param {string} key - Translation key
     * @param {Object} [params] - Interpolation parameters
     * @returns {string} Translated text or key as fallback
     */
    t(key, params = {}) {
        if (typeof i18n !== 'undefined' && i18n.t) {
            return i18n.t(key, params);
        }
        return key;
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Raw text
     * @returns {string} Escaped HTML
     */
    escape(text) {
        if (typeof escapeHtml === 'function') {
            return escapeHtml(text);
        }
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // LIFECYCLE
    // ============================================

    /**
     * Open the modal
     */
    open() {
        if (this.isOpen) return;

        // Save current focus for restoration
        this._previousFocus = document.activeElement;

        // Create DOM
        this._createDOM();

        // Attach core handlers
        this._attachCoreHandlers();

        // Subscribe to locale changes
        this._subscribeLocale();

        // Mark as open
        this.isOpen = true;

        // Prevent body scroll
        document.body.style.overflow = 'hidden';

        // Focus trap: focus first focusable element
        requestAnimationFrame(() => {
            this._focusFirst();
        });

        // Subclass hook
        this.onOpen();
    }

    /**
     * Close the modal
     */
    close() {
        if (!this.isOpen) return;

        // Subclass hook
        this.onClose();

        // Remove handlers
        this._detachCoreHandlers();

        // Unsubscribe locale
        this._unsubscribeLocale();

        // Remove DOM
        if (this.container) {
            this.container.remove();
            this.container = null;
            this.dialog = null;
        }

        // Restore body scroll
        document.body.style.overflow = '';

        // Restore focus
        if (this._previousFocus && this._previousFocus.focus) {
            this._previousFocus.focus();
        }

        this.isOpen = false;
    }

    /**
     * Update modal content (e.g., after locale change)
     */
    update() {
        if (!this.isOpen || !this.dialog) return;

        const headerEl = this.dialog.querySelector('.modal-header h2');
        if (headerEl) {
            headerEl.textContent = this.t(this.options.title);
        }

        const bodyEl = this.dialog.querySelector('.modal-body');
        if (bodyEl) {
            bodyEl.innerHTML = this.renderBody();
        }

        const footerEl = this.dialog.querySelector('.modal-footer');
        if (footerEl) {
            footerEl.innerHTML = this.renderFooter();
        }

        // Subclass hook
        this.onUpdate();
    }

    // ============================================
    // SUBCLASS HOOKS (override these)
    // ============================================

    /** Override to provide modal body HTML */
    renderBody() { return ''; }

    /** Override to provide modal footer HTML */
    renderFooter() { return ''; }

    /** Called after modal is opened and DOM is ready */
    onOpen() {}

    /** Called before modal DOM is removed */
    onClose() {}

    /** Called after content is updated (e.g., locale change) */
    onUpdate() {}

    // ============================================
    // DOM CREATION
    // ============================================

    _createDOM() {
        // Overlay
        this.container = document.createElement('div');
        this.container.className = 'modal-overlay';
        this.container.id = this.options.id + '-overlay';
        this.container.setAttribute('role', 'dialog');
        this.container.setAttribute('aria-modal', 'true');
        this.container.setAttribute('aria-labelledby', this.options.id + '-title');

        // Dialog
        const sizeClass = this.options.size !== 'md' ? `modal-${this.options.size}` : '';
        const customClass = this.options.customClass;

        this.container.innerHTML = `
            <div class="modal-dialog ${sizeClass} ${customClass}".trim()>
                ${this._renderHeader()}
                <div class="modal-body">
                    ${this.renderBody()}
                </div>
                <div class="modal-footer">
                    ${this.renderFooter()}
                </div>
            </div>
        `;

        this.dialog = this.container.querySelector('.modal-dialog');

        document.body.appendChild(this.container);
    }

    _renderHeader() {
        const closeBtn = this.options.showCloseButton
            ? `<button class="modal-close" data-action="close" aria-label="${this.t('common.close') || 'Close'}">&times;</button>`
            : '';

        return `
            <div class="modal-header">
                <h2 id="${this.options.id}-title">${this.escape(this.t(this.options.title))}</h2>
                ${closeBtn}
            </div>
        `;
    }

    // ============================================
    // EVENT HANDLERS
    // ============================================

    _attachCoreHandlers() {
        // ESC key
        if (this.options.closeOnEscape) {
            this._escHandler = (e) => {
                if (e.key === 'Escape' && this.isOpen) {
                    e.preventDefault();
                    this.close();
                }
            };
            document.addEventListener('keydown', this._escHandler);
        }

        // Overlay click
        if (this.options.closeOnOverlay) {
            this._overlayHandler = (e) => {
                if (e.target === this.container) {
                    this.close();
                }
            };
            this.container.addEventListener('click', this._overlayHandler);
        }

        // Close button
        const closeBtn = this.container.querySelector('[data-action="close"]');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // Focus trap
        this._focusTrapHandler = (e) => {
            if (e.key === 'Tab' && this.dialog) {
                const focusable = this.dialog.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last?.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first?.focus();
                    }
                }
            }
        };
        document.addEventListener('keydown', this._focusTrapHandler);
    }

    _detachCoreHandlers() {
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (this._overlayHandler && this.container) {
            this.container.removeEventListener('click', this._overlayHandler);
            this._overlayHandler = null;
        }
        if (this._focusTrapHandler) {
            document.removeEventListener('keydown', this._focusTrapHandler);
            this._focusTrapHandler = null;
        }
    }

    // ============================================
    // LOCALE MANAGEMENT
    // ============================================

    _subscribeLocale() {
        if (typeof i18n !== 'undefined' && i18n.onLocaleChange) {
            this._localeUnsubscribe = i18n.onLocaleChange(() => {
                this.update();
            });
        }
    }

    _unsubscribeLocale() {
        if (this._localeUnsubscribe) {
            this._localeUnsubscribe();
            this._localeUnsubscribe = null;
        }
    }

    // ============================================
    // FOCUS MANAGEMENT
    // ============================================

    _focusFirst() {
        if (!this.dialog) return;
        const focusable = this.dialog.querySelector(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable) {
            focusable.focus();
        }
    }

    // ============================================
    // UTILITY
    // ============================================

    /**
     * Query a DOM element within the modal
     * @param {string} selector - CSS selector
     * @returns {HTMLElement|null}
     */
    $(selector) {
        return this.dialog ? this.dialog.querySelector(selector) : null;
    }

    /**
     * Query all matching DOM elements within the modal
     * @param {string} selector - CSS selector
     * @returns {NodeList}
     */
    $$(selector) {
        return this.dialog ? this.dialog.querySelectorAll(selector) : [];
    }
}

// Expose globally
if (typeof window !== 'undefined') {
    window.BaseModal = BaseModal;
}
