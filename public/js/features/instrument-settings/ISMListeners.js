(function() {
    'use strict';
    const ISMListeners = {};

    // ========== DRUM HELPERS ==========

    ISMListeners._refreshDrumUI = function() {
        this.$$('.ism-drum-note-cb').forEach(function(cb) {
            cb.checked = this._drumSelectedNotes.has(parseInt(cb.dataset.note));
        }.bind(this));
        for (const catId of Object.keys(InstrumentSettingsModal.DRUM_CATEGORIES)) {
            this._updateDrumCategoryBadge(catId);
        }
        this._updateDrumSummary();
        this.$$('.ism-drum-cat-toggle').forEach(function(btn) {
            const cat = InstrumentSettingsModal.DRUM_CATEGORIES[btn.dataset.cat];
            if (cat) btn.textContent = cat.notes.every(function(n) { return this._drumSelectedNotes.has(n); }.bind(this)) ? '☑' : '☐';
        }.bind(this));
    };

    ISMListeners._updateDrumCategoryBadge = function(catId) {
        const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
        if (!cat) return;
        const checked = cat.notes.filter(function(n) { return this._drumSelectedNotes.has(n); }.bind(this)).length;
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
        const total = Object.values(InstrumentSettingsModal.DRUM_CATEGORIES).reduce(function(s, c) { return s + c.notes.length; }, 0);
        const count = this._drumSelectedNotes.size;
        summary.innerHTML = `<span class="ism-drum-stat ${count > 0 ? 'good' : 'bad'}">${count} / ${total} notes</span>`;
    };

    // ========== NECK DIAGRAM ==========

    ISMListeners._attachStringsSectionListeners = function() {
        // CC toggle
        const ismCcEnabled = this.$('#ism-cc-enabled');
        if (ismCcEnabled) {
            ismCcEnabled.addEventListener('change', function(e) {
                const tab = this._getActiveTab();
                if (tab && tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig.cc_enabled = e.target.checked;
                }
                const ccSection = this.dialog?.querySelector('#ism-cc-config-section');
                if (ccSection) ccSection.classList.toggle('si-collapsed', !e.target.checked);
            }.bind(this));
        }

        // Num strings change -> update config then re-render
        const siNumStrings = this.$('#siNumStrings');
        if (siNumStrings) {
            siNumStrings.addEventListener('change', function() {
                const num = parseInt(siNumStrings.value);
                if (isNaN(num) || num < 1 || num > 12) return;

                const tab = this._getActiveTab();
                if (!tab) return;

                if (!tab.stringInstrumentConfig) {
                    tab.stringInstrumentConfig = {
                        num_strings: 6, num_frets: 24,
                        tuning: [40, 45, 50, 55, 59, 64],
                        is_fretless: false, capo_fret: 0, cc_enabled: true
                    };
                }
                const cfg = tab.stringInstrumentConfig;

                const currentTuning = [];
                for (let i = 0; i < 12; i++) {
                    const el = this.$(`#siTuning${i}`);
                    if (el) currentTuning.push(parseInt(el.value) || 40);
                }
                while (currentTuning.length < num) {
                    const last = currentTuning[currentTuning.length - 1] || 40;
                    currentTuning.push(Math.min(127, last + 5));
                }

                cfg.num_strings = num;
                cfg.tuning = currentTuning.slice(0, num);

                if (cfg.frets_per_string) {
                    while (cfg.frets_per_string.length < num) {
                        cfg.frets_per_string.push(cfg.num_frets || 24);
                    }
                    cfg.frets_per_string = cfg.frets_per_string.slice(0, num);
                }

                // Re-render into subsection
                const stringsSubsection = this.$('#stringsSubsection');
                if (stringsSubsection) {
                    const titleHtml = stringsSubsection.querySelector('.ism-subsection-title');
                    const titleOuter = titleHtml ? titleHtml.outerHTML : '';
                    stringsSubsection.innerHTML = titleOuter + this._renderStringsContent();
                    this._attachStringsSectionListeners();
                }
                // Sync polyphony default — one voice per string.
                this._syncPolyphonyToNumStrings(num);
            }.bind(this));
        }

        // Preset change -> update config then re-render
        const siPreset = this.$('#siPresetSelect');
        if (siPreset) {
            siPreset.addEventListener('change', function() {
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

                // Re-render into subsection
                const stringsSubsection = this.$('#stringsSubsection');
                if (stringsSubsection) {
                    const titleHtml = stringsSubsection.querySelector('.ism-subsection-title');
                    const titleOuter = titleHtml ? titleHtml.outerHTML : '';
                    stringsSubsection.innerHTML = titleOuter + this._renderStringsContent();
                    this._attachStringsSectionListeners();
                }
                // Sync polyphony to match the preset's string count — picking
                // a new instrument is a reset, so overwrite any stale value.
                this._syncPolyphonyToNumStrings(preset.strings);
            }.bind(this));
        }

        // Scale-length preset → fill the mm input. The preset is purely a
        // shortcut: the user is free to overwrite the value afterwards (we
        // do NOT lock the input) so a non-standard scale length is allowed.
        const siScalePreset = this.$('#siScaleLengthPreset');
        const siScaleInput = this.$('#siScaleLengthMm');
        if (siScalePreset && siScaleInput) {
            siScalePreset.addEventListener('change', function() {
                if (!siScalePreset.value || !this.scaleLengthPresets) return;
                const preset = this.scaleLengthPresets[siScalePreset.value];
                if (!preset || !Number.isFinite(preset.scale_length_mm)) return;
                siScaleInput.value = String(preset.scale_length_mm);
                // Mirror into the in-memory tab config so other live computations
                // (eg. the hands section coverage hint) see the new value without
                // waiting for a re-render.
                const tab = this._getActiveTab();
                if (tab?.stringInstrumentConfig) {
                    tab.stringInstrumentConfig.scale_length_mm = preset.scale_length_mm;
                }
            }.bind(this));
        }
        if (siScaleInput) {
            siScaleInput.addEventListener('change', function() {
                const tab = this._getActiveTab();
                if (!tab?.stringInstrumentConfig) return;
                const v = parseInt(siScaleInput.value, 10);
                tab.stringInstrumentConfig.scale_length_mm = Number.isFinite(v) ? v : null;
            }.bind(this));
        }

        // Init neck diagram
        this._initNeckDiagram();
    };

    /**
     * Update `#polyphonyInput` to `numStrings`. Called when the user picks
     * a preset or changes the string count — one voice per string is the
     * physically-accurate default for plucked / bowed instruments.
     */
    ISMListeners._syncPolyphonyToNumStrings = function(numStrings) {
        const input = this.$('#polyphonyInput');
        if (input && Number.isFinite(numStrings)) {
            input.value = String(numStrings);
        }
        const tab = this._getActiveTab();
        if (tab?.settings) {
            tab.settings.polyphony = numStrings;
        }
    };

    ISMListeners._initNeckDiagram = function() {
        if (this._neckDiagram) {
            this._neckDiagram.destroy();
            this._neckDiagram = null;
        }

        const canvas = this.dialog?.querySelector('#ism-neck-canvas');
        if (!canvas || typeof NeckDiagramConfig === 'undefined') return;

        const tab = this._getActiveTab();
        const config = tab?.stringInstrumentConfig;
        const numStrings = config?.num_strings || parseInt(this.$('#siNumStrings')?.value) || 6;
        const numFrets = 24;
        const tuning = config?.tuning || [];

        requestAnimationFrame(function() {
            const wrapper = canvas.parentElement;
            const w = Math.min(wrapper?.clientWidth || 400, 280);
            canvas.width = w;
            canvas.height = Math.max(300, numFrets * 14 + 64);

            const initFrets = config?.frets_per_string
                || new Array(numStrings).fill(config?.num_frets ?? 24);

            this._neckDiagram = new NeckDiagramConfig(canvas, {
                numStrings: numStrings,
                numFrets: numFrets,
                fretsPerString: initFrets,
                tuning: tuning,
                isFretless: config?.is_fretless || false,
                onChange: function(fretsPerString) {
                    if (fretsPerString) {
                        for (let i = 0; i < fretsPerString.length; i++) {
                            const input = this.$(`#siFrets${i}`);
                            if (input) input.value = fretsPerString[i];
                        }
                    }
                    if (tab && tab.stringInstrumentConfig) {
                        tab.stringInstrumentConfig.frets_per_string = fretsPerString;
                    }
                }.bind(this)
            });
        }.bind(this));

        // Wire fret inputs -> sync into config + neck diagram (when present).
        // The inputs are the only per-string range control for fretless
        // (bowed) instruments since the canvas isn't rendered; for fretted
        // instruments the canvas still drives the primary UX but typed
        // edits need to flow back into its state.
        this.$$('.si-frets-val').forEach(function(input) {
            input.addEventListener('change', function() {
                const idx = parseInt(input.dataset.string ?? input.id.replace('siFrets', ''), 10);
                if (isNaN(idx)) return;
                const raw = parseInt(input.value, 10);
                const val = Math.max(0, Math.min(36, isNaN(raw) ? 0 : raw));
                input.value = String(val);

                const tab = this._getActiveTab();
                if (tab?.stringInstrumentConfig) {
                    const cfg = tab.stringInstrumentConfig;
                    if (!Array.isArray(cfg.frets_per_string) || cfg.frets_per_string.length !== cfg.num_strings) {
                        cfg.frets_per_string = new Array(cfg.num_strings).fill(cfg.num_frets ?? 24);
                    }
                    cfg.frets_per_string[idx] = val;
                }

                if (this._neckDiagram) {
                    this._neckDiagram.fretsPerString[idx] = val;
                    this._neckDiagram.redraw();
                }
            }.bind(this));
        }.bind(this));

        // Wire tuning inputs -> neck diagram sync + badge update
        this.$$('.si-tuning-val').forEach(function(input) {
            input.addEventListener('change', function() {
                const idx = parseInt(input.dataset.string);
                if (isNaN(idx)) return;
                const val = parseInt(input.value);
                if (isNaN(val) || val < 0 || val > 127) return;
                const NOTE_NAMES = MidiConstants.NOTE_NAMES;
                const badge = this.$(`#ismBadge${idx}`);
                if (badge) badge.textContent = NOTE_NAMES[val % 12] + (Math.floor(val / 12) - 1);
                if (this._neckDiagram && this._neckDiagram.tuning[idx] !== undefined) {
                    this._neckDiagram.tuning[idx] = val;
                    this._neckDiagram.redraw();
                }
            }.bind(this));
        }.bind(this));
    };

    // ========== SHARED LISTENER HELPERS ==========

    ISMListeners._wireNotesModeListeners = function() {
        const self = this;
        // Note selection mode toggle
        this.$$('.ism-mode-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const mode = btn.dataset.mode;
                self.$$('.ism-mode-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });
                if (typeof setNoteSelectionMode === 'function') setNoteSelectionMode(mode);
                // Show/hide octave mode selector
                const octaveSelector = self.$('#octaveModeSelector');
                if (octaveSelector) octaveSelector.style.display = (mode === 'discrete') ? 'none' : '';
            });
        });

        // Octave mode toggle buttons
        var updateOctaveMode = function() {
            const activeBtn = self.$('.ism-octave-btn.active');
            const modeKey = activeBtn ? activeBtn.dataset.octave : 'chromatic';
            // Update hidden input
            const modeInput = self.$('#octaveModeInput');
            if (modeInput) modeInput.value = modeKey;
            // Compute playable notes
            const minInput = document.getElementById('noteRangeMin');
            const maxInput = document.getElementById('noteRangeMax');
            const rangeMin = minInput && minInput.value !== '' ? parseInt(minInput.value) : 21;
            const rangeMax = maxInput && maxInput.value !== '' ? parseInt(maxInput.value) : 108;
            const playableNotes = InstrumentSettingsModal.computePlayableNotes(rangeMin, rangeMax, modeKey);
            const playableInput = self.$('#playableNotesInput');
            if (playableInput) playableInput.value = JSON.stringify(playableNotes);
            // Update info
            const infoEl = self.$('#octaveInfo');
            if (infoEl) infoEl.textContent = playableNotes.length + ' notes jouables';
            // Highlight playable notes on piano keyboard
            self._highlightPlayableNotes(playableNotes);
        };
        this.$$('.ism-octave-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                self.$$('.ism-octave-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                updateOctaveMode();
            });
        });
    };

    /**
     * Highlight playable notes on the mini piano keyboard.
     * Marks non-playable keys as dimmed (ism-muted) and playable keys with a dot (ism-playable).
     */
    ISMListeners._highlightPlayableNotes = function(playableNotes) {
        const pianoEl = document.getElementById('pianoKeyboardMini');
        if (!pianoEl) return;
        const noteSet = new Set(playableNotes);
        pianoEl.querySelectorAll('.piano-key').forEach(function(key) {
            const note = parseInt(key.dataset.note);
            key.classList.remove('ism-playable', 'ism-muted');
            if (isNaN(note)) return;
            // Only apply within the selected range (keys with in-range, range-start, range-end)
            const inRange = key.classList.contains('in-range') || key.classList.contains('range-start') || key.classList.contains('range-end');
            if (inRange || !key.classList.contains('disabled')) {
                if (noteSet.has(note)) {
                    key.classList.add('ism-playable');
                } else if (inRange) {
                    key.classList.add('ism-muted');
                }
            }
        });
    };

    ISMListeners._wireDrumListeners = function() {
        // Drum category expand/collapse
        this.$$('.ism-drum-cat-header').forEach(function(header) {
            header.addEventListener('click', function(e) {
                if (e.target.closest('.ism-drum-cat-toggle')) return;
                header.closest('.ism-drum-category').classList.toggle('expanded');
            });
        });

        // Drum category toggle all
        this.$$('.ism-drum-cat-toggle').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const catId = btn.dataset.cat;
                const cat = InstrumentSettingsModal.DRUM_CATEGORIES[catId];
                if (!cat) return;
                const allChecked = cat.notes.every(function(n) { return this._drumSelectedNotes.has(n); }.bind(this));
                cat.notes.forEach(function(n) { allChecked ? this._drumSelectedNotes.delete(n) : this._drumSelectedNotes.add(n); }.bind(this));
                this._refreshDrumUI();
            }.bind(this));
        }.bind(this));

        // Drum note checkboxes
        this.$$('.ism-drum-note-cb').forEach(function(cb) {
            cb.addEventListener('change', function() {
                const note = parseInt(cb.dataset.note);
                cb.checked ? this._drumSelectedNotes.add(note) : this._drumSelectedNotes.delete(note);
                this._updateDrumCategoryBadge(cb.dataset.cat);
                this._updateDrumSummary();
            }.bind(this));
        }.bind(this));

        // Drum preset apply
        const applyPreset = this.$('.ism-drum-apply-preset');
        if (applyPreset) {
            applyPreset.addEventListener('click', function() {
                const sel = this.$('.ism-drum-preset-select');
                if (!sel || !sel.value) return;
                const preset = InstrumentSettingsModal.DRUM_PRESETS[sel.value];
                if (!preset) return;
                this._drumSelectedNotes = new Set(preset.notes);
                this._refreshDrumUI();
            }.bind(this));
        }
    };

    ISMListeners._wireChannelGridListeners = function() {
        this.$$('.ism-channel-btn:not([disabled])').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const ch = parseInt(btn.dataset.channel);
                const hiddenInput = this.$('#channelSelect');
                if (hiddenInput) hiddenInput.value = ch;
                this.$$('.ism-channel-btn').forEach(function(b) {
                    const bCh = parseInt(b.dataset.channel);
                    const color = InstrumentSettingsModal.CHANNEL_COLORS[bCh];
                    b.classList.toggle('active', bCh === ch);
                    b.style.background = bCh === ch ? color : '';
                    b.style.color = bCh === ch ? '#fff' : '';
                });
            }.bind(this));
        }.bind(this));
    };


    // ===== Identity picker listeners (family row / instrument grid / selected) =====

    /**
     * Build a minimal shim mimicking a <select> element so the legacy global
     * `onGmProgramChanged(selectEl)` keeps working unchanged. That global reads:
     *   - selectEl.value                              (parseInt)
     *   - selectEl.options[selectEl.selectedIndex]    (selected <option>)
     *   - option.hasAttribute('data-drum-kit')
     *   - option.getAttribute('data-desc')
     */
    ISMListeners._buildGmShim = function(encodedValue, isDrumKit, desc) {
        const attrs = {};
        if (isDrumKit) attrs['data-drum-kit'] = '';
        if (desc) attrs['data-desc'] = desc;
        const fakeOption = {
            hasAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
            getAttribute: function(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; }
        };
        return {
            value: String(encodedValue == null ? '' : encodedValue),
            selectedIndex: 0,
            options: [fakeOption]
        };
    };

    ISMListeners._rerenderIdentityPicker = function() {
        const wrap = this.$('.ism-identity-picker-wrap');
        if (!wrap) return;
        const existing = wrap.querySelector('.ism-identity-picker');
        const html = this._renderIdentityPicker();
        if (existing) {
            existing.outerHTML = html;
        } else {
            wrap.insertAdjacentHTML('beforeend', html);
        }
        this._wireIdentityPickerListeners();
        // Refresh the section-title emoji based on current program
        const tab = this._getActiveTab();
        const gmProgram = tab ? tab.settings.gm_program : null;
        const catKey = this._getGmCategoryKey(gmProgram);
        const gmEmoji = catKey ? (InstrumentSettingsModal.GM_CATEGORY_EMOJIS[catKey] || '🎵') : '🎵';
        const titleIcon = this.$('.ism-section[data-section="identity"] .ism-section-title-icon');
        if (titleIcon) titleIcon.textContent = gmEmoji;
    };

    ISMListeners._refreshNotesSectionForProgram = function() {
        // Refresh notes section (strings/drums subsections depend on gm_program)
        const notesSection = this.$('.ism-section[data-section="notes"]');
        if (notesSection) {
            notesSection.innerHTML = this._renderNotesSection();
            this._attachNotesSectionListeners();
            if (this.activeSection === 'notes') {
                this._initPianoForActiveTab();
            }
        }
        // Hands section + sidebar also depend on the GM program:
        //  - family change (piano → guitar) flips the hands mode
        //    semitones → frets; without this refresh the DOM still
        //    carries the old layout, so save sends a mismatched payload
        //    and the new server-side validator rejects it.
        //  - family change out of a supported family (→ flute) must hide
        //    the hands sidebar entry.
        this._refreshHandsSectionForProgram();
    };

    /**
     * Re-render the hands section and the sidebar entry driving it so
     * they stay in sync with the current `gm_program`. Safe no-op when
     * the hands section is not rendered.
     */
    ISMListeners._refreshHandsSectionForProgram = function() {
        const tab = this._getActiveTab();
        if (!tab) return;

        const showHands = typeof window.ISMSections?._shouldShowHandsSection === 'function'
            && window.ISMSections._shouldShowHandsSection(tab);

        // Sidebar: re-render in place so the hands nav item appears /
        // disappears according to the new family. Re-attach the nav click
        // listeners inline — they're the only listeners bound to
        // .ism-nav-item and replacing outerHTML drops the originals.
        const sidebar = this.$('.ism-sidebar');
        if (sidebar && typeof this._renderSidebar === 'function') {
            sidebar.outerHTML = this._renderSidebar();
            const self = this;
            this.$$('.ism-nav-item').forEach(function(btn) {
                btn.addEventListener('click', function() { self._switchSection(btn.dataset.section); });
            });
        }

        // Content section: when visible, swap its HTML; when hidden now,
        // drop it; when newly visible, inject it next to the other sections.
        const existing = this.$('.ism-section[data-section="hands"]');
        if (showHands) {
            const html = typeof window.ISMSections?._renderHandsSection === 'function'
                ? window.ISMSections._renderHandsSection.call(this)
                : '';
            if (existing) {
                existing.innerHTML = html;
            } else {
                const notes = this.$('.ism-section[data-section="notes"]');
                if (notes && notes.parentNode) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'ism-section' + (this.activeSection === 'hands' ? ' active' : '');
                    wrapper.setAttribute('data-section', 'hands');
                    wrapper.innerHTML = html;
                    notes.parentNode.insertBefore(wrapper, notes.nextSibling);
                }
            }
            if (typeof this._attachHandsSectionListeners === 'function') {
                this._attachHandsSectionListeners();
            }
        } else if (existing) {
            existing.remove();
            // If the user was viewing the hands section, fall back to notes.
            if (this.activeSection === 'hands' && typeof this._switchSection === 'function') {
                this._switchSection('notes');
            }
        }
    };

    ISMListeners._wireIdentityPickerListeners = function() {
        const self = this;

        // Family buttons → switch to instrument grid
        this.$$('.ism-family-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                self._identityUI = self._identityUI || { step: 'family', currentFamilySlug: null };
                self._identityUI.step = 'instruments';
                self._identityUI.currentFamilySlug = btn.dataset.family;
                self._rerenderIdentityPicker();
            });
        });

        // Back button → back to family row
        const backBtn = this.$('.ism-back-to-family');
        if (backBtn) {
            backBtn.addEventListener('click', function() {
                self._identityUI.step = 'family';
                self._rerenderIdentityPicker();
            });
        }

        // Instrument tile → select that program
        this.$$('.ism-instrument-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const encoded = parseInt(btn.dataset.program);
                const isDrumKit = btn.dataset.drumKit === 'true';
                const desc = btn.dataset.desc || '';
                self._selectProgram(encoded, isDrumKit, desc);
            });
        });

        // Edit → re-open instrument grid with current family preselected
        const editBtn = this.$('.ism-edit-instrument');
        if (editBtn) {
            editBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._identityUI.step = 'instruments';
                self._rerenderIdentityPicker();
            });
        }

        // Delete → confirm then clear
        const delBtn = this.$('.ism-delete-instrument');
        if (delBtn) {
            delBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._clearInstrument();
            });
        }

        // Add another GM instrument (secondary voice) from the Identity tab
        const addGmBtn = this.$('.ism-add-gm-instrument-btn');
        if (addGmBtn) {
            addGmBtn.addEventListener('click', function() {
                self._openVoicePicker();
            });
        }

        // Delete a secondary voice directly from the Identity tab.
        // _deleteVoiceAt rerenders both the Notes-tab list and this picker.
        this.$$('.ism-identity-voice-delete').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const row = btn.closest('.ism-selected-secondary');
                if (!row) return;
                const idx = parseInt(row.dataset.voiceIndex, 10);
                self._deleteVoiceAt(idx);
            });
        });

        // Click a GM instrument row to route the preview keyboard to it.
        this.$$('.ism-selected-instrument').forEach(function(row) {
            const activate = function() {
                const raw = row.dataset.voiceIndex;
                const idx = (raw === '' || raw == null) ? null : parseInt(raw, 10);
                self._setPreviewActiveVoice(idx);
            };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate();
                }
            });
        });
    };

    ISMListeners._selectProgram = function(encodedValue, isDrumKit, desc) {
        const tab = this._getActiveTab();
        const decoded = typeof selectValueToGmProgram === 'function'
            ? selectValueToGmProgram(encodedValue)
            : { program: encodedValue, isDrumKit: isDrumKit };

        // Pre-flight: a drum kit always lives on channel 10 (index 9).
        // If the user picked a drum kit on a different channel AND another
        // tab already occupies channel 9, silently forcing `tab.channel = 9`
        // would overwrite that other tab on save. Abort before any state
        // mutation so the user can free channel 9 manually first.
        if (isDrumKit && tab && tab.channel !== 9) {
            const collision = this.instrumentTabs.some(function(t) {
                return t.channel === 9 && t !== tab;
            });
            if (collision) {
                if (typeof showAlert === 'function') {
                    showAlert(
                        this.t('instrumentSettings.drumChannelOccupied') || 'Le canal 10 (percussions) est déjà utilisé par un autre instrument.',
                        { title: this.t('common.error') || 'Erreur', icon: '⚠️' }
                    );
                }
                return;
            }
        }

        // 1) Update hidden input (save path reads #gmProgramSelect)
        const hiddenSel = this.$('#gmProgramSelect');
        if (hiddenSel) hiddenSel.value = String(encodedValue);

        // 2) Update settings
        if (tab) {
            tab.settings.gm_program = decoded.program;
        }

        // 2b) When the user leaves the string-instrument family (piano
        // after a guitar, etc.), drop the string configuration so the
        // Active-CCs summary stops surfacing `String Select` / `Fret Select`
        // tags and the save path doesn't resend stale cc_string_number /
        // cc_fret_number values. Also clear them from `supported_ccs` if
        // they were manually added to the checkbox picker.
        if (tab && !isDrumKit && typeof isGmStringInstrument === 'function'
            && !isGmStringInstrument(decoded.program)) {
            const oldConfig = tab.stringInstrumentConfig;
            if (oldConfig) {
                const strCCs = new Set([
                    oldConfig.cc_string_number ?? 20,
                    oldConfig.cc_fret_number ?? 21
                ]);
                // Mark the row for backend deletion on next save. The
                // frontend clears the local cache immediately so the UI
                // refresh doesn't resurrect the tags.
                tab._stringInstrumentDeleted = true;
                tab.stringInstrumentConfig = null;
                if (Array.isArray(tab.settings.supported_ccs)) {
                    tab.settings.supported_ccs = tab.settings.supported_ccs.filter(function(cc) {
                        return !strCCs.has(cc);
                    });
                }
            }
        }

        // 3) Auto-switch channel 10 (index 9) for drum kits + repaint channel grid
        if (isDrumKit) {
            const channelInput = this.$('#channelSelect');
            if (channelInput) channelInput.value = 9;
            if (tab) tab.channel = 9;
            this.activeChannel = 9;
            this.$$('.ism-channel-btn').forEach(function(b) {
                const bCh = parseInt(b.dataset.channel);
                const color = InstrumentSettingsModal.CHANNEL_COLORS[bCh];
                b.classList.toggle('active', bCh === 9);
                b.style.background = bCh === 9 ? color : '';
                b.style.color = bCh === 9 ? '#fff' : '';
            });
        }

        this._syncGlobalState();

        // 4) Call legacy global through a shim so dependent sections react
        if (typeof onGmProgramChanged === 'function') {
            const shim = this._buildGmShim(encodedValue, isDrumKit, desc);
            try { onGmProgramChanged(shim); } catch (e) { console.warn('onGmProgramChanged shim error:', e); }
        }

        // 5) Send program_change so the preview keyboard plays the new bank
        const previewChannel = isDrumKit ? 9 : (tab ? tab.channel : 0);
        this._sendPreviewProgramChange(decoded.program, previewChannel);

        // 6) Refresh Notes section (may have revealed strings/drums subsection)
        this._refreshNotesSectionForProgram();

        // 7) Switch picker to selected state and rerender it only
        this._identityUI = this._identityUI || {};
        this._identityUI.step = 'selected';
        const fam = window.InstrumentFamilies
            ? window.InstrumentFamilies.getFamilyForProgram(decoded.program, isDrumKit ? 9 : (tab ? tab.channel : 0))
            : null;
        this._identityUI.currentFamilySlug = fam ? fam.slug : null;
        this._rerenderIdentityPicker();

        // 8) Refresh preview keyboard (may have switched piano ↔ drum pads)
        this._renderPreviewKeyboard();
    };

    ISMListeners._clearInstrument = function() {
        const self = this;
        const msg = this.t('instrumentSettings.deleteInstrumentConfirm')
            || 'Effacer le choix d\'instrument ?';
        const confirmFn = (typeof showConfirm === 'function') ? showConfirm : null;
        const done = function() {
            const tab = self._getActiveTab();
            if (tab) tab.settings.gm_program = null;
            const hiddenSel = self.$('#gmProgramSelect');
            if (hiddenSel) hiddenSel.value = '';
            self._syncGlobalState();
            // Hide drum kit notice/desc
            const desc = document.getElementById('drumKitDesc');
            if (desc) desc.style.display = 'none';
            const notice = document.getElementById('drumKitNotice');
            if (notice) notice.style.display = 'none';
            self._refreshNotesSectionForProgram();
            self._identityUI = { step: 'family', currentFamilySlug: null };
            self._rerenderIdentityPicker();
            self._previewAllNotesOff();
            self._renderPreviewKeyboard();
        };
        if (confirmFn) {
            Promise.resolve(confirmFn(msg, { title: self.t('common.confirm') || 'Confirmation', icon: '🗑️' }))
                .then(function(ok) { if (ok) done(); });
        } else if (window.confirm(msg)) {
            done();
        }
    };

    ISMListeners._attachNotesSectionListeners = function() {
        this._wireNotesModeListeners();
        this._wireDrumListeners();
        this._attachStringsSectionListeners();
        this._wireVoicesListeners();
        this._wireVoicesShareToggle();
        this._wireNotesVoiceTabs();
        this._wireCCAccordionListeners();
        this._wireApplyRecommendedCCs();
        this._wireActiveCCTagRemoval();
        this._wireHandsMovementToggle();
        this._wirePianoNotationToggle();
        // Piano is initialized by _switchSection('notes') when the section becomes visible
    };

    /**
     * Toggle between US ('C, D, E…') and latin ('Do, Ré, Mi…') note names
     * shown under each octave of the piano. The choice is persisted in
     * localStorage and shared by every piano renderer.
     */
    ISMListeners._wirePianoNotationToggle = function() {
        const btn = this.$('#pianoNotationToggle');
        if (!btn) return;
        const label = this.$('#pianoNotationLabel');
        const refreshLabel = function() {
            if (!label) return;
            const cur = (typeof getPianoNoteNotation === 'function') ? getPianoNoteNotation() : 'us';
            label.textContent = cur === 'latin' ? 'Do → C' : 'C → Do';
        };
        refreshLabel();
        btn.addEventListener('click', function() {
            if (typeof getPianoNoteNotation !== 'function' || typeof setPianoNoteNotation !== 'function') return;
            const next = getPianoNoteNotation() === 'latin' ? 'us' : 'latin';
            setPianoNoteNotation(next);
            refreshLabel();
            if (typeof renderPianoKeyboard === 'function') {
                renderPianoKeyboard();
            }
            if (typeof updatePianoOctaveIndicator === 'function') {
                updatePianoOctaveIndicator();
            }
        });
    };

    /**
     * Persist the "Gestion du déplacement des mains" toggle on the active
     * tab and rebuild the sidebar / hands section in place so the Mains
     * tab appears (or disappears, falling back to Notes) immediately.
     * The flag is stored on `hands_config.enabled` to keep one source of
     * truth shared with the existing payload shape.
     */
    ISMListeners._wireHandsMovementToggle = function() {
        const cb = this.$('#handsMovementEnabled');
        if (!cb) return;
        const self = this;
        cb.addEventListener('change', function() {
            const tab = self._getActiveTab();
            if (!tab) return;
            const mode = (window.ISMSections && window.ISMSections._handsModeForTab)
                ? window.ISMSections._handsModeForTab(tab)
                : 'semitones';
            const defaults = (window.ISMSections && window.ISMSections._defaultHandsConfig)
                ? window.ISMSections._defaultHandsConfig(mode, tab)
                : { enabled: true, mode: 'semitones', hands: [] };
            const existing = tab.settings.hands_config && typeof tab.settings.hands_config === 'object'
                ? tab.settings.hands_config
                : defaults;
            tab.settings.hands_config = Object.assign({}, defaults, existing, { enabled: !!cb.checked });
            if (typeof self._refreshHandsSectionForProgram === 'function') {
                self._refreshHandsSectionForProgram();
            }
        });
    };

    // ===== Grouped CC picker (accordion + active-CC tags + recommended) =====

    ISMListeners._wireCCAccordionListeners = function() {
        const self = this;
        this.$$('.ism-cc-group-header').forEach(function(header) {
            header.addEventListener('click', function() {
                header.closest('.ism-cc-group').classList.toggle('expanded');
            });
        });
        this.$$('.ism-cc-checkbox').forEach(function(cb) {
            cb.addEventListener('change', function() {
                cb.closest('.ism-cc-item').classList.toggle('checked', cb.checked);
                self._updateCCHiddenInput();
                self._updateCCGroupBadges();
                self._updateActiveCCsSummary();
            });
        });
    };

    ISMListeners._wireApplyRecommendedCCs = function() {
        const btn = this.$('#applyRecommendedCCs');
        if (!btn) return;
        const self = this;
        btn.addEventListener('click', function() { self._applyRecommendedCCs(); });
    };

    ISMListeners._wireActiveCCTagRemoval = function() {
        // Event delegation — summary DOM is rebuilt on every change.
        const summary = this.$('#activeCCsSummary');
        if (!summary) return;
        const self = this;
        summary.addEventListener('click', function(e) {
            const removeBtn = e.target.closest('.ism-cc-tag-remove');
            if (!removeBtn) return;
            e.stopPropagation();
            const ccNum = parseInt(removeBtn.dataset.cc);
            if (isNaN(ccNum)) return;
            const cb = self.$(`.ism-cc-checkbox[value="${ccNum}"]`);
            if (cb) {
                cb.checked = false;
                const item = cb.closest('.ism-cc-item');
                if (item) item.classList.remove('checked');
            }
            self._updateCCHiddenInput();
            self._updateCCGroupBadges();
            self._updateActiveCCsSummary();
        });
    };

    ISMListeners._applyRecommendedCCs = function() {
        const tab = this._getActiveTab();
        if (!tab) return;
        const catKey = this._getGmCategoryKey(tab.settings.gm_program);
        const recommended = catKey ? (InstrumentSettingsModal.GM_RECOMMENDED_CCS[catKey] || []) : [];
        if (recommended.length === 0) return;
        this.$$('.ism-cc-checkbox').forEach(function(cb) {
            const ccNum = parseInt(cb.value);
            if (recommended.includes(ccNum)) {
                cb.checked = true;
                cb.closest('.ism-cc-item')?.classList.add('checked');
            }
        });
        this._updateCCHiddenInput();
        this._updateCCGroupBadges();
        this._updateActiveCCsSummary();
    };

    ISMListeners._updateCCHiddenInput = function() {
        const selected = [];
        this.$$('.ism-cc-checkbox:checked').forEach(function(c) { selected.push(parseInt(c.value)); });
        const hidden = this.$('#supportedCCs');
        if (hidden) hidden.value = selected.join(', ');
    };

    ISMListeners._updateActiveCCsSummary = function() {
        const summary = this.$('#activeCCsSummary');
        if (!summary) return;
        const selected = [];
        this.$$('.ism-cc-checkbox:checked').forEach(function(c) { selected.push(parseInt(c.value)); });
        summary.innerHTML = this._renderActiveCCsSummary(selected);
    };

    ISMListeners._updateCCGroupBadges = function() {
        const groups = InstrumentSettingsModal.CC_GROUPS;
        for (const groupId of Object.keys(groups)) {
            const groupEl = this.$(`.ism-cc-group[data-group="${groupId}"]`);
            if (!groupEl) continue;
            const cbs = groupEl.querySelectorAll('.ism-cc-checkbox');
            const checkedCount = groupEl.querySelectorAll('.ism-cc-checkbox:checked').length;
            const badge = groupEl.querySelector('.ism-cc-group-badge');
            if (badge) badge.textContent = `${checkedCount}/${cbs.length}`;
        }
    };

    // ===== "Voices share notes" checkbox + per-voice Notes tabs =====

    ISMListeners._wireVoicesShareToggle = function() {
        const cb = this.$('#voicesShareNotesCheckbox');
        if (!cb) return;
        const self = this;
        cb.addEventListener('change', function() {
            const tab = self._getActiveTab();
            if (!tab) return;
            // Persist the user's current editor state before we flip modes,
            // so any unsaved primary/voice tweaks survive the rerender.
            if (typeof self._commitCurrentNotesEditor === 'function') {
                self._commitCurrentNotesEditor();
            }
            const share = cb.checked;
            tab.settings.voices_share_notes = share ? 1 : 0;
            // When turning sharing OFF, seed any voice that still has null
            // notes with the primary's current values so the per-voice
            // editor starts from a sensible baseline.
            if (!share && Array.isArray(tab.voices)) {
                for (const v of tab.voices) {
                    if (v.note_selection_mode == null && v.note_range_min == null
                        && v.note_range_max == null && v.octave_mode == null
                        && (!Array.isArray(v.selected_notes) || v.selected_notes.length === 0)) {
                        v.note_selection_mode = tab.settings.note_selection_mode || 'range';
                        v.note_range_min = tab.settings.note_range_min ?? null;
                        v.note_range_max = tab.settings.note_range_max ?? null;
                        v.octave_mode = tab.settings.octave_mode || 'chromatic';
                        v.selected_notes = Array.isArray(tab.settings.selected_notes)
                            ? [...tab.settings.selected_notes] : null;
                    }
                }
            }
            // When sharing is ON the tab selector is hidden; reset the
            // active voice to primary so a later unshare starts cleanly.
            if (share) self._activeNotesVoiceIdx = null;
            self._refreshNotesSectionForProgram();
            if (self.activeSection === 'notes') self._initPianoForActiveTab();
        });
    };

    ISMListeners._wireNotesVoiceTabs = function() {
        const self = this;
        this.$$('#notesVoiceTabs .ism-notes-voice-tab').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const raw = btn.dataset.voiceIdx;
                const idx = (raw === '' || raw == null) ? null : parseInt(raw, 10);
                if (self._activeNotesVoiceIdx === idx) return;
                if (typeof self._commitCurrentNotesEditor === 'function') {
                    self._commitCurrentNotesEditor();
                }
                self._activeNotesVoiceIdx = idx;
                self._refreshNotesSectionForProgram();
                if (self.activeSection === 'notes') self._initPianoForActiveTab();
            });
        });
    };

    // ===== Multi-GM voices (per-voice timing rows in the ⏱️ Timings subsection) =====

    ISMListeners._wireVoicesListeners = function() {
        const self = this;

        // Param edits (interval / duration / ccs) -> mutate tab.voices in-place.
        // Add/delete are handled from the Identity tab; no buttons here.
        this.$$('.ism-voice-row').forEach(function(row) {
            const idx = parseInt(row.dataset.voiceIndex, 10);
            const intervalEl = row.querySelector('.ism-voice-interval');
            const durationEl = row.querySelector('.ism-voice-duration');
            const ccsEl = row.querySelector('.ism-voice-ccs-input');
            const tab = self._getActiveTab();
            if (!tab || !Array.isArray(tab.voices) || !tab.voices[idx]) return;
            if (intervalEl) {
                intervalEl.addEventListener('input', function() {
                    const v = intervalEl.value.trim();
                    tab.voices[idx].min_note_interval = v === '' ? null : parseInt(v, 10);
                });
            }
            if (durationEl) {
                durationEl.addEventListener('input', function() {
                    const v = durationEl.value.trim();
                    tab.voices[idx].min_note_duration = v === '' ? null : parseInt(v, 10);
                });
            }
            if (ccsEl) {
                ccsEl.addEventListener('input', function() {
                    const parts = ccsEl.value
                        .split(',')
                        .map(function(s) { return parseInt(s.trim(), 10); })
                        .filter(function(n) { return Number.isFinite(n) && n >= 0 && n <= 127; });
                    tab.voices[idx].supported_ccs = parts.length === 0 ? null : parts;
                });
            }
        });
    };

    ISMListeners._deleteVoiceAt = function(idx) {
        const tab = this._getActiveTab();
        if (!tab || !Array.isArray(tab.voices)) return;
        if (idx < 0 || idx >= tab.voices.length) return;
        tab.voices.splice(idx, 1);

        // Keep per-voice pointers (preview routing + active Notes voice tab)
        // consistent with the spliced list.
        const reconcile = (cur) => {
            if (cur == null) return null;
            if (cur === idx) return null;        // active voice removed → primary
            if (cur > idx) return cur - 1;       // earlier voice removed → shift
            return cur;
        };
        this._previewActiveVoice = reconcile(this._previewActiveVoice);
        this._activeNotesVoiceIdx = reconcile(this._activeNotesVoiceIdx);

        this._rerenderVoicesSubsection();
        this._rerenderIdentityPicker();
        this._renderPreviewKeyboard();
        // If we're looking at the Notes section, the voice tabs and editor
        // may reference the deleted voice — force a rerender.
        if (this.activeSection === 'notes') {
            this._refreshNotesSectionForProgram();
            this._initPianoForActiveTab();
        }
    };

    /**
     * Rerender just the voices list inside the ⏱️ Timings subsection. The
     * primary block is left untouched so unsaved input in `#minNoteInterval`
     * / `#minNoteDuration` is preserved across voice add/delete.
     */
    ISMListeners._rerenderVoicesSubsection = function() {
        const list = this.$('#timingsVoicesList');
        if (!list) return;
        list.innerHTML = this._renderVoicesSubsection();
        this._wireVoicesListeners();
    };

    ISMListeners._openVoicePicker = function() {
        const self = this;
        const families = (window.InstrumentFamilies && window.InstrumentFamilies.getAllFamilies()) || [];

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay ism-voice-picker-overlay';
        overlay.style.zIndex = '10002';
        overlay.innerHTML = `
            <div class="modal-content ism-voice-picker-content">
                <div class="modal-header">
                    <h2>${self.escape(self.t('instrumentSettings.pickFamily') || 'Choisir une famille')}</h2>
                    <button class="modal-close" data-voice-close>×</button>
                </div>
                <div class="ism-voice-picker-body" data-step="family">
                    ${self._renderVoicePickerFamilies(families)}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = function() { overlay.remove(); };
        overlay.querySelector('[data-voice-close]').addEventListener('click', close);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });

        // Family click -> show instrument grid
        overlay.querySelectorAll('.ism-family-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const slug = btn.dataset.family;
                const fam = window.InstrumentFamilies.getFamilyBySlug(slug);
                if (!fam) return;
                const body = overlay.querySelector('.ism-voice-picker-body');
                body.dataset.step = 'instruments';
                body.innerHTML = self._renderVoicePickerInstruments(fam);
                // Back button
                const back = overlay.querySelector('.ism-back-to-family');
                if (back) back.addEventListener('click', function() {
                    body.dataset.step = 'family';
                    body.innerHTML = self._renderVoicePickerFamilies(families);
                    self._rewireVoicePickerOverlay(overlay, families, close);
                });
                // Instrument tile click
                overlay.querySelectorAll('.ism-instrument-btn').forEach(function(iBtn) {
                    iBtn.addEventListener('click', function() {
                        const encoded = parseInt(iBtn.dataset.program, 10);
                        const isDrum = iBtn.dataset.drumKit === 'true';
                        self._addVoice(encoded, isDrum);
                        close();
                    });
                });
            });
        });
    };

    ISMListeners._rewireVoicePickerOverlay = function(overlay, families, close) {
        const self = this;
        overlay.querySelectorAll('.ism-family-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const slug = btn.dataset.family;
                const fam = window.InstrumentFamilies.getFamilyBySlug(slug);
                if (!fam) return;
                const body = overlay.querySelector('.ism-voice-picker-body');
                body.dataset.step = 'instruments';
                body.innerHTML = self._renderVoicePickerInstruments(fam);
                const back = overlay.querySelector('.ism-back-to-family');
                if (back) back.addEventListener('click', function() {
                    body.dataset.step = 'family';
                    body.innerHTML = self._renderVoicePickerFamilies(families);
                    self._rewireVoicePickerOverlay(overlay, families, close);
                });
                overlay.querySelectorAll('.ism-instrument-btn').forEach(function(iBtn) {
                    iBtn.addEventListener('click', function() {
                        const encoded = parseInt(iBtn.dataset.program, 10);
                        const isDrum = iBtn.dataset.drumKit === 'true';
                        self._addVoice(encoded, isDrum);
                        close();
                    });
                });
            });
        });
    };

    ISMListeners._renderVoicePickerFamilies = function(families) {
        const self = this;
        const btns = families.map(function(fam) {
            const label = self.t(fam.labelKey) || fam.slug;
            const svg = window.InstrumentFamilies.familyIconUrl(fam.slug);
            return `<button type="button" class="ism-family-btn" data-family="${fam.slug}" title="${self.escape(label)}">
                <span class="ism-family-icon">
                    <img class="ism-family-svg" src="${svg}" alt=""
                        onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                    <span class="ism-family-emoji" style="display:none">${fam.emoji}</span>
                </span>
                <span class="ism-family-label">${self.escape(label)}</span>
            </button>`;
        }).join('');
        return `<div class="ism-family-row">${btns}</div>`;
    };

    ISMListeners._renderVoicePickerInstruments = function(fam) {
        const self = this;
        const tab = this._getActiveTab();
        const channel = tab ? tab.channel : 0;
        const backLabel = this.t('instrumentSettings.backToFamily') || 'Familles';
        const famLabel = this.t(fam.labelKey) || fam.slug;
        let tiles = '';
        if (fam.isDrumKits) {
            const kits = window.InstrumentFamilies.GM_DRUM_KITS_LIST;
            const offset = (typeof GM_DRUM_KIT_OFFSET !== 'undefined') ? GM_DRUM_KIT_OFFSET : 128;
            tiles = kits.map(function(kit) {
                const encoded = kit.program + offset;
                const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: encoded, channel: 9 });
                const kitName = icon.name || kit.name;
                return `<button type="button" class="ism-instrument-btn" data-program="${encoded}" data-drum-kit="true" title="${self.escape(kitName)}">
                    <span class="ism-inst-icon">
                        ${icon.slug ? `<img class="ism-inst-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-inst-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-inst-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-inst-number">${kit.program}</span>
                    <span class="ism-inst-name">${self.escape(kitName)}</span>
                </button>`;
            }).join('');
        } else {
            tiles = fam.programs.map(function(p) {
                const icon = window.InstrumentFamilies.resolveInstrumentIcon({ gmProgram: p, channel: channel });
                const name = (typeof getGMInstrumentName === 'function') ? getGMInstrumentName(p) : ('Program ' + p);
                return `<button type="button" class="ism-instrument-btn" data-program="${p}" data-drum-kit="false" title="${self.escape(name)}">
                    <span class="ism-inst-icon">
                        ${icon.slug ? `<img class="ism-inst-svg" src="${icon.svgUrl}" alt=""
                            onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">
                        <span class="ism-inst-emoji" style="display:none">${icon.emoji}</span>`
                        : `<span class="ism-inst-emoji">${icon.emoji}</span>`}
                    </span>
                    <span class="ism-inst-number">${p}</span>
                    <span class="ism-inst-name">${self.escape(name)}</span>
                </button>`;
            }).join('');
        }
        return `<div class="ism-instrument-grid-header">
                <button type="button" class="ism-back-to-family">◀ ${this.escape(backLabel)}</button>
                <span class="ism-instrument-grid-family">${fam.emoji} ${this.escape(famLabel)}</span>
            </div>
            <div class="ism-instrument-grid">${tiles}</div>`;
    };

    ISMListeners._addVoice = function(encodedValue, isDrumKit) {
        const tab = this._getActiveTab();
        if (!tab) return;
        if (!Array.isArray(tab.voices)) tab.voices = [];
        const decoded = typeof selectValueToGmProgram === 'function'
            ? selectValueToGmProgram(encodedValue)
            : { program: encodedValue, isDrumKit: isDrumKit };
        // Store raw GM program for melodic; for drum kits we keep the encoded offset so the UI/resolver can distinguish
        const storedProgram = isDrumKit ? (decoded.program + (typeof GM_DRUM_KIT_OFFSET !== 'undefined' ? GM_DRUM_KIT_OFFSET : 128)) : decoded.program;
        tab.voices.push({
            id: null,   // assigned by backend on save
            gm_program: storedProgram,
            min_note_interval: null,
            min_note_duration: null,
            supported_ccs: null
        });
        // Keep both the Notes-tab voices list and the Identity-tab voices list in sync.
        this._rerenderVoicesSubsection();
        this._rerenderIdentityPicker();
    };

    ISMListeners._attachIdentitySectionListeners = function() {
        this._wireChannelGridListeners();
        this._wireIdentityPickerListeners();
        this._wireOmniToggleListener();
    };

    ISMListeners._wireOmniToggleListener = function() {
        const toggle = this.$('#omniModeToggle');
        if (!toggle) return;
        const self = this;
        toggle.addEventListener('click', function() {
            const hidden = self.$('#omniModeInput');
            const isOn = hidden && hidden.value === '1';
            const nextOn = !isOn;
            if (hidden) hidden.value = nextOn ? '1' : '0';
            toggle.classList.toggle('active', nextOn);
            toggle.setAttribute('aria-pressed', nextOn ? 'true' : 'false');

            // Disable/enable the channel grid buttons (except the already-used ones)
            const grid = self.$('#channelGrid');
            if (grid) grid.classList.toggle('ism-channel-grid-disabled', nextOn);
            const currentCh = self.activeChannel;
            const used = self.instrumentTabs.map(function(t) { return t.channel; }).filter(function(ch) { return ch !== currentCh; });
            self.$$('.ism-channel-btn').forEach(function(btn) {
                const ch = parseInt(btn.dataset.channel);
                const isUsed = used.includes(ch);
                btn.disabled = nextOn || (isUsed && ch !== currentCh);
            });

            // Update the hint text inline without a full rerender
            const hint = toggle.parentElement && toggle.parentElement.querySelector('.ism-form-hint');
            if (hint) {
                hint.textContent = nextOn
                    ? (self.t('instrumentSettings.omniModeActiveHint') || 'Cet instrument reçoit les notes sur n\'importe quel canal — le choix du canal est ignoré.')
                    : (self.t('instrumentSettings.midiChannelHelp') || 'Canal MIDI utilisé par cet instrument');
            }
        });
    };

    ISMListeners._measureDelay = function() {
        // Mic-based delay measurement
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (typeof showAlert === 'function') {
                showAlert(this.t('instrumentSettings.micNotAvailable') || 'Le microphone n\'est pas disponible dans ce navigateur.', { title: i18n.t('common.error') || 'Erreur', icon: '❌' });
            }
            return;
        }
        const btn = this.$('#measureDelayBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = this.t('instrumentSettings.measureListening') || '🎤 Écoute...';
        }

        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const threshold = 140;
            let detected = false;

            const cleanup = () => {
                clearInterval(checkInterval);
                stream.getTracks().forEach(function(t) { t.stop(); });
                audioCtx.close().catch(() => {});
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🎤 ' + (this.t('instrumentSettings.measureDelay') || 'Mesurer');
                }
                this._micTestCleanup = null;
            };

            this._micTestCleanup = cleanup;

            // Start chrono and trigger the MIDI note only once the mic stream is live,
            // so the measurement excludes the permission-prompt delay.
            const startTime = performance.now();
            if (this.api && this.device) {
                try {
                    this.api.sendCommand('midi_send_note', {
                        deviceId: this.device.id,
                        channel: this.activeChannel,
                        note: 60,
                        velocity: 100,
                        duration: 100
                    });
                } catch (e) { /* ignore */ }
            }

            var checkInterval = setInterval(function() {
                analyser.getByteTimeDomainData(dataArray);
                for (let i = 0; i < dataArray.length; i++) {
                    if (dataArray[i] > threshold || dataArray[i] < (256 - threshold)) {
                        detected = true;
                        break;
                    }
                }
                if (detected) {
                    const delay = Math.round(performance.now() - startTime);
                    cleanup();

                    const syncInput = this.$('#syncDelay');
                    if (syncInput) syncInput.value = delay;
                }
            }.bind(this), 10);

            // Timeout after 5s
            setTimeout(function() {
                if (!detected) {
                    cleanup();
                }
            }, 5000);
        }.bind(this)).catch(function() {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🎤 ' + (this.t('instrumentSettings.measureDelay') || 'Mesurer');
            }
        }.bind(this));
    };

    ISMListeners._detectMicAndToggleMeasureBtn = function() {
        const btn = this.$('#measureDelayBtn');
        if (!btn) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        navigator.mediaDevices.enumerateDevices().then(function(devices) {
            const hasMic = devices.some(function(d) { return d.kind === 'audioinput'; });
            if (hasMic) btn.style.display = '';
        }).catch(function() { /* no permission / not supported → stay hidden */ });
    };

    // ========== MAIN EVENT LISTENERS ==========

    ISMListeners._attachListeners = function() {
        // Sidebar nav
        this.$$('.ism-nav-item').forEach(function(btn) {
            btn.addEventListener('click', function() { this._switchSection(btn.dataset.section); }.bind(this));
        }.bind(this));

        // Tabs
        this.$$('.ism-tab[data-channel]').forEach(function(btn) {
            btn.addEventListener('click', function() { this._switchTab(parseInt(btn.dataset.channel)); }.bind(this));
        }.bind(this));
        const addBtn = this.$('.ism-tab-add');
        if (addBtn) addBtn.addEventListener('click', function() { this._addTab(); }.bind(this));

        // Footer buttons
        const saveBtn = this.$('.ism-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', function() { this._save(); }.bind(this));
        const cancelBtn = this.$('.ism-cancel-btn');
        // Cancel is itself an explicit "discard changes" action — skip the
        // unsaved-changes confirmation so the user isn't prompted twice.
        if (cancelBtn) cancelBtn.addEventListener('click', function() {
            this._forceClose = true;
            this.close();
        }.bind(this));
        const deleteBtn = this.$('.ism-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', function() { this._deleteTab(); }.bind(this));

        // Section-specific listeners
        this._attachIdentitySectionListeners();
        this._attachNotesSectionListeners();
        this._attachHandsSectionListeners();

        // Measure delay button — hidden by default, revealed only if an audio input is detected
        const measureBtn = this.$('#measureDelayBtn');
        if (measureBtn) {
            measureBtn.addEventListener('click', function() { this._measureDelay(); }.bind(this));
            this._detectMicAndToggleMeasureBtn();
        }
    };

    /**
     * Wire live behaviours for the Hands section:
     *   - mechanism cards: click to switch the active mechanism, which
     *     re-renders the per-mechanism form below.
     *   - geometry preset dropdown: auto-fill scale_length_mm,
     *     num_strings, num_frets when a preset is picked.
     *   - geometry inputs: write changes back to tab.stringInstrumentConfig
     *     so a save persists them alongside hands_config.
     *
     * When the section is not rendered (instrument family without
     * hand-position support, or the toggle in Notes & Capacités is
     * off) this is a no-op.
     */
    ISMListeners._attachHandsSectionListeners = function() {
        const handsSection = this.$('.ism-section[data-section="hands"]');
        if (!handsSection) return;

        this._attachMechanismCardListeners(handsSection);
        this._attachHandsGeometryListeners(handsSection);
    };

    /**
     * Click handler for the 3 mechanism cards. Sets the hidden
     * `#handsMechanismInput`, marks the active card visually, and
     * re-renders the section so the per-mechanism form (which fields
     * are shown) reflects the new choice. The V2 (`independent_fingers`)
     * card is `disabled`, so clicks are ignored by the browser; we
     * still defensively check the data attribute.
     * @private
     */
    ISMListeners._attachMechanismCardListeners = function(handsSection) {
        const cards = handsSection.querySelectorAll('.ism-mech-card[data-mechanism]');
        if (!cards.length) return;
        const self = this;
        cards.forEach(function(card) {
            card.addEventListener('click', function(e) {
                e.preventDefault();
                const id = card.dataset.mechanism;
                if (!id) return;
                const hidden = handsSection.querySelector('#handsMechanismInput');
                if (hidden) hidden.value = id;
                // Update the in-memory cfg so the re-render uses it.
                const tab = self._getActiveTab();
                if (tab && tab.settings) {
                    if (!tab.settings.hands_config) tab.settings.hands_config = {};
                    tab.settings.hands_config.mechanism = id;
                }
                self._refreshHandsSection();
            });
        });
    };

    /**
     * Geometry preset + manual inputs. Picking a preset fills the
     * three numeric fields (scale_length_mm, num_strings, num_frets)
     * and mirrors them into `tab.stringInstrumentConfig` so the live
     * mechanism form (e.g. mm-based reach) reads coherent values.
     * Manual edits to any of the three inputs also propagate to
     * `stringInstrumentConfig` so a save persists them.
     * @private
     */
    ISMListeners._attachHandsGeometryListeners = function(handsSection) {
        const presetSelect = handsSection.querySelector('#handsGeometryPreset');
        const scaleInput = handsSection.querySelector('#handsGeometryScaleLength');
        const stringsInput = handsSection.querySelector('#handsGeometryNumStrings');
        const fretsInput = handsSection.querySelector('#handsGeometryNumFrets');
        const self = this;

        const ensureCfg = (tab) => {
            if (!tab) return null;
            if (!tab.stringInstrumentConfig) {
                tab.stringInstrumentConfig = {};
            }
            return tab.stringInstrumentConfig;
        };

        if (presetSelect) {
            presetSelect.addEventListener('change', function() {
                const opt = presetSelect.selectedOptions && presetSelect.selectedOptions[0];
                if (!opt || !opt.value) return; // "Personnalisé"
                const tab = self._getActiveTab();
                const cfg = ensureCfg(tab);
                if (!cfg) return;

                const scaleMm = parseInt(opt.dataset.scaleLengthMm, 10);
                const numStrings = parseInt(opt.dataset.numStrings, 10);
                const numFrets = parseInt(opt.dataset.numFrets, 10);
                const defaultMechanism = opt.dataset.defaultMechanism;

                if (Number.isFinite(scaleMm)) {
                    cfg.scale_length_mm = scaleMm;
                    if (scaleInput) scaleInput.value = String(scaleMm);
                }
                if (Number.isFinite(numStrings)) {
                    cfg.num_strings = numStrings;
                    if (stringsInput) stringsInput.value = String(numStrings);
                    // String instruments pin polyphony to the string count
                    // — keep the hidden Notes-tab field in sync.
                    self._syncPolyphonyToNumStrings(numStrings);
                }
                if (Number.isFinite(numFrets)) {
                    cfg.num_frets = numFrets;
                    if (fretsInput) fretsInput.value = String(numFrets);
                }

                // Apply the recommended mechanism only when the user
                // hasn't already explicitly picked one (i.e. when the
                // current value is the default).
                const VALID = new Set(['string_sliding_fingers', 'fret_sliding_fingers']);
                if (defaultMechanism && VALID.has(defaultMechanism)
                        && tab.settings?.hands_config) {
                    tab.settings.hands_config.mechanism = defaultMechanism;
                    const hidden = handsSection.querySelector('#handsMechanismInput');
                    if (hidden) hidden.value = defaultMechanism;
                }

                self._refreshHandsSection();
            });
        }

        const wireNumericInput = (input, key, onChange) => {
            if (!input) return;
            input.addEventListener('change', function() {
                const tab = self._getActiveTab();
                const cfg = ensureCfg(tab);
                if (!cfg) return;
                const v = parseInt(input.value, 10);
                cfg[key] = Number.isFinite(v) ? v : null;
                if (typeof onChange === 'function') onChange(cfg[key]);
            });
        };
        wireNumericInput(scaleInput, 'scale_length_mm');
        wireNumericInput(stringsInput, 'num_strings', function(v) {
            // Polyphony tracks num_strings on string instruments, even
            // when the user edits it from the Main tab.
            if (Number.isFinite(v) && v > 0) self._syncPolyphonyToNumStrings(v);
        });
        wireNumericInput(fretsInput, 'num_frets');
    };

    /**
     * Re-render just the Hands section in place — used when a user
     * action (mechanism switch, preset pick) changes which fields
     * should appear without affecting any other section.
     * @private
     */
    ISMListeners._refreshHandsSection = function() {
        const sectionEl = this.$('.ism-section[data-section="hands"]');
        if (!sectionEl) return;
        if (typeof window.ISMSections?._renderHandsSection !== 'function') return;
        sectionEl.innerHTML = window.ISMSections._renderHandsSection.call(this);
        if (typeof this._attachHandsSectionListeners === 'function') {
            this._attachHandsSectionListeners();
        }
    };

    if (typeof window !== 'undefined') window.ISMListeners = ISMListeners;
})();
