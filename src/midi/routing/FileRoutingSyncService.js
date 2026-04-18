/**
 * @file src/midi/routing/FileRoutingSyncService.js
 * @description Domain service for file-routing synchronisation (P1-4.1).
 *
 * Extracted from `RoutingCommands.fileRoutingSync /
 * fileRoutingBulkSync`. The service is intentionally
 * **transport-agnostic** — it knows nothing about WebSocket, the
 * command registry, or the request/response envelope. It depends only
 * on the repositories and an optional `knownDevices` filter that the
 * command handler builds from the live DeviceManager snapshot.
 */

/**
 * Plan a single channel sync. Returns one of three actions:
 *
 *   - `'skip'`         — invalid input (NaN channel or empty routing).
 *   - `'skip-channel'` — channel not present in the file (orphan).
 *   - `'skip-device'`  — destination device is not connected and is
 *                        not the magic `'virtual-instrument'` value.
 *   - `'insert'`       — return a fully-populated routing payload that
 *                        preserves legacy auto-assign metadata when the
 *                        target device is unchanged.
 *
 * Pure function — no side effects, easy to unit-test in isolation.
 *
 * @param {Object} params
 * @param {(string|number)} params.fileId
 * @param {number} params.channel
 * @param {string} params.routingValue - `"deviceId"` or
 *   `"deviceId::targetChannel"`.
 * @param {Map<number, Object>} params.existingByChannel
 * @param {?Set<string>} [params.knownDevices]
 * @param {?Set<number>} [params.knownChannels]
 * @param {number} [params.now=Date.now()]
 * @returns {{action:string, reason?:string, channel?:number,
 *   deviceId?:string, routing?:Object}}
 */
export function planChannelRouting({
  fileId,
  channel,
  routingValue,
  existingByChannel,
  knownDevices,
  knownChannels,
  now = Date.now()
}) {
  if (Number.isNaN(channel) || !routingValue) {
    return { action: 'skip', reason: 'invalid-input' };
  }

  if (knownChannels && knownChannels.size > 0 && !knownChannels.has(channel)) {
    return { action: 'skip-channel', channel };
  }

  const parts = routingValue.split('::');
  const deviceId = parts[0];
  const targetChannel = parts.length > 1 ? parseInt(parts[1], 10) : channel;

  if (
    knownDevices && knownDevices.size > 0 &&
    !knownDevices.has(deviceId) &&
    deviceId !== 'virtual-instrument'
  ) {
    return { action: 'skip-device', deviceId };
  }

  const existing = existingByChannel.get(channel);
  const sameDevice = !!existing && existing.device_id === deviceId;

  return {
    action: 'insert',
    routing: {
      midi_file_id: fileId,
      channel,
      target_channel: Number.isNaN(targetChannel) ? channel : targetChannel,
      device_id: deviceId,
      instrument_name: sameDevice ? existing.instrument_name : null,
      compatibility_score: sameDevice ? existing.compatibility_score : null,
      transposition_applied: sameDevice ? (existing.transposition_applied ?? 0) : 0,
      auto_assigned: sameDevice ? existing.auto_assigned : false,
      assignment_reason: sameDevice ? existing.assignment_reason : 'manual',
      note_remapping: sameDevice && existing.note_remapping
        ? JSON.stringify(existing.note_remapping)
        : null,
      enabled: true,
      created_at: now
    }
  };
}

