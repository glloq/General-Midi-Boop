/**
 * @file src/repositories/RoutingRepository.js
 * @description Thin business-named wrapper over the routing methods on
 * {@link Database}/{@link RoutingPersistenceDB} (P0-2.2, ADR-002).
 * Decouples consumers from the wide DB surface and centralises the
 * `transaction()` entry point used for composite writes.
 */

export default class RoutingRepository {
  /** @param {Object} database - Application database facade. */
  constructor(database) {
    this.database = database;
  }

  /**
   * @param {Object} routing - Single routing row.
   * @returns {(string|number)} New row id.
   */
  save(routing) {
    return this.database.insertRouting(routing);
  }

  /**
   * Insert several segment rows for a single (file, channel) split
   * routing in one transaction.
   * @param {(string|number)} fileId
   * @param {number} channel
   * @param {Object[]} segments
   * @returns {void}
   */
  saveSplit(fileId, channel, segments) {
    return this.database.insertSplitRoutings(fileId, channel, segments);
  }

  /**
   * @param {(string|number)} fileId
   * @param {boolean} [includeDisabled=false]
   * @returns {Object[]}
   */
  findByFileId(fileId, includeDisabled = false) {
    return this.database.getRoutingsByFile(fileId, includeDisabled);
  }

  /**
   * Aggregate routing counts per file for the routing-status filter.
   * @param {(string|number)[]} fileIds
   * @param {?Set<string>} connectedDeviceIds - When provided, only
   *   routings to currently connected devices are counted.
   * @returns {Map<(string|number), number>}
   */
  countByFiles(fileIds, connectedDeviceIds) {
    return this.database.getRoutingCountsByFiles(fileIds, connectedDeviceIds);
  }

  /**
   * @param {(string|number)} fileId
   * @returns {void}
   */
  deleteByFileId(fileId) {
    return this.database.deleteRoutingsByFile(fileId);
  }

  /**
   * @param {string} deviceId
   * @param {?number} [channel]
   * @returns {void}
   */
  deleteByDevice(deviceId, channel) {
    return this.database.deleteRoutingsByDevice(deviceId, channel);
  }

  /**
   * Wrap a synchronous function in a SQLite transaction. Returns the
   * better-sqlite3 wrapper so callers can invoke it with their own
   * arguments (ADR-002 §Conventions — composite writes belong in the
   * Repository layer).
   *
   * @param {Function} fn
   * @returns {Function} The transaction-wrapped function.
   */
  transaction(fn) {
    return this.database.transaction(fn);
  }
}
