/**
 * @file src/midi/DeviceDiscovery.js
 * @description Hardware discovery helper extracted from DeviceManager.
 * Owns the cross-platform plumbing for:
 *   - Listing MIDI ports via `easymidi`.
 *   - Polling for hot-plug events at a fixed interval (Linux/macOS lack
 *     a userspace MIDI inotify so polling is the simplest reliable path).
 *   - Reading USB serial numbers from `/sys/bus/usb/...` so persisted
 *     configurations survive port re-enumeration.
 *   - Filtering out system loopback ports (`Midi Through`, `Through`)
 *     so they don't pollute the user-visible device list.
 *
 * Calls back into DeviceManager via the callbacks installed by
 * {@link DeviceDiscovery#setChangeCallbacks}.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Wait between port close and reopen so kernel buffers can drain. */
const PORT_RELEASE_DELAY_MS = 250;

class DeviceDiscovery {
  /**
   * @param {Object} app - Application context (logger, wsServer, etc.)
   * @param {Object} easymidi - The easymidi module (or stub)
   * @param {boolean} midiAvailable - Whether native MIDI is available
   */
  constructor(app, easymidi, midiAvailable) {
    this.app = app;
    this.easymidi = easymidi;
    this.midiAvailable = midiAvailable;

    // Hot-plug detection
    this.hotPlugInterval = null;
    this.hotPlugCheckIntervalMs = 5000; // Check every 5 seconds
    this.knownInputs = new Set();
    this.knownOutputs = new Set();
    this.hotPlugFailures = 0;
  }

  /**
   * Scan for MIDI devices. Closes existing connections, re-enumerates,
   * and returns the new inputs/outputs.
   * @param {Map} inputs - Current input map (will be cleared)
   * @param {Map} outputs - Current output map (will be cleared)
   * @param {Function} addInput - Callback to add an input by name
   * @param {Function} addOutput - Callback to add an output by name
   * @returns {Promise<void>}
   */
  async scanAndReopen(inputs, outputs, addInput, addOutput) {
    if (!this.midiAvailable) {
      this.app.logger.warn('MIDI scan skipped: native MIDI library not available');
      return;
    }

    // Close all existing connections first to ensure clean state
    this.app.logger.info('Closing existing MIDI connections...');

    // Close inputs with error handling
    const inputsToClose = Array.from(inputs.entries());
    for (const [name, input] of inputsToClose) {
      try {
        input.removeAllListeners();
        input.close();
        this.app.logger.info(`✓ Closed input: ${name}`);
      } catch (error) {
        this.app.logger.warn(`Failed to close input ${name}: ${error.message}`);
      }
    }

    // Close outputs with error handling
    const outputsToClose = Array.from(outputs.entries());
    for (const [name, output] of outputsToClose) {
      try {
        output.close();
        this.app.logger.info(`✓ Closed output: ${name}`);
      } catch (error) {
        this.app.logger.warn(`Failed to close output ${name}: ${error.message}`);
      }
    }

    // Clear all maps
    inputs.clear();
    outputs.clear();

    // Longer delay to ensure ports are properly released
    this.app.logger.info('Waiting for ports to release...');
    await new Promise(resolve => setTimeout(resolve, PORT_RELEASE_DELAY_MS));

    // USB MIDI devices - get fresh list
    const inputNames = this.easymidi.getInputs();
    const outputNames = this.easymidi.getOutputs();

    this.app.logger.info(`Scanning devices: ${inputNames.length} inputs, ${outputNames.length} outputs`);
    this.app.logger.info(`Input devices found: ${JSON.stringify(inputNames)}`);
    this.app.logger.info(`Output devices found: ${JSON.stringify(outputNames)}`);

    // Add inputs (filter out system devices)
    for (const name of inputNames) {
      if (this.isSystemDevice(name)) {
        this.app.logger.info(`Skipping system device (input): ${name}`);
        continue;
      }
      try {
        addInput(name);
        this.app.logger.info(`✓ Input device added: ${name}`);
      } catch (error) {
        this.app.logger.error(`✗ Failed to add input ${name}: ${error.message}`);
      }
    }

    // Add outputs (filter out system devices)
    for (const name of outputNames) {
      if (this.isSystemDevice(name)) {
        this.app.logger.info(`Skipping system device (output): ${name}`);
        continue;
      }
      try {
        addOutput(name);
        this.app.logger.info(`✓ Output device added: ${name}`);
      } catch (error) {
        this.app.logger.error(`✗ Failed to add output ${name}: ${error.message}`);
      }
    }
  }

