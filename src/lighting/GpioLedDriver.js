// src/lighting/GpioLedDriver.js
// GPIO PWM driver for RGB LEDs on Raspberry Pi
// Uses pigpio for hardware PWM control

import BaseLightingDriver from './BaseLightingDriver.js';

class GpioLedDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.pigpio = null;
    this.gpioInstances = []; // Array of {r, g, b} Gpio objects per LED
  }

  async connect() {
    try {
      // Dynamic import - pigpio is only available on Raspberry Pi
      const pigpioModule = await import('pigpio');
      this.pigpio = pigpioModule.default || pigpioModule;
      const Gpio = this.pigpio.Gpio;

      const config = this.device.connection_config;
      // config.leds = [{r: 17, g: 27, b: 22}, {r: 5, g: 6, b: 13}, ...]
      // OR for single LED: config.pins = {r: 17, g: 27, b: 22}
      const ledConfigs = config.leds || [config.pins || { r: 17, g: 27, b: 22 }];

      this.gpioInstances = ledConfigs.map((pins, index) => {
        try {
          return {
            r: new Gpio(pins.r, { mode: Gpio.OUTPUT }),
            g: new Gpio(pins.g, { mode: Gpio.OUTPUT }),
            b: new Gpio(pins.b, { mode: Gpio.OUTPUT })
          };
        } catch (err) {
          this.logger.error(`Failed to init GPIO LED ${index}: ${err.message}`);
          return null;
        }
      }).filter(Boolean);

      if (this.gpioInstances.length === 0) {
        throw new Error('No GPIO LEDs could be initialized');
      }

      this.connected = true;
      this.logger.info(`GPIO LED driver connected: ${this.gpioInstances.length} LED(s) on device "${this.device.name}"`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`GPIO LED driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    for (const led of this.gpioInstances) {
      if (led) {
        try {
          led.r.pwmWrite(0);
          led.g.pwmWrite(0);
          led.b.pwmWrite(0);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
    }
    this.gpioInstances = [];
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    const led = this.gpioInstances[ledIndex];
    if (!led) return;

    try {
      led.r.pwmWrite(this._applyBrightness(r, brightness));
      led.g.pwmWrite(this._applyBrightness(g, brightness));
      led.b.pwmWrite(this._applyBrightness(b, brightness));
    } catch (err) {
      this.logger.warn(`GPIO pwmWrite failed for LED ${ledIndex}: ${err.message}`);
    }
  }

  allOff() {
    for (let i = 0; i < this.gpioInstances.length; i++) {
      this.setColor(i, 0, 0, 0, 0);
    }
  }
}

export default GpioLedDriver;
