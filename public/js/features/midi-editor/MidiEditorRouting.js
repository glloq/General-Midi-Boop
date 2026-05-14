// ============================================================================
// File: public/js/features/midi-editor/MidiEditorRouting.js
// Description: Routing, connected devices, preview source, piano-roll boot.
//   Sub-component class ; called via `modal.routingOps.<method>(...)`.
//   (P2-F.10g body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorRouting {
        constructor(modal) {
            this.modal = modal;
            this.playableNotes = typeof MidiEditorPlayableNotes !== 'undefined'
                ? new MidiEditorPlayableNotes(this)
                : null;
        }

    async loadConnectedDevices() {
        try {
            const result = await this.modal.api.sendCommand('device_list');
            if (result && result.devices) {
    // Keep only devices that expose an output (output: true)
                const outputDevices = result.devices.filter(d => d.output === true);

    // Flatten multi-instrument devices into individual entries
                const expandedDevices = [];
                for (const device of outputDevices) {
                    if (device.instruments && device.instruments.length > 1) {
                        for (const inst of device.instruments) {
                            expandedDevices.push({
                                ...device,
                                _channel: inst.channel !== undefined ? inst.channel : 0,
                                _multiInstrument: true,
                                displayName: inst.custom_name || inst.name || device.displayName || device.name
                            });
                        }
                    } else {
                        expandedDevices.push(device);
                    }
                }
                this.modal.connectedDevices = expandedDevices;
                this.modal.log('info', `Loaded ${outputDevices.length} connected output devices (${expandedDevices.length} instruments)`);
            }
        } catch (error) {
            this.modal.log('error', 'Failed to load connected devices:', error);
            this.modal.connectedDevices = [];
        }
    }

    updateChannelButtons() {
        const chips = this.modal.container?.querySelectorAll('.channel-chip');
        if (!chips) return;

        const specializedActive = this.modal.editActions?._isSpecializedEditorActive();

        chips.forEach(chip => {
            const channel = parseInt(chip.dataset.channel);
            const color = chip.dataset.color;
            const isActive = this.modal.activeChannels.has(channel);

            if (isActive) {
                chip.classList.add('active');
                chip.style.cssText = `--chip-color: ${color}; --chip-bg: ${color}20; --chip-border: ${color}cc;`;
            } else {
                chip.classList.remove('active');
                chip.style.cssText = `--chip-color: ${color}; --chip-bg: transparent; --chip-border: ${color}4d;`;
            }

    // When a specialized editor is active, grey out non-active channel chips
            if (specializedActive && !isActive) {
                chip.classList.add('channel-locked');
            } else {
                chip.classList.remove('channel-locked');
            }

    // Update playable notes indicator
            const isPlayableHighlighted = this.modal.channelPlayableHighlights?.has(channel);
            chip.classList.toggle('playable-active', !!isPlayableHighlighted);
        });

    // Also update gear button border colors to match chip
        const gears = this.modal.container?.querySelectorAll('.chip-settings-btn');
        if (gears) {
            gears.forEach(gear => {
                const channel = parseInt(gear.dataset.channel);
                const chip = this.modal.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
                if (chip) {
                    gear.style.setProperty('--chip-border', chip.style.getPropertyValue('--chip-border'));
                }
            });
        }

    // "Show All" stays enabled even during specialized editing — it closes
    // the specialized editor and restores the full channel view.
        const showAllBtn = this.modal.container?.querySelector('.btn-show-all-channels');
        if (showAllBtn) {
            showAllBtn.disabled = false;
            showAllBtn.classList.remove('channel-locked');
        }

    // Update the note counter
        this.updateStats();
    }

    render() {
        const loop = this.modal.loopMode === true;

    // Create the modal container — in loop/panel mode we render directly
    // inside the host element (no modal-overlay wrapper), so the outer
    // LoopEditorModal owns the framing chrome.
        this.modal.container = document.createElement('div');
        this.modal.container.className = loop
            ? 'midi-editor-modal midi-editor-modal--loop'
            : 'modal-overlay midi-editor-modal';
        const headerHtml = loop ? '' : `
                <div class="modal-header">
                    <div class="modal-title">
                        <h3>🎹 ÉDIB∞P</h3>
                        <span class="title-separator">—</span>
                        <span class="file-name" id="editor-file-name">${escapeHtml(this.modal.currentFilename || this.modal.currentFile || '')}</span>
                        <button class="btn-rename-file" data-action="rename-file" title="${this.modal.t('midiEditor.renameFile')}">✏️</button>
                    </div>
                    <div class="tempo-control">
                        <span class="tempo-label">♩</span>
                        <input type="number" id="tempo-input" class="tempo-input" min="20" max="300" step="1" value="${this.modal.tempo || 120}" title="${this.modal.t('midiEditor.tempoTip')}">
                        <span class="tempo-unit">BPM</span>
                    </div>
                    <div class="header-right-actions">
                        <button class="header-info-btn" data-action="show-info" title="Informations du fichier">
                            📝
                        </button>
                        <button class="header-save-btn" data-action="save" id="save-btn" title="${this.modal.t('midiEditor.save')}">
                            💾 ${this.modal.t('midiEditor.save')}
                        </button>
                        <button class="header-save-as-btn" data-action="save-as" id="save-as-btn" title="${this.modal.t('midiEditor.saveAs')}">
                            📄 ${this.modal.t('midiEditor.saveAs')}
                        </button>
                        <button class="header-auto-assign-btn" data-action="auto-assign" title="${this.modal.t('autoAssign.title')}">
                            🎯 ${this.modal.t('midiEditor.autoAssign')}
                        </button>
                    </div>
                    <button class="modal-close" data-action="close">&times;</button>
                </div>`;

        const channelsToolbarHtml = loop ? '' : `
                    <!-- Channel toolbar (just below the header) -->
                    <div class="channels-toolbar-wrapper">
                        <div class="channels-toolbar">
                            ${this.modal.renderer.renderChannelButtons()}
                        </div>
                        <div class="channel-global-actions">
                            <button class="btn-show-all-channels" title="${this.modal.t('midiEditor.showAllChannels')}">👁️</button>
                        </div>
                    </div>`;

        // In loop mode the LoopEditorModal owns play/pause/stop in its big
        // transport bar — we hide the toolbar playback section to avoid
        // duplicated controls (and the routed/GM preview toggle, which
        // doesn't apply when the loop is single-instrument).
        const playbackSectionHtml = loop ? '' : `
                        <!-- Section Playback -->
                        <div class="toolbar-section playback-section">
                            <button class="tool-btn playback-btn" data-action="playback-play" id="play-btn" title="${this.modal.t('midiEditor.play')} (Space)">
                                <span class="icon play-icon">▶</span>
                            </button>
                            <button class="tool-btn playback-btn" data-action="playback-pause" id="pause-btn" title="${this.modal.t('midiEditor.pause')}" style="display: none;">
                                <span class="icon pause-icon">⏸</span>
                            </button>
                            <button class="tool-btn playback-btn" data-action="playback-stop" id="stop-btn" title="${this.modal.t('midiEditor.stop')}" disabled>
                                <span class="icon stop-icon">⏹</span>
                            </button>
                            <button class="tool-btn-compact preview-source-toggle" id="preview-source-toggle"
                                data-source="gm"
                                title="${this.modal.t('midiEditor.previewSourceHint')}">
                                🔊 GM
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>
        `;

        // Settings popover (gear) — entirely removed in loop mode. The
        // outer LoopEditorModal already exposes instrument/output choices
        // and channel routing is irrelevant for a mono-channel loop.
        const settingsPopoverHtml = loop ? '' : `
                        <div class="toolbar-divider"></div>

                        <!-- Settings button (opens Channel / Instrument / Device popover) -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="toggle-settings-popover" id="settings-popover-btn" title="${this.modal.t('midiEditor.settingsPopover')}">
                                <span class="icon">⚙️</span>
                            </button>
                        </div>

                        <!-- Settings popover (Channel, Instrument, connected Device) -->
                        <div class="settings-popover" id="settings-popover" style="display: none;">
                            <div class="settings-popover-header">
                                <span class="settings-popover-title">⚙️ ${this.modal.t('midiEditor.settingsPopoverTitle')}</span>
                            </div>

                            <div class="settings-group" data-group="actions">
                                <div class="settings-group-header">${this.modal.t('midiEditor.settingsGroupActions')}</div>
                                <div class="settings-popover-section">
                                    <label class="settings-label">🔀 ${this.modal.t('midiEditor.moveToChannelTitle')}</label>
                                    <span class="settings-popover-hint">${this.modal.t('midiEditor.moveToChannelHint')}</span>
                                    <div class="settings-row">
                                        <select class="snap-select" id="channel-selector" title="${this.modal.t('midiEditor.changeChannelTip')}">
                                            ${this.modal.renderer.renderChannelOptions()}
                                        </select>
                                        <button class="tool-btn-apply" data-action="change-channel" id="change-channel-btn" title="${this.modal.t('midiEditor.applyChannel')}" disabled>${this.modal.t('midiEditor.applyBtn')}</button>
                                    </div>
                                </div>
                                <div class="settings-popover-section">
                                    <label class="settings-label" id="instrument-label">🎵 ${this.modal.t('midiEditor.changeInstrumentTitle')}</label>
                                    <span class="settings-popover-hint">${this.modal.t('midiEditor.changeInstrumentHint')}</span>
                                    <div class="settings-row">
                                        <select class="snap-select" id="instrument-selector" title="${this.modal.t('midiEditor.selectInstrument')}">
                                            ${this.modal.renderer.renderInstrumentOptions()}
                                        </select>
                                        <button class="tool-btn-apply" data-action="apply-instrument" id="apply-instrument-btn" title="${this.modal.t('midiEditor.applyInstrument')}">${this.modal.t('midiEditor.applyBtn')}</button>
                                    </div>
                                </div>
                            </div>

                            <div class="settings-group" data-group="display">
                                <div class="settings-group-header">${this.modal.t('midiEditor.settingsGroupDisplay')}</div>
                                <div class="settings-switch-row" title="${this.modal.t('midiEditor.playableNotesHint')}">
                                    <div class="settings-switch-info">
                                        <span class="settings-switch-label">🎹 ${this.modal.t('midiEditor.playableNotesTitle')}</span>
                                    </div>
                                    <button class="settings-switch playable-notes-toggle" id="playable-notes-toggle"
                                        data-active="false"
                                        aria-label="${this.modal.t('midiEditor.playableNotesTitle')}"
                                        title="${this.modal.t('midiEditor.playableNotesHint')}">
                                        <span class="sr-only">OFF</span>
                                    </button>
                                </div>
                            </div>

                            <div class="settings-group" data-group="interface">
                                <div class="settings-group-header">${this.modal.t('midiEditor.settingsGroupInterface')}</div>
                                <div class="settings-switch-row" title="${this.modal.t('midiEditor.touchModeHint')}">
                                    <div class="settings-switch-info">
                                        <span class="settings-switch-label">👆 ${this.modal.t('midiEditor.touchModeTitle')}</span>
                                    </div>
                                    <button class="settings-switch touch-mode-toggle" id="touch-mode-toggle"
                                        data-active="${this.modal.touchMode ? 'true' : 'false'}"
                                        aria-label="${this.modal.t('midiEditor.touchModeTitle')}"
                                        title="${this.modal.t('midiEditor.touchModeHint')}">
                                        <span class="sr-only">${this.modal.touchMode ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            </div>

                            <div class="settings-group" data-group="playback">
                                <div class="settings-group-header">${this.modal.t('midiEditor.settingsGroupPlayback')}</div>
                                <div class="settings-switch-row" title="${this.modal.t('midiEditor.keyboardPlaybackHint')}">
                                    <div class="settings-switch-info">
                                        <span class="settings-switch-label">🎹 ${this.modal.t('midiEditor.keyboardPlaybackTitle')}</span>
                                    </div>
                                    <button class="settings-switch" id="keyboard-playback-toggle"
                                        data-active="${this.modal.keyboardPlaybackEnabled ? 'true' : 'false'}"
                                        aria-label="${this.modal.t('midiEditor.keyboardPlaybackTitle')}"
                                        title="${this.modal.t('midiEditor.keyboardPlaybackHint')}">
                                        <span class="sr-only">${this.modal.keyboardPlaybackEnabled ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                                <div class="settings-switch-row" title="${this.modal.t('midiEditor.dragPlaybackHint')}">
                                    <div class="settings-switch-info">
                                        <span class="settings-switch-label">🔊 ${this.modal.t('midiEditor.dragPlaybackTitle')}</span>
                                    </div>
                                    <button class="settings-switch" id="drag-playback-toggle"
                                        data-active="${this.modal.dragPlaybackEnabled ? 'true' : 'false'}"
                                        aria-label="${this.modal.t('midiEditor.dragPlaybackTitle')}"
                                        title="${this.modal.t('midiEditor.dragPlaybackHint')}">
                                        <span class="sr-only">${this.modal.dragPlaybackEnabled ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
        `;

        // Inline touch-mode toggle — only rendered in loop mode, where the
        // gear popover is gone and this becomes the only way to flip touch
        // UX. Standard mode keeps the existing toggle inside the popover.
        const inlineTouchToggleHtml = loop ? `
                            <button class="tool-btn touch-mode-inline-toggle" data-action="toggle-touch-mode" id="touch-mode-inline-toggle"
                                data-active="${this.modal.touchMode ? 'true' : 'false'}"
                                title="${this.modal.t('midiEditor.touchModeTitle')}"
                                aria-pressed="${this.modal.touchMode ? 'true' : 'false'}">
                                <span class="icon">👆</span>
                            </button>` : '';

        // Wrap the editor body. Outside loop mode we keep the historical
        // <div class="modal-dialog modal-xl"><…/></div> wrapper ; inside
        // loop mode we drop it so the panel inherits its host's flex
        // sizing.
        const bodyOpen  = loop ? '<div class="midi-editor-panel">' : '<div class="modal-dialog modal-xl">';
        const bodyClose = loop ? '</div>' : '</div>';

        this.modal.container.innerHTML = `
            ${bodyOpen}
                ${headerHtml}
                <div class="modal-body">
                    ${channelsToolbarHtml}

                    <!-- Edit toolbar (compact, icon-only buttons with tooltips) -->
                    <div class="editor-toolbar">
                        ${playbackSectionHtml}
                        <!-- Section Undo/Redo -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="undo" id="undo-btn" title="${this.modal.t('midiEditor.undo')} (Ctrl+Z)" disabled>
                                <span class="icon">↶</span>
                                <span class="btn-shortcut">Ctrl+Z</span>
                            </button>
                            <button class="tool-btn" data-action="redo" id="redo-btn" title="${this.modal.t('midiEditor.redo')} (Ctrl+Y)" disabled>
                                <span class="icon">↷</span>
                                <span class="btn-shortcut">Ctrl+Y</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Grille/Snap -->
                        <div class="toolbar-section">
                            <label class="snap-label">${this.modal.t('midiEditor.grid')}</label>
                            <button class="tool-btn-snap" data-action="cycle-snap" id="snap-btn" title="${this.modal.t('midiEditor.gridTip')}">
                                <span class="snap-value" id="snap-value">1/8</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Edit-modes section -->
                        <div class="toolbar-section edit-modes-section">
                            <button class="tool-btn active" data-action="mode-drag-view" data-mode="drag-view" title="${this.modal.t('midiEditor.viewModeTip')}">
                                <span class="icon">👁️</span>
                            </button>
                            <button class="tool-btn" data-action="mode-select" data-mode="select" title="${this.modal.t('midiEditor.selectModeTip')}">
                                <span class="icon">◻</span>
                            </button>
                            <!-- Unified Edit button (visible outside touch mode) -->
                            <button class="tool-btn edit-unified-btn${this.modal.touchMode ? ' hidden' : ''}" data-action="mode-edit" data-mode="edit" title="${this.modal.t('midiEditor.editModeTip')}">
                                <span class="icon">✏️</span>
                            </button>
                            <!-- Boutons tactiles (visibles en mode tactile uniquement) -->
                            <button class="tool-btn touch-edit-btn${this.modal.touchMode ? '' : ' hidden'}" data-action="mode-drag-notes" data-mode="drag-notes" title="${this.modal.t('midiEditor.moveNotesTip')}">
                                <span class="icon">✋</span>
                            </button>
                            <button class="tool-btn touch-edit-btn${this.modal.touchMode ? '' : ' hidden'}" data-action="mode-add-note" data-mode="add-note" title="${this.modal.t('midiEditor.addNoteTip')}">
                                <span class="icon">➕</span>
                            </button>
                            <button class="tool-btn touch-edit-btn${this.modal.touchMode ? '' : ' hidden'}" data-action="mode-resize-note" data-mode="resize-note" title="${this.modal.t('midiEditor.durationTip')}">
                                <span class="icon">↔</span>
                            </button>
                            ${inlineTouchToggleHtml}
                        </div>

                        <div class="toolbar-divider"></div>

                        ${loop ? `<!-- Specialized modes (drum / tab / wind) — loop mode only -->
                        <div class="toolbar-section specialized-mode-section" id="loop-specialized-modes"></div>
                        <div class="toolbar-divider"></div>` : ''}

                        <!-- Edit section (Copy / Paste / Delete) -->
                        <div class="toolbar-section">
                            <button class="tool-btn" data-action="copy" id="copy-btn" title="${this.modal.t('midiEditor.copy')} (Ctrl+C)" disabled>
                                <span class="icon">📋</span>
                                <span class="btn-shortcut">Ctrl+C</span>
                            </button>
                            <button class="tool-btn" data-action="paste" id="paste-btn" title="${this.modal.t('midiEditor.paste')} (Ctrl+V)" disabled>
                                <span class="icon">📄</span>
                                <span class="btn-shortcut">Ctrl+V</span>
                            </button>
                            <button class="tool-btn" data-action="delete" id="delete-btn" title="${this.modal.t('midiEditor.delete')} (Del)" disabled>
                                <span class="icon">🗑</span>
                                <span class="btn-shortcut">Suppr</span>
                            </button>
                            <button class="tool-btn" data-action="select-all" id="select-all-btn" title="${this.modal.t('midiEditor.selectAll', { defaultValue: 'Select All' })} (Ctrl+A)">
                                <span class="icon">▣</span>
                                <span class="btn-shortcut">Ctrl+A</span>
                            </button>
                        </div>

                        <div class="toolbar-divider"></div>

                        <!-- Section Zoom -->
                        <div class="toolbar-section">
                            <button class="tool-btn-compact" data-action="zoom-h-out" title="${this.modal.t('midiEditor.zoomHOut')}">H−</button>
                            <button class="tool-btn-compact" data-action="zoom-h-in" title="${this.modal.t('midiEditor.zoomHIn')}">H+</button>
                            <button class="tool-btn-compact" data-action="zoom-v-out" title="${this.modal.t('midiEditor.zoomVOut')}">V−</button>
                            <button class="tool-btn-compact" data-action="zoom-v-in" title="${this.modal.t('midiEditor.zoomVIn')}">V+</button>
                        </div>

                        ${settingsPopoverHtml}
                    </div>

                    <!-- Container for Notes and CC/Pitchbend -->
                    <div class="midi-editor-container">
                        <!-- Section Notes -->
                        <div class="midi-editor-section notes-section">
                            <!-- Navigation Overview Bar (loop mode uses LoopEditor's own minimap instead) -->
                            ${loop ? '' : '<div class="navigation-overview-wrap" id="navigation-overview-container"></div>'}
                            <!-- Playback Timeline Bar — kept in loop mode too : it doubles as a
                                 time ruler / scrub bar above the piano roll, very handy for
                                 navigating the view. The LoopEditor's own transport buttons
                                 keep driving play / stop ; this is just a viewport helper. -->
                            <div class="playback-timeline-wrap" id="playback-timeline-container"></div>
                            <div class="piano-roll-wrapper">
                                <div class="piano-roll-container" id="piano-roll-container">
                                    <!-- webaudio-pianoroll will be inserted here -->
                                </div>
                            </div>
                        </div>

                        <!-- Resize bar between notes and CC -->
                        <div class="cc-resize-bar" id="cc-resize-btn" title="${this.modal.t('midiEditor.dragToResize')}">
                            <span class="resize-grip">⋮⋮⋮</span>
                        </div>

                        <!-- Section CC/Pitchbend/Velocity (collapsible) -->
                        <div class="midi-editor-section cc-section collapsed" id="cc-section">
                            <!-- Collapsible header with channel selector -->
                            <div class="cc-section-header collapsed" id="cc-section-header">
                                <div class="cc-section-title">
                                    <span class="cc-collapse-icon">▼</span>
                                    <span>${this.modal.t('midiEditor.ccSection')}</span>
                                </div>
                                ${loop ? '' : `<div class="cc-header-channels" id="editor-channel-selector">
                                    <!-- Channels are added dynamically -->
                                </div>`}
                                <button class="cc-settings-btn" id="cc-draw-settings-btn" title="${this.modal.t('midiEditor.drawSettings')}">⚙</button>
                            </div>

                            <!-- CC/Velocity editor content -->
                            <div class="cc-section-content" id="cc-section-content">
                                <!-- Horizontal toolbar to pick the type (CC / PB / Velocity) -->
                                <div class="cc-type-toolbar">
                                    <label class="cc-toolbar-label">${this.modal.t('midiEditor.type')}</label>
                                    <div class="cc-type-buttons-horizontal">
                                        <!-- Groupe Performance -->
                                        <div class="cc-btn-group" data-group="perf">
                                            <span class="cc-group-label">${this.modal.t('midiEditor.groupPerf')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn active" data-cc-type="cc1" title="${this.modal.t('midiEditor.ccModulationWheel')}">CC1</button>
                                                <button class="cc-type-btn" data-cc-type="cc2" title="${this.modal.t('midiEditor.ccBreathController')}">CC2</button>
                                                <button class="cc-type-btn" data-cc-type="cc11" title="${this.modal.t('midiEditor.ccExpressionController')}">CC11</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Vibrato -->
                                        <div class="cc-btn-group" data-group="vib">
                                            <span class="cc-group-label">${this.modal.t('midiEditor.groupVib')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc76" title="${this.modal.t('midiEditor.ccVibratoRate')}">CC76</button>
                                                <button class="cc-type-btn" data-cc-type="cc77" title="${this.modal.t('midiEditor.ccVibratoDepth')}">CC77</button>
                                                <button class="cc-type-btn" data-cc-type="cc78" title="${this.modal.t('midiEditor.ccVibratoDelay')}">CC78</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Mix -->
                                        <div class="cc-btn-group" data-group="mix">
                                            <span class="cc-group-label">${this.modal.t('midiEditor.groupMix')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc7" title="${this.modal.t('midiEditor.ccChannelVolume')}">CC7</button>
                                                <button class="cc-type-btn" data-cc-type="cc10" title="${this.modal.t('midiEditor.ccPanPosition')}">CC10</button>
                                                <button class="cc-type-btn" data-cc-type="cc91" title="${this.modal.t('midiEditor.ccReverbSend')}">CC91</button>
                                            </div>
                                        </div>
                                        <!-- Groupe Tone -->
                                        <div class="cc-btn-group" data-group="tone">
                                            <span class="cc-group-label">${this.modal.t('midiEditor.groupTone')}</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn" data-cc-type="cc74" title="${this.modal.t('midiEditor.ccBrightnessCutoff')}">CC74</button>
                                                <button class="cc-type-btn" data-cc-type="cc5" title="${this.modal.t('midiEditor.ccPortamentoTime')}">CC5</button>
                                            </div>
                                        </div>
                                        <!-- Dynamic group (detected non-static CCs) -->
                                        <div class="cc-btn-group cc-dynamic-group" data-group="other" style="display:none;">
                                            <span class="cc-group-label">+</span>
                                            <div class="cc-btn-group-buttons" id="cc-dynamic-buttons"></div>
                                        </div>
                                        <!-- "+" button to add a CC from the list -->
                                        <div class="cc-btn-group" data-group="custom">
                                            <span class="cc-group-label">&nbsp;</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn cc-add-btn" id="cc-add-btn" title="${this.modal.t('midiEditor.addCC')}">+</button>
                                            </div>
                                        </div>

                                        <div class="cc-toolbar-divider"></div>

                                        <!-- Boutons standalone -->
                                        <div class="cc-standalone-buttons">
                                            <button class="cc-type-btn cc-standalone-btn" data-cc-type="pitchbend" title="${this.modal.t('midiEditor.ccPitchWheel')}">PB</button>
                                            <button class="cc-type-btn cc-standalone-btn" data-cc-type="aftertouch" title="${this.modal.t('midiEditor.ccAftertouch')}">AT</button>
                                            <button class="cc-type-btn cc-standalone-btn" data-cc-type="polyAftertouch" title="${this.modal.t('midiEditor.ccPolyAftertouch')}">PolyAT</button>
                                            <button class="cc-type-btn cc-standalone-btn" data-cc-type="velocity" title="${this.modal.t('midiEditor.ccNoteVelocity')}">VEL</button>
                                            <button class="cc-type-btn cc-standalone-btn cc-tempo-btn" data-cc-type="tempo" title="${this.modal.t('midiEditor.ccTempoAutomation')}">🕐 BPM</button>
                                        </div>
                                    </div>

                                    <div class="cc-toolbar-divider"></div>

                                    <label class="cc-toolbar-label">${this.modal.t('midiEditor.tools')}</label>
                                    <div class="cc-tool-buttons-horizontal">
                                        <button class="cc-tool-btn" data-tool="line" title="${this.modal.t('midiEditor.lineTool')}">╱</button>
                                        <button class="cc-tool-btn" data-tool="draw" title="${this.modal.t('midiEditor.drawTool')}">✎</button>
                                    </div>

                                    <div class="cc-toolbar-divider"></div>

                                    <button class="cc-delete-btn" id="cc-delete-btn" title="${this.modal.t('midiEditor.deleteSelection')}" disabled>
                                        🗑️
                                    </button>

                                </div>

                                <!-- Editor layout (full height, no sidebar) -->
                                <div class="cc-editor-layout">
                                    <!-- Container for the editors (CC, Velocity or Tempo) -->
                                    <div id="cc-editor-container" class="cc-editor-main"></div>
                                    <div id="velocity-editor-container" class="cc-editor-main" style="display: none;"></div>
                                    <div id="tempo-editor-container" class="cc-editor-main" style="display: none;"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            ${bodyClose}
        `;

        // Mount: append to the configured host (panel mode) or to body
        // (standalone overlay mode). The host attribute lets the loop
        // editor drop the editor straight into its tab pane.
        const mountTarget = this.modal.panelHost || document.body;
        mountTarget.appendChild(this.modal.container);

    // Attach events
        this.modal.events.attachEvents();

    // Keyboard shortcuts (includes Escape → close)
        this.modal.editActions?.setupKeyboardShortcuts();
    }

    /**
     * Sync the webaudio-pianoroll's pixel size to its container. The
     * custom element only reads its `width` / `height` attributes once,
     * at connectedCallback time (via getAttr inside defineprop), so
     * `setAttribute` after mount does NOT re-run the `layout()` observer.
     * We must assign the JS properties — the setter pipes through to
     * `layout()` and resizes both the underlying canvas and its CSS box.
     */
    _refreshPianoRollSize() {
        const renderer = this.modal.pianoRollRenderer;
        if (!renderer?.isMounted()) return false;
        const container = this.modal.container?.querySelector('#piano-roll-container');
        if (!container) return false;
        const w = container.clientWidth  || 0;
        const h = container.clientHeight || 0;
        if (w <= 0 || h <= 0) return false;
        renderer.setSize(w, h);
        return true;
    }

    /**
     * Render DRUM / TAB / WIND mode buttons in the loop panel's toolbar
     * based on the current channel's GM program. Drum & wind families
     * are detected from the program range ; TAB is only offered when a
     * string-instrument config already exists in DB for the active
     * device (the loop editor itself never creates one).
     *
     * Re-render on every change of program / channel / device.
     */
    async _updateLoopSpecializedModeButtons() {
        if (!this.modal.loopMode) return;
        const host = this.modal.container?.querySelector('#loop-specialized-modes');
        if (!host) return;
        const ch = this.modal.channels?.[0];
        if (!ch) { host.innerHTML = ''; return; }
        const program = ch.program ?? 0;
        const channel = ch.channel ?? 0;
        const isDrum  = channel === 9;
        const windCat = (typeof MidiEditorChannelPanel !== 'undefined')
            ? MidiEditorChannelPanel.getWindInstrumentCategory(program) : null;
        const stringCat = (typeof MidiEditorChannelPanel !== 'undefined')
            ? MidiEditorChannelPanel.getStringInstrumentCategory(program) : null;

        // String instruments only get a TAB button when a config exists
        // for the active device — checked via `string_instrument_list`.
        let hasStringConfig = false;
        if (stringCat) {
            try {
                const deviceId = this.modal.tablatureOps?.getEffectiveDeviceId?.();
                const resp = await this.modal.api.sendCommand('string_instrument_list', { device_id: deviceId });
                if (resp?.instruments?.length) hasStringConfig = true;
            } catch { /* backend offline → no TAB */ }
        }

        const buttons = [];
        if (isDrum) {
            buttons.push(`<button class="tool-btn channel-drum-btn" data-channel="${channel}"
                title="${this.modal.t('drumPattern.toggleEditor')}">
                <span class="icon">🥁</span></button>`);
        }
        if (windCat) {
            buttons.push(`<button class="tool-btn channel-wind-btn" data-channel="${channel}"
                title="${this.modal.t('windEditor.icon')}">
                <span class="icon">🎺</span></button>`);
        }
        if (hasStringConfig) {
            buttons.push(`<button class="tool-btn channel-tab-btn" data-channel="${channel}" data-color="#0aa"
                title="${this.modal.t('midiEditor.tabButton')}">
                <span class="icon">🎸</span></button>`);
        }
        host.innerHTML = buttons.join('');
    }

    async initPianoRoll() {
        const container = document.getElementById('piano-roll-container');
        if (!container) {
            this.modal.log('error', 'Piano roll container not found');
            return;
        }

    // Ensure webaudio-pianoroll is loaded
        if (typeof customElements.get('webaudio-pianoroll') === 'undefined') {
            this.modal.showError(this.modal.t('midiEditor.libraryNotLoaded'));
            return;
        }

    // Piano roll renderer abstraction (audit §1.1). Choose the
    // implementation based on a feature flag:
    //   - Default : WebaudioPianorollAdapter (the legacy third-party
    //     custom element, behaviour identical to pre-§1.1).
    //   - Opt-in via `?pianoRollV2=1` URL param or
    //     `localStorage.gmboop_piano_roll_v2 = '1'` :
    //     CanvasPianoRollRenderer (audit §3.1/§3.2 — Canvas 2D maison,
    //     viewport culling, grid-bucket spatial index).
    // The invariant `modal.pianoRoll === modal.pianoRollRenderer.getElement()`
    // is maintained so non-migrated call sites keep working unchanged.
        const useV2 = (() => {
            try {
                const qs = new URLSearchParams(window.location.search);
                if (qs.get('pianoRollV2') === '1') return true;
                if (localStorage.getItem('gmboop_piano_roll_v2') === '1') return true;
            } catch (_) { /* best-effort */ }
            return false;
        })();
        const Impl = (useV2 && typeof CanvasPianoRollRenderer !== 'undefined')
            ? CanvasPianoRollRenderer
            : (typeof WebaudioPianorollAdapter !== 'undefined' ? WebaudioPianorollAdapter : null);

        if (Impl) {
            this.modal.pianoRollRenderer = new Impl({
                container,
                width:  container.clientWidth  || 1000,
                height: container.clientHeight || 400,
                ppq:    this.modal.ticksPerBeat || 480,
                tempo:  this.modal.tempo || 120,
                mode:   'dragpoly'
            });
            this.modal.pianoRollRenderer.mount();
            this.modal.pianoRoll = this.modal.pianoRollRenderer.getElement();
            this.modal.log('info', `Piano roll renderer: ${Impl.name}`);
        } else {
            // Defensive fallback if neither renderer script loaded —
            // restores the legacy creation path so the editor still opens.
            this.modal.pianoRoll = document.createElement('webaudio-pianoroll');
            this.modal.pianoRollRenderer = null;
        }

    // Configuration
        const width = container.clientWidth || 1000;
        const height = container.clientHeight || 400;

    // Compute the tick range from the sequence
        let maxTick = 0;
        let minNote = 127;
        let maxNote = 0;

        if (this.modal.sequence && this.modal.sequence.length > 0) {
            this.modal.sequence.forEach(note => {
                const endTick = note.t + note.g;
                if (endTick > maxTick) maxTick = endTick;
                if (note.n < minNote) minNote = note.n;
                if (note.n > maxNote) maxNote = note.n;
            });

            this.modal.log('info', `Sequence range: ticks 0-${maxTick}, notes ${minNote}-${maxNote}`);
        }

    // Store maxTick for the sliders
        if (!this.modal.midiData) this.modal.midiData = {};
        this.modal.midiData.maxTick = maxTick;

    // Default zoom — loop mode fits the whole loop (bars × timeSig × ppq)
    // into the view since that's the unit of work. Standard (file) mode
    // keeps the legacy "first 20 seconds" framing.
        const ticksPerBeat = this.modal.midiData.header?.ticksPerBeat || 480;
        const twentySeconds = ticksPerBeat * 40; // ~20 seconds at 120 BPM
        const xrange = this.modal.loopMode
            ? (maxTick > 0 ? maxTick : ticksPerBeat * 4)
            : Math.min(maxTick > 0 ? maxTick : twentySeconds, twentySeconds);

    // Vertically centered view that keeps every note of visible channels onscreen
        const noteRange = Math.max(24, maxNote - minNote + 4); // +4 note margin instead of +24
        const centerNote = Math.floor((minNote + maxNote) / 2);
        const yoffset = Math.max(0, centerNote - Math.floor(noteRange / 2)); // Center vertically

        const renderer = this.modal.pianoRollRenderer;
        renderer.setSize(width, height)
                .setEditMode('dragpoly')
                .setXRange(xrange).setYRange(noteRange).setYOffset(yoffset)
                .setAttribute('wheelzoom', '1')
                .setAttribute('xscroll', '1')
                .setAttribute('yscroll', '1')
    // Native xruler — standard (file) mode hides it because PlaybackTimelineBar
    // takes over ; in loop/panel mode there's no timeline bar.
                .setAttribute('xruler', this.modal.loopMode ? '1' : '0')
    // Playback markers — kept internal for state but hidden visually
                .setMarkers(0, maxTick)
                .setCursor(0);

    // Clean, modern piano roll colors (theme-aware)
        this.modal.events._applyPianoRollTheme();

        this.modal.log('info', `Piano roll configured: xrange=${xrange}, yrange=${noteRange}, yoffset=${yoffset} (centered), tempo=${this.modal.tempo || 120} BPM, timebase=${this.modal.ticksPerBeat || 480} ticks/beat`);

    // Add to container BEFORE loading the sequence
        renderer.attachToContainer();

    // Hide the piano roll's native SVG markers (replaced by PlaybackTimelineBar)
        const cursorImg    = renderer.querySelector('#wac-cursor');
        const markStartImg = renderer.querySelector('#wac-markstart');
        const markEndImg   = renderer.querySelector('#wac-markend');
        if (cursorImg) cursorImg.style.display = 'none';
        if (markStartImg) markStartImg.style.display = 'none';
        if (markEndImg) markEndImg.style.display = 'none';

    // OPTIMIZATION: batch property assignments to avoid multiple redraws
    // Each property with a 'layout' observer triggers layout() → redraw()
    // Without batching: 3+ unnecessary redraws. With batching: a single redraw at the end.
        const currentSnap = this.modal.snapValues[this.modal.currentSnapIndex];
        renderer.beginBatchUpdate()
                .setTempo(this.modal.tempo || 120)
                .setTimebase(this.modal.ticksPerBeat || 480)
                .setGrid(120)
                .setSnap(currentSnap.ticks)
                .endBatchUpdate();

        this.modal.log('info', `Piano roll grid/snap: grid=120 ticks, snap=${currentSnap.ticks} ticks (${currentSnap.label})`);

    // OPTIMIZATION: Replace setTimeout(100ms) with a single RAF
    // The component is already mounted after appendChild — no 100ms wait needed
        await new Promise(resolve => requestAnimationFrame(resolve));

    // Set the MIDI channel colors on the piano roll BEFORE loading the sequence
        renderer.setChannelColors(this.modal.channelColors);

    // Pick the default channel for new notes (first active channel)
        if (this.modal.activeChannels.size > 0) {
            renderer.setDefaultChannel(Array.from(this.modal.activeChannels)[0]);
        }

    // Initialize the navigation overview bar
        this.modal.events._initNavigationOverview(maxTick, xrange);

    // Sync the sliders with the piano roll's native navigation
        this.modal.events.setupScrollSynchronization();

    // Initialize PlaybackTimelineBar
        this.modal.events._initTimelineBar(maxTick, ticksPerBeat, xrange);

        // Load the sequence only when it exists and is non-empty
        if (this.modal.sequence && this.modal.sequence.length > 0) {
            this.modal.log('info', `Loading ${this.modal.sequence.length} notes into piano roll`);
            this.modal.log('debug', 'First 3 notes:', JSON.stringify(this.modal.sequence.slice(0, 3)));

        // Assign the sequence to the piano roll
            renderer.setSequence(this.modal.sequence).redraw();
            this.modal.log('info', 'Piano roll redrawn with channel colors');

    // Verify the sequence was correctly assigned
            this.modal.log('debug', `Piano roll sequence length: ${renderer.getSequence().length}`);
        } else {
            this.modal.log('info', 'No notes to display in piano roll — starting empty');
            renderer.setSequence([]).redraw();
        }

    // Store a sequence copy to detect changes
        let previousSequence = [];

    // Optimization: debounce to avoid multiple calls
        let changeTimeout = null;
        const handleChange = () => {
    // Instant audio feedback before the debounce
            this.modal.handleNoteFeedback(previousSequence);

            if (changeTimeout) clearTimeout(changeTimeout);
            changeTimeout = setTimeout(() => {
                this.modal.isDirty = true;
                this.updateSaveButton();
                this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
                this.modal.editActions?.updateUndoRedoButtonsState(); // Update undo/redo when the sequence changes
                this.modal.editActions?.updateEditButtons(); // Update copy/paste/delete when the selection changes

    // Update the sequence copy after the sync
                previousSequence = this.copySequence(renderer.getSequence());
            }, 100); // 100ms debounce
        };

    // Initialize the sequence copy
        previousSequence = this.copySequence(renderer.getSequence());

    // Listen for changes with a debounce
        renderer.on('change', handleChange);
        renderer.on('selectionchange', () => {
            this.modal.editActions?.updateEditButtons();
        });

    // Auto-resize the canvas whenever its container changes size — covers
    // CC section expand/collapse, drag-resize of the cc-resize bar,
    // window resize, hidden-tab → visible tab transitions, etc. Without
    // this the piano roll keeps the pixel size it had at mount.
        if (typeof ResizeObserver !== 'undefined') {
            this.modal._pianoRollContainerObs?.disconnect?.();
            let lastW = 0, lastH = 0;
            // Coalesce resize bursts onto a single RAF — the drag-resize
            // handler fires per pointer-move and we don't want to thrash
            // the canvas allocation.
            let scheduled = false;
            this.modal._pianoRollContainerObs = new ResizeObserver(() => {
                const w = container.clientWidth, h = container.clientHeight;
                if (w === lastW && h === lastH) return;
                lastW = w; lastH = h;
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => {
                    scheduled = false;
                    this._refreshPianoRollSize();
                });
            });
            this.modal._pianoRollContainerObs.observe(container);
        }

    // Play the note on piano-keyboard click — true note-on / note-off
    // so that long-sustain instruments (strings, basses, pads) ring as
    // long as the pointer is held.
        renderer.on('pianokey', (e) => {
            if (!this.modal.keyboardPlaybackEnabled) return;
            const note = e.detail.note;
            const channel = renderer.getDefaultChannel() || 0;
            this.modal.playNoteHold(note, 100, channel);
        });
        renderer.on('pianokeyup', (e) => {
            const note = e.detail.note;
            const channel = renderer.getDefaultChannel() || 0;
            this.modal.releaseNote(note, channel);
        });

    // Play notes during drag movement. notedragmove fires once per pitch
    // change so a one-shot, family-aware fixed duration is appropriate.
        renderer.on('notedragmove', (e) => {
            if (!this.modal.dragPlaybackEnabled) return;
            const notes = e.detail.notes;
            if (notes.length > 0 && notes.length <= 6) {
                notes.forEach(note => {
                    this.modal.playNoteFeedback(note.n, note.v || 100, note.c || 0);
                });
            }
        });

        this.updateStats();
        this.modal.editActions?.updateEditButtons(); // Initial state
        this.modal.editActions?.updateUndoRedoButtonsState(); // Initial undo/redo state
        this.modal.renderer.updateInstrumentSelector(); // Initial instrument selector state

    // Pick the default mode (drag-view for navigation)
        if (renderer?.isMounted()) {
            renderer.setUIMode(this.modal.editMode); // 'drag-view' by default
            this.modal.log('info', `Piano roll UI mode set to: ${this.modal.editMode}`);
        }

    // The CC/pitch-bend editor is initialized when the section opens
    // via toggleCCSection()

    // Load connected devices so playable notes can be filtered
        await this.loadConnectedDevices();

    // Restore the routings saved in DB for this file
        await this.modal.tablatureOps?._loadSavedRoutings();

    // Update tablature button visibility for initial channel selection
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateTablatureButton();
        }
    }

    updateStats() {
    // Previously showed the note count — removed to save space
    // The info is still visible in the channel buttons' tooltip
    }

    updateSaveButton() {
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            if (this.modal.isDirty) {
                saveBtn.classList.add('btn-warning');
                saveBtn.innerHTML = `💾 ${this.modal.t('midiEditor.saveModified')}`;
            } else {
                saveBtn.classList.remove('btn-warning');
                saveBtn.innerHTML = `💾 ${this.modal.t('midiEditor.save')}`;
            }
        }
    }

    copySequence(sequence) {
        if (!sequence || sequence.length === 0) return [];
        return sequence.map(note => ({ t: note.t, g: note.g, n: note.n, c: note.c, v: note.v }));
    }

    // Delegates to playableNotes sub-feature (extracted per audit §1.3)
    async togglePreviewSource()                                { return this.playableNotes?.togglePreviewSource(); }
    async _loadRoutedPlayableNotes()                           { return this.playableNotes?.loadRoutedPlayableNotes(); }
    async togglePlayableNotesGlobal()                          { return this.playableNotes?.togglePlayableNotesGlobal(); }
    _getRoutedGmProgram(channel)                               { return this.playableNotes?.getRoutedGmProgram(channel) ?? null; }
    async _loadRoutedGmPrograms()                              { return this.playableNotes?.loadRoutedGmPrograms(); }
    async _fetchAndCacheRoutedGmProgram(channel, routedValue)  { return this.playableNotes?.fetchAndCacheRoutedGmProgram(channel, routedValue); }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorRouting = MidiEditorRouting;
    }
})();
