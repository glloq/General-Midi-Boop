// =============================================================================
// InstrumentViewRegistry.js — Registry + detection rules for keyboard views.
// =============================================================================
// The registry holds the mapping `viewKind -> ViewClass` and a list of
// detection rules (predicate → viewKind). The first matching rule wins.
//
// Built-in registrations live in registerBuiltins.js (loaded later) so that
// the registry itself remains free of view dependencies.
// =============================================================================
(function () {
    'use strict';

    class InstrumentViewRegistry {
        constructor() {
            /** @type {Map<string, Function>} */
            this._byKind = new Map();
            /** @type {Array<{predicate: Function, viewKind: string, options: Object}>} */
            this._rules = [];
        }

        /**
         * Register a view class. Must declare `static viewKind`.
         * @param {Function} ViewClass
         * @returns {this}
         */
        register(ViewClass) {
            if (!ViewClass || !ViewClass.viewKind || ViewClass.viewKind === 'abstract') {
                throw new Error('InstrumentViewRegistry.register: ViewClass.viewKind required');
            }
            if (this._byKind.has(ViewClass.viewKind)) {
                console.warn(`[InstrumentViewRegistry] overwriting viewKind: ${ViewClass.viewKind}`);
            }
            this._byKind.set(ViewClass.viewKind, ViewClass);
            return this;
        }

        /** Look up a view class by kind. */
        get(viewKind) { return this._byKind.get(viewKind); }

        /** List of all registered kinds. */
        kinds() { return [...this._byKind.keys()]; }

        /**
         * Add a detection rule. Rules are evaluated in insertion order until
         * one returns truthy.
         * @param {(caps: Object) => boolean} predicate
         * @param {string} viewKind
         * @param {Object} [options]
         * @returns {this}
         */
        addRule(predicate, viewKind, options = {}) {
            if (typeof predicate !== 'function' || !viewKind) {
                throw new Error('InstrumentViewRegistry.addRule: invalid arguments');
            }
            this._rules.push({ predicate, viewKind, options });
            return this;
        }

        /**
         * Resolve a view from raw capabilities. Returns the matching class
         * + options, or the fallback when none matches.
         * @param {Object} caps
         * @param {string} [fallback='piano']
         * @returns {{ ViewClass: Function|undefined, viewKind: string, options: Object }}
         */
        resolve(caps, fallback = 'piano') {
            for (const r of this._rules) {
                if (r.predicate(caps)) {
                    return {
                        ViewClass: this._byKind.get(r.viewKind),
                        viewKind: r.viewKind,
                        options: r.options || {}
                    };
                }
            }
            return {
                ViewClass: this._byKind.get(fallback),
                viewKind: fallback,
                options: {}
            };
        }

        /**
         * Convenience: resolve from a viewKind returned by InstrumentDetector.
         * Avoids re-running rules when the kind was already computed upstream.
         * @param {string} viewKind
         * @param {Object} [options]
         */
        resolveByKind(viewKind, options = {}) {
            return {
                ViewClass: this._byKind.get(viewKind),
                viewKind,
                options
            };
        }

        /** Reset state (tests only). */
        reset() {
            this._byKind.clear();
            this._rules.length = 0;
        }
    }

    // Singleton instance — every script registers/queries through it.
    const instance = new InstrumentViewRegistry();

    if (typeof window !== 'undefined') {
        window.InstrumentViewRegistry = InstrumentViewRegistry;
        window.instrumentViews = instance;
    }
    if (typeof module !== 'undefined') {
        module.exports = { InstrumentViewRegistry, instance };
    }
})();
