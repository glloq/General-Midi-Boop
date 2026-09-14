/**
 * SettingsTranscription — the "Audio → MIDI" section of the global settings
 * modal (§33).
 *
 * It shows what is installed, what each engine can do, and — the part that
 * must never be hidden — the licence of its code AND of its model weights,
 * with a clear marker when the model forbids commercial use.
 *
 * It also installs and removes engines (§34). Two rules the buttons obey:
 * an engine whose licence requires consent is never installed until the user
 * has SEEN that licence and confirmed it (the confirmation carries which
 * licence was shown, so a stale page cannot consent for them), and an engine
 * with no automated installer gets no button at all — a dead button is worse
 * than a documented procedure.
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
    this._transcriptionClient = client;

    const refresh = this.modal?.querySelector('#transcriptionRefreshBtn');
    if (refresh) {
      refresh.addEventListener('click', () => this._loadTranscriptionEngines(client, true));
    }

    // Follow an install that is already running (a reconnect, a second tab).
    if (client?.on && !this._transcriptionInstallHandlers) {
      this._transcriptionInstallHandlers = {
        transcription_install_progress: (data) => this._onInstallProgress(data),
        transcription_install_complete: (data) => this._onInstallComplete(data, client),
        // An engine can change status without an install: a manual venv, a
        // broken environment found on the next probe.
        transcription_backend_changed: () => this._loadTranscriptionEngines(client, false)
      };
      for (const [event, handler] of Object.entries(this._transcriptionInstallHandlers)) {
        client.on(event, handler);
      }
    }

    this._loadTranscriptionEngines(client, false);
  },

  /**
   * Release the install listeners. Called when the settings modal closes.
   * @returns {void}
   */
  unbindTranscriptionSection() {
    const client = this._transcriptionClient;
    if (!client?.off || !this._transcriptionInstallHandlers) return;
    for (const [event, handler] of Object.entries(this._transcriptionInstallHandlers)) {
      client.off(event, handler);
    }
    this._transcriptionInstallHandlers = null;
  },

  /**
   * @param {{backendId: ?string, stage: ?string}} data
   * @returns {void}
   * @private
   */
  _onInstallProgress(data) {
    const el = this.modal?.querySelector(`[data-install-status="${data?.backendId}"]`);
    if (!el) return;
    el.textContent = `${i18n.t('settings.transcription.installing')} — ${data.stage || ''}`;
  },

  /**
   * @param {{backendId: string, outcome: string, message: ?string}} data
   * @param {Object} client
   * @returns {void}
   * @private
   */
  _onInstallComplete(data, client) {
    if (data?.backendId) {
      this._rememberEngineError(data.backendId, data.outcome === 'failed' ? data.message : null);
    }
    // Whatever happened, the truth now comes from a fresh probe.
    this._loadTranscriptionEngines(client, true);
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
    this._bindEngineActions(listEl, backends, api);
  },

  /**
   * Wire Install / Repair / Uninstall. The consent prompt happens HERE, in
   * front of the user, and the acceptance sent to the server names the
   * licence that was actually displayed (§8).
   *
   * @param {HTMLElement} listEl
   * @param {Object[]} backends
   * @param {Object} api
   * @returns {void}
   * @private
   */
  _bindEngineActions(listEl, backends, api) {
    const byId = new Map(backends.map((backend) => [backend.id, backend]));

    for (const button of listEl.querySelectorAll('[data-install]')) {
      button.addEventListener('click', async () => {
        const backend = byId.get(button.dataset.install);
        if (!backend) return;
        const licensing = backend.licensing || {};

        if (licensing.requiresConsent) {
          const shown = [
            i18n.t('settings.transcription.consent', {
              name: backend.name,
              model: licensing.modelLicense || '—'
            }),
            licensing.notice || '',
            licensing.licenseUrl || ''
          ]
            .filter(Boolean)
            .join('\n\n');
          // eslint-disable-next-line no-alert
          if (!window.confirm(shown)) return;
        }

        this._rememberEngineError(backend.id, null);
        this._setEngineBusy(button, true);
        try {
          await api.installTranscriptionBackend(backend.id, {
            acceptLicense: true,
            // What the user saw — the server refuses if it has changed since.
            acceptedModelLicense: licensing.modelLicense ?? null
          });
        } catch (error) {
          // Remembered rather than written straight into the DOM: the
          // refresh below re-renders the row, and a message the user has to
          // read must survive that.
          this._rememberEngineError(backend.id, error.message);
        } finally {
          this._setEngineBusy(button, false);
          this._loadTranscriptionEngines(api, true);
        }
      });
    }

    for (const button of listEl.querySelectorAll('[data-uninstall]')) {
      button.addEventListener('click', async () => {
        const backend = byId.get(button.dataset.uninstall);
        if (!backend) return;
        // eslint-disable-next-line no-alert
        if (
          !window.confirm(i18n.t('settings.transcription.confirmUninstall', { name: backend.name }))
        ) {
          return;
        }
        this._setEngineBusy(button, true);
        try {
          await api.uninstallTranscriptionBackend(backend.id);
        } catch (error) {
          this._rememberEngineError(backend.id, error.message);
        } finally {
          this._setEngineBusy(button, false);
          this._loadTranscriptionEngines(api, true);
        }
      });
    }
  },

  /**
   * Keep the last failure for an engine so it survives the re-render that
   * follows every attempt.
   *
   * @param {string} backendId
   * @param {?string} message - null clears it.
   * @returns {void}
   * @private
   */
  _rememberEngineError(backendId, message) {
    this._transcriptionErrors = this._transcriptionErrors || {};
    if (message) this._transcriptionErrors[backendId] = message;
    else delete this._transcriptionErrors[backendId];
  },

  /**
   * @param {HTMLElement} button
   * @param {boolean} busy
   * @returns {void}
   * @private
   */
  _setEngineBusy(button, busy) {
    button.disabled = busy;
    const row = button.closest('.tr-settings-engine');
    for (const other of row ? row.querySelectorAll('button') : []) other.disabled = busy;
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
        <div class="tr-settings-actions">
          ${this._renderEngineActions(backend)}
          <span class="tr-settings-engine-status" data-install-status="${escapeHtml(backend.id)}"
                >${escapeHtml(this._transcriptionErrors?.[backend.id] || '')}</span>
        </div>
      </div>`;
  },

  /**
   * The buttons this engine's state allows. An engine with no automated
   * installer gets none — the section already points at the documented
   * procedure, and a button that cannot work is worse than no button.
   *
   * @param {Object} backend
   * @returns {string}
   * @private
   */
  _renderEngineActions(backend) {
    const id = escapeHtml(backend.id);
    const buttons = [];

    if (backend.status === 'installable' || backend.status === 'license_restricted') {
      buttons.push(
        `<button type="button" class="btn btn-primary" data-install="${id}">📦 ${escapeHtml(
          i18n.t('settings.transcription.install')
        )}</button>`
      );
    }
    if (backend.status === 'broken') {
      buttons.push(
        `<button type="button" class="btn" data-install="${id}">🔧 ${escapeHtml(
          i18n.t('settings.transcription.repair')
        )}</button>`
      );
    }
    if (backend.status === 'available' || backend.status === 'broken') {
      buttons.push(
        `<button type="button" class="btn btn-danger" data-uninstall="${id}">🗑️ ${escapeHtml(
          i18n.t('settings.transcription.uninstall')
        )}</button>`
      );
    }
    return buttons.join(' ');
  }
};

if (typeof window !== 'undefined') {
  window.SettingsTranscription = SettingsTranscription;
}
