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
import { Router, raw as expressRaw } from 'express';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LIMITS } from '../core/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

let GIT_HASH = 'unknown';
try {
  // 3s timeout protects against slow filesystems / missing git binary.
  GIT_HASH = execSync('git rev-parse --short HEAD', {
    cwd: join(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 3000
  }).trim();
} catch {
  /* ignore — keep "unknown" fallback */
}

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
      '# HELP gmboop_uptime_seconds Application uptime in seconds',
      '# TYPE gmboop_uptime_seconds gauge',
      `gmboop_uptime_seconds ${uptime.toFixed(1)}`,
      '',
      '# HELP gmboop_websocket_clients Number of connected WebSocket clients',
      '# TYPE gmboop_websocket_clients gauge',
      `gmboop_websocket_clients ${wsClients}`,
      '',
      '# HELP gmboop_memory_heap_used_bytes Node.js heap used bytes',
      '# TYPE gmboop_memory_heap_used_bytes gauge',
      `gmboop_memory_heap_used_bytes ${mem.heapUsed}`,
      '',
      '# HELP gmboop_memory_rss_bytes Node.js RSS bytes',
      '# TYPE gmboop_memory_rss_bytes gauge',
      `gmboop_memory_rss_bytes ${mem.rss}`,
      '',
      '# HELP gmboop_info Application version info',
      '# TYPE gmboop_info gauge',
      `gmboop_info{version="${APP_VERSION}"} 1`,
      ''
    ];

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n'));
  });

  // ==========================================================================
  // MIDI file upload + download
  // ==========================================================================

  // Cap the request body just above MAX_MIDI_FILE_SIZE so we reject oversize
  // payloads before buffering. `application/octet-stream` (or any audio/midi
  // variant) is accepted; the SPA sets Content-Type explicitly.
  const uploadLimit = LIMITS.MAX_MIDI_FILE_SIZE + 64 * 1024;
  router.post('/files', expressRaw({ type: '*/*', limit: uploadLimit }), async (req, res) => {
    try {
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty body. Send raw MIDI bytes.' });
      }
      const filename = String(req.query.filename || '').trim() || 'upload.mid';
      const folder = String(req.query.folder || '/');
      if (!folder.startsWith('/')) {
        return res.status(400).json({ error: 'folder must start with "/"' });
      }
      const uploadId = randomBytes(8).toString('hex');

      const result = await app.uploadQueue.add(uploadId, (report) =>
        app.fileManager.handleUpload(filename, req.body, { folder, report })
      );

      const status = result.status === 'duplicate' ? 200 : 201;
      res.status(status).json({ uploadId, ...result });
    } catch (err) {
      app.logger.error(`POST /api/files failed: ${err.message}`);
      const code = /too large/i.test(err.message)
        ? 413
        : /invalid midi/i.test(err.message)
          ? 415
          : 500;
      res.status(code).json({ error: err.message });
    }
  });

  router.get('/files/:id/blob', (req, res) => {
    try {
      const fileId = Number(req.params.id);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        return res.status(400).json({ error: 'Invalid file id' });
      }
      const file = app.database.getFileInfo(fileId);
      if (!file || !file.blob_path) {
        return res.status(404).json({ error: 'File not found' });
      }
      const abs = app.blobStore.resolve(file.blob_path);
      const stat = statSync(abs);
      res.setHeader('Content-Type', 'audio/midi');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('ETag', `"${file.content_hash}"`);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (req.query.dl) {
        const safeName = String(file.filename).replace(/[^\w.-]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      }
      app.blobStore.readStream(file.blob_path).pipe(res);
    } catch (err) {
      app.logger.error(`GET /api/files/${req.params.id}/blob failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
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
      } catch {
        /* ignore */
      }
    }

    if (existsSync(logFile)) {
      try {
        const full = readFileSync(logFile, 'utf8');
        const lines = full.split('\n');
        logTail = lines.slice(-30).join('\n');
      } catch {
        /* ignore */
      }
    }

    res.json({ status, logTail });
  });

  return router;
}
