// src/storage/FileManager.js
import { parseMidi } from 'midi-file';
import { writeMidi } from 'midi-file';
import ChannelAnalyzer from '../midi/ChannelAnalyzer.js';
import MidiUtils from '../utils/MidiUtils.js';

class FileManager {
  constructor(app) {
    this.app = app;
    this.uploadDir = './uploads';
    this.channelAnalyzer = new ChannelAnalyzer(app.logger);

    this.app.logger.info('FileManager initialized');
  }

  async handleUpload(filename, base64Data) {
    try {
      const uploadStartTime = Date.now();

      // Validate size before decoding (base64 is ~4/3 of original size)
      const MAX_MIDI_SIZE = 50 * 1024 * 1024; // 50MB max
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
        midi: this.convertMidiToJSON(midi)
      };
    } catch (error) {
      this.app.logger.error(`Upload failed: ${error.message}`);
      throw error;
    }
  }

  extractMetadata(midi) {
    const ppq = midi.header.ticksPerBeat || 480;
    if (ppq <= 0 || !isFinite(ppq)) {
      this.app.logger.warn(`Invalid PPQ value ${ppq}, using default 480`);
      return { tempo: 120, duration: 0, totalTicks: 0 };
    }
    let firstTempo = 120; // Default BPM
    let totalTicks = 0;

    // Collect all tempo events with absolute tick positions
    const tempoEvents = [];
    for (const track of midi.tracks) {
      let trackTicks = 0;
      for (const event of track) {
        trackTicks += event.deltaTime;
        if (event.type === 'setTempo') {
          if (firstTempo === 120 && tempoEvents.length === 0) {
            firstTempo = 60000000 / event.microsecondsPerBeat;
          }
          tempoEvents.push({
            tick: trackTicks,
            microsecondsPerBeat: event.microsecondsPerBeat
          });
        }
      }
    }
    tempoEvents.sort((a, b) => a.tick - b.tick);

    // Calculate total ticks across all tracks
    midi.tracks.forEach(track => {
      let trackTicks = 0;
      track.forEach(event => {
        trackTicks += event.deltaTime;
      });
      totalTicks = Math.max(totalTicks, trackTicks);
    });

    // Calculate duration using tempo map (handles multi-tempo files)
    let duration;
    if (tempoEvents.length <= 1) {
      // Single tempo: simple calculation
      const tempo = tempoEvents.length === 1
        ? 60000000 / tempoEvents[0].microsecondsPerBeat
        : 120;
      const beatsPerSecond = tempo / 60;
      const ticksPerSecond = beatsPerSecond * ppq;
      duration = totalTicks / ticksPerSecond;
    } else {
      // Multi-tempo: walk through tempo changes
      let cumulativeSeconds = 0;
      let lastTick = 0;
      let currentMicrosPerBeat = tempoEvents[0].microsecondsPerBeat;

      for (let i = 1; i < tempoEvents.length; i++) {
        const deltaTicks = tempoEvents[i].tick - lastTick;
        cumulativeSeconds += (deltaTicks * currentMicrosPerBeat) / (ppq * 1000000);
        lastTick = tempoEvents[i].tick;
        currentMicrosPerBeat = tempoEvents[i].microsecondsPerBeat;
      }
      // Add remaining ticks after last tempo change
      const remainingTicks = totalTicks - lastTick;
      cumulativeSeconds += (remainingTicks * currentMicrosPerBeat) / (ppq * 1000000);
      duration = cumulativeSeconds;
    }

    return {
      tempo: isFinite(firstTempo) ? firstTempo : 120,
      duration: isFinite(duration) ? duration : 0,
      totalTicks: totalTicks
    };
  }

  /**
   * Extract instrument metadata for filtering
   * Analyzes MIDI channels to determine instrument types, note ranges, etc.
   * @param {Object} midi - Parsed MIDI file
   * @returns {Object} - { fileMetadata, channelDetails }
   */
  extractInstrumentMetadata(midi) {
    try {
      // Convert to format expected by ChannelAnalyzer
      const midiData = this.convertMidiToJSON(midi);

      // Analyze all channels
      const channelAnalyses = this.channelAnalyzer.analyzeAllChannels(midiData);

      // Extract instrument types (both broad categories and GM categories)
      const instrumentTypes = new Set();
      const channelDetails = [];
      let hasDrums = false;
      let hasMelody = false;
      let hasBass = false;
      let noteMin = 127;
      let noteMax = 0;

      for (const analysis of channelAnalyses) {
        // Add estimated type to set
        if (analysis.estimatedType) {
          const typeMapping = {
            'drums': 'Drums',
            'percussive': 'Percussion',
            'bass': 'Bass',
            'melody': 'Melody',
            'harmony': 'Harmony'
          };

          const friendlyType = typeMapping[analysis.estimatedType] || analysis.estimatedType;
          instrumentTypes.add(friendlyType);

          if (analysis.estimatedType === 'drums') hasDrums = true;
          if (analysis.estimatedType === 'melody') hasMelody = true;
          if (analysis.estimatedType === 'bass') hasBass = true;
        }

        // Resolve GM instrument name and category from primary program
        let gmInstrumentName = null;
        let gmCategory = null;

        if (analysis.channel === 9) {
          // Channel 10 (0-indexed 9) is always drums in GM
          gmInstrumentName = 'Drums';
          gmCategory = 'Percussive';
          instrumentTypes.add('Drums');
          instrumentTypes.add('Percussive');
        } else {
          // Use primary program if available, otherwise default to 0 (Acoustic Grand Piano)
          // per GM standard: channels without explicit program change default to program 0
          const program = (analysis.primaryProgram !== null && analysis.primaryProgram !== undefined)
            ? analysis.primaryProgram
            : 0;
          gmInstrumentName = MidiUtils.getGMInstrumentName(program);
          gmCategory = MidiUtils.getGMCategory(program);
          if (gmCategory) {
            instrumentTypes.add(gmCategory);
          }
        }

        // Build channel detail record
        // Use resolved program (defaulting to 0 for non-drum channels without program change)
        const resolvedProgram = (analysis.channel === 9)
          ? analysis.primaryProgram
          : (analysis.primaryProgram !== null && analysis.primaryProgram !== undefined)
            ? analysis.primaryProgram
            : 0;

        channelDetails.push({
          channel: analysis.channel,
          primaryProgram: resolvedProgram,
          gmInstrumentName,
          gmCategory,
          estimatedType: analysis.estimatedType,
          typeConfidence: analysis.typeConfidence || 0,
          noteRangeMin: analysis.noteRange ? analysis.noteRange.min : null,
          noteRangeMax: analysis.noteRange ? analysis.noteRange.max : null,
          totalNotes: analysis.totalNotes || 0,
          polyphonyMax: analysis.polyphony ? analysis.polyphony.max : 0,
          polyphonyAvg: analysis.polyphony ? analysis.polyphony.avg : 0,
          density: analysis.density || 0,
          trackNames: analysis.trackNames || []
        });

        // Update note range
        if (analysis.noteRange) {
          noteMin = Math.min(noteMin, analysis.noteRange.min);
          noteMax = Math.max(noteMax, analysis.noteRange.max);
        }
      }

      return {
        fileMetadata: {
          instrument_types: JSON.stringify(Array.from(instrumentTypes)),
          channel_count: channelAnalyses.length,
          note_range_min: noteMin < 127 ? noteMin : null,
          note_range_max: noteMax > 0 ? noteMax : null,
          has_drums: hasDrums ? 1 : 0,
          has_melody: hasMelody ? 1 : 0,
          has_bass: hasBass ? 1 : 0
        },
        channelDetails
      };
    } catch (error) {
      this.app.logger.error(`Failed to extract instrument metadata: ${error.message}`, error.stack);

      return {
        fileMetadata: {
          instrument_types: '[]',
          channel_count: 0,
          note_range_min: null,
          note_range_max: null,
          has_drums: 0,
          has_melody: 0,
          has_bass: 0
        },
        channelDetails: []
      };
    }
  }

  convertMidiToJSON(midi) {
    // Log channel statistics for debugging
    const channelCounts = new Map();
    midi.tracks.forEach((track, trackIdx) => {
      track.forEach(event => {
        if (event.channel !== undefined) {
          channelCounts.set(event.channel, (channelCounts.get(event.channel) || 0) + 1);
        }
      });
    });

    if (channelCounts.size > 0) {
      this.app.logger.info(`MIDI channels detected during parsing: [${Array.from(channelCounts.keys()).sort((a,b) => a-b).join(', ')}]`);
    } else {
      this.app.logger.warn('No MIDI channels detected during parsing! This may indicate a problem.');
    }

    return {
      header: {
        format: midi.header.format,
        numTracks: midi.header.numTracks,
        ticksPerBeat: midi.header.ticksPerBeat
      },
      tracks: midi.tracks.map((track, index) => {
        return {
          index: index,
          name: this.extractTrackName(track),
          events: track.map(event => {
            // Simple approach: copy ALL event properties
            // This ensures we don't accidentally miss anything
            const cleanEvent = {
              deltaTime: event.deltaTime || 0,
              type: event.type
            };

            // Copy all other properties from the original event
            for (const key in event) {
              if (key !== 'deltaTime' && key !== 'type') {
                cleanEvent[key] = event[key];
              }
            }

            return cleanEvent;
          })
        };
      })
    };
  }

  extractTrackName(track) {
    const nameEvent = track.find(e => e.type === 'trackName');
    return nameEvent ? nameEvent.text : 'Unnamed Track';
  }

  async exportFile(fileId) {
    try {
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      return {
        filename: file.filename,
        data: file.data, // Already Base64
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
      
      return files.map(file => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
        tracks: file.tracks,
        duration: file.duration,
        tempo: file.tempo,
        uploadedAt: file.uploaded_at,
        folder: file.folder
      }));
    } catch (error) {
      this.app.logger.error(`List files failed: ${error.message}`);
      throw error;
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
          const buffer = Buffer.from(file.data, 'base64');
          const midi = parseMidi(buffer);
          format = midi.header.format;
          const channelsUsed = new Set();
          midi.tracks.forEach(track => {
            track.forEach(event => {
              if (event.channel !== undefined) channelsUsed.add(event.channel);
              if (event.type === 'noteOn' || event.type === 'noteOff') noteCount++;
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

      // Routing status computation
      let routingStatus = 'unrouted';
      let isAdapted = false;
      let hasAutoAssigned = false;
      try {
        const routings = this.app.database.getRoutingsByFile(fileId);
        const effectiveChannelCount = channels.length || file.channel_count || file.tracks || 1;
        const enabledRoutings = routings.filter(r => r.enabled !== false);
        const routedCount = enabledRoutings.length;

        if (routedCount > 0 && routedCount < effectiveChannelCount) {
          routingStatus = 'partial';
        } else if (routedCount >= effectiveChannelCount && effectiveChannelCount > 0) {
          const minScore = Math.min(...enabledRoutings.map(r => r.compatibility_score ?? 0));
          routingStatus = minScore === 100 ? 'playable' : 'routed_incomplete';
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

      const buffer = Buffer.from(file.data, 'base64');
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
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      this.app.database.deleteFile(fileId);
      this.app.logger.info(`File deleted: ${file.filename} (${fileId})`);

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
      const base64Data = buffer.toString('base64');

      // Update metadata
      const metadata = this.extractMetadata(midiData);

      // Re-analyze instrument metadata (content may have changed)
      const parsed = parseMidi(buffer);
      const instrumentMetadata = this.extractInstrumentMetadata(parsed);

      this.app.database.updateFile(fileId, {
        data: base64Data,
        size: buffer.length,
        tracks: midiData.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        ppq: midiData.header.ticksPerBeat || 480,
        ...instrumentMetadata.fileMetadata
      });

      // Update channel records
      try {
        this.app.database.deleteFileChannels(fileId);
        if (instrumentMetadata.channelDetails.length > 0) {
          this.app.database.insertFileChannels(fileId, instrumentMetadata.channelDetails);
        }
      } catch (err) {
        this.app.logger.warn(`Failed to update channel data on save: ${err.message}`);
      }

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
      const file = this.app.database.getFile(fileId);
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
      const file = this.app.database.getFile(fileId);
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

      // Insert duplicate with instrument metadata
      const newFileId = this.app.database.insertFile({
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

      // Copy channel records from original file
      try {
        const channels = this.app.database.getFileChannels(file.id);
        if (channels.length > 0) {
          const channelDetails = channels.map(ch => ({
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
          this.app.database.insertFileChannels(newFileId, channelDetails);
        }
      } catch (err) {
        this.app.logger.warn(`Failed to copy channel data for duplicate: ${err.message}`);
      }

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
      const file = this.app.database.getFile(fileId);
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
          const buffer = Buffer.from(file.data, 'base64');
          const midi = parseMidi(buffer);
          const instrumentMetadata = this.extractInstrumentMetadata(midi);

          // Update all file metadata (instrument_types, has_drums, has_melody, has_bass, etc.)
          this.app.database.updateFile(file.id, instrumentMetadata.fileMetadata);

          // Delete old channel data and insert new
          this.app.database.deleteFileChannels(file.id);
          if (instrumentMetadata.channelDetails.length > 0) {
            this.app.database.insertFileChannels(file.id, instrumentMetadata.channelDetails);
          }

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