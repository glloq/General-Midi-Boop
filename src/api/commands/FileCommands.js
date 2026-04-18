/**
 * @file src/api/commands/FileCommands.js
 * @description WebSocket commands managing the MIDI file library: CRUD,
 * read/write for the editor, search, multi-criterion filtering, channel
 * inspection and bulk re-analysis.
 *
 * Registered commands:
 *   - `file_upload`              — base64 → DB + parse + analyze
 *   - `file_list`                — flat list under a folder (with routing)
 *   - `file_metadata`            — header info for one file
 *   - `file_read`                — full MIDI payload for the editor
 *   - `file_write`               — overwrite payload (invalidates cache)
 *   - `file_delete`              — remove + invalidate cache
 *   - `file_save_as`             — clone into a new name
 *   - `file_rename`              — change filename
 *   - `file_move`                — change folder
 *   - `file_duplicate`           — copy with auto-named target
 *   - `file_export`              — return the file payload for download
 *   - `file_search`              — substring match over names
 *   - `file_filter`              — multi-criterion filter (see handler)
 *   - `file_channels`            — analyzed channel summary
 *   - `file_reanalyze_all`       — replay analysis over every file
 *   - `file_reanalyze_check`     — count files needing reanalysis
 *   - `file_routing_status`      — playable routings for one file
 *   - `midi_instruments_list`    — distinct GM instruments across library
 *   - `midi_categories_list`     — distinct GM categories across library
 *
 * Validation: see `file.schemas.js` for upload/delete/rename/move/export;
 * other commands rely on imperative checks inside the handler.
 */
import { ValidationError, NotFoundError } from '../../core/errors/index.js';

/**
 * Decode a base64 file payload, persist it, and analyze its content.
 *
 * @param {Object} app
 * @param {{filename:string, data:string}} data - `data` is base64.
 * @returns {Promise<Object>} Result returned verbatim by FileManager.
 */
async function fileUpload(app, data) {
  const result = await app.fileManager.handleUpload(data.filename, data.data);
  return result;
}

/**
 * List files under `folder` (defaults to `/`). Result entries already
 * carry routing status and human-formatted size/duration.
 *
 * @param {Object} app
 * @param {{folder?:string}} data
 * @returns {Promise<{files: Object[]}>}
 */
async function fileList(app, data) {
  const files = app.fileManager.listFiles(data.folder || '/');
  return { files: files };
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true, metadata:Object}>}
 */
async function fileMetadata(app, data) {
  const metadata = await app.fileManager.getFileMetadata(data.fileId);
  return { success: true, metadata: metadata };
}

/**
 * Load a file's MIDI payload for the in-browser editor.
 *
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true, fileId:(string|number), midiData:Object}>}
 */
async function fileRead(app, data) {
  const result = await app.fileManager.loadFile(data.fileId);
  return {
    success: true,
    fileId: data.fileId,
    midiData: result
  };
}

/**
 * Persist editor changes and invalidate the auto-assignment cache so
 * subsequent playbacks recompute device assignments.
 *
 * @param {Object} app
 * @param {{fileId:(string|number), midiData:Object}} data
 * @returns {Promise<{success:true}>}
 */
async function fileWrite(app, data) {
  await app.fileManager.saveFile(data.fileId, data.midiData);
  if (app.autoAssigner) {
    app.autoAssigner.invalidateCache(data.fileId);
  }
  return { success: true };
}

/**
 * Delete a file from disk + database; clears any cached auto-assignment.
 *
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function fileDelete(app, data) {
  await app.fileManager.deleteFile(data.fileId);
  if (app.autoAssigner) {
    app.autoAssigner.invalidateCache(data.fileId);
  }
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number), newFilename:string, midiData:Object}} data
 * @returns {Promise<Object>}
 */
async function fileSaveAs(app, data) {
  const result = await app.fileManager.saveFileAs(data.fileId, data.newFilename, data.midiData);
  return result;
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number), newFilename:string}} data
 * @returns {Promise<{success:true}>}
 */
async function fileRename(app, data) {
  await app.fileManager.renameFile(data.fileId, data.newFilename);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number), folder:string}} data
 * @returns {Promise<{success:true}>}
 */
async function fileMove(app, data) {
  await app.fileManager.moveFile(data.fileId, data.folder);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<Object>}
 */
async function fileDuplicate(app, data) {
  const result = await app.fileManager.duplicateFile(data.fileId);
  return result;
}

/**
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<Object>} Includes `data` (base64) + filename for download.
 */
async function fileExport(app, data) {
  const result = await app.fileManager.exportFile(data.fileId);
  return result;
}

/**
 * @param {Object} app
 * @param {{query:string}} data
 * @returns {Promise<{files: Object[]}>}
 */
async function fileSearch(app, data) {
  const files = app.fileRepository.search(data.query);
  return { files: files };
}

