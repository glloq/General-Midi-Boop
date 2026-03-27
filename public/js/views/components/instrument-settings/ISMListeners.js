(function() {
    'use strict';
    const ISMListeners = {};

    // ========== DRUM HELPERS ==========

    ISMListeners._refreshDrumUI = function() {
        this.$$('.ism-drum-note-cb').forEach(cb => {
            cb.checked = this._drumSelectedNotes.has(parseInt(cb.dataset.note));
        });
        for (const catId of Object.keys(InstrumentSettingsModal.DRUM_CATEGORIES)) {
            this._updateDrumCategoryBadge(catId);
        }
        this._updateDrumSummary();
        // Update toggle buttons
        this.$$('.ism-drum-cat-toggle').forEach(btn => {
            const cat = InstrumentSettingsModal.DRUM_CATEGORIES[btn.dataset.cat];
            if (cat) btn.textContent = cat.notes.every(n => this._drumSelectedNotes.has(n)) ? '☑' : '☐';
        });
    };

    ISMListeners._updateDrumCategoryBadge = function(catId) {
        const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
        if (!cat) return;
        const checked = cat.notes.filter(n => this._drumSelectedNotes.has(n)).length;
        const badge = this.$(`.ism-drum-category[data-cat="${catId}"] .ism-drum-cat-badge`);
        if (badge) {
            badge.textContent = `${checked}/${cat.notes.length}`;
            badge.classList.toggle('all', checked === cat.notes.length);
        }
        const toggle = this.$(`.ism-drum-cat-toggle[data-cat="${catId}"]`);
        if (toggle) toggle.textContent = checked === cat.notes.length ? '☑' : '☐';
    };

    ISMListeners._updateDrumSummary = function() {
        const summary = this.$('#drumSummary');
        if (!summary) return;
        const total = Object.values(InstrumentSettingsModal.DRUM_CATEGORIES).reduce((s, c) => s + c.notes.length, 0);
        const count = this._drumSelectedNotes.size;
        summary.innerHTML = `<span class="ism-drum-stat ${count > 0 ? 'good' : 'bad'}">${count} / ${total} notes</span>`;
    };

    // ========== NECK DIAGRAM ==========

    ISMListeners._attachStringsSectionListeners = function() {
        // CC toggle
        const ismCcEnabled = this.$('#ism-cc-enabled');
        if (ismCcEnabled) {
            ismCcEnabled.addEventListener('change', (e) => {
                const ccSection = this.dialog?.querySelector('#ism-cc-config-section');
                if (ccSection) ccSection.classList.toggle('si-collapsed', !e.target.checked);
            });
        }

        // Num strings change -> update config then re-render
        const siNumStrings = this.$('#siNumStrings');
        if (siNumStrings) {
            siNumStrings.addEventListener('change', () => {
                const num = parseInt(siNumStrings.value);
                if (isNaN(num) || num < 1 || num > 12) return;

                const tab = this._getActiveTab();
                if (!tab) return;

                // Ensure stringInstrumentConfig exists
                if (!tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig = {
                        num_strings: 6, num_frets: 24,
                        tuning: [40, 45, 50, 55, 59, 64],
                        is_fretless: false, capo_fret: 0, cc_enabled: true
                    };
                }
                const cfg = tab.stringInstrumentConfig;

                // Collect current tuning from DOM before re-render
                const currentTuning = [];
                for (let i = 0; i < 12; i++) {
                    const el = this.$(`#siTuning${i}`);
                    if (el) currentTuning.push(parseInt(el.value) || 40);
                }
                // Extend tuning if adding strings
                while (currentTuning.length < num) {
                    const last = currentTuning[currentTuning.length - 1] || 40;
                    currentTuning.push(Math.min(127, last + 5));
                }

                // Update config
                cfg.num_strings = num;
                cfg.tuning = currentTuning.slice(0, num);

                // Adjust frets_per_string if set
                if (cfg.frets_per_string) {
                    while (cfg.frets_per_string.length < num) {
                        cfg.frets_per_string.push(cfg.num_frets || 24);
                    }
                    cfg.frets_per_string = cfg.frets_per_string.slice(0, num);
                }

                // Re-render
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }

        // Preset change -> update config then re-render
        const siPreset = this.$('#siPresetSelect');
        if (siPreset) {
            siPreset.addEventListener('change', () => {
                if (!siPreset.value || !this.tuningPresets) return;
                const preset = this.tuningPresets[siPreset.value];
                if (!preset) return;

                const tab = this._getActiveTab();
                if (!tab) return;
                if (!tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig = {};
                }
                const cfg = tab.stringInstrumentConfig;
                cfg.num_strings = preset.strings;
                cfg.num_frets = preset.frets;
                cfg.tuning = [...preset.tuning];
                cfg.is_fretless = !!preset.fretless;
                cfg.frets_per_string = null;

                // Re-render
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }

        // Init neck diagram (also wires tuning/fret input listeners)
        this._initNeckDiagram();
    };

    ISMListeners._initNeckDiagram = function() {
        // Destroy old instance
        if (this._neckDiagram) {
            this._neckDiagram.destroy();
            this._neckDiagram = null;
        }

        const canvas = this.dialog?.querySelector('#ism-neck-canvas');
        if (!canvas || typeof NeckDiagramConfig === 'undefined') return;

        const tab = this._getActiveTab();
        const config = tab?.stringInstrumentConfig;
        const numStrings = config?.num_strings || parseInt(this.$('#siNumStrings')?.value) || 6;
        const numFrets = 24; // Max fret range for the diagram
        const tuning = config?.tuning || [];

        requestAnimationFrame(() => {
            const wrapper = canvas.parentElement;
            const w = wrapper?.clientWidth || 400;
            canvas.width = w;
            canvas.height = Math.max(120, numStrings * 22 + 36);

            // If no per-string frets, create uniform array from saved num_frets
            const initFrets = config?.frets_per_string
                || new Array(numStrings).fill(config?.num_frets ?? 24);

            this._neckDiagram = new NeckDiagramConfig(canvas, {
                numStrings,
                numFrets,
                fretsPerString: initFrets,
                tuning,
                isFretless: config?.is_fretless || false,
                onChange: (fretsPerString) => {
                    // Sync fret inputs in the side panel
                    if (fretsPerString) {
                        for (let i = 0; i < fretsPerString.length; i++) {
                            const input = this.$(`#siFrets${i}`);
                            if (input) input.value = fretsPerString[i];
                        }
                    }
                    // Store on the tab config for save
                    if (tab && tab.stringInstrumentConfig) {
                        tab.stringInstrumentConfig.frets_per_string = fretsPerString;
                    }
                }
            });
        });

        // Wire fret inputs -> neck diagram sync
        this.$$('.si-frets-val').forEach(input => {
            input.addEventListener('change', () => {
                if (!this._neckDiagram) return;
                const idx = parseInt(input.id.replace('siFrets', ''));
                if (isNaN(idx)) return;
                const val = parseInt(input.value) || 0;
                this._neckDiagram.fretsPerString[idx] = Math.max(0, Math.min(36, val));
                this._neckDiagram.redraw();
            });
        });

        // Wire tuning inputs -> neck diagram sync + badge update
        this.$$('.si-tuning-val').forEach(input => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.string);
                if (isNaN(idx)) return;
                const val = parseInt(input.value);
                if (isNaN(val) || val < 0 || val > 127) return;
                // Update badge
                const NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
                const badge = this.$(`#ismBadge${idx}`);
                if (badge) badge.textContent = NOTE_NAMES[val % 12] + (Math.floor(val / 12) - 1);
                // Update neck diagram
                if (this._neckDiagram && this._neckDiagram.tuning[idx] !== undefined) {
                    this._neckDiagram.tuning[idx] = val;
                    this._neckDiagram.redraw();
                }
            });
        });
    };

    // ========== EVENT LISTENERS ==========

    ISMListeners._attachListeners = function() {
        // Sidebar nav
        this.$$('.ism-nav-item').forEach(btn => {
            btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
        });

        // Tabs
        this.$$('.ism-tab[data-channel]').forEach(btn => {
            btn.addEventListener('click', () => this._switchTab(parseInt(btn.dataset.channel)));
        });
        const addBtn = this.$('.ism-tab-add');
        if (addBtn) addBtn.addEventListener('click', () => this._addTab());

        // Footer buttons
        const saveBtn = this.$('.ism-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', () => this._save());
        const cancelBtn = this.$('.ism-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());
        const deleteBtn = this.$('.ism-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this._deleteTab());

        // Channel grid
        this.$$('.ism-channel-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const ch = parseInt(btn.dataset.channel);
                const hiddenInput = this.$('#channelSelect');
                if (hiddenInput) hiddenInput.value = ch;
                this.$$('.ism-channel-btn').forEach(b => {
                    const bCh = parseInt(b.dataset.channel);
                    const color = InstrumentSettingsModal.CHANNEL_COLORS[bCh];
                    b.classList.toggle('active', bCh === ch);
                    b.style.background = bCh === ch ? color : '';
                    b.style.color = bCh === ch ? '#fff' : '';
                });
            });
        });

        // Drum category expand/collapse
        this.$$('.ism-drum-cat-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.ism-drum-cat-toggle')) return;
                header.closest('.ism-drum-category').classList.toggle('expanded');
            });
        });

        // Drum category toggle all
        this.$$('.ism-drum-cat-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const catId = btn.dataset.cat;
                const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
                if (!cat) return;
                const allChecked = cat.notes.every(n => this._drumSelectedNotes.has(n));
                cat.notes.forEach(n => allChecked ? this._drumSelectedNotes.delete(n) : this._drumSelectedNotes.add(n));
                this._refreshDrumUI();
            });
        });

        // Drum note checkboxes
        this.$$('.ism-drum-note-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const note = parseInt(cb.dataset.note);
                cb.checked ? this._drumSelectedNotes.add(note) : this._drumSelectedNotes.delete(note);
                this._updateDrumCategoryBadge(cb.dataset.cat);
                this._updateDrumSummary();
            });
        });

        // Drum preset apply
        const applyPreset = this.$('.ism-drum-apply-preset');
        if (applyPreset) {
            applyPreset.addEventListener('click', () => {
                const sel = this.$('.ism-drum-preset-select');
                if (!sel || !sel.value) return;
                const preset = InstrumentSettingsModal.DRUM_PRESETS[sel.value];
                if (!preset) return;
                this._drumSelectedNotes = new Set(preset.notes);
                this._refreshDrumUI();
            });
        }

        // Note selection mode toggle
        this.$$('.ism-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.$$('.ism-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
                if (typeof setNoteSelectionMode === 'function') setNoteSelectionMode(mode);
            });
        });

        // CC grid checkboxes
        this.$$('.ism-cc-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                cb.closest('.ism-cc-item').classList.toggle('checked', cb.checked);
                const selected = [];
                this.$$('.ism-cc-checkbox:checked').forEach(c => selected.push(parseInt(c.value)));
                const hidden = this.$('#supportedCCs');
                if (hidden) hidden.value = selected.join(', ');
            });
        });

        // Init CC toggle, neck diagram, and all string section listeners
        this._attachStringsSectionListeners();

        // GM Program change
        const gmSelect = this.$('#gmProgramSelect');
        if (gmSelect) {
            gmSelect.addEventListener('change', () => {
                // Update global state so legacy helpers see the new program
                const tab = this._getActiveTab();
                if (tab) {
                    const rawVal = parseInt(gmSelect.value);
                    const decoded = typeof selectValueToGmProgram === 'function'
                        ? selectValueToGmProgram(rawVal) : { program: rawVal, isDrumKit: false };
                    tab.settings.gm_program = decoded.program;
                    this._syncGlobalState();
                }
                if (typeof onGmProgramChanged === 'function') onGmProgramChanged(gmSelect);
                // Refresh sidebar to show/hide strings/drums
                const sidebar = this.$('.ism-sidebar');
                if (sidebar) sidebar.outerHTML = this._renderSidebar();
                this.$$('.ism-nav-item').forEach(btn => {
                    btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
                });
                // Refresh strings section content (preset dropdown depends on GM category)
                const stringsSection = this.$('.ism-section[data-section="strings"]');
                if (stringsSection) {
                    stringsSection.innerHTML = this._renderStringsSection();
                    this._attachStringsSectionListeners();
                }
            });
        }
    };

    if (typeof window !== 'undefined') window.ISMListeners = ISMListeners;
})();
