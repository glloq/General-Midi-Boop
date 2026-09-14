/**
 * TranscriptionModal — audio → MIDI conversion (§30/§31/§32).
 *
 * One modal, four views:
 *
 *   unavailable  the server has no engine (or no FFmpeg): say so plainly,
 *                with what is missing, and offer nothing that cannot work
 *   select       pick a file, an engine, a quality, and the options the
 *                chosen engine actually supports
 *   running      stage-by-stage progress and a Cancel button
 *   result       what was detected, with what confidence, and the actions
 *                that hand the file back to the rest of GMB
 *
 * The modal owns no pipeline logic: it queues a job over HTTP, follows it
 * through `transcription_*` WebSocket events, and hands the resulting
 * `fileId` to the existing library/editor code. Closing it does not cancel
 * anything — the job lives on the server, and re-opening re-syncs from
 * `transcription_status`.
 *
 * Dependencies: BaseModal, i18n, BackendAPIClient.
 */
class TranscriptionModal extends BaseModal {
  /** Stage order, used for the progress list (§31). */
  static STAGES = [
    'preprocessing',
    'transcribing',
    'postprocessing',
    'generating_midi',
    'importing'
  ];

  /** Feature toggles, and the backend capability each one needs (§30). */
  static OPTION_FLAGS = [
    { key: 'preserveDynamics', capability: 'dynamics', default: true },
    { key: 'preservePitchBends', capability: 'pitchBend', default: true },
    { key: 'detectTempo', capability: 'tempoDetection', default: true },
    { key: 'detectDrums', capability: 'drums', default: false },
    { key: 'detectInstruments', capability: 'multiInstrument', default: false }
  ];