  isSystemDevice(name) {
    const systemPatterns = [
      /^Midi Through/i,
      /^Through Port/i,
      /^Microsoft GS Wavetable/i,
      /^RtMidi Output/i,
      /^RtMidi Input/i,
      /^RtMidi.*Client/i,
      /^IAC Driver/i,
      /^Bus \d+/i,
      /^Midi.*Virtual/i,
      /^CoreMIDI/i,
      /^FLUID Synth/i,
      /^Gervill/i,
      /^LoopBe/i,
      /^loopMIDI/i
    ];
    return systemPatterns.some(pattern => pattern.test(name));
  }

  // ==================== USB SERIAL NUMBER DETECTION ====================

  /**
   * Get USB serial numbers for connected devices.
   * Returns a map of device paths to serial numbers.
   */
  async getUsbSerialNumbers() {
    const serialNumbers = {};

    try {
      // Method 1: Check /dev/serial/by-id/ (most reliable on Linux)
      const serialByIdPath = '/dev/serial/by-id';
      if (fs.existsSync(serialByIdPath)) {
        const devices = fs.readdirSync(serialByIdPath);

        for (const device of devices) {
          try {
            const fullPath = path.join(serialByIdPath, device);
            const realPath = fs.realpathSync(fullPath);
            const match = device.match(/usb-(.+?)_(.+?)_([^-]+)/);
            if (match) {
              const serialNumber = match[3];
              serialNumbers[realPath] = serialNumber;
              serialNumbers[path.basename(realPath)] = serialNumber;
              this.app.logger.debug(`Found USB device: ${device} -> ${serialNumber}`);
            }
          } catch (error) {
            this.app.logger.warn(`Failed to read serial device ${device}: ${error.message}`);
          }
        }
      }

      // Method 2: Use udevadm for additional info (if available)
      try {
        const ttyDevices = fs.readdirSync('/sys/class/tty')
          .filter(d => d.startsWith('ttyUSB') || d.startsWith('ttyACM'));

        for (const tty of ttyDevices) {
          try {
            const cmd = `udevadm info --name=/dev/${tty} --query=property 2>/dev/null | grep -E "ID_SERIAL_SHORT|ID_SERIAL"`;
            const output = execSync(cmd, { encoding: 'utf8', timeout: 1000 });

            const lines = output.split('\n');
            let serialShort = null;
            let serial = null;

            for (const line of lines) {
              if (line.startsWith('ID_SERIAL_SHORT=')) {
                serialShort = line.split('=')[1];
              } else if (line.startsWith('ID_SERIAL=')) {
                serial = line.split('=')[1];
              }
            }

            const serialNum = serialShort || serial;
            if (serialNum) {
              serialNumbers[`/dev/${tty}`] = serialNum;
              serialNumbers[tty] = serialNum;
              this.app.logger.debug(`Found USB serial for ${tty}: ${serialNum}`);
            }
          } catch (error) {
            // Ignore errors for individual devices
          }
        }
      } catch (error) {
        this.app.logger.warn(`udevadm not available: ${error.message}`);
      }

      // Method 3: Check /sys/class/sound/ for USB MIDI class-compliant devices
      try {
        const soundDevices = fs.readdirSync('/sys/class/sound')
          .filter(d => d.startsWith('card'));

        for (const card of soundDevices) {
          try {
            const deviceLink = `/sys/class/sound/${card}/device`;
            if (!fs.existsSync(deviceLink)) continue;

            let usbPath = fs.realpathSync(deviceLink);
            let serial = null;

            for (let i = 0; i < 10 && usbPath !== '/'; i++) {
              const serialFile = path.join(usbPath, 'serial');
              if (fs.existsSync(serialFile)) {
                serial = fs.readFileSync(serialFile, 'utf8').trim();
                break;
              }
              usbPath = path.dirname(usbPath);
            }

            if (serial) {
              const idFile = `/proc/asound/${card}/id`;
              let cardId = card;
              if (fs.existsSync(idFile)) {
                cardId = fs.readFileSync(idFile, 'utf8').trim();
              }
              serialNumbers[cardId] = serial;
              this.app.logger.debug(`Found USB MIDI serial for ${cardId}: ${serial}`);
            }
          } catch (error) {
            // Skip individual card errors
          }
        }
      } catch (error) {
        this.app.logger.debug(`/sys/class/sound not available: ${error.message}`);
      }

    } catch (error) {
      this.app.logger.warn(`Failed to get USB serial numbers: ${error.message}`);
    }

    return serialNumbers;
  }

