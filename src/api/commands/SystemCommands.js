/**
 * @file src/api/commands/SystemCommands.js
 * @description WebSocket command handlers for system-level operations
 * (status, info, restart, in-place update, backup).
 *
 * Registered commands:
 *   - `system_status`        — devices/routes/files counts + uptime
 *   - `system_info`          — host platform/CPU/memory
 *   - `system_restart`       — clean exit; PM2 restarts
 *   - `system_shutdown`      — same as restart in this codebase
 *   - `system_check_update`  — git ls-remote vs local HEAD
 *   - `system_update`        — spawn detached `scripts/update.sh`
 *   - `system_backup`        — copy DB to `backups/<filename>.db`
 *   - `system_restore`       — placeholder
 *   - `system_logs`          — tail the active log file (cap {@link LOG_TAIL_MAX_LINES})
 *   - `system_clear_logs`    — truncate the active log file
 *
 * Mutating commands (restart/shutdown/update) are gated by
 * {@link requireTokenConfigured} so they are unreachable when API token
 * auth is not configured.
 *
 * Validation: `system_backup` schema lives inline in
 * `JsonValidator.validateSystemCommand`; the rest take no payload.
 */
import os from 'os';
import { readFileSync, accessSync, openSync, closeSync, mkdirSync, unlinkSync, existsSync, constants as fsConstants } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { AuthenticationError, ValidationError } from '../../core/errors/index.js';

/** Default number of log lines returned when `data.lines` is absent. */
const LOG_TAIL_DEFAULT_LINES = 200;
/** Hard cap on `data.lines` so a large request cannot OOM the server. */
const LOG_TAIL_MAX_LINES = 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

/**
 * Process-wide guard preventing concurrent `system_update` invocations.
 * Reset by either a successful update (server restart drops the value)
 * or the safety timeout in {@link systemUpdate}.
 */
let _updateInProgress = false;
/** Timer that resets `_updateInProgress` after the safety window. */
let _updateInProgressTimer = null;

/**
 * @param {Object} app
 * @returns {Promise<{uptime:number, memory:NodeJS.MemoryUsage,
 *   version:string, devices:number, routes:number, files:number}>}
 */
async function systemStatus(app) {
  return {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: APP_VERSION,
    devices: app.deviceManager.getDeviceList().length,
    routes: app.midiRouter.getRouteList().length,
    files: app.fileRepository.findByFolder('/').length
  };
}

/**
 * @returns {Promise<{platform:string, arch:string, nodeVersion:string,
 *   cpus:number, totalMemory:number, freeMemory:number}>}
 */
async function systemInfo(_app) {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem()
  };
}

/**
 * Guard for critical system commands. Requires `GMBOOP_API_TOKEN` to
 * be configured so destructive operations cannot be invoked through an
 * unauthenticated server.
 *
 * @returns {void}
 * @throws {AuthenticationError}
 */
function requireTokenConfigured() {
  if (!process.env.GMBOOP_API_TOKEN) {
    throw new AuthenticationError('System commands require GMBOOP_API_TOKEN to be configured');
  }
}

/**
 * Schedule a clean process exit after a 1s delay (gives the WS response
 * time to reach the client). PM2 / systemd restarts the process.
 *
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {AuthenticationError}
 */
