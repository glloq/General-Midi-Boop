// src/storage/MidiDatabase.js
import { buildDynamicUpdate } from './dbHelpers.js';

// All columns except 'data' (large base64 BLOB) for listing queries
const LIST_COLUMNS = `id, filename, size, tracks, duration, tempo, ppq, uploaded_at, folder,
  is_original, parent_file_id,
  instrument_types, channel_count, note_range_min, note_range_max,
  has_drums, has_melody, has_bass`;

class MidiDatabase {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  insertFile(file) {
    try {
      // Store as binary BLOB if data_blob column exists, otherwise fall back to base64 TEXT
      const hasDataBlob = this.db.prepare("SELECT name FROM pragma_table_info('midi_files') WHERE name = 'data_blob'").get();

      let stmt;
      let dataValue;
      if (hasDataBlob) {
        stmt = this.db.prepare(`
          INSERT INTO midi_files (
            filename, data_blob, size, tracks, duration, tempo, ppq, uploaded_at, folder,
            is_original, parent_file_id,
            instrument_types, channel_count, note_range_min, note_range_max,
            has_drums, has_melody, has_bass
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // Convert base64 string to Buffer for BLOB storage
        dataValue = (typeof file.data === 'string') ? Buffer.from(file.data, 'base64') : file.data;
      } else {
        stmt = this.db.prepare(`
          INSERT INTO midi_files (
            filename, data, size, tracks, duration, tempo, ppq, uploaded_at, folder,
            is_original, parent_file_id,
            instrument_types, channel_count, note_range_min, note_range_max,
            has_drums, has_melody, has_bass
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        dataValue = file.data;
      }

      const result = stmt.run(
        file.filename,
        dataValue,
        file.size,
        file.tracks,
        file.duration || 0,
        file.tempo || 120,
        file.ppq || 480,
        file.uploaded_at,
        file.folder || '/',
        file.is_original !== undefined ? (file.is_original ? 1 : 0) : 1,
        file.parent_file_id || null,
        file.instrument_types || '[]',
        file.channel_count || 0,
        file.note_range_min ?? null,
        file.note_range_max ?? null,
        file.has_drums ? 1 : 0,
        file.has_melody ? 1 : 0,
        file.has_bass ? 1 : 0
      );

      return result.lastInsertRowid;
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE constraint failed: midi_files.filename')) {
        throw new Error(`A file with the name "${file.filename}" already exists. Please rename the file before adding it.`);
      }
      this.logger.error(`Failed to insert file: ${error.message}`);
      throw error;
    }
  }

  getFile(fileId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM midi_files WHERE id = ?');
      const row = stmt.get(fileId);
      if (row) {
        // Normalize: prefer data_blob (Buffer), fall back to data (base64 string)
        if (row.data_blob) {
          row.data = row.data_blob;
          delete row.data_blob;
        }
      }
      return row;
    } catch (error) {
      this.logger.error(`Failed to get file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get file metadata without the large BLOB data field.
   * Use this when you only need file info, not the actual MIDI data.
   */
  getFileInfo(fileId) {
    try {
      const stmt = this.db.prepare(`SELECT ${LIST_COLUMNS} FROM midi_files WHERE id = ?`);
      return stmt.get(fileId);
    } catch (error) {
      this.logger.error(`Failed to get file info: ${error.message}`);
      throw error;
    }
  }

  getFiles(folder = '/') {
    try {
      const stmt = this.db.prepare(`SELECT ${LIST_COLUMNS} FROM midi_files WHERE folder = ? ORDER BY uploaded_at DESC`);
      return stmt.all(folder);
    } catch (error) {
      this.logger.error(`Failed to get files: ${error.message}`);
      throw error;
    }
  }

  getAllFiles({ includeData = false } = {}) {
    try {
      const columns = includeData ? '*' : LIST_COLUMNS;
      const stmt = this.db.prepare(`SELECT ${columns} FROM midi_files ORDER BY uploaded_at DESC`);
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get all files: ${error.message}`);
      throw error;
    }
  }

