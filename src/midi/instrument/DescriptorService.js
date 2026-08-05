/**
 * @file src/midi/instrument/DescriptorService.js
 * @description Applies a parsed v2 capability descriptor (docs/SYSEX_IDENTITY.md
 * §7 steps 6-10) to an instrument's stored capabilities. This is the
 * orchestration "brain" of the descriptor pipeline: it validates, maps each
 * declared instrument onto the capability store, honours the per-instrument
 * `configured` flag, and computes the §6 override-purge decisions and the §9
 * lookahead.
 *
 * It is transport-agnostic: it takes an already-parsed descriptor object
 * (however it was obtained — block 0x10 transfer or the HTTP flag) and a
 * repository, so it can be unit-tested with a mock repository. Wiring the
 * fetch + the persisted `instance_id → config` / override state is the
 * remaining integration step.
 */

import {
  validateDescriptor,
  diffOverrides,
  descriptorToCapabilities,
  descriptorToStringConfig,
  descriptorLookaheadMs
} from './DescriptorProtocol.js';

export class DescriptorService {
  /**
   * @param {Object} deps
   * @param {Object} deps.instrumentRepository - must expose
   *   `updateCapabilities(deviceId, channel, fields)`.
   * @param {Object} [deps.eventBus]
   * @param {Object} [deps.logger]
   */
  constructor({ instrumentRepository, stringInstrumentRepository, eventBus, logger } = {}) {
    this._repo = instrumentRepository;
    this._stringRepo = stringInstrumentRepository ?? null;
    this._eventBus = eventBus ?? null;
    this._logger = logger ?? { info() {}, warn() {}, debug() {} };
    // Spec value is 'descriptor'; kept 'auto' until the instruments_latency
    // capabilities_source CHECK is widened (docs/SYSEX_IDENTITY.md §12).
    this._source = 'auto';
  }

  /**
   * Validate and apply `descriptor` to `deviceId`'s per-channel capabilities.
   *
   * @param {string} deviceId
   * @param {Object} descriptor - parsed descriptor (§5)
   * @param {Object} [opts]
   * @param {?Object} [opts.previousDescriptor] - the last applied descriptor, for the §6 diff
   * @param {Object<number,string[]>} [opts.overriddenFieldsByChannel] - user-overridden leaf fields per channel
   * @returns {{applied:boolean, errors?:string[], instruments:Array, lookaheadMs?:number}}
   */
  applyDescriptor(deviceId, descriptor, opts = {}) {
    const { previousDescriptor = null, overriddenFieldsByChannel = {} } = opts;

    const { valid, errors } = validateDescriptor(descriptor);
    if (!valid) {
      this._logger.warn(
        `Descriptor for ${deviceId} rejected (fell back to level 0): ${errors.join('; ')}`
      );
      return { applied: false, errors, instruments: [] };
    }

    const prevByChannel = new Map();
    if (previousDescriptor && Array.isArray(previousDescriptor.instruments)) {
      for (const p of previousDescriptor.instruments) {
        if (p && Number.isInteger(p.channel)) prevByChannel.set(p.channel, p);
      }
    }

    const instruments = [];
    let appliedCount = 0;
    for (const inst of descriptor.instruments) {
      // §5.1: an unconfigured instrument exists but is not defined — hand back
      // to manual entry without overwriting anything.
      if (inst.configured === false) {
        instruments.push({ channel: inst.channel, configured: false, applied: false });
        continue;
      }
      const fields = descriptorToCapabilities(inst, this._source);
      const overridden = overriddenFieldsByChannel[inst.channel] || [];
      const { purge, keep } = diffOverrides(
        prevByChannel.get(inst.channel) ?? null,
        inst,
        overridden
      );
      try {
        this._repo.updateCapabilities(deviceId, inst.channel, fields);
        appliedCount += 1;
      } catch (e) {
        this._logger.warn(
          `Failed to apply descriptor capabilities for ${deviceId}:${inst.channel}: ${e.message}`
        );
        instruments.push({ channel: inst.channel, applied: false, error: e.message });
        continue;
      }

      // Strings family (§5.9): also apply the physical geometry as a PARTIAL
      // update, so user-set fields the descriptor omits (scale length, bow CCs…)
      // are preserved rather than reset to defaults by a full upsert.
      const stringConfigApplied = this._applyStringConfig(deviceId, inst);

      instruments.push({
        channel: inst.channel,
        applied: true,
        purgedOverrides: purge,
        keptOverrides: keep,
        ...(stringConfigApplied !== undefined ? { stringConfigApplied } : {})
      });
    }

    const lookaheadMs = descriptorLookaheadMs(descriptor);
    this._eventBus?.emit('instruments_configured', {
      deviceId,
      count: appliedCount,
      lookaheadMs,
      source: 'descriptor'
    });

    return { applied: true, instruments, lookaheadMs };
  }

  /**
   * Upsert the string-instrument geometry for a `strings`-family instrument.
   * Partial update on an existing row (preserving fields the descriptor omits),
   * create for a new one. Returns undefined when not applicable (no string repo,
   * not a strings instrument, or nothing to map), else true/false on success.
   *
   * @param {string} deviceId
   * @param {Object} inst - descriptor instrument
   * @returns {(boolean|undefined)}
   * @private
   */
  _applyStringConfig(deviceId, inst) {
    if (!this._stringRepo || !inst.physical || inst.physical.family !== 'strings') return undefined;
    const cfg = descriptorToStringConfig(inst.physical);
    if (!cfg) return undefined;
    try {
      const existing = this._stringRepo.findByDeviceChannel(deviceId, inst.channel);
      if (existing) this._stringRepo.update(existing.id, cfg);
      else this._stringRepo.save({ device_id: deviceId, channel: inst.channel, ...cfg });
      return true;
    } catch (e) {
      this._logger.warn(
        `Failed to apply string config for ${deviceId}:${inst.channel}: ${e.message}`
      );
      return false;
    }
  }
}

export default DescriptorService;
