/**
 * Accessibility (a11y) Utilities v1.0.0
 * Provides focus trap, keyboard navigation, and ARIA helpers.
 */

const A11y = {
    /**
     * Focusable element selector
     */
    FOCUSABLE_SELECTOR: 'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',

    /**
     * Create a focus trap within a container element.
     * Returns a cleanup function to remove the trap.
     * @param {HTMLElement} container - The container to trap focus within
     * @returns {Function} cleanup - Call to remove the focus trap
     */
    trapFocus(container) {
        const handler = (e) => {
            if (e.key !== 'Tab') return;

            const focusable = container.querySelectorAll(A11y.FOCUSABLE_SELECTOR);
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === first || !container.contains(document.activeElement)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last || !container.contains(document.activeElement)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    },

    /**
     * Focus the first focusable element in a container
     * @param {HTMLElement} container
     */
    focusFirst(container) {
        const el = container.querySelector(A11y.FOCUSABLE_SELECTOR);
        if (el) el.focus();
    },

    /**
     * Announce a message to screen readers via aria-live region
     * @param {string} message - Text to announce
     * @param {string} [priority='polite'] - 'polite' or 'assertive'
     */
    announce(message, priority = 'polite') {
        let region = document.getElementById('a11y-announcer');
        if (!region) {
            region = document.createElement('div');
            region.id = 'a11y-announcer';
            region.setAttribute('aria-live', priority);
            region.setAttribute('aria-atomic', 'true');
            region.className = 'sr-only';
            document.body.appendChild(region);
        }
        region.setAttribute('aria-live', priority);
        // Clear then set to trigger announcement
        region.textContent = '';
        requestAnimationFrame(() => {
            region.textContent = message;
        });
    },

    /**
     * Setup arrow key navigation within a group of elements (e.g., toolbar buttons)
     * Elements should have role="toolbar" or similar.
     * @param {HTMLElement} container - Container with navigable children
     * @param {string} [selector='button'] - Selector for navigable children
     * @param {Object} [options]
     * @param {boolean} [options.horizontal=true] - Allow left/right arrow keys
     * @param {boolean} [options.vertical=false] - Allow up/down arrow keys
     * @param {boolean} [options.wrap=true] - Wrap around at ends
     * @returns {Function} cleanup - Call to remove listeners
     */
    arrowKeyNav(container, selector = 'button', options = {}) {
        const { horizontal = true, vertical = false, wrap = true } = options;

        const handler = (e) => {
            const items = Array.from(container.querySelectorAll(selector))
                .filter(el => !el.disabled && el.offsetParent !== null);
            if (items.length === 0) return;

            const currentIndex = items.indexOf(document.activeElement);
            let nextIndex = -1;

            if (horizontal && e.key === 'ArrowRight' || vertical && e.key === 'ArrowDown') {
                e.preventDefault();
                nextIndex = currentIndex + 1;
                if (nextIndex >= items.length) nextIndex = wrap ? 0 : items.length - 1;
            } else if (horizontal && e.key === 'ArrowLeft' || vertical && e.key === 'ArrowUp') {
                e.preventDefault();
                nextIndex = currentIndex - 1;
                if (nextIndex < 0) nextIndex = wrap ? items.length - 1 : 0;
            } else if (e.key === 'Home') {
                e.preventDefault();
                nextIndex = 0;
            } else if (e.key === 'End') {
                e.preventDefault();
                nextIndex = items.length - 1;
            }

            if (nextIndex >= 0 && nextIndex < items.length) {
                items[nextIndex].focus();
            }
        };

        container.addEventListener('keydown', handler);
        return () => container.removeEventListener('keydown', handler);
    },

    /**
     * Make an element announce its expanded/collapsed state
     * @param {HTMLElement} trigger - The button that toggles
     * @param {HTMLElement} target - The element that expands/collapses
     * @param {boolean} expanded - Current state
     */
    setExpanded(trigger, target, expanded) {
        trigger.setAttribute('aria-expanded', String(expanded));
        if (target.id) {
            trigger.setAttribute('aria-controls', target.id);
        }
    }
};

// Expose globally
if (typeof window !== 'undefined') {
    window.A11y = A11y;
}
