// src/api/apiRoutes.js
// Extracted API route handlers — keeps HttpServer focused on server setup.
import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

/**
 * Create an Express Router with all API endpoints.
 * @param {Object} app - Application instance (service locator)
 * @returns {import('express').Router}
 */
export function createApiRouter(app) {
  const router = Router();

  // Health check (public — excluded from auth middleware)
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: APP_VERSION,
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

  return router;
}
