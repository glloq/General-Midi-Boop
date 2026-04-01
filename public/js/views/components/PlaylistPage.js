/**
 * PlaylistPage
 *
 * Full-page modal for playlist management.
 * Pattern: Same as LightingControlPage / InstrumentManagementPage.
 *
 * Layout (from playlist.css):
 * - Left sidebar: Playlist list + create/delete
 * - Center: Current playlist items with drag-and-drop reorder
 * - Right sidebar: Queue/playback status (collapsible)
 */

class PlaylistPage {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.modal = null;
    this.playlists = [];
    this.selectedPlaylist = null;
    this.playlistItems = [];
    this.draggedItem = null;
  }

  _escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  _isDark() {
    return document.body.classList.contains('dark-mode') || document.body.classList.contains('theme-dark');
  }

  _t(key, params) {
    if (typeof i18n !== 'undefined' && i18n.t) return i18n.t(key, params);
    return key;
  }

  _formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ==================== SHOW / CLOSE ====================

  async show() {
    this.createModal();
    await this.loadPlaylists();
    window.playlistPageInstance = this;
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    window.playlistPageInstance = null;
  }

  // ==================== MODAL CREATION ====================

  createModal() {
    if (this.modal) this.close();

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="playlist-modal-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:stretch;justify-content:center;">
        <div class="playlist-view-container" style="width:100%;max-width:1400px;margin:20px;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;">
          <!-- Header -->
          <div class="playlist-header">
            <div class="playlist-header-content">
              <h2 class="playlist-title"><span class="icon">🎶</span> ${this._t('playlist.title') || 'Playlists'}</h2>
              <div class="header-right">
                <button class="btn-control" id="playlistPageCloseBtn" title="Close">✕</button>
              </div>
            </div>
          </div>

          <!-- Main Layout -->
          <div class="playlist-layout" style="flex:1;display:grid;grid-template-columns:280px 1fr 300px;overflow:hidden;">
            <!-- Left Sidebar: Playlist List -->
            <div class="playlist-sidebar left" style="overflow-y:auto;border-right:1px solid #dee2e6;padding:15px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 style="margin:0;font-size:1.1rem;">${this._t('playlist.myPlaylists') || 'My Playlists'}</h3>
                <button class="btn-control" id="playlistCreateBtn" title="${this._t('playlist.create') || 'New playlist'}">+</button>
              </div>
              <div id="playlistListContainer"></div>
            </div>

            <!-- Center: Playlist Items -->
            <div class="playlist-main" style="overflow-y:auto;padding:15px;">
              <div id="playlistItemsHeader" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 id="playlistItemsTitle" style="margin:0;font-size:1.1rem;">${this._t('playlist.selectPlaylist') || 'Select a playlist'}</h3>
                <div id="playlistItemsActions" style="display:none;gap:8px;">
                  <button class="btn-control" id="playlistAddFilesBtn">+ ${this._t('playlist.addFiles') || 'Add files'}</button>
                  <button class="btn-control" id="playlistPlayBtn" style="background:#667eea;color:white;">▶ ${this._t('playlist.play') || 'Play'}</button>
                </div>
              </div>
              <div id="playlistItemsContainer"></div>
            </div>

            <!-- Right Sidebar: Queue Status -->
            <div class="playlist-sidebar right" style="overflow-y:auto;border-left:1px solid #dee2e6;padding:15px;">
              <h3 style="margin:0;font-size:1.1rem;margin-bottom:12px;">${this._t('playlist.queueStatus') || 'Queue'}</h3>
              <div id="playlistQueueContainer">
                <p style="color:#6c757d;font-size:0.9rem;">${this._t('playlist.noActiveQueue') || 'No active playlist'}</p>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="playlist-footer" style="padding:10px 20px;border-top:1px solid #dee2e6;display:flex;justify-content:space-between;font-size:0.85rem;color:#6c757d;">
            <span id="playlistStatsInfo"></span>
          </div>
        </div>
      </div>`;

    document.body.appendChild(div);
    this.modal = div;

    // Apply dark mode
    if (this._isDark()) {
      const container = div.querySelector('.playlist-view-container');
      if (container) container.style.background = '#1e1e1e';
      div.querySelectorAll('.playlist-sidebar').forEach(s => {
        s.style.borderColor = '#333';
      });
    } else {
      const container = div.querySelector('.playlist-view-container');
      if (container) container.style.background = '#f8f9fa';
    }

    this._bindEvents();
  }

  _bindEvents() {
    // Close button
    this.modal.querySelector('#playlistPageCloseBtn')?.addEventListener('click', () => this.close());

    // Close on overlay click
    this.modal.querySelector('.playlist-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('playlist-modal-overlay')) this.close();
    });

    // ESC to close
    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    // Create playlist
    this.modal.querySelector('#playlistCreateBtn')?.addEventListener('click', () => this._createPlaylist());

    // Add files
    this.modal.querySelector('#playlistAddFilesBtn')?.addEventListener('click', () => this._openAddFilesModal());

    // Play playlist
    this.modal.querySelector('#playlistPlayBtn')?.addEventListener('click', () => this._playPlaylist());
  }

  // ==================== DATA LOADING ====================

  async loadPlaylists() {
    try {
      const result = await this.apiClient.sendCommand('playlist_list');
      this.playlists = result.playlists || [];
      this._renderPlaylistList();
    } catch (error) {
      console.error('Failed to load playlists:', error);
    }
  }

  async _loadPlaylistItems(playlistId) {
    try {
      const result = await this.apiClient.sendCommand('playlist_get', { playlistId });
      this.selectedPlaylist = result.playlist;
      this.playlistItems = result.items || [];
      this._renderPlaylistItems();
      this._updateStats();
    } catch (error) {
      console.error('Failed to load playlist items:', error);
    }
  }

  // ==================== RENDERING ====================

  _renderPlaylistList() {
    const container = this.modal?.querySelector('#playlistListContainer');
    if (!container) return;

    if (this.playlists.length === 0) {
      container.innerHTML = `<p style="color:#6c757d;font-size:0.9rem;text-align:center;padding:20px;">
        ${this._t('playlist.noPlaylists') || 'No playlists yet. Click + to create one.'}
      </p>`;
      return;
    }

    container.innerHTML = this.playlists.map(pl => {
      const isActive = this.selectedPlaylist && this.selectedPlaylist.id === pl.id;
      const bg = isActive ? (this._isDark() ? 'rgba(102,126,234,0.2)' : '#e8ecfe') : 'transparent';
      const border = isActive ? '2px solid #667eea' : '1px solid transparent';
      return `
        <div class="playlist-item${isActive ? ' active' : ''}" data-playlist-id="${pl.id}"
             style="padding:10px 12px;margin-bottom:6px;border-radius:8px;cursor:pointer;background:${bg};border:${border};transition:all 0.2s;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:500;">${this._escapeHtml(pl.name)}</span>
            <button class="playlist-delete-btn" data-playlist-id="${pl.id}"
                    style="background:none;border:none;cursor:pointer;font-size:0.85rem;opacity:0.5;padding:2px 6px;"
                    title="${this._t('common.delete') || 'Delete'}">🗑️</button>
          </div>
          ${pl.description ? `<div style="font-size:0.8rem;color:#6c757d;margin-top:2px;">${this._escapeHtml(pl.description)}</div>` : ''}
          <div style="font-size:0.75rem;color:#adb5bd;margin-top:4px;">
            ${pl.loop ? '🔁 ' : ''}
          </div>
        </div>`;
    }).join('');

    // Bind click events
    container.querySelectorAll('.playlist-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.playlist-delete-btn')) return;
        const id = parseInt(el.dataset.playlistId);
        this._loadPlaylistItems(id);
      });
    });

    container.querySelectorAll('.playlist-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.playlistId);
        await this._deletePlaylist(id);
      });
    });
  }

  _renderPlaylistItems() {
    const container = this.modal?.querySelector('#playlistItemsContainer');
    const title = this.modal?.querySelector('#playlistItemsTitle');
    const actions = this.modal?.querySelector('#playlistItemsActions');
    if (!container) return;

    if (!this.selectedPlaylist) {
      container.innerHTML = `<p style="color:#6c757d;text-align:center;padding:40px;">${this._t('playlist.selectPlaylist') || 'Select a playlist'}</p>`;
      if (actions) actions.style.display = 'none';
      return;
    }

    if (title) title.textContent = this._escapeHtml(this.selectedPlaylist.name);
    if (actions) actions.style.display = 'flex';

    if (this.playlistItems.length === 0) {
      container.innerHTML = `<p style="color:#6c757d;text-align:center;padding:40px;">
        ${this._t('playlist.emptyPlaylist') || 'Empty playlist. Click "Add files" to add MIDI files.'}
      </p>`;
      return;
    }

    container.innerHTML = this.playlistItems.map((item, index) => `
      <div class="playlist-file-item" data-item-id="${item.id}" data-position="${item.position}"
           draggable="true"
           style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:4px;border-radius:8px;border:1px solid ${this._isDark() ? '#333' : '#dee2e6'};background:${this._isDark() ? '#2d2d2d' : 'white'};cursor:grab;transition:all 0.2s;">
        <span class="file-drag-handle" style="cursor:grab;opacity:0.4;">⠿</span>
        <span class="file-item-number" style="background:#667eea;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:600;flex-shrink:0;">${index + 1}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._escapeHtml(item.filename)}</div>
          <div style="font-size:0.8rem;color:#6c757d;">${this._formatDuration(item.duration)}${item.tempo ? ` - ${Math.round(item.tempo)} BPM` : ''}</div>
        </div>
        <div class="file-actions" style="display:flex;gap:4px;">
          <button class="btn-remove-file" data-item-id="${item.id}" style="background:none;border:none;cursor:pointer;opacity:0.5;padding:4px;" title="Remove">✕</button>
        </div>
      </div>
    `).join('');

    // Bind remove buttons
    container.querySelectorAll('.btn-remove-file').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = parseInt(btn.dataset.itemId);
        await this._removeItem(itemId);
      });
    });

    // Setup drag and drop
    this._setupDragAndDrop(container);
  }

  _updateStats() {
    const info = this.modal?.querySelector('#playlistStatsInfo');
    if (!info) return;

    if (this.selectedPlaylist && this.playlistItems.length > 0) {
      const totalDuration = this.playlistItems.reduce((sum, item) => sum + (item.duration || 0), 0);
      info.textContent = `${this.playlistItems.length} files - ${this._formatDuration(totalDuration)} total`;
    } else {
      info.textContent = '';
    }
  }

  _updateQueueStatus() {
    const container = this.modal?.querySelector('#playlistQueueContainer');
    if (!container) return;

    this.apiClient.sendCommand('playlist_status').then(status => {
      if (!status.active) {
        container.innerHTML = `<p style="color:#6c757d;font-size:0.9rem;">${this._t('playlist.noActiveQueue') || 'No active playlist'}</p>`;
        return;
      }

      container.innerHTML = `
        <div style="padding:10px;background:${this._isDark() ? 'rgba(102,126,234,0.15)' : '#e8ecfe'};border-radius:8px;margin-bottom:8px;">
          <div style="font-weight:600;margin-bottom:4px;">Now Playing</div>
          <div style="font-size:0.9rem;">${this._escapeHtml(status.currentFile?.filename || '?')}</div>
          <div style="font-size:0.8rem;color:#6c757d;margin-top:4px;">${status.currentIndex + 1} / ${status.totalItems} ${status.loop ? '🔁' : ''}</div>
        </div>
        ${status.items.slice(status.currentIndex + 1, status.currentIndex + 6).map((item, i) => `
          <div style="padding:6px 10px;font-size:0.85rem;color:#6c757d;">
            ${status.currentIndex + 2 + i}. ${this._escapeHtml(item.filename)}
          </div>
        `).join('')}
      `;
    }).catch(() => {
      container.innerHTML = `<p style="color:#6c757d;font-size:0.9rem;">Queue unavailable</p>`;
    });
  }

  // ==================== DRAG AND DROP ====================

  _setupDragAndDrop(container) {
    const items = container.querySelectorAll('.playlist-file-item');

    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        this.draggedItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.draggedItem = null;
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this.draggedItem && this.draggedItem !== item) {
          item.style.borderTop = '2px solid #667eea';
        }
      });

      item.addEventListener('dragleave', () => {
        item.style.borderTop = '';
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.style.borderTop = '';
        if (!this.draggedItem || this.draggedItem === item) return;

        const draggedId = parseInt(this.draggedItem.dataset.itemId);
        const targetPosition = parseInt(item.dataset.position);

        try {
          await this.apiClient.sendCommand('playlist_reorder', {
            playlistId: this.selectedPlaylist.id,
            itemId: draggedId,
            newPosition: targetPosition
          });
          await this._loadPlaylistItems(this.selectedPlaylist.id);
        } catch (error) {
          console.error('Failed to reorder:', error);
        }
      });
    });
  }

  // ==================== ACTIONS ====================

  async _createPlaylist() {
    const name = prompt(this._t('playlist.enterName') || 'Enter playlist name:');
    if (!name || !name.trim()) return;

    try {
      await this.apiClient.sendCommand('playlist_create', { name: name.trim() });
      await this.loadPlaylists();
    } catch (error) {
      console.error('Failed to create playlist:', error);
    }
  }

  async _deletePlaylist(playlistId) {
    if (!confirm(this._t('playlist.confirmDelete') || 'Delete this playlist?')) return;

    try {
      await this.apiClient.sendCommand('playlist_delete', { playlistId });
      if (this.selectedPlaylist && this.selectedPlaylist.id === playlistId) {
        this.selectedPlaylist = null;
        this.playlistItems = [];
        this._renderPlaylistItems();
      }
      await this.loadPlaylists();
    } catch (error) {
      console.error('Failed to delete playlist:', error);
    }
  }

  async _removeItem(itemId) {
    try {
      await this.apiClient.sendCommand('playlist_remove_file', { itemId });
      await this._loadPlaylistItems(this.selectedPlaylist.id);
    } catch (error) {
      console.error('Failed to remove item:', error);
    }
  }

  _openAddFilesModal() {
    if (!this.selectedPlaylist) return;
    // Use PlaylistEditorModal if available
    if (window.PlaylistEditorModal) {
      const modal = new window.PlaylistEditorModal(this.apiClient, this.selectedPlaylist.id);
      modal.open();
      modal.onClose = () => this._loadPlaylistItems(this.selectedPlaylist.id);
    } else {
      console.warn('PlaylistEditorModal not loaded');
    }
  }

  async _playPlaylist() {
    if (!this.selectedPlaylist) return;

    try {
      await this.apiClient.sendCommand('playlist_start', {
        playlistId: this.selectedPlaylist.id
      });
      this.close();
    } catch (error) {
      console.error('Failed to start playlist:', error);
      alert(error.message || 'Failed to start playlist');
    }
  }

  /**
   * Add a file to a specific playlist (called from external context).
   * @param {number} playlistId
   * @param {number} midiId
   */
  async addFileToPlaylist(playlistId, midiId) {
    try {
      await this.apiClient.sendCommand('playlist_add_file', { playlistId, midiId });
      // Refresh if this playlist is currently displayed
      if (this.selectedPlaylist && this.selectedPlaylist.id === playlistId) {
        await this._loadPlaylistItems(playlistId);
      }
    } catch (error) {
      console.error('Failed to add file to playlist:', error);
    }
  }
}

// Export for global access
window.PlaylistPage = PlaylistPage;
