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
}
