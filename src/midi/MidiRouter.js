/**
 * @file src/midi/MidiRouter.js
 * @description Real-time MIDI routing engine. Owns the route table,
 * dispatches incoming messages to their destinations after applying
 * filter and channel-mapping rules, and applies *relative* latency
 * compensation so a single source feeding several destinations stays
 * synchronised at the listener's ear.
 *
 * Indexes:
 *   - `routes`            — `Map<routeId, route>` for direct lookup.
 *   - `routesBySource`    — secondary `Map<source, Set<routeId>>` so the
 *     hot path is O(routes-from-this-source) rather than O(total-routes).
 *
 * Compensation strategy: real-time routing cannot send messages "in the
 * past", so the slowest destination sends immediately and faster
 * destinations are delayed by `(slowest - this)` ms. The per-device
 * compensation lookup is memoised in a 30-second cache that is also
 * invalidated on the `instrument_settings_changed` event.
 *
 * Events:
 *   - emits `midi_routed` after each successful send.
 *   - subscribes to `instrument_settings_changed` to refresh the
 *     compensation cache.
 */
import { TIMING } from '../constants.js';

/** Hard ceiling on per-message compensation; logged + clamped above this. */
const MAX_COMPENSATION_MS = TIMING.MAX_COMPENSATION_MS;

/**
 * Stateful router. One instance per process; registered in the DI
 * container as `midiRouter`.
 */
class MidiRouter {
  /**
   * @param {Object} deps - DI bag (or Application facade). Must expose
   *   `logger`, `database`, `eventBus`. `deviceManager`,
   *   `latencyCompensator`, and `wsServer` are resolved lazily through
   *   `_deps` because they are constructed after the router itself.
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
    // Lazy-resolved deps (deviceManager, latencyCompensator, wsServer).
    this._deps = deps;
    /** @type {Map<string, Object>} routeId → route record. */
    this.routes = new Map();
    /** @type {Map<string, Set<string>>} sourceId → set of routeIds. */
    this.routesBySource = new Map();
    /** @type {Set<string>} Per-device monitor subscriptions. */
    this.monitors = new Set();
    /** Global "monitor every device" flag (debug console). */
    this.monitorAll = false;
    /** @type {Set<NodeJS.Timeout>} Pending compensation timers. */
    this.pendingTimeouts = new Set();
    /**
     * Compensation cache `(deviceId[_channel]) → ms`. Refreshed every
     * 30 s and invalidated on `instrument_settings_changed`.
     * @type {Map<string, number>}
     */
    this._compensationCache = new Map();
    this._compensationCacheTimer = setInterval(() => {
      this._compensationCache.clear();
    }, 30000);

    this._onSettingsChanged = () => {
      this._compensationCache.clear();
    };
    this.eventBus?.on('instrument_settings_changed', this._onSettingsChanged);

