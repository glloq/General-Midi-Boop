// ============================================================================
// KeyboardChords.js — Hand position widget for string-instrument fretboard view
// ============================================================================
// Mixin for KeyboardModalNew. Provides:
//   - Hand position widget (drag to move hand along fretboard)
//   - Physical mm-based width calculation for the hand band
//   - CC emission on hand position change
// ============================================================================
(function () {
    'use strict';
    const KeyboardChordsMixin = {};

    // ── Per-instance state (patched onto KeyboardModalNew.prototype) ─────────
    KeyboardChordsMixin.handAnchorFret = 0;     // leftmost fret of the hand window
    KeyboardChordsMixin._handSpanFrets = 4;     // frets covered by the hand (fallback)
    KeyboardChordsMixin._cachedMaxFrets = 22;
    KeyboardChordsMixin._handSpanMm = 0;        // physical hand span in mm (0 = not set)
    KeyboardChordsMixin._scaleLengthMm = 0;     // instrument scale length in mm (0 = not set)

    // ── Hand position widget ─────────────────────────────────────────────────

    /**
     * Equal-tempered fret-to-percentage conversion (matches fretboard grid).
     */
    function fretPct(fret, maxFrets) {
        if (!maxFrets) return fret / 24 * 100;
        const total = 1 - Math.pow(2, -maxFrets / 12);
        return (1 - Math.pow(2, -fret / 12)) / total * 100;
    }

    /**
     * Render the hand position widget above the string rows.
     * Called from KeyboardPiano.renderFretboard() before the string loop.
     */
    KeyboardChordsMixin.renderHandWidget = function (stringsArea, opts) {
        const { maxFretCount = 22, isFretless = false } = opts || {};

        const cfg = this.stringInstrumentConfig || {};
        const handsConfig = cfg.hands_config;

        // Show the hand widget only when explicitly enabled in instrument settings.
        if (!handsConfig || handsConfig.enabled !== true) return;

        this._cachedMaxFrets = maxFretCount;

        // Read physical dimensions for mm-based width calculation.
        const hand = (handsConfig.hands && handsConfig.hands[0]) || {};
        const handSpanMm = Number.isFinite(hand.hand_span_mm) ? hand.hand_span_mm : 0;
        const scaleLengthMm = Number.isFinite(cfg.scale_length_mm) ? cfg.scale_length_mm : 0;
        this._handSpanMm = handSpanMm;
        this._scaleLengthMm = scaleLengthMm;

        // Fallback: fret-based span (legacy field).
        if (hand.hand_span_frets > 0) this._handSpanFrets = hand.hand_span_frets;

        const widget = document.createElement('div');
        widget.className = 'fretboard-hand-widget';
        widget.id = 'fretboard-hand-widget';

        const nutGap = document.createElement('div');
        nutGap.className = 'hand-nut-gap';
        widget.appendChild(nutGap);

        const fretsArea = document.createElement('div');
        fretsArea.className = 'hand-frets-area';
        fretsArea.id = 'hand-frets-area';

        // Fret dividers
        if (!isFretless) {
            for (let f = 1; f <= maxFretCount; f++) {
                const line = document.createElement('div');
                line.className = 'hand-fret-line';
                line.style.left = fretPct(f, maxFretCount) + '%';
                fretsArea.appendChild(line);
            }
        }

        const band = document.createElement('div');
        band.className = 'hand-band';
        band.id = 'fretboard-hand-band';
        band.title = (typeof this.t === 'function') ? this.t('keyboard.chordHandDrag') : 'Drag to move hand';

        // Finger dots (one per string, using num_strings)
        const numStrings = Math.max(1, cfg.num_strings || 6);
        for (let i = 0; i < numStrings; i++) {
            const dot = document.createElement('div');
            dot.className = 'hand-finger-dot';
            band.appendChild(dot);
        }

        fretsArea.appendChild(band);
        widget.appendChild(fretsArea);
        stringsArea.appendChild(widget);

        this._updateHandWidgetPosition();
        this._attachHandWidgetEvents(band, fretsArea);
    };

    /**
     * Reposition the .hand-band.
     * When hand_span_mm and scale_length_mm are available the width is a fixed
     * physical fraction of the fretboard (independent of fret position).
     * Otherwise falls back to the legacy fret-count approach.
     */
    KeyboardChordsMixin._updateHandWidgetPosition = function () {
        const band = document.getElementById('fretboard-hand-band');
        if (!band) return;
        const maxFrets  = this._cachedMaxFrets || 22;
        const leftPct   = fretPct(this.handAnchorFret, maxFrets);

        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            // Physical width: hand_span_mm as a fraction of the fretboard length.
            // The rendered fretboard covers scaleLengthMm * (1 - 2^(-maxFrets/12)).
            const fretboardFraction = 1 - Math.pow(2, -maxFrets / 12);
            const widthPct = (this._handSpanMm / this._scaleLengthMm) / fretboardFraction * 100;
            band.style.left  = leftPct + '%';
            band.style.width = Math.min(widthPct, 100 - leftPct) + '%';
        } else {
            // Fallback: fret-based (non-physical, width varies with fret spacing).
            const rightPct = fretPct(this.handAnchorFret + this._handSpanFrets, maxFrets);
            band.style.left  = leftPct + '%';
            band.style.width = (rightPct - leftPct) + '%';
        }
    };

    /**
     * Maximum fret the hand anchor can reach so the band stays inside the
     * fretboard. In mm mode this is derived from physical dimensions; otherwise
     * it falls back to the legacy fret-count formula.
     */
    KeyboardChordsMixin._maxHandAnchorFret = function () {
        const maxFrets = this._cachedMaxFrets || 22;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            // Physical end of fretboard in mm, then subtract hand span.
            const fretboardMm = this._scaleLengthMm * (1 - Math.pow(2, -maxFrets / 12));
            const maxStartMm  = fretboardMm - this._handSpanMm;
            if (maxStartMm <= 0) return 0;
            return -12 * Math.log2(1 - maxStartMm / this._scaleLengthMm);
        }
        return maxFrets - this._handSpanFrets;
    };

    /**
     * Wire up drag events on the hand band.
     */
    KeyboardChordsMixin._attachHandWidgetEvents = function (band, fretsArea) {
        if (!band || !fretsArea) return;

        band.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX      = e.clientX;
            const startAnchor = this.handAnchorFret;
            const maxFrets    = this._cachedMaxFrets || 22;

            const onMove = (mv) => {
                const dx        = mv.clientX - startX;
                const areaW     = fretsArea.clientWidth || 1;
                const fretDelta = Math.round(dx / (areaW / maxFrets));
                const newAnchor = Math.max(0, Math.min(
                    this._maxHandAnchorFret(),
                    startAnchor + fretDelta
                ));
                if (newAnchor !== this.handAnchorFret) {
                    this.handAnchorFret = newAnchor;
                    this._updateHandWidgetPosition();
                    this._sendHandPositionCC(newAnchor);
                }
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Touch support
        band.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const startX      = e.touches[0].clientX;
            const startAnchor = this.handAnchorFret;
            const maxFrets    = this._cachedMaxFrets || 22;

            const onMove = (mv) => {
                const dx        = mv.touches[0].clientX - startX;
                const areaW     = fretsArea.clientWidth || 1;
                const fretDelta = Math.round(dx / (areaW / maxFrets));
                const newAnchor = Math.max(0, Math.min(
                    this._maxHandAnchorFret(),
                    startAnchor + fretDelta
                ));
                if (newAnchor !== this.handAnchorFret) {
                    this.handAnchorFret = newAnchor;
                    this._updateHandWidgetPosition();
                    this._sendHandPositionCC(newAnchor);
                }
            };

            const onEnd = () => {
                band.removeEventListener('touchmove', onMove);
                band.removeEventListener('touchend', onEnd);
            };

            band.addEventListener('touchmove', onMove, { passive: false });
            band.addEventListener('touchend', onEnd);
        }, { passive: false });
    };

    /**
     * Send CC for the hand anchor fret position.
     */
    KeyboardChordsMixin._sendHandPositionCC = function (anchorFret) {
        if (!this.selectedDevice || !this.backend) return;
        const cfg = this.stringInstrumentConfig || {};
        if (cfg.cc_enabled === false) return;

        const ccFretNumber = cfg.cc_fret_number !== undefined ? cfg.cc_fret_number : 21;
        const ccFretOffset = cfg.cc_fret_offset || 0;
        const ccFretMin    = cfg.cc_fret_min    !== undefined ? cfg.cc_fret_min    : 0;
        const ccFretMax    = cfg.cc_fret_max    !== undefined ? cfg.cc_fret_max    : 36;

        const val = Math.max(0, Math.min(127, Math.max(ccFretMin, Math.min(ccFretMax, anchorFret + ccFretOffset))));
        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

        if (this.selectedDevice.isVirtual) {
            this.logger && this.logger.info && this.logger.info(`[Hand] CC${ccFretNumber}=${val} (anchor fret ${anchorFret})`);
            return;
        }

        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId, channel, controller: ccFretNumber, value: val
        }).catch(err => this.logger && this.logger.error('[HandWidget] CC send failed:', err));
    };

    // ── Auto-move hand on out-of-range fret click ─────────────────────────────

    /**
     * If `fret` is outside the current hand window, recentre the hand and send CC.
     */
    KeyboardChordsMixin._maybeAutoMoveHand = function (fret) {
        if (fret <= 0) return;
        const anchor = this.handAnchorFret || 0;

        // Effective span in frets at the current anchor position.
        let span;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const anchorMm = this._scaleLengthMm * (1 - Math.pow(2, -anchor / 12));
            const endMm    = anchorMm + this._handSpanMm;
            if (endMm < this._scaleLengthMm) {
                span = -12 * Math.log2(1 - endMm / this._scaleLengthMm) - anchor;
            } else {
                span = (this._cachedMaxFrets || 22) - anchor;
            }
        } else {
            span = this._handSpanFrets || 4;
        }

        if (fret >= anchor && fret <= anchor + span - 1) return; // already in range
        const newAnchor = Math.max(0, Math.min(
            this._maxHandAnchorFret(),
            fret - Math.floor(span / 2)
        ));
        this.handAnchorFret = newAnchor;
        this._updateHandWidgetPosition();
        this._sendHandPositionCC(newAnchor);
    };

    if (typeof window !== 'undefined') window.KeyboardChordsMixin = KeyboardChordsMixin;
})();
