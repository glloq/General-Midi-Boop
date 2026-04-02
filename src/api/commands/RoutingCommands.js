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

  // Delete existing manual routings for this file
  app.database.deleteRoutingsByFile(data.fileId);

  if (!data.channels || Object.keys(data.channels).length === 0) {
    return { success: true, synced: 0, invalidDevices: [] };
  }

  // Build set of known device IDs for validation
  const knownDevices = new Set();
  try {
    const deviceList = app.deviceManager?.getDeviceList?.() || [];
    for (const d of deviceList) {
      if (d.id) knownDevices.add(d.id);
    }
  } catch (e) { /* ignore — skip validation if device list unavailable */ }

  let synced = 0;
  const invalidDeviceIds = new Set();

  for (const [channelStr, routingValue] of Object.entries(data.channels)) {
    const channel = parseInt(channelStr, 10);
    if (isNaN(channel) || !routingValue) continue;

    // routingValue may be "deviceId::targetChannel" for multi-instrument devices
    const parts = routingValue.split('::');
    const deviceId = parts[0];
    const targetChannel = parts.length > 1 ? parseInt(parts[1], 10) : channel;

    // Skip routings to devices that don't exist
    if (knownDevices.size > 0 && !knownDevices.has(deviceId)) {
      invalidDeviceIds.add(deviceId);
      continue;
    }

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

  if (invalidDeviceIds.size > 0) {
    app.logger.info(`[fileRoutingSync] Skipped invalid device(s): ${[...invalidDeviceIds].join(', ')}`);
  }
  app.logger.info(`[fileRoutingSync] Synced ${synced} channels for file ${data.fileId}`);
  return { success: true, synced, invalidDevices: [...invalidDeviceIds] };
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

  let totalSynced = 0;
  let fileCount = 0;
  const invalidDeviceIds = new Set();

  // Build set of known device IDs for validation
  const knownDevices = new Set();
  try {
    const deviceList = app.deviceManager?.getDeviceList?.() || [];
    for (const d of deviceList) {
      if (d.id) knownDevices.add(d.id);
    }
  } catch (e) {
    app.logger.warn(`[fileRoutingBulkSync] Could not get device list: ${e.message}`);
  }

  for (const [fileId, config] of Object.entries(data.routings)) {
    if (!config.channels || Object.keys(config.channels).length === 0) continue;

    // Delete existing routings for this file
    app.database.deleteRoutingsByFile(parseInt(fileId, 10));

    let hasValidRouting = false;
    for (const [channelStr, routingValue] of Object.entries(config.channels)) {
      const channel = parseInt(channelStr, 10);
      if (isNaN(channel) || !routingValue) continue;

      // Extract deviceId (may be "deviceId::targetChannel")
      const deviceId = routingValue.split('::')[0];

      // Skip routings to devices that don't exist (unless we couldn't get device list)
      if (knownDevices.size > 0 && !knownDevices.has(deviceId)) {
        invalidDeviceIds.add(deviceId);
        continue;
      }

      try {
        const parts = routingValue.split('::');
        const targetChannel = parts.length > 1 ? parseInt(parts[1], 10) : channel;

        app.database.insertRouting({
          midi_file_id: parseInt(fileId, 10),
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
          created_at: config.lastModified || Date.now()
        });
        totalSynced++;
        hasValidRouting = true;
      } catch (error) {
        app.logger.warn(`[fileRoutingBulkSync] Failed channel ${channel} for file ${fileId}: ${error.message}`);
      }
    }
    if (hasValidRouting) fileCount++;
  }

  if (invalidDeviceIds.size > 0) {
    app.logger.info(`[fileRoutingBulkSync] Skipped ${invalidDeviceIds.size} invalid device(s): ${[...invalidDeviceIds].join(', ')}`);
  }
  app.logger.info(`[fileRoutingBulkSync] Synced ${totalSynced} channels across ${fileCount} files`);
  return { success: true, synced: totalSynced, files: fileCount, invalidDevices: [...invalidDeviceIds] };
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
