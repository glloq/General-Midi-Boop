/**
 * @file src/midi/files/FileRoutingStatusService.js
 * @description Pure-function helper + DI-friendly service that compute
 * the routing playability status of a stored MIDI file (P1-4.2).
 *
 * Possible statuses:
 *   - `'unrouted'`          — zero routed channels.
 *   - `'partial'`           — some channels routed but `< channel_count`.
 *   - `'playable'`          — all channels routed AND every routing has
 *                             100% compatibility score (or no score data).
 *   - `'routed_incomplete'` — all channels routed but at least one
 *                             routing has < 100% compatibility.
 */

/**
 * Pure status calculator. No I/O — easy to unit-test in isolation.
 *
 * @param {{file:Object, routings:Object[],
 *   connectedDeviceIds?:?Set<string>}} params - When
 *   `connectedDeviceIds` is supplied, routings to disconnected devices
 *   are excluded so the status reflects what is *currently playable*.
 * @returns {{status:string, isAdapted:boolean, hasAutoAssigned:boolean,
 *   routedCount:number, channelCount:number}}
 */
export function computeRoutingStatus({ file, routings, connectedDeviceIds = null }) {
  const channelCount = file.channel_count || 1;

  const enabledRoutings = routings.filter((r) => {
    if (r.enabled === false) return false;
    if (connectedDeviceIds && !connectedDeviceIds.has(r.device_id)) return false;
    return true;
  });
  const routedCount = enabledRoutings.length;

  let status = 'unrouted';
  if (routedCount > 0 && routedCount < channelCount) {
    status = 'partial';
  } else if (routedCount >= channelCount && channelCount > 0) {
    const scores = enabledRoutings
      .map((r) => r.compatibility_score)
      .filter((s) => s !== null && s !== undefined);
    const minScore = scores.length > 0 ? Math.min(...scores) : null;
    status = (minScore === null || minScore === 100) ? 'playable' : 'routed_incomplete';
  }

  const hasAutoAssigned = enabledRoutings.some((r) => r.auto_assigned);
  const isAdapted = file.is_original === 0 || file.is_original === false;

  return {
    status,
    isAdapted,
    hasAutoAssigned,
    routedCount,
    channelCount
  };
}

export default class FileRoutingStatusService {
  /**
   * @param {object} deps
   * @param {object} deps.fileRepository
   * @param {object} deps.routingRepository
   */
  constructor(deps) {
    this.fileRepository = deps.fileRepository;
    this.routingRepository = deps.routingRepository;
  }

  /**
   * @param {string|number} fileId
   * @param {Set<string>|null} connectedDeviceIds
   * @returns {object|null} status payload, or null if file not found.
   */
  computeForFile(fileId, connectedDeviceIds = null) {
    const file = this.fileRepository.findInfoById(fileId);
    if (!file) return null;
    const routings = this.routingRepository.findByFileId(fileId);
    return computeRoutingStatus({ file, routings, connectedDeviceIds });
  }
}
