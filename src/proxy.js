const http = require('http');
const httpProxy = require('http-proxy-middleware');
const WebSocket = require('ws');
const url = require('url');
const { loadConfig } = require("./config-loader");

/**
 * Simplified WebSocket Proxy Server
 * Auto-detects protocol and uses client headers for WebSocket protocol
 */
class Proxy {
  constructor(config = {}) {
    this.port = config.port || 8080;
    this.httpTarget = config.httpTarget;
    this.wsTarget = config.wsTarget;
    this.connectionTimeout = config.connectionTimeout || 15000;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;

    // Create an HTTP server
    this.server = http.createServer();

    // Setup proxy middleware for HTTP requests
    this.setupHttpProxy();

    // Setup WebSocket server
    this.setupWebSocketUpgrade();
  }

  /**
   * Setup HTTP proxy middleware for regular HTTP requests
   */
  setupHttpProxy() {
    if (!this.httpTarget) {
      console.warn('No HTTP target configured');
      return;
    }

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
      // Add CORS headers if needed
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
   * Setup WebSocket upgrade handler
   */
  setupWebSocketUpgrade() {
    this.server.on('upgrade', async (request, socket, head) => {
      if (!this.wsTarget) {
        console.error('No WebSocket target configured');
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
        return;
      }

      const parsedUrl = url.parse(request.url, true);
      console.log(`WebSocket upgrade: ${request.url} -> ${this.wsTarget}`);
      console.log('WebSocket connection from:', request.headers.origin);

      await this.handleWebSocketUpgrade(request, socket, head);
    });
  }

  /**
   * Handle WebSocket upgrade request
   */
  async handleWebSocketUpgrade(request, socket, head) {
    let retries = 0;

    const attemptConnection = async () => {
      try {
        const parsedUrl = url.parse(request.url, true);

        // Build target WebSocket URL with path and query
        const targetWsUrl = this.buildTargetWebSocketUrl(parsedUrl.pathname, parsedUrl.search || '');

        console.log(`Creating WebSocket connection to: ${targetWsUrl} (attempt ${retries + 1})`);

        // Get protocol from client headers
        const clientProtocol = request.headers['sec-websocket-protocol'];
        const headers = this.getProxyHeaders(request);

        console.log(`Client WebSocket protocol: ${clientProtocol || 'none'}`);

        // Create WebSocket connection with enhanced options
        const wsOptions = {
          headers: headers,
          followRedirects: true,
          maxRedirects: 3,
          perMessageDeflate: false,
          handshakeTimeout: 10000
        };

        // Create WebSocket connection with client's protocol if specified
        const targetWs = clientProtocol
          ? new WebSocket(targetWsUrl, clientProtocol, wsOptions)
          : new WebSocket(targetWsUrl, wsOptions);

        let clientWs = null;
        let isUpgraded = false;
        let connectionClosed = false;

        // Handle target connection timeout
        const connectionTimeout = setTimeout(() => {
          if (!isUpgraded && !connectionClosed) {
            console.error(`Target connection timeout: ${targetWsUrl} (attempt ${retries + 1})`);
            connectionClosed = true;

            if (retries < this.maxRetries) {
              retries++;
              setTimeout(() => attemptConnection(), this.retryDelay * retries);
              return;
            }

            socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
            socket.destroy();
            if (targetWs.readyState !== WebSocket.CLOSED) {
              targetWs.close();
            }
          }
        }, this.connectionTimeout);

        // Handle target WebSocket connection
        targetWs.on('open', () => {
          if (connectionClosed) return;

          clearTimeout(connectionTimeout);
          console.log('Connected to target WebSocket server:', targetWsUrl);

          if (targetWs.protocol) {
            console.log('Negotiated protocol:', targetWs.protocol);
          }

          // Only upgrade client connection after target is ready
          if (!isUpgraded) {
            try {
              // Create WebSocket server for this specific connection
              const wss = new WebSocket.Server({ noServer: true });

              wss.handleUpgrade(request, socket, head, (ws) => {
                clientWs = ws;
                isUpgraded = true;

                // Log successful protocol negotiation
                if (ws.protocol) {
                  console.log('Client WebSocket protocol negotiated:', ws.protocol);
                }

                // Setup bidirectional proxy
                this.establishWebSocketProxy(clientWs, targetWs, parsedUrl.pathname);
              });
            } catch (error) {
              console.error('Error upgrading client connection:', error.message);
              connectionClosed = true;
              socket.destroy();
              if (targetWs.readyState !== WebSocket.CLOSED) {
                targetWs.close();
              }
            }
          }
        });

        // Handle target WebSocket errors with retry logic
        targetWs.on('error', (error) => {
          if (connectionClosed) return;

          clearTimeout(connectionTimeout);
          console.error(`Target WebSocket error (attempt ${retries + 1}):`, error.message);

          // Check for authentication errors
          if (error.message.includes('401') || error.message.includes('403')) {
            console.error('Authentication error - check token validity and format');
            connectionClosed = true;
            if (!isUpgraded) {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
              socket.destroy();
            }
            return;
          }

          // Check for connection errors that might be temporary
          const isTemporaryError = error.code === 'ECONNREFUSED' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ETIMEDOUT' ||
            error.message.includes('Unexpected server response');

          if (isTemporaryError && retries < this.maxRetries && !isUpgraded) {
            console.log(`Retrying connection in ${this.retryDelay * (retries + 1)}ms...`);
            retries++;
            setTimeout(() => attemptConnection(), this.retryDelay * retries);
            return;
          }

          connectionClosed = true;

          if (!isUpgraded) {
            socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            socket.destroy();
          } else if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            const closeCode = error.code === 'ECONNREFUSED' ? 1006 : 1011;
            clientWs.close(closeCode, 'Target server connection error');
          }
        });

        // Handle socket errors
        socket.on('error', (error) => {
          if (connectionClosed) return;

          console.error('Socket error during upgrade:', error.message);
          clearTimeout(connectionTimeout);
          connectionClosed = true;
          if (targetWs.readyState !== WebSocket.CLOSED) {
            targetWs.close();
          }
        });

      } catch (error) {
        console.error('Error in handleWebSocketUpgrade:', error.message);
        if (retries < this.maxRetries) {
          retries++;
          setTimeout(() => attemptConnection(), this.retryDelay * retries);
        } else {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          socket.destroy();
        }
      }
    };

    await attemptConnection();
  }