  /**
   * Synchronous lookup of serial number from a pre-fetched serial numbers map
   */
  findSerialNumberInMap(deviceName, serialNumbers) {
    for (const [devicePath, serialNumber] of Object.entries(serialNumbers)) {
      if (deviceName.includes(path.basename(devicePath)) ||
          devicePath.includes(deviceName.toLowerCase())) {
        return serialNumber;
      }
    }

    const cardMatch = deviceName.match(/card\s*(\d+)/i) || deviceName.match(/MIDI\s*(\d+)/i);
    if (cardMatch) {
      const cardNum = cardMatch[1];
      const keys = Object.keys(serialNumbers);
      if (keys.length > 0 && parseInt(cardNum) < keys.length) {
        return serialNumbers[keys[parseInt(cardNum)]];
      }
    }

    return null;
  }

  /**
   * Try to find USB serial number for a MIDI device
   */
  async findSerialNumberForDevice(deviceName) {
    const serialNumbers = await this.getUsbSerialNumbers();

    for (const [devicePath, serialNumber] of Object.entries(serialNumbers)) {
      if (deviceName.includes(path.basename(devicePath)) ||
          devicePath.includes(deviceName.toLowerCase())) {
        return serialNumber;
      }
    }

    const cardMatch = deviceName.match(/card\s*(\d+)/i) || deviceName.match(/MIDI\s*(\d+)/i);
    if (cardMatch) {
      const cardNum = cardMatch[1];
      const keys = Object.keys(serialNumbers);
      if (keys.length > 0 && parseInt(cardNum) < keys.length) {
        return serialNumbers[keys[parseInt(cardNum)]];
      }
    }

    return null;
  }

  // ==================== HOT-PLUG MONITORING ====================

  /**
   * Start automatic hot-plug monitoring.
   * @param {Map} inputs - Live inputs map
   * @param {Map} outputs - Live outputs map
   */
  startHotPlugMonitoring(inputs, outputs) {
    if (this.hotPlugInterval) {
      return; // Already running
    }

    this.app.logger.info(`Starting hot-plug monitoring (check every ${this.hotPlugCheckIntervalMs}ms)`);

    // Initialize known devices from current inputs/outputs maps
    this.knownInputs = new Set(inputs.keys());
    this.knownOutputs = new Set(outputs.keys());
    this.hotPlugFailures = 0;

    // Store references for checkDeviceChanges
    this._inputs = inputs;
    this._outputs = outputs;

    this.hotPlugInterval = setInterval(() => {
      this._onCheckDeviceChanges();
    }, this.hotPlugCheckIntervalMs);
  }

  stopHotPlugMonitoring() {
    if (this.hotPlugInterval) {
      clearInterval(this.hotPlugInterval);
      this.hotPlugInterval = null;
      this.app.logger.info('Hot-plug monitoring stopped');
    }
  }

