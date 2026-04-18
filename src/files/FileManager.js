/**
 * @file src/files/FileManager.js
 * @description High-level file-library service. Wraps the lower-level
 * {@link MidiDatabase} with workflows for upload (with size check, parse,
 * validate, metadata extraction), edit/save, rename/move, duplicate,
 * export and bulk re-analysis. Also owns the routing-status batch
 * helpers consumed by the file listing API.
 *
 * Collaborators:
 *   - {@link MidiFileParser} for MIDI → metadata extraction.
 *   - {@link MidiFileValidator} for non-blocking structural validation.
 *
 * The file is large (~800 LOC); only public entry points carry full
 * JSDoc. Helpers documented inline where logic is non-obvious.
 */
import { parseMidi } from 'midi-file';
import { writeMidi } from 'midi-file';
import MidiFileParser from './MidiFileParser.js';
import MidiFileValidator from './MidiFileValidator.js';
import { LIMITS } from '../core/constants.js';

class FileManager {
  /**
   * @param {Object} app - Application facade. Needs `logger`,
   *   `database`, `eventBus`, `fileRepository`, `routingRepository`,
   *   `autoAssigner`.
   */
  constructor(app) {
    this.app = app;
    this.uploadDir = './uploads';
    this.midiFileParser = new MidiFileParser(app.logger);
    this.midiFileValidator = new MidiFileValidator(app.logger);

    this.app.logger.info('FileManager initialized');
  }

  /**
   * Decode + persist a base64-encoded MIDI upload. Performs:
   *   1. Size cap (against `LIMITS.MAX_MIDI_FILE_SIZE`).
   *   2. Parse via `midi-file` (rejects on malformed data).
   *   3. Non-blocking validation report (warnings only).
   *   4. Header / channel / instrument metadata extraction.
   *   5. Database insert + EventBus emit `file_uploaded`.
   *
   * @param {string} filename
   * @param {string} base64Data
   * @returns {Promise<Object>} Persisted file row + extracted metadata.
   * @throws {Error} On size, parse, or insert failure.
   */
  async handleUpload(filename, base64Data) {
    try {
      const uploadStartTime = Date.now();

      // Validate size before decoding (base64 is ~4/3 of original size)
      const MAX_MIDI_SIZE = LIMITS.MAX_MIDI_FILE_SIZE;
      const estimatedSize = Math.ceil(base64Data.length * 3 / 4);
      if (estimatedSize > MAX_MIDI_SIZE) {
        throw new Error(`File too large: ${(estimatedSize / (1024 * 1024)).toFixed(1)}MB exceeds ${MAX_MIDI_SIZE / (1024 * 1024)}MB limit`);
      }

      // Decode base64
      const buffer = Buffer.from(base64Data, 'base64');

      // Validate MIDI file
      const parseStartTime = Date.now();
      let midi;
      try {
        midi = parseMidi(buffer);
      } catch (error) {
        throw new Error(`Invalid MIDI file: ${error.message}`);
      }
      const parseTimeMs = Date.now() - parseStartTime;

      // Validate MIDI structure (non-blocking, logs warnings)
      const validationReport = this.midiFileValidator.validate(midi);

      // Extract metadata
      const metadataStartTime = Date.now();
      const metadata = this.extractMetadata(midi);

      // Extract instrument metadata for filtering
      const instrumentMetadata = this.extractInstrumentMetadata(midi);
      const analysisTimeMs = Date.now() - metadataStartTime;

      // Store in database with filter metadata
      const dbStartTime = Date.now();
      const fileId = this.app.database.insertFile({
        filename: filename,
        data: base64Data,
        size: buffer.length,
        tracks: midi.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        ppq: midi.header.ticksPerBeat || 480,
        uploaded_at: new Date().toISOString(),
        folder: '/',
        ...instrumentMetadata.fileMetadata
      });

      // Store per-channel detail in midi_file_channels
      if (instrumentMetadata.channelDetails && instrumentMetadata.channelDetails.length > 0) {
        try {
          this.app.database.insertFileChannels(fileId, instrumentMetadata.channelDetails);
        } catch (err) {
          this.app.logger.warn(`Failed to insert channel details for ${filename}: ${err.message}`);
        }
      }
      const dbTimeMs = Date.now() - dbStartTime;

      const totalTimeMs = Date.now() - uploadStartTime;

      this.app.logger.info(`File uploaded: ${filename} (${fileId}) - Instruments: ${instrumentMetadata.fileMetadata.instrument_types} - Total: ${totalTimeMs}ms (parse: ${parseTimeMs}ms, analysis: ${analysisTimeMs}ms, db: ${dbTimeMs}ms)`);

      // Broadcast file list update
      this.broadcastFileList();

      return {
        fileId: fileId,
        filename: filename,
        size: buffer.length,
        sizeFormatted: this.formatFileSize(buffer.length),
        tracks: midi.tracks.length,
        duration: metadata.duration,
        durationFormatted: this.formatDuration(metadata.duration || 0),
        tempo: Math.round(metadata.tempo || 120),
        ppq: midi.header.ticksPerBeat || 480,
        format: midi.header.format,
        // Channel analysis details
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
        // Processing timing (for UI feedback)
        processingTime: {
          totalMs: totalTimeMs,
          parseMs: parseTimeMs,
          analysisMs: analysisTimeMs,
          dbMs: dbTimeMs
        },
        // Validation report (warnings/anomalies detected)
        validation: {
          warnings: validationReport.warnings,
          stats: validationReport.stats
        },
        midi: this.convertMidiToJSON(midi)
      };
    } catch (error) {
      this.app.logger.error(`Upload failed: ${error.message}`);
      throw error;
    }
  }

