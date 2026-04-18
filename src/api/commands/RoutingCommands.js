// src/api/commands/RoutingCommands.js
import { ValidationError, NotFoundError } from '../../core/errors/index.js';

async function routeCreate(app, data) {
  const routeId = app.midiRouter.addRoute(data);
  return { routeId: routeId };
}

async function routeDelete(app, data) {
  app.midiRouter.deleteRoute(data.routeId);
  return { success: true };
}

async function routeList(app) {
  return { routes: app.midiRouter.getRouteList() };
}

async function routeEnable(app, data) {
  app.midiRouter.enableRoute(data.routeId, data.enabled);
  return { success: true };
}

async function routeInfo(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }
  return { route: route };
}

async function filterSet(app, data) {
  app.midiRouter.setFilter(data.routeId, data.filter);
  return { success: true };
}

async function filterClear(app, data) {
  app.midiRouter.setFilter(data.routeId, {});
  return { success: true };
}

async function channelMap(app, data) {
  app.midiRouter.setChannelMap(data.routeId, data.mapping);
  return { success: true };
}

async function monitorStart(app, data) {
  app.midiRouter.startMonitor(data.deviceId);
  return { success: true };
}

async function monitorStop(app, data) {
  app.midiRouter.stopMonitor(data.deviceId);
  return { success: true };
}

async function monitorStartAll(app) {
  app.midiRouter.startMonitorAll();
  return { success: true };
}

async function monitorStopAll(app) {
  app.midiRouter.stopMonitorAll();
  return { success: true };
}

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

async function routeExport(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new NotFoundError('Route', data.routeId);
  }
  return { route: route };
}

async function routeImport(app, data) {
  const routeId = app.midiRouter.addRoute(data.route);
  return { routeId: routeId };
}

async function routeClearAll(app) {
  const routes = app.midiRouter.getRouteList();
  routes.forEach(route => app.midiRouter.deleteRoute(route.id));
  return { success: true, deleted: routes.length };
}

/**
 * Sync file routing config from frontend (localStorage) to the database.
 * This allows the routing status filter to work with manually configured routings.
 * @param {Object} data - { fileId, channels: { "0": "deviceId", "1": "deviceId", ... } }
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
 * Bulk sync all file routings from frontend localStorage to database.
 * Called once on page load to ensure DB has all manual routing data.
 * @param {Object} data - { routings: { fileId: { channels: {...} }, ... } }
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