  /**
   * Set the callback for when device changes are detected.
   * @param {Function} callback - async function({ added, removedInputs, removedOutputs })
   * @param {Function} fullRescanCallback - async function() for new device detection
   */
  setChangeCallbacks(callback, fullRescanCallback) {
    this._onDeviceChange = callback;
    this._onFullRescan = fullRescanCallback;
  }

  /**
   * Detect MIDI device changes using /proc/asound/ (Linux) to avoid
   * leaking ALSA sequencer clients. Falls back to easymidi.
   */
  _detectCurrentPorts() {
    // Method 1: Use /proc/asound/
    try {
      const cardsPath = '/proc/asound/cards';
      if (fs.existsSync(cardsPath)) {
        const cardsContent = fs.readFileSync(cardsPath, 'utf8');
        const cardNumbers = [];
        for (const line of cardsContent.split('\n')) {
          const match = line.match(/^\s*(\d+)\s+\[/);
          if (match) cardNumbers.push(parseInt(match[1]));
        }

        const midiDeviceNames = new Set();
        for (const cardNum of cardNumbers) {
          try {
            const cardDir = `/proc/asound/card${cardNum}`;
            const entries = fs.readdirSync(cardDir);
            const hasMidi = entries.some(entry => /^midi\d+$/.test(entry));
            if (hasMidi) {
              const idPath = `/proc/asound/card${cardNum}/id`;
              let cardId = `card${cardNum}`;
              if (fs.existsSync(idPath)) {
                cardId = fs.readFileSync(idPath, 'utf8').trim();
              }
              midiDeviceNames.add(cardId);
            }
          } catch (e) {
            // Skip this card
          }
        }
        return { cardIds: midiDeviceNames, method: 'proc' };
      }
    } catch (e) {
      this.app.logger.debug(`/proc/asound not available: ${e.message}`);
    }

    // Method 2: Fallback to easymidi
    try {
      const currentInputs = new Set(this.easymidi.getInputs().filter(name => !this.isSystemDevice(name)));
      const currentOutputs = new Set(this.easymidi.getOutputs().filter(name => !this.isSystemDevice(name)));
      return { inputs: currentInputs, outputs: currentOutputs, method: 'easymidi' };
    } catch (e) {
      this.app.logger.error(`Failed to enumerate MIDI ports: ${e.message}`);
      return null;
    }
  }

  /**
   * Internal: called by the interval timer.
   */
  async _onCheckDeviceChanges() {
    try {
      const ports = this._detectCurrentPorts();

      if (!ports) {
        this.hotPlugFailures++;
        if (this.hotPlugFailures >= 5) {
          this.app.logger.error('Hot-plug monitoring: too many consecutive failures, stopping');
          this.stopHotPlugMonitoring();
        }
        return;
      }

      let hasChanges = false;
      const inputs = this._inputs;
      const outputs = this._outputs;

      if (ports.method === 'proc') {
        const currentCardIds = ports.cardIds;

        // Check for removed inputs
        const removedInputs = [];
        for (const name of this.knownInputs) {
          const cardId = name.split(':')[0].trim();
          const stillPresent = [...currentCardIds].some(id =>
            cardId.toLowerCase().includes(id.toLowerCase()) ||
            id.toLowerCase().includes(cardId.toLowerCase())
          );
          if (!stillPresent) {
            removedInputs.push(name);
          }
        }

        for (const name of removedInputs) {
          this.app.logger.info(`🔌 MIDI input disconnected: ${name}`);
          const input = inputs.get(name);
          if (input) {
            try {
              input.removeAllListeners();
              input.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected input ${name}: ${error.message}`);
            }
            inputs.delete(name);
          }
          this.knownInputs.delete(name);
          hasChanges = true;
        }

        // Check for removed outputs
        const removedOutputs = [];
        for (const name of this.knownOutputs) {
          const cardId = name.split(':')[0].trim();
          const stillPresent = [...currentCardIds].some(id =>
            cardId.toLowerCase().includes(id.toLowerCase()) ||
            id.toLowerCase().includes(cardId.toLowerCase())
          );
          if (!stillPresent) {
            removedOutputs.push(name);
          }
        }

        for (const name of removedOutputs) {
          this.app.logger.info(`🔌 MIDI output disconnected: ${name}`);
          const output = outputs.get(name);
          if (output) {
            try {
              output.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected output ${name}: ${error.message}`);
            }
            outputs.delete(name);
          }
          this.knownOutputs.delete(name);
          hasChanges = true;
        }

        // Check for new devices
        const knownCardIds = new Set();
        for (const name of [...this.knownInputs, ...this.knownOutputs]) {
          const cardId = name.split(':')[0].trim().toLowerCase();
          knownCardIds.add(cardId);
        }

        for (const cardId of currentCardIds) {
          const isKnown = [...knownCardIds].some(known =>
            known.includes(cardId.toLowerCase()) ||
            cardId.toLowerCase().includes(known)
          );
          if (!isKnown) {
            this.app.logger.info(`🔌 New MIDI card detected: ${cardId} - rescanning...`);
            if (this._onFullRescan) {
              await this._onFullRescan();
            }
            return;
          }
        }
      } else {
        // easymidi method
        const currentInputs = ports.inputs;
        const currentOutputs = ports.outputs;

        // Check for new inputs
        for (const name of currentInputs) {
          if (!this.knownInputs.has(name)) {
            this.app.logger.info(`🔌 New MIDI input detected: ${name}`);
            if (this._onDeviceChange) {
              try {
                await this._onDeviceChange({ type: 'addInput', name });
                this.knownInputs.add(name);
                hasChanges = true;
              } catch (error) {
                this.app.logger.error(`Failed to add new input ${name}: ${error.message}`);
              }
            }
          }
        }

        // Check for removed inputs
        const removedInputs = [...this.knownInputs].filter(name => !currentInputs.has(name));
        for (const name of removedInputs) {
          this.app.logger.info(`🔌 MIDI input disconnected: ${name}`);
          const input = inputs.get(name);
          if (input) {
            try {
              input.removeAllListeners();
              input.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected input ${name}: ${error.message}`);
            }
            inputs.delete(name);
          }
          this.knownInputs.delete(name);
          hasChanges = true;
        }

        // Check for new outputs
        for (const name of currentOutputs) {
          if (!this.knownOutputs.has(name)) {
            this.app.logger.info(`🔌 New MIDI output detected: ${name}`);
            if (this._onDeviceChange) {
              try {
                await this._onDeviceChange({ type: 'addOutput', name });
                this.knownOutputs.add(name);
                hasChanges = true;
              } catch (error) {
                this.app.logger.error(`Failed to add new output ${name}: ${error.message}`);
              }
            }
          }
        }

        // Check for removed outputs
        const removedOutputs = [...this.knownOutputs].filter(name => !currentOutputs.has(name));
        for (const name of removedOutputs) {
          this.app.logger.info(`🔌 MIDI output disconnected: ${name}`);
          const output = outputs.get(name);
          if (output) {
            try {
              output.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected output ${name}: ${error.message}`);
            }
            outputs.delete(name);
          }
          this.knownOutputs.delete(name);
          hasChanges = true;
        }
      }

      // Reset failure counter on success
      this.hotPlugFailures = 0;

      if (hasChanges && this._onDeviceChange) {
        await this._onDeviceChange({ type: 'update' });
      }

    } catch (error) {
      this.app.logger.error(`Error checking device changes: ${error.message}`);
      this.hotPlugFailures++;
      if (this.hotPlugFailures >= 5) {
        this.app.logger.error('Hot-plug monitoring: too many consecutive failures, stopping');
        this.stopHotPlugMonitoring();
      }
    }
  }
}

export default DeviceDiscovery;
