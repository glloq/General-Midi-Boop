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
import { createCaptivePortalMiddleware } from './middleware/captivePortal.js';
import { isSecureMode, isPrivateAddress } from './securityPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A request path that looks like a file (last segment carries an extension) is
 * an asset request, never an SPA route — this SPA has no client-side history
 * routing, so every navigable URL is extension-less. Used by the catch-all to
 * answer 404 instead of the index shell (audit L11 F-119 / L08 F-88).
 *
 * Exported for the regression test in `tests/audit/r6-static-asset-404.test.js`.
 */
export const ASSET_PATH = /\.[a-z0-9]{1,12}$/i;

/**
 * Return true when the request originates from a private network (RFC 1918,
 * link-local 169.254/16, loopback, IPv6 ULA fc00::/7 or ::1). Used to bypass
 * the Bearer-token check for trusted LAN/loopback clients when no header-
 * based same-origin signal is available — browsers with strong privacy
 * settings (Referrer-Policy: no-referrer + Sec-Fetch-* stripping extensions)
 * send neither Origin nor Sec-Fetch-Site, so the source IP is the only
 * remaining hint.
 *
 * Public IPs always fall through to the token check, so an internet-exposed
 * instance still requires authentication.
 *
 * The address predicate itself lives in `securityPolicy.js` so the HTTP and
 * WebSocket layers share one definition (audit L10 F-108/F-114).
 */
