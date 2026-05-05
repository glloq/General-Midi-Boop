/**
 * @file src/repositories/DeviceRouteRepository.js
 * @description Thin business-named wrapper over the real-time device-to-device
 * routing methods on {@link Database} (ADR-002).
 *
 * Distinct from {@link RoutingRepository} which manages file-channel-to-device
 * playback routings. This repository exclusively covers the `routes` table used
 * by {@link MidiRouter} for live MIDI message forwarding.
 */
export default class DeviceRouteRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  /**
   * Load all routes from the database (used at startup to hydrate MidiRouter).
   * @returns {Object[]}
   */
  findAll() {
    return this.database.getRoutes();
  }

  /**
   * Insert a new real-time route.
   * @param {Object} route - `{id, source_device, destination_device, channel_mapping, filter, enabled}`.
   * @returns {string} The route id.
   */
  insert(route) {
    return this.database.insertRoute(route);
  }

  /**
   * Patch selected fields of an existing route.
   * @param {string} routeId
   * @param {Object} updates - Partial route fields to update.
   * @returns {void}
   */
  update(routeId, updates) {
    return this.database.updateRoute(routeId, updates);
  }

  /**
   * Delete a route by id.
   * @param {string} routeId
   * @returns {void}
   */
  delete(routeId) {
    return this.database.deleteRoute(routeId);
  }
}
