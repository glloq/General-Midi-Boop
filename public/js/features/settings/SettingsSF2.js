// Custom SF2 soundfont management — mixed into SettingsModal.prototype.
//
// Responsibilities:
//  - Fetch the list of custom SF2 banks from the server (GET /api/sf2)
//    and register them in MidiSynthesizerConstants so all synth instances
//    can use them.
//  - Render the #sf2BankList in the Settings → Son panel.
//  - Handle file upload (POST /api/sf2) with progress feedback.
//  - Handle delete (DELETE /api/sf2/:id) with a simple confirm.
//  - Rebuild the #soundBankSelect dropdown after any change.

(function () {
  'use strict';
  const SettingsSF2 = {};

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _fmt(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function _hasSynth() {
    return typeof MidiSynthesizer !== 'undefined';
  }

  function _savedBank() {
    return _hasSynth() && MidiSynthesizer.getSavedBank ? MidiSynthesizer.getSavedBank() : null;
  }

  function _eachInstance(fn) {
    if (_hasSynth() && MidiSynthesizer._instances) {
      for (const inst of MidiSynthesizer._instances) {
        try {
          fn(inst);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  /**
   * Register the fetched custom banks and re-apply the saved sf2: bank in
   * case the synth was constructed before the custom registry was hot
   * (e.g. after a page reload). Shared by loadCustomBanks / bootSync.
   */
  function _registerAndReapply(banks) {
    if (
      window.MidiSynthesizerConstants &&
      typeof window.MidiSynthesizerConstants.setCustomBanks === 'function'
    ) {
      window.MidiSynthesizerConstants.setCustomBanks(banks);
    }
    const saved = _savedBank();
    if (saved && saved.startsWith('sf2:')) {
      _eachInstance((inst) => inst.setSoundBank(saved));
    }
  }

  function _notifyDefaultMissing() {
    if (_hasSynth() && typeof MidiSynthesizer.notifyDefaultSf2Missing === 'function') {
      MidiSynthesizer.notifyDefaultSf2Missing();
    }
  }

  // ── Core ─────────────────────────────────────────────────────────────────

  /**
   * Fetch SF2 list, register custom banks, repopulate the dropdown and list.
   * Called by SettingsModal.open() and after any upload/delete.
   */
  SettingsSF2.loadCustomBanks = async function () {
    try {
      const res = await fetch('/api/sf2');
      if (!res.ok) return;
      const payload = await res.json();
      const banks = payload.banks || [];

      // Surface a toast when the built-in default soundfont is missing
      // from the server (postinstall hasn't run). Without this the
      // synth would silently produce no sound and the user wouldn't
      // know why. MidiSynthesizer.notifyDefaultSf2Missing dedupes so
      // multiple loadCustomBanks calls don't stack toasts.
      if (payload.defaultPresent === false) {
        _notifyDefaultMissing();
      }

      _registerAndReapply(banks);

      this._rebuildBankDropdown();
      this._renderSF2List(banks);
    } catch (e) {
      // Non-fatal: SF2 feature is optional
    }
  };

  /**
   * Rebuild the #soundBankSelect options to include custom SF2 banks.
   */
  SettingsSF2._rebuildBankDropdown = function () {
    const select = this.modal && this.modal.querySelector('#soundBankSelect');
    if (!select) return;
    const banks =
      typeof MidiSynthesizer !== 'undefined' && MidiSynthesizer.getAvailableBanks
        ? MidiSynthesizer.getAvailableBanks()
        : [];
    const defaultId =
      (window.MidiSynthesizerConstants && window.MidiSynthesizerConstants.DEFAULT_BANK_ID) ||
      'sf2:default';
    const currentVal = select.value || (this.settings && this.settings.soundBank) || defaultId;
    const i18n = window.i18n || { t: (k) => k };

    select.innerHTML = banks
      .map(function (bank) {
        const qualityLabel =
          i18n.t('settings.soundBank.quality.' + (bank.quality || 'medium')) || bank.quality || '';
        const sizeLabel = bank.sizeMB ? '~' + bank.sizeMB + ' MB' : '';
        const suffix =
          qualityLabel || sizeLabel
            ? ' (' + [qualityLabel, sizeLabel].filter(Boolean).join(' · ') + ')'
            : '';
        const sel = bank.id === currentVal ? ' selected' : '';
        // C-1: escape both id and label to prevent stored XSS via innerHTML
        return (
          '<option value="' +
          _esc(String(bank.id)) +
          '"' +
          sel +
          '>' +
          _esc(bank.label) +
          _esc(suffix) +
          '</option>'
        );
      })
      .join('');
  };

  /**
   * Render the #sf2BankList DOM element.
   */
  SettingsSF2._renderSF2List = function (banks) {
    const list = this.modal && this.modal.querySelector('#sf2BankList');
    if (!list) return;

    if (!banks || banks.length === 0) {
      list.innerHTML =
        '<p style="font-size:12px; color:var(--text-secondary,#666); margin:4px 0;">Aucun soundfont personnalisé.</p>';
      return;
    }

    list.innerHTML = banks
      .map(function (b) {
        return [
          '<div style="display:flex; align-items:center; gap:8px; padding:6px 0;',
          'border-bottom:1px solid var(--border-color,#e5e7eb);">',
          '<span style="flex:1; font-size:13px;">',
          _esc(b.label),
          ' <span style="font-size:11px; color:#999;">(' + _fmt(b.size) + ')</span>',
          '</span>',
          '<button data-sf2-delete="' + b.id + '" style="',
          'color:#ef4444; background:none; border:none; cursor:pointer; font-size:12px;">',
          'Supprimer',
          '</button>',
          '</div>'
        ].join('');
      })
      .join('');
  };

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  /**
   * Attach upload + delete listeners inside the modal.
   * Called by SettingsModal.attachContentEventListeners().
   */
  SettingsSF2.attachSF2Listeners = function () {
    const modal = this.modal;
    if (!modal) return;

    // Upload
    const fileInput = modal.querySelector('#sf2FileInput');
    if (fileInput) {
      fileInput.addEventListener('change', this._onSF2FileSelected.bind(this));
    }

    // Delete (event delegation on #sf2BankList)
    const list = modal.querySelector('#sf2BankList');
    if (list) {
      list.addEventListener('click', this._onSF2DeleteClick.bind(this));
    }
  };

  SettingsSF2._onSF2FileSelected = async function (evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = ''; // reset so same file can be re-uploaded
    if (!file) return;

    const progressEl = this.modal && this.modal.querySelector('#sf2UploadProgress');
    const show = (msg) => {
      if (progressEl) {
        progressEl.style.display = '';
        progressEl.textContent = msg;
      }
    };
    const hide = () => {
      if (progressEl) progressEl.style.display = 'none';
    };

    if (!file.name.toLowerCase().endsWith('.sf2')) {
      show('Erreur : seuls les fichiers .sf2 sont acceptés.');
      return;
    }

    show('Lecture du fichier…');

    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      show('Erreur de lecture du fichier.');
      return;
    }

    const MAX = 500 * 1024 * 1024;
    if (buf.byteLength > MAX) {
      show('Erreur : fichier trop volumineux (max 500 MB).');
      return;
    }

    show('Upload en cours… (' + _fmt(buf.byteLength) + ')');
    try {
      const res = await fetch('/api/sf2?filename=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf
      });
      const data = await res.json();
      if (!res.ok) {
        show('Erreur : ' + (data.error || res.status));
        return;
      }
      hide();
      await this.loadCustomBanks();
    } catch (e) {
      show('Erreur réseau : ' + e.message);
    }
  };

  SettingsSF2._onSF2DeleteClick = async function (evt) {
    const btn = evt.target.closest('[data-sf2-delete]');
    if (!btn) return;
    const sf2Id = btn.dataset.sf2Delete;
    if (!confirm('Supprimer ce soundfont ? Les sons seront perdus.')) return;

    try {
      const res = await fetch('/api/sf2/' + sf2Id, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        alert('Erreur : ' + (data.error || res.status));
        return;
      }
      // Switch away from the deleted bank if it is currently selected
      const savedBank = 'sf2:' + sf2Id;
      if (this.settings && this.settings.soundBank === savedBank) {
        const fallbackId =
          (window.MidiSynthesizerConstants && window.MidiSynthesizerConstants.DEFAULT_BANK_ID) ||
          'sf2:default';
        this.settings.soundBank = fallbackId;
        try {
          localStorage.setItem('gmboop_settings', JSON.stringify(this.settings));
        } catch (e) {}
        _eachInstance((inst) => inst.setSoundBank(fallbackId));
      }
      await this.loadCustomBanks();
    } catch (e) {
      alert('Erreur réseau : ' + e.message);
    }
  };

  /**
   * Lightweight boot-time check: hit GET /api/sf2 once, register custom
   * banks (so MidiSynthesizer can resolve them on first construction)
   * and surface the "default soundfont missing" toast if needed. Runs
   * outside of the SettingsModal lifecycle so the user gets feedback
   * even if they never open the settings panel.
   *
   * No DOM mutations here — _rebuildBankDropdown / _renderSF2List are
   * skipped because the modal may not be in the DOM yet.
   */
  SettingsSF2.bootSync = async function () {
    if (SettingsSF2._bootDone) return;
    SettingsSF2._bootDone = true;
    try {
      const res = await fetch('/api/sf2');
      if (!res.ok) return;
      const payload = await res.json();
      _registerAndReapply(payload.banks || []);

      if (payload.defaultPresent === false) {
        _notifyDefaultMissing();
        // UX fallback: when the built-in SF2 is missing AND the user
        // is on the default selection, transparently switch every
        // live synth to FluidR3_GM (WAF). This is what makes the
        // loop-modal virtual piano produce sound on a fresh install
        // before the user has had a chance to fix the soundfont. The
        // fallback is one-shot and only kicks in when the saved bank
        // is the (now-broken) default; users who explicitly picked
        // another bank are left alone.
        const defaultId =
          (window.MidiSynthesizerConstants && window.MidiSynthesizerConstants.DEFAULT_BANK_ID) ||
          'sf2:default';
        const savedNow = _savedBank();
        if (!savedNow || savedNow === defaultId) {
          _eachInstance((inst) => inst.setSoundBank('FluidR3_GM'));
        }
      }
    } catch (e) {
      // Non-fatal: SF2 backend may not be reachable yet on cold boot.
    }
  };

  // Auto-run on DOM ready so the user gets default-missing feedback
  // without having to open the Settings panel.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => SettingsSF2.bootSync(), { once: true });
    } else {
      // Defer to next tick so MidiSynthesizer / toast helpers finish loading.
      setTimeout(() => SettingsSF2.bootSync(), 0);
    }
  }

  window.SettingsSF2 = SettingsSF2;
})();
