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
 * @param {?Set<number>} [params.splitChannels] - channels currently
 *   routed via an auto-assign-managed split; the simple sync must not
 *   overwrite them.
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
  splitChannels,
  now = Date.now()
}) {
  if (Number.isNaN(channel) || !routingValue) {
    return { action: 'skip', reason: 'invalid-input' };
  }

  // A split routing for this channel is owned by the auto-assigner /
  // routing modal. The editor's simple channel→device sync covers every
  // channel it knows (including split ones), so without this guard a
  // single channel edit in the editor would replace the split with a
  // plain routing and silently destroy the split segments + their
  // hand-position overrides.
  if (splitChannels && splitChannels.has(channel)) {
    return { action: 'skip-split', channel };
  }

  if (knownChannels && knownChannels.size > 0 && !knownChannels.has(channel)) {
    return { action: 'skip-channel', channel };
  }

  const parts = routingValue.split('::');
  const deviceId = parts[0];
  const targetChannel = parts.length > 1 ? parseInt(parts[1], 10) : channel;

  const deviceOffline =
    knownDevices &&
    knownDevices.size > 0 &&
    !knownDevices.has(deviceId) &&
    deviceId !== 'virtual-instrument';

  const existing = existingByChannel.get(channel);
  const sameDevice = !!existing && existing.device_id === deviceId;

  const routing = {
    midi_file_id: fileId,
    channel,
    target_channel: Number.isNaN(targetChannel) ? channel : targetChannel,
    device_id: deviceId,
    instrument_name: sameDevice ? existing.instrument_name : null,
    compatibility_score: sameDevice ? existing.compatibility_score : null,
    transposition_applied: sameDevice ? (existing.transposition_applied ?? 0) : 0,
    auto_assigned: sameDevice ? existing.auto_assigned : false,
    assignment_reason: sameDevice ? existing.assignment_reason : 'manual',
    note_remapping:
      sameDevice && existing.note_remapping ? JSON.stringify(existing.note_remapping) : null,
    // Hand-position plan is bound to the physical instrument. Keep it
    // when the device is unchanged (the editor re-syncs the WHOLE
    // channel map on any single edit, so dropping it here would wipe
    // hand overrides for every hand-edited channel on an unrelated
    // change). Clear it when the device changes — the previous
    // instrument's hand mechanics no longer apply.
    hand_position_overrides:
      sameDevice && existing.hand_position_overrides ? existing.hand_position_overrides : null,
    hand_position_feasibility:
      sameDevice && existing.hand_position_feasibility ? existing.hand_position_feasibility : null,
    // Persist DISABLED when the destination device is offline right now, so a
    // transient dropout doesn't destroy the routing — it re-enables on the next
    // sync once the device is back (audit P2-3).
    enabled: !deviceOffline,
    created_at: now
  };

  // `skip-device` is retained for the caller's invalid-device reporting, but it
  // now also carries the disabled routing so the caller can persist (not drop) it.
  return deviceOffline
    ? { action: 'skip-device', deviceId, routing }
    : { action: 'insert', routing };
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
    } catch {
      /* ignore */
    }
    return set;
  }

  /**
   * @param {(string|number)} fileId
   * @param {Object[]} [existingRoutings] - rows already fetched by the
   *   caller, unioned into the result.
   * @returns {Set<number>} Channels considered valid for the file: those
   *   present in the parsed metadata UNION those that already carry a
   *   routing. The union matters because file metadata (`getChannels`)
   *   can lag behind the actual sequence (adapted files, parser
   *   differences); without it, re-syncing would silently drop a channel
   *   that the user had legitimately routed. Genuinely bogus channels
   *   (no metadata AND no prior routing) are still rejected.
   * @private
   */
  _knownChannels(fileId, existingRoutings) {
    const set = new Set();
    try {
      const channels = this.fileRepository.getChannels(fileId) || [];
      for (const c of channels) if (c.channel != null) set.add(c.channel);
    } catch {
      /* ignore */
    }
    if (Array.isArray(existingRoutings)) {
      for (const r of existingRoutings) if (r && r.channel != null) set.add(r.channel);
    }
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
    const splitChannels = new Set();
    for (const r of existingRoutings) {
      if (r.channel == null) continue;
      if (r.split_mode) {
        splitChannels.add(r.channel);
      } else {
        existingByChannel.set(r.channel, r);
      }
    }

    // Replace non-split routings only; auto-assign-managed splits (and
    // their hand-position overrides) survive the editor's simple sync.
    this.routingRepository.deleteNonSplitByFileId(fileId);

    const knownDevices = this._knownDevices();
    const knownChannels = this._knownChannels(fileId, existingRoutings);

    let synced = 0;
    let splitPreserved = 0;
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
        splitChannels,
        now
      });

      if (plan.action === 'skip') continue;
      if (plan.action === 'skip-split') {
        splitPreserved++;
        continue;
      }
      if (plan.action === 'skip-channel') {
        invalidChannels.add(plan.channel);
        continue;
      }
      if (plan.action === 'skip-device') {
        invalidDeviceIds.add(plan.deviceId);
        // Preserve the routing DISABLED instead of dropping it (audit P2-3).
        if (plan.routing) {
          try {
            this.routingRepository.save(plan.routing);
          } catch (error) {
            this.logger.warn(
              `[fileRoutingSync] Failed to persist disabled channel ${channel}: ${error.message}`
            );
          }
        }
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
      splitPreserved,
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
      const splitChannels = new Set();
      for (const r of existingRoutings) {
        if (r.channel == null) continue;
        if (r.split_mode) {
          splitChannels.add(r.channel);
        } else {
          existingByChannel.set(r.channel, r);
        }
      }

      this.routingRepository.deleteNonSplitByFileId(parsedFileId);

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
          splitChannels,
          now
        });

        if (plan.action === 'skip') continue;
        if (plan.action === 'skip-split') continue;
        if (plan.action === 'skip-channel') continue;
        if (plan.action === 'skip-device') {
          invalidDeviceIds.add(plan.deviceId);
          // Preserve the routing DISABLED instead of dropping it (audit P2-3).
          if (plan.routing) {
            try {
              this.routingRepository.save(plan.routing);
            } catch (error) {
              this.logger.warn(
                `[fileRoutingBulkSync] Failed to persist disabled channel ${channel} for file ${fileIdStr}: ${error.message}`
              );
            }
          }
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
