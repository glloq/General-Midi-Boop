// src/api/HttpServer.js
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { createServer as createHttpsServer } from 'https';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync, existsSync } from 'fs';
import { createApiRouter } from './apiRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class HttpServer {
  constructor(deps) {
    // Support both explicit deps and legacy app object
    this.logger = deps.logger;
    this.config = deps.config;
    this._deps = deps; // Keep reference for lazy service resolution in route handlers
    this.server = null;
    this.expressApp = express();

    this.setupRoutes();
    this.logger.info('HttpServer initialized');
  }

  setupRoutes() {
    // Gzip compression for all responses
    this.expressApp.use(compression());

    // Security headers (CSP disabled — embedded SPA with inline scripts,
    // CORP/COEP disabled — app accessed via IP on local network)
    this.expressApp.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false
      })
    );

    // CORS — restrict to same-origin and localhost
    this.expressApp.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const url = new URL(origin);
          if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === req.hostname) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          }
        } catch { /* invalid origin, ignore */ }
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // API token authentication (enabled via MAESTRO_API_TOKEN env var)
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
      this.logger.info('API token authentication enabled');
    }

    // Serve static files — use dist/ in production if available, public/ otherwise
    const isProduction = process.env.NODE_ENV === 'production';
    const distPath = path.join(__dirname, '../../dist');
    const devPath = path.join(__dirname, '../../public');
    const publicPath = (isProduction && existsSync(path.join(distPath, 'index.html'))) ? distPath : devPath;

    this.expressApp.use(
      express.static(publicPath, {
        etag: true,
        lastModified: true,
        maxAge: isProduction ? '1d' : 0
      })
    );

    // Mount API routes (health, status, metrics)
    this.expressApp.use('/api', createApiRouter(this._deps));

    // Fallback to index.html for SPA
    this.expressApp.get('*', (req, res) => {
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      const port = this.config.server.port;
      const host = this.config.server.host || '0.0.0.0';

      const sslCert = this.config.server.sslCert;
      const sslKey = this.config.server.sslKey;

      if (sslCert && sslKey && existsSync(sslCert) && existsSync(sslKey)) {
        this.server = createHttpsServer({
          cert: readFileSync(sslCert),
          key: readFileSync(sslKey)
        }, this.expressApp);
        this.server.listen(port, host, () => {
          this.logger.info(`HTTPS server listening on https://${host}:${port}`);
          resolve();
        });
      } else {
        this.server = this.expressApp.listen(port, host, () => {
          this.logger.info(`HTTP server listening on http://${host}:${port}`);
          resolve();
        });
      }

      this.server.on('error', (error) => {
        this.logger.error(`HTTP server error: ${error.message}`);
        reject(error);
      });
    });
  }

  close() {
    if (this.server) {
      this.server.close(() => {
        this.logger.info('HTTP server closed');
      });
    }
  }
}

export default HttpServer;
