/**
 * InstrumentCapabilitiesModal
 *
 * Modal pour renseigner les capacités manquantes d'un instrument avant
 * l'auto-assignation. Étend BaseModal : ESC, click-outside, focus trap,
 * ARIA et i18n sont gérés nativement.
 */
(function () {
  'use strict';

  const _t = (key, params) => (typeof i18n !== 'undefined' ? i18n.t(key, params) : key);
  const _esc = (str) =>
    typeof escapeHtml === 'function'
      ? escapeHtml(str || '')
      : String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

  class InstrumentCapabilitiesModal extends BaseModal {
    constructor(apiClient) {
      super({
        id: 'instrument-capabilities-modal',
        size: 'md',
        title: 'instrumentCapabilities.title',
        closeOnEscape: true,
        closeOnOverlay: false,
        customClass: 'icm-modal'
      });
      this.apiClient = apiClient;
      this.incompleteInstruments = [];
      this.currentIndex = 0;
      this.updates = {};
      this.onComplete = null;
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    async show(incompleteInstruments, onComplete) {
      this.incompleteInstruments = incompleteInstruments;
      this.currentIndex = 0;
      this.updates = {};
      this.onComplete = onComplete;
      this.open();
      this._showInstrument(0);
    }

    // ─── BaseModal overrides ───────────────────────────────────────────────────

    renderBody() {
      return `
      <div class="icm-loading" id="icm-loading" style="display:none;">
        <span class="icm-loading-dot"></span>
        <span class="icm-loading-text" id="icm-loading-text"></span>
      </div>
      <div class="icm-subtitle">${_t('instrumentCapabilities.subtitle') || ''}</div>
      <div id="icm-form-container"></div>
    `;
    }

    renderFooter() {
      const total = this.incompleteInstruments.length;
      return `
      <div class="icm-progress">
        <span id="icm-progress-text">${_t('instrumentCapabilities.progress', { current: 1, total }) || `1 / ${total}`}</span>
      </div>
      <div class="icm-footer-btns">
        <button type="button" class="btn" id="icm-skip-btn">${_t('instrumentCapabilities.skip') || 'Passer'}</button>
        <button type="button" class="btn" id="icm-prev-btn">${_t('instrumentCapabilities.previous') || '← Précédent'}</button>
        <button type="button" class="btn btn-primary" id="icm-next-btn">${_t('instrumentCapabilities.next') || 'Suivant →'}</button>
      </div>
    `;
    }

    onOpen() {
      this._attachListeners();
    }

    onClose() {
      this.updates = {};
      this.onComplete = null;
    }

    // ─── Navigation ────────────────────────────────────────────────────────────

    _showInstrument(index) {
      if (index < 0 || index >= this.incompleteInstruments.length) return;
      this.currentIndex = index;
      const validation = this.incompleteInstruments[index];
      const instrument = validation.instrument;
      const total = this.incompleteInstruments.length;
      const isLast = index === total - 1;

      // Progress
      const progressEl = this.$('#icm-progress-text');
      if (progressEl) {
        progressEl.textContent =
          _t('instrumentCapabilities.progress', { current: index + 1, total }) ||
          `${index + 1} / ${total}`;
      }

      // Buttons
      const prevBtn = this.$('#icm-prev-btn');
      const nextBtn = this.$('#icm-next-btn');
      if (prevBtn) prevBtn.disabled = index === 0;
      if (nextBtn) {
        nextBtn.textContent = isLast
          ? _t('instrumentCapabilities.complete') || 'Terminer'
          : _t('instrumentCapabilities.next') || 'Suivant →';
      }

      // Form
      const container = this.$('#icm-form-container');
      if (container) {
        container.innerHTML = this._renderInstrumentForm(instrument, validation);
        this._restoreUpdates(instrument.id);
      }
    }

    // ─── Form rendering ────────────────────────────────────────────────────────

    _renderInstrumentForm(instrument, validation) {
      let html = `
      <div class="instrument-info">
        <h3>${_esc(instrument.custom_name || instrument.name)}</h3>
        <div class="meta">
          ${_t('instrumentCapabilities.type') || 'Type'}: ${_esc(instrument.type || _t('common.unknown') || '?')} •
          ${_t('instrumentCapabilities.manufacturer') || 'Fabricant'}: ${_esc(instrument.manufacturer || _t('common.unknown') || '?')}
        </div>
      </div>
    `;

      if (validation.missing.length > 0) {
        html += `<div class="section-required">
        <h4>${_t('instrumentCapabilities.requiredFields') || 'Champs requis'}</h4>
        ${validation.missing.map((f) => this._renderField(instrument, f, true)).join('')}
      </div>`;
      }

      if (validation.recommended.length > 0) {
        html += `<div class="section-recommended">
        <h4>${_t('instrumentCapabilities.recommendedFields') || 'Champs recommandés'}</h4>
        <p class="hint">${_t('instrumentCapabilities.recommendedHint') || ''}</p>
        ${validation.recommended.map((f) => this._renderField(instrument, f, false)).join('')}
      </div>`;
      }

      html += `
      <div class="defaults-section">
        <button type="button" class="btn" id="icm-defaults-btn">
          ${_t('instrumentCapabilities.applyDefaults') || 'Appliquer les valeurs par défaut'}
        </button>
      </div>
    `;
      return html;
    }

    _renderField(instrument, field, required) {
      const currentValue = instrument[field.field];
      const inputId = `icm_${instrument.id}_${field.field}`;
      const reqAttr = required ? 'required' : '';
      let inputHtml = '';

      switch (field.type) {
        case 'number':
          inputHtml = `<input type="number" id="${inputId}" class="icm-input"
          value="${currentValue != null ? currentValue : ''}"
          data-field="${field.field}" ${reqAttr}>`;
          break;

        case 'note':
          inputHtml = `
          <div class="icm-note-row">
            <input type="number" id="${inputId}" class="icm-input"
              value="${currentValue != null ? currentValue : ''}"
              min="0" max="127"
              data-field="${field.field}" data-note-display="${inputId}_name" ${reqAttr}>
            <span id="${inputId}_name" class="icm-note-name">
              ${currentValue != null ? this._noteNameFromMidi(currentValue) : ''}
            </span>
          </div>`;
          break;

        case 'select':
          if (field.field === 'note_selection_mode') {
            inputHtml = `
            <select id="${inputId}" class="icm-select" data-field="${field.field}" ${reqAttr}>
              <option value="">— ${_t('instrumentCapabilities.select') || 'Choisir'} —</option>
              <option value="range" ${currentValue === 'range' ? 'selected' : ''}>${_t('instrumentCapabilities.noteSelectionRange') || 'Plage'}</option>
              <option value="discrete" ${currentValue === 'discrete' ? 'selected' : ''}>${_t('instrumentCapabilities.noteSelectionDiscrete') || 'Notes individuelles'}</option>
            </select>`;
          } else if (field.field === 'type') {
            const types = [
              'keyboard',
              'synth',
              'drums',
              'bass',
              'guitar',
              'strings',
              'brass',
              'woodwind',
              'pad',
              'sampler',
              'other'
            ];
            inputHtml = `<select id="${inputId}" class="icm-select" data-field="${field.field}">
            <option value="">— ${_t('instrumentCapabilities.select') || 'Choisir'} —</option>
            ${types.map((t) => `<option value="${t}" ${currentValue === t ? 'selected' : ''}>${_t('instrumentCapabilities.type' + t.charAt(0).toUpperCase() + t.slice(1)) || t}</option>`).join('')}
          </select>`;
          }
          break;

        case 'array': {
          const currentCCs = Array.isArray(currentValue) ? currentValue : [];
          const commonCCs = [
            { v: 1, l: 'CC1 — Modulation' },
            { v: 7, l: 'CC7 — Volume' },
            { v: 10, l: 'CC10 — Pan' },
            { v: 11, l: 'CC11 — Expression' },
            { v: 64, l: 'CC64 — Sustain' },
            { v: 71, l: 'CC71 — Resonance' },
            { v: 72, l: 'CC72 — Release' },
            { v: 73, l: 'CC73 — Attack' },
            { v: 74, l: 'CC74 — Brightness' },
            { v: 91, l: 'CC91 — Reverb' },
            { v: 93, l: 'CC93 — Chorus' }
          ];
          inputHtml = `<div class="cc-grid">
          ${commonCCs
            .map(
              (cc) => `
            <label>
              <input type="checkbox" class="icm-cc-cb" value="${cc.v}"
                data-cc-field="${field.field}"
                ${currentCCs.includes(cc.v) ? 'checked' : ''}>
              <span>${_esc(cc.l)}</span>
            </label>`
            )
            .join('')}
        </div>`;
          break;
        }

        case 'note-array': {
          const currentNotes = Array.isArray(currentValue) ? currentValue.join(', ') : '';
          inputHtml = `
          <textarea id="${inputId}" class="icm-textarea"
            data-field="${field.field}"
            placeholder="${_t('instrumentCapabilities.noteArrayPlaceholder') || '35, 36, 38…'}"
            ${reqAttr}>${_esc(currentNotes)}</textarea>
          <div class="icm-field-hint">${_t('instrumentCapabilities.commonDrums') || ''}</div>`;
          break;
        }
      }

      const optLabel = required
        ? '<span class="icm-required">*</span>'
        : `<span class="icm-optional">(${_t('instrumentCapabilities.optional') || 'optionnel'})</span>`;

      return `
      <div class="field-group">
        <label for="${inputId}">${_esc(field.label)} ${optLabel}</label>
        ${inputHtml}
      </div>`;
    }

    // ─── Event listeners ───────────────────────────────────────────────────────

    _attachListeners() {
      const self = this;

      this.$('#icm-prev-btn')?.addEventListener('click', () => this._prev());
      this.$('#icm-next-btn')?.addEventListener('click', () => this._next());
      this.$('#icm-skip-btn')?.addEventListener('click', () => this._skip());

      // Delegated listeners on the form container for dynamic content
      const container = this.$('#icm-form-container');
      if (!container) return;

      container.addEventListener('change', function (e) {
        const el = e.target;
        const field = el.dataset.field;
        const ccField = el.dataset.ccField;

        if (ccField && el.type === 'checkbox') {
          self._updateCCArray(ccField, el);
          return;
        }
        if (field) {
          self._updateField(field, el.value);
        }
      });

      // Live note name display when typing in a note input
      container.addEventListener('input', function (e) {
        const el = e.target;
        if (el.dataset.noteDisplay) {
          const nameEl = document.getElementById(el.dataset.noteDisplay);
          if (nameEl) nameEl.textContent = self._noteNameFromMidi(parseInt(el.value));
        }
      });

      // Defaults button (rendered inside the form — needs delegation)
      container.addEventListener('click', function (e) {
        if (e.target.closest('#icm-defaults-btn')) self._applyDefaults();
      });
    }

    // ─── Data mutation ─────────────────────────────────────────────────────────

    _updateField(field, value) {
      const instrument = this.incompleteInstruments[this.currentIndex].instrument;
      if (!this.updates[instrument.id]) this.updates[instrument.id] = {};

      if (field === 'selected_notes' && typeof value === 'string') {
        value = value
          .split(',')
          .map((n) => parseInt(n.trim()))
          .filter((n) => !isNaN(n) && n >= 0 && n <= 127);
      } else if (['gm_program', 'note_range_min', 'note_range_max', 'polyphony'].includes(field)) {
        value = parseInt(value);
      }

      this.updates[instrument.id][field] = value;

      if (field === 'type' && ['guitar', 'bass', 'strings'].includes(value)) {
        this._autoCreateStringInstrument(instrument, value);
      }
    }

    _updateCCArray(field, checkbox) {
      const instrument = this.incompleteInstruments[this.currentIndex].instrument;
      if (!this.updates[instrument.id]) this.updates[instrument.id] = {};

      let ccs = this.updates[instrument.id][field] || instrument[field] || [];
      ccs = Array.isArray(ccs) ? [...ccs] : [];
      const val = parseInt(checkbox.value);
      if (checkbox.checked) {
        if (!ccs.includes(val)) ccs.push(val);
      } else {
        ccs = ccs.filter((c) => c !== val);
      }
      this.updates[instrument.id][field] = ccs;
    }

    _restoreUpdates(instrumentId) {
      const saved = this.updates[instrumentId];
      if (!saved) return;

      const container = this.$('#icm-form-container');
      if (!container) return;

      for (const [field, value] of Object.entries(saved)) {
        // Restore checkboxes (CC array)
        if (Array.isArray(value) && field === 'supported_ccs') {
          container.querySelectorAll(`.icm-cc-cb[data-cc-field="${field}"]`).forEach((cb) => {
            cb.checked = value.includes(parseInt(cb.value));
          });
          continue;
        }

        // Restore a text/number/select/textarea via data-field attribute
        const el = container.querySelector(`[data-field="${field}"]`);
        if (!el) continue;
        if (field === 'selected_notes' && Array.isArray(value)) {
          el.value = value.join(', ');
        } else {
          el.value = value;
        }

        // Refresh live note name if applicable
        if (el.dataset.noteDisplay) {
          const nameEl = document.getElementById(el.dataset.noteDisplay);
          if (nameEl) nameEl.textContent = this._noteNameFromMidi(parseInt(el.value));
        }
      }
    }

    // ─── Navigation actions ────────────────────────────────────────────────────

    _next() {
      if (this.currentIndex < this.incompleteInstruments.length - 1) {
        this._showInstrument(this.currentIndex + 1);
      } else {
        this._complete();
      }
    }

    _prev() {
      if (this.currentIndex > 0) this._showInstrument(this.currentIndex - 1);
    }

    // Skipping a field behaves exactly like advancing without saving it.
    _skip() {
      this._next();
    }

    // ─── Save ──────────────────────────────────────────────────────────────────

    async _complete() {
      const nextBtn = this.$('#icm-next-btn');
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.textContent = '⏳';
      }
      try {
        const response = await this.apiClient.sendCommand('update_instrument_capabilities', {
          updates: this.updates
        });
        if (response && response.success) {
          // The backend returns success:true even when SOME items fail to
          // persist (it reports them via `failed`/`failedDetails`). Surface
          // those honestly instead of masking them as a clean success.
          if (response.failed && response.failed > 0) {
            const details = Array.isArray(response.failedDetails)
              ? response.failedDetails
                  .map(
                    (f) =>
                      `• ${f.instrumentId != null ? f.instrumentId : '?'}: ${
                        f.error || _t('common.unknownError')
                      }`
                  )
                  .join('\n')
              : '';
            const msg =
              (_t('instrumentCapabilities.savedPartial') ||
                "Certaines capacités n'ont pas pu être enregistrées") +
              ` (${response.updated != null ? response.updated : 0} OK, ${response.failed} ✗)` +
              (details ? '\n\n' + details : '');
            await this._alert(msg);
            // Keep the modal open so the user can review / retry.
            if (nextBtn) {
              nextBtn.disabled = false;
              nextBtn.textContent = _t('instrumentCapabilities.complete') || 'Terminer';
            }
            return;
          }
          const cb = this.onComplete;
          const updates = { ...this.updates };
          this.close();
          if (cb) cb(updates);
        } else {
          const msg =
            _t('instrumentCapabilities.saveFailed') +
            ': ' +
            (response?.error || _t('common.unknownError'));
          await this._alert(msg);
          if (nextBtn) {
            nextBtn.disabled = false;
            nextBtn.textContent = _t('instrumentCapabilities.complete') || 'Terminer';
          }
        }
      } catch (err) {
        console.error('[InstrumentCapabilitiesModal] complete failed:', err);
        await this._alert(_t('instrumentCapabilities.saveFailed') || 'Échec de la sauvegarde');
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.textContent = _t('instrumentCapabilities.complete') || 'Terminer';
        }
      }
    }

    async _applyDefaults() {
      const instrument = this.incompleteInstruments[this.currentIndex].instrument;
      try {
        const response = await this.apiClient.sendCommand('get_instrument_defaults', {
          instrumentId: instrument.id,
          type: instrument.type
        });
        if (response && response.defaults) {
          if (!this.updates[instrument.id]) this.updates[instrument.id] = {};
          Object.assign(this.updates[instrument.id], response.defaults);
          this._showInstrument(this.currentIndex);
        }
      } catch (err) {
        console.error('[InstrumentCapabilitiesModal] applyDefaults failed:', err);
        await this._alert(
          _t('instrumentCapabilities.defaultsFailed') ||
            'Impossible de charger les valeurs par défaut'
        );
      }
    }

    // ─── String instrument auto-create ─────────────────────────────────────────

    async _autoCreateStringInstrument(instrument, type) {
      const presetMap = {
        guitar: 'guitar_standard',
        bass: 'bass_4_standard',
        strings: 'guitar_standard'
      };
      try {
        const existing = await this.apiClient.sendCommand('string_instrument_get', {
          device_id: instrument.id,
          channel: 0
        });
        if (existing && existing.instrument) {
          this._showStringBanner(true);
          return;
        }

        const presetResponse = await this.apiClient.sendCommand('string_instrument_apply_preset', {
          preset_key: presetMap[type]
        });
        if (presetResponse && presetResponse.preset) {
          const p = presetResponse.preset;
          await this.apiClient.sendCommand('string_instrument_create', {
            device_id: instrument.id,
            channel: 0,
            instrument_name: p.name || type,
            num_strings: p.strings,
            num_frets: p.frets,
            tuning: p.tuning,
            is_fretless: p.fretless || false,
            capo_fret: 0
          });
          this._showStringBanner(false);
        }
      } catch (err) {
        console.error('[InstrumentCapabilitiesModal] autoCreateStringInstrument failed:', err);
      }
    }

    _showStringBanner(alreadyExists) {
      const existing = this.$('#icm-string-banner');
      if (existing) existing.remove();
      const container = this.$('#icm-form-container');
      if (!container) return;
      const msg = alreadyExists
        ? _t('stringInstrument.configExists') ||
          "Configuration d'instrument à cordes déjà existante."
        : _t('stringInstrument.configCreated') ||
          "Configuration d'instrument à cordes créée automatiquement.";
      const banner = document.createElement('div');
      banner.id = 'icm-string-banner';
      banner.className = 'icm-string-banner';
      banner.textContent = msg;
      container.insertBefore(banner, container.firstChild);
    }

    // ─── Utilities ─────────────────────────────────────────────────────────────

    _noteNameFromMidi(midi) {
      if (isNaN(midi) || midi < 0 || midi > 127) return '';
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    async _alert(msg) {
      if (typeof window.showAlert === 'function') {
        await window.showAlert(msg, { title: _t('common.error') || 'Erreur', icon: '❌' });
      } else {
        alert(msg);
      }
    }
  }

  window.InstrumentCapabilitiesModal = InstrumentCapabilitiesModal;
})();
