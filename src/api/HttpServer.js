// src/api/HttpServer.js
import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

class HttpServer {
  constructor(app) {
    this.app = app;
    this.server = null;
    this.expressApp = express();

    this.setupRoutes();
    this.app.logger.info('HttpServer initialized');
  }

  setupRoutes() {
    // Security headers
    this.expressApp.use(
      helmet({
        contentSecurityPolicy: false, // Disabled for SPA with inline scripts
        crossOriginEmbedderPolicy: false
      })
    );

    // API token authentication (optional, enabled via MAESTRO_API_TOKEN env var)
    const apiToken = process.env.MAESTRO_API_TOKEN;
    if (apiToken) {
      const apiTokenBuf = Buffer.from(apiToken);
      this.expressApp.use('/api', (req, res, next) => {
        if (req.path === '/health') return next(); // Health check always public
        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        try {
          const tokenBuf = Buffer.from(token);
          if (tokenBuf.length !== apiTokenBuf.length || !timingSafeEqual(tokenBuf, apiTokenBuf)) {
            return res.status(401).json({ error: 'Unauthorized' });
          }
        } catch {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
      this.app.logger.info('API token authentication enabled');
    }

    // Serve static files from public directory
    const publicPath = path.join(__dirname, '../../public');
    this.expressApp.use(
      express.static(publicPath, {
        etag: true,
        lastModified: true,
        maxAge: 0 // No caching for development - JS files always fresh
      })
    );

    // API health check
    this.expressApp.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        version: APP_VERSION,
        uptime: process.uptime(),
        timestamp: Date.now()
      });
    });

    // API status
    this.expressApp.get('/api/status', (req, res) => {
      res.json({
        devices: this.app.deviceManager.getDeviceList().length,
        routes: this.app.midiRouter.getRouteList().length,
        files: this.app.database.getFiles('/').length,
        memory: process.memoryUsage(),
        uptime: process.uptime()
      });
    });

    // Prometheus-compatible metrics endpoint
    this.expressApp.get('/api/metrics', (req, res) => {
      const mem = process.memoryUsage();
      const wsClients = this.app.wsServer?.getStats()?.clients || 0;
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
        `# HELP maestro_info Application version info`,
        `# TYPE maestro_info gauge`,
        `maestro_info{version="${APP_VERSION}"} 1`,
        ''
      ];

      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(lines.join('\n'));
    });

    // Fallback to index.html for SPA
    this.expressApp.get('*', (req, res) => {
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      const port = this.app.config.server.port;
      const host = this.app.config.server.host || '0.0.0.0';

      this.server = this.expressApp.listen(port, host, () => {
        this.app.logger.info(`HTTP server listening on http://${host}:${port}`);
        resolve();
      });

      this.server.on('error', (error) => {
        this.app.logger.error(`HTTP server error: ${error.message}`);
        reject(error);
      });
    });
  }

  close() {
    if (this.server) {
      this.server.close(() => {
        this.app.logger.info('HTTP server closed');
      });
    }
  }
}

export default HttpServer;
