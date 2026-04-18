// src/midi/domain/routing/FileRoutingSyncService.js
// Domain service for file-routing synchronisation (P1-4.1).
//
// Extracted from RoutingCommands.fileRoutingSync / fileRoutingBulkSync.
// The service is **transport-agnostic** : it does not know about WS, the
// command registry or the request/response envelope. It depends on the
// repositories and an optional `knownDevices` set.

/**
 * Plan a single channel sync : decide whether to skip (orphan / invalid
 * device) or to insert, and build the routing payload preserving the
 * legacy auto-assign metadata when the device hasn't changed.
 *
 * Pure function — no side effects, easily testable.
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

  _knownDevices() {
    const set = new Set();
    try {
      const list = this.deviceManager?.getDeviceList?.() || [];
      for (const d of list) if (d.id) set.add(d.id);
    } catch { /* ignore */ }
    return set;
  }

  _knownChannels(fileId) {
    const set = new Set();
    try {
      const channels = this.fileRepository.getChannels(fileId) || [];
      for (const c of channels) if (c.channel != null) set.add(c.channel);
    } catch { /* ignore */ }
    return set;
  }

  /**
   * Sync a single file's channel-to-device map.
   * Pre : channels is non-empty (caller handles the "clear" case).
   * Returns { synced, invalidDevices, invalidChannels }.
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
   * Bulk variant : same logic per file, aggregated counters.
   * Returns { synced, files, invalidDevices }.
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