  /**
   * @param {Object} api - BackendAPIClient.
   * @param {Object} [options]
   * @param {Function} [options.onOpenEditor] - `(fileId, filename)`.
   * @param {Function} [options.onUseFile] - `(fileId, filename)`.
   * @param {Function} [options.onImported] - `(fileId)` — refresh the library.
   * @param {Object} [options.logger]
   */
  constructor(api, options = {}) {
    super({
      id: 'transcription-modal',
      size: 'lg',
      title: 'transcription.title',
      customClass: 'transcription-modal'
    });

    this.api = api;
    this.onOpenEditor = options.onOpenEditor || null;
    this.onUseFile = options.onUseFile || null;
    this.onImported = options.onImported || null;
    this.logger = options.logger || null;

    /** @type {'loading'|'unavailable'|'select'|'running'|'result'} */
    this.view = 'loading';
    this.capabilities = null;
    this.backends = [];
    this.selectedBackendId = 'auto';
    this.quality = 'balanced';
    this.flags = Object.fromEntries(
      TranscriptionModal.OPTION_FLAGS.map((flag) => [flag.key, flag.default])
    );
    this.file = null;
    this.fileDuration = null;
    this.job = null;
    this.error = null;

    /** Bound WS handlers, kept so they can be detached on close. */
    this._handlers = null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** @override */
  onOpen() {
    this._attachApiHandlers();
    this._bindView();
    this._refreshCapabilities();
  }

  /** @override */
  onClose() {
    this._detachApiHandlers();
    this._revokeObjectUrl();
  }

  /** @override */
  onUpdate() {
    this._bindView();
  }

  /**
   * Subscribe to the job lifecycle. The handlers ignore events for other
   * jobs, so two browser tabs following different conversions do not
   * overwrite one another's view.
   * @private
   */
  _attachApiHandlers() {
    if (this._handlers || !this.api?.on) return;
    this._handlers = {
      transcription_progress: (data) => {
        if (!this._isCurrentJob(data)) return;
        this.job = { ...this.job, ...data, status: data.stage };
        this._renderProgress();
      },
      transcription_complete: (data) => {
        if (!this._isCurrentJob(data)) return;
        this.job = { ...this.job, ...data, status: 'complete' };
        this.view = 'result';
        this.update();
        if (data.fileId && this.onImported) this.onImported(data.fileId);
      },
      transcription_failed: (data) => {
        if (!this._isCurrentJob(data)) return;
        this.job = { ...this.job, status: 'failed' };
        this.error = { reason: data.reason, message: data.message, retryable: data.retryable };
        this.view = 'result';
        this.update();
      },
      transcription_cancelled: (data) => {
        if (!this._isCurrentJob(data)) return;
        this.job = { ...this.job, status: 'cancelled' };
        this.view = 'select';
        this.update();
      }
    };
    for (const [event, handler] of Object.entries(this._handlers)) {
      this.api.on(event, handler);
    }
  }

  /** @private */
  _detachApiHandlers() {
    if (!this._handlers || !this.api?.off) {
      this._handlers = null;
      return;
    }
    for (const [event, handler] of Object.entries(this._handlers)) {
      this.api.off(event, handler);
    }
    this._handlers = null;
  }

  /**
   * @param {Object} data
   * @returns {boolean}
   * @private
   */
  _isCurrentJob(data) {
    return !!this.job && !!data && data.jobId === this.job.id;
  }

  /**
   * Ask the server what it can do, then show the matching view. A server
   * with no engine gets an explanation, not a disabled form (§29).
   * @private
   */
  async _refreshCapabilities() {
    try {
      this.capabilities = await this.api.getTranscriptionCapabilities();
      this.backends = await this.api.listTranscriptionBackends();
      this.view = this.capabilities.status === 'ready' ? 'select' : 'unavailable';
    } catch (error) {
      this.capabilities = null;
      this.error = { message: error.message };
      this.view = 'unavailable';
    }
    this.update();
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================

  /** @override */
  renderBody() {
    switch (this.view) {
      case 'loading':
        return `<p class="tr-loading">${this.escape(this.t('common.loading'))}</p>`;
      case 'unavailable':
        return this._renderUnavailable();
      case 'running':
        return this._renderRunning();
      case 'result':
        return this._renderResult();
      default:
        return this._renderSelect();
    }
  }

  /** @override */
  renderFooter() {
    if (this.view === 'running') {
      return `<button type="button" class="btn btn-danger" id="tr-cancel">${this.escape(
        this.t('transcription.actions.cancel')
      )}</button>`;
    }
    if (this.view === 'result') {
      const parts = [];
      if (this.job?.fileId) {
        parts.push(
          `<button type="button" class="btn" id="tr-open-editor">${this.escape(
            this.t('transcription.actions.openEditor')
          )}</button>`,
          `<button type="button" class="btn btn-primary" id="tr-use-file">${this.escape(
            this.t('transcription.actions.useFile')
          )}</button>`
        );
      }
      parts.push(
        `<button type="button" class="btn" id="tr-again">${this.escape(
          this.t('transcription.actions.newConversion')
        )}</button>`,
        `<button type="button" class="btn" id="tr-close">${this.escape(
          this.t('common.close')
        )}</button>`
      );
      return parts.join('');
    }
    if (this.view === 'select') {
      return `
        <button type="button" class="btn" id="tr-close">${this.escape(this.t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="tr-start" ${this.file ? '' : 'disabled'}>
          ${this.escape(this.t('transcription.actions.start'))}
        </button>`;
    }
    return `<button type="button" class="btn" id="tr-close">${this.escape(this.t('common.close'))}</button>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderUnavailable() {
    const ffmpeg = this.capabilities?.ffmpeg;
    const reasons = [];
    if (ffmpeg && !ffmpeg.available) {
      reasons.push(this.t('transcription.unavailable.ffmpeg'));
    }
    if (this.capabilities && (this.capabilities.backends || []).every((b) => !b.available)) {
      reasons.push(this.t('transcription.unavailable.noEngine'));
    }
    if (this.error?.message) reasons.push(this.error.message);
    if (reasons.length === 0) {
      reasons.push(this.capabilities?.detail || this.t('transcription.unavailable.generic'));
    }

    const engines = (this.capabilities?.backends || [])
      .map(
        (backend) =>
          `<li><strong>${this.escape(backend.name)}</strong> — ${this.escape(
            this.t(`transcription.status.${backend.status}`)
          )}${backend.detail ? ` <span class="tr-muted">(${this.escape(backend.detail)})</span>` : ''}</li>`
      )
      .join('');

    return `
      <div class="tr-unavailable">
        <p class="tr-lead">${this.escape(this.t('transcription.unavailable.title'))}</p>
        <ul class="tr-reasons">${reasons.map((r) => `<li>${this.escape(r)}</li>`).join('')}</ul>
        ${engines ? `<p class="tr-muted">${this.escape(this.t('transcription.unavailable.engines'))}</p><ul class="tr-engines">${engines}</ul>` : ''}
        <p class="tr-hint">${this.escape(this.t('transcription.unavailable.help'))}</p>
      </div>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderSelect() {
    return `
      <div class="tr-select">
        ${this._renderFileStep()}
        ${this._renderEngineStep()}
        ${this._renderQualityStep()}
        ${this._renderOptionsStep()}
      </div>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderFileStep() {
    const details = this.file
      ? `
        <dl class="tr-file-details">
          <div><dt>${this.escape(this.t('transcription.file.name'))}</dt><dd>${this.escape(this.file.name)}</dd></div>
          <div><dt>${this.escape(this.t('transcription.file.size'))}</dt><dd>${this.escape(formatBytes(this.file.size))}</dd></div>
          <div><dt>${this.escape(this.t('transcription.file.duration'))}</dt><dd>${this.escape(
            this.fileDuration ? formatDuration(this.fileDuration) : '—'
          )}</dd></div>
        </dl>`
      : '';

    return `
      <section class="tr-step">
        <h3 class="tr-step-title">1. ${this.escape(this.t('transcription.step.file'))}</h3>
        <div class="tr-dropzone" id="tr-dropzone" role="button" tabindex="0"
             aria-label="${this.escape(this.t('transcription.dropzone.aria'))}">
          <span class="tr-dropzone-icon" aria-hidden="true">🎧</span>
          <span>${this.escape(this.t('transcription.dropzone.hint'))}</span>
          <strong>${this.escape(this.t('transcription.dropzone.browse'))}</strong>
        </div>
        <input type="file" id="tr-file-input" class="tr-hidden-input"
               accept=".wav,.mp3,.flac,.ogg,.oga,.opus,.m4a,.aac,.aiff,.aif,.wma,.mp4,.mkv,.webm,.mov"
               aria-label="${this.escape(this.t('transcription.dropzone.aria'))}">
        ${details}
      </section>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderEngineStep() {
    const options = [
      `<option value="auto"${this.selectedBackendId === 'auto' ? ' selected' : ''}>${this.escape(
        this.t('transcription.engine.auto')
      )}</option>`,
      ...this.backends.map((backend) => {
        const label = backend.available
          ? backend.name
          : `${backend.name} — ${this.t(`transcription.status.${backend.status}`)}`;
        return `<option value="${this.escape(backend.id)}"${backend.available ? '' : ' disabled'}${
          this.selectedBackendId === backend.id ? ' selected' : ''
        }>${this.escape(label)}</option>`;
      })
    ].join('');

    const selected = this._selectedBackend();
    const licence = selected?.licensing
      ? `<p class="tr-licence">${this.escape(
          this.t('transcription.engine.licence', {
            code: selected.licensing.codeLicense || '—',
            model: selected.licensing.modelLicense || '—'
          })
        )}${
          selected.licensing.commercialUse
            ? ''
            : ` <strong>${this.escape(this.t('transcription.engine.nonCommercial'))}</strong>`
        }</p>`
      : `<p class="tr-muted">${this.escape(this.t('transcription.engine.autoHint'))}</p>`;

    return `
      <section class="tr-step">
        <h3 class="tr-step-title">2. ${this.escape(this.t('transcription.step.engine'))}</h3>
        <label class="tr-field">
          <span class="tr-field-label">${this.escape(this.t('transcription.step.engine'))}</span>
          <select id="tr-backend" class="tr-select-input">${options}</select>
        </label>
        ${licence}
      </section>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderQualityStep() {
    const selected = this._selectedBackend();
    const offered = selected?.qualityProfiles || ['fast', 'balanced', 'maximum'];
    const buttons = ['fast', 'balanced', 'maximum']
      .map((quality) => {
        const disabled = !offered.includes(quality);
        const active = this.quality === quality && !disabled;
        return `<button type="button" class="tr-quality${active ? ' is-active' : ''}"
                  data-quality="${quality}" ${disabled ? 'disabled' : ''}
                  aria-pressed="${active ? 'true' : 'false'}">
                  ${this.escape(this.t(`transcription.quality.${quality}`))}
                </button>`;
      })
      .join('');

    return `
      <section class="tr-step">
        <h3 class="tr-step-title">3. ${this.escape(this.t('transcription.step.quality'))}</h3>
        <div class="tr-quality-row" role="group"
             aria-label="${this.escape(this.t('transcription.step.quality'))}">${buttons}</div>
      </section>`;
  }

  /**
   * Feature toggles. An option the selected engine cannot honour is
   * disabled and explained rather than silently ignored (§30).
   * @returns {string}
   * @private
   */
  _renderOptionsStep() {
    const selected = this._selectedBackend();
    const rows = TranscriptionModal.OPTION_FLAGS.map((flag) => {
      const supported = !selected || selected.capabilities?.[flag.capability] !== false;
      const checked = supported && this.flags[flag.key];
      return `
        <label class="tr-option${supported ? '' : ' is-unsupported'}"
               ${supported ? '' : `title="${this.escape(this.t('transcription.options.unsupported'))}"`}>
          <input type="checkbox" data-flag="${flag.key}" ${checked ? 'checked' : ''}
                 ${supported ? '' : 'disabled'}>
          <span>${this.escape(this.t(`transcription.options.${flag.key}`))}</span>
          ${supported ? '' : `<em class="tr-muted">${this.escape(this.t('transcription.options.unsupported'))}</em>`}
        </label>`;
    }).join('');

    return `
      <section class="tr-step">
        <h3 class="tr-step-title">${this.escape(this.t('transcription.options.title'))}</h3>
        <div class="tr-options">${rows}</div>
      </section>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderRunning() {
    const stages = TranscriptionModal.STAGES.map((stage) => {
      const state = this._stageState(stage);
      return `<li class="tr-stage is-${state}" data-stage="${stage}">
        <span class="tr-stage-dot" aria-hidden="true"></span>
        ${this.escape(this.t(`transcription.stage.${stage}`))}
      </li>`;
    }).join('');

    return `
      <div class="tr-running">
        <p class="tr-lead">${this.escape(
          this.t('transcription.progress.title', { name: this.file?.name || '' })
        )}</p>
        <ol class="tr-stages">${stages}</ol>
        <div class="tr-progress" id="tr-progress-wrap">${this._renderProgressBar()}</div>
      </div>`;
  }

  /**
   * @returns {string}
   * @private
   */
  _renderProgressBar() {
    const progress = this.job?.progress;
    // No number from the engine means an indeterminate bar — never a
    // fabricated percentage (§31).
    if (progress === null || progress === undefined) {
      return `<div class="tr-bar is-indeterminate" role="progressbar"
                aria-label="${this.escape(this.t('transcription.progress.title', { name: '' }))}">
                <div class="tr-bar-fill"></div>
              </div>
              <span class="tr-progress-text">${this.escape(this.t('transcription.progress.working'))}</span>`;
    }
    const percent = Math.round(progress * 100);
    return `<div class="tr-bar" role="progressbar" aria-valuenow="${percent}"
              aria-valuemin="0" aria-valuemax="100">
              <div class="tr-bar-fill" style="width:${percent}%"></div>
            </div>
            <span class="tr-progress-text">${percent}%</span>`;
  }

  /**
   * @param {string} stage
   * @returns {'done'|'active'|'pending'}
   * @private
   */
  _stageState(stage) {
    const current = this.job?.stage;
    const index = TranscriptionModal.STAGES.indexOf(stage);
    const currentIndex = TranscriptionModal.STAGES.indexOf(current);
    if (currentIndex === -1) return index === 0 ? 'active' : 'pending';
    if (index < currentIndex) return 'done';
    if (index === currentIndex) return 'active';
    return 'pending';
  }

  /**
   * @returns {string}
   * @private
   */
  _renderResult() {
    if (this.error) {
      return `
        <div class="tr-result tr-result-error">
          <p class="tr-lead">${this.escape(this.t('transcription.result.failed'))}</p>
          <p class="tr-error-message">${this.escape(this.error.message || '')}</p>
          ${this.error.reason ? `<p class="tr-muted">${this.escape(this.error.reason)}</p>` : ''}
        </div>`;
    }

    const summary = this.job?.summary || {};
    const instruments = (summary.instruments || [])
      .map((instrument) => {
        const confidence =
          instrument.confidence === null || instrument.confidence === undefined
            ? '—'
            : `${Math.round(instrument.confidence * 100)} %`;
        const label = instrument.label || this.t('transcription.result.unknownInstrument');
        return `<li><span class="tr-instrument-name">${this.escape(label)}</span>
                  <span class="tr-instrument-confidence">${this.escape(confidence)}</span>
                  <span class="tr-muted">${instrument.noteCount} ${this.escape(
                    this.t('transcription.result.notes')
                  )}</span></li>`;
      })
      .join('');

    const warnings = (this.job?.warnings || [])
      .map((warning) => `<li>${this.escape(warning)}</li>`)
      .join('');

    return `
      <div class="tr-result">
        <p class="tr-lead">${this.escape(this.t('transcription.result.complete'))}</p>
        ${
          summary.duplicate
            ? `<p class="tr-muted">${this.escape(this.t('transcription.result.duplicate'))}</p>`
            : ''
        }
        <h4>${this.escape(this.t('transcription.result.detected'))}</h4>
        <ul class="tr-instruments">${instruments || `<li class="tr-muted">—</li>`}</ul>
        <h4>${this.escape(this.t('transcription.result.warnings'))}</h4>
        <ul class="tr-warnings">${
          warnings ||
          `<li class="tr-muted">${this.escape(this.t('transcription.result.noWarnings'))}</li>`
        }</ul>
      </div>`;
  }

  // ==========================================================================
  // Behaviour
  // ==========================================================================

  /**
   * (Re)bind the handlers of whichever view is on screen. Called after every
   * `update()`, because BaseModal replaces the body's innerHTML.
   * @private
   */
  _bindView() {
    if (!this.dialog) return;
    const byId = (id) => this.dialog.querySelector(`#${id}`);

    byId('tr-close')?.addEventListener('click', () => this.close());
    byId('tr-start')?.addEventListener('click', () => this._start());
    byId('tr-cancel')?.addEventListener('click', () => this._cancel());
    byId('tr-again')?.addEventListener('click', () => this._reset());
    byId('tr-open-editor')?.addEventListener('click', () => {
      const fileId = this.job?.fileId;
      const filename = this.job?.summary?.filename || this.file?.name || '';
      this.close();
      if (fileId && this.onOpenEditor) this.onOpenEditor(fileId, filename);
    });
    byId('tr-use-file')?.addEventListener('click', () => {
      const fileId = this.job?.fileId;
      const filename = this.job?.summary?.filename || this.file?.name || '';
      this.close();
      if (fileId && this.onUseFile) this.onUseFile(fileId, filename);
    });

    this._bindFileInput();
    this._bindSelectControls();
  }

  /** @private */
  _bindFileInput() {
    const input = this.dialog.querySelector('#tr-file-input');
    const dropzone = this.dialog.querySelector('#tr-dropzone');
    if (!input || !dropzone) return;

    input.addEventListener('change', () => {
      if (input.files && input.files[0]) this._setFile(input.files[0]);
    });
    dropzone.addEventListener('click', () => input.click());
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });
    for (const type of ['dragover', 'dragenter']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-over');
      });
    }
    dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) this._setFile(file);
    });
  }

  /** @private */
  _bindSelectControls() {
    const backend = this.dialog.querySelector('#tr-backend');
    backend?.addEventListener('change', () => {
      this.selectedBackendId = backend.value;
      // Re-render: the engine change may disable options and quality levels.
      this.update();
    });

    for (const button of this.dialog.querySelectorAll('.tr-quality')) {
      button.addEventListener('click', () => {
        this.quality = button.dataset.quality;
        this.update();
      });
    }

    for (const checkbox of this.dialog.querySelectorAll('[data-flag]')) {
      checkbox.addEventListener('change', () => {
        this.flags[checkbox.dataset.flag] = checkbox.checked;
      });
    }
  }

  /**
   * Accept a picked file and read its duration where the browser can,
   * without decoding the whole thing.
   * @param {File} file
   * @private
   */
  _setFile(file) {
    this.file = file;
    this.fileDuration = null;
    this.update();

    this._revokeObjectUrl();
    try {
      this._objectUrl = URL.createObjectURL(file);
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(probe.duration)) {
          this.fileDuration = probe.duration;
          if (this.view === 'select') this.update();
        }
        this._revokeObjectUrl();
      });
      probe.addEventListener('error', () => this._revokeObjectUrl());
      probe.src = this._objectUrl;
    } catch (_) {
      // Duration is a nicety; the server reads the real one with ffprobe.
      this._revokeObjectUrl();
    }
  }

  /** @private */
  _revokeObjectUrl() {
    if (this._objectUrl) {
      try {
        URL.revokeObjectURL(this._objectUrl);
      } catch (_) {
        /* ignore */
      }
      this._objectUrl = null;
    }
  }

  /**
   * Queue the job and switch to the progress view.
   * @private
   */
  async _start() {
    if (!this.file) return;
    this.error = null;
    this.job = { id: null, stage: null, progress: null, status: 'queued' };
    this.view = 'running';
    this.update();

    try {
      const response = await this.api.transcribeAudioFile(this.file, {
        backendId: this.selectedBackendId === 'auto' ? null : this.selectedBackendId,
        quality: this.quality,
        flags: this.flags
      });
      this.job = { ...this.job, ...(response.job || {}) };
      this.logger?.info?.(`Transcription queued: ${this.job.id}`);
      // An event may have arrived while the upload was in flight; re-sync.
      await this._syncJob();
    } catch (error) {
      this.error = { message: error.message };
      this.view = 'result';
      this.update();
    }
  }

  /**
   * Pull the authoritative job state — events can be missed while the HTTP
   * upload is in flight, or when the modal is re-opened later.
   * @private
   */
  async _syncJob() {
    if (!this.job?.id) return;
    try {
      const { job } = await this.api.getTranscriptionStatus(this.job.id);
      if (!job) return;
      this.job = { ...this.job, ...job };
      if (job.status === 'complete') {
        this.view = 'result';
        this.update();
        if (job.fileId && this.onImported) this.onImported(job.fileId);
      } else if (job.status === 'failed') {
        this.error = job.error || { message: this.t('transcription.result.failed') };
        this.view = 'result';
        this.update();
      } else if (job.status === 'cancelled') {
        this.view = 'select';
        this.update();
      } else {
        this._renderProgress();
      }
    } catch (_) {
      /* the events remain the primary channel */
    }
  }

  /** @private */
  async _cancel() {
    if (!this.job?.id) {
      this.view = 'select';
      this.update();
      return;
    }
    try {
      await this.api.cancelTranscription(this.job.id);
    } catch (error) {
      this.logger?.error?.(`Transcription cancel failed: ${error.message}`);
    }
  }

  /** @private */
  _reset() {
    this.job = null;
    this.error = null;
    this.file = null;
    this.fileDuration = null;
    this.view = 'select';
    this.update();
  }

  /**
   * Repaint only the moving parts. A full `update()` on every progress frame
   * would rebuild the DOM several times a second and fight the screen
   * reader.
   * @private
   */
  _renderProgress() {
    if (!this.dialog || this.view !== 'running') return;
    const wrap = this.dialog.querySelector('#tr-progress-wrap');
    if (wrap) wrap.innerHTML = this._renderProgressBar();
    for (const item of this.dialog.querySelectorAll('.tr-stage')) {
      const state = this._stageState(item.dataset.stage);
      item.className = `tr-stage is-${state}`;
    }
  }

  /**
   * @returns {?Object} The selected backend descriptor, or null in `auto`.
   * @private
   */
  _selectedBackend() {
    if (this.selectedBackendId === 'auto') return null;
    return this.backends.find((backend) => backend.id === this.selectedBackendId) || null;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {number} seconds
 * @returns {string} `m:ss`, or `h:mm:ss` past an hour.
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

if (typeof window !== 'undefined') {
  window.TranscriptionModal = TranscriptionModal;
}
