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
 * Auth: same `GMBOOP_API_TOKEN` and same `security.mode` as the HTTP layer
 * (resolved once in {@link ../api/securityPolicy.js}). In `trusted-lan`
 * (default) a same-origin browser connects without a token because the SPA is
 * served from the same host; in `secure` the token is required for every
 * connection, loopback included (audit L10 F-108).
 */
import { WebSocketServer as WSServer } from 'ws';
import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ApplicationError } from '../core/errors/index.js';
import { TIMING } from '../core/constants.js';
import { WsOutputQueue } from './WsOutputQueue.js';
import { isSecureMode, isLoopbackAddress } from './securityPolicy.js';

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
/** Max inbound bytes allowed per {@link RATE_LIMIT_WINDOW_MS}. Generous enough
 *  for a legitimate large `file_write` (≤16 MB frame) yet far below what a
 *  60-msg/s flood of max-size frames (~960 MB/s) would push through — that
 *  volume of `toString()` + `JSON.parse` on the main thread would stall the
 *  MIDI scheduler the WsOutputQueue was built to protect (audit A2 D2). */
const RATE_LIMIT_MAX_BYTES = 32 * 1024 * 1024;
/** Extra frames allowed per window for {@link PRIORITY_COMMANDS} once the
 *  normal budget is spent. Deliberately small: the exemption exists so an
 *  operator can always silence the rig, not so a flood can bypass the
 *  limiter (audit L01 F-07). */
const RATE_LIMIT_MAX_PRIORITY = 10;
/** A priority frame is a bare control command; anything larger is not one and
 *  gets no exemption (keeps the 16 MB frame path fully rate-limited). */
const PRIORITY_FRAME_MAX_BYTES = 4096;
/** Bytes of the frame head scanned by {@link peekFrameHead}. */
const FRAME_HEAD_PEEK_BYTES = 192;

/**
 * Commands that must never be dropped by the rate limiter: the operator's
 * "make it stop" controls. This mirrors the exemption the transport layer
 * already implements (`DeviceManager.sendMessageEx` lets Note Off, reset and
 * Channel Mode CCs >= 120 bypass the per-device limiter) — without it, a dense
 * passage on the virtual keyboard (one WS frame per note event) spends the
 * whole window budget and the panic frame that follows is silently discarded.
 * Measured 2026-09-07: under a 200 msg/s flood on one socket, 13 of 19 panic
 * attempts never reached a handler (audit L01 F-07).
 * @type {Set<string>}
 */
const PRIORITY_COMMANDS = new Set([
  'midi_panic',
  'midi_all_notes_off',
  'midi_reset',
  'playback_stop',
  'playback_pause',
  'lighting_all_off',
  'lighting_blackout'
]);

/**
 * Anchored head scan for the envelope's `id` / `command`, used ONLY on the
 * rate-limit path — the full parse still happens in {@link
 * WebSocketServer#handleMessage} for frames that pass.
 *
 * The regex is anchored on the opening brace and only reads the first two
 * key/value pairs, so it can never bind a *nested* `"id"` or `"command"`: when
 * the envelope is not shaped that way it simply matches nothing and the caller
 * degrades to today's behaviour (no id echoed, no exemption). `BackendAPIClient`
 * always serialises `{id, command, data, timestamp}` in that order, so in
 * practice it is exact. Cost is one bounded `toString()` plus one anchored
 * regex — cheap enough to stay on the reject path of a flood, unlike a full
 * `JSON.parse` of a 16 MB frame (audit L01 F-06).
 */
const _HEAD_PAIR = '"(id|command)"\\s*:\\s*(?:"([^"\\\\]{0,64})"|(-?\\d+(?:\\.\\d+)?))';
const FRAME_HEAD_RE = new RegExp(`^\\s*\\{\\s*${_HEAD_PAIR}(?:\\s*,\\s*${_HEAD_PAIR})?`);

/**
 * @param {Buffer|string} data - Raw inbound frame.
 * @returns {{id?:(string|number), command?:string}} Empty object when the head
 *   does not match the expected envelope shape.
 */
export function peekFrameHead(data) {
  try {
    const head =
      typeof data === 'string'
        ? data.slice(0, FRAME_HEAD_PEEK_BYTES)
        : data.subarray(0, FRAME_HEAD_PEEK_BYTES).toString('utf8');
    const m = FRAME_HEAD_RE.exec(head);
    if (!m) return {};
    const out = {};
    const put = (key, str, num) => {
      if (key === 'id') {
        if (str !== undefined) out.id = str;
        else if (num !== undefined) out.id = Number(num);
      } else if (key === 'command' && str !== undefined) {
        out.command = str;
      }
    };
    put(m[1], m[2], m[3]);
    put(m[4], m[5], m[6]);
    return out;
  } catch {
    return {};
  }
}