async function systemRestart(app) {
  requireTokenConfigured();
  app.logger.info('System restart requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

/**
 * Same semantics as {@link systemRestart} — the process supervisor
 * decides whether to bring the server back up. Distinct command name so
 * the UI can label the action correctly.
 *
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 * @throws {AuthenticationError}
 */
async function systemShutdown(app) {
  requireTokenConfigured();
  app.logger.info('System shutdown requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

/**
 * Compare local HEAD against origin/main (stable) and the current branch
 * (beta) to detect available updates on both channels.
 *
 * Returns structured `stable` and `beta` objects plus legacy flat fields
 * for backward compatibility.  `stable.versionChanged` is true when the
 * version string in origin/main's package.json differs from the running
 * version, signalling an official release.
 *
 * @param {Object} app
 * @returns {Promise<{
 *   version: string,
 *   localHash: string,
 *   localDate: string,
 *   currentBranch: string,
 *   stable: {upToDate:boolean, remoteHash:string, remoteVersion:string|null,
 *            versionChanged:boolean, behindCount:number, remoteDate:string},
 *   beta: {upToDate:boolean, remoteHash:string, behindCount:number,
 *          remoteDate:string, branch:string}|null,
 *   upToDate: boolean|null,
 *   remoteHash: string,
 *   behindCount: number,
 *   error?: string
 * }>}
 */
async function systemCheckUpdate(app) {
  const { execSync } = await import('child_process');
  const cwd = PROJECT_ROOT;

  try {
    const localHash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const localDate = execSync('git log -1 --format=%ci HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const currentBranch = execSync('git branch --show-current', { cwd, encoding: 'utf8', timeout: 5000 }).trim() || 'main';

    // ── Stable channel: origin/main ──
    const lsRemoteMain = execSync('git ls-remote origin refs/heads/main', { cwd, encoding: 'utf8', timeout: 15000 }).trim();
    const stableRemoteHashFull = lsRemoteMain.split(/\s/)[0] || '';

    if (!stableRemoteHashFull) {
      return { upToDate: null, error: 'Impossible de lire le hash distant', version: APP_VERSION };
    }

    let stableBehindCount = 0;
    let stableRemoteDate = '';
    let stableRemoteVersion = null;

    try {
      execSync('git fetch origin main', { cwd, timeout: 15000, stdio: 'pipe' });
      stableRemoteDate = execSync('git log -1 --format=%ci origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      if (localHash !== stableRemoteHashFull) {
        const behind = execSync('git rev-list --count HEAD..origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
        stableBehindCount = parseInt(behind) || 0;
        try {
          const remotePkgRaw = execSync('git show origin/main:package.json', { cwd, encoding: 'utf8', timeout: 5000 });
          stableRemoteVersion = JSON.parse(remotePkgRaw).version || null;
        } catch { /* ignore */ }
      }
    } catch {
      // No write access — use ls-remote result only
    }

    const stableUpToDate = localHash === stableRemoteHashFull;
    const stableVersionChanged = !stableUpToDate && stableRemoteVersion !== null && stableRemoteVersion !== APP_VERSION;

    // ── Beta channel: current branch (only when different from main) ──
    // Validate branch name against a safe pattern before interpolating into shell commands.
    const SAFE_BRANCH_RE = /^[a-zA-Z0-9/_.-]+$/;
    let betaInfo = null;
    if (currentBranch && currentBranch !== 'main' && SAFE_BRANCH_RE.test(currentBranch)) {
      try {
        const lsRemoteBeta = execSync(`git ls-remote origin refs/heads/${currentBranch}`, { cwd, encoding: 'utf8', timeout: 15000 }).trim();
        const betaRemoteHashFull = lsRemoteBeta.split(/\s/)[0] || '';
        if (betaRemoteHashFull) {
          let betaBehindCount = 0;
          let betaRemoteDate = '';
          try {
            execSync(`git fetch origin ${currentBranch}`, { cwd, timeout: 15000, stdio: 'pipe' });
            betaRemoteDate = execSync(`git log -1 --format=%ci origin/${currentBranch}`, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
            if (localHash !== betaRemoteHashFull) {
              const behind = execSync(`git rev-list --count HEAD..origin/${currentBranch}`, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
              betaBehindCount = parseInt(behind) || 0;
            }
          } catch { /* ignore */ }
          betaInfo = {
            upToDate: localHash === betaRemoteHashFull,
            remoteHash: betaRemoteHashFull.substring(0, 7),
            behindCount: betaBehindCount,
            remoteDate: betaRemoteDate,
            branch: currentBranch
          };
        }
      } catch { /* beta check failed silently */ }
    }

    return {
      version: APP_VERSION,
      localHash: localHash.substring(0, 7),
      localDate,
      currentBranch,
      stable: {
        upToDate: stableUpToDate,
        remoteHash: stableRemoteHashFull.substring(0, 7),
        remoteVersion: stableRemoteVersion,
        versionChanged: stableVersionChanged,
        behindCount: stableBehindCount,
        remoteDate: stableRemoteDate
      },
      beta: betaInfo,
      // Legacy flat fields for backward compatibility
      upToDate: stableUpToDate,
      remoteHash: stableRemoteHashFull.substring(0, 7),
      remoteDate: stableRemoteDate,
      behindCount: stableBehindCount
    };
  } catch (error) {
    app.logger.warn('Check update failed:', error.message);
    return { upToDate: null, error: error.message, version: APP_VERSION };
  }
}

/**
 * Spawn `scripts/update.sh` detached so it survives the server restart
 * triggered later in the script. Concurrent invocations are blocked by
 * a process-local flag (with a 5-minute safety reset). Sets up a poller
 * that triggers a self-`process.exit(0)` once the script writes
 * `restarting` or `done` to the status file — PM2 brings the new code
 * up.
 *
 * @param {Object} app
 * @param {{type?: 'stable'|'beta'}} [data]  `type='beta'` stays on the
 *   current branch; `type='stable'` (default) switches to main.
 * @returns {Promise<{success:boolean, message?:string, error?:string}>}
 * @throws {AuthenticationError}
 */
async function systemUpdate(app, data = {}) {
  requireTokenConfigured();
  const updateType = (data?.type === 'beta') ? 'beta' : 'stable';
  app.logger.info(`System update requested (type: ${updateType})`);

  // Prevent concurrent updates
  if (_updateInProgress) {
    // Check if a previous update actually finished (stale flag)
    const statusFilePath = join(PROJECT_ROOT, 'logs', 'update-status');
    let stale = false;
    try {
      const lastStatus = readFileSync(statusFilePath, 'utf8').trim().split(' ')[0].replace(':', '');
      if (lastStatus === 'done' || lastStatus === 'failed') {
        stale = true;
      }
    } catch { /* file doesn't exist */ }

    if (!stale) {
      return { success: false, error: 'Update already in progress' };
    }

    // Previous update finished but flag wasn't cleared (server didn't restart)
    app.logger.warn('Stale _updateInProgress flag detected (status: done/failed) — resetting');
    _updateInProgress = false;
    if (_updateInProgressTimer) { clearTimeout(_updateInProgressTimer); _updateInProgressTimer = null; }
  }

  const scriptPath = join(PROJECT_ROOT, 'scripts/update.sh');
  const cwd = PROJECT_ROOT;

  // Verify script exists and is executable
  try {
    accessSync(scriptPath, fsConstants.F_OK | fsConstants.X_OK);
  } catch (err) {
    app.logger.error(`Update script not found or not executable: ${scriptPath}`);
    return { success: false, error: 'Update script not found or not executable' };
  }

  _updateInProgress = true;

  // Safety timeout: reset flag after 5 minutes in case update fails without restarting server
  if (_updateInProgressTimer) clearTimeout(_updateInProgressTimer);
  _updateInProgressTimer = setTimeout(() => {
    _updateInProgress = false;
    _updateInProgressTimer = null;
    app.logger.warn('Update flag reset after 5 minute safety timeout');
  }, 5 * 60 * 1000);

  const { spawn } = await import('child_process');
  const serverPort = app.config?.server?.port || 8080;

  // Open log file from Node.js so the child has a valid stdout/stderr.
  // Use the project logs/ directory to avoid /tmp permission conflicts.
  const logsDir = join(PROJECT_ROOT, 'logs');
  try { mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }

  // Remove stale status file from previous update so frontend doesn't see old "done"
  try { unlinkSync(join(logsDir, 'update-status')); } catch { /* doesn't exist */ }

  const logPath = join(logsDir, 'update.log');
  let logFd;
  try {
    // Remove stale file that may be owned by another user
    try { unlinkSync(logPath); } catch { /* doesn't exist */ }
    logFd = openSync(logPath, 'w');
  } catch (err) {
    app.logger.error(`Cannot open update log file ${logPath}: ${err.message}`);
    _updateInProgress = false;
    if (_updateInProgressTimer) { clearTimeout(_updateInProgressTimer); _updateInProgressTimer = null; }
    return { success: false, error: `Cannot open update log: ${err.message}` };
  }

  app.logger.info(`Spawning update script: bash ${scriptPath} --non-interactive (cwd: ${cwd}, type: ${updateType})`);

  // Launch update script detached so it survives server restart
  const child = spawn('bash', [scriptPath, '--non-interactive'], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      DEBIAN_FRONTEND: 'noninteractive',
      NON_INTERACTIVE: '1',
      SERVER_PORT: String(serverPort),
      UPDATE_DELAY_SECONDS: '3',
      UPDATE_TYPE: updateType
    }
  });

  // Close fd in parent process (child has its own copy)
  try { closeSync(logFd); } catch { /* ignore */ }

  // Monitor child process exit. The script double-forks to escape PM2 treekill,
  // so the first fork exits immediately with code 0 (expected). Only warn on errors.
  child.on('exit', (code, signal) => {
    if (code === 0) {
      app.logger.info('Update script first fork exited (double-fork detach)');
    } else {
      app.logger.warn(`Update script process exited unexpectedly: code=${code}, signal=${signal}`);
    }
  });

  // Wait briefly to catch immediate spawn failures
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(resolvePromise, 500);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    _updateInProgress = false;
    if (_updateInProgressTimer) { clearTimeout(_updateInProgressTimer); _updateInProgressTimer = null; }
    app.logger.error(`Failed to spawn update script: ${err.message}`);
    return { success: false, error: `Failed to start update: ${err.message}` };
  }

  child.unref();

  // Safety net: poll the update status file.
  // If the bash script wrote "restarting" or "done" but failed to restart us,
  // we exit ourselves — PM2 autorestart will bring us back with new code.
  const statusFilePath = join(PROJECT_ROOT, 'logs', 'update-status');
  const safetyPoll = setInterval(() => {
    try {
      const status = readFileSync(statusFilePath, 'utf8').trim().split(' ')[0];
      if (status === 'restarting' || status === 'done') {
        clearInterval(safetyPoll);
        app.logger.info(`Update safety net: status="${status}", triggering self-exit for restart`);
        setTimeout(() => process.exit(0), 2000);
      }
    } catch { /* file doesn't exist yet, ignore */ }
  }, 3000);

  // Stop polling after 5 minutes (matches existing safety timeout)
  setTimeout(() => clearInterval(safetyPoll), 5 * 60 * 1000);

  app.logger.info(`Update script launched (PID: ${child.pid}), server will restart`);
  return { success: true, message: 'Update started' };
}

/**
 * Snapshot the SQLite database file into `./backups/<filename>`. Any
 * caller-provided `path` is reduced to its `basename` and refused if it
 * contains `..` or starts with `.` — directory escapes and dotfiles are
 * rejected to keep the destination locked to `backups/`.
 *
 * @param {Object} app
 * @param {{path?:string}} data
 * @returns {Promise<{path:string}>} Absolute path of the written backup.
 * @throws {ValidationError} For unsafe filenames.
 */
async function systemBackup(app, data) {
  const { resolve, basename } = await import('path');
  const backupsDir = resolve('./backups');

  let filename;
  if (data.path) {
    filename = basename(data.path);
    if (filename.includes('..') || filename.startsWith('.')) {
      throw new ValidationError('Invalid backup filename', 'path');
    }
  } else {
    filename = `backup_${Date.now()}.db`;
  }

  const backupPath = resolve(backupsDir, filename);
  // Admin-level op on the whole database file; no domain Repository fits here.
  app.database.backup(backupPath);
  return { path: backupPath };
}

/**
 * Placeholder for full database restore.
 * TODO: implement once the UI exposes a confirmation dialog and a way
 * to upload a backup blob securely.
 *
 * @returns {Promise<{success:true}>}
 */
async function systemRestore(_app, _data) {
  return { success: true };
}

/**
 * Resolve the active log file path from config, falling back to the
 * legacy default used by older installs.
 *
 * @param {Object} app
 * @returns {string} Absolute path (resolved against the project root).
 * @private
 */
function _resolveLogPath(app) {
  const configured = app.config?.logging?.file || './logs/gmboop.log';
  return resolve(PROJECT_ROOT, configured);
}

/**
 * Return the last `data.lines` lines of the log file (default
 * {@link LOG_TAIL_DEFAULT_LINES}, capped at {@link LOG_TAIL_MAX_LINES}).
 * Returns `{logs: []}` when no log file is configured or the file does
 * not exist yet (fresh install).
 *
 * @param {Object} app
 * @param {?{lines?:number}} data
 * @returns {Promise<{logs:string[], path:string, truncated:boolean}>}
 *   `truncated:true` indicates the file had more lines than returned.
 */
async function systemLogs(app, data) {
  const requested = Number.isInteger(data?.lines) && data.lines > 0 ? data.lines : LOG_TAIL_DEFAULT_LINES;
  const lineLimit = Math.min(requested, LOG_TAIL_MAX_LINES);
  const logPath = _resolveLogPath(app);

  if (!existsSync(logPath)) {
    return { logs: [], path: logPath, truncated: false };
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch (err) {
    app.logger.warn(`system_logs read failed: ${err.message}`);
    return { logs: [], path: logPath, truncated: false };
  }

  // Split and drop a trailing empty line (normal when file ends with \n).
  const allLines = content.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const tail = allLines.slice(-lineLimit);
  return {
    logs: tail,
    path: logPath,
    truncated: allLines.length > tail.length
  };
}

/**
 * Truncate the active log file to zero bytes. Delegates to
 * `Logger.clear()` so the logger's write stream stays coherent with
 * the on-disk file across the operation.
 *
 * @param {Object} app
 * @returns {Promise<{success:boolean, path?:string}>}
 */
async function systemClearLogs(app) {
  if (typeof app.logger?.clear === 'function') {
    const ok = app.logger.clear();
    return { success: ok, path: _resolveLogPath(app) };
  }

  // Console-only logger (no file sink) — nothing to clear but not an error.
  return { success: true };
}

/**
 * Wire every system-level command on the registry.
 *
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('system_status', () => systemStatus(app));
  registry.register('system_info', () => systemInfo(app));
  registry.register('system_restart', () => systemRestart(app));
  registry.register('system_shutdown', () => systemShutdown(app));
  registry.register('system_update', (data) => systemUpdate(app, data));
  registry.register('system_check_update', () => systemCheckUpdate(app));
  registry.register('system_backup', (data) => systemBackup(app, data));
  registry.register('system_restore', (data) => systemRestore(app, data));
  registry.register('system_logs', (data) => systemLogs(app, data));
  registry.register('system_clear_logs', () => systemClearLogs(app));
}
