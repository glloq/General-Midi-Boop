// src/api/commands/RoutingCommands.js

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
    throw new Error(`Route not found: ${data.routeId}`);
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

async function routeTest(app, data) {
  // Send test MIDI message through route
  return { success: true };
}

async function routeDuplicate(app, data) {
  const route = app.midiRouter.getRoute(data.routeId);
  if (!route) {
    throw new Error(`Route not found: ${data.routeId}`);
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
    throw new Error(`Route not found: ${data.routeId}`);
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
    throw new Error('fileId is required');
  }

  // Delete existing manual routings for this file
  app.database.deleteRoutingsByFile(data.fileId);

  if (!data.channels || Object.keys(data.channels).length === 0) {
    return { success: true, synced: 0 };
  }

  let synced = 0;
  for (const [channelStr, routingValue] of Object.entries(data.channels)) {
    const channel = parseInt(channelStr, 10);
    if (isNaN(channel) || !routingValue) continue;

    // routingValue may be "deviceId::targetChannel" for multi-instrument devices
    const parts = routingValue.split('::');
    const deviceId = parts[0];
    const targetChannel = parts.length > 1 ? parseInt(parts[1], 10) : channel;

    try {
      app.database.insertRouting({
        midi_file_id: data.fileId,
        channel: channel,
        target_channel: isNaN(targetChannel) ? channel : targetChannel,
        device_id: deviceId,
        instrument_name: null,
        compatibility_score: null,
        transposition_applied: 0,
        auto_assigned: false,
        assignment_reason: 'manual',
        note_remapping: null,
        enabled: true,
        created_at: Date.now()
      });
      synced++;
    } catch (error) {
      app.logger.warn(`[fileRoutingSync] Failed to sync channel ${channel}: ${error.message}`);
    }
  }

  app.logger.info(`[fileRoutingSync] Synced ${synced} channels for file ${data.fileId}`);
  return { success: true, synced };
}

/**
 * Bulk sync all file routings from frontend localStorage to database.
 * Called once on page load to ensure DB has all manual routing data.
 * @param {Object} data - { routings: { fileId: { channels: {...} }, ... } }
 */
async function fileRoutingBulkSync(app, data) {
  if (!data.routings || typeof data.routings !== 'object') {
    return { success: true, synced: 0, files: 0 };
  }

  let totalSynced = 0;
  let fileCount = 0;

  for (const [fileId, config] of Object.entries(data.routings)) {
    if (!config.channels || Object.keys(config.channels).length === 0) continue;

    // Delete existing routings for this file
    app.database.deleteRoutingsByFile(parseInt(fileId, 10));

    for (const [channelStr, deviceId] of Object.entries(config.channels)) {
      const channel = parseInt(channelStr, 10);
      if (isNaN(channel) || !deviceId) continue;

      try {
        app.database.insertRouting({
          midi_file_id: parseInt(fileId, 10),
          channel: channel,
          target_channel: channel,
          device_id: deviceId,
          instrument_name: null,
          compatibility_score: null,
          transposition_applied: 0,
          auto_assigned: false,
          assignment_reason: 'manual',
          note_remapping: null,
          enabled: true,
          created_at: config.lastModified || Date.now()
        });
        totalSynced++;
      } catch (error) {
        app.logger.warn(`[fileRoutingBulkSync] Failed channel ${channel} for file ${fileId}: ${error.message}`);
      }
    }
    fileCount++;
  }

  app.logger.info(`[fileRoutingBulkSync] Synced ${totalSynced} channels across ${fileCount} files`);
  return { success: true, synced: totalSynced, files: fileCount };
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
  registry.register('route_test', (data) => routeTest(app, data));
  registry.register('route_duplicate', (data) => routeDuplicate(app, data));
  registry.register('route_export', (data) => routeExport(app, data));
  registry.register('route_import', (data) => routeImport(app, data));
  registry.register('route_clear_all', () => routeClearAll(app));
  registry.register('file_routing_sync', (data) => fileRoutingSync(app, data));
  registry.register('file_routing_bulk_sync', (data) => fileRoutingBulkSync(app, data));
}
