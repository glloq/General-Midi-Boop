// src/midi/MidiRouter.js

class MidiRouter {
  constructor(app) {
    this.app = app;
    this.routes = new Map();
    this.monitors = new Set();
    
    this.loadRoutesFromDB();
    this.app.logger.info('MidiRouter initialized');
  }

  loadRoutesFromDB() {
    try {
      const routes = this.app.database.getRoutes();
      let loadedCount = 0;
      routes.forEach(route => {
        try {
          this.addRoute({
            id: route.id,
            source: route.source_device,
            destination: route.destination_device,
            channelMap: JSON.parse(route.channel_mapping || '{}'),
            filter: JSON.parse(route.filter || '{}'),
            enabled: route.enabled === 1
          });
          loadedCount++;
        } catch (routeError) {
          this.app.logger.error(`Failed to load route ${route.id}: ${routeError.message}`);
        }
      });
      this.app.logger.info(`Loaded ${loadedCount}/${routes.length} routes from database`);
    } catch (error) {
      this.app.logger.error(`Failed to load routes: ${error.message}`);
    }
  }

  addRoute(route) {
    const routeId = route.id || this.generateRouteId();
    
    this.routes.set(routeId, {
      id: routeId,
      source: route.source,
      destination: route.destination,
      channelMap: route.channelMap || {},
      filter: route.filter || {},
      enabled: route.enabled !== false
    });

    // Save to database if new route
    if (!route.id) {
      this.app.database.insertRoute({
        id: routeId,
        source_device: route.source,
        destination_device: route.destination,
        channel_mapping: JSON.stringify(route.channelMap || {}),
        filter: JSON.stringify(route.filter || {}),
        enabled: route.enabled !== false ? 1 : 0
      });
    }

    this.app.logger.info(`Route added: ${routeId} (${route.source} → ${route.destination})`);
    return routeId;
  }

  deleteRoute(routeId) {
    if (!this.routes.has(routeId)) {
      throw new Error(`Route not found: ${routeId}`);
    }

    this.routes.delete(routeId);
    this.app.database.deleteRoute(routeId);
    this.app.logger.info(`Route deleted: ${routeId}`);
  }

  enableRoute(routeId, enabled) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.enabled = enabled;
    this.app.database.updateRoute(routeId, { enabled: enabled ? 1 : 0 });
    this.app.logger.info(`Route ${routeId} ${enabled ? 'enabled' : 'disabled'}`);
  }

  setFilter(routeId, filter) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.filter = filter;
    this.app.database.updateRoute(routeId, {
      filter: JSON.stringify(filter)
    });
    this.app.logger.info(`Filter updated for route ${routeId}`);
  }

  setChannelMap(routeId, channelMap) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.channelMap = channelMap;
    this.app.database.updateRoute(routeId, {
      channel_mapping: JSON.stringify(channelMap)
    });
    this.app.logger.info(`Channel map updated for route ${routeId}`);
  }

  routeMessage(sourceDevice, type, msg) {
    this.routes.forEach(route => {
      if (!route.enabled || route.source !== sourceDevice) {
        return;
      }

      // Apply filter
      if (!this.passesFilter(type, msg, route.filter)) {
        return;
      }

      // Apply channel mapping
      const mapped = this.applyChannelMap(msg, route.channelMap);

      // Send to destination
      const success = this.app.deviceManager.sendMessage(
        route.destination,
        type,
        mapped
      );

      if (success) {
        this.app.eventBus.emit('midi_routed', {
          route: route.id,
          source: sourceDevice,
          destination: route.destination,
          type: type,
          data: mapped
        });
      }
    });

    // Handle monitors
    if (this.monitors.has(sourceDevice)) {
      this.broadcastMonitorEvent(sourceDevice, type, msg);
    }
  }

  passesFilter(type, msg, filter) {
    // No filter = pass all
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }

    // Filter by message type
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(type)) {
        return false;
      }
    }

    // Filter by channel
    if (filter.channels && filter.channels.length > 0) {
      if (msg.channel !== undefined && !filter.channels.includes(msg.channel)) {
        return false;
      }
    }

    // Filter by note range (for noteon/noteoff)
    if (filter.noteRange) {
      if (type === 'noteon' || type === 'noteoff') {
        const note = msg.note;
        if (note < filter.noteRange.min || note > filter.noteRange.max) {
          return false;
        }
      }
    }

    // Filter by velocity range (for noteon)
    if (filter.velocityRange) {
      if (type === 'noteon') {
        const velocity = msg.velocity;
        if (velocity < filter.velocityRange.min || velocity > filter.velocityRange.max) {
          return false;
        }
      }
    }

    // Filter by CC number
    if (filter.ccNumbers && type === 'cc') {
      if (!filter.ccNumbers.includes(msg.controller)) {
        return false;
      }
    }

    return true;
  }

  applyChannelMap(msg, mapping) {
    if (!mapping || Object.keys(mapping).length === 0) {
      return msg;
    }

    const mapped = { ...msg };

    // Map channel if specified
    if (msg.channel !== undefined && mapping[msg.channel] !== undefined) {
      mapped.channel = mapping[msg.channel];
    }

    return mapped;
  }

  startMonitor(deviceId) {
    this.monitors.add(deviceId);
    this.app.logger.info(`Monitor started for device: ${deviceId}`);
  }

  stopMonitor(deviceId) {
    this.monitors.delete(deviceId);
    this.app.logger.info(`Monitor stopped for device: ${deviceId}`);
  }

  broadcastMonitorEvent(deviceId, type, msg) {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('monitor_event', {
        device: deviceId,
        type: type,
        data: msg,
        timestamp: Date.now()
      });
    }
  }

  getRouteList() {
    return Array.from(this.routes.values());
  }

  getRoute(routeId) {
    return this.routes.get(routeId);
  }

  generateRouteId() {
    return `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default MidiRouter;