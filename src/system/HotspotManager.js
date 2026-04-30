/**
 * @file src/system/HotspotManager.js
 * @description Thin wrapper around `scripts/hotspot.sh` — the only path
 * the application uses to flip the Raspberry Pi between WiFi-client mode
 * and AP (hotspot) mode.
 *
 * The shell script is invoked through `sudo -n` so the operation fails
 * cleanly when the sudoers rule (installed by `scripts/Install.sh`) is
 * missing, instead of hanging on a password prompt.
 *
 * Concurrency: a single in-flight `enable`/`disable` is enforced via
 * `_busy` to avoid racing two activations.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, '../../scripts/hotspot.sh');

/** Maximum time (ms) we let nmcli operations run before giving up. */
const HOTSPOT_CMD_TIMEOUT_MS = 20000;

class HotspotManager {
  /**
   * @param {{logger:Object}} deps
   */
  constructor(deps) {
    this.logger = deps.logger;
    this._busy = false;
    // In-memory flag mirroring the AP profile state. Updated on every
    // enable/disable and at startup via _bootstrapState(). Read by the
    // captive-portal middleware in HttpServer to skip its work when the
    // hotspot is off.
    this._active = false;
    this._bootstrapState();
  }

  /**
   * Best-effort initial state read so `isActive()` is correct after a
   * server restart while the hotspot was already up.
   * @returns {void}
   * @private
   */
  _bootstrapState() {
    this.status()
      .then((s) => { this._active = !!s.hotspotActive; })
      .catch(() => { /* nmcli unavailable, leave default false */ });
  }

  /**
   * Whether the AP profile is currently up. Synchronous (in-memory).
   * @returns {boolean}
   */
  isActive() {
    return this._active;
  }

  /**
   * Run the wrapper script and parse its single-line JSON output.
   *
   * @param {string[]} args Sub-command and positional arguments.
   * @returns {Promise<Object>} Parsed JSON payload from the script.
   * @private
   */
  async _runScript(args) {
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync('sudo', ['-n', SCRIPT_PATH, ...args], {
        timeout: HOTSPOT_CMD_TIMEOUT_MS,
        maxBuffer: 1024 * 64
      });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (err) {
      // execFile throws when exit code != 0; the script still wrote its
      // JSON error envelope to stdout — try to parse it before giving up.
      stdout = err.stdout || '';
      stderr = err.stderr || err.message || '';
      const parsed = this._tryParse(stdout);
      if (parsed) return parsed;
      const hint = /password is required|sudo:.*not allowed/i.test(stderr)
        ? ' (sudoers rule missing — see scripts/Install.sh)'
        : '';
      throw new Error(`hotspot.sh failed: ${stderr.trim() || err.message}${hint}`);
    }

    const parsed = this._tryParse(stdout);
    if (!parsed) {
      throw new Error(`hotspot.sh produced unparseable output: ${stdout.slice(0, 200)}`);
    }
    return parsed;
  }

  /**
   * @param {string} text
   * @returns {?Object}
   * @private
   */
  _tryParse(text) {
    const line = (text || '').trim().split('\n').pop();
    if (!line) return null;
    try { return JSON.parse(line); } catch { return null; }
  }

  /**
   * Read the current hotspot/wifi state. Always fresh — reads nmcli.
   *
   * @returns {Promise<{hotspotActive:boolean, wifiActive:string, interface:string}>}
   */
  async status() {
    const res = await this._runScript(['status']);
    const active = !!res.hotspotActive;
    this._active = active;
    return {
      hotspotActive: active,
      wifiActive: res.wifiActive || '',
      interface: res.interface || 'wlan0'
    };
  }

  /**
   * Activate the hotspot using the supplied configuration. Implicitly
   * tears down the WiFi-client connection on the same interface.
   *
   * @param {{ssid:string, password:string, band?:string, channel?:number}} cfg
   * @returns {Promise<{hotspotActive:true, ssid:string}>}
   */
  async enable(cfg) {
    if (this._busy) throw new Error('hotspot operation already in progress');
    this._busy = true;
    try {
      const args = ['enable', cfg.ssid, cfg.password, cfg.band || 'bg'];
      if (cfg.channel) args.push(String(cfg.channel));
      const res = await this._runScript(args);
      this._active = true;
      this.logger?.info(`Hotspot enabled (ssid="${cfg.ssid}")`);
      return res;
    } finally {
      this._busy = false;
    }
  }

  /**
   * Stop the hotspot and let NetworkManager bring the WiFi client back.
   *
   * @returns {Promise<{hotspotActive:false, wifiActive:string}>}
   */
  async disable() {
    if (this._busy) throw new Error('hotspot operation already in progress');
    this._busy = true;
    try {
      const res = await this._runScript(['disable']);
      this._active = false;
      this.logger?.info(`Hotspot disabled (wifi reactivated="${res.wifiActive || ''}")`);
      return res;
    } finally {
      this._busy = false;
    }
  }
}

export default HotspotManager;
