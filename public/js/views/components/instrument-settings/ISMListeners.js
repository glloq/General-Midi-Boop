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
            const w = wrapper?.clientWidth || 400;
            canvas.width = w;
            canvas.height = Math.max(120, numStrings * 22 + 36);

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
                const NOTE_NAMES = (typeof MidiConstants !== 'undefined') ? MidiConstants.NOTE_NAMES : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
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

    ISMListeners._wireCCAccordionListeners = function() {
        // CC group expand/collapse
        this.$$('.ism-cc-group-header').forEach(function(header) {
            header.addEventListener('click', function() {
                header.closest('.ism-cc-group').classList.toggle('expanded');
            });
        });

        // CC checkboxes
        this.$$('.ism-cc-checkbox').forEach(function(cb) {
            cb.addEventListener('change', function() {
                cb.closest('.ism-cc-item').classList.toggle('checked', cb.checked);
                this._updateCCHiddenInput();
                this._updateCCGroupBadges();
            }.bind(this));
        }.bind(this));
    };

    ISMListeners._applyRecommendedCCs = function() {
        const tab = this._getActiveTab();
        if (!tab) return;
        const catKey = this._getGmCategoryKey(tab.settings.gm_program);
        const recommended = catKey ? (InstrumentSettingsModal.GM_RECOMMENDED_CCS[catKey] || []) : [];
        if (recommended.length === 0) return;

        // Check all recommended CCs
        this.$$('.ism-cc-checkbox').forEach(function(cb) {
            const ccNum = parseInt(cb.value);
            if (recommended.includes(ccNum)) {
                cb.checked = true;
                cb.closest('.ism-cc-item')?.classList.add('checked');
            }
        });
        this._updateCCHiddenInput();
        this._updateCCGroupBadges();
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

    ISMListeners._wireSysExButton = function() {
        const sysexBtn = this.$('#sysexRequestBtn');
        if (sysexBtn) {
            sysexBtn.addEventListener('click', function() {
                this._requestSysExIdentity();
            }.bind(this));
        }
    };

    ISMListeners._wireGmProgramChange = function() {
        const gmSelect = this.$('#gmProgramSelect');
        if (gmSelect) {
            gmSelect.addEventListener('change', function() {
                const tab = this._getActiveTab();
                if (tab) {
                    const rawVal = parseInt(gmSelect.value);
                    const decoded = typeof selectValueToGmProgram === 'function'
                        ? selectValueToGmProgram(rawVal) : { program: rawVal, isDrumKit: false };
                    tab.settings.gm_program = decoded.program;
                    this._syncGlobalState();
                }
                if (typeof onGmProgramChanged === 'function') onGmProgramChanged(gmSelect);

                // Refresh notes section (strings/drums subsections depend on GM)
                const notesSection = this.$('.ism-section[data-section="notes"]');
                if (notesSection) {
                    notesSection.innerHTML = this._renderNotesSection();
                    this._attachNotesSectionListeners();
                    // Re-init piano if notes section is currently visible
                    if (this.activeSection === 'notes') {
                        this._initPianoForActiveTab();
                    }
                }

                // Refresh identity section (emoji changes)
                const identitySection = this.$('.ism-section[data-section="identity"]');
                if (identitySection) {
                    identitySection.innerHTML = this._renderIdentitySection();
                    this._attachIdentitySectionListeners();
                }
            }.bind(this));
        }
    };

    ISMListeners._attachNotesSectionListeners = function() {
        this._wireNotesModeListeners();
        this._wireCCAccordionListeners();
        this._wireDrumListeners();
        this._attachStringsSectionListeners();

        // Apply recommended CCs button
        const applyBtn = this.$('#applyRecommendedCCs');
        if (applyBtn) {
            applyBtn.addEventListener('click', function() {
                this._applyRecommendedCCs();
            }.bind(this));
        }

        // Piano is initialized by _switchSection('notes') when the section becomes visible
    };

    ISMListeners._attachIdentitySectionListeners = function() {
        this._wireChannelGridListeners();
        this._wireSysExButton();
        this._wireGmProgramChange();
    };

    ISMListeners._updateCCHiddenInput = function() {
        const selected = [];
        this.$$('.ism-cc-checkbox:checked').forEach(function(c) { selected.push(parseInt(c.value)); });
        const hidden = this.$('#supportedCCs');
        if (hidden) hidden.value = selected.join(', ');
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

    ISMListeners._requestSysExIdentity = function() {
        if (!this.api || !this.device) return;
        const btn = this.$('#sysexRequestBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ En attente...';
        }
        try {
            this.api.sendCommand('sysex_identity_request', { deviceId: this.device.id });
        } catch (e) {
            console.error('SysEx identity request failed:', e);
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔍 Demander l\'identité';
            }
        }
        // Timeout to re-enable button
        setTimeout(function() {
            if (btn && btn.disabled) {
                btn.disabled = false;
                btn.textContent = '🔍 Demander l\'identité';
            }
        }, 5000);
    };

    ISMListeners.handleSysExIdentity = function(data) {
        if (!data || !this.device) return;
        // Cache identity
        if (!this._sysexIdentityCache) this._sysexIdentityCache = {};
        this._sysexIdentityCache[this.device.id] = data;

        // Update settings on active tab
        const tab = this._getActiveTab();
        if (tab) {
            tab.settings.sysex_identity = data;
        }

        // Show identity section
        const section = this.$('#sysexIdentitySection');
        if (section) {
            section.style.display = '';
            const card = this.$('#sysexCard');
            if (card) {
                card.outerHTML = this._renderSysexIdentityCard(data);
            }
        }

        // Propose name if empty
        const nameInput = this.$('#customName');
        if (nameInput && !nameInput.value && data.name) {
            nameInput.value = data.name;
        }

        // Re-enable button
        const btn = this.$('#sysexRequestBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '✅ Identité reçue';
            setTimeout(function() {
                if (btn) btn.textContent = '🔍 Demander l\'identité';
            }, 3000);
        }
    };

    ISMListeners._measureDelay = function() {
        // Mic-based delay measurement
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (typeof showAlert === 'function') {
                showAlert('Le microphone n\'est pas disponible dans ce navigateur.', { title: 'Erreur', icon: '❌' });
            }
            return;
        }
        const btn = this.$('#measureDelayBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '🎤 Écoute...';
        }

        const startTime = performance.now();
        // Send a MIDI note to trigger sound
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

        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const threshold = 140;
            let detected = false;

            var checkInterval = setInterval(function() {
                analyser.getByteTimeDomainData(dataArray);
                for (let i = 0; i < dataArray.length; i++) {
                    if (dataArray[i] > threshold || dataArray[i] < (256 - threshold)) {
                        detected = true;
                        break;
                    }
                }
                if (detected) {
                    clearInterval(checkInterval);
                    const delay = Math.round(performance.now() - startTime);
                    stream.getTracks().forEach(function(t) { t.stop(); });
                    audioCtx.close();

                    const syncInput = this.$('#syncDelay');
                    if (syncInput) syncInput.value = delay;
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🎤 Mesurer';
                    }
                }
            }.bind(this), 10);

            // Timeout after 5s
            setTimeout(function() {
                if (!detected) {
                    clearInterval(checkInterval);
                    stream.getTracks().forEach(function(t) { t.stop(); });
                    audioCtx.close();
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🎤 Mesurer';
                    }
                }
            }, 5000);
        }.bind(this)).catch(function() {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🎤 Mesurer';
            }
        });
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

        // Measure delay button
        const measureBtn = this.$('#measureDelayBtn');
        if (measureBtn) {
            measureBtn.addEventListener('click', function() { this._measureDelay(); }.bind(this));
        }
    };

    if (typeof window !== 'undefined') window.ISMListeners = ISMListeners;
})();
