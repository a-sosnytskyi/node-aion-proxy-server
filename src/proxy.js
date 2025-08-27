/**
 * @fileoverview WebSocket and HTTP proxy server with bidirectional message forwarding
 */

const http = require('http');
const httpProxy = require('http-proxy-middleware');
const WebSocket = require('ws');
const url = require('url');
const { loadConfig } = require("./config-loader");

/**
 * WebSocket and HTTP proxy server
 * @class
 */
class Proxy {
  /**
   * Create a proxy server instance
   * @param {Object} [config={}] - Configuration options
   * @param {number} [config.port=8080] - Server port
   * @param {string} [config.httpTarget] - HTTP proxy target URL
   * @param {string} [config.wsTarget] - WebSocket proxy target URL
   * @param {number} [config.connectionTimeout=10000] - Connection timeout in ms
   */
  constructor(config = {}) {
    this.port = config.port || 8080;
    this.httpTarget = config.httpTarget;
    this.wsTarget = config.wsTarget;
    this.connectionTimeout = config.connectionTimeout || 10000;

    this.server = http.createServer();
    this.setupHttpProxy();
    this.setupWebSocketUpgrade();
  }

  /**
   * Configure HTTP proxy middleware with CORS support
   * @private
   */
  setupHttpProxy() {
    if (!this.httpTarget) return;

    const httpProxyMiddleware = httpProxy.createProxyMiddleware({
      target: this.httpTarget,
      changeOrigin: true,
      ws: false,
      onError: (err, req, res) => {
        console.error('HTTP Proxy Error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
      },
    });

    this.server.on('request', (req, res) => {
      // Add basic CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      console.log(`HTTP ${req.method} ${req.url} -> ${this.httpTarget}`);
      httpProxyMiddleware(req, res);
    });
  }

  /**
   * Setup WebSocket upgrade request handler
   * @private
   */
  setupWebSocketUpgrade() {
    this.server.on('upgrade', (request, socket, head) => {
      if (!this.wsTarget) {
        console.error('No WebSocket target configured');
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log(`WebSocket upgrade: ${request.url} -> ${this.wsTarget}`);
      this.handleWebSocketUpgrade(request, socket, head);
    });
  }

  /**
   * Handle WebSocket upgrade and establish target connection
   * @private
   * @param {http.IncomingMessage} request - HTTP upgrade request
   * @param {net.Socket} socket - Client socket
   * @param {Buffer} head - Upgrade head buffer
   */
  async handleWebSocketUpgrade(request, socket, head) {
    try {
      const parsedUrl = url.parse(request.url, true);
      const targetWsUrl = `${this.wsTarget}${parsedUrl.pathname || ''}${parsedUrl.search || ''}`;

      console.log(`Connecting to: ${targetWsUrl}`);

      // Prepare headers to forward
      const headers = this.getProxyHeaders(request);
      const clientProtocol = request.headers['sec-websocket-protocol'];

      // Create WebSocket connection to target
      const wsOptions = {
        headers: headers,
        handshakeTimeout: this.connectionTimeout
      };

      const targetWs = clientProtocol
        ? new WebSocket(targetWsUrl, clientProtocol, wsOptions)
        : new WebSocket(targetWsUrl, wsOptions);

      // Handle connection timeout
      const timeout = setTimeout(() => {
        if (targetWs.readyState === WebSocket.CONNECTING) {
          console.error('Connection timeout');
          targetWs.terminate();
          socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
          socket.destroy();
        }
      }, this.connectionTimeout);

      targetWs.on('open', () => {
        clearTimeout(timeout);
        console.log('Connected to target WebSocket');

        // Upgrade client connection
        const wss = new WebSocket.Server({ noServer: true });
        wss.handleUpgrade(request, socket, head, (clientWs) => {
          this.establishProxy(clientWs, targetWs, parsedUrl.pathname || '/');
        });
      });

      targetWs.on('error', (error) => {
        clearTimeout(timeout);
        console.error('Target WebSocket error:', error.message);

        if (!socket.destroyed) {
          const statusCode = error.message.includes('401') || error.message.includes('403') ? 401 : 502;
          socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Bad Gateway'}\r\n\r\n`);
          socket.destroy();
        }
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        console.error('Socket error:', error.message);
        if (targetWs.readyState !== WebSocket.CLOSED) {
          targetWs.close();
        }
      });

    } catch (error) {
      console.error('Error in handleWebSocketUpgrade:', error.message);
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
    }
  }

  /**
   * Establish bidirectional WebSocket proxy with message forwarding
   * @private
   * @param {WebSocket} clientWs - Client WebSocket connection
   * @param {WebSocket} targetWs - Target WebSocket connection
   * @param {string} pathname - Request pathname for logging
   */
  establishProxy(clientWs, targetWs, pathname) {
    console.log(`WebSocket proxy established for ${pathname}`);

    let messageCount = 0;
    let isActive = true;

    const cleanup = () => {
      if (isActive) {
        isActive = false;
        console.log(`WebSocket proxy closed for ${pathname} (${messageCount} messages)`);
      }
    };

    // Forward messages between client and target
    clientWs.on('message', (data) => {
      if (isActive && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data.toString());
        messageCount++;
      }
    });

    targetWs.on('message', (data) => {
      if (isActive && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
        messageCount++;
      }
    });

    // Handle connection closes
    clientWs.on('close', (code, reason) => {
      cleanup();
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(code, reason);
      }
    });

    targetWs.on('close', (code, reason) => {
      cleanup();
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    // Handle errors
    clientWs.on('error', (error) => {
      console.error(`Client WebSocket error:`, error.message);
      cleanup();
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close();
      }
    });

    targetWs.on('error', (error) => {
      console.error(`Target WebSocket error:`, error.message);
      cleanup();
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    });

    // Simple keepalive
    const keepAlive = setInterval(() => {
      if (!isActive) {
        clearInterval(keepAlive);
        return;
      }

      if (targetWs.readyState === WebSocket.OPEN) targetWs.ping();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
    }, 30000);
  }

  /**
   * Extract and filter headers to forward to target server
   * @private
   * @param {http.IncomingMessage} request - HTTP request
   * @returns {Object} Filtered headers object
   */
  getProxyHeaders(request) {
    const headers = {};

    // Forward essential headers
    const forwardHeaders = [
      'authorization',
      'cookie',
      'user-agent',
      'sec-websocket-protocol',
      'origin'
    ];

    forwardHeaders.forEach(name => {
      if (request.headers[name]) {
        headers[name] = request.headers[name];
      }
    });

    return headers;
  }

  /**
   * Start the proxy server
   * @returns {Promise<void>} Promise that resolves when server starts
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, (error) => {
        if (error) {
          reject(error);
          return;
        }

        console.log(`WebSocket Proxy Server running on port ${this.port}`);
        console.log(`HTTP target: ${this.httpTarget || 'none'}`);
        console.log(`WebSocket target: ${this.wsTarget || 'none'}`);
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server gracefully
   * @returns {Promise<void>} Promise that resolves when server stops
   */
  stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('WebSocket Proxy Server stopped');
        resolve();
      });
    });
  }
}

// Create and start proxy server
const proxy = new Proxy(loadConfig());

proxy.start().then(() => {
  console.log('Press Ctrl+C to stop the server');
}).catch((error) => {
  console.error('Failed to start proxy server:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    await proxy.stop();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error.message);
    process.exit(1);
  }
});

module.exports = Proxy;
