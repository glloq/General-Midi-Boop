// src/api/commands/FileCommands.js

async function fileUpload(app, data) {
  const result = await app.fileManager.handleUpload(data.filename, data.data);
  return result;
}

async function fileList(app, data) {
  const files = app.fileManager.listFiles(data.folder || '/');
  return { files: files };
}

async function fileMetadata(app, data) {
  const metadata = await app.fileManager.getFileMetadata(data.fileId);
  return { success: true, metadata: metadata };
}

async function fileLoad(app, data) {
  const result = await app.fileManager.loadFile(data.fileId);
  return result;
}

async function fileRead(app, data) {
  // Read MIDI file content for editing
  const result = await app.fileManager.loadFile(data.fileId);
  return {
    success: true,
    fileId: data.fileId,
    midiData: result
  };
}

async function fileWrite(app, data) {
  // Write MIDI file content from editor
  await app.fileManager.saveFile(data.fileId, data.midiData);
  // Invalidate auto-assignment cache for this file
  if (app.autoAssigner) {
    app.autoAssigner.invalidateCache(data.fileId);
  }
  return { success: true };
}

async function fileDelete(app, data) {
  await app.fileManager.deleteFile(data.fileId);
  // Invalidate auto-assignment cache for this file
  if (app.autoAssigner) {
    app.autoAssigner.invalidateCache(data.fileId);
  }
  return { success: true };
}

async function fileSave(app, data) {
  await app.fileManager.saveFile(data.fileId, data.midi);
  return { success: true };
}

async function fileSaveAs(app, data) {
  const result = await app.fileManager.saveFileAs(data.fileId, data.newFilename, data.midiData);
  return result;
}

async function fileRename(app, data) {
  await app.fileManager.renameFile(data.fileId, data.newFilename);
  return { success: true };
}

async function fileMove(app, data) {
  await app.fileManager.moveFile(data.fileId, data.folder);
  return { success: true };
}

async function fileDuplicate(app, data) {
  const result = await app.fileManager.duplicateFile(data.fileId);
  return result;
}

async function fileExport(app, data) {
  const result = await app.fileManager.exportFile(data.fileId);
  return result;
}

async function fileSearch(app, data) {
  const files = app.database.searchFiles(data.query);
  return { files: files };
}

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

  // Remove empty/null/undefined values (FilterManager sends null as default for inactive filters)
  Object.keys(filters).forEach(key => {
    const val = filters[key];
    if (val === undefined || val === null || val === '') {
      delete filters[key];
    } else if (Array.isArray(val) && val.length === 0) {
      delete filters[key];
    }
  });

  const files = app.database.filterFiles(filters);

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

async function fileChannels(app, data) {
  if (!data.fileId) {
    throw new Error('fileId is required');
  }

  const channels = app.database.getFileChannels(data.fileId);
  return {
    success: true,
    fileId: data.fileId,
    channels: channels,
    total: channels.length
  };
}

async function fileReanalyzeAll(app) {
  const result = await app.fileManager.reanalyzeAllFiles();
  return {
    success: true,
    ...result
  };
}

function fileReanalyzeCheck(app) {
  const count = app.database.countFilesNeedingReanalysis();
  return {
    success: true,
    needsReanalysis: count
  };
}

async function fileRoutingStatus(app, data) {
  const fileId = data.fileId;
  if (!fileId) throw new Error('fileId is required');

  const file = app.database.getFile(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  const routings = app.database.getRoutingsByFile(fileId);
  const channelCount = file.channel_count || file.tracks || 1;
  const enabledRoutings = routings.filter(r => r.enabled !== false);
  const routedCount = enabledRoutings.length;

  let status = 'unrouted';
  if (routedCount > 0 && routedCount < channelCount) {
    status = 'partial';
  } else if (routedCount >= channelCount && channelCount > 0) {
    const minScore = Math.min(...enabledRoutings.map(r => r.compatibility_score ?? 0));
    status = minScore === 100 ? 'playable' : 'routed_incomplete';
  }

  const hasAutoAssigned = enabledRoutings.some(r => r.auto_assigned);
  const isAdapted = file.is_original === 0 || file.is_original === false;

  return { success: true, fileId, status, isAdapted, hasAutoAssigned, routedCount, channelCount };
}

async function midiInstrumentsList(app) {
  const instruments = app.database.getDistinctInstruments();
  return {
    success: true,
    instruments: instruments,
    total: instruments.length
  };
}

async function midiCategoriesList(app) {
  const categories = app.database.getDistinctCategories();
  return {
    success: true,
    categories: categories,
    total: categories.length
  };
}

export function register(registry, app) {
  registry.register('file_upload', (data) => fileUpload(app, data));
  registry.register('file_list', (data) => fileList(app, data));
  registry.register('file_metadata', (data) => fileMetadata(app, data));
  registry.register('file_load', (data) => fileLoad(app, data));
  registry.register('file_read', (data) => fileRead(app, data));
  registry.register('file_write', (data) => fileWrite(app, data));
  registry.register('file_delete', (data) => fileDelete(app, data));
  registry.register('file_save', (data) => fileSave(app, data));
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
