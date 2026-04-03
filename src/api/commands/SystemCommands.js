// src/api/commands/SystemCommands.js
import os from 'os';
import { readFileSync, accessSync, constants as fsConstants } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { AuthenticationError, ValidationError } from '../../core/errors/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

let _updateInProgress = false;
let _updateInProgressTimer = null;

async function systemStatus(app) {
  return {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: APP_VERSION,
    devices: app.deviceManager.getDeviceList().length,
    routes: app.midiRouter.getRouteList().length,
    files: app.database.getFiles('/').length
  };
}

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
 * Guard for critical system commands — requires that API token authentication
 * is configured. Prevents accidental or unauthorized system operations when
 * the server runs without token protection.
 */
function requireTokenConfigured() {
  if (!process.env.MAESTRO_API_TOKEN) {
    throw new AuthenticationError('System commands require MAESTRO_API_TOKEN to be configured');
  }
}

async function systemRestart(app) {
  requireTokenConfigured();
  app.logger.info('System restart requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

async function systemShutdown(app) {
  requireTokenConfigured();
  app.logger.info('System shutdown requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

async function systemCheckUpdate(app) {
  const { execSync } = await import('child_process');
  const cwd = PROJECT_ROOT;

  try {
    // Get local commit info
    const localHash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const localDate = execSync('git log -1 --format=%ci HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();

    // Query remote without writing to .git/ (avoids permission issues)
    const lsRemote = execSync('git ls-remote origin refs/heads/main', { cwd, encoding: 'utf8', timeout: 15000 }).trim();
    const remoteHash = lsRemote.split(/\s/)[0] || '';

    if (!remoteHash) {
      return { upToDate: null, error: 'Impossible de lire le hash distant', version: APP_VERSION };
    }

    let behindCount = 0;
    let remoteDate = '';

    // Try to get remote date and behind count using local refs (may be stale but no write needed)
    try {
      // Fetch to update refs if we have write access
      execSync('git fetch origin main', { cwd, timeout: 15000, stdio: 'pipe' });
      remoteDate = execSync('git log -1 --format=%ci origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      if (localHash !== remoteHash) {
        const behind = execSync('git rev-list --count HEAD..origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
        behindCount = parseInt(behind) || 0;
      }
    } catch {
      // No write access to .git/, use ls-remote result only
      // remoteDate stays empty, behindCount stays 0
    }

    return {
      upToDate: localHash === remoteHash,
      localHash: localHash.substring(0, 7),
      remoteHash: remoteHash.substring(0, 7),
      localDate,
      remoteDate,
      behindCount,
      version: APP_VERSION
    };
  } catch (error) {
    app.logger.warn('Check update failed:', error.message);
    return {
      upToDate: null,
      error: error.message,
      version: APP_VERSION
    };
  }
}

async function systemUpdate(app) {
  requireTokenConfigured();
  app.logger.info('System update requested');

  // Prevent concurrent updates
  if (_updateInProgress) {
    return { success: false, error: 'Update already in progress' };
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

  // Launch update script detached so it survives server restart
  const child = spawn('bash', [scriptPath, '--non-interactive'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: process.env.LANG || 'C.UTF-8',
      NODE_ENV: process.env.NODE_ENV || 'production',
      DEBIAN_FRONTEND: 'noninteractive',
      NON_INTERACTIVE: '1',
      SERVER_PORT: String(serverPort),
      UPDATE_DELAY_SECONDS: '3'
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

  app.logger.info(`Update script launched (PID: ${child.pid}), server will restart`);
  return { success: true, message: 'Update started' };
}

async function systemBackup(app, data) {
  const { resolve, basename } = await import('path');
  const backupsDir = resolve('./backups');

  // Sanitize: only allow filename, force it into backups directory
  let filename;
  if (data.path) {
    filename = basename(data.path);
    // Reject suspicious filenames
    if (filename.includes('..') || filename.startsWith('.')) {
      throw new ValidationError('Invalid backup filename', 'path');
    }
  } else {
    filename = `backup_${Date.now()}.db`;
  }

  const backupPath = resolve(backupsDir, filename);
  app.database.backup(backupPath);
  return { path: backupPath };
}

async function systemRestore(_app, _data) {
  // Future implementation
  return { success: true };
}

async function systemLogs(_app, _data) {
  // Future implementation - return recent logs
  return { logs: [] };
}

async function systemClearLogs(_app) {
  // Future implementation
  return { success: true };
}

export function register(registry, app) {
  registry.register('system_status', () => systemStatus(app));
  registry.register('system_info', () => systemInfo(app));
  registry.register('system_restart', () => systemRestart(app));
  registry.register('system_shutdown', () => systemShutdown(app));
  registry.register('system_update', () => systemUpdate(app));
  registry.register('system_check_update', () => systemCheckUpdate(app));
  registry.register('system_backup', (data) => systemBackup(app, data));
  registry.register('system_restore', (data) => systemRestore(app, data));
  registry.register('system_logs', (data) => systemLogs(app, data));
  registry.register('system_clear_logs', () => systemClearLogs(app));
}
