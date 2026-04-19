/**
 * @file src/api/WebSocketServer.js
 * @description WebSocket transport layer. Attaches a `ws` server to the
 * existing HTTP listener so HTTPS and WS share the same port, then
 * forwards every parsed frame to {@link CommandHandler#handle}.
 *
 * Per-connection safeguards (RPi-friendly defaults):
 *   - Hard cap of {@link MAX_WS_CLIENTS} simultaneous clients.
 *   - {@link MAX_PAYLOAD_BYTES} max frame size (16 MB — fits a base64
 *     encoded MIDI file plus headers).
 *   - Sliding-window rate limiter
 *     ({@link RATE_LIMIT_MAX_MESSAGES}/{@link RATE_LIMIT_WINDOW_MS}).
 *   - ping/pong heartbeat that terminates dead sockets after a missed
 *     beat.
 *
 * Auth: same `GMBOOP_API_TOKEN` as the HTTP layer; same-origin browsers
 * connect without a token because the SPA is served from the same host.
 */
import { WebSocketServer as WSServer } from 'ws';
import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ApplicationError } from '../core/errors/index.js';
import { TIMING } from '../core/constants.js';

const __wsFilename = fileURLToPath(import.meta.url);
const __wsDirname = dirname(__wsFilename);
const wsPkg = JSON.parse(readFileSync(join(__wsDirname, '../../package.json'), 'utf8'));
const APP_VERSION = wsPkg.version;

/** Heartbeat ping/pong cadence (ms). */
const HEARTBEAT_INTERVAL_MS = TIMING.HEARTBEAT_INTERVAL_MS;
/** Max simultaneous WebSocket connections (deliberately conservative for Pi). */
const MAX_WS_CLIENTS = 10;
/** Max single-frame size in bytes (16 MB). Headroom above
 *  LIMITS.MAX_MIDI_FILE_SIZE (10 MB) so the `file_write` command,
 *  which carries the full MIDI payload as JSON, can save the largest
 *  files the server is willing to store. Binary upload (new file)
 *  still goes through HTTP `POST /api/files`; this limit covers the
 *  edit-save path. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Rate-limiter sliding-window length (ms). */
const RATE_LIMIT_WINDOW_MS = 1000;
/** Max messages allowed per {@link RATE_LIMIT_WINDOW_MS}. */
const RATE_LIMIT_MAX_MESSAGES = 60;

/**
 * `ws`-backed WebSocket server. One instance per process; constructed by
 * {@link Application#initialize}, started by {@link Application#start}
 * once `HttpServer.server` exists.
 */
class WebSocketServer {
  /**
   * @param {Object} deps - DI bag (or Application facade). Needs at
   *   least `logger`, `config`, `commandHandler`.
   * @param {?import('http').Server} httpServer - The bound HTTP server to
   *   attach to. May be `null` at construction; assigned later by
   *   `Application#start`.
   */
  constructor(deps, httpServer) {
    this.logger = deps.logger;
    this.config = deps.config;
    this._deps = deps;
    this.httpServer = httpServer;
    this.wss = null;
    /** @type {Set<import('ws').WebSocket>} Live client sockets. */
    this.clients = new Set();

    this.logger.info('WebSocketServer initialized');
  }

  /**
   * Build the underlying `ws.Server`, install the upgrade handler with
   * same-origin / token-based auth, register connection / error
   * listeners, and kick off the heartbeat ticker.
   *
   * @returns {void}
   */
  start() {
    const apiToken = process.env.GMBOOP_API_TOKEN;
    const serverPort = this.config?.server?.port || 8080;

    // Attach WebSocket server to existing HTTP server
    this.wss = new WSServer({
      server: this.httpServer,
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient: apiToken
        ? ({ req }, done) => {
            // Allow same-origin connections (frontend served by this server)
            const origin = req.headers.origin || '';
            const host = req.headers.host || '';
            if (origin) {
              try {
                const originUrl = new URL(origin);
                const originHost = originUrl.hostname;
                const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
                const serverHost = host.split(':')[0];
                const srvPort = String(host.split(':')[1] || serverPort);
                if (originHost === serverHost && originPort === srvPort) {
                  done(true);
                  return;
                }
              } catch { /* invalid origin, fall through to token check */ }
            }

            // External connections require token
            const url = new URL(req.url, 'http://localhost');
            const token =
              url.searchParams.get('token') || req.headers['sec-websocket-protocol'] || '';
            try {
              const tokenBuf = Buffer.from(token);
              const apiTokenBuf = Buffer.from(apiToken);
              if (
                tokenBuf.length !== apiTokenBuf.length ||
                !timingSafeEqual(tokenBuf, apiTokenBuf)
              ) {
                this.logger.warn(`WebSocket auth rejected: ${req.socket.remoteAddress}`);
                done(false, 401, 'Unauthorized');
              } else {
                done(true);
              }
            } catch {
              done(false, 401, 'Unauthorized');
            }
          }
        : undefined
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      this.logger.error(`WebSocket server error: ${error.message}`);
    });

    this.startHeartbeat();
    this.logger.info(`WebSocket server attached to HTTP server (max clients: ${MAX_WS_CLIENTS}, max payload: ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB)`);
  }

