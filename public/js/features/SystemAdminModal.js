/**
 * @file SystemAdminModal.js
 * @description UI surface for the previously headless `system_*` (T2.6) and
 * `session_*` (T2.7) WebSocket commands. Both command families were fully
 * implemented and tested on the backend but had NO frontend, so the operator
 * could not reach status/info/logs/backup/restore/restart/reboot/shutdown or
 * save/load/list/delete/export/import a session.
 *
 * Extends BaseModal. Every destructive action (clear logs, restore, restart,
 * reboot, shutdown, delete session) is gated behind window.confirm. The command
 * wiring is unit-tested in tests/frontend/system-admin-modal.test.js; the actual
 * hardware effect (a real reboot/shutdown on the Pi) is T9 runtime QA.
 *
 * Note: system_update / system_check_update are intentionally NOT duplicated
 * here — they are already wired in the Settings modal (SettingsUpdate.js).
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof window.BaseModal !== 'function') return;

  const BaseModal = window.BaseModal;

  function tt(key, fallback) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  class SystemAdminModal extends BaseModal {
    constructor(apiClient) {
      super({
        id: 'system-admin-modal',
        size: 'lg',
        title: 'systemAdmin.title',
        closeOnEscape: true,
        closeOnOverlay: true,
        customClass: 'system-admin-modal'
      });
      this.apiClient = apiClient;
    }

    renderBody() {
      const btn = (id, label, danger) =>
        `<button type="button" id="${id}" style="padding:6px 12px;margin:3px;border-radius:7px;cursor:pointer;border:1px solid ${
          danger ? 'rgba(220,38,38,0.4)' : 'var(--border-color,#d1d5db)'
        };background:${danger ? 'rgba(220,38,38,0.08)' : 'var(--bg-secondary,#f3f4f6)'};color:${
          danger ? '#dc2626' : 'var(--text-primary,#1f2937)'
        };font-size:13px;">${this.escape(label)}</button>`;

      const T = (k, f) => this.escape(tt(k, f));

      return `
        <div class="sam-section">
          <h3 style="margin:8px 0;font-size:14px;">${T('systemAdmin.systemSection', 'Système')}</h3>
          <div class="sam-actions" style="display:flex;flex-wrap:wrap;">
            ${btn('sam-status', T('systemAdmin.status', 'Statut'))}
            ${btn('sam-info', T('systemAdmin.info', 'Infos'))}
            ${btn('sam-logs', T('systemAdmin.logs', 'Logs'))}
            ${btn('sam-backup', T('systemAdmin.backup', 'Sauvegarder'))}
            ${btn('sam-clear-logs', T('systemAdmin.clearLogs', 'Vider les logs'), true)}
            ${btn('sam-restart', T('systemAdmin.restart', "Redémarrer l'app"), true)}
            ${btn('sam-reboot', T('systemAdmin.reboot', 'Reboot'), true)}
            ${btn('sam-shutdown', T('systemAdmin.shutdown', 'Éteindre'), true)}
          </div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
            <input type="text" id="sam-restore-path" placeholder="${T(
              'systemAdmin.restorePath',
              'Chemin de sauvegarde à restaurer'
            )}" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border-color,#d1d5db);font-size:12px;" />
            ${btn('sam-restore', T('systemAdmin.restore', 'Restaurer'), true)}
          </div>
        </div>

        <div class="sam-section" style="margin-top:14px;">
          <h3 style="margin:8px 0;font-size:14px;">${T('systemAdmin.sessionsSection', 'Sessions')}</h3>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="sam-session-name" placeholder="${T(
              'systemAdmin.sessionName',
              'Nom de la session'
            )}" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border-color,#d1d5db);font-size:12px;" />
            ${btn('sam-session-save', T('systemAdmin.sessionSave', 'Sauvegarder'))}
            ${btn('sam-session-refresh', T('systemAdmin.sessionRefresh', 'Rafraîchir la liste'))}
          </div>
          <div id="sam-session-list" style="margin-top:8px;"></div>
        </div>

        <div class="sam-section" style="margin-top:14px;">
          <h3 style="margin:8px 0;font-size:14px;">${T('systemAdmin.result', 'Résultat')}</h3>
          <pre id="sam-result" style="max-height:220px;overflow:auto;background:var(--bg-tertiary,#111827);color:#e5e7eb;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;">—</pre>
        </div>
      `;
    }

    _setResult(value) {
      const el = this.$('#sam-result');
      if (!el) return;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      el.textContent = text;
    }

    /**
     * Dispatch a command, optionally gated by a confirmation. Renders the
     * response (or error) into the result pane. Returns the promise so tests
     * and the sessions refresh can await it.
     */
    async _run(command, data, confirmMsg) {
      if (confirmMsg && !window.confirm(confirmMsg)) return null;
      try {
        this._setResult(tt('systemAdmin.running', '…'));
        const res = await this.apiClient.sendCommand(command, data || {});
        this._setResult(res);
        return res;
      } catch (err) {
        this._setResult(
          (tt('systemAdmin.error', 'Erreur') + ': ' + (err && err.message ? err.message : err))
        );
        return null;
      }
    }

    async _refreshSessions() {
      const res = await this._run('session_list', {});
      const listEl = this.$('#sam-session-list');
      if (!listEl) return;
      const sessions = (res && (res.sessions || res.list || res.data)) || [];
      if (!Array.isArray(sessions) || sessions.length === 0) {
        listEl.innerHTML = `<div style="color:var(--text-muted,#9ca3af);font-size:12px;">${this.escape(
          tt('systemAdmin.noSessions', 'Aucune session')
        )}</div>`;
        return;
      }
      listEl.innerHTML = sessions
        .map((s) => {
          const id = s.id != null ? s.id : s.sessionId;
          const name = s.name != null ? s.name : `#${id}`;
          return `<div class="sam-session-row" style="display:flex;gap:6px;align-items:center;padding:3px 0;">
            <span style="flex:1;font-size:12px;">${this.escape(name)}</span>
            <button type="button" data-sam-load="${this.escape(String(id))}" style="font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;">${this.escape(tt('systemAdmin.sessionLoad', 'Charger'))}</button>
            <button type="button" data-sam-export="${this.escape(String(id))}" style="font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;">${this.escape(tt('systemAdmin.sessionExport', 'Exporter'))}</button>
            <button type="button" data-sam-delete="${this.escape(String(id))}" style="font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;color:#dc2626;">${this.escape(tt('systemAdmin.sessionDelete', 'Supprimer'))}</button>
          </div>`;
        })
        .join('');
      listEl.querySelectorAll('[data-sam-load]').forEach((b) =>
        b.addEventListener('click', () =>
          this._run('session_load', { sessionId: this._num(b.getAttribute('data-sam-load')) })
        )
      );
      listEl.querySelectorAll('[data-sam-export]').forEach((b) =>
        b.addEventListener('click', () =>
          this._run('session_export', { sessionId: this._num(b.getAttribute('data-sam-export')) })
        )
      );
      listEl.querySelectorAll('[data-sam-delete]').forEach((b) =>
        b.addEventListener('click', () =>
          this._run(
            'session_delete',
            { sessionId: this._num(b.getAttribute('data-sam-delete')) },
            tt('systemAdmin.confirmSessionDelete', 'Supprimer cette session ?')
          ).then((r) => {
            if (r) this._refreshSessions();
          })
        )
      );
    }

    _num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }

    onOpen() {
      const on = (id, fn) => {
        const el = this.$('#' + id);
        if (el) el.addEventListener('click', fn);
      };
      on('sam-status', () => this._run('system_status', {}));
      on('sam-info', () => this._run('system_info', {}));
      on('sam-logs', () => this._run('system_logs', { lines: 200 }));
      on('sam-backup', () => this._run('system_backup', {}));
      on('sam-clear-logs', () =>
        this._run('system_clear_logs', {}, tt('systemAdmin.confirmClearLogs', 'Vider les logs ?'))
      );
      on('sam-restart', () =>
        this._run(
          'system_restart',
          {},
          tt('systemAdmin.confirmRestart', "Redémarrer l'application ?")
        )
      );
      on('sam-reboot', () =>
        this._run('system_reboot', {}, tt('systemAdmin.confirmReboot', 'Redémarrer la machine ?'))
      );
      on('sam-shutdown', () =>
        this._run('system_shutdown', {}, tt('systemAdmin.confirmShutdown', 'Éteindre la machine ?'))
      );
      on('sam-restore', () => {
        const path = (this.$('#sam-restore-path') || {}).value;
        if (!path) {
          this._setResult(tt('systemAdmin.restoreNeedsPath', 'Indiquez un chemin de sauvegarde.'));
          return;
        }
        this._run(
          'system_restore',
          { path },
          tt('systemAdmin.confirmRestore', 'Restaurer cette sauvegarde ? Les données actuelles seront remplacées.')
        );
      });
      on('sam-session-save', () => {
        const name = (this.$('#sam-session-name') || {}).value || '';
        this._run('session_save', { name }).then((r) => {
          if (r) this._refreshSessions();
        });
      });
      on('sam-session-refresh', () => this._refreshSessions());
    }
  }

  window.SystemAdminModal = SystemAdminModal;
})();
