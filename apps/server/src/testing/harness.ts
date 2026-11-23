// Test support (never imported by production code): the service on core's in-memory store and
// fakes, a temp DATA directory and a temp .env, so nothing touches ~/.agent-team or the repo .env.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore, noopLogger, type Logger } from '@agent-team/core';
import {
  FakeCheckExecutor,
  FakeGit,
  FakeRunner,
  InMemoryRunnerRegistry,
  ManualClock,
  SequentialIdGen,
  testModelsConfig,
} from '@agent-team/core/testing';
import { defaultServiceConfig, type ServiceConfig } from '@agent-team/schema';
import type { GateGit } from '@agent-team/git';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createApp } from '../app/app.js';
import type { AppEnv } from '../app/types.js';
import { createEnvReader } from '../env.js';
import type { Summarize } from '../hub/summarizer.js';
import type { HubRuntime } from '../hub/types.js';
import type { LeaderRuntime } from '../leader/types.js';
import type { MemosMemory } from '../memory/memos.js';
import { createService, type Service } from '../service.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';
/** The leader-scoped token of the local listener (docs/adr/0014). */
export const TEST_LEADER_TOKEN = 'test-leader-token-0123456789';

/** Loosely typed JSON response body for assertions. */
// oxlint-disable-next-line typescript/no-explicit-any
export type Loose = any;
/** Address of the in-process LAN app in `lanRequest` (as other devices open it). */
export const LAN_HOST = '192.168.1.20:4518';

export interface TestServiceOptions {
  /** Change the (already loopback/ephemeral) service config. */
  configure?: (config: ServiceConfig) => void;
  /** Lines of the temp .env (default: empty). */
  envFile?: string;
  logger?: Logger;
  /** A built board directory (with index.html) for the LAN listener. */
  webDist?: string;
  /** Leader runtime (default: disabled — never spawns claude). */
  leader?: (root: string) => LeaderRuntime;
  /** grokmsg runtime (only used when the test enables grok; never the real grokmsg). */
  hub?: HubRuntime;
  /** Hub condenser (default: none → truncated with 「（未整理）」). */
  summarize?: Summarize;
  /** Project memory adapter (used only when the test enables memory; a fake MemOS on loopback). */
  memory?: (store: InMemoryStore, config: ServiceConfig) => MemosMemory;
  /** Git for the gate (spec §19); default none (the gate routes answer 503). */
  gateGit?: GateGit;
}

export interface TestService {
  service: Service;
  store: InMemoryStore;
  clock: ManualClock;
  git: FakeGit;
  checks: FakeCheckExecutor;
  registry: InMemoryRunnerRegistry;
  runners: Record<'claude' | 'codex' | 'dsh', FakeRunner>;
  config: ServiceConfig;
  dataDir: string;
  /** Everything the service printed to the "terminal". */
  printed: string[];
  /** Local-listener app for `app.request` (bearer TEST_TOKEN). */
  localApp(): OpenAPIHono<AppEnv>;
  /** LAN app for `app.request` (no authentication; see `lanRequest`). */
  lanApp(): OpenAPIHono<AppEnv>;
  /** The temp root (holds DATA, the .env and anything a test writes). */
  root: string;
  /** Stop the service (if started) and delete the temp directory. */
  cleanup(): Promise<void>;
}

/** Loopback-only, ephemeral ports, slow patrol (commits wake the engine anyway). */
export function testServiceConfig(): ServiceConfig {
  const config = defaultServiceConfig();
  config.local = { host: '127.0.0.1', port: 0 };
  config.lan = { ...config.lan, host: '127.0.0.1', port: 0 };
  config.engine.tick_ms = 60_000;
  return config;
}

export function createTestService(options: TestServiceOptions = {}): TestService {
  const root = mkdtempSync(join(tmpdir(), 'team-server-'));
  const dataDir = join(root, 'data');
  const envPath = join(root, 'test.env');
  writeFileSync(envPath, options.envFile ?? '');
  const config = testServiceConfig();
  options.configure?.(config);

  const store = new InMemoryStore();
  const clock = new ManualClock();
  const git = new FakeGit();
  const checks = new FakeCheckExecutor();
  const registry = new InMemoryRunnerRegistry();
  const runners = {
    claude: new FakeRunner('claude'),
    codex: new FakeRunner('codex'),
    dsh: new FakeRunner('dsh'),
  };
  // probed (like the real registry after startup): research runs need `supports.webSearch`
  for (const runner of Object.values(runners)) registry.register(runner, runner.probeResult);
  const printed: string[] = [];
  const logger = options.logger ?? noopLogger;
  const env = createEnvReader({ file: envPath, processEnv: {} });

  const service = createService({
    store,
    runners: registry,
    git,
    checks,
    clock,
    ids: new SequentialIdGen(),
    config: {
      service: config,
      models: testModelsConfig(),
      dataDir,
      worktreeRoot: join(root, 'worktrees'),
      webDist: options.webDist,
    },
    env,
    logger,
    print: (text) => void printed.push(text),
    ...(options.leader ? { leader: options.leader(root) } : {}),
    ...(options.hub ? { hub: options.hub } : {}),
    ...(options.memory ? { memory: options.memory(store, config) } : {}),
    ...(options.gateGit ? { gateGit: options.gateGit } : {}),
    // never the real hub_summarizer in tests
    summarize:
      options.summarize ??
      (async () => {
        throw new Error('no summarizer in tests');
      }),
  });

  return {
    service,
    store,
    clock,
    git,
    checks,
    registry,
    runners,
    config,
    dataDir,
    printed,
    root,
    localApp: () =>
      createApp(service.context, {
        listener: 'local',
        token: TEST_TOKEN,
        leaderToken: TEST_LEADER_TOKEN,
      }),
    lanApp: () => createApp(service.context, { listener: 'lan' }),
    cleanup: async () => {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** `app.request` init for the local app: bearer token (operator by default) + JSON body. */
export function local(
  body?: unknown,
  headers: Record<string, string> = {},
  token = TEST_TOKEN,
): RequestInit {
  const init: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

/** `app.request` on the LAN app: no credential, a JSON body (POST when `body` is given). */
export function lanRequest(
  app: OpenAPIHono<AppEnv>,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`http://${LAN_HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: LAN_HOST,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}
