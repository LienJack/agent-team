// Composition root (spec §3 apps/server): the only module that knows the real adapters.
// Run: `node apps/server/dist/main.js` (or `team serve`). Environment:
//   AGENT_TEAM_HOME         data directory (default ~/.agent-team)
//   AGENT_TEAM_ENV_FILE     .env location (default <project root>/.env)
//   AGENT_TEAM_CONFIG_DIR   directory with service.json / models.json (default <root>/config)
//   AGENT_TEAM_FAKE_RUNNERS=1  in-process fake runners instead of claude/codex/dsh for the
//                              workers; the leader is controlled separately by service.json
//                              `leader.enabled` (default true), so fake workers + the real leader
//                              is the cheapest realistic end-to-end setup
// (all listed in ENV_VARS, packages/schema/src/env.ts)
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, randomIdGen, type Clock, type Store } from '@agent-team/core';
import { createSqliteStore } from '@agent-team/db';
import { createGitPort, type CliGitPort } from '@agent-team/git';
import {
  createCheckExecutor,
  createProcessControl,
  createRunnerRegistry,
  type RunnerRegistryOptions,
} from '@agent-team/runners';
import { DATA_LAYOUT } from '@agent-team/schema';
import { ConfigError, loadConfig, type LoadedConfig } from './config.js';
import { createEnvReader, envFilePath, isKnownEnvVar } from './env.js';
import { createLogger } from './logger.js';
import { createService, type Service } from './service.js';

const systemClock: Clock = { now: () => new Date() };

/** The git adapter: worktrees under `paths.worktree_root`, commits as `git.author`. */
export function createGit(config: LoadedConfig): CliGitPort {
  return createGitPort({ worktreeRoot: config.worktreeRoot, author: config.service.git.author });
}

/**
 * Paths no worker sandbox may read or write (docs/adr/0014): DATA (database, listener files with
 * the tokens, run logs), the service `.env` (TEAM_LAN_PASSWORD, API keys) and this checkout's
 * `.env`. Credential directories under home are added by the runners.
 */
export function serviceDenyPaths(
  config: Pick<LoadedConfig, 'dataDir' | 'projectRoot'>,
  envFile: string,
): string[] {
  return [...new Set([config.dataDir, envFile, join(config.projectRoot, '.env')])];
}

/**
 * Last resort before a forced exit (second Ctrl-C): SIGKILL the process group of every live run
 * (workers run in their own groups, so they would outlive this process). The next start's
 * recovery marks the runs abandoned.
 */
export function killLiveRunGroups(store: Pick<Store, 'runs'>): number {
  let killed = 0;
  for (const run of store.runs.list({ states: ['starting', 'running'] })) {
    if (run.pid === null) continue;
    try {
      process.kill(-run.pid, 'SIGKILL');
      killed++;
    } catch {
      // already gone
    }
  }
  return killed;
}

export interface MainOptions {
  /** Worker executables (argv prefix) — only the crash-recovery test entry sets this. */
  runnerCommands?: RunnerRegistryOptions['commands'];
}

export async function main(
  processEnv: NodeJS.ProcessEnv = process.env,
  options: MainOptions = {},
): Promise<Service> {
  const logger = createLogger({ write: (line) => void process.stderr.write(line) });
  const config = loadConfig({ env: processEnv });
  const envFile = envFilePath(config.projectRoot, processEnv);
  const env = createEnvReader({ file: envFile, processEnv });

  const store = createSqliteStore({ path: join(config.dataDir, DATA_LAYOUT.database) });
  const fake = processEnv['AGENT_TEAM_FAKE_RUNNERS'] === '1';
  // the service's own ports, denied to checks and dsh (configured ones now, bound ones after start)
  const servicePorts = new Set<number>(
    [config.service.local.port, config.service.lan.port].filter((p) => p > 0),
  );
  // workers never see the service's state or secrets (docs/adr/0014, 0019)
  const sandbox = {
    denyPaths: serviceDenyPaths(config, envFile),
    servicePorts: () => [...servicePorts],
  };
  const runners = createRunnerRegistry({
    env: (name) => (isKnownEnvVar(name) ? env.get(name) : undefined),
    logger,
    fake,
    ...(options.runnerCommands ? { commands: options.runnerCommands } : {}),
    sandbox,
    dsh: { allowUnsandboxed: config.service.runners.dsh.allow_unsandboxed },
  });
  const caps = await runners.probeAll();
  logger.info('runners probed', {
    fake,
    available: caps.filter((c) => c.available).map((c) => c.runner),
    unavailable: caps.filter((c) => !c.available).map((c) => c.runner),
  });

  const service = createService({
    store,
    runners,
    git: createGit(config),
    // checks run worker-authored code: same deny list under Seatbelt (macOS), or not at all
    // unless checks.allow_unsandboxed (docs/adr/0014, 0019)
    checks: createCheckExecutor({
      sandbox,
      allowUnsandboxed: config.service.checks.allow_unsandboxed,
    }),
    clock: systemClock,
    ids: randomIdGen,
    config,
    env,
    logger,
    onClose: () => store.close(),
    processes: createProcessControl(),
    // the leader's `team` is this checkout's built CLI; `leader.enabled` is independent of
    // AGENT_TEAM_FAKE_RUNNERS (fake workers + the real leader is a supported setup)
    leader: {
      enabled: config.service.leader.enabled,
      teamEntry: join(config.projectRoot, 'apps', 'cli', 'dist', 'bin.js'),
      // its Bash runs in Claude Code's sandbox with the same service deny list (docs/adr/0012)
      denyPaths: serviceDenyPaths(config, envFile),
    },
  });
  const running = await service.start();
  for (const url of [running.localUrl, running.lanUrl]) {
    if (url !== undefined) servicePorts.add(Number(new URL(url).port));
  }

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      let killed = 0;
      try {
        killed = killLiveRunGroups(store);
      } catch {
        // the store may be closed already
      }
      logger.warn('second signal: exiting now', { signal, killed_run_groups: killed });
      process.exit(1);
    }
    logger.info('shutting down', { signal });
    service.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error('shutdown failed', { error: errorMessage(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return service;
}

function isEntry(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    // compare real paths: the entry may be reached through a symlink (AGENT_TEAM_SERVER_ENTRY)
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntry(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof ConfigError ? err.message : errorMessage(err);
    process.stderr.write(`agent-team: ${message}\n`);
    process.exit(1);
  });
}
