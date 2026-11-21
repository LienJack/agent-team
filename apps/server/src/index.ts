// @agent-team/server: Hono app, auth and LAN listener, SSE, wiring, leader and hub (spec §3).
// `main.ts` is the composition root with the real adapters; everything exported here takes
// ports, so tests (and phase 3) build the service from fakes.
export { createApp, type AppOptions } from './app/app.js';
export { EventHub, eventStream, Subscriber } from './app/sse.js';
export { REPLAYED_HEADER } from './app/idempotency.js';
export type { AppContext, AppEnv } from './app/types.js';
export { boardSnapshot } from './app/routes-system.js';
export { createLanAuth, bearerAuth, type LanAuth, type LanAuthOptions } from './auth/guards.js';
export { ConfigError, loadConfig, type LoadedConfig } from './config.js';
export { runDoctor } from './doctor.js';
export { createEnvReader, envFilePath, type EnvReader } from './env.js';
export { createHub } from './hub/stub.js';
export type { Hub, HubDeps } from './hub/types.js';
export { createLeader } from './leader/stub.js';
export { resumeBrief } from './leader/resume.js';
export {
  LEADER_RECEIPTS_CURSOR_KEY,
  LEADER_SESSION_KEY,
  type Leader,
  type LeaderDeps,
  type LeaderReply,
} from './leader/types.js';
export { listen, writeListenerFile, removeListenerFile, type Listening } from './listeners.js';
export { createLogger } from './logger.js';
export { createService, type RunningService, type Service, type ServiceDeps } from './service.js';
