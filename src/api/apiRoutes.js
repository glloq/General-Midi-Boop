/**
 * @file src/api/apiRoutes.js
 * @description Express router holding the small set of HTTP endpoints
 * exposed alongside the WebSocket API. Most operational features live on
 * the WS side; HTTP is reserved for things that monitoring tools need
 * (`/health`, `/metrics`) and for the update flow.
 *
 * Public (no auth) endpoints:
 *   - `GET /health` — liveness probe with version + git hash + uptime.
 *   - `GET /update-status` — polled by the SPA during in-place updates.
 *
 * Authenticated endpoints (gated by the bearer middleware in HttpServer):
 *   - `GET /status` — counts of devices/routes/files plus memory/uptime.
 *   - `GET /metrics` — Prometheus text exposition format (v0.0.4).
 *
 * Module-load side-effect: shells out to `git rev-parse` once to capture
 * the short hash for `/health`. Failure is silently ignored — value
 * stays `"unknown"`.
 */
import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

let GIT_HASH = 'unknown';
try {
  // 3s timeout protects against slow filesystems / missing git binary.
  GIT_HASH = execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '../..'), encoding: 'utf8', timeout: 3000 }).trim();
} catch { /* ignore — keep "unknown" fallback */ }

/**
 * Build the Express router that exposes the HTTP API surface.
 *
 * @param {Object} app - Application facade (service locator). Used to
 *   resolve `deviceManager`, `midiRouter`, `database`, `wsServer`.
 * @returns {import('express').Router}
 */
export function createApiRouter(app) {
  const router = Router();

  // Health check (public — excluded from auth middleware)
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: APP_VERSION,
      gitHash: GIT_HASH,
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  });

  // Application status
  router.get('/status', (_req, res) => {
    res.json({
      devices: app.deviceManager.getDeviceList().length,
      routes: app.midiRouter.getRouteList().length,
      files: app.database.getFiles('/').length,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    });
  });

  // Prometheus-compatible metrics
  router.get('/metrics', (_req, res) => {
    const mem = process.memoryUsage();
    const wsClients = app.wsServer?.getStats()?.clients || 0;
    const uptime = process.uptime();

    const lines = [
      '# HELP maestro_uptime_seconds Application uptime in seconds',
      '# TYPE maestro_uptime_seconds gauge',
      `maestro_uptime_seconds ${uptime.toFixed(1)}`,
      '',
      '# HELP maestro_websocket_clients Number of connected WebSocket clients',
      '# TYPE maestro_websocket_clients gauge',
      `maestro_websocket_clients ${wsClients}`,
      '',
      '# HELP maestro_memory_heap_used_bytes Node.js heap used bytes',
      '# TYPE maestro_memory_heap_used_bytes gauge',
      `maestro_memory_heap_used_bytes ${mem.heapUsed}`,
      '',
      '# HELP maestro_memory_rss_bytes Node.js RSS bytes',
      '# TYPE maestro_memory_rss_bytes gauge',
      `maestro_memory_rss_bytes ${mem.rss}`,
      '',
      '# HELP maestro_info Application version info',
      '# TYPE maestro_info gauge',
      `maestro_info{version="${APP_VERSION}"} 1`,
      ''
    ];

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n'));
  });

  // Update status (public — no auth, used by frontend during update)
  router.get('/update-status', (_req, res) => {
    const projectRoot = join(__dirname, '../..');
    const statusFile = join(projectRoot, 'logs', 'update-status');
    const logFile = join(projectRoot, 'logs', 'update.log');

    let status = null;
    let logTail = null;

    if (existsSync(statusFile)) {
      try {
        status = readFileSync(statusFile, 'utf8').trim();
      } catch { /* ignore */ }
    }

    if (existsSync(logFile)) {
      try {
        const full = readFileSync(logFile, 'utf8');
        const lines = full.split('\n');
        logTail = lines.slice(-30).join('\n');
      } catch { /* ignore */ }
    }

    res.json({ status, logTail });
  });

  return router;
}
