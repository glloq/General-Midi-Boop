// src/api/HttpServer.js
import express from 'express';
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
    // Serve static files from public directory
    const publicPath = path.join(__dirname, '../../public');
    this.expressApp.use(express.static(publicPath, {
      etag: true,
      lastModified: true,
      maxAge: 0 // No caching for development - JS files always fresh
    }));

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