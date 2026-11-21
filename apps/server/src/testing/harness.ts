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
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createApp } from '../app/app.js';
import type { AppEnv } from '../app/types.js';
import { createLanAuth } from '../auth/guards.js';
import { createEnvReader } from '../env.js';
import type { Summarize } from '../hub/summarizer.js';
import type { HubRuntime } from '../hub/types.js';
import type { LeaderRuntime } from '../leader/types.js';
import { createService, type Service } from '../service.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';
/** The leader-scoped token of the local listener (docs/adr/0014). */
export const TEST_LEADER_TOKEN = 'test-leader-token-0123456789';

/** Loosely typed JSON response body for assertions. */
// oxlint-disable-next-line typescript/no-explicit-any
export type Loose = any;
export const TEST_PASSWORD = 'correct horse battery staple';
/** Header the in-process LAN app uses as the lockout source (app.request has no socket). */
export const SOURCE_HEADER = 'x-test-source';

export interface TestServiceOptions {
  /** Change the (already loopback/ephemeral) service config. */
  configure?: (config: ServiceConfig) => void;
  /** Lines of the temp .env (default: a LAN password). */
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
  /** LAN app for `app.request` (password TEST_PASSWORD, source from SOURCE_HEADER). */
  lanApp(overrides?: Partial<ServiceConfig['lan']>): OpenAPIHono<AppEnv>;
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
  writeFileSync(envPath, options.envFile ?? `TEAM_LAN_PASSWORD="${TEST_PASSWORD}"\n`);
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
  for (const runner of Object.values(runners)) registry.register(runner);
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
    sourceOf: (c) => c.req.header(SOURCE_HEADER) ?? 'test-source',
    ...(options.leader ? { leader: options.leader(root) } : {}),
    ...(options.hub ? { hub: options.hub } : {}),
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
    lanApp: (overrides = {}) => {
      const lan = { ...config.lan, ...overrides };
      return createApp(service.context, {
        listener: 'lan',
        lan: createLanAuth({
          password: TEST_PASSWORD,
          clock,
          logger,
          allowedOrigins: lan.allowed_origins,
          lockoutFailures: lan.lockout_failures,
          lockoutMinutes: lan.lockout_minutes,
          sessionHours: lan.session_hours,
          sourceOf: (c) => c.req.header(SOURCE_HEADER) ?? 'test-source',
        }),
      });
    },
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
