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

  _t(key) {
    if (typeof i18n !== 'undefined' && i18n.t) return i18n.t(key);
    return key;
  }

  _formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ==================== DIALOGS ====================

  /**
   * Show a styled prompt dialog (replaces native prompt())
   * @param {string} message - Label text
   * @param {string} [defaultValue] - Pre-filled input value
   * @param {string} [icon] - Emoji icon
   * @returns {Promise<string|null>} User input or null if cancelled
   */
  _showPrompt(message, defaultValue = '', icon = '🎶') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10010;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

      overlay.innerHTML = `
        <div style="background:var(--bg-secondary, #fff);border:1px solid var(--border-color, #dee2e6);border-radius:12px;overflow:hidden;width:380px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);color:var(--text-primary, #2c3e50);">
          <div style="background:var(--accent-gradient, linear-gradient(135deg, #667eea, #764ba2));padding:16px 20px;text-align:center;">
            <div style="font-size:1.5rem;margin-bottom:4px;">${icon}</div>
          </div>
          <div style="padding:20px 24px;">
            <div style="font-size:0.95rem;margin-bottom:14px;text-align:center;color:var(--text-primary, #2c3e50);">${this._escapeHtml(message)}</div>
            <input type="text" id="_plPromptInput" value="${this._escapeHtml(defaultValue)}"
              style="width:100%;padding:10px 12px;border:1px solid var(--border-color, #dee2e6);border-radius:6px;font-size:0.95rem;background:var(--bg-tertiary, #f8f9fa);color:var(--text-primary, #2c3e50);box-sizing:border-box;outline:none;">
            <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">
              <button id="_plPromptCancel" style="padding:8px 18px;border:1px solid var(--border-color, #dee2e6);border-radius:6px;background:var(--bg-secondary, #fff);color:var(--text-primary, #2c3e50);cursor:pointer;font-size:0.9rem;">${this._t('common.cancel')}</button>
              <button id="_plPromptOk" style="padding:8px 18px;border:none;border-radius:6px;background:var(--accent-primary, #667eea);color:#fff;cursor:pointer;font-size:0.9rem;">${this._t('common.save')}</button>
            </div>
          </div>
        </div>`;

      document.body.appendChild(overlay);

      const input = overlay.querySelector('#_plPromptInput');
      const okBtn = overlay.querySelector('#_plPromptOk');
      const cancelBtn = overlay.querySelector('#_plPromptCancel');

      const close = (val) => { overlay.remove(); resolve(val); };

      okBtn.addEventListener('click', () => close(input.value));
      cancelBtn.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });

      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
  }

  /**
   * Show a styled confirm dialog (replaces native confirm())
   * @param {string} message - Confirmation message
   * @param {string} [icon] - Emoji icon
   * @returns {Promise<boolean>}
   */
  _showConfirm(message, icon = '⚠️') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10010;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

      overlay.innerHTML = `
        <div style="background:var(--bg-secondary, #fff);border:1px solid var(--border-color, #dee2e6);border-radius:12px;overflow:hidden;width:360px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);color:var(--text-primary, #2c3e50);">
          <div style="background:linear-gradient(135deg, #dc3545, #c82333);padding:16px 20px;text-align:center;">
            <div style="font-size:1.5rem;">${icon}</div>
          </div>
          <div style="padding:20px 24px;">
            <div style="font-size:0.95rem;margin-bottom:18px;text-align:center;color:var(--text-primary, #2c3e50);">${this._escapeHtml(message)}</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button id="_plConfirmCancel" style="padding:8px 18px;border:1px solid var(--border-color, #dee2e6);border-radius:6px;background:var(--bg-secondary, #fff);color:var(--text-primary, #2c3e50);cursor:pointer;font-size:0.9rem;">${this._t('common.cancel')}</button>
              <button id="_plConfirmOk" style="padding:8px 18px;border:none;border-radius:6px;background:#dc3545;color:#fff;cursor:pointer;font-size:0.9rem;">${this._t('common.confirm')}</button>
            </div>
          </div>
        </div>`;

      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };

      overlay.querySelector('#_plConfirmOk').addEventListener('click', () => close(true));
      overlay.querySelector('#_plConfirmCancel').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
      });

      overlay.querySelector('#_plConfirmCancel').focus();
    });
  }

  // ==================== SHOW / CLOSE ====================

  async show() {
    this.createModal();
    await this.loadPlaylists();
    window.playlistPageInstance = this;
  }

  close() {
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
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
      <style>
        .plpage-overlay { position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center; }
        .plpage-container { width:900px;height:600px;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;background:var(--bg-secondary, #f8f9fa);color:var(--text-primary, #2c3e50);box-shadow:0 8px 32px rgba(0,0,0,0.3); }
        .plpage-header { background:var(--accent-gradient, linear-gradient(135deg, #667eea, #764ba2));padding:14px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0; }
        .plpage-header h2 { margin:0;font-size:1.4rem;display:flex;align-items:center;gap:10px;color:#fff; }
        /* .plpage-close — styled by universal close button rule in components.css */
        .plpage-layout { flex:1;display:grid;grid-template-columns:260px 1fr;overflow:hidden;min-height:0; }
        .plpage-sidebar { overflow-y:auto;padding:15px; }
        .plpage-sidebar.left { border-right:1px solid var(--border-color, #dee2e6);background:var(--bg-tertiary, #f0f0f0); }
        .plpage-main { overflow-y:auto;padding:15px;background:var(--bg-secondary, #fff); }
        .plpage-section-hdr { display:flex;justify-content:space-between;align-items:center;margin-bottom:12px; }
        .plpage-section-hdr h3 { margin:0;font-size:1.05rem;color:var(--text-primary, #2c3e50); }
        .plpage-btn { display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:var(--bg-secondary, #fff);border:1px solid var(--border-color, #dee2e6);border-radius:6px;cursor:pointer;font-size:0.85rem;color:var(--text-primary, #2c3e50);transition:all 0.2s; }
        .plpage-btn:hover { background:var(--bg-tertiary, #e9ecef); }
        .plpage-btn.primary { background:var(--accent-primary, #667eea);color:#fff;border-color:var(--accent-primary, #667eea); }
        .plpage-btn.primary:hover { opacity:0.9; }
        .plpage-footer { padding:10px 20px;border-top:1px solid var(--border-color, #dee2e6);font-size:0.85rem;color:var(--text-muted, #6c757d);flex-shrink:0; }
        .plpage-actions { display:flex;gap:8px; }

        @media (max-width: 768px) {
          .plpage-container { width:95%;height:90vh; }
          .plpage-layout { grid-template-columns:1fr; }
          .plpage-sidebar.left { border-right:none;border-bottom:1px solid var(--border-color, #dee2e6); }
        }
      </style>
      <div class="plpage-overlay">
        <div class="plpage-container">
          <div class="plpage-header">
            <h2>🎶 ${this._t('playlist.title')}</h2>
            <button class="plpage-close" id="playlistPageCloseBtn" title="Close">✕</button>
          </div>

          <div class="plpage-layout">
            <div class="plpage-sidebar left">
              <div class="plpage-section-hdr">
                <h3>${this._t('playlist.myPlaylists')}</h3>
                <button class="plpage-btn" id="playlistCreateBtn" title="${this._t('playlist.create')}">+</button>
              </div>
              <div id="playlistListContainer"></div>
            </div>

            <div class="plpage-main">
              <div class="plpage-section-hdr">
                <h3 id="playlistItemsTitle">${this._t('playlist.selectPlaylist')}</h3>
                <div id="playlistItemsActions" class="plpage-actions" style="display:none;">
                  <button class="plpage-btn" id="playlistRenameBtn" title="${this._t('playlist.rename')}">✏️</button>
                  <button class="plpage-btn" id="playlistLoopBtn" title="${this._t('playlist.loop')}">🔁</button>
                  <button class="plpage-btn" id="playlistShuffleBtn" title="${this._t('playlist.shuffle')}" style="opacity:0.4;">🔀</button>
                  <button class="plpage-btn" id="playlistGapBtn" title="${this._t('playlist.gapDelay')}">⏱️</button>
                  <button class="plpage-btn" id="playlistAddFilesBtn">+ ${this._t('playlist.addFiles')}</button>
                  <button class="plpage-btn primary" id="playlistPlayBtn" disabled>▶ ${this._t('playlist.play')}</button>
                </div>
              </div>
              <div id="playlistItemsContainer"></div>
            </div>
          </div>

          <div class="plpage-footer">
            <span id="playlistStatsInfo"></span>
          </div>
        </div>
      </div>`;

    document.body.appendChild(div);
    this.modal = div;

    this._bindEvents();
  }

  _bindEvents() {
    // Close button
    this.modal.querySelector('#playlistPageCloseBtn')?.addEventListener('click', () => this.close());

    // Close on overlay click
    this.modal.querySelector('.plpage-overlay')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('plpage-overlay')) this.close();
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

    // Rename playlist
    this.modal.querySelector('#playlistRenameBtn')?.addEventListener('click', () => this._renamePlaylist());

    // Toggle loop
    this.modal.querySelector('#playlistLoopBtn')?.addEventListener('click', () => this._toggleLoop());

    // Toggle shuffle
    this.modal.querySelector('#playlistShuffleBtn')?.addEventListener('click', () => this._toggleShuffle());

    // Set gap delay
    this.modal.querySelector('#playlistGapBtn')?.addEventListener('click', () => this._setGapDelay());
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
      this._updateSettingsButtons();
    } catch (error) {
      console.error('Failed to load playlist items:', error);
    }
  }

  // ==================== RENDERING ====================

  _renderPlaylistList() {
    const container = this.modal?.querySelector('#playlistListContainer');
    if (!container) return;

    if (this.playlists.length === 0) {
      container.innerHTML = `<p style="color:var(--text-muted, #6c757d);font-size:0.9rem;text-align:center;padding:20px;">
        ${this._t('playlist.noPlaylists')}
      </p>`;
      return;
    }

    container.innerHTML = this.playlists.map(pl => {
      const isActive = this.selectedPlaylist && this.selectedPlaylist.id === pl.id;
      const itemBg = isActive ? 'rgba(102,126,234,0.15)' : 'transparent';
      const itemBorder = isActive ? '2px solid var(--accent-primary, #667eea)' : '1px solid transparent';
      return `
        <div class="playlist-item${isActive ? ' active' : ''}" data-playlist-id="${pl.id}"
             style="padding:10px 12px;margin-bottom:6px;border-radius:8px;cursor:pointer;background:${itemBg};border:${itemBorder};transition:all 0.2s;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:500;color:var(--text-primary, #2c3e50);">${this._escapeHtml(pl.name)}</span>
            <button class="playlist-delete-btn" data-playlist-id="${pl.id}"
                    style="background:none;border:none;cursor:pointer;font-size:0.85rem;opacity:0.5;padding:2px 6px;"
                    title="${this._t('common.delete')}">🗑️</button>
          </div>
          ${pl.description ? `<div style="font-size:0.8rem;color:var(--text-muted, #6c757d);margin-top:2px;">${this._escapeHtml(pl.description)}</div>` : ''}
          <div style="font-size:0.75rem;color:var(--text-muted, #adb5bd);margin-top:4px;">
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
      container.innerHTML = `<p style="color:var(--text-muted, #6c757d);text-align:center;padding:40px;">${this._t('playlist.selectPlaylist')}</p>`;
      if (actions) actions.style.display = 'none';
      return;
    }

    if (title) title.textContent = this._escapeHtml(this.selectedPlaylist.name);
    if (actions) actions.style.display = 'flex';

    // Update play button state
    const playBtn = this.modal?.querySelector('#playlistPlayBtn');
    if (playBtn) playBtn.disabled = this.playlistItems.length === 0;

    // Update loop button visual
    const loopBtn = this.modal?.querySelector('#playlistLoopBtn');
    if (loopBtn) {
      const isLoop = this.selectedPlaylist.loop === 1;
      loopBtn.style.opacity = isLoop ? '1' : '0.4';
      loopBtn.title = isLoop
        ? (this._t('playlist.loopEnabled'))
        : (this._t('playlist.loop'));
    }

    if (this.playlistItems.length === 0) {
      container.innerHTML = `<p style="color:var(--text-muted, #6c757d);text-align:center;padding:40px;">
        ${this._t('playlist.emptyPlaylist')}
      </p>`;
      return;
    }

    // Show loading state then render with routing data
    container.innerHTML = `<p style="color:var(--text-muted, #6c757d);text-align:center;padding:20px;">Loading...</p>`;

    const routingChecks = this.playlistItems.map(item =>
      this.apiClient.sendCommand('get_file_routings', { fileId: item.midi_id })
        .then(res => ({ midi_id: item.midi_id, count: (res.routings || []).length }))
        .catch(() => ({ midi_id: item.midi_id, count: 0 }))
    );

    Promise.all(routingChecks).then(results => {
      const routingMap = new Map(results.map(r => [r.midi_id, r.count]));
      this._renderPlaylistItemsWithRouting(container, routingMap);
    });
  }

  _renderPlaylistItemsWithRouting(container, routingMap) {
    container.innerHTML = this.playlistItems.map((item, index) => {
      const routingCount = routingMap.get(item.midi_id);
      let routingDot = '';
      if (routingCount === undefined) {
        routingDot = '<span title="Checking..." style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#adb5bd;flex-shrink:0;"></span>';
      } else if (routingCount > 0) {
        routingDot = `<span title="Routed (${routingCount} ch)" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#28a745;flex-shrink:0;"></span>`;
      } else {
        routingDot = '<span title="Not routed" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc3545;flex-shrink:0;"></span>';
      }

      return `
        <div class="playlist-file-item" data-item-id="${item.id}" data-position="${item.position}"
             draggable="true"
             style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:4px;border-radius:8px;border:1px solid var(--border-color, #dee2e6);background:var(--bg-secondary, #fff);color:var(--text-primary, #2c3e50);cursor:grab;transition:all 0.2s;">
          <span class="file-drag-handle" style="cursor:grab;opacity:0.4;">⠿</span>
          <span style="background:var(--accent-primary, #667eea);color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:600;flex-shrink:0;">${index + 1}</span>
          ${routingDot}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary, #2c3e50);">${this._escapeHtml(item.filename)}</div>
            <div style="font-size:0.8rem;color:var(--text-muted, #6c757d);">${this._formatDuration(item.duration)}${item.tempo ? ` - ${Math.round(item.tempo)} BPM` : ''}</div>
          </div>
          <button class="btn-remove-file" data-item-id="${item.id}" style="background:none;border:none;cursor:pointer;opacity:0.5;padding:4px;color:var(--text-muted, #999);" title="Remove">✕</button>
        </div>`;
    }).join('');

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

  // Bridge: old _renderPlaylistItems still ends by calling this now
  // (routing check is async, so we need both sync and async paths)

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
    const name = await this._showPrompt(this._t('playlist.enterName'), '', '🎶');
    if (!name || !name.trim()) return;

    try {
      await this.apiClient.sendCommand('playlist_create', { name: name.trim() });
      await this.loadPlaylists();
    } catch (error) {
      console.error('Failed to create playlist:', error);
    }
  }

  async _renamePlaylist() {
    if (!this.selectedPlaylist) return;
    const newName = await this._showPrompt(
      this._t('playlist.enterNewName'),
      this.selectedPlaylist.name,
      '✏️'
    );
    if (!newName || !newName.trim() || newName.trim() === this.selectedPlaylist.name) return;

    try {
      await this.apiClient.sendCommand('playlist_create', {
        name: newName.trim(),
        description: this.selectedPlaylist.description
      });
      // Delete old and reload — no rename command exists, so recreate
      // Actually, let's just update the DB directly via a dedicated approach
      // For now, use delete + create + re-add items pattern
      const items = [...this.playlistItems];
      const oldId = this.selectedPlaylist.id;
      const loop = this.selectedPlaylist.loop;
      const res = await this.apiClient.sendCommand('playlist_create', { name: newName.trim() });
      const newId = res.playlistId;
      for (const item of items) {
        await this.apiClient.sendCommand('playlist_add_file', { playlistId: newId, midiId: item.midi_id });
      }
      if (loop) {
        await this.apiClient.sendCommand('playlist_set_loop', { playlistId: newId, loop: true });
      }
      // Copy shuffle and gap_seconds settings
      const settingsToClone = {};
      if (this.selectedPlaylist.shuffle) settingsToClone.shuffle = true;
      if (this.selectedPlaylist.gap_seconds) settingsToClone.gap_seconds = this.selectedPlaylist.gap_seconds;
      if (Object.keys(settingsToClone).length > 0) {
        await this.apiClient.sendCommand('playlist_update_settings', { playlistId: newId, ...settingsToClone });
      }
      await this.apiClient.sendCommand('playlist_delete', { playlistId: oldId });
      await this.loadPlaylists();
      await this._loadPlaylistItems(newId);
    } catch (error) {
      console.error('Failed to rename playlist:', error);
    }
  }

  async _toggleLoop() {
    if (!this.selectedPlaylist) return;
    const newLoop = this.selectedPlaylist.loop !== 1;
    try {
      await this.apiClient.sendCommand('playlist_set_loop', {
        playlistId: this.selectedPlaylist.id,
        loop: newLoop
      });
      this.selectedPlaylist.loop = newLoop ? 1 : 0;
      // Update button visual
      const loopBtn = this.modal?.querySelector('#playlistLoopBtn');
      if (loopBtn) {
        loopBtn.style.opacity = newLoop ? '1' : '0.4';
        loopBtn.title = newLoop
          ? (this._t('playlist.loopEnabled'))
          : (this._t('playlist.loop'));
      }
    } catch (error) {
      console.error('Failed to toggle loop:', error);
    }
  }

  async _toggleShuffle() {
    if (!this.selectedPlaylist) return;
    const newShuffle = this.selectedPlaylist.shuffle !== 1;
    try {
      await this.apiClient.sendCommand('playlist_update_settings', {
        playlistId: this.selectedPlaylist.id,
        shuffle: newShuffle
      });
      this.selectedPlaylist.shuffle = newShuffle ? 1 : 0;
      const shuffleBtn = this.modal?.querySelector('#playlistShuffleBtn');
      if (shuffleBtn) {
        shuffleBtn.style.opacity = newShuffle ? '1' : '0.4';
        shuffleBtn.title = newShuffle
          ? (this._t('playlist.shuffleEnabled'))
          : (this._t('playlist.shuffle'));
      }
    } catch (error) {
      console.error('Failed to toggle shuffle:', error);
    }
  }

  async _setGapDelay() {
    if (!this.selectedPlaylist) return;
    const currentGap = this.selectedPlaylist.gap_seconds || 0;
    const input = await this._showPrompt(
      this._t('playlist.gapDelayPrompt'),
      String(currentGap),
      '⏱️'
    );
    if (input === null) return;
    const seconds = Math.max(0, Math.min(60, parseInt(input) || 0));
    try {
      await this.apiClient.sendCommand('playlist_update_settings', {
        playlistId: this.selectedPlaylist.id,
        gap_seconds: seconds
      });
      this.selectedPlaylist.gap_seconds = seconds;
      this._updateGapButton();
    } catch (error) {
      console.error('Failed to set gap delay:', error);
    }
  }

  _updateGapButton() {
    const gapBtn = this.modal?.querySelector('#playlistGapBtn');
    if (!gapBtn) return;
    const gap = this.selectedPlaylist?.gap_seconds || 0;
    gapBtn.textContent = gap > 0 ? `⏱️ ${gap}s` : '⏱️';
    gapBtn.style.opacity = gap > 0 ? '1' : '0.7';
  }

  _updateSettingsButtons() {
    if (!this.selectedPlaylist) return;
    // Shuffle button
    const shuffleBtn = this.modal?.querySelector('#playlistShuffleBtn');
    if (shuffleBtn) {
      const shuffleOn = this.selectedPlaylist.shuffle === 1;
      shuffleBtn.style.opacity = shuffleOn ? '1' : '0.4';
      shuffleBtn.title = shuffleOn
        ? (this._t('playlist.shuffleEnabled'))
        : (this._t('playlist.shuffle'));
    }
    // Gap button
    this._updateGapButton();
    // Loop button
    const loopBtn = this.modal?.querySelector('#playlistLoopBtn');
    if (loopBtn) {
      loopBtn.style.opacity = this.selectedPlaylist.loop === 1 ? '1' : '0.4';
    }
  }

  async _deletePlaylist(playlistId) {
    const confirmed = await this._showConfirm(this._t('playlist.confirmDelete'), '🗑️');
    if (!confirmed) return;

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
      modal.onCloseHandler = () => this._loadPlaylistItems(this.selectedPlaylist.id);
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
