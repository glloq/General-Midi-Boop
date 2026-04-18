/**
 * @file src/files/FileManager.js
 * @description High-level file-library service. Wraps the lower-level
 * {@link MidiDatabase} + {@link BlobStore} with workflows for upload
 * (hash → blob → parse → analyse → DB transaction), edit/save, rename/move,
 * duplicate, export and bulk re-analysis. Also owns the routing-status batch
 * helpers consumed by the file listing API.
 *
 * Bytes live on disk under `data/midi/<sha[0..1]>/<sha>.mid` and are reached
 * exclusively through `app.blobStore`. The DB only stores the relative
 * `blob_path` + `content_hash`; no base64, no BLOB column.
 */
import { parseMidi, writeMidi } from 'midi-file';
import MidiFileParser from './MidiFileParser.js';
import MidiFileValidator from './MidiFileValidator.js';
import { LIMITS } from '../core/constants.js';

class FileManager {
  /**
   * @param {Object} app - Application facade. Needs `logger`, `database`,
   *   `blobStore`, `eventBus`, `fileRepository`, `routingRepository`,
   *   `autoAssigner`.
   */
  constructor(app) {
    this.app = app;
    this.midiFileParser = new MidiFileParser(app.logger);
    this.midiFileValidator = new MidiFileValidator(app.logger);
    this.app.logger.info('FileManager initialized');
  }

  // ==========================================================================
  // Upload pipeline
  // ==========================================================================

  /**
   * Persist a MIDI buffer end-to-end. Designed to be called from inside an
   * `UploadQueue.add()` task — the optional `report(stage)` callback emits
   * progress events to the WS client (`received | hashed | parsed | analyzed
   * | stored`). Idempotent on `content_hash`: identical bytes returned as a
   * `duplicate` without re-parsing.
   *
   * @param {string} filename
   * @param {Buffer} buffer - Raw MIDI bytes (NOT base64).
   * @param {{folder?: string, report?: (stage: string) => void}} [opts]
   * @returns {Promise<Object>} Result row + extracted metadata.
   * @throws {Error} On size, parse or insert failure.
   */
  async handleUpload(filename, buffer, { folder = '/', report = () => {} } = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('handleUpload requires a Buffer');
    }
    if (buffer.length > LIMITS.MAX_MIDI_FILE_SIZE) {
      const mb = (buffer.length / (1024 * 1024)).toFixed(1);
      const cap = LIMITS.MAX_MIDI_FILE_SIZE / (1024 * 1024);
      throw new Error(`File too large: ${mb}MB exceeds ${cap}MB limit`);
    }
    const t0 = Date.now();
    report('received');

    // Hash + write the blob first. Idempotent on identical bytes.
    const blob = this.app.blobStore.write(buffer);
    report('hashed');

    // Dedup short-circuit: if a row already references this content, return it.
    const existing = this.app.database.midiDB.getFileByContentHash(blob.hash);
    if (existing) {
      this.app.logger.info(
        `Upload duplicate: ${filename} → existing fileId=${existing.id} (hash=${blob.hash.slice(0, 8)}…)`
      );
      return {
        fileId: existing.id,
        filename: existing.filename,
        contentHash: blob.hash,
        status: 'duplicate',
        size: existing.size,
        sizeFormatted: this.formatFileSize(existing.size),
        tracks: existing.tracks,
        duration: existing.duration,
        durationFormatted: this.formatDuration(existing.duration || 0),
        tempo: Math.round(existing.tempo || 120),
        channelCount: existing.channel_count || 0,
        processingTime: { totalMs: Date.now() - t0 }
      };
    }

    // Parse + validate + extract metadata + tempo map
    const parseStart = Date.now();
    let midi;
    try {
      midi = parseMidi(buffer);
    } catch (err) {
      // Blob is now orphaned — clean it up before bailing.
      this._safeBlobDelete(blob.relativePath);
      throw new Error(`Invalid MIDI file: ${err.message}`);
    }
    const parseMs = Date.now() - parseStart;
    report('parsed');

    const validation = this.midiFileValidator.validate(midi);

    const analysisStart = Date.now();
    const metadata = this.midiFileParser.extractMetadata(midi);
    const tempoMap = this.midiFileParser.extractTempoMap(midi);
    const instrumentMetadata = this.midiFileParser.extractInstrumentMetadata(midi);
    const analysisMs = Date.now() - analysisStart;
    report('analyzed');

