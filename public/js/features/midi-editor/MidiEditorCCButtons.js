// ============================================================================
// File: public/js/features/midi-editor/MidiEditorCCButtons.js
// Description: CC type buttons + section UI — extracted from MidiEditorCC
//   per audit §1.3 (god-class split).
//
// Owns:
//   - `updateDynamicCCButtons()` — refresh the CC type buttons in the
//     toolbar based on CC events present in the sequence.
//   - `toggleCCSection()` — collapse/expand the CC editor section,
//     manage section header state, init the active lane editor on first
//     expansion.
//   - `selectBestCCTypeForChannel(channel)` — auto-pick a CC type that
//     has data on the given channel (called when active channel changes).
//   - `selectCCType(ccType)` — switch active CC editor type
//     (cc7, cc11, pitchbend, tempo, velocity, …) ; spawns/destroys the
//     specialized editor and updates the toolbar/button state.
//   - `getUsedCCTypesForChannel(channel)` / `getAllUsedCCTypes()` —
//     compute the set of CC types with at least one event.
//   - `highlightUsedCCButtons()` — apply the "has data" badge to buttons
//     whose CC type has events.
//
// Accessed via `modal.ccOps.buttons`. MidiEditorCC keeps thin delegate
// methods preserving the legacy names so external callers
// (MidiEditorEvents, MidiEditorCCPicker, MidiEditorLaneEditors,
// MidiEditorSequence) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorCCButtons {
    /** @param {MidiEditorCC} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    updateDynamicCCButtons() {
      const dynamicContainer = this.modal.container?.querySelector('#cc-dynamic-buttons');
      const dynamicGroup = this.modal.container?.querySelector('.cc-dynamic-group');
      if (!dynamicContainer || !dynamicGroup) return;

      // CC couverts par les boutons statiques
      const staticCCs = new Set([
        'cc1',
        'cc2',
        'cc5',
        'cc7',
        'cc10',
        'cc11',
        'cc74',
        'cc76',
        'cc77',
        'cc78',
        'cc91',
        'pitchbend',
        'aftertouch',
        'polyAftertouch'
      ]);

      // Find CCs present in the file that are not in the static list (all channels)
      const detectedCCs = new Set();
      this.modal.ccEvents.forEach((e) => {
        if (!staticCCs.has(e.type) && e.type.startsWith('cc')) {
          detectedCCs.add(e.type);
        }
      });

      // Vider les anciens boutons dynamiques
      dynamicContainer.innerHTML = '';

      if (detectedCCs.size === 0) {
        dynamicGroup.style.display = 'none';
        return;
      }

      // Afficher le groupe dynamique
      dynamicGroup.style.display = '';

      // Determine the active channel for visual filtering
      const activeBtn = this.modal.container.querySelector(
        '#editor-channel-selector .cc-channel-btn.active'
      );
      const activeChannel = activeBtn
        ? parseInt(activeBtn.dataset.channel)
        : this.modal.channels && this.modal.channels.length > 0
          ? this.modal.channels[0].channel
          : 0;
      const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);

      // Sort detected CCs numerically
      const sortedCCs = Array.from(detectedCCs).sort((a, b) => {
        return parseInt(a.replace('cc', '')) - parseInt(b.replace('cc', ''));
      });

      // OPTIMIZATION: precompute counts in a single pass instead of O(n) per CC type
      const ccCounts = new Map();
      this.modal.ccEvents.forEach((e) => ccCounts.set(e.type, (ccCounts.get(e.type) || 0) + 1));

      // OPTIMISATION: DocumentFragment pour un seul reflow DOM au lieu d'un par bouton
      const fragment = document.createDocumentFragment();
      sortedCCs.forEach((ccType) => {
        const ccNum = parseInt(ccType.replace('cc', ''));
        const ccName = this.parent._getCCName(ccNum);
        const count = ccCounts.get(ccType) || 0;
        const hasDataOnChannel = usedTypesOnChannel.has(ccType);

        const btn = document.createElement('button');
        btn.className = 'cc-type-btn dynamic';
        if (hasDataOnChannel) btn.classList.add('has-data');
        if (!hasDataOnChannel) btn.classList.add('has-data-other');
        btn.dataset.ccType = ccType;
        btn.title = `${ccName} (${this.modal.t('midiEditor.events', { count })})`;
        btn.textContent = `CC${ccNum}`;

        fragment.appendChild(btn);
      });
      dynamicContainer.appendChild(fragment);

      this.modal.log(
        'info',
        `Added ${sortedCCs.length} dynamic CC buttons: ${sortedCCs.join(', ')}`
      );

      this.highlightUsedCCButtons();
    }

    toggleCCSection() {
      this.modal.ccSectionExpanded = !this.modal.ccSectionExpanded;

      const ccSection = document.getElementById('cc-section');
      const ccContent = document.getElementById('cc-section-content');
      const ccHeader = document.getElementById('cc-section-header');
      const resizeBar = document.getElementById('cc-resize-btn');

      if (ccSection && ccContent && ccHeader) {
        if (this.modal.ccSectionExpanded) {
          ccSection.classList.add('expanded');
          ccSection.classList.remove('collapsed');
          ccHeader.classList.add('expanded');
          ccHeader.classList.remove('collapsed');

          // Afficher la barre de resize
          if (resizeBar) {
            resizeBar.classList.add('visible');
            this.modal.log('debug', 'Resize bar shown');
          }

          // Listen for the CSS transition to finish
          const onTransitionEnd = (e) => {
            // S'assurer que c'est bien la transition de la section CC
            if (e.target !== ccSection) return;

            ccSection.removeEventListener('transitionend', onTransitionEnd);

            this.modal.log('debug', 'CC Section transition ended');

            // Initialize the CC editor if it does not exist yet
            if (!this.modal.ccEditor) {
              this.modal.ccPicker.initCCEditor();
            } else {
              // The editor already exists — wait for its layout then resize
              this.modal.ccPicker.waitForCCEditorLayout();
            }
          };

          ccSection.addEventListener('transitionend', onTransitionEnd);

          // Fallback when there is no transition (already expanded, etc.)
          setTimeout(() => {
            if (!this.modal.ccEditor) {
              this.modal.ccPicker.initCCEditor();
            }
          }, 400);
        } else {
          ccSection.classList.remove('expanded');
          ccSection.classList.add('collapsed');
          ccHeader.classList.remove('expanded');
          ccHeader.classList.add('collapsed');

          // Clean up inline styles set by the drag-resize handler
          // so the CSS classes (flex, min-height) can take over
          ccSection.style.removeProperty('height');
          ccSection.style.removeProperty('flex');
          ccSection.style.removeProperty('min-height');

          const notesSection = this.modal.container?.querySelector('.notes-section');
          if (notesSection) {
            notesSection.style.removeProperty('height');
            notesSection.style.removeProperty('flex');
            notesSection.style.removeProperty('min-height');
          }

          // Cacher la barre de resize
          if (resizeBar) {
            resizeBar.classList.remove('visible');
            this.modal.log('debug', 'Resize bar hidden');
          }

          // Suspend sub-editors to save CPU when collapsed
          if (this.modal.ccEditor && typeof this.modal.ccEditor.suspend === 'function')
            this.modal.ccEditor.suspend();
          if (this.modal.velocityEditor && typeof this.modal.velocityEditor.suspend === 'function')
            this.modal.velocityEditor.suspend();
          if (this.modal.tempoEditor && typeof this.modal.tempoEditor.suspend === 'function')
            this.modal.tempoEditor.suspend();

          // Redimensionner le piano roll pour occuper tout l'espace
          requestAnimationFrame(() => {
            if (this.modal.pianoRollRenderer?.isMounted()) {
              this.modal.pianoRollRenderer?.redraw();
            }
          });
        }
      }

      this.modal.log(
        'info',
        `Section CC ${this.modal.ccSectionExpanded ? 'expanded' : 'collapsed'}`
      );
    }

    selectBestCCTypeForChannel(channel) {
      // Ne rien faire si on est en mode velocity ou tempo
      if (this.modal.currentCCType === 'velocity' || this.modal.currentCCType === 'tempo') return;

      const usedTypes = this.getUsedCCTypesForChannel(channel);
      const ccTypes = Array.from(usedTypes).filter((t) => t !== 'velocity' && t !== 'tempo');

      // Masquer le message "aucun CC" s'il existe
      const ccEditorContainer = document.getElementById('cc-editor-container');
      const existingMsg = ccEditorContainer?.querySelector('.cc-no-data-message');
      if (existingMsg) existingMsg.remove();

      if (ccTypes.length === 0) {
        // No CC on this channel — deselect all CC buttons
        this.modal.container?.querySelectorAll('.cc-type-btn').forEach((btn) => {
          const type = btn.dataset.ccType;
          if (type && type !== 'velocity' && type !== 'tempo') {
            btn.classList.remove('active');
          }
        });

        // Display a message inside the editor
        if (ccEditorContainer) {
          const msg = document.createElement('div');
          msg.className = 'cc-no-data-message';
          msg.style.cssText =
            'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:13px;pointer-events:none;z-index:1;';
          msg.textContent = this.modal.t('midiEditor.noCCOnChannel') || 'No CC on this channel';
          ccEditorContainer.appendChild(msg);
        }
        return;
      }

      // Keep the current type if it has data on this channel
      if (usedTypes.has(this.modal.currentCCType)) return;

      // Otherwise pick the first CC type that has data on this channel
      this.selectCCType(ccTypes[0]);
    }

    selectCCType(ccType) {
      this.modal.currentCCType = ccType;
      this.modal.log('info', `Type sélectionné: ${ccType}`);

      // Retirer le message "aucun CC" s'il existe
      const noDataMsg = document.querySelector('.cc-no-data-message');
      if (noDataMsg) noDataMsg.remove();

      // Update the buttons
      const ccTypeButtons = this.modal.container?.querySelectorAll('.cc-type-btn');
      ccTypeButtons?.forEach((btn) => {
        if (btn.dataset.ccType === ccType) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      const ccEditorContainer = document.getElementById('cc-editor-container');
      const velocityEditorContainer = document.getElementById('velocity-editor-container');
      const tempoEditorContainer = document.getElementById('tempo-editor-container');

      if (ccType === 'tempo') {
        // Show the tempo editor
        if (ccEditorContainer) ccEditorContainer.style.display = 'none';
        if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
        if (tempoEditorContainer) tempoEditorContainer.style.display = 'flex';

        // Initialize the tempo editor if it does not exist
        if (!this.modal.tempoEditor) {
          this.modal.ccPicker.initTempoEditor();
        } else {
          // Synchroniser avec le piano roll actuel
          this.modal.ccPicker.syncTempoEditor();
          // OPTIMIZATION: single RAF instead of double RAF (saves one frame)
          requestAnimationFrame(() => {
            if (this.modal.tempoEditor && this.modal.tempoEditor.resize) {
              this.modal.tempoEditor.resize();
            }
          });
        }

        // Afficher les boutons de courbes pour tempo
        this.modal.ccPicker.showCurveButtons();
      } else if (ccType === 'velocity') {
        // Show the velocity editor
        if (ccEditorContainer) ccEditorContainer.style.display = 'none';
        if (velocityEditorContainer) velocityEditorContainer.style.display = 'flex';
        if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

        // Initialize the velocity editor if it does not exist
        if (!this.modal.velocityEditor) {
          this.modal.ccPicker.initVelocityEditor();
        } else {
          // Reload the full sequence (per-channel filtering happens inside the editor)
          this.modal.velocityEditor.setSequence(this.modal.fullSequence);
          this.modal.ccPicker.syncVelocityEditor();
          // OPTIMIZATION: single RAF instead of double RAF (saves one frame)
          requestAnimationFrame(() => {
            if (this.modal.velocityEditor && this.modal.velocityEditor.resize) {
              this.modal.velocityEditor.resize();
            }
          });
        }

        // Update the channel selector for the velocity editor
        this.parent.updateEditorChannelSelector();
        // Masquer les boutons de courbes
        this.modal.ccPicker.hideCurveButtons();
      } else {
        // Show the CC editor
        if (ccEditorContainer) ccEditorContainer.style.display = 'flex';
        if (velocityEditorContainer) velocityEditorContainer.style.display = 'none';
        if (tempoEditorContainer) tempoEditorContainer.style.display = 'none';

        // Initialize the CC editor if it does not exist
        if (!this.modal.ccEditor) {
          this.modal.ccPicker.initCCEditor();
        } else {
          this.modal.ccEditor.setCC(ccType);
          // OPTIMISATION: Simple RAF au lieu de double RAF
          requestAnimationFrame(() => {
            if (this.modal.ccEditor && this.modal.ccEditor.resize) {
              this.modal.ccEditor.resize();
            }
          });
          // Update the channel selector because used channels vary per CC type
          this.parent.updateEditorChannelSelector();
        }

        // Afficher les boutons de courbes pour les CC aussi
        this.modal.ccPicker.showCurveButtons();
      }

      // Update the delete button state after the type change
      this.modal.ccPicker.updateDeleteButtonState();
      this.highlightUsedCCButtons();
    }

    getUsedCCTypesForChannel(channel) {
      const usedTypes = new Set();
      this.modal.ccEvents.forEach((event) => {
        if (event.channel === channel) {
          usedTypes.add(event.type);
        }
      });
      if (this.modal.fullSequence && this.modal.fullSequence.some((note) => note.c === channel)) {
        usedTypes.add('velocity');
      }
      return usedTypes;
    }

    getAllUsedCCTypes() {
      const allTypes = new Set();
      this.modal.ccEvents.forEach((event) => {
        allTypes.add(event.type);
      });
      if (this.modal.fullSequence && this.modal.fullSequence.length > 0) {
        allTypes.add('velocity');
      }
      return allTypes;
    }

    highlightUsedCCButtons() {
      if (!this.modal.container) return;

      // Source of truth: the active channel button in the DOM
      const activeBtn = this.modal.container.querySelector(
        '#editor-channel-selector .cc-channel-btn.active'
      );
      const activeChannel = activeBtn
        ? parseInt(activeBtn.dataset.channel)
        : this.modal.channels && this.modal.channels.length > 0
          ? this.modal.channels[0].channel
          : 0;

      const usedTypesOnChannel = this.getUsedCCTypesForChannel(activeChannel);
      const allUsedTypes = this.getAllUsedCCTypes();
      const alwaysVisible = new Set(['velocity', 'tempo']);

      this.modal.container.querySelectorAll('.cc-type-btn').forEach((btn) => {
        const ccType = btn.dataset.ccType;
        if (!ccType) return; // bouton GO du custom CC

        const hasDataOnChannel = usedTypesOnChannel.has(ccType);
        const hasDataInFile = allUsedTypes.has(ccType);
        const isActive = btn.classList.contains('active');
        const isAlwaysVisible = alwaysVisible.has(ccType);

        btn.classList.toggle('has-data', hasDataOnChannel);
        btn.classList.toggle('has-data-other', !hasDataOnChannel && hasDataInFile);

        // Visible si: donnees sur le canal actif, OU donnees dans le fichier, OU toujours visible, OU actif
        btn.style.display =
          isAlwaysVisible || hasDataOnChannel || hasDataInFile || isActive ? '' : 'none';
      });

      // Masquer les groupes CC entierement vides
      this.modal.container
        .querySelectorAll('.cc-btn-group:not(.cc-dynamic-group)')
        .forEach((group) => {
          if (group.dataset.group === 'custom') return;
          const visibleBtns = group.querySelectorAll('.cc-type-btn:not([style*="display: none"])');
          group.style.display = visibleBtns.length > 0 ? '' : 'none';
        });
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorCCButtons = MidiEditorCCButtons;
  }
})();