/** Keys that pollute `Object.prototype` when copied by a naive merge. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `JSON.parse` reviver that drops prototype-pollution keys during parsing.
 * `JSON.parse` materializes `__proto__`/`constructor`/`prototype` as plain own
 * properties (it does not pollute by itself), but any handler that later
 * merges/mass-assigns the payload could — so we strip them at the edge as
 * defense-in-depth (audit A2 D1). Returning `undefined` deletes the key.
 *
 * @param {string} key
 * @param {*} value
 * @returns {*}
 */
export function stripDangerousKeys(key, value) {
  return DANGEROUS_KEYS.has(key) ? undefined : value;
}

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

    // Asynchronous outbound pipeline. Producers (PlaybackScheduler,
    // MidiRouter, audio callbacks) call `broadcast()` from any context
    // and the queue flushes via setImmediate, so the MIDI hot path is
    // never blocked by socket I/O. The eventLoopMonitor is wired later
    // by Application#start, so we expose it through a lazy proxy that
    // reads `_deps.eventLoopMonitor.currentLag` on every flush.
    const self = this;
    const eventLoopMonitorProxy = {
      get currentLag() {
        return self._deps.eventLoopMonitor?.currentLag ?? 0;
      }
    };
    this._outQueue = new WsOutputQueue({
      clients: this.clients,
      logger: this.logger,
      eventLoopMonitor: eventLoopMonitorProxy
    });

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

    // The security mode must cover the WHOLE API surface, not HTTP alone: the
    // WebSocket carries the 270 commands, `system_update` and
    // `system_shutdown` included, with no further authorisation check. Read
    // through the shared resolver so HTTP and WS can never drift apart again
    // (audit L10 F-108).
    const secureMode = isSecureMode(this.config);
    this.logger.info(`WebSocket security mode: ${secureMode ? 'secure' : 'trusted-lan'}`);

    // Soft-warn rather than fail-closed when the token is missing.
    // ApiTokenManager.ensure() runs during boot and is supposed to
    // populate this env, but a misconfigured deployment (token forced
    // to empty in .env, or chmod 000 on .env preventing the write)
    // should not silently lock the user out of their MIDI box. Without
    // a token, only the loopback bypass and the same-origin bypass
    // below remain — that's the legacy behaviour and the SPA served
    // from the same host still works.
    if (!apiToken) {
      this.logger.warn(
        secureMode
          ? 'GMBOOP_API_TOKEN is empty while security.mode=secure — every WebSocket ' +
              'connection will be refused, including the local SPA. Verify ' +
              'ApiTokenManager.ensure() ran successfully.'
          : 'GMBOOP_API_TOKEN is empty — cross-origin clients are refused (only the ' +
              'loopback and same-origin SPA bypasses remain). Verify ' +
              'ApiTokenManager.ensure() ran successfully to enable authenticated remote access.'
      );
    }

    // Always-loopback whitelist. `localhost`, `127.0.0.1`, `::1` are safe
    // bypass targets because they cannot be reached from another host.
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);

    // Attach WebSocket server to existing HTTP server. permessage-deflate
    // is force-disabled: gzip cycles on a Pi cost more than the few KB
    // saved on a LAN, and the binary frames emitted by WsOutputQueue
    // already shrink the high-frequency payloads.
    this.wss = new WSServer({
      server: this.httpServer,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      verifyClient: ({ req }, done) => {
        // `secure` mode: no bypass at all. The token is required for every
        // connection, same-origin and loopback included. This is the mode the
        // documentation points operators to for shared/untrusted networks, and
        // until now it hardened HTTP only (audit L10 F-108).
        if (secureMode) {
          this._verifyToken(req, apiToken, serverPort, done);
          return;
        }

        // Same-origin bypass (trusted-lan mode only). The server typically
        // binds 0.0.0.0 so the SPA can be reached over LAN
        // (http://192.168.1.42:8080) as well as locally — we cannot
        // pre-enumerate every LAN interface, so we accept the request when the
        // Origin matches the inbound Host header (the URL the browser was
        // actually told to use). Both headers are browser-set, so JS in a
        // third-party page cannot forge them — XSS-style attacks therefore
        // still hit the token gate below.
        //
        // A non-browser client CAN match both, so this bypass hands full
        // command access to anything that reaches the port. That is what
        // `trusted-lan` means, and it is exactly what `secure` above closes.
        const origin = req.headers.origin || '';
        const host = req.headers.host || '';
        if (origin) {
          try {
            const originUrl = new URL(origin);
            const originHost = originUrl.hostname;
            const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
            // Loopback short-circuit (no Host needed) — but only when the
            // connection REALLY comes from the loopback interface. `Origin` is
            // forgeable by any non-browser client; the peer address of an
            // accepted TCP connection is not (audit L10 F-108).
            if (
              isLoopbackAddress(req.socket?.remoteAddress) &&
              loopbackHosts.has(originHost) &&
              originPort === String(serverPort)
            ) {
              done(true);
              return;
            }
            // Origin must match the URL the browser was told to use. Parse the
            // Host header via URL so an IPv6 literal (`[::1]:8080`) splits
            // correctly — `split(':')` would turn `[::1]` into `[` and force a
            // legitimate same-origin IPv6 connection to the token gate (audit
            // A2 N3).
            let serverHost = '';
            let srvPort = String(serverPort);
            try {
              const hostUrl = new URL(`http://${host}`);
              serverHost = hostUrl.hostname;
              srvPort = hostUrl.port || String(serverPort);
            } catch {
              /* malformed Host header — no same-origin match */
            }
            if (serverHost && originHost === serverHost && originPort === srvPort) {
              done(true);
              return;
            }
          } catch {
            /* invalid origin, fall through to token check */
          }
        }

        // External (cross-origin) connections must present the token.
        this._verifyToken(req, apiToken, serverPort, done);
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      this.logger.error(`WebSocket server error: ${error.message}`);
    });

    this.startHeartbeat();
    this.logger.info(
      `WebSocket server attached to HTTP server (max clients: ${MAX_WS_CLIENTS}, max payload: ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB)`
    );
  }

  /**
   * Constant-time bearer-token check for the WebSocket upgrade. The token
   * travels either as the `token` query parameter or as the
   * `Sec-WebSocket-Protocol` header. Calls `done(true)` on success and
   * `done(false, 401, 'Unauthorized')` on every failure — including the
   * "no token configured" case, where there is no secret to match and
   * `timingSafeEqual(Buffer.from(''), Buffer.from(''))` would otherwise
   * return true and accept a credential-less socket (audit A2 C1).
   *
   * @param {import('http').IncomingMessage} req
   * @param {?string} apiToken - Expected token (`GMBOOP_API_TOKEN`).
   * @param {number|string} serverPort - Logged so operators can tell a stale
   *   build from a genuine header mismatch.
   * @param {Function} done - `ws` verifyClient callback.
   * @returns {void}
   * @private
   */
  _verifyToken(req, apiToken, serverPort, done) {
    const describe = () =>
      `ip=${req.socket?.remoteAddress} origin=${req.headers.origin || '(none)'} ` +
      `host=${req.headers.host || '(none)'}`;

    if (!apiToken) {
      this.logger.warn(`WebSocket auth rejected (no token configured): ${describe()}`);
      done(false, 401, 'Unauthorized');
      return;
    }

    let token = '';
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token') || req.headers['sec-websocket-protocol'] || '';
    } catch {
      token = req.headers['sec-websocket-protocol'] || '';
    }

    try {
      const tokenBuf = Buffer.from(token);
      const apiTokenBuf = Buffer.from(apiToken);
      if (tokenBuf.length !== apiTokenBuf.length || !timingSafeEqual(tokenBuf, apiTokenBuf)) {
        // Include the headers we just compared so operators can tell
        // apart "running the old build" from "headers don't actually
        // match" without instrumenting the runtime.
        this.logger.warn(`WebSocket auth rejected: ${describe()} expectedPort=${serverPort}`);
        done(false, 401, 'Unauthorized');
      } else {
        done(true);
      }
    } catch {
      done(false, 401, 'Unauthorized');
    }
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
      // Attach an error listener BEFORE closing. A ws that emits 'error' with
      // no listener throws ("Unhandled 'error' event"), which bubbles to the
      // process uncaughtException handler and shuts the server down — a
      // remotely-triggerable DoS if an over-limit peer resets during the close
      // handshake.
      ws.on('error', () => {});
      ws.close(1013, 'Maximum connections reached');
      return;
    }

    this.logger.info(`Client connected: ${clientIp} (${this.clients.size + 1}/${MAX_WS_CLIENTS})`);

    this.clients.add(ws);

    // Rate limiting state per client (message count + byte volume per window)
    ws._rateLimit = { count: 0, bytes: 0, priority: 0, windowStart: Date.now() };

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
      // Rate limiting check — bound BOTH the message count and the byte volume
      // per window. Counting messages alone lets 60 × 16 MB frames/s through,
      // saturating the main thread with JSON.parse and stalling MIDI timing
      // (audit A2 D2).
      const now = Date.now();
      const rl = ws._rateLimit;
      if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
        rl.count = 0;
        rl.bytes = 0;
        rl.priority = 0;
        rl.windowStart = now;
      }
      rl.bytes += data.length || 0;
      if (++rl.count > RATE_LIMIT_MAX_MESSAGES || rl.bytes > RATE_LIMIT_MAX_BYTES) {
        // Over budget. Peek at the envelope head once and use it for both the
        // panic exemption (F-07) and the correlation id (F-06).
        const head = peekFrameHead(data);
        const isPriority =
          head.command !== undefined &&
          PRIORITY_COMMANDS.has(head.command) &&
          (data.length || 0) <= PRIORITY_FRAME_MAX_BYTES &&
          ++rl.priority <= RATE_LIMIT_MAX_PRIORITY;

        if (!isPriority) {
          if (ws.readyState === 1) {
            // Echo the request id so the client can settle THAT promise instead
            // of waiting out its 10 s timeout. Measured before the fix: 40 of
            // 100 commands hung 9 999-10 000 ms each (audit L01 F-06).
            ws.send(
              JSON.stringify({
                ...(head.id !== undefined ? { id: head.id } : {}),
                type: 'error',
                error: 'Rate limit exceeded',
                code: 'ERR_RATE_LIMITED',
                timestamp: now
              })
            );
          }
          return;
        }
      }

      // handleMessage has its own try/catch; the only residual reject vector is
      // a throw inside that catch (e.g. send on a just-closed socket). Swallow
      // it so it never surfaces as an unhandled rejection (audit A2 N2).
      this.handleMessage(ws, data).catch(() => {});
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
      parsedMessage = JSON.parse(data.toString(), stripDangerousKeys);

      // Per-message debug — gated so the template string is not built when
      // the log level filters it out (60 msg/s rate limit applies upstream).
      if (this.logger.isDebugEnabled?.()) {
        this.logger.debug(`Received command: ${parsedMessage?.command} (id: ${parsedMessage?.id})`);
      }

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

      // Guard the send: the socket can transition to CLOSED between the
      // readyState check and the write, and an unguarded throw here would
      // reject the (now caught) handleMessage promise (audit A2 N2).
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(errorResponse));
        }
      } catch (sendErr) {
        this.logger.warn(`Failed to send WS error response: ${sendErr.message}`);
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
   * Enqueue a server-pushed event for every open client. Returns
   * immediately — the actual send happens on the next event-loop turn
   * via {@link WsOutputQueue}, which also implements:
   *   - per-event-type coalescing for high-frequency payloads
   *     (playback_position, monitor_event, tuner:pitch, ...)
   *   - per-client backpressure (skip when bufferedAmount exceeds
   *     the high-water mark)
   *   - binary wire format for events with a registered encoder
   *     (see {@link ../../shared/BinaryFrameCodec.js})
   *   - pruning of CLOSING/CLOSED sockets
   *
   * The function signature is preserved so producers (PlaybackScheduler,
   * MidiRouter, audio callbacks) don't change.
   *
   * @param {string} event - Event name forwarded as the `event` field.
   * @param {*} data - JSON-serialisable payload.
   * @returns {void}
   */
  broadcast(event, data) {
    this._outQueue.broadcast(event, data);
  }

  /**
   * @returns {Object} Live counters from the output queue. Exposed for
   *   `/metrics` and the benchmark suite.
   */
  getOutputStats() {
    return this._outQueue.getStats();
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
    // Don't keep the event loop alive solely for the heartbeat — if the
    // app is otherwise shutting down, this lets `process.exit` happen
    // (AUDIT 2026-05-10 §28).
    if (typeof this.heartbeatInterval.unref === 'function') {
      this.heartbeatInterval.unref();
    }
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

    // Stop accepting new outbound events; any pending entry is dropped.
    this._outQueue.close();

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
