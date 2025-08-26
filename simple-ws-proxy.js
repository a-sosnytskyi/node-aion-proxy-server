const WebSocket = require('ws');
const { parse } = require("node:url");

const server = new WebSocket.Server({ port: 8080 }, () => {
  console.log('🚀 WebSocket proxy running on ws://localhost:8080');
});

server.on('connection', (clientSocket, req) => {
  const parsed = parse(req.url, true);
  const token = parsed.query.token;

  if (!token) {
    clientSocket.close(4001, 'No token provided');
    return;
  }

  const targetUrl = `wss://api.aion.to/ws/graphql?token=${token}`;
  const targetSocket = new WebSocket(targetUrl, 'graphql-transport-ws');

  targetSocket.on('open', () => {
    console.log('✅ Connected to target server');
    // Отправляем connection_init для handshake
    targetSocket.send(JSON.stringify({ type: 'connection_init' }));
  });

  // Проксируем и логируем сообщения от клиента
  clientSocket.on('message', (data) => {
    console.log('📤 From client:', data.toString());
    if (targetSocket.readyState === WebSocket.OPEN) {
      targetSocket.send(data);
    }
  });

  // Проксируем и логируем сообщения от сервера
  targetSocket.on('message', (data) => {
    console.log('📥 From server:', data.toString());
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data);
    }
  });

  clientSocket.on('close', () => {
    console.log('👤 Client disconnected');
    if (targetSocket.readyState === WebSocket.OPEN) targetSocket.close();
  });

  targetSocket.on('close', (code, reason) => {
    console.log(`🔌 Target connection closed: ${code} - ${reason}`);
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
  });

  targetSocket.on('error', (err) => {
    console.log('❌ Target socket error:', err.message);
  });
});
