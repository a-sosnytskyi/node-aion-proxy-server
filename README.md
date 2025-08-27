# WebSocket Proxy Server

Simple HTTP/WebSocket proxy server with automatic protocol detection and YAML configuration.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start server**
   ```bash
   npm start           # Production
   npm run dev         # Development (with auto-restart)
   ```

## How it works

The proxy automatically routes requests based on protocol:

- **HTTP requests:** `http://localhost:8080/api/users` → `https://api.example.com/api/users`
- **WebSocket requests:** `ws://localhost:8080/ws/chat` → `wss://api.example.com/ws/chat`

All headers, query parameters, and paths are forwarded transparently.

## CORS Support

Automatically adds CORS headers for cross-origin requests:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`

## Error Handling

- **502 Bad Gateway:** Target server unreachable
- **504 Gateway Timeout:** Connection timeout exceeded
- **401 Unauthorized:** Authentication failed at target

## Requirements

- Node.js 14+
- npm or yarn

