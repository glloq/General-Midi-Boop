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
            }.bind(this));
        }

        // Init neck diagram
        this._initNeckDiagram();
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

        // Wire fret inputs -> neck diagram sync
        this.$$('.si-frets-val').forEach(function(input) {
            input.addEventListener('change', function() {
                if (!this._neckDiagram) return;
                const idx = parseInt(input.id.replace('siFrets', ''));
                if (isNaN(idx)) return;
                const val = parseInt(input.value) || 0;
                this._neckDiagram.fretsPerString[idx] = Math.max(0, Math.min(36, val));
                this._neckDiagram.redraw();
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
            editBtn.addEventListener('click', function() {
                self._identityUI.step = 'instruments';
                self._rerenderIdentityPicker();
            });
        }

        // Delete → confirm then clear
        const delBtn = this.$('.ism-delete-instrument');
        if (delBtn) {
            delBtn.addEventListener('click', function() {
                self._clearInstrument();
            });
        }
    };

    ISMListeners._selectProgram = function(encodedValue, isDrumKit, desc) {
        const tab = this._getActiveTab();
        const decoded = typeof selectValueToGmProgram === 'function'
            ? selectValueToGmProgram(encodedValue)
            : { program: encodedValue, isDrumKit: isDrumKit };

        // 1) Update hidden input (save path reads #gmProgramSelect)
        const hiddenSel = this.$('#gmProgramSelect');
        if (hiddenSel) hiddenSel.value = String(encodedValue);

        // 2) Update settings
        if (tab) {
            tab.settings.gm_program = decoded.program;
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
        // Piano is initialized by _switchSection('notes') when the section becomes visible
    };

    // ===== Multi-GM voices (Notes subsection) =====

    ISMListeners._wireVoicesListeners = function() {
        const self = this;

        // Add voice button -> picker overlay
        const addBtn = this.$('.ism-voice-add-btn');
        if (addBtn) {
            addBtn.addEventListener('click', function() { self._openVoicePicker(); });
        }

        // Delete voice
        this.$$('.ism-voice-delete').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const row = btn.closest('.ism-voice-row');
                if (!row) return;
                const idx = parseInt(row.dataset.voiceIndex, 10);
                self._deleteVoiceAt(idx);
            });
        });

        // Param edits (interval / duration / ccs) -> mutate tab.voices in-place
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
        this._rerenderVoicesSubsection();
    };

    ISMListeners._rerenderVoicesSubsection = function() {
        const sub = this.$('#voicesSubsection');
        if (!sub) return;
        // Preserve subsection title, replace only list + add btn
        const titleEl = sub.querySelector('.ism-subsection-title');
        const hintEl = sub.querySelector('.ism-subsection-hint');
        sub.innerHTML = (titleEl ? titleEl.outerHTML : '')
            + (hintEl ? hintEl.outerHTML : '')
            + this._renderVoicesSubsection();
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
        this._rerenderVoicesSubsection();
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
        if (cancelBtn) cancelBtn.addEventListener('click', function() { this.close(); }.bind(this));
        const deleteBtn = this.$('.ism-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', function() { this._deleteTab(); }.bind(this));

        // Section-specific listeners
        this._attachIdentitySectionListeners();
        this._attachNotesSectionListeners();

        // Measure delay button — hidden by default, revealed only if an audio input is detected
        const measureBtn = this.$('#measureDelayBtn');
        if (measureBtn) {
            measureBtn.addEventListener('click', function() { this._measureDelay(); }.bind(this));
            this._detectMicAndToggleMeasureBtn();
        }
    };

    if (typeof window !== 'undefined') window.ISMListeners = ISMListeners;
})();