    this.loadRoutesFromDB();
    this.logger.info('MidiRouter initialized');
  }

  /**
   * Re-hydrate the in-memory route table from the database. Errors on
   * individual rows are logged but do not abort the load.
   *
   * @returns {void}
   */
  loadRoutesFromDB() {
    try {
      const routes = this.database.getRoutes();
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
          this.logger.error(`Failed to load route ${route.id}: ${routeError.message}`);
        }
      });
      this.logger.info(`Loaded ${loadedCount}/${routes.length} routes from database`);
    } catch (error) {
      this.logger.error(`Failed to load routes: ${error.message}`);
    }
  }

  /**
   * Insert a route in memory and (for new routes) persist it to the
   * database. If the DB insert fails, the in-memory state is rolled
   * back so the two views stay consistent.
   *
   * @param {Object} route - `{id?, source, destination, channelMap?,
   *   filter?, enabled?}`. When `id` is missing one is generated.
   * @returns {string} The route id.
   * @throws Re-throws DB errors after rollback.
   */
  addRoute(route) {
    const routeId = route.id || this.generateRouteId();

    const routeObj = {
      id: routeId,
      source: route.source,
      destination: route.destination,
      channelMap: route.channelMap || {},
      filter: route.filter || {},
      enabled: route.enabled !== false
    };
    this.routes.set(routeId, routeObj);

    // Update source index
    if (!this.routesBySource.has(routeObj.source)) {
      this.routesBySource.set(routeObj.source, new Set());
    }
    this.routesBySource.get(routeObj.source).add(routeId);

    // Save to database if new route
    if (!route.id) {
      try {
        this.database.insertRoute({
          id: routeId,
          source_device: route.source,
          destination_device: route.destination,
          channel_mapping: JSON.stringify(route.channelMap || {}),
          filter: JSON.stringify(route.filter || {}),
          enabled: route.enabled !== false ? 1 : 0
        });
      } catch (dbError) {
        // Rollback in-memory route if DB insert fails
        this.routes.delete(routeId);
        const sourceRoutes = this.routesBySource.get(routeObj.source);
        if (sourceRoutes) {
          sourceRoutes.delete(routeId);
          if (sourceRoutes.size === 0) this.routesBySource.delete(routeObj.source);
        }
        throw dbError;
      }
    }

    this.logger.info(`Route added: ${routeId} (${route.source} → ${route.destination})`);
    return routeId;
  }

  /**
   * Delete a route from both database and in-memory indexes.
   * DB deletion happens first so a DB failure leaves both views
   * consistent (the route still exists in memory).
   *
   * @param {string} routeId
   * @returns {void}
   * @throws {Error} When the route does not exist.
   */
  deleteRoute(routeId) {
    if (!this.routes.has(routeId)) {
      throw new Error(`Route not found: ${routeId}`);
    }

    const route = this.routes.get(routeId);

    this.database.deleteRoute(routeId);

    // Remove from source index
    const sourceSet = this.routesBySource.get(route.source);
    if (sourceSet) {
      sourceSet.delete(routeId);
      if (sourceSet.size === 0) {
        this.routesBySource.delete(route.source);
      }
    }

    this.routes.delete(routeId);
    this.logger.info(`Route deleted: ${routeId}`);
  }

  /**
   * @param {string} routeId
   * @param {boolean} enabled
   * @returns {void}
   * @throws {Error}
   */
  enableRoute(routeId, enabled) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.enabled = enabled;
    this.database.updateRoute(routeId, { enabled: enabled ? 1 : 0 });
    this.logger.info(`Route ${routeId} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * @param {string} routeId
   * @param {Object} filter - Filter spec; see {@link MidiRouter#passesFilter}.
   * @returns {void}
   * @throws {Error}
   */
  setFilter(routeId, filter) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.filter = filter;
    this.database.updateRoute(routeId, {
      filter: JSON.stringify(filter)
    });
    this.logger.info(`Filter updated for route ${routeId}`);
  }

/**
   * @param {string} routeId
   * @param {Object<string|number, number>} channelMap - source → dest channel.
   * @returns {void}
   * @throws {Error}
   */
  setChannelMap(routeId, channelMap) {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`Route not found: ${routeId}`);
    }

    route.channelMap = channelMap;
    this.database.updateRoute(routeId, {
      channel_mapping: JSON.stringify(channelMap)
    });
    this.logger.info(`Channel map updated for route ${routeId}`);
  }

  /**
   * Hot path: dispatch a single MIDI message from `sourceDevice` to
   * every enabled route registered against that source. Applies filter,
   * channel map, then either sends immediately or schedules a
   * compensation-delayed send. Emits `midi_routed` on each successful
   * send and broadcasts a `monitor_event` when monitoring is active.
   *
   * @param {string} sourceDevice - Originating device id.
   * @param {string} type - MIDI message type (`noteon`, `cc`, etc.).
   * @param {Object} msg - Parsed MIDI message payload.
   * @returns {void}
   */
  routeMessage(sourceDevice, type, msg) {
    // Source index keeps the hot path O(routes-for-this-source).
    const routeIds = this.routesBySource.get(sourceDevice);
    if (routeIds) {
      for (const routeId of routeIds) {
        const route = this.routes.get(routeId);
        if (!route || !route.enabled) {
          continue;
        }

        // Apply filter
        if (!this.passesFilter(type, msg, route.filter)) {
          continue;
        }

        // Apply channel mapping
        const mapped = this.applyChannelMap(msg, route.channelMap);

        // Apply relative latency compensation: fast devices are delayed so all destinations sync
        const compensation = this._getRelativeCompensation(sourceDevice, route.destination, mapped.channel);
        if (compensation > 0) {
          const timeoutId = setTimeout(() => {
            this.pendingTimeouts.delete(timeoutId);
            // Skip if route was deleted/disabled while waiting
            const currentRoute = this.routes.get(route.id);
            if (!currentRoute || !currentRoute.enabled) return;

            const success = this._deps.deviceManager.sendMessage(
              route.destination,
              type,
              mapped
            );
            if (success) {
              this.eventBus.emit('midi_routed', {
                route: route.id,
                source: sourceDevice,
                destination: route.destination,
                type: type,
                data: mapped
              });
            }
          }, compensation);
          this.pendingTimeouts.add(timeoutId);
          continue;
        }

        // Send immediately (no compensation needed)
        const success = this._deps.deviceManager.sendMessage(
          route.destination,
          type,
          mapped
        );

        if (success) {
          this.eventBus.emit('midi_routed', {
            route: route.id,
            source: sourceDevice,
            destination: route.destination,
            type: type,
            data: mapped
          });
        }
      }
    }

    // Handle monitors (per-device or global debug monitor)
    if (this.monitorAll || this.monitors.has(sourceDevice)) {
      this.broadcastMonitorEvent(sourceDevice, type, msg);
    }
  }

  /**
   * Apply a route filter to a message.
   *
   * Supported filter keys:
   *   - `types: string[]`      — message types to allow.
   *   - `channels: number[]`   — MIDI channels (0-15) to allow.
   *   - `noteRange: {min, max}` — applied to noteon/noteoff.
   *   - `velocityRange: {min,max}` — applied to noteon.
   *   - `ccNumbers: number[]`  — applied to cc messages.
   *
   * @param {string} type
   * @param {Object} msg
   * @param {?Object} filter
   * @returns {boolean} True when the message should be forwarded.
   */
  passesFilter(type, msg, filter) {
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

  /**
   * Remap the message's channel according to `mapping`. Out-of-range
   * targets fall back to the original channel — invalid mappings never
   * silently drop the message.
   *
   * @param {Object} msg
   * @param {Object<string|number, number>} mapping
   * @returns {Object} A copy of `msg` with the channel possibly rewritten.
   */
  applyChannelMap(msg, mapping) {
    if (!mapping || Object.keys(mapping).length === 0) {
      return msg;
    }

    const mapped = { ...msg };

    // Map channel if specified, clamping to valid MIDI range (0-15)
    if (msg.channel !== undefined && mapping[msg.channel] !== undefined) {
      const targetCh = parseInt(mapping[msg.channel]);
      mapped.channel = (isNaN(targetCh) || targetCh < 0 || targetCh > 15) ? msg.channel : targetCh;
    }

    return mapped;
  }

  /**
   * @param {string} deviceId
   * @returns {void}
   */
  startMonitor(deviceId) {
    this.monitors.add(deviceId);
    this.logger.info(`Monitor started for device: ${deviceId}`);
  }

  /**
   * @param {string} deviceId
   * @returns {void}
   */
  stopMonitor(deviceId) {
    this.monitors.delete(deviceId);
    this.logger.info(`Monitor stopped for device: ${deviceId}`);
  }

  /**
   * Enable global monitoring (every device's traffic is broadcast).
   * Used by the debug console.
   *
   * @returns {void}
   */
  startMonitorAll() {
    this.monitorAll = true;
    this.logger.info('Monitor ALL devices started (debug console)');
  }

  /** @returns {void} */
  stopMonitorAll() {
    this.monitorAll = false;
    this.logger.info('Monitor ALL devices stopped (debug console)');
  }

  /**
   * Send a `monitor_event` WebSocket broadcast for a single MIDI
   * message. Tries to attach a friendly `instrumentName` from the DB
   * but never blocks the hot path on the lookup.
   *
   * @param {string} deviceId
   * @param {string} type
   * @param {Object} msg
   * @returns {void}
   */
  broadcastMonitorEvent(deviceId, type, msg) {
    if (this._deps.wsServer) {
      // Resolve instrument name from database
      let instrumentName = null;
      if (this.database && msg && msg.channel !== undefined) {
        try {
          const settings = this.database.getInstrumentSettings(deviceId, msg.channel);
          if (settings) instrumentName = settings.custom_name || settings.name;
        } catch (e) { /* instrument name lookup is optional for monitor events */ }
      }
      this._deps.wsServer.broadcast('monitor_event', {
        device: deviceId,
        instrumentName: instrumentName,
        type: type,
        data: msg,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Get latency compensation offset for a destination device + channel (in ms).
   * In real-time routing, we cannot send events "earlier", so instead we compute
   * the relative delay needed: fastest device gets max delay, slowest gets 0.
   * This is cached per routing session and refreshed when routes change.
   * @param {string} deviceId - Destination device
   * @param {number} channel - MIDI channel
   * @returns {number} Compensation delay in milliseconds (0 = send immediately)
   */
  _getRouteCompensation(deviceId, channel) {
    // Only apply compensation if latencyCompensator or database are available
    if (!this._deps.latencyCompensator && !this.database) {
      return 0;
    }

    const cacheKey = channel !== undefined ? `${deviceId}_${channel}` : deviceId;
    if (this._compensationCache.has(cacheKey)) {
      return this._compensationCache.get(cacheKey);
    }

    let totalLatency = 0;

    // Hardware latency from LatencyCompensator
    if (this._deps.latencyCompensator) {
      totalLatency += this._deps.latencyCompensator.getLatency(deviceId) || 0;
    }

    // User-configured sync_delay from database
    if (this.database) {
      try {
        const settings = this.database.getInstrumentSettings(deviceId, channel);
        if (settings && settings.sync_delay !== undefined && settings.sync_delay !== null) {
          totalLatency += settings.sync_delay;
        }
      } catch (e) {
        // Ignore DB errors in hot path
      }
    }

    // For real-time routing, negative compensation = this device is faster
    // We store the raw value; the caller decides how to use it
    // (In routeMessage, we only delay if compensation > 0)
    const clamped = Math.min(Math.max(0, totalLatency), MAX_COMPENSATION_MS);
    if (totalLatency > MAX_COMPENSATION_MS) {
      this.logger.warn(`Compensation ${totalLatency.toFixed(0)}ms for device ${deviceId} exceeds max ${MAX_COMPENSATION_MS}ms, clamping`);
    }
    this._compensationCache.set(cacheKey, clamped);
    return clamped;
  }

  /**
   * Get relative compensation for a destination in the context of all destinations
   * from the same source. The slowest device (highest latency) sends immediately;
   * faster devices are delayed so all events arrive at the same time.
   * @param {string} sourceDevice - Source device
   * @param {string} destDevice - Destination device
   * @param {number} channel - MIDI channel
   * @returns {number} Relative delay in milliseconds (0 = send immediately)
   */
  _getRelativeCompensation(sourceDevice, destDevice, channel) {
    const routeIds = this.routesBySource.get(sourceDevice);
    if (!routeIds || routeIds.size <= 1) {
      // Single destination — no relative delay needed
      return 0;
    }

    // Find maximum compensation across all active destinations for this source
    let maxComp = 0;
    for (const rid of routeIds) {
      const r = this.routes.get(rid);
      if (!r || !r.enabled) continue;
      const comp = this._getRouteCompensation(r.destination, channel);
      if (comp > maxComp) maxComp = comp;
    }

    const thisComp = this._getRouteCompensation(destDevice, channel);
    // Fast device (low latency) gets delayed; slow device (high latency) sends immediately
    return Math.max(0, maxComp - thisComp);
  }

  /** @returns {Object[]} Snapshot of every registered route. */
  getRouteList() {
    return Array.from(this.routes.values());
  }

  /**
   * @param {string} routeId
   * @returns {?Object}
   */
  getRoute(routeId) {
    return this.routes.get(routeId);
  }

  /**
   * @returns {string} A new unique route id (`"route_<ts>_<rand>"`).
   *   Not cryptographically random — collisions inside a single second
   *   are practically impossible for human-driven workflows.
   */
  generateRouteId() {
    return `route_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Cancel every pending compensation timer, drop the cache + cache
   * timer, detach the EventBus subscription, and clear the route /
   * monitor maps. Must be called during application shutdown to avoid
   * leaks across restarts.
   *
   * @returns {void}
   */
  destroy() {
    // Clear all pending message timeouts
    for (const timeoutId of this.pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    this.pendingTimeouts.clear();

    // Clear compensation cache timer
    if (this._compensationCacheTimer) {
      clearInterval(this._compensationCacheTimer);
      this._compensationCacheTimer = null;
    }
    if (this._compensationCache) {
      this._compensationCache.clear();
    }

    // Remove event listeners (use stored reference for proper cleanup)
    if (this._onSettingsChanged) {
      this.eventBus?.off('instrument_settings_changed', this._onSettingsChanged);
    }

    this.routes.clear();
    this.routesBySource.clear();
    this.monitors.clear();
    this.logger.info('MidiRouter destroyed');
  }
}

export default MidiRouter;