const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy-middleware');
const WebSocket = require('ws');
const url = require('url');

/**
 * Enhanced WebSocket Proxy Server with full message logging
 */
class WebSocketProxy {
  constructor(config = {}) {
    this.port = config.port || 8080;
    this.routes = config.routes || {};
    this.protocolMap = config.protocolMap || {};
    this.defaultTarget = config.defaultTarget || null;
    this.connectionTimeout = config.connectionTimeout || 15000;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;

    // Create HTTP server
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
    const httpProxyMiddleware = httpProxy.createProxyMiddleware({
      target: this.defaultTarget,
      changeOrigin: true,
      ws: false, // We handle WebSocket separately
      router: (req) => {
        const pathname = url.parse(req.url).pathname;
        return this.getTargetForPath(pathname) || this.defaultTarget;
      },
      onError: (err, req, res) => {
        console.error('HTTP Proxy Error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
      }
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

      httpProxyMiddleware(req, res);
    });
  }

  /**
   * Setup WebSocket upgrade handler
   */
  setupWebSocketUpgrade() {
    this.server.on('upgrade', async (request, socket, head) => {
      const parsedUrl = url.parse(request.url, true);
      const pathname = parsedUrl.pathname;
      const targetUrl = this.getTargetForPath(pathname);

      if (!targetUrl) {
        console.error('No target found for path:', pathname);
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log(`Proxying WebSocket connection: ${pathname} -> ${targetUrl}`);
      console.log('WebSocket connection attempt from:', request.headers.origin);

      await this.handleWebSocketUpgrade(request, socket, head, targetUrl);
    });
  }

  /**
   * Handle WebSocket upgrade request with fixed URL building
   */
  async handleWebSocketUpgrade(request, socket, head, targetUrl) {
    let retries = 0;

    const attemptConnection = async () => {
      try {
        const parsedUrl = url.parse(request.url, true);
        const pathname = parsedUrl.pathname;

        // Build correct target WebSocket URL without duplicating paths
        const targetWsUrl = this.buildTargetWebSocketUrl(targetUrl, parsedUrl.search || '');

        console.log(`Creating WebSocket connection to: ${targetWsUrl} (attempt ${retries + 1})`);

        // Get protocol for this path
        const protocol = this.getProtocolForPath(pathname);
        const headers = this.getProxyHeaders(request);

        // Override protocol if specified in configuration
        if (protocol) {
          headers['sec-websocket-protocol'] = protocol;
          console.log(`Using WebSocket protocol: ${protocol} for path: ${pathname}`);
        }

        // Create WebSocket connection with enhanced options
        const wsOptions = {
          headers: headers,
          followRedirects: true, // Allow following redirects
          maxRedirects: 3,
          perMessageDeflate: false,
          handshakeTimeout: 10000
        };

        // Create WebSocket connection
        const targetWs = protocol
          ? new WebSocket(targetWsUrl, protocol, wsOptions)
          : new WebSocket(targetWsUrl, wsOptions);

        let clientWs = null;
        let isUpgraded = false;
        let connectionClosed = false;

        // Handle target connection timeout
        const connectionTimeout = setTimeout(() => {
          if (!isUpgraded && !connectionClosed) {
            console.error(`Target connection timeout for: ${targetWsUrl} (attempt ${retries + 1})`);
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
          if (protocol) {
            console.log('Using protocol:', protocol);
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
                this.establishWebSocketProxy(clientWs, targetWs, pathname);
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

          // Check for protocol-related errors
          if (error.message.includes('protocol') || error.message.includes('Unexpected server response: 400')) {
            console.error('WebSocket protocol negotiation failed. Checking protocol configuration...');
            console.error('Expected protocol:', protocol);
            console.error('Try connecting without protocol or with different protocol');
          }

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
   * Establish bidirectional WebSocket proxy with full message logging
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

    // Enhanced message handling with FULL message logging
    const forwardMessage = (from, to, data, direction) => {
      if (!isProxyActive) return;

      if (!to || to.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot forward message: ${direction} - target not ready (state: ${to ? to.readyState : 'null'})`);
        return;
      }

      try {
        to.send(data);
        messageCount[direction === 'client→target' ? 'clientToTarget' : 'targetToClient']++;

        // FULL message logging - display complete message content
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

    // Handle target WebSocket close
    targetWs.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`Target WebSocket closed for ${pathname}: code=${code}, reason="${reasonStr}"`);

      // Enhanced error code analysis
      if (code === 1011) {
        console.error('Server internal error - check server logs and configuration');
      } else if (code === 1002) {
        console.error('Protocol error - check message format and protocol compliance');
      } else if (code === 1003) {
        console.error('Unsupported data - check message types and payload format');
      }

      cleanup(`target closed: ${code} ${reasonStr}`);

      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code || 1000, reasonStr);
      }
    });

    // Handle client WebSocket close
    clientWs.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`Client WebSocket closed for ${pathname}: code=${code}, reason="${reasonStr}"`);
      cleanup(`client closed: ${code} ${reasonStr}`);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(code || 1000, reasonStr);
      }
    });

    // Handle client WebSocket errors
    clientWs.on('error', (error) => {
      console.error(`Client WebSocket error for ${pathname}:`, error.message);
      cleanup(`client error: ${error.message}`);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(1011, 'Client connection error');
      }
    });

    // Handle target WebSocket errors during proxy
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

    // Reduced ping interval to avoid timeouts
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
    }, 25000); // Ping every 25 seconds

    console.log(`WebSocket proxy established successfully for ${pathname}`);
  }

  /**
   * Get target server URL for a given path
   */
  getTargetForPath(pathname) {
    // Check exact path matches first
    if (this.routes[pathname]) {
      return this.routes[pathname];
    }

    // Check prefix matches (sort by length descending to match most specific first)
    const sortedRoutes = Object.entries(this.routes)
      .sort(([a], [b]) => b.length - a.length);

    for (const [route, target] of sortedRoutes) {
      if (pathname.startsWith(route)) {
        return target;
      }
    }

    return this.defaultTarget;
  }

  /**
   * Get WebSocket protocol for a given path
   */
  getProtocolForPath(pathname) {
    // Check exact path matches first
    if (this.protocolMap && this.protocolMap[pathname]) {
      return this.protocolMap[pathname];
    }

    // Check prefix matches
    if (this.protocolMap) {
      const sortedProtocols = Object.entries(this.protocolMap)
        .sort(([a], [b]) => b.length - a.length);

      for (const [route, protocol] of sortedProtocols) {
        if (pathname.startsWith(route)) {
          return protocol;
        }
      }
    }

    // Default protocols for common GraphQL patterns
    if (pathname.includes('graphql') || pathname.includes('subscription')) {
      return 'graphql-transport-ws';
    }

    return undefined;
  }

  /**
   * Build target WebSocket URL from target URL - FIXED VERSION
   */
  buildTargetWebSocketUrl(targetUrl, queryString = '') {
    const parsedTarget = url.parse(targetUrl);

    // Convert HTTP(S) to WebSocket protocol
    let protocol;
    if (targetUrl.startsWith('ws://') || targetUrl.startsWith('wss://')) {
      // Already a WebSocket URL
      return targetUrl + queryString;
    } else if (targetUrl.startsWith('https://')) {
      protocol = 'wss:';
    } else {
      protocol = 'ws:';
    }

    const host = parsedTarget.host;
    const path = parsedTarget.path || parsedTarget.pathname || '';

    // Build final URL
    const finalUrl = `${protocol}//${host}${path}${queryString}`;

    console.log(`Built WebSocket URL: ${targetUrl} + ${queryString} -> ${finalUrl}`);
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

    // For GraphQL subscriptions, ensure proper protocol is set if not present
    if (!headers['sec-websocket-protocol']) {
      const pathname = url.parse(request.url).pathname;
      const protocol = this.getProtocolForPath(pathname);

      if (protocol) {
        headers['sec-websocket-protocol'] = protocol;
      }
    }

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

        console.log(`WebSocket Proxy Server running on port ${this.port}`);
        console.log('Configuration:');
        console.log(`  Connection timeout: ${this.connectionTimeout}ms`);
        console.log(`  Max retries: ${this.maxRetries}`);
        console.log(`  Retry delay: ${this.retryDelay}ms`);
        console.log('Routes configured:');
        for (const [route, target] of Object.entries(this.routes)) {
          console.log(`  ${route} -> ${target}`);
          if (this.protocolMap[route]) {
            console.log(`    Protocol: ${this.protocolMap[route]}`);
          }
        }
        if (this.defaultTarget) {
          console.log(`  Default target: ${this.defaultTarget}`);
        }
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

// Enhanced configuration with corrected URL mappings
const proxyConfig = {
  port: 8080,
  defaultTarget: 'https://api.aion.to',
  connectionTimeout: 20000,  // Increased timeout
  maxRetries: 3,
  retryDelay: 1000,

  // WebSocket protocol configuration
  protocolMap: {
    '/ws/graphql': 'graphql-transport-ws',
    '/graphql/ws': 'graphql-ws',
    '/subscriptions': 'graphql-transport-ws',
    '/api/graphql/ws': 'graphql-transport-ws'
  },

  routes: {
    // CORRECTED: WebSocket endpoints should map directly without path duplication
    '/ws/graphql': 'wss://api.aion.to/ws/graphql',
    '/graphql/ws': 'wss://api.aion.to/graphql/ws',
    '/subscriptions': 'wss://api.aion.to/subscriptions',
    '/api/graphql/ws': 'wss://api.aion.to/api/graphql/ws',

    // HTTP endpoints for queries/mutations
    '/api/graphql': 'https://api.aion.to/api/graphql',
    '/graphql': 'https://api.aion.to/graphql',

    // Other WebSocket routes
    '/socket.io': 'wss://api.aion.to/socket.io',
    '/websocket': 'wss://api.aion.to/websocket'
  }
};

// Create and start proxy server
const proxy = new WebSocketProxy(proxyConfig);

proxy.start().then(() => {
  console.log('\n=== GraphQL WebSocket Proxy Server with Full Message Logging ===');
  console.log('Key features:');
  console.log('  ✓ Full message content logging (no truncation)');
  console.log('  ✓ JSON pretty-printing for structured messages');
  console.log('  ✓ Message size and direction tracking');
  console.log('  ✓ Fixed URL duplication issue');
  console.log('  ✓ Enhanced error handling');
  console.log('\nSupported GraphQL protocols:');
  console.log('  - graphql-transport-ws (modern standard)');
  console.log('  - graphql-ws (legacy)');
  console.log('\nExample client connection:');
  console.log(`  ws://localhost:${proxyConfig.port}/ws/graphql?token=YOUR_TOKEN`);
  console.log('\nPress Ctrl+C to stop the server');
}).catch((error) => {
  console.error('Failed to start proxy server:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down GraphQL WebSocket proxy server...');
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

module.exports = WebSocketProxy;
