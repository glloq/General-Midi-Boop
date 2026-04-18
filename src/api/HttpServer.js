/**
 * @file src/api/HttpServer.js
 * @description Boots the Express application that serves the SPA, the
 * `/api/*` routes (defined in {@link createApiRouter}) and acts as the
 * upgrade target for {@link WebSocketServer}.
 *
 * Responsibilities wired in {@link HttpServer#setupRoutes}:
 *   - gzip compression for every response
 *   - `helmet` security headers (CSP/CORP/COEP intentionally relaxed —
 *     embedded SPA with inline scripts, accessed over LAN by IP)
 *   - same-origin / localhost CORS allowlist
 *   - bearer-token auth on `/api/*` (skipped for `/health` and
 *     `/update-status` so the dashboard can poll while updating)
 *   - static asset serving (`dist/` in production, `public/` otherwise)
 *   - SPA fallback to `index.html`
 *
 * TLS is opt-in: when both `server.sslCert` and `server.sslKey` exist on
 * disk an HTTPS server is created instead of plain HTTP.
 */
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

/**
 * Express HTTP/HTTPS server. One instance per process; constructor
 * builds the express app and wires every middleware/route. Call
 * {@link HttpServer#start} to bind the listener.
 */
class HttpServer {
  /**
   * @param {Object} deps - DI bag (or Application facade). Needs
   *   `logger`, `config`, and is also stored on `this._deps` so that
   *   lazy services consumed inside route handlers (e.g. wsServer,
   *   deviceManager) are resolved through the container.
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.config = deps.config;
    // Stored so route handlers can look up services that may not yet exist
    // at construction time (HttpServer is built before WebSocketServer).
    this._deps = deps;
    this.server = null;
    this.expressApp = express();

    this.setupRoutes();
    this.logger.info('HttpServer initialized');
  }

  /**
   * Wire every middleware and route on the underlying Express app.
   * Idempotent only if called once — re-invoking would stack middleware.
   *
   * @returns {void}
   */
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

    // Bearer-token auth, enabled when MAESTRO_API_TOKEN is set.
    // `Application#_ensureApiToken` guarantees this is the case in normal
    // runs, so the `if` is mostly for tests that intentionally clear it.
    const apiToken = process.env.MAESTRO_API_TOKEN;
    if (apiToken) {
      const apiTokenBuf = Buffer.from(apiToken);
      this.expressApp.use('/api', (req, res, next) => {
        // Public endpoints used by the frontend dashboard during update.
        if (req.path === '/health' || req.path === '/update-status') return next();

        // Same-origin SPA bypass: mirrors WebSocketServer.verifyClient.
        // The CORS middleware above already restricts the Origin header to
        // localhost / the request host, so an Origin echo here is a strong
        // same-origin signal.
        const origin = req.headers.origin;
        if (origin) {
          try {
            const url = new URL(origin);
            if (url.hostname === 'localhost'
                || url.hostname === '127.0.0.1'
                || url.hostname === req.hostname) {
              return next();
            }
          } catch { /* fall through to token check */ }
        }

        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        try {
          const tokenBuf = Buffer.from(token);
          // Constant-time comparison to defeat timing oracles. Length
          // mismatch must short-circuit BEFORE timingSafeEqual since that
          // function throws on differing lengths.
          if (tokenBuf.length !== apiTokenBuf.length || !timingSafeEqual(tokenBuf, apiTokenBuf)) {
            return res.status(401).json({ error: 'Unauthorized' });
          }
        } catch {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
      this.logger.info('API token authentication enabled (same-origin bypass for SPA)');
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

  /**
   * Bind the configured port and start accepting connections. Resolves
   * once the listener is up; rejects on bind/listen errors.
   *
   * Selects HTTPS when both `server.sslCert` and `server.sslKey` are
   * present and exist on disk; otherwise falls back to plain HTTP.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Stop accepting new connections and close existing keep-alives.
   * Async work is fire-and-forget — no await — because the caller
   * (Application#stop) does not depend on the close completing.
   *
   * @returns {void}
   */
  close() {
    if (this.server) {
      this.server.close(() => {
        this.logger.info('HTTP server closed');
      });
    }
  }
}

export default HttpServer;
