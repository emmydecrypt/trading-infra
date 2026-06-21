#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((err) => {
  // stderr only — MCP over stdio uses stdout for framed messages.
  console.error('[mcp-server] fatal:', err);
  process.exit(1);
});