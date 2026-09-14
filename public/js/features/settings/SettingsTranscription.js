/**
 * SettingsTranscription — the "Audio → MIDI" section of the global settings
 * modal (§33).
 *
 * Read-only on purpose at this stage: it shows what is installed, what each
 * engine can do, and — the part that must never be hidden — the licence of
 * its code AND of its model weights, with a clear marker when the model
 * forbids commercial use. Installation itself lands with the backend
 * installer; until then the section tells the operator where to look rather
 * than offering a button that cannot work.
 *
 * Mixin for SettingsModal: `renderTranscriptionSection()` and
 * `bindTranscriptionSection()`.
 */
const SettingsTranscription = {
  /**
   * Static markup. The engine list is filled asynchronously by
   * {@link bindTranscriptionSection} so opening the settings modal never
   * waits on a server round-trip.
   *
   * @returns {string}
   */
  renderTranscriptionSection() {
    return `
      <div class="settings-section" style="margin-top: 16px;">
        <h3 style="margin: 0 0 10px 0; font-size: 15px; color: var(--text-primary, #333);">
          🎧 ${i18n.t('settings.transcription.title')}
        </h3>
        <div id="transcriptionEnginesStatus" class="tr-settings-status">
          <span class="tr-muted">${i18n.t('common.loading')}</span>
        </div>
        <div id="transcriptionEnginesList" class="tr-settings-engines"></div>
        <button type="button" class="btn" id="transcriptionRefreshBtn" style="margin-top: 8px;">
          🔄 ${i18n.t('settings.transcription.refresh')}
        </button>
      </div>`;
  },

  /**
   * The shared client, resolved the way the other settings mixins do.
   * @returns {?Object}
   * @private
   */
  _getTranscriptionApi() {
    return window.api || window.apiClient || null;
  },

  /**
   * Fetch the engines and render them. Safe to call when the feature is
   * absent: the server answers `disabled` and the section says so.
   *
   * @param {Object} [api] - Injectable client, for tests.
   * @returns {void}
   */
  bindTranscriptionSection(api) {
    const client = api || this._getTranscriptionApi();
    const refresh = this.modal?.querySelector('#transcriptionRefreshBtn');
    if (refresh) {
      refresh.addEventListener('click', () => this._loadTranscriptionEngines(client, true));
    }
    this._loadTranscriptionEngines(client, false);
  },

  /**
   * @param {Object} api
   * @param {boolean} force - Re-probe instead of trusting the server cache.
   * @returns {Promise<void>}
   * @private
   */
  async _loadTranscriptionEngines(api, force) {
    const statusEl = this.modal?.querySelector('#transcriptionEnginesStatus');
    const listEl = this.modal?.querySelector('#transcriptionEnginesList');
    if (!statusEl || !listEl) return;

    if (!api || typeof api.getTranscriptionCapabilities !== 'function') {
      statusEl.textContent = i18n.t('transcription.unavailable.generic');
      listEl.innerHTML = '';
      return;
    }

    statusEl.textContent = i18n.t('common.loading');
    listEl.innerHTML = '';

    let capabilities;
    let backends;
    try {
      capabilities = await api.getTranscriptionCapabilities(force);
      backends = await api.listTranscriptionBackends(force);
    } catch (error) {
      statusEl.textContent = error.message;
      return;
    }

    const ffmpegOk = capabilities?.ffmpeg?.available;
    statusEl.innerHTML = [
      `<span class="tr-settings-badge is-${capabilities?.status || 'disabled'}">${escapeHtml(
        i18n.t(
          `transcription.status.${capabilities?.status === 'ready' ? 'available' : 'not_installed'}`
        )
      )}</span>`,
      `<span class="tr-muted">FFmpeg: ${ffmpegOk ? '✅' : '❌'}${
        capabilities?.ffmpeg?.version ? ` ${escapeHtml(capabilities.ffmpeg.version)}` : ''
      }</span>`,
      capabilities?.detail ? `<span class="tr-muted">${escapeHtml(capabilities.detail)}</span>` : ''
    ].join(' ');

    if (!backends || backends.length === 0) {
      listEl.innerHTML = `<p class="tr-muted">${escapeHtml(
        i18n.t('transcription.unavailable.noEngine')
      )}</p><p class="tr-muted">${escapeHtml(i18n.t('transcription.unavailable.help'))}</p>`;
      return;
    }

    listEl.innerHTML = backends.map((backend) => this._renderEngineRow(backend)).join('');
  },

  /**
   * One engine: name, status, what it can do, and its licences. The
   * non-commercial marker is never omitted (§9).
   *
   * @param {Object} backend - Descriptor from `transcription_backends`.
   * @returns {string}
   * @private
   */
  _renderEngineRow(backend) {
    const licensing = backend.licensing || {};
    const capabilities = backend.capabilities || {};
    const abilities = [
      capabilities.polyphonic && i18n.t('transcription.options.preserveDynamics'),
      capabilities.multiInstrument && i18n.t('transcription.options.detectInstruments'),
      capabilities.drums && i18n.t('transcription.options.detectDrums'),
      capabilities.pitchBend && i18n.t('transcription.options.preservePitchBends')
    ].filter(Boolean);

    return `
      <div class="tr-settings-engine">
        <div class="tr-settings-engine-head">
          <strong>${escapeHtml(backend.name)}</strong>
          <span class="tr-settings-badge is-${escapeHtml(backend.status)}">${escapeHtml(
            i18n.t(`transcription.status.${backend.status}`)
          )}</span>
        </div>
        ${backend.detail ? `<p class="tr-muted">${escapeHtml(backend.detail)}</p>` : ''}
        ${abilities.length ? `<p class="tr-muted">${escapeHtml(abilities.join(' · '))}</p>` : ''}
        <p class="tr-muted">${escapeHtml(
          i18n.t('transcription.engine.licence', {
            code: licensing.codeLicense || '—',
            model: licensing.modelLicense || '—'
          })
        )}</p>
        ${
          licensing.commercialUse
            ? ''
            : `<p class="tr-settings-restricted">⚠️ ${escapeHtml(
                i18n.t('transcription.engine.nonCommercial')
              )}</p>`
        }
      </div>`;
  }
};

if (typeof window !== 'undefined') {
  window.SettingsTranscription = SettingsTranscription;
}