  /**
   * Establish bidirectional WebSocket proxy with message logging
   */
  establishWebSocketProxy(clientWs, targetWs, pathname) {
    if (!clientWs || !targetWs) {
      console.error('Invalid WebSocket objects provided');
      return;
    }

    if (clientWs.readyState === WebSocket.CLOSED || targetWs.readyState === WebSocket.CLOSED) {
      console.error('One or both WebSocket connections are already closed');
      return;
    }

    let isProxyActive = true;
    let messageCount = { clientToTarget: 0, targetToClient: 0 };
    const startTime = Date.now();

    const cleanup = (reason = 'unknown') => {
      if (isProxyActive) {
        const duration = Date.now() - startTime;
        console.log(`WebSocket proxy cleanup for ${pathname}: ${reason}`);
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Messages: ${messageCount.clientToTarget} → target, ${messageCount.targetToClient} ← target`);
        isProxyActive = false;
      }
    };

    // Message handling with logging
    const forwardMessage = (from, to, data, direction) => {
      if (!isProxyActive) return;

      if (!to || to.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot forward message: ${direction} - target not ready (state: ${to ? to.readyState : 'null'})`);
        return;
      }

      try {
        to.send(data.toString());
        messageCount[direction === 'client→target' ? 'clientToTarget' : 'targetToClient']++;

        // Log message content
        let messageStr;
        try {
          // Try to parse as JSON for pretty printing
          const messageObj = JSON.parse(data.toString());
          messageStr = JSON.stringify(messageObj, null, 2);
        } catch (e) {
          // If not JSON, just convert to string
          messageStr = data.toString();
        }

        console.log(`\n=== Message forwarded ${direction} ===`);
        console.log(`Path: ${pathname}`);
        console.log(`Size: ${data.length} bytes`);
        console.log(`Content:`);
        console.log(messageStr);
        console.log(`=== End of message ===\n`);

      } catch (error) {
        console.error(`Error forwarding message ${direction}:`, error.message);

        if (error.code === 'EPIPE' || error.message.includes('not connected')) {
          cleanup(`send error: ${error.message}`);
          if (from && from.readyState === WebSocket.OPEN) {
            from.close(1006, 'Connection lost');
          }
        }
      }
    };