  updateFile(fileId, updates) {
    try {
      const result = buildDynamicUpdate('midi_files', updates, [
        'filename', 'data', 'data_blob', 'size', 'tracks', 'duration',
        'tempo', 'ppq', 'folder', 'is_original', 'parent_file_id',
        'instrument_types', 'channel_count',
        'note_range_min', 'note_range_max', 'has_drums', 'has_melody', 'has_bass'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, fileId);
    } catch (error) {
      this.logger.error(`Failed to update file: ${error.message}`);
      throw error;
    }
  }

  deleteFile(fileId) {
    try {
      const numericId = Number(fileId);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        throw new Error(`Invalid file ID: ${fileId}`);
      }
      const stmt = this.db.prepare('DELETE FROM midi_files WHERE id = ?');
      const result = stmt.run(numericId);
      if (result.changes === 0) {
        throw new Error(`File not found in database: ${numericId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to delete file: ${error.message}`);
      throw error;
    }
  }

  getFolders() {
    try {
      const stmt = this.db.prepare('SELECT DISTINCT folder FROM midi_files ORDER BY folder');
      return stmt.all().map(row => row.folder);
    } catch (error) {
      this.logger.error(`Failed to get folders: ${error.message}`);
      throw error;
    }
  }

  searchFiles(query) {
    try {
      const stmt = this.db.prepare(`
        SELECT ${LIST_COLUMNS} FROM midi_files
        WHERE filename LIKE ?
        ORDER BY uploaded_at DESC
      `);
      return stmt.all(`%${query}%`);
    } catch (error) {
      this.logger.error(`Failed to search files: ${error.message}`);
      throw error;
    }
  }

  getFilesByDateRange(startDate, endDate) {
    try {
      const stmt = this.db.prepare(`
        SELECT ${LIST_COLUMNS} FROM midi_files
        WHERE uploaded_at >= ? AND uploaded_at <= ?
        ORDER BY uploaded_at DESC
      `);
      return stmt.all(startDate, endDate);
    } catch (error) {
      this.logger.error(`Failed to get files by date range: ${error.message}`);
      throw error;
    }
  }

  getRecentFiles(limit = 10) {
    try {
      const stmt = this.db.prepare(`
        SELECT ${LIST_COLUMNS} FROM midi_files
        ORDER BY uploaded_at DESC
        LIMIT ?
      `);
      return stmt.all(limit);
    } catch (error) {
      this.logger.error(`Failed to get recent files: ${error.message}`);
      throw error;
    }
  }

  getStorageStats() {
    try {
      const stmt = this.db.prepare(`
        SELECT
          COUNT(*) as totalFiles,
          SUM(size) as totalSize,
          AVG(duration) as avgDuration,
          MAX(duration) as maxDuration
        FROM midi_files
      `);
      return stmt.get();
    } catch (error) {
      this.logger.error(`Failed to get storage stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Filter MIDI files with advanced criteria
   * @param {Object} filters - Filter criteria
   * @returns {Array} - Filtered files
   */
  filterFiles(filters = {}) {
    try {
      const listCols = LIST_COLUMNS.replace(/(\w+)/g, 'mf.$1');
      let query = `SELECT ${listCols} FROM midi_files mf`;
      const joins = [];
      const wheres = [];
      const params = [];

      // JOIN with routings if needed (only for legacy hasRouting/minCompatibilityScore, not routingStatus which uses CTE)
      let hasMirJoin = false;
      if (((filters.hasRouting !== undefined) && !filters.routingStatus) || filters.minCompatibilityScore !== undefined) {
        joins.push('LEFT JOIN midi_instrument_routings mir ON mf.id = mir.midi_file_id');
        hasMirJoin = true;
      }

      // Filename filter
      if (filters.filename) {
        wheres.push('mf.filename LIKE ?');
        params.push(`%${filters.filename}%`);
      }

      // Folder filter
      if (filters.folder) {
        if (filters.includeSubfolders) {
          wheres.push('mf.folder LIKE ?');
          params.push(`${filters.folder}%`);
        } else {
          wheres.push('mf.folder = ?');
          params.push(filters.folder);
        }
      }

      // Duration filter
      if (filters.durationMin !== undefined) {
        wheres.push('mf.duration >= ?');
        params.push(filters.durationMin);
      }
      if (filters.durationMax !== undefined) {
        wheres.push('mf.duration <= ?');
        params.push(filters.durationMax);
      }

      // Tempo filter
      if (filters.tempoMin !== undefined) {
        wheres.push('mf.tempo >= ?');
        params.push(filters.tempoMin);
      }
      if (filters.tempoMax !== undefined) {
        wheres.push('mf.tempo <= ?');
        params.push(filters.tempoMax);
      }

      // Track count filter
      if (filters.tracksMin !== undefined) {
        wheres.push('mf.tracks >= ?');
        params.push(filters.tracksMin);
      }
      if (filters.tracksMax !== undefined) {
        wheres.push('mf.tracks <= ?');
        params.push(filters.tracksMax);
      }

      // Channel count filter
      if (filters.channelCountMin !== undefined) {
        wheres.push('mf.channel_count >= ?');
        params.push(filters.channelCountMin);
      }
      if (filters.channelCountMax !== undefined) {
        wheres.push('mf.channel_count <= ?');
        params.push(filters.channelCountMax);
      }

      // Upload date filter
      if (filters.uploadedAfter) {
        wheres.push('mf.uploaded_at >= ?');
        params.push(filters.uploadedAfter);
      }
      if (filters.uploadedBefore) {
        wheres.push('mf.uploaded_at <= ?');
        params.push(filters.uploadedBefore);
      }

      // Is original filter (COALESCE handles NULL for pre-migration files, treating them as originals)
      if (filters.isOriginal !== undefined) {
        wheres.push('COALESCE(mf.is_original, 1) = ?');
        params.push(filters.isOriginal ? 1 : 0);
      }

      // Boolean quick filters (use COALESCE to handle NULL as 0 for pre-migration files)
      if (filters.hasDrums !== undefined) {
        wheres.push('COALESCE(mf.has_drums, 0) = ?');
        params.push(filters.hasDrums ? 1 : 0);
      }
      if (filters.hasMelody !== undefined) {
        wheres.push('COALESCE(mf.has_melody, 0) = ?');
        params.push(filters.hasMelody ? 1 : 0);
      }
      if (filters.hasBass !== undefined) {
        wheres.push('COALESCE(mf.has_bass, 0) = ?');
        params.push(filters.hasBass ? 1 : 0);
      }

      // Instrument types filter (legacy broad categories)
      if (filters.instrumentTypes && filters.instrumentTypes.length > 0) {
        const mode = filters.instrumentMode || 'ANY';

        if (mode === 'ANY') {
          const orClauses = filters.instrumentTypes.map(() => 'mf.instrument_types LIKE ?');
          wheres.push(`(${orClauses.join(' OR ')})`);
          filters.instrumentTypes.forEach(type => {
            params.push(`%"${type}"%`);
          });
        } else if (mode === 'ALL') {
          filters.instrumentTypes.forEach(type => {
            wheres.push('mf.instrument_types LIKE ?');
            params.push(`%"${type}"%`);
          });
        } else if (mode === 'EXACT') {
          // File must contain ALL specified types AND no other types
          filters.instrumentTypes.forEach(type => {
            wheres.push('mf.instrument_types LIKE ?');
            params.push(`%"${type}"%`);
          });
          // Verify the file has exactly the right number of instrument types
          // by checking the JSON array length matches the filter count
          wheres.push(`json_array_length(mf.instrument_types) = ?`);
          params.push(filters.instrumentTypes.length);
        }
      }

      // GM instrument name filter (specific GM instruments via midi_file_channels)
      if (filters.gmInstruments && filters.gmInstruments.length > 0) {
        const gmMode = filters.gmMode || 'ANY';
        if (gmMode === 'ANY') {
          const placeholders = filters.gmInstruments.map(() => '?').join(', ');
          wheres.push(`mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_instrument_name IN (${placeholders}))`);
          filters.gmInstruments.forEach(name => params.push(name));
        } else if (gmMode === 'ALL') {
          filters.gmInstruments.forEach(name => {
            wheres.push('mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_instrument_name = ?)');
            params.push(name);
          });
        }
      }

      // GM category filter (instrument families via midi_file_channels)
      if (filters.gmCategories && filters.gmCategories.length > 0) {
        const gmMode = filters.gmMode || 'ANY';
        if (gmMode === 'ANY') {
          const placeholders = filters.gmCategories.map(() => '?').join(', ');
          wheres.push(`mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_category IN (${placeholders}))`);
          filters.gmCategories.forEach(cat => params.push(cat));
        } else if (gmMode === 'ALL') {
          filters.gmCategories.forEach(cat => {
            wheres.push('mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_category = ?)');
            params.push(cat);
          });
        }
      }

      // GM program number filter
      if (filters.gmPrograms && filters.gmPrograms.length > 0) {
        const gmMode = filters.gmMode || 'ANY';
        if (gmMode === 'ALL') {
          filters.gmPrograms.forEach(prog => {
            wheres.push('mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE primary_program = ?)');
            params.push(prog);
          });
        } else {
          const placeholders = filters.gmPrograms.map(() => '?').join(', ');
          wheres.push(`mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE primary_program IN (${placeholders}))`);
          filters.gmPrograms.forEach(prog => params.push(prog));
        }
      }

      // Routing status filter (detailed: unrouted, partial, playable, routed_incomplete, auto_assigned)
      // Supports single status (routingStatus) or multiple statuses (routingStatuses array)
      const statusList = filters.routingStatuses || (filters.routingStatus ? [filters.routingStatus] : []);
      if (statusList.length > 0) {
        const validStatuses = ['unrouted', 'partial', 'playable', 'routed_incomplete', 'auto_assigned'];
        for (const s of statusList) {
          if (!validStatuses.includes(s)) {
            throw new Error(`Invalid routingStatus: ${s}. Must be one of: ${validStatuses.join(', ')}`);
          }
        }

        // Build device filter clause for routing subqueries (only count routings to connected devices)
        // Device IDs come from server's deviceManager (trusted source), safe to embed as literals
        let deviceFilterSql = '';
        if (filters.connectedDeviceIds && filters.connectedDeviceIds.length > 0) {
          const safeIds = filters.connectedDeviceIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
          deviceFilterSql = ` AND device_id IN (${safeIds})`;
        }

        // Subquery for counting enabled routings for this file
        const routedCountSql = `(SELECT COUNT(*) FROM midi_instrument_routings WHERE midi_file_id = mf.id AND enabled = 1${deviceFilterSql})`;
        // Subquery for min compatibility score
        const minScoreSql = `(SELECT MIN(compatibility_score) FROM midi_instrument_routings WHERE midi_file_id = mf.id AND enabled = 1${deviceFilterSql})`;
        // Effective channel count: use channel_count if set, else 1 (NOT mf.tracks which is SMF track count, not MIDI channels)
        const channelCountSql = 'COALESCE(NULLIF(mf.channel_count, 0), 1)';
        // Subquery for auto-assigned check
        const hasAutoAssignedSql = `(SELECT COUNT(*) FROM midi_instrument_routings WHERE midi_file_id = mf.id AND enabled = 1 AND auto_assigned = 1${deviceFilterSql})`;

        const orConditions = [];
        for (const status of statusList) {
          switch (status) {
            case 'unrouted':
              orConditions.push(`${routedCountSql} = 0`);
              break;
            case 'partial':
              orConditions.push(`(${routedCountSql} > 0 AND ${routedCountSql} < ${channelCountSql})`);
              break;
            case 'routed_incomplete':
              // Only routed_incomplete if there ARE actual scores and min < 100
              orConditions.push(`(${routedCountSql} >= ${channelCountSql} AND ${channelCountSql} > 0 AND ${minScoreSql} IS NOT NULL AND ${minScoreSql} < 100)`);
              break;
            case 'playable':
              // Playable if all scores are 100 OR all scores are NULL (manual routings)
              orConditions.push(`(${routedCountSql} >= ${channelCountSql} AND ${channelCountSql} > 0 AND (${minScoreSql} IS NULL OR ${minScoreSql} = 100))`);
              break;
            case 'auto_assigned':
              orConditions.push(`(${hasAutoAssignedSql} > 0)`);
              break;
          }
        }
        if (orConditions.length > 0) {
          wheres.push(`(${orConditions.join(' OR ')})`);
        }
      }

      // Playable on specific instruments filter
      if (filters.playableOnInstruments && filters.playableOnInstruments.length > 0) {
        const mode = filters.playableMode || 'routed';
        const placeholders = filters.playableOnInstruments.map(() => '?').join(', ');

        if (mode === 'compatible') {
          wheres.push(`mf.id IN (
            SELECT DISTINCT mfc2.midi_file_id
            FROM midi_file_channels mfc2
            INNER JOIN instruments_latency il ON il.id IN (${placeholders})
            WHERE (
              -- TYPE COMPATIBILITY (gm_category -> instrument_type via normalization)
              (
                -- Direct match: normalize gm_category to instrument_type format
                (il.instrument_type IS NOT NULL AND il.instrument_type != 'unknown'
                 AND il.instrument_type != ''
                 AND LOWER(REPLACE(COALESCE(mfc2.gm_category, ''), ' ', '_')) = il.instrument_type)
                OR
                -- Drums: channel 9 or Percussive category
                (il.instrument_type = 'drums'
                 AND (mfc2.channel = 9 OR mfc2.gm_category = 'Percussive'))
                OR
                -- Unknown instrument type: match any channel (rely on note range)
                (il.instrument_type IS NULL OR il.instrument_type = 'unknown' OR il.instrument_type = '')
              )
              AND
              -- NOTE RANGE COMPATIBILITY
              (
                CASE COALESCE(il.note_selection_mode, 'range')
                  WHEN 'discrete' THEN
                    -- Discrete mode: at least one selected note in channel range
                    il.selected_notes IS NULL
                    OR EXISTS (
                      SELECT 1 FROM json_each(il.selected_notes) je
                      WHERE (mfc2.note_range_min IS NULL OR je.value >= mfc2.note_range_min)
                        AND (mfc2.note_range_max IS NULL OR je.value <= mfc2.note_range_max)
                    )
                  ELSE
                    -- Range mode: overlap check, NULL = no restriction
                    (il.note_range_min IS NULL OR mfc2.note_range_max IS NULL
                     OR mfc2.note_range_max >= il.note_range_min)
                    AND
                    (il.note_range_max IS NULL OR mfc2.note_range_min IS NULL
                     OR mfc2.note_range_min <= il.note_range_max)
                END
              )
            )
          )`);
        } else {
          wheres.push(`mf.id IN (
            SELECT DISTINCT mir3.midi_file_id
            FROM midi_instrument_routings mir3
            INNER JOIN instruments_latency il ON mir3.device_id = il.device_id
            WHERE il.id IN (${placeholders})
              AND mir3.enabled = 1
          )`);
        }
        filters.playableOnInstruments.forEach(id => params.push(id));
      }

      // Simple routing existence filter (legacy) — skip if routingStatus/routingStatuses is active
      if (!filters.routingStatus && (!filters.routingStatuses || filters.routingStatuses.length === 0)) {
        if (filters.hasRouting === true) {
          wheres.push('mir.id IS NOT NULL');
        } else if (filters.hasRouting === false) {
          wheres.push('mir.id IS NULL');
        }
      }

      // Assemble query
      if (joins.length > 0) {
        query += ' ' + joins.join(' ');
      }

      if (wheres.length > 0) {
        query += ' WHERE ' + wheres.join(' AND ');
      }

      // GROUP BY if we joined with routings (to avoid duplicates)
      if (joins.length > 0) {
        query += ' GROUP BY mf.id';
      }

      // Compatibility score filter (needs to be in HAVING after GROUP BY, requires mir JOIN)
      // Note: Files with no routings will have AVG(mir.compatibility_score) = NULL,
      // which naturally fails the >= comparison. This is intentional: a minimum
      // compatibility score filter only makes sense for files that have routings.
      if (filters.minCompatibilityScore !== undefined && hasMirJoin) {
        query += ' HAVING AVG(mir.compatibility_score) >= ?';
        params.push(filters.minCompatibilityScore);
      }

      // ORDER BY
      const sortBy = filters.sortBy || 'uploaded_at';
      const sortOrder = filters.sortOrder || 'DESC';

      // Validate sortBy and sortOrder to prevent SQL injection
      const validSortFields = ['filename', 'uploaded_at', 'duration', 'tempo', 'tracks', 'size', 'channel_count'];
      const validSortOrders = ['ASC', 'DESC'];
      const safeSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
      if (validSortFields.includes(sortBy)) {
        query += ` ORDER BY mf.${sortBy} ${safeSortOrder}`;
      } else {
        query += ' ORDER BY mf.uploaded_at DESC';
      }

      // LIMIT and OFFSET for pagination
      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);

        if (filters.offset) {
          query += ' OFFSET ?';
          params.push(filters.offset);
        }
      }

      this.logger.debug(`Filter query: ${query}`);
      this.logger.debug(`Filter params: ${JSON.stringify(params)}`);

      // Execute query
      const stmt = this.db.prepare(query);
      const results = stmt.all(...params);

      return results;
    } catch (error) {
      this.logger.error(`Failed to filter files: ${error.message}`);
      throw error;
    }
  }

  // ==================== MIDI FILE CHANNELS ====================

  /**
   * Insert channel analysis data for a MIDI file
   * @param {number} fileId - MIDI file ID
   * @param {Array} channels - Channel analysis data
   */
  insertFileChannels(fileId, channels) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO midi_file_channels (
          midi_file_id, channel, primary_program, gm_instrument_name, gm_category,
          estimated_type, type_confidence, note_range_min, note_range_max,
          total_notes, polyphony_max, polyphony_avg, density, track_names
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = this.db.transaction((fileId, channels) => {
        for (const ch of channels) {
          stmt.run(
            fileId,
            ch.channel,
            ch.primaryProgram !== null && ch.primaryProgram !== undefined ? ch.primaryProgram : null,
            ch.gmInstrumentName || null,
            ch.gmCategory || null,
            ch.estimatedType || null,
            ch.typeConfidence || 0,
            ch.noteRangeMin !== undefined ? ch.noteRangeMin : null,
            ch.noteRangeMax !== undefined ? ch.noteRangeMax : null,
            ch.totalNotes || 0,
            ch.polyphonyMax || 0,
            ch.polyphonyAvg || 0,
            ch.density || 0,
            ch.trackNames ? JSON.stringify(ch.trackNames) : '[]'
          );
        }
      });

      insertMany(fileId, channels);
      this.logger.info(`Inserted ${channels.length} channel analyses for file ${fileId}`);
    } catch (error) {
      this.logger.error(`Failed to insert file channels: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get channel analyses for a MIDI file
   * @param {number} fileId - MIDI file ID
   * @returns {Array} Channel data
   */
  getFileChannels(fileId) {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM midi_file_channels WHERE midi_file_id = ? ORDER BY channel'
      );
      return stmt.all(fileId);
    } catch (error) {
      this.logger.error(`Failed to get file channels: ${error.message}`);
      throw error;
    }
  }

  /**
   * Count files that have no channel analysis data or missing metadata
   * @returns {number} Number of files missing channel data or instrument metadata
   */
  countFilesWithoutChannels() {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM midi_files mf
        WHERE mf.id NOT IN (SELECT DISTINCT midi_file_id FROM midi_file_channels)
          OR mf.instrument_types IS NULL
          OR mf.instrument_types = '[]'
          OR mf.has_drums IS NULL
      `);
      return stmt.get().count;
    } catch (error) {
      this.logger.error(`Failed to count files without channels: ${error.message}`);
      return 0;
    }
  }

  /**
   * Delete channel analyses for a MIDI file
   * @param {number} fileId - MIDI file ID
   */
  deleteFileChannels(fileId) {
    try {
      const stmt = this.db.prepare('DELETE FROM midi_file_channels WHERE midi_file_id = ?');
      stmt.run(fileId);
    } catch (error) {
      this.logger.error(`Failed to delete file channels: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all distinct GM instrument names present in the collection
   * @returns {Array<{name: string, count: number}>}
   */
  getDistinctInstruments() {
    try {
      const stmt = this.db.prepare(`
        SELECT gm_instrument_name as name, COUNT(DISTINCT midi_file_id) as file_count
        FROM midi_file_channels
        WHERE gm_instrument_name IS NOT NULL
        GROUP BY gm_instrument_name
        ORDER BY file_count DESC, gm_instrument_name ASC
      `);
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get distinct instruments: ${error.message}`);
      throw error;
    }
  }

  /**
   * Count files that need metadata re-analysis
   * (files with NULL or empty instrument_types, or no midi_file_channels rows)
   * @returns {number}
   */
  countFilesNeedingReanalysis() {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM midi_files
        WHERE instrument_types IS NULL
          OR instrument_types = '[]'
          OR has_drums IS NULL
          OR id NOT IN (SELECT DISTINCT midi_file_id FROM midi_file_channels)
      `);
      return stmt.get().count;
    } catch (error) {
      this.logger.error(`Failed to count files needing reanalysis: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get all distinct GM categories present in the collection
   * @returns {Array<{category: string, count: number}>}
   */
  getDistinctCategories() {
    try {
      const stmt = this.db.prepare(`
        SELECT gm_category as category, COUNT(DISTINCT midi_file_id) as file_count
        FROM midi_file_channels
        WHERE gm_category IS NOT NULL
        GROUP BY gm_category
        ORDER BY file_count DESC, gm_category ASC
      `);
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get distinct categories: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find files by GM instrument name
   * @param {Array<string>} instruments - GM instrument names
   * @param {string} mode - 'ANY' or 'ALL'
   * @returns {Array} Matching files
   */
  findFilesByInstrument(instruments, mode = 'ANY') {
    try {
      let query;
      const params = [];

      if (mode === 'ALL') {
        // File must contain ALL specified instruments
        const subqueries = instruments.map(() =>
          'mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_instrument_name = ?)'
        );
        query = `SELECT mf.* FROM midi_files mf WHERE ${subqueries.join(' AND ')} ORDER BY mf.uploaded_at DESC`;
        instruments.forEach(name => params.push(name));
      } else {
        // File must contain at least one
        const placeholders = instruments.map(() => '?').join(', ');
        query = `SELECT DISTINCT mf.* FROM midi_files mf
          INNER JOIN midi_file_channels mfc ON mf.id = mfc.midi_file_id
          WHERE mfc.gm_instrument_name IN (${placeholders})
          ORDER BY mf.uploaded_at DESC`;
        instruments.forEach(name => params.push(name));
      }

      const stmt = this.db.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      this.logger.error(`Failed to find files by instrument: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find files by GM category
   * @param {Array<string>} categories - GM categories
   * @param {string} mode - 'ANY' or 'ALL'
   * @returns {Array} Matching files
   */
  findFilesByCategory(categories, mode = 'ANY') {
    try {
      let query;
      const params = [];

      if (mode === 'ALL') {
        const subqueries = categories.map(() =>
          'mf.id IN (SELECT midi_file_id FROM midi_file_channels WHERE gm_category = ?)'
        );
        query = `SELECT mf.* FROM midi_files mf WHERE ${subqueries.join(' AND ')} ORDER BY mf.uploaded_at DESC`;
        categories.forEach(cat => params.push(cat));
      } else {
        const placeholders = categories.map(() => '?').join(', ');
        query = `SELECT DISTINCT mf.* FROM midi_files mf
          INNER JOIN midi_file_channels mfc ON mf.id = mfc.midi_file_id
          WHERE mfc.gm_category IN (${placeholders})
          ORDER BY mf.uploaded_at DESC`;
        categories.forEach(cat => params.push(cat));
      }

      const stmt = this.db.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      this.logger.error(`Failed to find files by category: ${error.message}`);
      throw error;
    }
  }
}

export default MidiDatabase;