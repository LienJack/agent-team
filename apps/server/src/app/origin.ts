import type { AnswerVia, MessageSource } from '@agent-team/schema';
import type { Context } from 'hono';
import type { AppEnv } from './types.js';

// L9c: where a message or an answer came from is derived from the listener and the credential
// only; the request body's `source` / `via` is ignored (kept in the schema for old clients). A
// LAN session is the board (`web`); the operator token is a local client (`cli` — the CLI and
// the MCP server share that token, so the server cannot and does not tell them apart).

function derive(c: Context<AppEnv>): 'web' | 'cli' {
  return c.get('channel') === 'lan' ? 'web' : 'cli';
}

export function messageSource(c: Context<AppEnv>): MessageSource {
  return derive(c);
}

export function answerVia(c: Context<AppEnv>): AnswerVia {
  return derive(c);
}
