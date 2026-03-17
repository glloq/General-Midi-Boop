// src/api/commands/SystemCommands.js
import os from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

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

async function systemInfo(app) {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem()
  };
}

async function systemRestart(app) {
  app.logger.info('System restart requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

async function systemShutdown(app) {
  app.logger.info('System shutdown requested');
  setTimeout(() => process.exit(0), 1000);
  return { success: true };
}

async function systemCheckUpdate(app) {
  const { execSync } = await import('child_process');
  const { resolve } = await import('path');
  const cwd = resolve('.');

  try {
    // Fetch latest from remote
    execSync('git fetch origin main', { cwd, timeout: 15000, stdio: 'pipe' });

    const localHash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const remoteHash = execSync('git rev-parse origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const localDate = execSync('git log -1 --format=%ci HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const remoteDate = execSync('git log -1 --format=%ci origin/main', { cwd, encoding: 'utf8', timeout: 5000 }).trim();

    let behindCount = 0;
    if (localHash !== remoteHash) {
      const behind = execSync(`git rev-list --count HEAD..origin/main`, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      behindCount = parseInt(behind) || 0;
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
  app.logger.info('System update requested');
  const { spawn } = await import('child_process');
  const { resolve } = await import('path');
  const scriptPath = resolve('./scripts/update.sh');
  const cwd = resolve('.');

  // Launch update script detached so it survives server restart
  const child = spawn('bash', [scriptPath, '--non-interactive'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', NON_INTERACTIVE: '1' }
  });
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
      throw new Error('Invalid backup filename');
    }
  } else {
    filename = `backup_${Date.now()}.db`;
  }

  const backupPath = resolve(backupsDir, filename);
  app.database.backup(backupPath);
  return { path: backupPath };
}

async function systemRestore(app, data) {
  // Future implementation
  return { success: true };
}

async function systemLogs(app, data) {
  // Future implementation - return recent logs
  return { logs: [] };
}

async function systemClearLogs(app) {
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