/**
 * Multi-criterion filter consumed by the FilterManager UI. Empty / null
 * values are dropped before query so the UI can pass null for inactive
 * filters without silently scoping the result. Connected device ids are
 * injected so the routing-status filter only counts live devices.
 *
 * @param {Object} app
 * @param {Object} data - Filter spec; see body for the supported keys.
 * @returns {Promise<{success:true, files:Object[], total:number, filters:string}>}
 */
async function fileFilter(app, data) {
  // Advanced filtering with multiple criteria
  const filters = {
    // Simple filters
    filename: data.filename,
    folder: data.folder,
    includeSubfolders: data.includeSubfolders,
    durationMin: data.durationMin,
    durationMax: data.durationMax,
    tempoMin: data.tempoMin,
    tempoMax: data.tempoMax,
    tracksMin: data.tracksMin,
    tracksMax: data.tracksMax,
    uploadedAfter: data.uploadedAfter,
    uploadedBefore: data.uploadedBefore,

    // Advanced filters
    instrumentTypes: data.instrumentTypes,
    instrumentMode: data.instrumentMode || 'ANY',
    channelCountMin: data.channelCountMin,
    channelCountMax: data.channelCountMax,
    hasRouting: data.hasRouting,
    isOriginal: data.isOriginal,
    minCompatibilityScore: data.minCompatibilityScore,

    // GM instrument filters
    gmInstruments: data.gmInstruments,
    gmCategories: data.gmCategories,
    gmPrograms: data.gmPrograms,
    gmMode: data.gmMode || 'ANY',

    // Routing status filter (supports single string or array of statuses)
    routingStatus: data.routingStatus,
    routingStatuses: data.routingStatuses,

    // Playable on instruments filter
    playableOnInstruments: data.playableOnInstruments,
    playableMode: data.playableOnInstruments?.length > 0 ? (data.playableMode || 'routed') : undefined,

    // Quick filters
    hasDrums: data.hasDrums,
    hasMelody: data.hasMelody,
    hasBass: data.hasBass,

    // Sorting and pagination
    sortBy: data.sortBy || 'uploaded_at',
    sortOrder: data.sortOrder || 'DESC',
    limit: (Number.isInteger(data.limit) && data.limit > 0) ? data.limit : undefined,
    offset: (Number.isInteger(data.offset) && data.offset >= 0) ? data.offset : undefined
  };

  // Inject connected device IDs for routing status accuracy
  try {
    const deviceList = app.deviceManager?.getDeviceList?.() || [];
    if (deviceList.length > 0) {
      filters.connectedDeviceIds = deviceList.map(d => d.id).filter(Boolean);
    }
  } catch (e) { /* skip device filtering */ }

  // Remove empty/null/undefined values (FilterManager sends null as default for inactive filters)
  Object.keys(filters).forEach(key => {
    const val = filters[key];
    if (val === undefined || val === null || val === '') {
      delete filters[key];
    } else if (Array.isArray(val) && val.length === 0) {
      delete filters[key];
    }
  });

  const rawFiles = app.fileRepository.filter(filters);

  // Batch-fetch routing status for all filtered files (same as FileManager.listFiles)
  const fileIds = rawFiles.map(f => f.id);
  const routingMap = app.fileManager._batchGetRoutingStatus(fileIds, rawFiles);

  // Normalize field names to match FileManager.listFiles() format (camelCase + formatted fields)
  const files = rawFiles.map(file => ({
    id: file.id,
    filename: file.filename,
    size: file.size,
    sizeFormatted: app.fileManager.formatFileSize(file.size),
    tracks: file.tracks,
    duration: file.duration,
    durationFormatted: app.fileManager.formatDuration(file.duration || 0),
    tempo: Math.round(file.tempo || 120),
    channelCount: file.channel_count || 0,
    uploadedAt: file.uploaded_at,
    folder: file.folder,
    is_original: file.is_original,
    routingStatus: routingMap.get(file.id) || 'unrouted',
    // Keep snake_case aliases for backward compatibility
    channel_count: file.channel_count || 0,
    uploaded_at: file.uploaded_at,
  }));

  // Build filter summary for response
  const appliedFilters = [];
  if (data.filename) appliedFilters.push(`filename: "${data.filename}"`);
  if (data.folder) appliedFilters.push(`folder: "${data.folder}"`);
  if (data.durationMin !== undefined || data.durationMax !== undefined) {
    appliedFilters.push(`duration: ${data.durationMin || 0}-${data.durationMax || '∞'}s`);
  }
  if (data.tempoMin !== undefined || data.tempoMax !== undefined) {
    appliedFilters.push(`tempo: ${data.tempoMin || 0}-${data.tempoMax || '∞'} BPM`);
  }
  if (data.channelCountMin !== undefined || data.channelCountMax !== undefined) {
    appliedFilters.push(`channels: ${data.channelCountMin || 0}-${data.channelCountMax || '∞'}`);
  }
  if (data.instrumentTypes && data.instrumentTypes.length > 0) {
    appliedFilters.push(`instruments: ${data.instrumentTypes.join(', ')} (${data.instrumentMode || 'ANY'})`);
  }
  if (data.gmInstruments && data.gmInstruments.length > 0) {
    appliedFilters.push(`GM instruments: ${data.gmInstruments.join(', ')} (${data.gmMode || 'ANY'})`);
  }
  if (data.gmCategories && data.gmCategories.length > 0) {
    appliedFilters.push(`GM categories: ${data.gmCategories.join(', ')} (${data.gmMode || 'ANY'})`);
  }
  if (data.routingStatus) {
    appliedFilters.push(`routing status: ${data.routingStatus}`);
  }
  if (data.routingStatuses && data.routingStatuses.length > 0) {
    appliedFilters.push(`routing statuses: ${data.routingStatuses.join(', ')}`);
  }
  if (data.playableOnInstruments && data.playableOnInstruments.length > 0) {
    appliedFilters.push(`playable on: ${data.playableOnInstruments.join(', ')} (${data.playableMode || 'routed'})`);
  }

  return {
    success: true,
    files: files,
    total: files.length,
    filters: appliedFilters.length > 0 ? appliedFilters.join('; ') : 'none'
  };
}

