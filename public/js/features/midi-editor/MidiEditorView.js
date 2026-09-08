// ============================================================================
// File: public/js/features/midi-editor/MidiEditorView.js
// Description: HTML template for the MIDI editor modal — extracted from
//   MidiEditorRouting per audit §1.3 (god-class split).
//
// Owns:
//   - `render()` — builds `modal.container` (header, toolbar, channel panel,
//     piano-roll container, CC editor, status bar), mounts it, and wires
//     event listeners + keyboard shortcuts.
//
// Pure view code : all state reads go through `this.modal.X` and there is
// no logic dependency on MidiEditorRouting beyond the host class structure.
// Accessed via `modal.routingOps.view`. MidiEditorRouting.render() is a
// one-line delegate so external callers (MidiEditorModal) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorView {
    /** @param {MidiEditorRouting} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
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
      const headerHtml = loop
        ? ''
        : `
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
                    <button class="modal-close" data-action="close" aria-label="${this.modal.t('common.close')}">&times;</button>
                </div>`;

      const channelsToolbarHtml = loop
        ? ''
        : `
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
      const playbackSectionHtml = loop
        ? ''
        : `
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
      const settingsPopoverHtml = loop
        ? ''
        : `
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
      const inlineTouchToggleHtml = loop
        ? `
                            <button class="tool-btn touch-mode-inline-toggle" data-action="toggle-touch-mode" id="touch-mode-inline-toggle"
                                data-active="${this.modal.touchMode ? 'true' : 'false'}"
                                title="${this.modal.t('midiEditor.touchModeTitle')}"
                                aria-pressed="${this.modal.touchMode ? 'true' : 'false'}">
                                <span class="icon">👆</span>
                            </button>`
        : '';

      // Wrap the editor body. Outside loop mode we keep the historical
      // <div class="modal-dialog modal-xl"><…/></div> wrapper ; inside
      // loop mode we drop it so the panel inherits its host's flex
      // sizing.
      const bodyOpen = loop
        ? '<div class="midi-editor-panel">'
        : '<div class="modal-dialog modal-xl">';
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

                        ${
                          loop
                            ? `<!-- Specialized modes (drum / tab / wind) — loop mode only -->
                        <div class="toolbar-section specialized-mode-section" id="loop-specialized-modes"></div>
                        <div class="toolbar-divider"></div>`
                            : ''
                        }

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
                            <!-- Navigation Overview minimap (whole-song + viewport rect).
                                 Loop mode uses the LoopEditor's own minimap instead. -->
                            ${loop ? '' : '<div class="navigation-overview-wrap" id="navigation-overview-container"></div>'}
                            <!-- Playback Timeline Bar — time ruler / scrub bar above the
                                 piano roll. -->
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
                                ${
                                  loop
                                    ? ''
                                    : `<div class="cc-header-channels" id="editor-channel-selector">
                                    <!-- Channels are added dynamically -->
                                </div>`
                                }
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
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorView = MidiEditorView;
  }
})();
