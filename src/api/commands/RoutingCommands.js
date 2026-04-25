/**
 * @file src/api/commands/RoutingCommands.js
 * @description WebSocket commands managing MIDI routes and the
 * file-channel routing index. Routes describe how MIDI flows from a
 * source (input device or playback file) to a destination device, with
 * optional channel remapping and filter rules.
 *
 * Registered commands:
 *   - `route_create`           — add a new route, returns its id
 *   - `route_delete`           — remove a route
 *   - `route_list`             — list every route
 *   - `route_enable`           — toggle on/off
 *   - `route_info`             — single route
 *   - `filter_set`             — replace filter object
 *   - `filter_clear`           — set filter to {}
 *   - `channel_map`            — replace channel mapping
 *   - `monitor_start`/_stop    — single-device monitoring
 *   - `monitor_start_all`/_all — global monitoring toggle
 *   - `route_test`             — short test note through a route
 *   - `route_duplicate`        — clone disabled
 *   - `route_export`/_import   — JSON round-trip
 *   - `route_clear_all`        — bulk delete
 *   - `file_routing_sync`      — sync per-file channel→device map
 *   - `file_routing_bulk_sync` — same, for multiple files at once
 *
 * Validation: see `routing.schemas.js` for the route_*, filter_*,
 * channel_map and monitor_* commands.
 */
import { ValidationError, NotFoundError } from '../../core/errors/index.js';
import InstrumentMatcher from '../../midi/adaptation/InstrumentMatcher.js';
import { parseMidi } from 'midi-file';

/**
 * @param {Object} app
 * @param {Object} data - Route definition (`source`, `destination`,
 *   optional `channelMap`, `filter`, `enabled`).
 * @returns {Promise<{routeId:(string|number)}>}
 */
async function routeCreate(app, data) {
  const routeId = app.midiRouter.addRoute(data);
  return { routeId: routeId };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function routeDelete(app, data) {
  app.midiRouter.deleteRoute(data.routeId);
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{routes:Object[]}>}
 */
async function routeList(app) {
  return { routes: app.midiRouter.getRouteList() };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number), enabled:boolean}} data
 * @returns {Promise<{success:true}>}
 */
async function routeEnable(app, data) {
  app.midiRouter.enableRoute(data.routeId, data.enabled);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number)}} data
 * @returns {Promise<{route:Object}>}
 * @throws {NotFoundError}
 */
async function routeInfo(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }
  return { route: route };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number), filter:Object}} data
 * @returns {Promise<{success:true}>}
 */
async function filterSet(app, data) {
  app.midiRouter.setFilter(data.routeId, data.filter);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function filterClear(app, data) {
  app.midiRouter.setFilter(data.routeId, {});
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number), mapping:Object}} data - `mapping`
 *   is an object keyed by source channel number.
 * @returns {Promise<{success:true}>}
 */
async function channelMap(app, data) {
  app.midiRouter.setChannelMap(data.routeId, data.mapping);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true}>}
 */
async function monitorStart(app, data) {
  app.midiRouter.startMonitor(data.deviceId);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true}>}
 */
async function monitorStop(app, data) {
  app.midiRouter.stopMonitor(data.deviceId);
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function monitorStartAll(app) {
  app.midiRouter.startMonitorAll();
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function monitorStopAll(app) {
  app.midiRouter.stopMonitorAll();
  return { success: true };
}

/**
 * Send a short test note through a route's destination device. Defaults
 * to middle C (note 60), velocity 80, channel 0, 300 ms duration.
 *
 * @param {Object} app
 * @param {{routeId:(string|number), channel?:number, note?:number,
 *   velocity?:number, duration?:number}} data
 * @returns {Promise<{success:boolean, destination?:string, note?:number,
 *   channel?:number, error?:string}>}
 * @throws {NotFoundError}
 */
async function routeTest(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }

  // Send a short test note (middle C, velocity 80, channel 0) through the route destination
  const channel = data.channel ?? 0;
  const note = data.note ?? 60;
  const velocity = data.velocity ?? 80;
  const duration = data.duration ?? 300;

  const sent = app.deviceManager.sendMessage(route.destination, 'noteon', {
    channel,
    note,
    velocity
  });

  if (!sent) {
    return { success: false, error: 'Failed to send test note to device' };
  }

  // Schedule note off after duration
  setTimeout(() => {
    app.deviceManager.sendMessage(route.destination, 'noteoff', {
      channel,
      note,
      velocity: 0
    });
  }, duration);

  return { success: true, destination: route.destination, note, channel };
}

/**
 * Clone a route disabled — the user can edit it before enabling.
 *
 * @param {Object} app
 * @param {{routeId:(string|number)}} data
 * @returns {Promise<{routeId:(string|number)}>}
 * @throws {NotFoundError}
 */
async function routeDuplicate(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }
  const newRouteId = app.midiRouter.addRoute({
    source: route.source,
    destination: route.destination,
    channelMap: route.channelMap,
    filter: route.filter,
    enabled: false
  });
  return { routeId: newRouteId };
}