/**
 * List the analyzed channels for a file (channel number, GM program,
 * note range, density, etc.).
 *
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true, fileId:(string|number), channels:Object[], total:number}>}
 * @throws {ValidationError}
 */
async function fileChannels(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const channels = app.fileRepository.getChannels(data.fileId);
  return {
    success: true,
    fileId: data.fileId,
    channels: channels,
    total: channels.length
  };
}

/**
 * Re-run channel analysis over every file in the library. Long-running.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, analyzed:number, failed:number}>}
 */
async function fileReanalyzeAll(app) {
  const result = await app.fileManager.reanalyzeAllFiles();
  return {
    success: true,
    ...result
  };
}

/**
 * @param {Object} app
 * @returns {{success:true, needsReanalysis:number}}
 */
function fileReanalyzeCheck(app) {
  const count = app.fileRepository.countNeedingReanalysis();
  return {
    success: true,
    needsReanalysis: count
  };
}

/**
 * Compute current routing playability status for one file. Restricted to
 * live devices so disconnected hardware does not inflate the count.
 *
 * @param {Object} app
 * @param {{fileId:(string|number)}} data
 * @returns {Promise<{success:true, fileId:(string|number)}>}
 * @throws {ValidationError|NotFoundError}
 */
async function fileRoutingStatus(app, data) {
  const fileId = data.fileId;
  if (!fileId) throw new ValidationError('fileId is required', 'fileId');

  // Connected devices restrict the routing count (only routings to live
  // devices are considered "playable").
  let connectedDeviceIds = null;
  try {
    const deviceList = app.deviceManager?.getDeviceList?.() || [];
    if (deviceList.length > 0) {
      connectedDeviceIds = new Set(deviceList.map(d => d.id).filter(Boolean));
    }
  } catch (e) { /* skip filtering */ }

  const result = app.fileRoutingStatusService.computeForFile(fileId, connectedDeviceIds);
  if (!result) throw new NotFoundError('File', fileId);

  return { success: true, fileId, ...result };
}

/**
 * List the distinct GM instruments referenced anywhere in the library
 * (used to populate the FilterManager dropdown).
 *
 * @param {Object} app
 * @returns {Promise<{success:true, instruments:string[], total:number}>}
 */
async function midiInstrumentsList(app) {
  const instruments = app.fileRepository.getDistinctInstruments();
  return {
    success: true,
    instruments: instruments,
    total: instruments.length
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, categories:string[], total:number}>}
 */
async function midiCategoriesList(app) {
  const categories = app.fileRepository.getDistinctCategories();
  return {
    success: true,
    categories: categories,
    total: categories.length
  };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('file_upload', (data) => fileUpload(app, data));
  registry.register('file_list', (data) => fileList(app, data));
  registry.register('file_metadata', (data) => fileMetadata(app, data));
  registry.register('file_read', (data) => fileRead(app, data));
  registry.register('file_write', (data) => fileWrite(app, data));
  registry.register('file_delete', (data) => fileDelete(app, data));
  registry.register('file_save_as', (data) => fileSaveAs(app, data));
  registry.register('file_rename', (data) => fileRename(app, data));
  registry.register('file_move', (data) => fileMove(app, data));
  registry.register('file_duplicate', (data) => fileDuplicate(app, data));
  registry.register('file_export', (data) => fileExport(app, data));
  registry.register('file_search', (data) => fileSearch(app, data));
  registry.register('file_filter', (data) => fileFilter(app, data));
  registry.register('file_channels', (data) => fileChannels(app, data));
  registry.register('file_reanalyze_all', () => fileReanalyzeAll(app));
  registry.register('file_reanalyze_check', () => fileReanalyzeCheck(app));
  registry.register('file_routing_status', (data) => fileRoutingStatus(app, data));
  registry.register('midi_instruments_list', () => midiInstrumentsList(app));
  registry.register('midi_categories_list', () => midiCategoriesList(app));
}
