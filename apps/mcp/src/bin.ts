#!/usr/bin/env node
import { connectLocal } from '@agent-team/client/node';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// stdout carries protocol frames only; everything else goes to stderr.
async function main(): Promise<void> {
  // connect per call: the service may be started (or restarted with a new token) after we are
  const server = createServer(() => connectLocal({ env: process.env }));
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = (code: number) => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(code));
  };
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
  await server.connect(transport);
  process.stderr.write('agent-team-mcp: ready (stdio)\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`agent-team-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
