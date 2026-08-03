// ============================================================================
// File: public/js/features/LoopCreatorModalView.js
// Description: HTML rendering for LoopCreatorModal — extracted per audit
//   §1.3 (god-class split, complementing §6.6).
//
// Owns:
//   - `_renderHeader()` — top-of-modal title + tabs + per-tab toolbar
//     (output picker, arranger tempo/bars/save controls).
//   - `renderBody()` / `renderFooter()` — pane container + footer (no-op).
//   - `_renderLibraryTab()` / `_renderPadTab()` / `_renderLiveTab()` /
//     `_renderArrangerTab()` / `_renderKeyboardTab()` — delegates to the
//     respective sub-features for their tab HTML.
//   - `_renderPlaybar()` — bottom playhead bar showing live pad / arranger
//     playback positions (RAF-driven, called every frame while playing).
//
// Accessed via `loopCreatorModal.view`. The modal keeps thin delegates so
// existing call sites (super.render() pipeline, _switchTab) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class LoopCreatorModalView {
    /** @param {LoopCreatorModal} parent */
    constructor(parent) {
      this.parent = parent;
    }

    _renderHeader() {
      const showSave = this.parent.activeTab === 'arranger';
      return `
        <div class="modal-header lc-header">
            <div class="lc-header-left">
                <span class="lc-header-title" aria-hidden="true">∞</span>
                <span class="lc-header-subtitle">${this.parent.t('loopManager.title')}</span>
            </div>
            <div class="lc-header-tabs" role="tablist" aria-label="${this.parent.t('loopManager.title')}">
                <button class="lc-tab${this.parent.activeTab === 'library' ? ' lc-tab--active' : ''}" data-tab="library"  role="tab" id="lc-tab-library"  aria-controls="lc-pane-library"  aria-selected="${this.parent.activeTab === 'library'}"  tabindex="${this.parent.activeTab === 'library' ? '0' : '-1'}"><span aria-hidden="true">🗂</span> ${this.parent.t('loopManager.tabLibrary')}</button>
                <button class="lc-tab${this.parent.activeTab === 'pad' ? ' lc-tab--active' : ''}" data-tab="pad"      role="tab" id="lc-tab-pad"      aria-controls="lc-pane-pad"      aria-selected="${this.parent.activeTab === 'pad'}"      tabindex="${this.parent.activeTab === 'pad' ? '0' : '-1'}"><span class="lc-tab-icon lc-tab-icon--pad" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><circle cx="5" cy="5"  r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="5"  r="1.1" fill="currentColor" stroke="none"/><circle cx="5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="11" r="1.1" fill="currentColor" stroke="none"/></svg></span> ${this.parent.t('loopManager.tabPad')}</button>
                <button class="lc-tab${this.parent.activeTab === 'live' ? ' lc-tab--active' : ''}" data-tab="live"     role="tab" id="lc-tab-live"     aria-controls="lc-pane-live"     aria-selected="${this.parent.activeTab === 'live'}"     tabindex="${this.parent.activeTab === 'live' ? '0' : '-1'}"><span aria-hidden="true">⚡</span> ${this.parent.t('loopManager.tabLive')}</button>
                <button class="lc-tab${this.parent.activeTab === 'keyboard' ? ' lc-tab--active' : ''}" data-tab="keyboard" role="tab" id="lc-tab-keyboard" aria-controls="lc-pane-keyboard" aria-selected="${this.parent.activeTab === 'keyboard'}" tabindex="${this.parent.activeTab === 'keyboard' ? '0' : '-1'}"><span aria-hidden="true">🎹</span> ${this.parent.t('loopManager.tabKeyboard')}</button>
                <button class="lc-tab${this.parent.activeTab === 'arranger' ? ' lc-tab--active' : ''}" data-tab="arranger" role="tab" id="lc-tab-arranger" aria-controls="lc-pane-arranger" aria-selected="${this.parent.activeTab === 'arranger'}" tabindex="${this.parent.activeTab === 'arranger' ? '0' : '-1'}"><span aria-hidden="true">∞</span> ${this.parent.t('loopManager.tabArranger')}</button>
            </div>
            <div class="lc-header-actions">
                <button class="lc-btn lc-btn-sm lc-header-output-btn" id="lc-header-output-btn"
                    data-action="toggle-output"
                    aria-pressed="${this.parent._globalOutput.mode === 'device' ? 'true' : 'false'}"
                    title="${this.parent.t('loopCreator.outputLabel')}">
                    <span class="lc-header-output-icon" id="lc-header-output-icon" aria-hidden="true">🔊</span>
                    <span class="lc-header-output-label" id="lc-header-output-label">${this.parent.t('loopManager.outputSynth')}</span>
                </button>
                <button class="lc-btn lc-btn-primary lc-btn-sm" id="lc-header-save"
                    data-action="save-arrangement"
                    style="${showSave ? '' : 'display:none'}">💾 ${this.parent.t('loopCreator.saveArrangement')}</button>
                <button class="lc-btn lc-btn-sm lc-btn-icon" data-action="stop-all-playback" title="${this.parent.t('loopManager.stopAll')}">⏹</button>
                <button class="modal-close" data-action="close" aria-label="${this.parent.t('common.close')}">&times;</button>
            </div>
            <div class="lc-playbar" id="lc-playbar">
                <div class="lc-playbar-fill" id="lc-playbar-fill"></div>
            </div>
        </div>`;
    }

    renderBody() {
      return `
        <div class="lc-layout">
            <div class="lc-tab-content" id="lc-tab-content">
                ${this._renderLibraryTab()}
                ${this._renderPadTab()}
                ${this._renderLiveTab()}
                ${this._renderKeyboardTab()}
                ${this._renderArrangerTab()}
            </div>
        </div>`;
    }

    // =========================================================
    // RENDERING — TAB: KEYBOARD (live performance)
    // =========================================================

    _renderKeyboardTab() {
      return `
        <div class="lc-pane${this.parent.activeTab === 'keyboard' ? '' : ' lc-pane--hidden'} lm-kbd-pane" id="lc-pane-keyboard" role="tabpanel" aria-labelledby="lc-tab-keyboard">
            <div class="lm-kbd-panel" id="lm-kbd-panel"></div>
        </div>`;
    }

    renderFooter() {
      return '';
    }

    // =========================================================
    // RENDERING — TAB 1: LIBRARY
    // =========================================================

    _renderLibraryTab() {
      return this.parent.libraryFeature ? this.parent.libraryFeature.renderTabHtml() : '';
    }

    // =========================================================
    // RENDERING — TAB 2: PAD
    // =========================================================

    _renderPadTab() {
      return this.parent.padFeature ? this.parent.padFeature.renderTabHtml() : '';
    }

    // =========================================================
    // RENDERING — TAB 3: LIVE
    // =========================================================

    _renderLiveTab() {
      return this.parent.liveFeature ? this.parent.liveFeature.renderTabHtml() : '';
    }

    // =========================================================
    // RENDERING — TAB 4: ARRANGER
    // =========================================================

    _renderArrangerTab() {
      // Raccourcis platform-aware (AUDIT §U2 : ⌘ sur Mac, Ctrl ailleurs).
      const mod = LoopUtils.modKeyLabel();
      const sft = LoopUtils.shiftKeyLabel();
      return `
        <div class="lc-pane${this.parent.activeTab === 'arranger' ? '' : ' lc-pane--hidden'}" id="lc-pane-arranger" role="tabpanel" aria-labelledby="lc-tab-arranger">
            <div class="lc-ctrl-bar lc-ctrl-bar--arr">
                <!-- Groupe 1 — Identité de l'arrangement -->
                <input type="text" class="lc-name-input la-toolbar-name" id="la-name-input"
                    aria-label="${this.parent.t('loopCreator.arrangementName')}"
                    value="${this.parent.escape(this.parent.arrangementName || this.parent.t('loopCreator.untitledArrangement'))}"
                    placeholder="${this.parent.t('loopCreator.arrangementName')}" />

                <!-- Groupe 2 — Transport (play, stop, loop, count-in) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.parent.t('loopManager.groupTransport') || 'Transport'}">
                    <button class="lc-btn lc-btn-icon lc-btn-primary-ish" data-action="arr-play" id="la-play-btn"
                        title="${this.parent.t('loopCreator.play')} (Space)" aria-label="${this.parent.t('loopCreator.play')}"><span aria-hidden="true">▶</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-stop"
                        title="${this.parent.t('loopCreator.stop')} (Esc)" aria-label="${this.parent.t('loopCreator.stop')}"><span aria-hidden="true">⏹</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-toggle-loop" id="la-loop-btn"
                        title="${this.parent.t('loopManager.loopPlayback')}"
                        aria-label="${this.parent.t('loopManager.loopPlayback')}"
                        aria-pressed="${this.parent._arrangerLoop ? 'true' : 'false'}"><span aria-hidden="true">🔁</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-toggle-countin" id="la-countin-btn"
                        title="${this.parent.t('loopManager.countIn')}"
                        aria-label="${this.parent.t('loopManager.countIn')}"
                        aria-pressed="${this.parent._arrangerCountIn ? 'true' : 'false'}"><span aria-hidden="true">⏲</span></button>
                </div>

                <!-- Groupe 3 — Propriétés (tempo, mesures) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.parent.t('loopManager.groupProperties') || 'Properties'}">
                    <div class="lc-spinbox" title="${this.parent.t('loopCreator.tempo')}">
                        <button class="lc-spin-btn" data-action="arr-tempo-dec" aria-label="${this.parent.t('loopCreator.tempo')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="la-tempo" class="lc-spin-input lc-spin-input--sm" value="${this.parent.arrangementTempo}" min="20" max="300" aria-label="${this.parent.t('loopCreator.tempo')}" />
                        <button class="lc-spin-btn" data-action="arr-tempo-inc" aria-label="${this.parent.t('loopCreator.tempo')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <span class="lc-unit" aria-hidden="true">BPM</span>
                    <div class="lc-spinbox" title="${this.parent.t('loopCreator.totalBars')}">
                        <button class="lc-spin-btn" data-action="arr-bars-dec" aria-label="${this.parent.t('loopCreator.totalBars')} −"><span aria-hidden="true">‹</span></button>
                        <input type="number" id="la-bars" class="lc-spin-input lc-spin-input--sm" value="${this.parent.arrangementBars}" min="4" max="256" step="4" aria-label="${this.parent.t('loopCreator.totalBars')}" />
                        <button class="lc-spin-btn" data-action="arr-bars-inc" aria-label="${this.parent.t('loopCreator.totalBars')} +"><span aria-hidden="true">›</span></button>
                    </div>
                    <span class="lc-unit" aria-hidden="true">${this.parent.t('loopCreator.barsUnitShort') || 'M'}</span>
                </div>

                <!-- Groupe 4 — Édition (undo/redo) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.parent.t('loopManager.groupHistory') || 'Edit history'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-undo" id="la-undo-btn"
                        title="${this.parent.t('loopCreator.undo')} (${mod}+Z)" aria-label="${this.parent.t('loopCreator.undo')}" disabled><span aria-hidden="true">↶</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-redo" id="la-redo-btn"
                        title="${this.parent.t('loopCreator.redo')} (${mod}+${sft}+Z)" aria-label="${this.parent.t('loopCreator.redo')}" disabled><span aria-hidden="true">↷</span></button>
                </div>

                <!-- Groupe 5 — Vue (zoom horizontal + vertical) -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.parent.t('loopManager.groupZoom') || 'Zoom'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-out"
                        title="${this.parent.t('loopEditor.zoomHOut')}" aria-label="${this.parent.t('loopEditor.zoomHOut')}"><span aria-hidden="true">−↔</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-reset"
                        title="${this.parent.t('loopManager.zoomReset')}" aria-label="${this.parent.t('loopManager.zoomReset')}"><span aria-hidden="true">⌖</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoom-in"
                        title="${this.parent.t('loopEditor.zoomHIn')}" aria-label="${this.parent.t('loopEditor.zoomHIn')}"><span aria-hidden="true">+↔</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoomv-out"
                        title="${this.parent.t('loopManager.zoomVOut')}" aria-label="${this.parent.t('loopManager.zoomVOut')}"><span aria-hidden="true">−↕</span></button>
                    <button class="lc-btn lc-btn-icon" data-action="arr-zoomv-in"
                        title="${this.parent.t('loopManager.zoomVIn')}" aria-label="${this.parent.t('loopManager.zoomVIn')}"><span aria-hidden="true">+↕</span></button>
                </div>

                <span class="lc-ctrl-spacer"></span>

                <!-- Groupe 6 — Structure (add track, new arrangement) — actions secondaires, à droite -->
                <div class="lc-ctrl-group" role="group" aria-label="${this.parent.t('loopManager.groupStructure') || 'Structure'}">
                    <button class="lc-btn lc-btn-icon" data-action="arr-add-track"
                        title="${this.parent.t('loopCreator.addTrack')}" aria-label="${this.parent.t('loopCreator.addTrack')}"><span aria-hidden="true">＋</span></button>
                    <button class="lc-btn lc-btn-sm" data-action="arr-new"
                        title="${this.parent.t('loopCreator.newArrangement')}"><span aria-hidden="true">🆕</span> ${this.parent.t('loopCreator.newArrangement')}</button>
                </div>
            </div>

            <div class="la-area" id="la-area">
                <div class="la-palette" id="la-palette">
                    <div class="la-palette-title">${this.parent.t('loopCreator.palette')}</div>
                    <input type="search" id="la-palette-search" class="lc-name-input la-palette-search"
                        aria-label="${this.parent.t('loopManager.search')}"
                        placeholder="${this.parent.t('loopManager.search')}" autocomplete="off" />
                    <div class="la-palette-grid" id="la-palette-grid">
                        <div class="lc-empty">${this.parent.t('loopCreator.libraryEmpty')}</div>
                    </div>
                </div>
                <div class="la-timeline-col">
                    <canvas class="la-minimap" id="la-minimap" height="48"
                        aria-label="${this.parent.t('loopManager.arrangerMinimap') || 'Arrangement overview'}"
                        title="${this.parent.t('loopManager.arrangerMinimapHint') || 'Click to seek; drag to pan'}"></canvas>
                    <div class="la-timeline-wrap" id="la-timeline-wrap">
                        <div class="la-ruler" id="la-ruler"></div>
                        <div class="la-tracks" id="la-tracks"></div>
                        <div class="la-playhead" id="la-playhead" style="display:none"></div>
                    </div>
                </div>
            </div>

            <div class="la-arr-list-wrap">
                <div class="la-arr-list-title">${this.parent.t('loopCreator.arrangements')}</div>
                <div class="la-arr-list" id="la-arr-list"></div>
            </div>
        </div>`;
    }
    _renderPlaybar() {
      const fill = this.parent.$('#lc-playbar-fill');
      if (!fill) return;

      if (this.parent.isArrangerPlaying && this.parent._arrangerStartTime) {
        fill.classList.remove('lc-playbar-fill--looping');
        fill.style.removeProperty('--playbar-dur');
        const secPerBar = (60 / this.parent.arrangementTempo) * 4;
        const totalMs = this.parent.arrangementBars * secPerBar * 1000;
        const startMs = this.parent._arrangerStartBar * secPerBar * 1000;
        const elapsed = performance.now() - this.parent._arrangerStartTime;
        const pct = Math.min(100, Math.max(0, ((startMs + elapsed) / totalMs) * 100));
        fill.style.width = pct + '%';
        this.parent._renderArrangerPlayhead(elapsed / 1000);
        return;
      }
      this.parent._renderArrangerPlayhead(null);

      const hasPad = this.parent._padPlayingIndex.size > 0;
      const hasLive = this.parent._livePlayingLoops.size > 0;
      if (hasPad || hasLive) {
        // Use the shortest active loop duration to pace the fill animation
        let minDurMs = Infinity;
        for (const [idx, data] of this.parent._padPlayTimes) {
          if (this.parent._padPlayingIndex.has(idx) && data.durMs < minDurMs) minDurMs = data.durMs;
        }
        for (const [, state] of this.parent._livePlayingLoops) {
          if (state.durMs && state.durMs < minDurMs) minDurMs = state.durMs;
        }
        if (!isFinite(minDurMs)) minDurMs = 2000;
        fill.style.setProperty('--playbar-dur', (minDurMs / 1000).toFixed(3) + 's');
        if (!fill.classList.contains('lc-playbar-fill--looping')) {
          fill.classList.add('lc-playbar-fill--looping');
        }
      } else {
        fill.classList.remove('lc-playbar-fill--looping');
        fill.style.width = '0%';
      }
    }

    // ---------------------------------------------------------
    // GM program → display name / icon
    // ---------------------------------------------------------

    gmProgramName(prog) {
      // GM_PROGRAM_NAMES is a script-scope const declared in
      // LoopCreatorModal.js — visible across classic scripts in the
      // shared global script lexical environment.
      return (
        (typeof GM_PROGRAM_NAMES !== 'undefined' && GM_PROGRAM_NAMES[prog]) || `Program ${prog}`
      );
    }

    instrIconHtml(prog, kind = 'instrument', extraClass = '') {
      const family = LoopUtils.familyForProgram(prog);
      const emoji = family?.icon || '🎵';
      let svgUrl = null;
      const IF = typeof window !== 'undefined' ? window.InstrumentFamilies : null;
      if (IF) {
        if (kind === 'instrument') {
          const ico = IF.resolveInstrumentIcon({ gmProgram: prog });
          svgUrl = ico?.svgUrl || null;
          if (!svgUrl && ico?.family) svgUrl = IF.familyIconUrl(ico.family.slug);
        } else {
          const fam = IF.getFamilyForProgram(prog);
          if (fam) svgUrl = IF.familyIconUrl(fam.slug);
        }
      }
      const wrap = `lc-instr-icon${extraClass ? ' ' + extraClass : ''}`;
      if (!svgUrl)
        return `<span class="${wrap}"><span class="lc-instr-emoji">${emoji}</span></span>`;
      return (
        `<span class="${wrap}">` +
        `<img class="lc-instr-svg" src="${svgUrl}" alt="" loading="lazy" decoding="async"` +
        ` onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">` +
        `<span class="lc-instr-emoji" style="display:none">${emoji}</span>` +
        `</span>`
      );
    }
  }

  if (typeof window !== 'undefined') {
    window.LoopCreatorModalView = LoopCreatorModalView;
  }
})();