/**
 * @param {Object} app
 * @param {{routeId:(string|number)}} data
 * @returns {Promise<{route:Object}>}
 * @throws {NotFoundError}
 */
async function routeExport(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }
  return { route: route };
}

/**
 * @param {Object} app
 * @param {{route:Object}} data
 * @returns {Promise<{routeId:(string|number)}>}
 */
async function routeImport(app, data) {
  const routeId = app.midiRouter.addRoute(data.route);
  return { routeId: routeId };
}

/**
 * Delete every route. Useful for "reset" workflows.
 *
 * @param {Object} app
 * @returns {Promise<{success:true, deleted:number}>}
 */
async function routeClearAll(app) {
  const routes = app.midiRouter.getRouteList();
  routes.forEach(route => app.midiRouter.deleteRoute(route.id));
  return { success: true, deleted: routes.length };
}

/**
 * Sync file routing config from frontend (localStorage) to the
 * database. The DB copy lets the routing-status filter find playable
 * files even when the user has not opened the editor.
 *
 * @param {Object} app
 * @param {{fileId:(string|number),
 *   channels:Object<string,string>}} data - `channels` maps channel
 *   index (as string) to a device id; an empty/missing object clears
 *   all routings for the file.
 * @returns {Promise<{success:true, synced:number, invalidDevices:string[],
 *   invalidChannels?:number[]}>}
 * @throws {ValidationError}
 */
async function fileRoutingSync(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  if (!data.channels || Object.keys(data.channels).length === 0) {
    app.routingRepository.deleteByFileId(data.fileId);
    return { success: true, synced: 0, invalidDevices: [] };
  }

  const result = app.fileRoutingSyncService.syncFile(data.fileId, data.channels);

  if (result.invalidDevices.length > 0) {
    app.logger.info(`[fileRoutingSync] Skipped invalid device(s): ${result.invalidDevices.join(', ')}`);
  }
  if (result.invalidChannels.length > 0) {
    app.logger.info(`[fileRoutingSync] Skipped channels not present in file: ${result.invalidChannels.join(', ')}`);
  }
  app.logger.info(`[fileRoutingSync] Synced ${result.synced} channels for file ${data.fileId}`);

  return { success: true, ...result };
}

/**
 * Bulk version of {@link fileRoutingSync}. Called once on page load so
 * the DB sees every manual routing the user kept in localStorage.
 *
 * @param {Object} app
 * @param {{routings:Object<string|number,{channels:Object<string,string>}>}} data
 * @returns {Promise<{success:true, synced:number, files:number,
 *   invalidDevices:string[]}>}
 */