    // Single transaction: file row + channels + tempo map. Either everything
    // commits or nothing does — no orphan rows.
    const dbStart = Date.now();
    const persist = this.app.database.transaction(() => {
      const id = this.app.database.insertFile({
        content_hash: blob.hash,
        filename,
        folder,
        blob_path: blob.relativePath,
        size: buffer.length,
        tracks: midi.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        ppq: midi.header.ticksPerBeat || 480,
        ...instrumentMetadata.fileMetadata,
        uploaded_at: new Date().toISOString()
      });
      if (instrumentMetadata.channelDetails.length > 0) {
        this.app.database.insertFileChannels(id, instrumentMetadata.channelDetails);
      }
      if (tempoMap.length > 0) {
        this.app.database.midiDB.insertFileTempoMap(id, tempoMap);
      }
      return id;
    });

    let fileId;
    try {
      fileId = persist();
    } catch (err) {
      // If insertion failed for any reason other than a race-condition dedup,
      // the blob is now orphaned. Clean it up only when no row references it.
      if (err.code !== 'DUPLICATE_CONTENT') {
        if (!this.app.database.midiDB.getFileByContentHash(blob.hash)) {
          this._safeBlobDelete(blob.relativePath);
        }
      }
      throw err;
    }
    const dbMs = Date.now() - dbStart;
    report('stored');

    const totalMs = Date.now() - t0;
    this.app.logger.info(
      `File uploaded: ${filename} (id=${fileId}, hash=${blob.hash.slice(0, 8)}…, ${totalMs}ms — parse:${parseMs} analyze:${analysisMs} db:${dbMs})`
    );

    if (this.app.eventBus) {
      this.app.eventBus.emit('file_uploaded', {
        fileId,
        filename,
        contentHash: blob.hash
      });
    }
    this.broadcastFileList();

