/**
 * PlaylistEditorModal
 *
 * Modal for adding/removing files from a playlist.
 * Extends BaseModal with 2-column layout.
 *
 * Left column: Available MIDI files with search + "Routed only" filter
 * Right column: Current playlist items (numbered, removable)
 */

class PlaylistEditorModal extends BaseModal {
  constructor(apiClient, playlistId) {
    super({
      id: 'playlist-editor-modal',
      size: 'xl',
      title: 'playlist.editPlaylist',
      closeOnEscape: true,
      closeOnOverlay: true,
      customClass: 'playlist-editor'
    });
    this.apiClient = apiClient;
    this.playlistId = playlistId;
    this.availableFiles = [];
    this.playlistItems = [];
    this.routingStatusMap = new Map(); // fileId -> 'routed' | 'unrouted' | 'partial'
    this.searchQuery = '';
    this.showRoutedOnly = false;
    this.onCloseCallback = null;
  }

  set onClose(fn) {
    this.onCloseCallback = fn;
  }

  // Override BaseModal.t() to support fallback when key is not found
  t(key, fallback) {
    if (typeof i18n !== 'undefined' && i18n.t) {
      const result = i18n.t(key);
      if (result && result !== key) return result;
    }
    return fallback || key;
  }

  _isDark() {
    return document.body.classList.contains('dark-mode') || document.body.classList.contains('theme-dark');
  }

  _formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  renderBody() {
    const dark = this._isDark();
    const border = dark ? '#444' : '#dee2e6';
    const inputBg = dark ? '#3a3a3a' : '#fff';
    const inputColor = dark ? '#e0e0e0' : '#333';
    const textMuted = dark ? '#999' : '#6c757d';
    const btnBg = dark ? '#3a3a3a' : '#f3f4f6';
    const btnBorder = dark ? '#555' : '#dee2e6';

    return `
      <div class="playlist-editor-content" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;min-height:0;height:100%;overflow:hidden;">
        <div class="available-files" style="display:flex;flex-direction:column;min-height:0;overflow:hidden;">
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-shrink:0;">
            <input type="text" id="playlistEditorSearch"
              placeholder="${this.t('playlist.searchFiles', 'Search files...')}"
              style="flex:1;padding:8px 12px;border:1px solid ${border};border-radius:6px;font-size:0.9rem;background:${inputBg};color:${inputColor};box-sizing:border-box;">
            <button id="playlistEditorRoutedFilter"
              style="padding:6px 12px;border:1px solid ${btnBorder};border-radius:6px;font-size:0.8rem;cursor:pointer;background:${btnBg};color:${inputColor};white-space:nowrap;transition:all 0.2s;"
              title="${this.t('playlist.showRoutedOnly', 'Show only routed files')}">
              🔀 ${this.t('playlist.routedOnly', 'Routed only')}
            </button>
          </div>
          <div id="playlistEditorFileCount" style="font-size:0.75rem;color:${textMuted};margin-bottom:6px;flex-shrink:0;"></div>
          <div id="playlistEditorAvailableFiles" style="flex:1;overflow-y:auto;min-height:0;"></div>
        </div>
        <div class="playlist-files" style="display:flex;flex-direction:column;min-height:0;overflow:hidden;">
          <div style="font-size:0.8rem;color:${textMuted};margin-bottom:6px;flex-shrink:0;">
            ${this.t('playlist.playlistContent', 'Playlist Content')}
          </div>
          <div id="playlistEditorPlaylistItems" style="flex:1;overflow-y:auto;min-height:0;"></div>
          <div id="playlistEditorStats" style="padding:8px 0;font-size:0.85rem;color:${textMuted};border-top:1px solid ${border};margin-top:8px;flex-shrink:0;"></div>
        </div>
      </div>`;
  }

  renderFooter() {
    return `
      <button class="btn btn-secondary" id="playlistEditorCloseBtn">${this.t('common.close', 'Close')}</button>`;
  }

