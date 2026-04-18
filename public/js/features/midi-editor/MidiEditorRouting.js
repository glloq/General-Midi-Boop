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

        const specializedActive = this.modal._isSpecializedEditorActive();

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
    // Create the modal container
        this.modal.container = document.createElement('div');
        this.modal.container.className = 'modal-overlay midi-editor-modal';
        this.modal.container.innerHTML = `
            <div class="modal-dialog modal-xl">
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
                </div>
                <div class="modal-body">
                    <!-- Channel toolbar (just below the header) -->
                    <div class="channels-toolbar-wrapper">
                        <div class="channels-toolbar">
                            ${this.modal.renderer.renderChannelButtons()}
                        </div>
                        <div class="channel-global-actions">
                            <button class="btn-show-all-channels" title="${this.modal.t('midiEditor.showAllChannels')}">👁️</button>
                        </div>
                    </div>

                    <!-- Edit toolbar (compact, icon-only buttons with tooltips) -->
                    <div class="editor-toolbar">
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
                        </div>

                        <div class="toolbar-divider"></div>

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
                    </div>

                    <!-- Conteneur pour Notes et CC/Pitchbend -->
                    <div class="midi-editor-container">
                        <!-- Section Notes -->
                        <div class="midi-editor-section notes-section">
                            <!-- Navigation Overview Bar -->
                            <div class="navigation-overview-wrap" id="navigation-overview-container"></div>
                            <!-- Playback Timeline Bar -->
                            <div class="playback-timeline-wrap" id="playback-timeline-container"></div>
                            <div class="piano-roll-wrapper">
                                <div class="piano-roll-container" id="piano-roll-container">
                                    <!-- webaudio-pianoroll will be inserted here -->
                                </div>
                            </div>
                        </div>

                        <!-- Barre de resize entre notes et CC -->
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
                                <div class="cc-header-channels" id="editor-channel-selector">
                                    <!-- Channels are added dynamically -->
                                </div>
                                <button class="cc-settings-btn" id="cc-draw-settings-btn" title="${this.modal.t('midiEditor.drawSettings') || 'Réglages de dessin'}">⚙</button>
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
                                        <!-- Bouton + pour ajouter un CC depuis la liste -->
                                        <div class="cc-btn-group" data-group="custom">
                                            <span class="cc-group-label">&nbsp;</span>
                                            <div class="cc-btn-group-buttons">
                                                <button class="cc-type-btn cc-add-btn" id="cc-add-btn" title="${this.modal.t('midiEditor.addCC') || 'Ajouter un CC'}">+</button>
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
            </div>
        `;

        document.body.appendChild(this.modal.container);

    // Attach events
        this.modal.events.attachEvents();

    // Fermer avec Escape
        this.modal.escapeHandler = (e) => {
            if (e.key === 'Escape') this.modal.close();
        };
        document.addEventListener('keydown', this.modal.escapeHandler);

    // Raccourcis clavier
        this.modal.setupKeyboardShortcuts();
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

    // Create the webaudio-pianoroll element
        this.modal.pianoRoll = document.createElement('webaudio-pianoroll');

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

    // Default zoom that shows ~20 seconds
    // At 480 ticks/beat and 120 BPM: 20s = 9600 ticks
        const ticksPerBeat = this.modal.midiData.header?.ticksPerBeat || 480;
        const twentySeconds = ticksPerBeat * 40; // ~20 secondes à 120 BPM
        const xrange = Math.max(twentySeconds, Math.min(maxTick, twentySeconds)); // Vue sur 20 premières secondes

    // Vertically centered view that keeps every note of visible channels onscreen
        const noteRange = Math.max(24, maxNote - minNote + 4); // +4 notes de marge au lieu de +24
        const centerNote = Math.floor((minNote + maxNote) / 2);
        const yoffset = Math.max(0, centerNote - Math.floor(noteRange / 2)); // Centrer verticalement

        this.modal.pianoRoll.setAttribute('width', width);
        this.modal.pianoRoll.setAttribute('height', height);
        this.modal.pianoRoll.setAttribute('editmode', 'dragpoly');
        this.modal.pianoRoll.setAttribute('xrange', xrange.toString());
        this.modal.pianoRoll.setAttribute('yrange', noteRange.toString());
        this.modal.pianoRoll.setAttribute('yoffset', yoffset.toString());
        this.modal.pianoRoll.setAttribute('wheelzoom', '1');
        this.modal.pianoRoll.setAttribute('xscroll', '1');
        this.modal.pianoRoll.setAttribute('yscroll', '1');
    // Disable the piano roll's native xruler (replaced by PlaybackTimelineBar)
        this.modal.pianoRoll.setAttribute('xruler', '0');
    // Playback markers — kept internal for state but hidden visually
        this.modal.pianoRoll.setAttribute('markstart', '0');
        this.modal.pianoRoll.setAttribute('markend', maxTick.toString());
        this.modal.pianoRoll.setAttribute('cursor', '0');

    // Clean, modern piano roll colors (theme-aware)
        this.modal.events._applyPianoRollTheme();

        this.modal.log('info', `Piano roll configured: xrange=${xrange}, yrange=${noteRange}, yoffset=${yoffset} (centered), tempo=${this.modal.tempo || 120} BPM, timebase=${this.modal.ticksPerBeat || 480} ticks/beat`);

    // Ajouter au conteneur AVANT de charger la sequence
        container.appendChild(this.modal.pianoRoll);

    // Hide the piano roll's native SVG markers (replaced by PlaybackTimelineBar)
        const cursorImg = this.modal.pianoRoll.querySelector('#wac-cursor');
        const markStartImg = this.modal.pianoRoll.querySelector('#wac-markstart');
        const markEndImg = this.modal.pianoRoll.querySelector('#wac-markend');
        if (cursorImg) cursorImg.style.display = 'none';
        if (markStartImg) markStartImg.style.display = 'none';
        if (markEndImg) markEndImg.style.display = 'none';

    // OPTIMIZATION: batch property assignments to avoid multiple redraws
    // Each property with a 'layout' observer triggers layout() → redraw()
    // Without batching: 3+ unnecessary redraws. With batching: a single redraw at the end.
        this.modal.pianoRoll.beginBatchUpdate();

        this.modal.pianoRoll.tempo = this.modal.tempo || 120;
        this.modal.pianoRoll.timebase = this.modal.ticksPerBeat || 480;
        this.modal.pianoRoll.grid = 120;

        const currentSnap = this.modal.snapValues[this.modal.currentSnapIndex];
        this.modal.pianoRoll.snap = currentSnap.ticks;

        this.modal.pianoRoll.endBatchUpdate();

        this.modal.log('info', `Piano roll grid/snap: grid=${this.modal.pianoRoll.grid} ticks, snap=${this.modal.pianoRoll.snap} ticks (${currentSnap.label})`);

    // OPTIMISATION: Remplacer setTimeout(100ms) par un seul RAF
    // The component is already mounted after appendChild — no 100ms wait needed
        await new Promise(resolve => requestAnimationFrame(resolve));

    // Set the MIDI channel colors on the piano roll BEFORE loading the sequence
        this.modal.pianoRoll.channelColors = this.modal.channelColors;

    // Pick the default channel for new notes (first active channel)
        if (this.modal.activeChannels.size > 0) {
            this.modal.pianoRoll.defaultChannel = Array.from(this.modal.activeChannels)[0];
        }

    // Initialiser la barre de navigation overview
        this.modal.events._initNavigationOverview(maxTick, xrange);

    // Synchroniser les sliders avec la navigation native du piano roll
        this.modal.events.setupScrollSynchronization();

    // Initialize PlaybackTimelineBar
        this.modal.events._initTimelineBar(maxTick, ticksPerBeat, xrange);

        // Load the sequence only when it exists and is non-empty
        if (this.modal.sequence && this.modal.sequence.length > 0) {
            this.modal.log('info', `Loading ${this.modal.sequence.length} notes into piano roll`);
            this.modal.log('debug', 'First 3 notes:', JSON.stringify(this.modal.sequence.slice(0, 3)));

        // Assign the sequence to the piano roll
            this.modal.pianoRoll.sequence = this.modal.sequence;

    // OPTIMISATION: redraw direct via RAF au lieu de setTimeout(50ms)
            if (typeof this.modal.pianoRoll.redraw === 'function') {
                this.modal.pianoRoll.redraw();
                this.modal.log('info', 'Piano roll redrawn with channel colors');
            }

    // Verify the sequence was correctly assigned
            this.modal.log('debug', `Piano roll sequence length: ${this.modal.pianoRoll.sequence?.length || 0}`);
        } else {
            this.modal.log('warn', 'No notes to display in piano roll - adding test notes');

    // Add a few test notes to confirm the piano roll works
            this.modal.pianoRoll.sequence = [
                { t: 0, g: 480, n: 60 },   // C4
                { t: 480, g: 480, n: 64 }, // E4
                { t: 960, g: 480, n: 67 }  // G4
            ];

            if (typeof this.modal.pianoRoll.redraw === 'function') {
                this.modal.pianoRoll.redraw();
            }
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
                this.modal.updateUndoRedoButtonsState(); // Mettre à jour undo/redo quand la séquence change
                this.modal.updateEditButtons(); // Mettre à jour copy/paste/delete quand la sélection change

    // Update the sequence copy after the sync
                previousSequence = this.copySequence(this.modal.pianoRoll.sequence);
            }, 100); // Debounce de 100ms
        };

    // Initialize the sequence copy
        previousSequence = this.copySequence(this.modal.pianoRoll.sequence);

    // Listen for changes with a debounce
        this.modal.pianoRoll.addEventListener('change', handleChange);
        this.modal.pianoRoll.addEventListener('selectionchange', () => {
            this.modal.updateEditButtons();
        });

    // Jouer la note au clic sur le clavier piano
        this.modal.pianoRoll.addEventListener('pianokey', (e) => {
            if (!this.modal.keyboardPlaybackEnabled) return;
            const note = e.detail.note;
            const channel = this.modal.pianoRoll.defaultChannel || 0;
            this.modal.playNoteFeedback(note, 100, channel);
        });

    // Jouer les notes pendant le deplacement par drag
        this.modal.pianoRoll.addEventListener('notedragmove', (e) => {
            if (!this.modal.dragPlaybackEnabled) return;
            const notes = e.detail.notes;
            if (notes.length > 0 && notes.length <= 6) {
                notes.forEach(note => {
                    this.modal.playNoteFeedback(note.n, note.v || 100, note.c || 0);
                });
            }
        });

        this.updateStats();
        this.modal.updateEditButtons(); // État initial
        this.modal.updateUndoRedoButtonsState(); // État initial undo/redo
        this.modal.renderer.updateInstrumentSelector(); // État initial sélecteur d'instrument

    // Pick the default mode (drag-view for navigation)
        if (this.modal.pianoRoll && typeof this.modal.pianoRoll.setUIMode === 'function') {
            this.modal.pianoRoll.setUIMode(this.modal.editMode); // 'drag-view' par défaut
            this.modal.log('info', `Piano roll UI mode set to: ${this.modal.editMode}`);
        }

    // The CC/pitch-bend editor is initialized when the section opens
    // via toggleCCSection()

    // Load connected devices so playable notes can be filtered
        await this.loadConnectedDevices();

    // Restore the routings saved in DB for this file
        await this.modal._loadSavedRoutings();

    // Update tablature button visibility for initial channel selection
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateTablatureButton();
        }
    }

    updateStats() {
    // Previously showed the note count — removed to save space
    // L'information est toujours visible dans le tooltip des boutons de canal
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

    async togglePreviewSource() {
        const btn = this.modal.container?.querySelector('#preview-source-toggle');
        if (this.modal.previewSource === 'gm') {
            this.modal.previewSource = 'routed';
            if (btn) { btn.dataset.source = 'routed'; btn.textContent = this.modal.t('midiEditor.routedSource') || '🔊 Routé'; }
            // Fetch playable note ranges for all routed channels
            await this._loadRoutedPlayableNotes();
        } else {
            this.modal.previewSource = 'gm';
            if (btn) { btn.dataset.source = 'gm'; btn.textContent = this.modal.t('midiEditor.gmSource') || '🔊 GM'; }
            this.modal._routedPlayableNotes.clear();
        }
        if (this.modal._playback) this.modal._playback._feedbackInstrumentsLoaded = false;
        if (this.modal.synthesizer) this.modal.loadSequenceForPlayback();
        this.modal.log('info', `Preview source switched to: ${this.modal.previewSource}`);
    }

    async _loadRoutedPlayableNotes() {
        this.modal._routedPlayableNotes.clear();
        const promises = [];
        for (const [channel, routedValue] of this.modal.channelRouting) {
            promises.push((async () => {
                let deviceId = routedValue;
                let devChannel = undefined;
                if (routedValue.includes('::')) {
                    const parts = routedValue.split('::');
                    deviceId = parts[0];
                    devChannel = parseInt(parts[1]);
                }
                try {
                    const params = { deviceId };
                    if (devChannel !== undefined) params.channel = devChannel;
                    const response = await this.modal.api.sendCommand('instrument_get_capabilities', params);
                    if (response && response.capabilities) {
                        const caps = response.capabilities;
                        const mode = caps.note_selection_mode || 'range';
                        let notes = null;
                        if (mode === 'discrete' && caps.selected_notes && Array.isArray(caps.selected_notes)) {
                            notes = new Set(caps.selected_notes.map(n => parseInt(n)));
                        } else if (mode === 'range') {
                            const minNote = caps.note_range_min != null ? parseInt(caps.note_range_min) : 0;
                            const maxNote = caps.note_range_max != null ? parseInt(caps.note_range_max) : 127;
                            if (minNote !== 0 || maxNote !== 127) {
                                notes = new Set();
                                for (let n = minNote; n <= maxNote; n++) notes.add(n);
                            }
                        }
                        this.modal._routedPlayableNotes.set(channel, notes);
                    }
                } catch (err) {
                    this.modal.log('warn', `Failed to fetch capabilities for routed channel ${channel}:`, err);
                }
            })());
        }
        await Promise.all(promises);
    }

    async togglePlayableNotesGlobal() {
        this.modal.showPlayableNotes = !this.modal.showPlayableNotes;

        const btn = this.modal.container?.querySelector('#playable-notes-toggle');
        if (btn) {
            btn.dataset.active = String(this.modal.showPlayableNotes);
            const onLabel = this.modal.t('midiEditor.playableOn') || 'ON';
            const offLabel = this.modal.t('midiEditor.playableOff') || 'OFF';
            const srLabel = btn.querySelector('.sr-only');
            if (srLabel) {
                srLabel.textContent = this.modal.showPlayableNotes ? onLabel : offLabel;
            } else {
                btn.textContent = this.modal.showPlayableNotes ? onLabel : offLabel;
            }
        }

        if (this.modal.showPlayableNotes) {
            const promises = [];
            for (const [channel] of this.modal.channelRouting) {
                if (!this.modal.channelPlayableHighlights.has(channel)) {
                    promises.push(this.modal._toggleChannelPlayableHighlight(channel));
                }
            }
            await Promise.all(promises);
        } else {
            this.modal.channelPlayableHighlights.clear();
            this.modal._syncPianoRollHighlights();
        }

        this.updateChannelButtons();
        this.modal.log('info', `Playable notes global: ${this.modal.showPlayableNotes ? 'ON' : 'OFF'}`);
    }

    _getRoutedGmProgram(channel) {
        const gm = this.modal._routedGmPrograms.get(channel);
        return gm != null ? gm : null;
    }

    async _loadRoutedGmPrograms() {
        this.modal._routedGmPrograms.clear();
        const promises = [];
        for (const [channel, routedValue] of this.modal.channelRouting.entries()) {
            promises.push(this._fetchAndCacheRoutedGmProgram(channel, routedValue));
        }
        await Promise.all(promises);
    }

    async _fetchAndCacheRoutedGmProgram(channel, routedValue) {
        if (!routedValue) {
            this.modal._routedGmPrograms.delete(channel);
            return;
        }
        let deviceId = routedValue;
        let devChannel = undefined;
        if (routedValue.includes('::')) {
            const parts = routedValue.split('::');
            deviceId = parts[0];
            devChannel = parseInt(parts[1]);
        }
        try {
            const params = { deviceId };
            if (devChannel !== undefined) params.channel = devChannel;
            const response = await this.modal.api.sendCommand('instrument_get_capabilities', params);
            if (response && response.capabilities && response.capabilities.gm_program != null) {
                this.modal._routedGmPrograms.set(channel, response.capabilities.gm_program);
            }
        } catch (err) {
            this.modal.log('warn', `Failed to fetch gm_program for routed device ${deviceId}:`, err);
        }
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorRouting = MidiEditorRouting;
    }
})();
