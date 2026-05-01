/**
 * @file HandEditorShared.js
 * @description Helpers shared between the two hand-position editor
 * modals (HandPositionEditorModal for fretted instruments,
 * KeyboardHandPositionEditorModal for keyboards). Both modals
 * historically duplicated the same undo/redo bookkeeping, the same
 * default override schema, and the same "modifications non
 * enregistrées" confirm dialog — this module is the single source
 * for those.
 *
 * Public API on `window.HandEditorShared`:
 *   - DEFAULT_OVERRIDES               — frozen template
 *   - cloneOverrides(o)               — deep clone (returns null for null)
 *   - emptyOverrides()                — fresh writable copy of DEFAULT_OVERRIDES
 *   - HistoryManager                  — class wrapping push/undo/redo/dirty
 *   - showUnsavedChangesConfirm(opts) — Promise<boolean> dialog
 */
(function() {
    'use strict';

    /** Override schema kept in lock-step with the backend route
     *  `POST /api/hand-position-overrides`. The two modals + the
     *  simulator all reach for this exact shape — keep it in one
     *  place so a future field addition is a one-line change. */
    const DEFAULT_OVERRIDES = Object.freeze({
        hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1
    });

    function cloneOverrides(o) {
        return o ? JSON.parse(JSON.stringify(o)) : null;
    }

    /** Fresh writable copy of the default override schema — used
     *  whenever the caller needs a blank slate (initial overrides
     *  null, reset button, etc). */
    function emptyOverrides() {
        return { hand_anchors: [], disabled_notes: [], note_assignments: [], version: 1 };
    }

    /**
     * Linear undo/redo stack with a saved-index marker. The dirty
     * flag is the gap between the live index and the saved index,
     * so undo-after-save correctly clears dirty even though the
     * stack moved. push() trims the redo branch like a typical
     * editor; the stack caps at maxHistory and shifts off the
     * oldest entry when full.
     */
    class HistoryManager {
        /**
         * @param {object} initial - initial overrides object (will be cloned)
         * @param {object} [opts]
         * @param {number} [opts.maxHistory=50]
         * @param {Function} [opts.onChange] - called after every push/undo/redo
         */
        constructor(initial, opts = {}) {
            this._maxHistory = Number.isFinite(opts.maxHistory) && opts.maxHistory > 0
                ? opts.maxHistory : 50;
            this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
            const seed = cloneOverrides(initial) || emptyOverrides();
            this._history = [seed];
            this._index = 0;
            this._savedIndex = 0;
        }

        /** Current snapshot — always a fresh clone so the caller can
         *  mutate freely without corrupting the stack. */
        current() { return cloneOverrides(this._history[this._index]); }

        get canUndo() { return this._index > 0; }
        get canRedo() { return this._index < this._history.length - 1; }
        get isDirty() { return this._index !== this._savedIndex; }

        /** Snapshot `state`, dropping any redo branch past the live
         *  index. When the stack overflows we drop the oldest entry
         *  and adjust savedIndex so an undo to a popped frame is
         *  reported as dirty (matches the legacy behaviour). */
        push(state) {
            this._history = this._history.slice(0, this._index + 1);
            this._history.push(cloneOverrides(state));
            if (this._history.length > this._maxHistory) {
                this._history.shift();
                this._savedIndex = Math.max(0, this._savedIndex - 1);
            } else {
                this._index++;
            }
            this._notify();
        }

        /** Step back. Returns the new live snapshot or null when
         *  already at the bottom. */
        undo() {
            if (!this.canUndo) return null;
            this._index--;
            this._notify();
            return this.current();
        }

        /** Step forward. Returns the new live snapshot or null when
         *  already at the top. */
        redo() {
            if (!this.canRedo) return null;
            this._index++;
            this._notify();
            return this.current();
        }

        /** Mark the current snapshot as the persisted one — the dirty
         *  flag flips false until the next push. Called after a
         *  successful save. */
        markSaved() {
            this._savedIndex = this._index;
            this._notify();
        }

        _notify() { if (this._onChange) this._onChange(this); }
    }

    function _t(key, fallback) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    /**
     * Project-styled "unsaved changes" confirmation dialog. Reuses
     * the `.confirm-modal-overlay` CSS from editor.css so it looks
     * like the rest of the app. Resolves to true when the operator
     * confirms the discard, false otherwise. Esc cancels, Enter
     * confirms.
     *
     * @param {object} [opts]
     * @param {string} [opts.titleKey]   i18n key for the title
     * @param {string} [opts.titleFallback]
     * @param {string} [opts.messageKey]
     * @param {string} [opts.messageFallback]
     * @param {string} [opts.confirmKey]
     * @param {string} [opts.confirmFallback]
     * @param {number} [opts.zIndex=10025] dialog z-index — must beat
     *                                     the editor's overlay (10010).
     * @param {string} [opts.extraClass]   additional class on the
     *                                     overlay for instance styling.
     * @returns {Promise<boolean>}
     */
    function showUnsavedChangesConfirm(opts = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            const cls = opts.extraClass ? ` ${opts.extraClass}` : '';
            overlay.className = `confirm-modal-overlay${cls}`;
            const title   = _t(opts.titleKey   || 'handEditorShared.confirmDiscardTitle',
                                opts.titleFallback   || 'Modifications non enregistrées');
            const message = _t(opts.messageKey || 'handEditorShared.confirmDiscard',
                                opts.messageFallback || 'Voulez-vous quitter sans sauvegarder ?');
            const confirm = _t(opts.confirmKey || 'handEditorShared.discardConfirmBtn',
                                opts.confirmFallback || 'Quitter sans sauvegarder');
            const cancel  = _t('common.cancel', 'Annuler');
            overlay.innerHTML = `
                <div class="confirm-modal" role="dialog" aria-modal="true">
                    <div class="confirm-modal-header">
                        <span class="confirm-modal-icon">⚠️</span>
                        <h3 class="confirm-modal-title">${title}</h3>
                    </div>
                    <div class="confirm-modal-body">
                        <p class="confirm-modal-message">${message}</p>
                    </div>
                    <div class="confirm-modal-footer">
                        <button class="confirm-modal-btn cancel" data-action="cancel">${cancel}</button>
                        <button class="confirm-modal-btn danger" data-action="confirm">${confirm}</button>
                    </div>
                </div>
            `;
            overlay.style.zIndex = String(opts.zIndex || 10025);
            document.body.appendChild(overlay);

            const close = (result) => {
                overlay.removeEventListener('click', onClick);
                document.removeEventListener('keydown', onKey);
                overlay.classList.remove('visible');
                setTimeout(() => {
                    if (overlay.parentNode) overlay.remove();
                    resolve(result);
                }, 200);
            };
            const onClick = (e) => {
                if (e.target === overlay) { close(false); return; }
                const btn = e.target.closest('.confirm-modal-btn');
                if (!btn) return;
                close(btn.dataset.action === 'confirm');
            };
            const onKey = (e) => {
                if (e.key === 'Escape') close(false);
                else if (e.key === 'Enter') close(true);
            };
            overlay.addEventListener('click', onClick);
            document.addEventListener('keydown', onKey);
            requestAnimationFrame(() => overlay.classList.add('visible'));
            setTimeout(() => {
                overlay.querySelector('.confirm-modal-btn.cancel')?.focus();
            }, 50);
        });
    }

    const api = {
        DEFAULT_OVERRIDES,
        cloneOverrides,
        emptyOverrides,
        HistoryManager,
        showUnsavedChangesConfirm
    };

    if (typeof window !== 'undefined') {
        window.HandEditorShared = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