export default class FileRoutingSyncService {
  /**
   * @param {object} deps
   * @param {object} deps.routingRepository
   * @param {object} deps.fileRepository
   * @param {object} [deps.deviceManager] - source of `getDeviceList()`
   * @param {object} [deps.logger]
   */
  constructor(deps) {
    this.routingRepository = deps.routingRepository;
    this.fileRepository = deps.fileRepository;
    this.deviceManager = deps.deviceManager;
    this.logger = deps.logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  /**
   * @returns {Set<string>} Snapshot of every connected device id; used
   *   as a filter when deciding which routings to keep.
   * @private
   */
  _knownDevices() {
    const set = new Set();
    try {
      const list = this.deviceManager?.getDeviceList?.() || [];
      for (const d of list) if (d.id) set.add(d.id);
    } catch { /* ignore */ }
    return set;
  }

  /**
   * @param {(string|number)} fileId
   * @returns {Set<number>} Channels actually present in the file —
   *   used to drop routings for channels that don't exist in the data.
   * @private
   */
  _knownChannels(fileId) {
    const set = new Set();
    try {
      const channels = this.fileRepository.getChannels(fileId) || [];
      for (const c of channels) if (c.channel != null) set.add(c.channel);
    } catch { /* ignore */ }
    return set;
  }

  /**
   * Sync a single file's channel-to-device map. Replaces all
   * non-split routings for the file (split routings are managed by
   * the auto-assigner and intentionally preserved).
   *
   * Pre: `channels` is non-empty — the caller handles the "clear"
   * case via `routingRepository.deleteByFileId`.
   *
   * @param {(string|number)} fileId
   * @param {Object<string, string>} channels - channel index → routing
   *   value (`"deviceId"` or `"deviceId::targetChannel"`).
   * @returns {{synced:number, invalidDevices:string[],
   *   invalidChannels:number[]}}
   */
  syncFile(fileId, channels) {
    const existingRoutings = this.routingRepository.findByFileId(fileId, true);
    const existingByChannel = new Map();
    for (const r of existingRoutings) {
      if (r.channel != null && !r.split_mode) {
        existingByChannel.set(r.channel, r);
      }
    }

    // Replace non-split routings, preserve splits managed by auto-assign.
    this.routingRepository.deleteByFileId(fileId);

    const knownDevices = this._knownDevices();
    const knownChannels = this._knownChannels(fileId);

    let synced = 0;
    const invalidDeviceIds = new Set();
    const invalidChannels = new Set();
    const now = Date.now();

    for (const [channelStr, routingValue] of Object.entries(channels)) {
      const channel = parseInt(channelStr, 10);
      const plan = planChannelRouting({
        fileId,
        channel,
        routingValue,
        existingByChannel,
        knownDevices,
        knownChannels,
        now
      });

      if (plan.action === 'skip') continue;
      if (plan.action === 'skip-channel') {
        invalidChannels.add(plan.channel);
        continue;
      }
      if (plan.action === 'skip-device') {
        invalidDeviceIds.add(plan.deviceId);
        continue;
      }

      try {
        this.routingRepository.save(plan.routing);
        synced++;
      } catch (error) {
        this.logger.warn(`[fileRoutingSync] Failed to sync channel ${channel}: ${error.message}`);
      }
    }

    return {
      synced,
      invalidDevices: [...invalidDeviceIds],
      invalidChannels: [...invalidChannels]
    };
  }

  /**
   * Bulk variant of {@link FileRoutingSyncService#syncFile}. Same
   * per-file logic but with aggregated counters and one-shot device
   * snapshot. Channel-existence check is intentionally skipped here
   * to preserve legacy bulk-sync behaviour.
   *
   * @param {Object<string, {channels:Object<string,string>,
   *   lastModified?:number}>} routingsByFile
   * @returns {{synced:number, files:number, invalidDevices:string[]}}
   */
  bulkSync(routingsByFile) {
    let totalSynced = 0;
    let fileCount = 0;
    const invalidDeviceIds = new Set();
    const knownDevices = this._knownDevices();

    for (const [fileIdStr, config] of Object.entries(routingsByFile)) {
      if (!config.channels || Object.keys(config.channels).length === 0) continue;

      const parsedFileId = parseInt(fileIdStr, 10);
      const existingRoutings = this.routingRepository.findByFileId(parsedFileId, true);
      const existingByChannel = new Map();
      for (const r of existingRoutings) {
        if (r.channel != null && !r.split_mode) {
          existingByChannel.set(r.channel, r);
        }
      }

      this.routingRepository.deleteByFileId(parsedFileId);

      let hasValidRouting = false;
      const now = config.lastModified || Date.now();

      for (const [channelStr, routingValue] of Object.entries(config.channels)) {
        const channel = parseInt(channelStr, 10);
        const plan = planChannelRouting({
          fileId: parsedFileId,
          channel,
          routingValue,
          existingByChannel,
          knownDevices,
          knownChannels: null, // bulk sync skips channel-existence check (legacy behaviour)
          now
        });

        if (plan.action === 'skip') continue;
        if (plan.action === 'skip-channel') continue;
        if (plan.action === 'skip-device') {
          invalidDeviceIds.add(plan.deviceId);
          continue;
        }

        try {
          this.routingRepository.save(plan.routing);
          totalSynced++;
          hasValidRouting = true;
        } catch (error) {
          this.logger.warn(
            `[fileRoutingBulkSync] Failed channel ${channel} for file ${fileIdStr}: ${error.message}`
          );
        }
      }
      if (hasValidRouting) fileCount++;
    }

    return {
      synced: totalSynced,
      files: fileCount,
      invalidDevices: [...invalidDeviceIds]
    };
  }
}
