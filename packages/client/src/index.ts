// Typed HTTP client shared by the CLI, MCP and web (spec §2, §6 合約先行). Browser-safe: the
// listener-file helpers that need `node:` modules live in `@agent-team/client/node`.
export * from './client.js';
export { connectionError, errorFromResponse, TeamApiError, type TeamErrorInfo } from './errors.js';
export {
  SseParser,
  subscribeEvents,
  type EventStreamConnection,
  type EventStreamOptions,
  type EventSubscription,
} from './events.js';
export type { components, operations, paths } from './generated/index.js';