  async onOpen() {
    // Fix modal body height
    if (this.dialog) {
      const body = this.dialog.querySelector('.modal-body');
      if (body) {
        body.style.overflow = 'hidden';
        body.style.minHeight = '0';
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
      }
    }

    await Promise.all([
      this._loadAvailableFiles(),
      this._loadPlaylistItems()
    ]);

    // Load routing status for all files
    await this._loadRoutingStatuses();

    this._renderAvailableFiles();
    this._renderPlaylistItems();

    // Search handler
    const searchInput = this.$('#playlistEditorSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.toLowerCase();
        this._renderAvailableFiles();
      });
    }

    // Routed-only filter
    const filterBtn = this.$('#playlistEditorRoutedFilter');
    if (filterBtn) {
      filterBtn.addEventListener('click', () => {
        this.showRoutedOnly = !this.showRoutedOnly;
        filterBtn.style.background = this.showRoutedOnly ? '#667eea' : (this._isDark() ? '#3a3a3a' : '#f3f4f6');
        filterBtn.style.color = this.showRoutedOnly ? '#fff' : (this._isDark() ? '#e0e0e0' : '#333');
        filterBtn.style.borderColor = this.showRoutedOnly ? '#667eea' : (this._isDark() ? '#555' : '#dee2e6');
        this._renderAvailableFiles();
      });
    }

    // Close button
    const closeBtn = this.$('#playlistEditorCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
  }

  onClose() {
    if (this.onCloseCallback) {
      this.onCloseCallback();
    }
  }

  async _loadAvailableFiles() {
    try {
      this.availableFiles = await this.apiClient.listMidiFiles('/');
    } catch (error) {
      console.error('Failed to load files:', error);
      this.availableFiles = [];
    }
  }

  async _loadPlaylistItems() {
    try {
      const result = await this.apiClient.sendCommand('playlist_get', { playlistId: this.playlistId });
      this.playlistItems = result.items || [];
    } catch (error) {
      console.error('Failed to load playlist items:', error);
      this.playlistItems = [];
    }
  }

  async _loadRoutingStatuses() {
    // Flatten files
    const files = [];
    const flatten = (items) => {
      for (const item of items) {
        if (item.files) flatten(item.files);
        else if (item.id) files.push(item);
      }
    };
    if (Array.isArray(this.availableFiles)) flatten(this.availableFiles);

    // Batch check routing for all files
    const checks = files.map(f =>
      this.apiClient.sendCommand('get_file_routings', { fileId: f.id })
        .then(res => ({ id: f.id, count: (res.routings || []).length }))
        .catch(() => ({ id: f.id, count: 0 }))
    );

    const results = await Promise.all(checks);
    this.routingStatusMap.clear();
    for (const r of results) {
      this.routingStatusMap.set(r.id, r.count > 0 ? 'routed' : 'unrouted');
    }
  }

  _renderAvailableFiles() {
    const container = this.$('#playlistEditorAvailableFiles');
    const countEl = this.$('#playlistEditorFileCount');
    if (!container) return;

    const dark = this._isDark();
    const border = dark ? '#444' : '#dee2e6';
    const cardBg = dark ? '#2d2d2d' : '#fff';
    const textMuted = dark ? '#999' : '#6c757d';

    let files = [];
    const flatten = (items) => {
      for (const item of items) {
        if (item.files) flatten(item.files);
        else if (item.id) files.push(item);
      }
    };
    if (Array.isArray(this.availableFiles)) flatten(this.availableFiles);

    // Search filter
    if (this.searchQuery) {
      files = files.filter(f => (f.filename || '').toLowerCase().includes(this.searchQuery));
    }

    // Routed-only filter
    if (this.showRoutedOnly) {
      files = files.filter(f => this.routingStatusMap.get(f.id) === 'routed');
    }

    const addedIds = new Set(this.playlistItems.map(i => i.midi_id));

    // Count display
    if (countEl) {
      const totalCount = files.length;
      const routedCount = files.filter(f => this.routingStatusMap.get(f.id) === 'routed').length;
      countEl.textContent = this.showRoutedOnly
        ? `${totalCount} routed file(s)`
        : `${totalCount} file(s) (${routedCount} routed)`;
    }

    if (files.length === 0) {
      container.innerHTML = `<p style="color:${textMuted};text-align:center;padding:20px;">${this.showRoutedOnly ? 'No routed files found' : 'No files found'}</p>`;
      return;
    }

    container.innerHTML = files.map(f => {
      const isAdded = addedIds.has(f.id);
      const routingStatus = this.routingStatusMap.get(f.id) || 'unrouted';
      const isRouted = routingStatus === 'routed';
      const itemBorder = isAdded ? '#28a745' : border;
      const itemBg = isAdded ? (dark ? 'rgba(40,167,69,0.1)' : 'rgba(40,167,69,0.05)') : cardBg;
      const dot = isRouted
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#28a745;flex-shrink:0;" title="Routed"></span>'
        : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#dc3545;flex-shrink:0;" title="Not routed"></span>';

      return `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:3px;border-radius:6px;border:1px solid ${itemBorder};background:${itemBg};transition:all 0.15s;">
          ${dot}
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escape(f.filename || '')}</div>
            <div style="font-size:0.72rem;color:${textMuted};">${this._formatDuration(f.duration)}</div>
          </div>
          <button class="btn-add-file" data-file-id="${f.id}"
                  ${isAdded ? 'disabled' : ''}
                  style="background:none;border:none;cursor:${isAdded ? 'default' : 'pointer'};font-size:1rem;opacity:${isAdded ? '0.3' : '1'};"
                  title="${isAdded ? 'Already added' : 'Add to playlist'}">
            ${isAdded ? '✓' : '+'}
          </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-add-file:not([disabled])').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fileId = parseInt(btn.dataset.fileId);
        await this._addFile(fileId);
      });
    });
  }

  _renderPlaylistItems() {
    const container = this.$('#playlistEditorPlaylistItems');
    if (!container) return;

    const dark = this._isDark();
    const border = dark ? '#444' : '#dee2e6';
    const cardBg = dark ? '#2d2d2d' : '#fff';
    const textMuted = dark ? '#999' : '#6c757d';

    if (this.playlistItems.length === 0) {
      container.innerHTML = `<p style="color:${textMuted};text-align:center;padding:20px;">Empty playlist</p>`;
      this._updateStats();
      return;
    }

    container.innerHTML = this.playlistItems.map((item, index) => {
      const routingStatus = this.routingStatusMap.get(item.midi_id) || 'unrouted';
      const isRouted = routingStatus === 'routed';
      const dot = isRouted
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#28a745;flex-shrink:0;" title="Routed"></span>'
        : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#dc3545;flex-shrink:0;" title="Not routed"></span>';

      return `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:3px;border-radius:6px;border:1px solid ${border};background:${cardBg};transition:all 0.15s;">
          <span style="background:#667eea;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:600;flex-shrink:0;">${index + 1}</span>
          ${dot}
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escape(item.filename || '')}</div>
            <div style="font-size:0.72rem;color:${textMuted};">${this._formatDuration(item.duration)}</div>
          </div>
          <button class="btn-remove-file" data-item-id="${item.id}"
                  style="background:none;border:none;cursor:pointer;font-size:0.9rem;opacity:0.5;"
                  title="Remove">✕</button>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-remove-file').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = parseInt(btn.dataset.itemId);
        await this._removeFile(itemId);
      });
    });

    this._updateStats();
  }

  _updateStats() {
    const statsEl = this.$('#playlistEditorStats');
    if (!statsEl) return;
    const totalDuration = this.playlistItems.reduce((sum, item) => sum + (item.duration || 0), 0);
    const routedCount = this.playlistItems.filter(i => this.routingStatusMap.get(i.midi_id) === 'routed').length;
    statsEl.textContent = `${this.playlistItems.length} file(s) - ${this._formatDuration(totalDuration)} total - ${routedCount} routed`;
  }

  async _addFile(fileId) {
    try {
      await this.apiClient.sendCommand('playlist_add_file', {
        playlistId: this.playlistId,
        midiId: fileId
      });
      await this._loadPlaylistItems();
      this._renderPlaylistItems();
      this._renderAvailableFiles();
    } catch (error) {
      console.error('Failed to add file:', error);
    }
  }

  async _removeFile(itemId) {
    try {
      await this.apiClient.sendCommand('playlist_remove_file', { itemId });
      await this._loadPlaylistItems();
      this._renderPlaylistItems();
      this._renderAvailableFiles();
    } catch (error) {
      console.error('Failed to remove file:', error);
    }
  }
}

window.PlaylistEditorModal = PlaylistEditorModal;
