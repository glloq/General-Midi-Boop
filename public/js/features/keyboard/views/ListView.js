// =============================================================================
// ListView.js — Compact horizontal note list with radial glow + drag pitch.
// =============================================================================
// Notes laid out left-to-right (low → high). Y-axis = velocity OR a chosen
// CC; X-axis = pitch bend (toggleable). Used as an alternative to the piano
// view for sound design / live performance — works for any pitched
// instrument that isn't a drum kit or fretboard.
//
// Phase D delegation: mount() calls modal.renderKeyboardList() and
// modal._initKeyboardListInteraction(container) (legacy mixin in
// KeyboardListView.js).
// =============================================================================
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.InstrumentView) return;
    const InstrumentView = window.InstrumentView;

    class ListView extends InstrumentView {
        static viewKind = 'keyboard-list';
        static emoji = '☰';
        static labelKey = 'keyboard.viewList';

        mount(ctx) {
            super.mount(ctx);
            const modal = ctx.modal;
            if (!modal) return;
            if (typeof modal.renderKeyboardList === 'function') {
                modal.renderKeyboardList();
            }
            // Interaction binding (mouse → velocity Y + pitch bend X)
            // is attached by the legacy code inside renderKeyboardList().
        }

        unmount() {
            const modal = this.ctx && this.ctx.modal;
            if (modal && typeof modal._destroyKeyboardListInteraction === 'function') {
                modal._destroyKeyboardListInteraction();
            }
            super.unmount();
        }

        setNoteRange(startNote, noteCount) {
            const modal = this.ctx && this.ctx.modal;
            if (!modal) return;
            modal.startNote = startNote;
            modal.visibleNoteCount = noteCount;
            if (typeof modal.renderKeyboardList === 'function') {
                modal.renderKeyboardList();
            }
        }

        toolbarGroups() {
            // List view exposes its own controls (CC selector + pitch-bend
            // toggle) plus the standard notation + velocity. Minimap is
            // visible because list uses the same MIDI range as piano.
            return new Set([
                'notation', 'velocity', 'note-color',
                'list-view', 'list-cc', 'list-pb',
                'minimap', 'view-mode',
                'modulation', 'pitch-bend'
            ]);
        }
    }

    if (typeof window !== 'undefined') window.ListView = ListView;
    if (typeof module !== 'undefined') module.exports = ListView;
})();
