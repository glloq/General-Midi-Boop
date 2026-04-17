// src/midi/domain/devices/DeviceReconciliationService.js
// Domain service for matching a hardware device to its persisted instrument
// settings, with USB-serial / MAC / normalized-name fallbacks (P1-4.2).
//
// Extracted from DeviceCommands.deviceList. The reconcile rule is :
//   1. lookup by current device.id
//   2. if not found, try device.usbSerialNumber → reconcile + re-lookup
//   3. if still not found and bluetooth, try MAC → reconcile + re-lookup
//   4. if still not found and usb, try normalized name → reconcile + re-lookup

export default class DeviceReconciliationService {
  /**
   * @param {object} deps
   * @param {object} deps.instrumentRepository
   * @param {object} [deps.logger]
   */
  constructor(deps) {
    this.instrumentRepository = deps.instrumentRepository;
    this.logger = deps.logger || { info: () => {}, warn: () => {} };
  }

  /**
   * Resolve the instrument settings row for `device`, applying reconciliation
   * if a different device_id matches by serial / MAC / normalized name.
   * @param {{ id: string, usbSerialNumber?: string, address?: string, type?: string }} device
   * @returns {object|null} settings row or null when nothing matches.
   */
  resolveSettings(device) {
    let settings = this._safe(() => this.instrumentRepository.getAllSettings(device.id));
    if (settings) return settings;

    if (device.usbSerialNumber) {
      const bySerial = this._safe(() => this.instrumentRepository.findByUsbSerial(device.usbSerialNumber));
      if (bySerial && bySerial.device_id !== device.id) {
        this.logger.info(
          `[DeviceReconciliation] USB device "${device.id}" matched by serial "${device.usbSerialNumber}" to DB entry "${bySerial.device_id}" - reconciling`
        );
        this._safe(() => this.instrumentRepository.reconcileDeviceId(bySerial.device_id, device.id));
        settings = this._safe(() => this.instrumentRepository.getAllSettings(device.id));
        if (settings) return settings;
      }
    }

    if (device.address && device.type === 'bluetooth') {
      const byMac = this._safe(() => this.instrumentRepository.findByMac(device.address));
      if (byMac && byMac.device_id !== device.id) {
        this.logger.info(
          `[DeviceReconciliation] Bluetooth device "${device.id}" matched by MAC "${device.address}" to DB entry "${byMac.device_id}" - reconciling`
        );
        this._safe(() => this.instrumentRepository.reconcileDeviceId(byMac.device_id, device.id));
        settings = this._safe(() => this.instrumentRepository.getAllSettings(device.id));
        if (settings) return settings;
      }
    }

    if (device.type === 'usb') {
      const byName = this._safe(() => this.instrumentRepository.findByNormalizedName(device.id));
      if (byName && byName.device_id !== device.id) {
        this.logger.info(
          `[DeviceReconciliation] USB device "${device.id}" matched by normalized name to DB entry "${byName.device_id}" - reconciling`
        );
        this._safe(() => this.instrumentRepository.reconcileDeviceId(byName.device_id, device.id));
        settings = this._safe(() => this.instrumentRepository.getAllSettings(device.id));
        if (settings) return settings;
      }
    }

    return null;
  }

  _safe(fn) {
    try {
      return fn();
    } catch (e) {
      this.logger.warn(`[DeviceReconciliation] ${e.message}`);
      return null;
    }
  }
}
