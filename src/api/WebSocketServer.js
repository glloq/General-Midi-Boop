// src/api/WebSocketServer.js
import { WebSocketServer as WSServer } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __wsFilename = fileURLToPath(import.meta.url);
const __wsDirname = dirname(__wsFilename);
const wsPkg = JSON.parse(readFileSync(join(__wsDirname, '../../package.json'), 'utf8'));
const APP_VERSION = wsPkg.version;

// WebSocket timing constants
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds between heartbeat pings

class WebSocketServer {
  constructor(app, httpServer) {
    this.app = app;
    this.httpServer = httpServer;
    this.wss = null;
    this.clients = new Set();

    this.app.logger.info('WebSocketServer initialized');
  }

  start() {
    // Attach WebSocket server to existing HTTP server
    this.wss = new WSServer({
      server: this.httpServer
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      this.app.logger.error(`WebSocket server error: ${error.message}`);
    });

    this.startHeartbeat();
    this.app.logger.info(`WebSocket server attached to HTTP server`);
  }

  handleConnection(ws, req) {
    const clientIp = req.socket.remoteAddress;
    this.app.logger.info(`Client connected: ${clientIp}`);
    
    this.clients.add(ws);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'event',
      event: 'connected',
      data: {
        version: APP_VERSION,
        timestamp: Date.now()
      }
    }));

    // Handle messages
    ws.on('message', (data) => {
      this.handleMessage(ws, data);
    });

    // Handle close
    ws.on('close', () => {
      this.handleClose(ws, clientIp);
    });

    // Handle error - clean up to prevent leaked connections
    ws.on('error', (error) => {
      this.app.logger.error(`WebSocket client error: ${error.message}`);
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
      this.app.logger.info(`Received command: ${parsedMessage.command} (id: ${parsedMessage.id})`);

      // Dispatch to command handler (await to catch async errors)
      await this.app.commandHandler.handle(parsedMessage, ws);
    } catch (error) {
      this.app.logger.error(`Failed to process message: ${error.message}`);

      // Send error response with ID if we managed to parse the message
      const errorResponse = {
        type: 'error',
        error: error.message || 'Invalid message format',
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
    this.app.logger.info(`Client disconnected: ${clientIp}`);
  }

  broadcast(event, data) {
    const message = JSON.stringify({
      type: 'event',
      event: event,
      data: data,
      timestamp: Date.now()
    });

    let sent = 0;
    const stale = [];
    this.clients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
        sent++;
      } else if (client.readyState > 1) { // CLOSING or CLOSED
        stale.push(client);
      }
    });
    // Prune stale clients
    for (const client of stale) {
      this.clients.delete(client);
    }

    this.app.logger.debug(`Broadcast ${event} to ${sent} clients`);
  }

  send(ws, type, data) {
    if (ws.readyState === 1) { // OPEN
      ws.send(JSON.stringify({
        type: type,
        data: data,
        timestamp: Date.now()
      }));
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach(ws => {
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

    this.clients.forEach(client => {
      client.close();
    });

    if (this.wss) {
      this.wss.close();
    }

    this.app.logger.info('WebSocket server closed');
  }

  getStats() {
    return {
      clients: this.clients.size,
      port: this.app?.config?.server?.port
    };
  }
}

export default WebSocketServer;