async function fileRoutingBulkSync(app, data) {
  if (!data.routings || typeof data.routings !== 'object') {
    return { success: true, synced: 0, files: 0, invalidDevices: [] };
  }

  const result = app.fileRoutingSyncService.bulkSync(data.routings);

  if (result.invalidDevices.length > 0) {
    app.logger.info(
      `[fileRoutingBulkSync] Skipped ${result.invalidDevices.length} invalid device(s): ${result.invalidDevices.join(', ')}`
    );
  }
  app.logger.info(`[fileRoutingBulkSync] Synced ${result.synced} channels across ${result.files} files`);

  return { success: true, ...result };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
/**
 * Pre-validate the hand-position feasibility of routing one MIDI
 * channel to a given instrument *before* the operator commits the
 * routing. Returns the same `{level, summary, message}` shape the
 * apply path persists in `handPositionWarnings` (D.2) so the UI can
 * render an early-warning banner without waiting for an apply round-
 * trip. Pure read — never mutates state.
 *
 * @param {Object} app
 * @param {{fileId:(string|number), channel:number,
 *          deviceId:string, targetChannel?:number}} data
 * @returns {Promise<{level:string, summary:Object,
 *                    message:?string, qualityScore:number}>}
 * @throws {ValidationError|NotFoundError}
 */
async function validateRoutingFeasibility(app, data) {
  if (data.fileId === undefined || data.fileId === null) {
    throw new ValidationError('fileId is required', 'fileId');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  const channel = parseInt(data.channel, 10);
  if (!Number.isFinite(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }
  const targetChannel = data.targetChannel != null ? parseInt(data.targetChannel, 10) : channel;

  // Resolve the routed instrument's capabilities (carries hands_config,
  // scale_length when wired, etc.).
  let capabilities = null;
  if (app.instrumentRepository?.getCapabilities) {
    try {
      capabilities = app.instrumentRepository.getCapabilities(data.deviceId, targetChannel);
    } catch (_) { /* fall through to unknown */ }
  }
  if (!capabilities) {
    return {
      level: 'unknown',
      qualityScore: 0,
      summary: {},
      message: `No capabilities found for ${data.deviceId} ch ${targetChannel}`
    };
  }

  // Resolve the channel analysis. Prefer the adaptation service
  // (matches the apply path); load the file directly only when the
  // service can't run (e.g. test contexts without the full app).
  let analysis = null;
  if (app.adaptationService?.analyzeChannel) {
    let midiData = null;
    try {
      const file = app.fileRepository?.findById?.(data.fileId);
      if (file && app.blobStore?.read) {
        const buffer = app.blobStore.read(file.blob_path);
        midiData = parseMidi(buffer);
      }
    } catch (_) { /* surface unknown below */ }
    if (midiData) {
      try {
        analysis = app.adaptationService.analyzeChannel(midiData, channel, data.fileId);
      } catch (_) { /* surface unknown below */ }
    }
  }
  if (!analysis) {
    return {
      level: 'unknown',
      qualityScore: 0,
      summary: {},
      message: 'Could not analyze the channel — file or analyzer unavailable'
    };
  }

  const matcher = new InstrumentMatcher(app.logger);
  const r = matcher._scoreHandPositionFeasibility(analysis, capabilities);
  return {
    level: r.level,
    qualityScore: r.qualityScore,
    summary: r.summary || {},
    message: r.issue?.message || r.info || null
  };
}

/**
 * Persist hand-position overrides authored in the
 * RoutingSummaryPage HandsPreviewPanel onto a single routing row.
 * The payload is opaque JSON but must declare {hand_anchors,
 * disabled_notes, version} to be accepted; anything else is rejected
 * so a stale client can't store an unparseable shape that would trip
 * the future MidiPlayer consumer. Pass `overrides: null` to clear.
 *
 * @param {Object} app
 * @param {{fileId:(string|number), channel:number, deviceId:string,
 *          overrides:?(Object|null)}} data
 * @returns {Promise<{success:true, updated:number}>}
 * @throws {ValidationError}
 */
async function routingSaveHandOverrides(app, data) {
  if (data.fileId === undefined || data.fileId === null) {
    throw new ValidationError('fileId is required', 'fileId');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  const channel = parseInt(data.channel, 10);
  if (!Number.isFinite(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Shape gate. `null` clears the field; otherwise must be an object
  // with the documented top-level keys (extra keys are tolerated).
  const overrides = data.overrides;
  if (overrides !== null && overrides !== undefined) {
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new ValidationError('overrides must be an object or null', 'overrides');
    }
    if (!Array.isArray(overrides.hand_anchors) && !Array.isArray(overrides.disabled_notes)) {
      throw new ValidationError(
        'overrides must declare hand_anchors and/or disabled_notes arrays',
        'overrides'
      );
    }
    if (Array.isArray(overrides.hand_anchors)) {
      for (const a of overrides.hand_anchors) {
        if (!a || typeof a !== 'object'
            || !Number.isFinite(a.tick) || !Number.isFinite(a.anchor)
            || typeof a.handId !== 'string') {
          throw new ValidationError(
            'each hand_anchors entry must carry {tick, handId, anchor}',
            'overrides.hand_anchors'
          );
        }
      }
    }
    if (Array.isArray(overrides.disabled_notes)) {
      for (const n of overrides.disabled_notes) {
        if (!n || typeof n !== 'object'
            || !Number.isFinite(n.tick) || !Number.isFinite(n.note)) {
          throw new ValidationError(
            'each disabled_notes entry must carry {tick, note}',
            'overrides.disabled_notes'
          );
        }
      }
    }
  }

  if (!app.routingRepository?.saveHandOverrides) {
    throw new ValidationError('routing repository is not wired', 'routingRepository');
  }
  const updated = app.routingRepository.saveHandOverrides(
    data.fileId, channel, data.deviceId,
    overrides == null ? null : overrides
  );
  return { success: true, updated };
}

export function register(registry, app) {
  registry.register('route_create', (data) => routeCreate(app, data));
  registry.register('route_delete', (data) => routeDelete(app, data));
  registry.register('route_list', () => routeList(app));
  registry.register('route_enable', (data) => routeEnable(app, data));
  registry.register('route_info', (data) => routeInfo(app, data));
  registry.register('filter_set', (data) => filterSet(app, data));
  registry.register('filter_clear', (data) => filterClear(app, data));
  registry.register('channel_map', (data) => channelMap(app, data));
  registry.register('monitor_start', (data) => monitorStart(app, data));
  registry.register('monitor_stop', (data) => monitorStop(app, data));
  registry.register('monitor_start_all', () => monitorStartAll(app));
  registry.register('monitor_stop_all', () => monitorStopAll(app));
  registry.register('route_test', (data) => routeTest(app, data));
  registry.register('route_duplicate', (data) => routeDuplicate(app, data));
  registry.register('route_export', (data) => routeExport(app, data));
  registry.register('route_import', (data) => routeImport(app, data));
  registry.register('route_clear_all', () => routeClearAll(app));
  registry.register('file_routing_sync', (data) => fileRoutingSync(app, data));
  registry.register('file_routing_bulk_sync', (data) => fileRoutingBulkSync(app, data));
  registry.register('validate_routing_feasibility', (data) => validateRoutingFeasibility(app, data));
  registry.register('routing_save_hand_overrides', (data) => routingSaveHandOverrides(app, data));
}

// Exported for unit tests so a stub `app` can drive the helper without
// going through the registry (which requires the full DI bag).
export { validateRoutingFeasibility, routingSaveHandOverrides };