    return {
      fileId,
      filename,
      contentHash: blob.hash,
      status: 'created',
      size: buffer.length,
      sizeFormatted: this.formatFileSize(buffer.length),
      tracks: midi.tracks.length,
      duration: metadata.duration,
      durationFormatted: this.formatDuration(metadata.duration || 0),
      tempo: Math.round(metadata.tempo || 120),
      ppq: midi.header.ticksPerBeat || 480,
      format: midi.header.format,
      channelCount: instrumentMetadata.fileMetadata.channel_count,
      channels: instrumentMetadata.channelDetails.map(ch => ({
        channel: ch.channel,
        channelDisplay: ch.channel + 1,
        program: ch.primaryProgram,
        instrumentName: ch.gmInstrumentName,
        category: ch.gmCategory,
        type: ch.estimatedType,
        noteRange: { min: ch.noteRangeMin, max: ch.noteRangeMax },
        totalNotes: ch.totalNotes,
        polyphonyMax: ch.polyphonyMax
      })),
      instrumentTypes: instrumentMetadata.fileMetadata.instrument_types,
      hasDrums: !!instrumentMetadata.fileMetadata.has_drums,
      hasMelody: !!instrumentMetadata.fileMetadata.has_melody,
      hasBass: !!instrumentMetadata.fileMetadata.has_bass,
      validation: { warnings: validation.warnings, stats: validation.stats },
      processingTime: { totalMs, parseMs, analysisMs, dbMs }
    };
  }

  // ==========================================================================
  // Read / export
  // ==========================================================================

  async exportFile(fileId) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return {
      filename: file.filename,
      contentHash: file.content_hash,
      size: file.size,
      tracks: file.tracks,
      url: `/api/files/${file.id}/blob?dl=1`
    };
  }

  async loadFile(fileId) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    if (!file.blob_path) {
      throw new Error(`File ${fileId} (${file.filename}) has no blob_path`);
    }
    const buffer = this.app.blobStore.read(file.blob_path);
    const midi = parseMidi(buffer);
    return {
      id: file.id,
      filename: file.filename,
      midi: this.midiFileParser.convertMidiToJSON(midi),
      size: file.size,
      tracks: file.tracks,
      duration: file.duration,
      tempo: file.tempo
    };
  }

  // ==========================================================================
  // Mutating operations
  // ==========================================================================

  async deleteFile(fileId) {
    const numericId = Number(fileId);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new Error(`Invalid file ID: ${fileId}`);
    }
    const file = this.app.database.getFileInfo(numericId);
    if (!file) throw new Error(`File not found: ${numericId}`);

    // FK ON DELETE CASCADE removes channels, tempo map, routings, tablatures.
    this.app.database.deleteFile(numericId);

    // content_hash is UNIQUE → exactly one row per blob. Safe to delete now.
    if (file.blob_path) {
      this._safeBlobDelete(file.blob_path);
    }
    this.app.logger.info(`File deleted: ${file.filename} (${numericId})`);
    this.broadcastFileList();
    return { success: true };
  }

  async saveFile(fileId, midiData) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    const buffer = Buffer.from(writeMidi(midiData));
    const newBlob = this.app.blobStore.write(buffer);

    // If the new content matches another row's hash, refuse rather than
    // silently merging two midi_files rows onto a single blob.
    if (newBlob.hash !== file.content_hash) {
      const collision = this.app.database.midiDB.getFileByContentHash(newBlob.hash);
      if (collision && collision.id !== file.id) {
        // Roll back the just-written blob if it wasn't deduplicated.
        if (!newBlob.deduplicated) this._safeBlobDelete(newBlob.relativePath);
        throw new Error(
          `Save would collide with existing file id=${collision.id} (identical content hash)`
        );
      }
    }

    const parsed = parseMidi(buffer);
    const metadata = this.midiFileParser.extractMetadata(parsed);
    const tempoMap = this.midiFileParser.extractTempoMap(parsed);
    const instrumentMetadata = this.midiFileParser.extractInstrumentMetadata(parsed);

    const oldBlobPath = file.blob_path;
    const persist = this.app.database.transaction(() => {
      this.app.database.updateFile(fileId, {
        blob_path: newBlob.relativePath,
        size: buffer.length,
        tracks: parsed.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        ppq: parsed.header.ticksPerBeat || 480,
        ...instrumentMetadata.fileMetadata
      });
      // content_hash is UNIQUE — not in updateFile's allow-list, raw UPDATE.
      if (newBlob.hash !== file.content_hash) {
        this.app.database.db
          .prepare('UPDATE midi_files SET content_hash = ? WHERE id = ?')
          .run(newBlob.hash, fileId);
      }
      this.app.database.deleteFileChannels(fileId);
      if (instrumentMetadata.channelDetails.length > 0) {
        this.app.database.insertFileChannels(fileId, instrumentMetadata.channelDetails);
      }
      this.app.database.midiDB.deleteFileTempoMap(fileId);
      if (tempoMap.length > 0) {
        this.app.database.midiDB.insertFileTempoMap(fileId, tempoMap);
      }
    });
    persist();

    // Old blob is now orphaned (UNIQUE(content_hash) ⇒ no other row uses it).
    if (oldBlobPath && oldBlobPath !== newBlob.relativePath) {
      this._safeBlobDelete(oldBlobPath);
    }

    this.app.logger.info(`File saved: ${fileId} (hash=${newBlob.hash.slice(0, 8)}…)`);
    this.broadcastFileList();
    return { success: true };
  }

  async renameFile(fileId, newFilename) {
    const file = this.app.database.getFileInfo(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    this.app.database.updateFile(fileId, { filename: newFilename });
    this.app.logger.info(`File renamed: ${file.filename} → ${newFilename}`);
    this.broadcastFileList();
    return { success: true };
  }

  async moveFile(fileId, newFolder) {
    const file = this.app.database.getFileInfo(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    this.app.database.updateFile(fileId, { folder: newFolder });
    this.app.logger.info(`File moved: ${file.filename} → ${newFolder}`);
    this.broadcastFileList();
    return { success: true };
  }

  /**
   * Duplicate by content. Because `content_hash` is UNIQUE on `midi_files`,
   * an exact-content duplicate cannot create a second row — we return the
   * existing source id with `status: 'duplicate'`. To get a writable copy
   * with mutations, callers should use {@link saveFileAs}.
   */
  async duplicateFile(fileId) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return {
      fileId: file.id,
      filename: file.filename,
      status: 'duplicate'
    };
  }

  async saveFileAs(fileId, newFilename, midiData) {
    const file = this.app.database.getFileInfo(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    const buffer = Buffer.from(writeMidi(midiData));
    return this.handleUpload(newFilename, buffer, { folder: file.folder });
  }

  async reanalyzeAllFiles() {
    const allFiles = this.app.database.getAllFiles();
    let analyzed = 0;
    let failed = 0;
    this.app.logger.info(`Re-analyzing ${allFiles.length} MIDI files...`);

    for (const file of allFiles) {
      try {
        if (!file.blob_path) {
          this.app.logger.warn(`Skipping file ${file.id}: no blob_path`);
          failed++;
          continue;
        }
        const buffer = this.app.blobStore.read(file.blob_path);
        const midi = parseMidi(buffer);
        const instrumentMetadata = this.midiFileParser.extractInstrumentMetadata(midi);
        const tempoMap = this.midiFileParser.extractTempoMap(midi);

        const persist = this.app.database.transaction(() => {
          this.app.database.updateFile(file.id, instrumentMetadata.fileMetadata);
          this.app.database.deleteFileChannels(file.id);
          if (instrumentMetadata.channelDetails.length > 0) {
            this.app.database.insertFileChannels(file.id, instrumentMetadata.channelDetails);
          }
          this.app.database.midiDB.deleteFileTempoMap(file.id);
          if (tempoMap.length > 0) {
            this.app.database.midiDB.insertFileTempoMap(file.id, tempoMap);
          }
        });
        persist();
        analyzed++;
      } catch (err) {
        this.app.logger.warn(`Re-analyze failed for file ${file.id}: ${err.message}`);
        failed++;
      }
    }

    this.app.logger.info(`Re-analysis complete: ${analyzed} analyzed, ${failed} failed`);
    return { analyzed, failed, total: allFiles.length };
  }

  // ==========================================================================
  // Listing / metadata helpers
  // ==========================================================================

  listFiles(folder = '/') {
    const files = this.app.database.getFiles(folder);
    const fileIds = files.map(f => f.id);
    const routingMap = this._batchGetRoutingStatus(fileIds, files);

    return files.map(file => ({
      id: file.id,
      filename: file.filename,
      size: file.size,
      sizeFormatted: this.formatFileSize(file.size),
      tracks: file.tracks,
      duration: file.duration,
      durationFormatted: this.formatDuration(file.duration || 0),
      tempo: Math.round(file.tempo || 120),
      channelCount: file.channel_count || 0,
      uploadedAt: file.uploaded_at,
      folder: file.folder,
      routingStatus: routingMap.get(file.id) || 'unrouted'
    }));
  }

  _batchGetRoutingStatus(fileIds, files) {
    const result = new Map();
    if (fileIds.length === 0) return result;

    try {
      const connectedDeviceIds = this._getConnectedDeviceIds();
      const routingCounts = this.app.database.getRoutingCountsByFiles(fileIds, connectedDeviceIds);

      const channelCountMap = new Map();
      for (const file of files) {
        channelCountMap.set(file.id, file.channel_count || 1);
      }

      for (const row of routingCounts) {
        const effectiveChannelCount = channelCountMap.get(row.midi_file_id) || 1;
        const routedCount = row.count;

        if (routedCount > 0 && routedCount < effectiveChannelCount) {
          result.set(row.midi_file_id, 'partial');
        } else if (routedCount >= effectiveChannelCount && effectiveChannelCount > 0) {
          const minScore = row.min_score;
          result.set(
            row.midi_file_id,
            (minScore === null || minScore === undefined || minScore === 100)
              ? 'playable'
              : 'routed_incomplete'
          );
        }
      }
    } catch (err) {
      this.app.logger.warn(`Batch routing status failed: ${err.message}`);
    }

    return result;
  }

  _getConnectedDeviceIds() {
    try {
      const deviceList = this.app.deviceManager?.getDeviceList?.();
      if (!deviceList || deviceList.length === 0) return null;
      const ids = new Set();
      for (const d of deviceList) {
        if (d.id) ids.add(d.id);
      }
      return ids.size > 0 ? ids : null;
    } catch {
      return null;
    }
  }

  getFile(fileId) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return {
      id: file.id,
      filename: file.filename,
      size: file.size,
      tracks: file.tracks,
      duration: file.duration,
      tempo: file.tempo,
      ppq: file.ppq,
      uploadedAt: file.uploaded_at,
      folder: file.folder
    };
  }

  async getFileMetadata(fileId) {
    const file = this.app.database.getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    let channels = [];
    let noteCount = 0;
    let format = 1;
    try {
      const channelRows = this.app.database.getFileChannels(fileId);
      channels = channelRows.map(ch => ch.channel).sort((a, b) => a - b);
      noteCount = channelRows.reduce((sum, ch) => sum + (ch.total_notes || 0), 0);
    } catch (chErr) {
      this.app.logger.warn(`Failed to get channel details for file ${fileId}: ${chErr.message}`);
    }

    // Fallback: parse the blob if no channel rows are stored.
    if (channels.length === 0 && file.blob_path) {
      try {
        const buffer = this.app.blobStore.read(file.blob_path);
        const midi = parseMidi(buffer);
        format = midi.header.format;
        const channelsUsed = new Set();
        midi.tracks.forEach(track => {
          track.forEach(event => {
            if (event.channel !== undefined &&
                (event.type === 'noteOn' || event.type === 'noteOff')) {
              channelsUsed.add(event.channel);
              noteCount++;
            }
          });
        });
        channels = Array.from(channelsUsed).sort((a, b) => a - b);
      } catch (parseErr) {
        this.app.logger.warn(`Fallback MIDI parse failed for file ${fileId}: ${parseErr.message}`);
        if (file.channel_count > 0) {
          channels = Array.from({ length: file.channel_count }, (_, i) => i);
        }
      }
    }

    let routingStatus = 'unrouted';
    let isAdapted = false;
    let hasAutoAssigned = false;
    try {
      const routings = this.app.database.getRoutingsByFile(fileId);
      const connectedDeviceIds = this._getConnectedDeviceIds();
      const effectiveChannelCount = channels.length || file.channel_count || 1;
      const enabledRoutings = routings.filter(r => {
        if (r.enabled === false) return false;
        if (connectedDeviceIds && !connectedDeviceIds.has(r.device_id)) return false;
        return true;
      });
      const routedCount = enabledRoutings.length;

      if (routedCount > 0 && routedCount < effectiveChannelCount) {
        routingStatus = 'partial';
      } else if (routedCount >= effectiveChannelCount && effectiveChannelCount > 0) {
        const scores = enabledRoutings
          .map(r => r.compatibility_score)
          .filter(s => s !== null && s !== undefined);
        const minScore = scores.length > 0 ? Math.min(...scores) : null;
        routingStatus = (minScore === null || minScore === 100) ? 'playable' : 'routed_incomplete';
      }

      isAdapted = file.is_original === 0 || file.is_original === false;
      hasAutoAssigned = enabledRoutings.some(r => r.auto_assigned);
    } catch (routingErr) {
      this.app.logger.warn(`Failed to compute routing status for file ${fileId}: ${routingErr.message}`);
    }

    return {
      id: file.id,
      filename: file.filename,
      contentHash: file.content_hash,
      size: file.size,
      sizeFormatted: this.formatFileSize(file.size),
      tracks: file.tracks,
      duration: file.duration,
      durationFormatted: this.formatDuration(file.duration || 0),
      tempo: Math.round(file.tempo || 120),
      ppq: file.ppq || 480,
      format,
      channelCount: channels.length || file.channel_count || 0,
      channels,
      noteCount,
      uploadedAt: file.uploaded_at,
      routingStatus,
      isAdapted,
      hasAutoAssigned,
      blobUrl: `/api/files/${file.id}/blob`
    };
  }

  // ==========================================================================
  // Misc helpers
  // ==========================================================================

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getFolders() {
    return this.app.database.getFolders();
  }

  createFolder(folderPath) {
    if (!folderPath || !folderPath.startsWith('/')) {
      throw new Error('Invalid folder path');
    }
    this.app.logger.info(`Folder created: ${folderPath}`);
    return { success: true };
  }

  broadcastFileList() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('file_list_updated', {
        files: this.listFiles()
      });
    }
  }

  getStorageStats() {
    const files = this.app.database.getFiles('/');
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    return {
      totalFiles: files.length,
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
  }

  // Pass-through helpers used by other modules / tests.
  extractMetadata(midi) { return this.midiFileParser.extractMetadata(midi); }
  extractInstrumentMetadata(midi) { return this.midiFileParser.extractInstrumentMetadata(midi); }
  convertMidiToJSON(midi) { return this.midiFileParser.convertMidiToJSON(midi); }
  extractTrackName(track) { return this.midiFileParser.extractTrackName(track); }

  _safeBlobDelete(relativePath) {
    try {
      this.app.blobStore.delete(relativePath);
    } catch (err) {
      this.app.logger.warn(`BlobStore delete failed for ${relativePath}: ${err.message}`);
    }
  }
}

export default FileManager;
