// src/storage/FileManager.js
import { parseMidi } from 'midi-file';
import { writeMidi } from 'midi-file';
import ChannelAnalyzer from '../midi/ChannelAnalyzer.js';

class FileManager {
  constructor(app) {
    this.app = app;
    this.uploadDir = './uploads';
    this.channelAnalyzer = new ChannelAnalyzer(app.logger);

    this.app.logger.info('FileManager initialized');
  }

  async handleUpload(filename, base64Data) {
    try {
      // Decode base64
      const buffer = Buffer.from(base64Data, 'base64');

      // Validate MIDI file
      let midi;
      try {
        midi = parseMidi(buffer);
      } catch (error) {
        throw new Error(`Invalid MIDI file: ${error.message}`);
      }

      // Extract metadata
      const metadata = this.extractMetadata(midi);

      // Extract instrument metadata for filtering
      const instrumentMetadata = this.extractInstrumentMetadata(midi);

      // Store in database with filter metadata
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
        ...instrumentMetadata
      });

      this.app.logger.info(`File uploaded: ${filename} (${fileId}) - Instruments: ${instrumentMetadata.instrument_types}`);

      // Broadcast file list update
      this.broadcastFileList();

      return {
        fileId: fileId,
        filename: filename,
        size: buffer.length,
        tracks: midi.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        midi: this.convertMidiToJSON(midi)
      };
    } catch (error) {
      this.app.logger.error(`Upload failed: ${error.message}`);
      throw error;
    }
  }

  extractMetadata(midi) {
    const ppq = midi.header.ticksPerBeat || 480;
    let tempo = 120; // Default BPM
    let totalTicks = 0;

    // Find tempo
    for (const track of midi.tracks) {
      const tempoEvent = track.find(e => e.type === 'setTempo');
      if (tempoEvent) {
        tempo = 60000000 / tempoEvent.microsecondsPerBeat;
        break;
      }
    }

    // Calculate duration
    midi.tracks.forEach(track => {
      let trackTicks = 0;
      track.forEach(event => {
        trackTicks += event.deltaTime;
      });
      totalTicks = Math.max(totalTicks, trackTicks);
    });

    const beatsPerSecond = tempo / 60;
    const ticksPerSecond = beatsPerSecond * ppq;
    const duration = totalTicks / ticksPerSecond;

    return {
      tempo: tempo,
      duration: duration,
      totalTicks: totalTicks
    };
  }

  /**
   * Extract instrument metadata for filtering
   * Analyzes MIDI channels to determine instrument types, note ranges, etc.
   * @param {Object} midi - Parsed MIDI file
   * @returns {Object} - Filter metadata
   */
  extractInstrumentMetadata(midi) {
    try {
      // Convert to format expected by ChannelAnalyzer
      const midiData = this.convertMidiToJSON(midi);

      // Analyze all channels
      const channelAnalyses = this.channelAnalyzer.analyzeAllChannels(midiData);

      // Extract instrument types
      const instrumentTypes = new Set();
      let hasDrums = false;
      let hasMelody = false;
      let hasBass = false;
      let noteMin = 127;
      let noteMax = 0;

      for (const analysis of channelAnalyses) {
        // Add estimated type to set
        if (analysis.estimatedType) {
          // Map internal types to user-friendly names
          const typeMapping = {
            'drums': 'Drums',
            'percussive': 'Percussion',
            'bass': 'Bass',
            'melody': 'Melody',
            'harmony': 'Harmony'
          };

          const friendlyType = typeMapping[analysis.estimatedType] || analysis.estimatedType;
          instrumentTypes.add(friendlyType);

          // Set boolean flags
          if (analysis.estimatedType === 'drums') hasDrums = true;
          if (analysis.estimatedType === 'melody') hasMelody = true;
          if (analysis.estimatedType === 'bass') hasBass = true;
        }

        // Update note range
        if (analysis.noteRange) {
          noteMin = Math.min(noteMin, analysis.noteRange.min);
          noteMax = Math.max(noteMax, analysis.noteRange.max);
        }
      }

      return {
        instrument_types: JSON.stringify(Array.from(instrumentTypes)),
        channel_count: channelAnalyses.length,
        note_range_min: noteMin < 127 ? noteMin : null,
        note_range_max: noteMax > 0 ? noteMax : null,
        has_drums: hasDrums,
        has_melody: hasMelody,
        has_bass: hasBass
      };
    } catch (error) {
      this.app.logger.error(`Failed to extract instrument metadata: ${error.message}`);

      // Return default values on error
      return {
        instrument_types: '[]',
        channel_count: 0,
        note_range_min: null,
        note_range_max: null,
        has_drums: false,
        has_melody: false,
        has_bass: false
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
      const file = this.app.database.getFile(fileId);
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Parse MIDI to get channel information
      const buffer = Buffer.from(file.data, 'base64');
      const midi = parseMidi(buffer);

      // Count unique channels used
      const channelsUsed = new Set();
      let noteCount = 0;

      midi.tracks.forEach(track => {
        track.forEach(event => {
          if (event.channel !== undefined) {
            channelsUsed.add(event.channel);
          }
          if (event.type === 'noteOn' || event.type === 'noteOff') {
            noteCount++;
          }
        });
      });

      return {
        id: file.id,
        filename: file.filename,
        size: file.size,
        sizeFormatted: this.formatFileSize(file.size),
        tracks: file.tracks,
        duration: file.duration,
        durationFormatted: this.formatDuration(file.duration),
        tempo: Math.round(file.tempo),
        ppq: file.ppq,
        format: midi.header.format,
        channelCount: channelsUsed.size,
        channels: Array.from(channelsUsed).sort((a, b) => a - b),
        noteCount: noteCount,
        uploadedAt: file.uploaded_at
      };
    } catch (error) {
      this.app.logger.error(`Get file metadata failed: ${error.message}`);
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

      this.app.database.updateFile(fileId, {
        data: base64Data,
        size: buffer.length,
        tracks: midiData.tracks.length,
        duration: metadata.duration,
        tempo: metadata.tempo,
        ppq: midiData.header.ticksPerBeat || 480
      });

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
      const nameParts = file.filename.split('.');
      const ext = nameParts.pop();
      const baseName = nameParts.join('.');
      const newFilename = `${baseName} (copy).${ext}`;

      // Insert duplicate
      const newFileId = this.app.database.insertFile({
        filename: newFilename,
        data: file.data,
        size: file.size,
        tracks: file.tracks,
        duration: file.duration,
        tempo: file.tempo,
        ppq: file.ppq,
        uploaded_at: new Date().toISOString(),
        folder: file.folder
      });

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

      // Insert new file
      const newFileId = this.app.database.insertFile({
        filename: newFilename,
        data: base64Data,
        size: buffer.length,
        tracks: parsed.tracks.length,
        duration: duration,
        tempo: tempo,
        ppq: parsed.header.ticksPerBeat || 480,
        uploaded_at: new Date().toISOString(),
        folder: file.folder
      });

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
}

export default FileManager;