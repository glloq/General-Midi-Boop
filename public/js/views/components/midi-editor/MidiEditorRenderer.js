// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorRenderer.js
// Description: HTML rendering for the editor modal
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorRendererMixin = {};

    // ========================================================================
    // RENDU
    // ========================================================================

    /**
    * Générer les boutons de canal
    */
    MidiEditorRendererMixin.renderChannelButtons = function() {
        if (!this.channels || this.channels.length === 0) {
            return `<div class="channel-chips"><span>${this.t('midiEditor.noActiveChannel')}</span></div>`;
        }

        let html = '<div class="channel-chips">';

    // Chips pour chaque canal
        this.channels.forEach(ch => {
            const isActive = this.activeChannels.has(ch.channel);
            const isDisabled = this.channelDisabled.has(ch.channel);
            const color = this.channelColors[ch.channel % this.channelColors.length];
            const activeClass = isActive ? 'active' : '';
            const disabledClass = isDisabled ? 'channel-disabled' : '';
            const isPlayableHighlighted = this.channelPlayableHighlights?.has(ch.channel);
            const playableClass = isPlayableHighlighted ? 'playable-active' : '';

    // Inline styles for chip (full background color)
            const inlineStyles = `--chip-color: ${color};`;

    // DRUM button for channel 9
            const drumBtn = ch.channel === 9 ? `
                <button class="channel-drum-btn" data-channel="9"
                    title="${this.t('drumPattern.toggleEditor')}">DRUM</button>` : '';

    // TAB/WIND buttons
            let tabBtn = '';
            let windBtn = '';
            try {
                if (ch.channel !== 9) {
    // Determine effective GM program: use routed instrument's gm_program if available
                    const routedGm = this._routedGmPrograms.get(ch.channel);
                    const effectiveProgram = (this.channelRouting.has(ch.channel) && routedGm != null) ? routedGm : ch.program;
                    const showButtons = !this.channelRouting.has(ch.channel) || routedGm != null;

                    if (showButtons) {
                        if (typeof MidiEditorChannelPanel !== 'undefined' &&
                            MidiEditorChannelPanel.getStringInstrumentCategory(effectiveProgram) !== null) {
                            const ccEnabled = this._stringInstrumentCCEnabled?.get(ch.channel);
                            if (ccEnabled !== false) {
                                tabBtn = `<button class="channel-tab-btn" data-channel="${ch.channel}" data-color="${color}"
                                    title="${this.t('tablature.tabButton', { instrument: ch.instrument || this.t('stringInstrument.string') })}">${this.t('midiEditor.tabButton')}</button>`;
                            }
                        }
                        if (typeof WindInstrumentDatabase !== 'undefined' && WindInstrumentDatabase.isWindInstrument(effectiveProgram)) {
                            const preset = WindInstrumentDatabase.getPresetByProgram(effectiveProgram);
                            windBtn = `<button class="channel-wind-btn" data-channel="${ch.channel}"
                                title="${this.t('windEditor.windEditorTitle', { name: preset?.name || this.t('windEditor.icon') })}">${this.t('midiEditor.windButton')}</button>`;
                        }
                    }
                }
            } catch { /* ignore — buttons will be added by _refreshStringInstrumentChannels */ }

    // GM instrument name (full, no forced truncation — CSS handles ellipsis)
            const gmLabelFull = (ch.hasExplicitProgram || ch.channel === 9) ? ch.instrument : '';
            const mainLabel = gmLabelFull
                ? `<span class="chip-number">${ch.channel + 1}</span><span class="chip-dot">·</span><span class="chip-instrument">${gmLabelFull}</span>`
                : `<span class="chip-number">${ch.channel + 1}</span>`;

    // Routed instrument line
            const routedName = this.getRoutedInstrumentName(ch.channel);
            const routedLine = routedName
                ? `<span class="chip-routing-line">→ ${routedName}</span>`
                : '';

    // Playable notes indicator (shown on chip when highlighted)
            const playableIndicator = isPlayableHighlighted
                ? `<span class="chip-playable-dot" style="background: ${color}" title="${this.t('midiEditor.showPlayableNotes')}"></span>`
                : '';

    // Settings gear button (always visible, compact)
            const settingsBtn = `<button class="chip-settings-btn" data-channel="${ch.channel}" title="${this.t('midiEditor.channelSettings')}">⚙</button>`;

    // EDIT button for channels without specialized editors
            const editBtn = (!drumBtn && !tabBtn && !windBtn) ? `
                <button class="channel-edit-btn" data-channel="${ch.channel}"
                    title="${this.t('midiEditor.editChannel')}">${this.t('midiEditor.editButton')}</button>` : '';

            html += `
                <div class="channel-chip-group">
                    <div class="channel-chip-row">
                        <button
                            class="channel-chip ${activeClass} ${disabledClass} ${playableClass}"
                            data-channel="${ch.channel}"
                            data-color="${color}"
                            style="${inlineStyles}"
                            title="${gmLabelFull ? `${ch.channel + 1}: ${gmLabelFull}` : `Ch ${ch.channel + 1}`} — ${this.t('midiEditor.notesChannel', { count: ch.noteCount, channel: ch.channel + 1 })}"
                        >
                            <span class="chip-content">
                                <span class="chip-main-line">${mainLabel}${playableIndicator}</span>
                                ${routedLine}
                            </span>
                        </button>
                        ${settingsBtn}
                    </div>
                    ${drumBtn}${tabBtn}${windBtn}${editBtn}
                </div>
            `;
        });

        html += '</div>';

        return html;
    }

    /**
    * Rendre les options du sélecteur de canal
    */
    MidiEditorRendererMixin.renderChannelOptions = function() {
        let options = '';
        for (let i = 0; i < 16; i++) {
            options += `<option value="${i}">Canal ${i + 1}${i === 9 ? ' (Drums)' : ''}</option>`;
        }
        return options;
    }

    /**
    * Rendre les options d'instruments MIDI GM
    */
    MidiEditorRendererMixin.renderInstrumentOptions = function() {
        let options = '';

    // Groupes d'instruments MIDI GM
        const groups = [
            { key: 'piano', start: 0, count: 8 },
            { key: 'chromaticPercussion', start: 8, count: 8 },
            { key: 'organ', start: 16, count: 8 },
            { key: 'guitar', start: 24, count: 8 },
            { key: 'bass', start: 32, count: 8 },
            { key: 'strings', start: 40, count: 8 },
            { key: 'ensemble', start: 48, count: 8 },
            { key: 'brass', start: 56, count: 8 },
            { key: 'reed', start: 64, count: 8 },
            { key: 'pipe', start: 72, count: 8 },
            { key: 'synthLead', start: 80, count: 8 },
            { key: 'synthPad', start: 88, count: 8 },
            { key: 'synthEffects', start: 96, count: 8 },
            { key: 'ethnic', start: 104, count: 8 },
            { key: 'percussive', start: 112, count: 8 },
            { key: 'soundEffects', start: 120, count: 8 }
        ];

        groups.forEach(group => {
            const categoryName = this.t(`instruments.categories.${group.key}`);
            options += `<optgroup label="${categoryName}">`;
            for (let i = 0; i < group.count; i++) {
                const program = group.start + i;
                const instrument = this.getInstrumentName(program);
                options += `<option value="${program}">${program}: ${instrument}</option>`;
            }
            options += `</optgroup>`;
        });

        return options;
    }

    /**
    * Mettre à jour le sélecteur d'instrument selon les canaux actifs
    */
    MidiEditorRendererMixin.updateInstrumentSelector = function() {
        const instrumentSelector = document.getElementById('instrument-selector');
        const instrumentLabel = document.getElementById('instrument-label');
        const applyBtn = document.getElementById('apply-instrument-btn');

        if (!instrumentSelector) return;

        if (this.activeChannels.size === 0) {
    // Aucun canal actif : afficher "Instrument:" et désactiver
            if (instrumentLabel) instrumentLabel.textContent = this.t('midiEditor.instrument');
            if (applyBtn) applyBtn.disabled = true;
        } else if (this.activeChannels.size === 1) {
    // Un seul canal actif : on peut modifier son instrument
            const activeChannel = Array.from(this.activeChannels)[0];
            const channelInfo = this.channels.find(ch => ch.channel === activeChannel);

            if (channelInfo) {
    // Mettre à jour le label pour indiquer quel canal sera modifié
                if (instrumentLabel) {
                    instrumentLabel.textContent = `${this.t('midiEditor.instrument')} ${this.t('midiEditor.channelTip', { channel: activeChannel + 1 })}`;
                    instrumentLabel.title = '';
                }

    // Mettre à jour le sélecteur pour afficher l'instrument actuel
                instrumentSelector.value = channelInfo.program.toString();

    // Activer le bouton
                if (applyBtn) {
                    applyBtn.disabled = false;
                    applyBtn.title = this.t('midiEditor.applyInstrument');
                }
            }
        } else {
    // Plusieurs canaux actifs : désactiver le bouton et afficher un message clair
            const firstActiveChannel = Array.from(this.activeChannels)[0];
            const channelInfo = this.channels.find(ch => ch.channel === firstActiveChannel);

            if (instrumentLabel) {
                instrumentLabel.textContent = this.t('midiEditor.multipleChannels', { count: this.activeChannels.size });
                instrumentLabel.title = this.t('midiEditor.multipleChannelsTip');
            }

    // Afficher l'instrument du premier canal actif
            if (channelInfo) {
                instrumentSelector.value = channelInfo.program.toString();
            }

    // Désactiver le bouton car plusieurs canaux actifs
            if (applyBtn) {
                applyBtn.disabled = true;
                applyBtn.title = this.t('midiEditor.singleChannelRequired');
            }
        }
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorRendererMixin = MidiEditorRendererMixin;
    }
})();