  /**
   * Per-client setup: enforce {@link MAX_WS_CLIENTS}, send the welcome
   * frame (containing the server version), wire message / close / error
   * listeners and initialise rate-limit + heartbeat state.
   *
   * @param {import('ws').WebSocket} ws
   * @param {import('http').IncomingMessage} req
   * @returns {void}
   */
  handleConnection(ws, req) {
    const clientIp = req.socket.remoteAddress;

    // Enforce connection limit
    if (this.clients.size >= MAX_WS_CLIENTS) {
      this.logger.warn(`Connection rejected (limit ${MAX_WS_CLIENTS} reached): ${clientIp}`);
      ws.close(1013, 'Maximum connections reached');
      return;
    }

    this.logger.info(`Client connected: ${clientIp} (${this.clients.size + 1}/${MAX_WS_CLIENTS})`);

    this.clients.add(ws);

    // Rate limiting state per client
    ws._rateLimit = { count: 0, windowStart: Date.now() };

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'connected',
        data: {
          version: APP_VERSION,
          timestamp: Date.now()
        }
      })
    );

    // Handle messages with rate limiting
    ws.on('message', (data) => {
      // Rate limiting check
      const now = Date.now();
      const rl = ws._rateLimit;
      if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
        rl.count = 0;
        rl.windowStart = now;
      }
      if (++rl.count > RATE_LIMIT_MAX_MESSAGES) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded', timestamp: now }));
        }
        return;
      }

      this.handleMessage(ws, data);
    });

    // Handle close
    ws.on('close', () => {
      this.handleClose(ws, clientIp);
    });

    // Handle error - clean up to prevent leaked connections
    ws.on('error', (error) => {
      this.logger.error(`WebSocket client error: ${error.message}`);
      this.clients.delete(ws);
    });

    // Setup ping/pong for keep-alive
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  }

  /**
   * Parse a raw frame, log it, and dispatch to {@link CommandHandler}.
   * Errors are caught and translated into the `{type:'error'}` wire shape;
   * details are exposed only for {@link ApplicationError} subclasses to
   * avoid leaking internals.
   *
   * @param {import('ws').WebSocket} ws
   * @param {Buffer|string} data - Raw inbound frame payload.
   * @returns {Promise<void>}
   */
  async handleMessage(ws, data) {
    let parsedMessage = null;
    try {
      parsedMessage = JSON.parse(data.toString());

      this.logger.info(`Received command: ${parsedMessage.command} (id: ${parsedMessage.id})`);

      // Awaited so async errors (rejections inside handlers) are caught here
      // instead of becoming unhandled rejections on the Node process.
      await this._deps.commandHandler.handle(parsedMessage, ws);
    } catch (error) {
      this.logger.error(`Failed to process message: ${error.message}`);

      // Send error response with ID if we managed to parse the message
      // Only expose error details for known application errors
      const isAppError = error instanceof ApplicationError;
      const errorResponse = {
        type: 'error',
        error: isAppError ? error.message : 'Internal server error',
        timestamp: Date.now()
      };

      if (parsedMessage && parsedMessage.id) {
        errorResponse.id = parsedMessage.id;
      }

      if (ws.readyState === 1) {
        ws.send(JSON.stringify(errorResponse));
      }
    }
  }

  /**
   * Drop the client from the active set on close. Idempotent.
   *
   * @param {import('ws').WebSocket} ws
   * @param {string} clientIp
   * @returns {void}
   */
  handleClose(ws, clientIp) {
    this.clients.delete(ws);
    this.logger.info(`Client disconnected: ${clientIp} (${this.clients.size}/${MAX_WS_CLIENTS})`);
  }

  /**
   * Send a server-pushed event to every open client. Stale (CLOSING /
   * CLOSED) sockets are pruned during the same iteration to keep the
   * `clients` set free of zombies.
   *
   * @param {string} event - Event name forwarded as the `event` field.
   * @param {*} data - JSON-serialisable payload.
   * @returns {void}
   */
  broadcast(event, data) {
    let message;
    try {
      message = JSON.stringify({
        type: 'event',
        event: event,
        data: data,
        timestamp: Date.now()
      });
    } catch (err) {
      this.logger.error(`Failed to serialize broadcast ${event}: ${err.message}`);
      return;
    }

    let sent = 0;
    const stale = [];
    this.clients.forEach((client) => {
      if (client.readyState === 1) {
        // OPEN
        client.send(message);
        sent++;
      } else if (client.readyState > 1) {
        // CLOSING or CLOSED
        stale.push(client);
      }
    });
    // Remove stale clients
    for (const client of stale) {
      this.clients.delete(client);
    }

    this.logger.debug(`Broadcast ${event} to ${sent} clients`);
  }

  /**
   * Send a single typed frame to one client. Silently drops the call when
   * the socket is not OPEN to avoid `ws` errors on closing connections.
   *
   * @param {import('ws').WebSocket} ws
   * @param {string} type - Frame `type` field.
   * @param {*} data - JSON-serialisable payload.
   * @returns {void}
   */
  send(ws, type, data) {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: type,
          data: data,
          timestamp: Date.now()
        })
      );
    }
  }

  /**
   * Start the periodic ping/pong tick. Sockets that did not pong since
   * the previous tick are terminated and removed — this keeps `clients`
   * accurate even when the network drops without a clean close frame.
   *
   * @returns {void}
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((ws) => {
        if (!ws.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          return;
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat ticker, send a `1001 Going Away` close frame to
   * every client, then shut down the underlying `ws.Server` after a
   * brief grace window so clients have time to receive the close frame.
   *
   * @returns {void}
   */
  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, 'Server shutting down');
      }
    });

    // 500ms is enough for the TCP-level write of the close frame to
    // flush on a LAN; longer would unnecessarily delay shutdown.
    setTimeout(() => {
      if (this.wss) {
        this.wss.close();
      }
    }, 500);

    this.logger.info('WebSocket server closed');
  }

  /**
   * @returns {{clients:number, maxClients:number, port:?number}} Live
   *   stats consumed by `apiRoutes` (`/metrics`) and the boot banner.
   */
  getStats() {
    return {
      clients: this.clients.size,
      maxClients: MAX_WS_CLIENTS,
      port: this.config?.server?.port
    };
  }
}

export default WebSocketServer;