    // Proxy messages from client to target
    clientWs.on('message', (data) => {
      forwardMessage(clientWs, targetWs, data, 'client→target');
    });

    // Proxy messages from target to client
    targetWs.on('message', (data) => {
      forwardMessage(targetWs, clientWs, data, 'target→client');
    });

    // Handle connection close events
    targetWs.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`Target WebSocket closed for ${pathname}: code=${code}, reason="${reasonStr}"`);
      cleanup(`target closed: ${code} ${reasonStr}`);

      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code || 1000, reasonStr);
      }
    });

    clientWs.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`Client WebSocket closed for ${pathname}: code=${code}, reason="${reasonStr}"`);
      cleanup(`client closed: ${code} ${reasonStr}`);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(code || 1000, reasonStr);
      }
    });

    // Handle errors during proxy
    clientWs.on('error', (error) => {
      console.error(`Client WebSocket error for ${pathname}:`, error.message);
      cleanup(`client error: ${error.message}`);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(1011, 'Client connection error');
      }
    });

    targetWs.on('error', (error) => {
      console.error(`Target WebSocket error during proxy for ${pathname}:`, error.message);
      cleanup(`target error: ${error.message}`);

      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        let closeCode = 1011;
        if (error.code === 'ECONNRESET') {
          closeCode = 1006;
        } else if (error.code === 'ETIMEDOUT') {
          closeCode = 1001;
        }

        clientWs.close(closeCode, `Target error: ${error.message}`);
      }
    });

    // Keep connections alive
    const pingInterval = setInterval(() => {
      if (!isProxyActive) {
        clearInterval(pingInterval);
        return;
      }

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        try {
          targetWs.ping();
        } catch (error) {
          console.error(`Error sending ping to target for ${pathname}:`, error.message);
        }
      }

      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch (error) {
          console.error(`Error sending ping to client for ${pathname}:`, error.message);
        }
      }
    }, 25000);

    console.log(`WebSocket proxy established successfully for ${pathname}`);
  }

  /**
   * Build target WebSocket URL from configured target and request path
   */
  buildTargetWebSocketUrl(pathname, queryString = '') {
    const finalUrl = `${this.wsTarget}${pathname}${queryString}`;
    console.log(`Built WebSocket URL: ${this.wsTarget} + ${pathname}${queryString} -> ${finalUrl}`);
    return finalUrl;
  }

  /**
   * Get headers to forward to target server
   */
  getProxyHeaders(request) {
    const headers = {};

    // Forward important headers
    const headersToForward = [
      'authorization',
      'cookie',
      'user-agent',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
      'origin'
    ];

    headersToForward.forEach(headerName => {
      if (request.headers[headerName]) {
        headers[headerName] = request.headers[headerName];
      }
    });

    // Add connection-specific headers for better compatibility
    headers['sec-websocket-version'] = '13';
    headers['connection'] = 'Upgrade';
    headers['upgrade'] = 'websocket';

    return headers;
  }

  /**
   * Start the proxy server
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, (error) => {
        if (error) {
          reject(error);
          return;
        }

        console.log(`Simplified WebSocket Proxy Server running on port ${this.port}`);
        console.log('Configuration:');
        console.log(`  HTTP target: ${this.httpTarget || 'none'}`);
        console.log(`  WebSocket target: ${this.wsTarget || 'none'}`);
        console.log(`  Connection timeout: ${this.connectionTimeout}ms`);
        console.log(`  Max retries: ${this.maxRetries}`);
        console.log(`  Retry delay: ${this.retryDelay}ms`);
        resolve();
      });

      this.server.on('error', (error) => {
        console.error('Server error:', error.message);
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${this.port} is already in use`);
        }
      });
    });
  }

  /**
   * Stop the proxy server
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
  console.log('\nPress Ctrl+C to stop the server');
}).catch((error) => {
  console.error('Failed to start proxy server:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down WebSocket proxy server...');
  try {
    await proxy.stop();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error.message);
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = Proxy;
