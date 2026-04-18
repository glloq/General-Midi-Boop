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
}