function isPrivateClient(req) {
  return isPrivateAddress(req.ip || req.socket?.remoteAddress || '');
}

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
   * Constant-time bearer-token check. Calls `next()` on success or sends
   * 401 on failure. Length mismatch short-circuits before `timingSafeEqual`
   * (which throws on differing lengths).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   * @param {Buffer} apiTokenBuf
   * @returns {void}
   * @private
   */
  _checkBearer(req, res, next, apiTokenBuf) {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    try {
      const tokenBuf = Buffer.from(token);
      if (tokenBuf.length !== apiTokenBuf.length || !timingSafeEqual(tokenBuf, apiTokenBuf)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }

  /**
   * Wire every middleware and route on the underlying Express app.
   * Idempotent only if called once — re-invoking would stack middleware.
   *
   * @returns {void}
   */
  setupRoutes() {
    // Captive-portal redirect (active only while the WiFi hotspot is up).
    // Mounted before compression/helmet/CORS so probe requests issued by
    // mobile OSes get a clean 302 untouched by the rest of the pipeline.
    this.expressApp.use(
      createCaptivePortalMiddleware({
        hotspotManager: this._deps.hotspotManager,
        logger: this.logger
      })
    );

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
          if (
            url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === req.hostname
          ) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          }
        } catch {
          /* invalid origin, ignore */
        }
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Bearer-token auth, enabled when GMBOOP_API_TOKEN is set.
    // `Application#_ensureApiToken` guarantees this is the case in normal
    // runs, so the `if` is mostly for tests that intentionally clear it.
    // Security mode (audit P2). `trusted-lan` (default) keeps the
    // convenience bypasses for same-origin SPA and RFC1918/loopback
    // clients. `secure` requires the bearer token for EVERY non-public
    // request — no same-origin or private-network exception — for
    // deployments on shared/untrusted networks. Set via GMBOOP_SECURITY_MODE
    // or config.security.mode.
    const secureMode = isSecureMode(this.config);
    this.logger.info(`HTTP security mode: ${secureMode ? 'secure' : 'trusted-lan'}`);

    const apiToken = process.env.GMBOOP_API_TOKEN;
    if (apiToken) {
      const apiTokenBuf = Buffer.from(apiToken);
      this.expressApp.use('/api', (req, res, next) => {
        // Public endpoints: liveness + update polling + capability probe.
        if (
          req.path === '/health' ||
          req.path === '/update-status' ||
          req.path === '/capabilities'
        ) {
          return next();
        }

        // In secure mode every other request must present the token — skip
        // all convenience bypasses below.
        if (secureMode) {
          return this._checkBearer(req, res, next, apiTokenBuf);
        }

        // trusted-lan bypasses, anchored on the SOURCE ADDRESS (audit L10
        // F-114). Three gates used to run here: `Sec-Fetch-Site: same-origin`,
        // `Origin ∈ {localhost, 127.0.0.1, req.hostname}` and
        // `isPrivateClient(req)`. The first two are browser-set signals, but a
        // non-browser client sends whatever headers it likes — measured:
        // `curl -H "Sec-Fetch-Site: same-origin"` and
        // `curl -H "Origin: http://127.0.0.1:<port>"` both returned 200
        // without a token, and a WRONG token passed too because these gates
        // were evaluated BEFORE `_checkBearer`. They granted a direct WAN
        // client exactly the access the token exists to deny, so they are now
        // subsumed by the one signal a client cannot forge: the peer address
        // of the accepted connection.
        //
        // What that means, stated plainly: in `trusted-lan` any client whose
        // source address is private (RFC 1918, link-local, loopback, IPv6 ULA)
        // has full API access, token or not. This is also the only signal left
        // for browsers configured to strip Sec-Fetch-* and Origin headers via
        // privacy extensions.
        //
        // Two consequences worth knowing before deploying:
        //   - a client reaching the box on a PUBLIC address (a routed IPv6
        //     GUA, a port-forward) now needs the token, even from a browser;
        //   - any local reverse proxy or tunnel makes every request look like
        //     127.0.0.1 (`trust proxy` is deliberately not set, so
        //     `X-Forwarded-For` is never honoured). Behind one of those, this
        //     bypass is worthless and `security.mode=secure` is mandatory.
        if (isPrivateClient(req)) {
          return next();
        }

        return this._checkBearer(req, res, next, apiTokenBuf);
      });
      this.logger.info(
        secureMode
          ? 'API token authentication enabled (secure mode — token required for all requests)'
          : 'API token authentication enabled (same-origin/LAN bypass for SPA)'
      );
    }

    // Serve static files — use dist/ in production if available, public/ otherwise
    const isProduction = process.env.NODE_ENV === 'production';
    const distPath = path.join(__dirname, '../../dist');
    const devPath = path.join(__dirname, '../../public');
    const publicPath =
      isProduction && existsSync(path.join(distPath, 'index.html')) ? distPath : devPath;

    this.expressApp.use(
      express.static(publicPath, {
        etag: true,
        lastModified: true,
        maxAge: isProduction ? '1d' : 0
      })
    );

    // Mount API routes (health, status, metrics)
    this.expressApp.use('/api', createApiRouter(this._deps));

    // Any /api path that reached this point matched no route (unknown endpoint
    // or unsupported method). Answer with JSON here, BEFORE the SPA fallback:
    // without it, `GET /api/typo` returned 200 + the whole 615 KB index.html,
    // so an API client could not tell "no such endpoint" from "here is your
    // page" and a mistyped path cost 615 KB instead of ~40 bytes
    // (audit L01 F-10). Non-/api paths are untouched and still get the SPA.
    this.expressApp.use('/api', (_req, res) => {
      res.status(404).json({ error: 'Not found', code: 'ERR_NOT_FOUND' });
    });

    // Fallback to index.html for SPA
    this.expressApp.get('*', (req, res) => {
      // A path that carries a file extension is an ASSET request, not an SPA
      // route: this SPA has no client-side history routing at all (nothing
      // calls pushState), so every navigable URL is extension-less.
      //
      // Answering such a request with index.html produced HTTP 200 +
      // `text/html` where the browser expected JS/CSS — 615 KB of shell under
      // the identity of a script. That turned a missing file into a SILENT
      // failure: no 404 ever reached the logs, and the SPA's
      // `typeof WebAudioFontPlayer === 'undefined'` guard was unconditionally
      // true, so the offline-first box always reached for a CDN
      // (audit L11 F-119 / L08 F-88). Same class as F-10 on /api/*, fixed
      // above.
      if (ASSET_PATH.test(req.path)) {
        return res.status(404).type('text/plain').send('Not found');
      }
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
        this.server = createHttpsServer(
          {
            cert: readFileSync(sslCert),
            key: readFileSync(sslKey)
          },
          this.expressApp
        );
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
