// ============================================================================
// File: public/js/features/midi-editor/MidiEditorRenderer.js
// Description: Channel button + instrument selector rendering for the editor.
//   Sub-component class ; called via `modal.renderer.<method>(...)`.
//   (P2-F.10e body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorRenderer {
        constructor(modal) {
            this.modal = modal;
        }

    renderChannelButtons() {
        if (!this.modal.channels || this.modal.channels.length === 0) {
            return `<div class="channel-chips"><span>${this.modal.t('midiEditor.noActiveChannel')}</span></div>`;
        }

        let html = '<div class="channel-chips">';

    // Chips pour chaque canal
        this.modal.channels.forEach(ch => {
            const isActive = this.modal.activeChannels.has(ch.channel);
            const isDisabled = this.modal.channelDisabled.has(ch.channel);
            const color = this.modal.channelColors[ch.channel % this.modal.channelColors.length];
            const activeClass = isActive ? 'active' : '';
            const disabledClass = isDisabled ? 'channel-disabled' : '';
            const isPlayableHighlighted = this.modal.channelPlayableHighlights?.has(ch.channel);
            const playableClass = isPlayableHighlighted ? 'playable-active' : '';

    // Inline styles for chip (full background color)
            const inlineStyles = `--chip-color: ${color};`;

    // DRUM button for channel 9
            const drumBtn = ch.channel === 9 ? `
                <button class="channel-drum-btn" data-channel="9"
                    title="${this.modal.t('drumPattern.toggleEditor')}">DRUM</button>` : '';

    // TAB/WIND buttons
            let tabBtn = '';
            let windBtn = '';
            try {
                if (ch.channel !== 9) {
    // Determine effective GM program: use routed instrument's gm_program if available
                    const routedGm = this.modal._routedGmPrograms.get(ch.channel);
                    const effectiveProgram = (this.modal.channelRouting.has(ch.channel) && routedGm != null) ? routedGm : ch.program;
                    const showButtons = !this.modal.channelRouting.has(ch.channel) || routedGm != null;

                    if (showButtons) {
                        if (typeof MidiEditorChannelPanel !== 'undefined' &&
                            MidiEditorChannelPanel.getStringInstrumentCategory(effectiveProgram) !== null) {
                            const ccEnabled = this.modal._stringInstrumentCCEnabled?.get(ch.channel);
                            if (ccEnabled !== false) {
                                tabBtn = `<button class="channel-tab-btn" data-channel="${ch.channel}" data-color="${color}"
                                    title="${this.modal.t('tablature.tabButton', { instrument: ch.instrument || this.modal.t('stringInstrument.string') })}">${this.modal.t('midiEditor.tabButton')}</button>`;
                            }
                        }
                        if (typeof WindInstrumentDatabase !== 'undefined' && WindInstrumentDatabase.isWindInstrument(effectiveProgram)) {
                            const preset = WindInstrumentDatabase.getPresetByProgram(effectiveProgram);
                            windBtn = `<button class="channel-wind-btn" data-channel="${ch.channel}"
                                title="${this.modal.t('windEditor.windEditorTitle', { name: preset?.name || this.modal.t('windEditor.icon') })}">${this.modal.t('midiEditor.windButton')}</button>`;
                        }
                    }
                }
            } catch { /* ignore — buttons will be added by _refreshStringInstrumentChannels */ }

    // GM instrument name (full, no forced truncation — CSS handles ellipsis)
            const gmLabelFull = (ch.hasExplicitProgram || ch.channel === 9) ? ch.instrument : '';
            const mainLabel = gmLabelFull
                ? `<span class="chip-number">${ch.channel + 1}</span><span class="chip-dot">·</span><span class="chip-instrument">${gmLabelFull}</span>`
                : `<span class="chip-number">${ch.channel + 1}</span>`;

    // Routed instrument line — detect split routing
            const isSplit = this.modal._splitChannelNames && this.modal._splitChannelNames.has(ch.channel);
            const splitNames = isSplit ? this.modal._splitChannelNames.get(ch.channel) : null;
            const routedName = this.modal.tablatureOps?.getRoutedInstrumentName(ch.channel) ?? null;
            let routedLine;
            if (isSplit && splitNames && splitNames.length > 1) {
                routedLine = `<span class="chip-routing-line chip-split-line">🔀 ${splitNames.join(' + ')}</span>`;
            } else if (routedName) {
                routedLine = `<span class="chip-routing-line">→ ${routedName}</span>`;
            } else {
                routedLine = '';
            }

    // Playable notes indicator (shown on chip when highlighted)
            const playableIndicator = isPlayableHighlighted
                ? `<span class="chip-playable-dot" style="background: ${color}" title="${this.modal.t('midiEditor.showPlayableNotes')}"></span>`
                : '';

    // Settings gear button (always visible, compact)
            const settingsBtn = `<button class="chip-settings-btn" data-channel="${ch.channel}" title="${this.modal.t('midiEditor.channelSettings')}">⚙</button>`;

    // EDIT button for channels without specialized editors
            const editBtn = (!drumBtn && !tabBtn && !windBtn) ? `
                <button class="channel-edit-btn" data-channel="${ch.channel}"
                    title="${this.modal.t('midiEditor.editChannel')}">${this.modal.t('midiEditor.editButton')}</button>` : '';

            html += `
                <div class="channel-chip-group">
                    <div class="channel-chip-row">
                        <button
                            class="channel-chip ${activeClass} ${disabledClass} ${playableClass}"
                            data-channel="${ch.channel}"
                            data-color="${color}"
                            style="${inlineStyles}"
                            title="${gmLabelFull ? `${ch.channel + 1}: ${gmLabelFull}` : `Ch ${ch.channel + 1}`} — ${this.modal.t('midiEditor.notesChannel', { count: ch.noteCount, channel: ch.channel + 1 })}"
                        >
                            <span class="chip-content">
                                <span class="chip-main-line">${mainLabel}${isSplit ? '<span class="chip-split-badge" title="Split routing">split</span>' : ''}${playableIndicator}</span>
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

    renderChannelOptions() {
        let options = '';
        for (let i = 0; i < 16; i++) {
            options += `<option value="${i}">Canal ${i + 1}${i === 9 ? ' (Drums)' : ''}</option>`;
        }
        return options;
    }

    renderInstrumentOptions() {
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
            const categoryName = this.modal.t(`instruments.categories.${group.key}`);
            options += `<optgroup label="${categoryName}">`;
            for (let i = 0; i < group.count; i++) {
                const program = group.start + i;
                const instrument = this.modal.getInstrumentName(program);
                options += `<option value="${program}">${program}: ${instrument}</option>`;
            }
            options += `</optgroup>`;
        });

        return options;
    }

    updateInstrumentSelector() {
        const instrumentSelector = document.getElementById('instrument-selector');
        const instrumentLabel = document.getElementById('instrument-label');
        const applyBtn = document.getElementById('apply-instrument-btn');

        if (!instrumentSelector) return;

        if (this.modal.activeChannels.size === 0) {
    // No active channel: display "Instrument:" and disable
            if (instrumentLabel) instrumentLabel.textContent = this.modal.t('midiEditor.instrument');
            if (applyBtn) applyBtn.disabled = true;
        } else if (this.modal.activeChannels.size === 1) {
    // Un seul canal actif : on peut modifier son instrument
            const activeChannel = Array.from(this.modal.activeChannels)[0];
            const channelInfo = this.modal.channels.find(ch => ch.channel === activeChannel);

            if (channelInfo) {
    // Update the label to indicate which channel will be changed
                if (instrumentLabel) {
                    instrumentLabel.textContent = `${this.modal.t('midiEditor.instrument')} ${this.modal.t('midiEditor.channelTip', { channel: activeChannel + 1 })}`;
                    instrumentLabel.title = '';
                }

    // Update the selector to show the current program
                instrumentSelector.value = channelInfo.program.toString();

    // Activer le bouton
                if (applyBtn) {
                    applyBtn.disabled = false;
                    applyBtn.title = this.modal.t('midiEditor.applyInstrument');
                }
            }
        } else {
    // Multiple active channels: disable the button and show a clear message
            const firstActiveChannel = Array.from(this.modal.activeChannels)[0];
            const channelInfo = this.modal.channels.find(ch => ch.channel === firstActiveChannel);

            if (instrumentLabel) {
                instrumentLabel.textContent = this.modal.t('midiEditor.multipleChannels', { count: this.modal.activeChannels.size });
                instrumentLabel.title = this.modal.t('midiEditor.multipleChannelsTip');
            }

    // Afficher l'instrument du premier canal actif
            if (channelInfo) {
                instrumentSelector.value = channelInfo.program.toString();
            }

    // Disable the button because multiple channels are active
            if (applyBtn) {
                applyBtn.disabled = true;
                applyBtn.title = this.modal.t('midiEditor.singleChannelRequired');
            }
        }
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorRenderer = MidiEditorRenderer;
    }
})();
