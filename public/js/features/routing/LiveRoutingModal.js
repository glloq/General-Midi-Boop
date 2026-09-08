/**
 * @file public/js/features/routing/LiveRoutingModal.js
 * @description UI surface for the live MIDI routing engine (`MidiRouter`).
 *
 * Audit finding **F-138 (P1)** — remediation **R12**: fifteen `route_*` /
 * `filter_*` / `channel_map` WebSocket commands were registered, schema-
 * validated, unit-tested and documented in `docs/API.md`, yet **not one of
 * them had a caller in the SPA**. `MidiRouter.addRoute()` was reachable only
 * from `session_load` and the DB re-hydration, so an operator who plugged in a
 * BLE or USB keyboard had no way whatsoever to route it to an instrument —
 * breaking the README promise "inbound BLE notes are routed like any other
 * input".
 *
 * This modal closes that gap using **only the existing backend commands**:
 *
 *   create      → `route_create`      list      → `route_list`
 *   enable      → `route_enable`      inspect   → `route_info`
 *   delete      → `route_delete`      duplicate → `route_duplicate`
 *   test note   → `route_test`        export    → `route_export`
 *   import JSON → `route_import`      clear all → `route_clear_all`
 *   channel map → `channel_map`       filter    → `filter_set` / `filter_clear`
 *
 * Accessibility (audit L09, F-103/F-104): it extends `BaseModal`, which already
 * provides `role="dialog"`, `aria-modal`, Escape-to-close, a focus trap and
 * focus restoration. Every control rendered here carries either a `<label for>`
 * or an `aria-label`, and no button is icon-only.
 *
 * i18n (CLAUDE.md convention): `tHtml()` for anything interpolated into
 * `innerHTML`, plain `t()` for `textContent`, `.title`, `.value`,
 * `.placeholder` and `setAttribute` sinks. Never both.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof window.BaseModal !== 'function') return;

  const BaseModal = window.BaseModal;

  /**
   * MIDI message types `MidiRouter.passesFilter()` understands, paired with the
   * i18n key of their label. `wire` is the exact string the router compares
   * against (`DEVICE_MSG_TYPES` in `src/core/constants.js`) — it must not be
   * translated.
   */
  const FILTER_TYPES = [
    { wire: 'noteon', key: 'noteon' },
    { wire: 'noteoff', key: 'noteoff' },
    { wire: 'cc', key: 'cc' },
    { wire: 'program', key: 'program' },
    { wire: 'pitchbend', key: 'pitchbend' },
    { wire: 'channel aftertouch', key: 'channelAftertouch' },
    { wire: 'poly aftertouch', key: 'polyAftertouch' }
  ];

  const CHANNEL_COUNT = 16;

  class LiveRoutingModal extends BaseModal {
    /**
     * @param {Object} apiClient - `BackendAPIClient` (needs `sendCommand`).
     */
    constructor(apiClient) {
      super({
        id: 'live-routing-modal',
        size: 'lg',
        title: 'liveRouting.title',
        closeOnEscape: true,
        closeOnOverlay: true,
        customClass: 'live-routing-modal'
      });
      this.apiClient = apiClient;
      /** @type {Object[]} */
      this.devices = [];
      /** @type {Object[]} */
      this.routes = [];
      /** @type {?string} route currently open in the editor panel */
      this.editingId = null;
      this._busy = false;
    }

    // ── rendering ───────────────────────────────────────────────────────────

    renderBody() {
      // innerHTML sink → tHtml (no params here, but keep the sink consistent).
      const h = (k) => this.tHtml(k);
      return `
        <div class="lrt">
          <p class="lrt-intro">${h('liveRouting.intro')}</p>

          <section class="lrt-section" aria-labelledby="lrt-create-heading">
            <h3 class="lrt-heading" id="lrt-create-heading">${h('liveRouting.createHeading')}</h3>
            <div class="lrt-create-row">
              <div class="lrt-field">
                <label class="lrt-label" for="lrt-source">${h('liveRouting.source')}</label>
                <select id="lrt-source" class="lrt-select"></select>
              </div>
              <span class="lrt-arrow" aria-hidden="true">→</span>
              <div class="lrt-field">
                <label class="lrt-label" for="lrt-destination">${h('liveRouting.destination')}</label>
                <select id="lrt-destination" class="lrt-select"></select>
              </div>
              <button type="button" class="lrt-btn lrt-btn-primary" id="lrt-create">
                ${h('liveRouting.create')}
              </button>
              <button type="button" class="lrt-btn" id="lrt-refresh">
                ${h('liveRouting.refresh')}
              </button>
            </div>
            <p class="lrt-hint" id="lrt-no-devices" hidden>${h('liveRouting.noDevices')}</p>
          </section>

          <section class="lrt-section" aria-labelledby="lrt-list-heading">
            <h3 class="lrt-heading" id="lrt-list-heading">${h('liveRouting.routesHeading')}</h3>
            <div id="lrt-routes" class="lrt-routes"></div>
          </section>

          <section class="lrt-section lrt-editor" id="lrt-editor" hidden
                   aria-labelledby="lrt-editor-heading">
            <h3 class="lrt-heading" id="lrt-editor-heading">${h('liveRouting.editorHeading')}</h3>
            <p class="lrt-editing" id="lrt-editing-label"></p>

            <fieldset class="lrt-fieldset">
              <legend>${h('liveRouting.channelMap')}</legend>
              <p class="lrt-hint">${h('liveRouting.channelMapHint')}</p>
              <div class="lrt-chmap" id="lrt-chmap"></div>
              <div class="lrt-actions">
                <button type="button" class="lrt-btn lrt-btn-primary" id="lrt-chmap-save">
                  ${h('liveRouting.applyChannelMap')}
                </button>
                <button type="button" class="lrt-btn" id="lrt-chmap-reset">
                  ${h('liveRouting.clearChannelMap')}
                </button>
              </div>
            </fieldset>

            <fieldset class="lrt-fieldset">
              <legend>${h('liveRouting.filter')}</legend>
              <p class="lrt-hint">${h('liveRouting.filterHint')}</p>
              <div class="lrt-filter-types" id="lrt-filter-types"></div>
              <div class="lrt-filter-ranges">
                <div class="lrt-field">
                  <label class="lrt-label" for="lrt-note-min">${h('liveRouting.noteMin')}</label>
                  <input type="number" min="0" max="127" step="1" id="lrt-note-min"
                         class="lrt-input" />
                </div>
                <div class="lrt-field">
                  <label class="lrt-label" for="lrt-note-max">${h('liveRouting.noteMax')}</label>
                  <input type="number" min="0" max="127" step="1" id="lrt-note-max"
                         class="lrt-input" />
                </div>
                <div class="lrt-field">
                  <label class="lrt-label" for="lrt-vel-min">${h('liveRouting.velocityMin')}</label>
                  <input type="number" min="0" max="127" step="1" id="lrt-vel-min"
                         class="lrt-input" />
                </div>
                <div class="lrt-field">
                  <label class="lrt-label" for="lrt-vel-max">${h('liveRouting.velocityMax')}</label>
                  <input type="number" min="0" max="127" step="1" id="lrt-vel-max"
                         class="lrt-input" />
                </div>
              </div>
              <div class="lrt-actions">
                <button type="button" class="lrt-btn lrt-btn-primary" id="lrt-filter-save">
                  ${h('liveRouting.applyFilter')}
                </button>
                <button type="button" class="lrt-btn" id="lrt-filter-clear">
                  ${h('liveRouting.clearFilter')}
                </button>
                <button type="button" class="lrt-btn" id="lrt-editor-close">
                  ${h('liveRouting.closeEditor')}
                </button>
              </div>
            </fieldset>
          </section>

          <section class="lrt-section" aria-labelledby="lrt-io-heading">
            <h3 class="lrt-heading" id="lrt-io-heading">${h('liveRouting.ioHeading')}</h3>
            <div class="lrt-field lrt-field-block">
              <label class="lrt-label" for="lrt-import-json">${h('liveRouting.importLabel')}</label>
              <textarea id="lrt-import-json" class="lrt-textarea" rows="3"
                        spellcheck="false"></textarea>
            </div>
            <div class="lrt-actions">
              <button type="button" class="lrt-btn" id="lrt-import">
                ${h('liveRouting.import')}
              </button>
              <button type="button" class="lrt-btn lrt-btn-danger" id="lrt-clear-all">
                ${h('liveRouting.clearAll')}
              </button>
            </div>
          </section>

          <p class="lrt-status" id="lrt-status" role="status" aria-live="polite"></p>
        </div>
      `;
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Write a message into the live region. `textContent` sink → plain `t()`.
     * @param {string} key i18n key
     * @param {Object} [params]
     */
    _say(key, params) {
      const el = this.$('#lrt-status');
      if (el) el.textContent = this.t(key, params || {});
    }

    /** @param {string} text raw (already-resolved) message */
    _sayRaw(text) {
      const el = this.$('#lrt-status');
      if (el) el.textContent = String(text);
    }

    /**
     * Run a command, reporting failures into the status line instead of
     * throwing into a click handler.
     * @param {string} command
     * @param {Object} [data]
     * @returns {Promise<?Object>} the response, or null when it failed
     */
    async _send(command, data) {
      if (!this.apiClient || typeof this.apiClient.sendCommand !== 'function') {
        this._say('liveRouting.notConnected');
        return null;
      }
      try {
        return await this.apiClient.sendCommand(command, data || {});
      } catch (err) {
        this._sayRaw(
          this.t('liveRouting.commandFailed', { command }) +
            ' ' +
            (err && err.message ? err.message : String(err))
        );
        return null;
      }
    }

    /** Friendly label for a device id (falls back to the raw id). */
    _deviceLabel(id) {
      const d = this.devices.find((x) => String(x.id) === String(id));
      if (!d) return String(id == null ? '' : id);
      return d.displayName || d.customName || d.name || String(d.id);
    }

    // ── data loading ────────────────────────────────────────────────────────

    /**
     * Pull `device_list` and repopulate both selects.
     *
     * The direction flags reported by `DeviceManager.getDeviceList()` are a
     * hint, not a contract (a soft virtual instrument is `input:false`, a BLE
     * device claims both, a USB port depends on which ALSA ports exist), and
     * `route_create` accepts any pair. So both selects list **every** device,
     * with the direction-appropriate ones grouped first — the operator is
     * guided, never blocked.
     */
    async refreshDevices() {
      const res = await this._send('device_list', {});
      const list = (res && (res.devices || res.list)) || [];
      this.devices = Array.isArray(list) ? list : [];

      this._fillSelect(
        '#lrt-source',
        this.devices.filter((d) => d && d.input !== false),
        'liveRouting.groupInputs'
      );
      this._fillSelect(
        '#lrt-destination',
        this.devices.filter((d) => d && d.output !== false),
        'liveRouting.groupOutputs'
      );

      const empty = this.$('#lrt-no-devices');
      if (empty) empty.hidden = this.devices.length > 0;
      const createBtn = this.$('#lrt-create');
      if (createBtn) createBtn.disabled = this.devices.length === 0;
    }

    /**
     * @param {string} selector
     * @param {Object[]} preferred - devices matching the select's direction
     * @param {string} preferredLabelKey - i18n key of the first optgroup label
     */
    _fillSelect(selector, preferred, preferredLabelKey) {
      const sel = this.$(selector);
      if (!sel) return;
      const previous = sel.value;
      sel.innerHTML = '';

      const preferredIds = new Set(preferred.map((d) => String(d.id)));
      const others = this.devices.filter((d) => d && !preferredIds.has(String(d.id)));

      const addGroup = (devices, labelKey) => {
        if (devices.length === 0) return;
        let parent = sel;
        // Only introduce an optgroup when there is something to separate.
        if (preferred.length > 0 && others.length > 0) {
          parent = document.createElement('optgroup');
          // `.label` is an attribute-style sink, not innerHTML → plain t().
          parent.label = this.t(labelKey);
          sel.appendChild(parent);
        }
        devices.forEach((d) => {
          const opt = document.createElement('option');
          // `.value` / `.textContent` are NOT innerHTML sinks — assigning the
          // raw string is correct here and escaping would double-escape.
          opt.value = String(d.id);
          opt.textContent = this._deviceLabel(d.id);
          parent.appendChild(opt);
        });
      };

      addGroup(preferred, preferredLabelKey);
      addGroup(others, 'liveRouting.groupOther');

      if (previous && this.devices.some((d) => String(d.id) === previous)) sel.value = previous;
    }

    /** Pull `route_list` and re-render the table. */
    async refreshRoutes() {
      const res = await this._send('route_list', {});
      const list = (res && (res.routes || res.list)) || [];
      this.routes = Array.isArray(list) ? list : [];
      this._renderRoutes();
      if (this.editingId && !this.routes.some((r) => String(r.id) === String(this.editingId))) {
        this._closeEditor();
      }
    }

    _renderRoutes() {
      const host = this.$('#lrt-routes');
      if (!host) return;

      if (this.routes.length === 0) {
        host.innerHTML = `<p class="lrt-empty">${this.tHtml('liveRouting.empty')}</p>`;
        return;
      }

      host.innerHTML = this.routes
        .map((route, index) => {
          const id = this.escape(String(route.id));
          const checkboxId = `lrt-enabled-${index}`;
          const filterCount = route.filter ? Object.keys(route.filter).length : 0;
          const mapCount = route.channelMap ? Object.keys(route.channelMap).length : 0;
          // tHtml escapes each param against the trusted locale template.
          const path = this.tHtml('liveRouting.routePath', {
            source: this._deviceLabel(route.source),
            destination: this._deviceLabel(route.destination)
          });
          const meta = this.tHtml('liveRouting.routeMeta', {
            channels: mapCount,
            filters: filterCount
          });
          const enabled = route.enabled !== false ? ' checked' : '';
          const act = (action, labelKey, extra) =>
            `<button type="button" class="lrt-btn lrt-btn-sm${extra || ''}" ` +
            `data-lrt-action="${action}" data-lrt-id="${id}">` +
            `${this.tHtml('liveRouting.' + labelKey)}</button>`;

          return `
            <div class="lrt-route" data-lrt-route="${id}">
              <div class="lrt-route-main">
                <input type="checkbox" class="lrt-enabled" id="${checkboxId}"
                       data-lrt-action="enable" data-lrt-id="${id}"${enabled} />
                <label class="lrt-enabled-label" for="${checkboxId}">${this.tHtml(
                  'liveRouting.enabled'
                )}</label>
                <span class="lrt-route-path">${path}</span>
                <span class="lrt-route-meta">${meta}</span>
              </div>
              <div class="lrt-route-actions">
                ${act('edit', 'edit')}
                ${act('info', 'info')}
                ${act('test', 'test')}
                ${act('duplicate', 'duplicate')}
                ${act('export', 'export')}
                ${act('delete', 'delete', ' lrt-btn-danger')}
              </div>
            </div>`;
        })
        .join('');
    }

    // ── editor panel ────────────────────────────────────────────────────────

    /** @param {string} routeId */
    _openEditor(routeId) {
      const route = this.routes.find((r) => String(r.id) === String(routeId));
      if (!route) return;
      this.editingId = String(routeId);

      const panel = this.$('#lrt-editor');
      if (panel) panel.hidden = false;

      const label = this.$('#lrt-editing-label');
      if (label) {
        // textContent sink → t()
        label.textContent = this.t('liveRouting.editing', {
          source: this._deviceLabel(route.source),
          destination: this._deviceLabel(route.destination)
        });
      }

      this._renderChannelMap(route.channelMap || {});
      this._renderFilter(route.filter || {});
    }

    _closeEditor() {
      this.editingId = null;
      const panel = this.$('#lrt-editor');
      if (panel) panel.hidden = true;
    }

    /** @param {Object} channelMap */
    _renderChannelMap(channelMap) {
      const host = this.$('#lrt-chmap');
      if (!host) return;
      let html = '';
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        const selectId = `lrt-chmap-${ch}`;
        let options = `<option value="">${this.tHtml('liveRouting.channelPassthrough')}</option>`;
        for (let target = 0; target < CHANNEL_COUNT; target++) {
          const current = channelMap[ch] != null ? Number(channelMap[ch]) : null;
          const selected = current === target ? ' selected' : '';
          options += `<option value="${target}"${selected}>${target + 1}</option>`;
        }
        html +=
          `<div class="lrt-chmap-cell">` +
          `<label class="lrt-label" for="${selectId}">${this.tHtml('liveRouting.channelN', {
            channel: ch + 1
          })}</label>` +
          `<select class="lrt-select lrt-select-sm" id="${selectId}" data-lrt-channel="${ch}">${options}</select>` +
          `</div>`;
      }
      host.innerHTML = html;
    }

    /** @param {Object} filter */
    _renderFilter(filter) {
      const host = this.$('#lrt-filter-types');
      if (host) {
        const active = Array.isArray(filter.types) ? filter.types : [];
        host.innerHTML = FILTER_TYPES.map((type, i) => {
          const inputId = `lrt-filter-type-${i}`;
          const checked = active.includes(type.wire) ? ' checked' : '';
          return (
            `<span class="lrt-check">` +
            `<input type="checkbox" id="${inputId}" data-lrt-type="${this.escape(type.wire)}"${checked} />` +
            `<label for="${inputId}">${this.tHtml('liveRouting.types.' + type.key)}</label>` +
            `</span>`
          );
        }).join('');
      }
      const setNum = (sel, value) => {
        const el = this.$(sel);
        if (el) el.value = value == null ? '' : String(value);
      };
      setNum('#lrt-note-min', filter.noteRange ? filter.noteRange.min : null);
      setNum('#lrt-note-max', filter.noteRange ? filter.noteRange.max : null);
      setNum('#lrt-vel-min', filter.velocityRange ? filter.velocityRange.min : null);
      setNum('#lrt-vel-max', filter.velocityRange ? filter.velocityRange.max : null);
    }

    /** @returns {Object} the channel map currently drawn in the editor */
    _collectChannelMap() {
      const mapping = {};
      this.$$('#lrt-chmap select[data-lrt-channel]').forEach((sel) => {
        if (sel.value === '') return;
        const target = parseInt(sel.value, 10);
        if (Number.isFinite(target)) mapping[sel.getAttribute('data-lrt-channel')] = target;
      });
      return mapping;
    }

    /** @returns {Object} the filter currently drawn in the editor */
    _collectFilter() {
      const filter = {};
      const types = [];
      this.$$('#lrt-filter-types input[data-lrt-type]').forEach((cb) => {
        if (cb.checked) types.push(cb.getAttribute('data-lrt-type'));
      });
      if (types.length) filter.types = types;

      const num = (sel) => {
        const el = this.$(sel);
        if (!el || el.value === '' || el.value == null) return null;
        const n = parseInt(el.value, 10);
        return Number.isFinite(n) ? n : null;
      };
      const noteMin = num('#lrt-note-min');
      const noteMax = num('#lrt-note-max');
      if (noteMin != null || noteMax != null) {
        filter.noteRange = {
          min: noteMin == null ? 0 : noteMin,
          max: noteMax == null ? 127 : noteMax
        };
      }
      const velMin = num('#lrt-vel-min');
      const velMax = num('#lrt-vel-max');
      if (velMin != null || velMax != null) {
        filter.velocityRange = {
          min: velMin == null ? 0 : velMin,
          max: velMax == null ? 127 : velMax
        };
      }
      return filter;
    }

    // ── actions ─────────────────────────────────────────────────────────────

    async _createRoute() {
      const source = (this.$('#lrt-source') || {}).value;
      const destination = (this.$('#lrt-destination') || {}).value;
      if (!source || !destination) {
        this._say('liveRouting.pickBoth');
        return null;
      }
      const res = await this._send('route_create', { source, destination, enabled: true });
      if (!res) return null;
      this._say('liveRouting.created');
      await this.refreshRoutes();
      return res;
    }

    /**
     * @param {string} action
     * @param {string} routeId
     * @param {?HTMLElement} el the control that triggered it
     */
    async _routeAction(action, routeId, el) {
      switch (action) {
        case 'enable': {
          const enabled = !!(el && el.checked);
          const ok = await this._send('route_enable', { routeId, enabled });
          if (ok) this._say('liveRouting.stateSaved');
          await this.refreshRoutes();
          break;
        }
        case 'delete': {
          if (!window.confirm(this.t('liveRouting.confirmDelete'))) return;
          const ok = await this._send('route_delete', { routeId });
          if (ok) this._say('liveRouting.deleted');
          if (String(this.editingId) === String(routeId)) this._closeEditor();
          await this.refreshRoutes();
          break;
        }
        case 'duplicate': {
          const ok = await this._send('route_duplicate', { routeId });
          if (ok) this._say('liveRouting.duplicated');
          await this.refreshRoutes();
          break;
        }
        case 'test': {
          const res = await this._send('route_test', { routeId });
          if (res) {
            this._sayRaw(
              res.success === false
                ? this.t('liveRouting.testFailed', { error: res.error || '' })
                : this.t('liveRouting.testSent', {
                    destination: this._deviceLabel(res.destination)
                  })
            );
          }
          break;
        }
        case 'info': {
          const res = await this._send('route_info', { routeId });
          if (res && res.route) this._sayRaw(JSON.stringify(res.route));
          break;
        }
        case 'export': {
          const res = await this._send('route_export', { routeId });
          if (res && res.route) {
            const box = this.$('#lrt-import-json');
            // `.value` is not an innerHTML sink — assign the raw JSON.
            if (box) box.value = JSON.stringify(res.route, null, 2);
            this._say('liveRouting.exported');
          }
          break;
        }
        case 'edit':
          this._openEditor(routeId);
          break;
        default:
          break;
      }
    }

    async _saveChannelMap() {
      if (!this.editingId) return;
      const ok = await this._send('channel_map', {
        routeId: this.editingId,
        mapping: this._collectChannelMap()
      });
      if (ok) this._say('liveRouting.channelMapSaved');
      await this.refreshRoutes();
    }

    async _resetChannelMap() {
      if (!this.editingId) return;
      const ok = await this._send('channel_map', { routeId: this.editingId, mapping: {} });
      if (ok) {
        this._say('liveRouting.channelMapCleared');
        this._renderChannelMap({});
      }
      await this.refreshRoutes();
    }

    async _saveFilter() {
      if (!this.editingId) return;
      const ok = await this._send('filter_set', {
        routeId: this.editingId,
        filter: this._collectFilter()
      });
      if (ok) this._say('liveRouting.filterSaved');
      await this.refreshRoutes();
    }

    async _clearFilter() {
      if (!this.editingId) return;
      const ok = await this._send('filter_clear', { routeId: this.editingId });
      if (ok) {
        this._say('liveRouting.filterCleared');
        this._renderFilter({});
      }
      await this.refreshRoutes();
    }

    async _importRoute() {
      const box = this.$('#lrt-import-json');
      const raw = box ? String(box.value || '').trim() : '';
      if (!raw) {
        this._say('liveRouting.importEmpty');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        this._say('liveRouting.importInvalid');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this._say('liveRouting.importInvalid');
        return;
      }
      // `route_import` re-uses `route.id` when present, which would collide with
      // the exported route — drop it so the backend mints a fresh one.
      const route = Object.assign({}, parsed);
      delete route.id;
      const ok = await this._send('route_import', { route });
      if (ok) this._say('liveRouting.imported');
      await this.refreshRoutes();
    }

    async _clearAll() {
      if (!window.confirm(this.t('liveRouting.confirmClearAll'))) return;
      const res = await this._send('route_clear_all', {});
      if (res) this._sayRaw(this.t('liveRouting.clearedAll', { count: res.deleted ?? 0 }));
      this._closeEditor();
      await this.refreshRoutes();
    }

    // ── wiring ──────────────────────────────────────────────────────────────

    onOpen() {
      const on = (selector, event, handler) => {
        const el = this.$(selector);
        if (el) el.addEventListener(event, handler);
      };

      on('#lrt-create', 'click', () => this._createRoute());
      on('#lrt-refresh', 'click', () => this.reload());
      on('#lrt-chmap-save', 'click', () => this._saveChannelMap());
      on('#lrt-chmap-reset', 'click', () => this._resetChannelMap());
      on('#lrt-filter-save', 'click', () => this._saveFilter());
      on('#lrt-filter-clear', 'click', () => this._clearFilter());
      on('#lrt-editor-close', 'click', () => this._closeEditor());
      on('#lrt-import', 'click', () => this._importRoute());
      on('#lrt-clear-all', 'click', () => this._clearAll());

      // One delegated listener on the route list: rows are re-rendered on every
      // refresh, so per-row listeners would have to be re-attached (and would
      // leak if a render were missed).
      const host = this.$('#lrt-routes');
      if (host) {
        this._listHandler = (e) => {
          const el = e.target && e.target.closest ? e.target.closest('[data-lrt-action]') : null;
          if (!el || !host.contains(el)) return;
          const action = el.getAttribute('data-lrt-action');
          if (action === 'enable' && e.type !== 'change') return;
          if (action !== 'enable' && e.type !== 'click') return;
          this._routeAction(action, el.getAttribute('data-lrt-id'), el);
        };
        host.addEventListener('click', this._listHandler);
        host.addEventListener('change', this._listHandler);
        this._listHost = host;
      }

      this.reload();
    }

    /** Re-read devices and routes from the backend. */
    async reload() {
      if (this._busy) return;
      this._busy = true;
      try {
        await this.refreshDevices();
        await this.refreshRoutes();
      } finally {
        this._busy = false;
      }
    }

    onClose() {
      if (this._listHost && this._listHandler) {
        this._listHost.removeEventListener('click', this._listHandler);
        this._listHost.removeEventListener('change', this._listHandler);
      }
      this._listHost = null;
      this._listHandler = null;
      this.editingId = null;
    }

    // BaseModal.update() (locale change) replaces the body innerHTML and drops
    // every listener attached in onOpen; re-run the wiring, exactly as
    // SystemAdminModal does.
    onUpdate() {
      this.onClose();
      this.onOpen();
    }
  }

  window.LiveRoutingModal = LiveRoutingModal;
})();
