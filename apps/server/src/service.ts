import { mkdir } from 'node:fs/promises';
import {
  Engine,
  errorMessage,
  type CheckExecutor,
  type Clock,
  type GitPort,
  type IdGen,
  type Logger,
  type RunnerRegistry,
  type Store,
} from '@agent-team/core';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { createApp } from './app/app.js';
import { EventHub } from './app/sse.js';
import type { AppContext } from './app/types.js';
import { createLanAuth } from './auth/guards.js';
import { generatePassword, randomToken } from './auth/secrets.js';
import type { LoadedConfig } from './config.js';
import { runDoctor } from './doctor.js';
import type { EnvReader } from './env.js';
import { createHub } from './hub/hub.js';
import { roleSummarizer, type Summarize } from './hub/summarizer.js';
import type { Hub, HubRuntime } from './hub/types.js';
import { createLeader } from './leader/leader.js';
import type { Leader, LeaderRuntime } from './leader/types.js';
import {
  boardUrls,
  listen,
  removeListenerFile,
  writeListenerFile,
  type Listening,
} from './listeners.js';
import { watchRunLogs, type RunLogWatcher } from './run-log-watch.js';

/** Ports and settings; `main.ts` supplies the real adapters, tests supply fakes. */
export interface ServiceDeps {
  store: Store;
  runners: RunnerRegistry;
  git: GitPort;
  checks: CheckExecutor;
  clock: Clock;
  ids: IdGen;
  config: Pick<LoadedConfig, 'service' | 'models' | 'dataDir' | 'worktreeRoot' | 'webDist'>;
  env: EnvReader;
  logger: Logger;
  /** Terminal output (the one-time LAN password and addresses); default stdout. */
  print?: (text: string) => void;
  /** Login lockout source (default: the socket's remote address). */
  sourceOf?: (c: Context) => string;
  /** LAN session HMAC key (default: random per start). */
  sessionKey?: Uint8Array;
  /** Runs last on stop (e.g. close the database). */
  onClose?: () => void | Promise<void>;
  /** The leader's claude processes (default: disabled — messages are stored, never answered). */
  leader?: LeaderRuntime;
  /** The Grok bridge's grokmsg (used only when `grok.enabled`). */
  hub?: HubRuntime;
  /** Condenser for long Grok texts (default: role `hub_summarizer` through `runners`). */
  summarize?: Summarize;
}

export interface RunningService {
  localUrl: string;
  lanUrl: string | undefined;
  listenerFile: string;
}

export interface Service {
  readonly engine: Engine;
  readonly events: EventHub;
  readonly leader: Leader;
  readonly hub: Hub;
  readonly context: AppContext;
  /** Recover, bind both listeners, write listener.json, start the patrol tick. */
  start(): Promise<RunningService>;
  /**
   * Graceful shutdown (idempotent): leader and hub, SSE, listeners, then the engine (worker
   * process groups terminated, their runs marked abandoned and requeued), listener.json, onClose.
   */
  stop(): Promise<void>;
}

function remoteAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createService(deps: ServiceDeps): Service {
  const { store, clock, logger, config } = deps;
  const { service, dataDir } = config;
  const print = deps.print ?? ((text: string) => void process.stdout.write(text));
  const events = new EventHub();
  // the engine needs the hub (notifier) and the leader's event feed; both need the engine
  const late: { engine?: Engine; leader?: Leader } = {};
  const hub = createHub({
    service,
    logger,
    store,
    clock,
    engine: () => late.engine!,
    leader: () => late.leader!,
    ...(deps.hub ? { runtime: deps.hub } : {}),
    summarize:
      deps.summarize ??
      roleSummarizer({
        runners: deps.runners,
        models: config.models,
        quota: () => late.engine!.quotaState(),
        clock,
        dataDir,
      }),
  });
  const engine = new Engine({
    store,
    runners: deps.runners,
    git: deps.git,
    checks: deps.checks,
    clock,
    ids: deps.ids,
    config: {
      models: config.models,
      engine: service.engine,
      dataDir,
      worktreeRoot: config.worktreeRoot,
      notifications: hub.delivering,
    },
    notifier: hub,
    // every committed event reaches SSE and the leader (it filters and keeps its own cursor)
    publisher: {
      publish: (batch) => {
        events.publish(batch);
        late.leader?.notify(batch);
      },
    },
    logger,
  });
  late.engine = engine;
  const leader = createLeader({
    engine,
    store,
    clock,
    logger,
    models: config.models,
    service,
    dataDir,
    ...(deps.leader ? { runtime: deps.leader } : {}),
    onReply: (tx, inbound, reply) => hub.onLeaderReply(tx, inbound, reply),
    onRateLimited: (tx, until) => hub.onLeaderRateLimited(tx, until),
  });
  late.leader = leader;
  const context: AppContext = {
    engine,
    store,
    clock,
    logger,
    service,
    dataDir,
    leader,
    events,
    webDist: config.webDist,
    doctor: () => runDoctor({ runners: deps.runners, env: deps.env, store, dataDir }),
    checkRepo: async (repoPath, baseBranch) => {
      await deps.git.resolveRef({ repoPath, ref: baseBranch });
    },
  };

  let local: Listening | undefined;
  let lan: Listening | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let logWatch: RunLogWatcher | undefined;
  let listenerFile: { path: string; token: string } | undefined;
  let stopping: Promise<void> | undefined;

  async function stop(): Promise<void> {
    stopping ??= (async () => {
      if (timer) clearInterval(timer);
      logWatch?.stop();
      for (const part of [leader, hub]) {
        await part
          .stop()
          .catch((err: unknown) => logger.warn('stop failed', { error: errorMessage(err) }));
      }
      events.closeAll();
      await Promise.all([local?.close(), lan?.close()]);
      const { abandonedRuns } = await engine.shutdown();
      if (abandonedRuns.length > 0) {
        logger.info('stopped live runs (requeued with a recovery note)', {
          abandoned_runs: abandonedRuns,
        });
      }
      if (listenerFile) await removeListenerFile(listenerFile.path, listenerFile.token);
      await deps.onClose?.();
      logger.info('service stopped');
    })();
    return stopping;
  }

  async function start(): Promise<RunningService> {
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const report = await engine.recover();
      logger.info('recovery completed', {
        abandoned_runs: report.abandonedRuns.length,
        requeued_tasks: report.requeuedTasks.length,
        orphan_worktrees: report.orphanWorktrees.length,
        pending_effects: report.pendingEffects,
      });

      const token = randomToken();
      const localApp = createApp(context, { listener: 'local', token });
      local = await listen(localApp.fetch, service.local.host, service.local.port);
      listenerFile = { path: await writeListenerFile(dataDir, { addr: local.url, token }), token };
      logger.info('local listener', { url: local.url });

      if (service.lan.enabled) {
        let password = deps.env.get('TEAM_LAN_PASSWORD');
        if (password === undefined) {
          password = generatePassword();
          print(`區網看板密碼（只顯示這一次）：${password}\n`);
          logger.info('generated a LAN password (printed on the terminal once)');
        }
        const lanAuth = createLanAuth({
          password,
          clock,
          logger,
          allowedOrigins: service.lan.allowed_origins,
          lockoutFailures: service.lan.lockout_failures,
          lockoutMinutes: service.lan.lockout_minutes,
          sessionHours: service.lan.session_hours,
          sourceOf: deps.sourceOf ?? remoteAddress,
          ...(deps.sessionKey ? { sessionKey: deps.sessionKey } : {}),
        });
        const lanApp = createApp(context, { listener: 'lan', lan: lanAuth });
        lan = await listen(lanApp.fetch, service.lan.host, service.lan.port);
        const urls = boardUrls(lan);
        if (urls.thisMachine) print(`看板（這台電腦）：${urls.thisMachine}\n`);
        print(`區網看板：${urls.lan.join('  ')}\n`);
        logger.info('lan listener', { url: lan.url });
      } else {
        print('看板已關閉（service.json lan.enabled = false）；CLI／MCP 走本機監聽埠\n');
      }

      timer = setInterval(() => {
        engine
          .tick()
          .catch((err: unknown) => logger.error('tick failed', { error: errorMessage(err) }));
      }, service.engine.tick_ms);
      logWatch = watchRunLogs({ store, engine, logger });
      await hub.start();
      await leader.start();
      engine.wake();
      return { localUrl: local.url, lanUrl: lan?.url, listenerFile: listenerFile.path };
    } catch (err) {
      await stop();
      throw err;
    }
  }

  return { engine, events, leader, hub, context, start, stop };
}