  extractMetadata(midi) {
    return this.midiFileParser.extractMetadata(midi);
  }

  extractInstrumentMetadata(midi) {
    return this.midiFileParser.extractInstrumentMetadata(midi);
  }

  convertMidiToJSON(midi) {
    return this.midiFileParser.convertMidiToJSON(midi);
  }

  extractTrackName(track) {
    return this.midiFileParser.extractTrackName(track);
  }

  async exportFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Convert Buffer (BLOB) back to base64 for client export
      const data = Buffer.isBuffer(file.data) ? file.data.toString('base64') : file.data;
      return {
        filename: file.filename,
        data: data,
        size: file.size,
        tracks: file.tracks
      };
    } catch (error) {
      this.app.logger.error(`Export failed: ${error.message}`);
      throw error;
    }
  }

  listFiles(folder = '/') {
    try {
      const files = this.app.database.getFiles(folder);

      // Batch-fetch routing status for all files in one query
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
    } catch (error) {
      this.app.logger.error(`List files failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Batch-compute routing status for multiple files using a single SQL query.
   * @param {number[]} fileIds
   * @param {Array} files - raw file rows from DB (with channel_count, tracks)
   * @returns {Map<number, string>} fileId -> routingStatus
   */
  _batchGetRoutingStatus(fileIds, files) {
    const result = new Map();
    if (fileIds.length === 0) return result;

    try {
      // Only count routings to currently connected devices
      const connectedDeviceIds = this._getConnectedDeviceIds();
      const routingCounts = this.app.database.getRoutingCountsByFiles(fileIds, connectedDeviceIds);

      // Build a quick lookup for effective channel count per file
      const channelCountMap = new Map();
      for (const file of files) {
        // Use channel_count (actual MIDI channels with notes), NOT file.tracks (SMF track count).
        // SMF tracks != MIDI channels — a 16-track file may use only 5 channels.
        channelCountMap.set(file.id, file.channel_count || 1);
      }

      for (const row of routingCounts) {
        const effectiveChannelCount = channelCountMap.get(row.midi_file_id) || 1;
        const routedCount = row.count;

        if (routedCount > 0 && routedCount < effectiveChannelCount) {
          result.set(row.midi_file_id, 'partial');
        } else if (routedCount >= effectiveChannelCount && effectiveChannelCount > 0) {
          // NULL min_score means all routings are manual (no compatibility score) => treat as playable
          const minScore = row.min_score;
          result.set(row.midi_file_id, (minScore === null || minScore === undefined || minScore === 100) ? 'playable' : 'routed_incomplete');
        }
      }
    } catch (err) {
      this.app.logger.warn(`Batch routing status failed: ${err.message}`);
    }

    return result;
  }

  /**
   * Get set of currently connected device IDs.
   * Returns null if device manager is unavailable (skip filtering).
   */
  _getConnectedDeviceIds() {
    try {
      const deviceList = this.app.deviceManager?.getDeviceList?.();
      if (!deviceList || deviceList.length === 0) return null;
      const ids = new Set();
      for (const d of deviceList) {
        if (d.id) ids.add(d.id);
      }
      return ids.size > 0 ? ids : null;
    } catch (e) {
      return null;
    }
  }

  getFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

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
    } catch (error) {
      this.app.logger.error(`Get file failed: ${error.message}`);
      throw error;
    }
  }

  async getFileMetadata(fileId) {
    try {
      // Use stored metadata from database — avoid re-parsing the MIDI blob
      // which is slow and can fail on large files or concurrent access
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Get pre-computed channel details from midi_file_channels table
      let channels = [];
      let noteCount = 0;
      let format = 1; // Default MIDI format
      try {
        const channelRows = this.app.database.getFileChannels(fileId);
        channels = channelRows.map(ch => ch.channel).sort((a, b) => a - b);
        noteCount = channelRows.reduce((sum, ch) => sum + (ch.total_notes || 0), 0);
      } catch (chErr) {
        this.app.logger.warn(`Failed to get channel details for file ${fileId}: ${chErr.message}`);
      }

      // Fallback: if no channel data in DB, parse from MIDI blob
      if (channels.length === 0 && file.data) {
        try {
          const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
          const midi = parseMidi(buffer);
          format = midi.header.format;
          const channelsUsed = new Set();
          midi.tracks.forEach(track => {
            track.forEach(event => {
              // Only detect channels with note events (aligns with
              // ChannelAnalyzer and MidiPlayer — no ghost channels)
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
          // Use stored channel_count as best-effort
          if (file.channel_count > 0) {
            channels = Array.from({ length: file.channel_count }, (_, i) => i);
          }
        }
      }

      // Routing status computation — only count routings to connected devices
      let routingStatus = 'unrouted';
      let isAdapted = false;
      let hasAutoAssigned = false;
      try {
        const routings = this.app.database.getRoutingsByFile(fileId);
        const connectedDeviceIds = this._getConnectedDeviceIds();
        const effectiveChannelCount = channels.length || file.channel_count || 1;
        const enabledRoutings = routings.filter(r => {
          if (r.enabled === false) return false;
          // If we have a device list, only count routings to connected devices
          if (connectedDeviceIds && !connectedDeviceIds.has(r.device_id)) return false;
          return true;
        });
        const routedCount = enabledRoutings.length;

        if (routedCount > 0 && routedCount < effectiveChannelCount) {
          routingStatus = 'partial';
        } else if (routedCount >= effectiveChannelCount && effectiveChannelCount > 0) {
          // Filter out NULL scores (manual routings) — only consider actual compatibility scores
          const scores = enabledRoutings.map(r => r.compatibility_score).filter(s => s !== null && s !== undefined);
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
        size: file.size,
        sizeFormatted: this.formatFileSize(file.size),
        tracks: file.tracks,
        duration: file.duration,
        durationFormatted: this.formatDuration(file.duration || 0),
        tempo: Math.round(file.tempo || 120),
        ppq: file.ppq || 480,
        format: format,
        channelCount: channels.length || file.channel_count || 0,
        channels: channels,
        noteCount: noteCount,
        uploadedAt: file.uploaded_at,
        routingStatus: routingStatus,
        isAdapted: isAdapted,
        hasAutoAssigned: hasAutoAssigned
      };
    } catch (error) {
      this.app.logger.error(`Get file metadata failed for file ${fileId}: ${error.message}`);
      throw error;
    }
  }

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

  async loadFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }
      if (!file.data) {
        throw new Error(`File ${fileId} (${file.filename}) has no MIDI data`);
      }

      // Handle both Buffer (BLOB) and base64 string (legacy)
      const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
      const midi = parseMidi(buffer);

      return {
        id: file.id,
        filename: file.filename,
        midi: this.convertMidiToJSON(midi),
        size: file.size,
        tracks: file.tracks,
        duration: file.duration,
        tempo: file.tempo
      };
    } catch (error) {
      this.app.logger.error(`Load file failed: ${error.message}`);
      throw error;
    }
  }

  async deleteFile(fileId) {
    try {
      const numericId = Number(fileId);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        throw new Error(`Invalid file ID: ${fileId}`);
      }

      const file = this.app.database.getFileInfo(numericId);
      if (!file) {
        throw new Error(`File not found: ${numericId}`);
      }

      // midi_file_channels rows are removed by ON DELETE CASCADE (migration 018).
      this.app.database.deleteFile(numericId);
      this.app.logger.info(`File deleted: ${file.filename} (${numericId})`);

      // Broadcast file list update
      this.broadcastFileList();

      return { success: true };
    } catch (error) {
      this.app.logger.error(`Delete file failed: ${error.message}`);
      throw error;
    }
  }

  async saveFile(fileId, midiData) {
    try {
      // Convert JSON back to MIDI buffer
      const midiBytes = writeMidi(midiData);
      const buffer = Buffer.from(midiBytes);

      // Update metadata
      const metadata = this.extractMetadata(midiData);

      // Re-analyze instrument metadata (content may have changed)
      const parsed = parseMidi(buffer);
      const instrumentMetadata = this.extractInstrumentMetadata(parsed);

      // Atomic: either the file row, the channel deletion, and the channel
      // re-insert all commit, or none of them do.
      const persist = this.app.database.transaction(() => {
        this.app.database.updateFile(fileId, {
          data_blob: buffer,
          data: null,
          size: buffer.length,
          tracks: midiData.tracks.length,
          duration: metadata.duration,
          tempo: metadata.tempo,
          ppq: midiData.header.ticksPerBeat || 480,
          ...instrumentMetadata.fileMetadata
        });

        this.app.database.deleteFileChannels(fileId);
        if (instrumentMetadata.channelDetails.length > 0) {
          this.app.database.insertFileChannels(fileId, instrumentMetadata.channelDetails);
        }
      });
      persist();

      this.app.logger.info(`File saved: ${fileId}`);

      // Broadcast file list update
      this.broadcastFileList();

      return { success: true };
    } catch (error) {
      this.app.logger.error(`Save file failed: ${error.message}`);
      throw error;
    }
  }

  async renameFile(fileId, newFilename) {
    try {
      const file = this.app.database.getFileInfo(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      this.app.database.updateFile(fileId, {
        filename: newFilename
      });

      this.app.logger.info(`File renamed: ${file.filename} → ${newFilename}`);

      // Broadcast file list update
      this.broadcastFileList();

      return { success: true };
    } catch (error) {
      this.app.logger.error(`Rename file failed: ${error.message}`);
      throw error;
    }
  }

  async moveFile(fileId, newFolder) {
    try {
      const file = this.app.database.getFileInfo(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      this.app.database.updateFile(fileId, {
        folder: newFolder
      });

      this.app.logger.info(`File moved: ${file.filename} → ${newFolder}`);

      // Broadcast file list update
      this.broadcastFileList();

      return { success: true };
    } catch (error) {
      this.app.logger.error(`Move file failed: ${error.message}`);
      throw error;
    }
  }

  async duplicateFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Generate new filename
      const dotIndex = file.filename.lastIndexOf('.');
      let newFilename;
      if (dotIndex > 0) {
        const baseName = file.filename.substring(0, dotIndex);
        const ext = file.filename.substring(dotIndex);
        newFilename = `${baseName} (copy)${ext}`;
      } else {
        newFilename = `${file.filename} (copy)`;
      }

      // Pre-read channels outside the transaction so JSON parsing failures
      // don't roll back the duplicate; the transaction only owns the writes.
      const sourceChannels = this.app.database.getFileChannels(file.id);
      const channelDetails = sourceChannels.map(ch => ({
        channel: ch.channel,
        primaryProgram: ch.primary_program,
        gmInstrumentName: ch.gm_instrument_name,
        gmCategory: ch.gm_category,
        estimatedType: ch.estimated_type,
        typeConfidence: ch.type_confidence || 0,
        noteRangeMin: ch.note_range_min,
        noteRangeMax: ch.note_range_max,
        totalNotes: ch.total_notes || 0,
        polyphonyMax: ch.polyphony_max || 0,
        polyphonyAvg: ch.polyphony_avg || 0,
        density: ch.density || 0,
        trackNames: ch.track_names ? (() => { try { return JSON.parse(ch.track_names); } catch { return []; } })() : []
      }));

      // Atomic: insert the new file row and its channel copies together.
      const persist = this.app.database.transaction(() => {
        const newId = this.app.database.insertFile({
          filename: newFilename,
          data: file.data,
          size: file.size,
          tracks: file.tracks,
          duration: file.duration,
          tempo: file.tempo,
          ppq: file.ppq,
          uploaded_at: new Date().toISOString(),
          folder: file.folder,
          instrument_types: file.instrument_types || '[]',
          channel_count: file.channel_count || 0,
          note_range_min: file.note_range_min,
          note_range_max: file.note_range_max,
          has_drums: file.has_drums ? 1 : 0,
          has_melody: file.has_melody ? 1 : 0,
          has_bass: file.has_bass ? 1 : 0
        });

        if (channelDetails.length > 0) {
          this.app.database.insertFileChannels(newId, channelDetails);
        }

        return newId;
      });
      const newFileId = persist();

      this.app.logger.info(`File duplicated: ${file.filename} → ${newFilename}`);

      // Broadcast file list update
      this.broadcastFileList();

      return {
        fileId: newFileId,
        filename: newFilename
      };
    } catch (error) {
      this.app.logger.error(`Duplicate file failed: ${error.message}`);
      throw error;
    }
  }

  async saveFileAs(fileId, newFilename, midiData) {
    try {
      const file = this.app.database.getFileInfo(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Check if a file with the new name already exists
      const existingFiles = this.app.database.getFiles(file.folder);
      const duplicateFile = existingFiles.find(f =>
        f.filename.toLowerCase() === newFilename.toLowerCase() && f.id !== fileId
      );

      if (duplicateFile) {
        throw new Error(`A file named "${newFilename}" already exists`);
      }

      // Encode MIDI data to buffer using writeMidi
      const midiBytes = writeMidi(midiData);
      const buffer = Buffer.from(midiBytes);
      const base64Data = buffer.toString('base64');

      // Parse the new MIDI data to extract metadata
      const parsed = parseMidi(buffer);
      const metadata = this.extractMetadata(parsed);
      const duration = metadata.duration;
      const tempo = metadata.tempo;

      // Extract instrument metadata for the new file
      const instrumentMetadata = this.extractInstrumentMetadata(parsed);

      // Insert new file with instrument metadata
      const newFileId = this.app.database.insertFile({
        filename: newFilename,
        data: base64Data,
        size: buffer.length,
        tracks: parsed.tracks.length,
        duration: duration,
        tempo: tempo,
        ppq: parsed.header.ticksPerBeat || 480,
        uploaded_at: new Date().toISOString(),
        folder: file.folder,
        ...instrumentMetadata.fileMetadata
      });

      // Store per-channel detail
      if (instrumentMetadata.channelDetails && instrumentMetadata.channelDetails.length > 0) {
        try {
          this.app.database.insertFileChannels(newFileId, instrumentMetadata.channelDetails);
        } catch (err) {
          this.app.logger.warn(`Failed to insert channel details for saveAs: ${err.message}`);
        }
      }

      this.app.logger.info(`File saved as: ${file.filename} → ${newFilename}`);

      // Broadcast file list update
      this.broadcastFileList();

      return {
        success: true,
        newFileId: newFileId,
        filename: newFilename
      };
    } catch (error) {
      this.app.logger.error(`Save file as failed: ${error.message}`);
      throw error;
    }
  }

  getFolders() {
    try {
      return this.app.database.getFolders();
    } catch (error) {
      this.app.logger.error(`Get folders failed: ${error.message}`);
      throw error;
    }
  }

  createFolder(folderPath) {
    try {
      // Folders are implicitly created when files are moved to them
      // Just validate the path
      if (!folderPath || !folderPath.startsWith('/')) {
        throw new Error('Invalid folder path');
      }

      this.app.logger.info(`Folder created: ${folderPath}`);
      return { success: true };
    } catch (error) {
      this.app.logger.error(`Create folder failed: ${error.message}`);
      throw error;
    }
  }

  broadcastFileList() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('file_list_updated', {
        files: this.listFiles()
      });
    }
  }

  getStorageStats() {
    try {
      const files = this.app.database.getFiles('/');
      const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
      const totalFiles = files.length;

      return {
        totalFiles: totalFiles,
        totalSize: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
      };
    } catch (error) {
      this.app.logger.error(`Get storage stats failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Re-analyze all existing MIDI files to populate midi_file_channels
   * and update instrument_types with GM categories.
   * @returns {Object} - { analyzed, failed, total }
   */
  async reanalyzeAllFiles() {
    try {
      const allFiles = this.app.database.getAllFiles({ includeData: true });
      let analyzed = 0;
      let failed = 0;

      this.app.logger.info(`Starting re-analysis of ${allFiles.length} MIDI files...`);

      for (const file of allFiles) {
        try {
          if (!file.data) {
            this.app.logger.warn(`Skipping file ${file.id} (${file.filename}): no MIDI data`);
            failed++;
            continue;
          }
          const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
          const midi = parseMidi(buffer);
          const instrumentMetadata = this.extractInstrumentMetadata(midi);

          // Atomic per file: metadata update + channel replace commit together
          // or not at all. A failure on one file does not roll back siblings.
          const persist = this.app.database.transaction(() => {
            this.app.database.updateFile(file.id, instrumentMetadata.fileMetadata);
            this.app.database.deleteFileChannels(file.id);
            if (instrumentMetadata.channelDetails.length > 0) {
              this.app.database.insertFileChannels(file.id, instrumentMetadata.channelDetails);
            }
          });
          persist();

          analyzed++;
        } catch (err) {
          this.app.logger.warn(`Failed to re-analyze file ${file.id} (${file.filename}): ${err.message}`);
          failed++;
        }
      }

      this.app.logger.info(`Re-analysis complete: ${analyzed} analyzed, ${failed} failed, ${allFiles.length} total`);

      return {
        analyzed,
        failed,
        total: allFiles.length
      };
    } catch (error) {
      this.app.logger.error(`Re-analyze all files failed: ${error.message}`);
      throw error;
    }
  }
}

export default FileManager;