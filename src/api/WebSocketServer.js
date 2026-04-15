// src/api/WebSocketServer.js
import { WebSocketServer as WSServer } from 'ws';
import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ApplicationError } from '../core/errors/index.js';
import { TIMING } from '../constants.js';

const __wsFilename = fileURLToPath(import.meta.url);
const __wsDirname = dirname(__wsFilename);
const wsPkg = JSON.parse(readFileSync(join(__wsDirname, '../../package.json'), 'utf8'));
const APP_VERSION = wsPkg.version;

// WebSocket constants (centralized in constants.js where applicable)
const HEARTBEAT_INTERVAL_MS = TIMING.HEARTBEAT_INTERVAL_MS;
const MAX_WS_CLIENTS = 10; // Max simultaneous WebSocket connections (RPi-friendly)
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024; // 16MB max message size
const RATE_LIMIT_WINDOW_MS = 1000; // Rate limit window: 1 second
const RATE_LIMIT_MAX_MESSAGES = 60; // Max messages per window

class WebSocketServer {
  constructor(deps, httpServer) {
    this.logger = deps.logger;
    this.config = deps.config;
    this._deps = deps;
    this.httpServer = httpServer;
    this.wss = null;
    this.clients = new Set();

    this.logger.info('WebSocketServer initialized');
  }

  start() {
    const apiToken = process.env.MAESTRO_API_TOKEN;
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

  async handleMessage(ws, data) {
    let parsedMessage = null;
    try {
      parsedMessage = JSON.parse(data.toString());

      // Log command with ID
      this.logger.info(`Received command: ${parsedMessage.command} (id: ${parsedMessage.id})`);

      // Dispatch to command handler (await to catch async errors)
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

  handleClose(ws, clientIp) {
    this.clients.delete(ws);
    this.logger.info(`Client disconnected: ${clientIp} (${this.clients.size}/${MAX_WS_CLIENTS})`);
  }

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

  send(ws, type, data) {
    if (ws.readyState === 1) {
      // OPEN
      ws.send(
        JSON.stringify({
          type: type,
          data: data,
          timestamp: Date.now()
        })
      );
    }
  }

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

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send close frame with reason before shutting down
    this.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, 'Server shutting down');
      }
    });

    // Give clients a moment to receive the close frame, then force close
    setTimeout(() => {
      if (this.wss) {
        this.wss.close();
      }
    }, 500);

    this.logger.info('WebSocket server closed');
  }

  getStats() {
    return {
      clients: this.clients.size,
      maxClients: MAX_WS_CLIENTS,
      port: this.config?.server?.port
    };
  }
}

export default WebSocketServer;
