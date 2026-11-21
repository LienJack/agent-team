// Composition root (spec §3 apps/server): the only module that knows the real adapters.
// Run: `node apps/server/dist/main.js` (or `team serve`). Environment:
//   AGENT_TEAM_HOME         data directory (default ~/.agent-team)
//   AGENT_TEAM_ENV_FILE     .env location (default <project root>/.env)
//   AGENT_TEAM_CONFIG_DIR   directory with service.json / models.json (default <root>/config)
//   AGENT_TEAM_FAKE_RUNNERS=1  in-process fake runners instead of claude/codex/dsh
// (all listed in ENV_VARS, packages/schema/src/env.ts)
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, randomIdGen, type Clock } from '@agent-team/core';
import { createSqliteStore } from '@agent-team/db';
import { createGitPort, type CliGitPort } from '@agent-team/git';
import { createCheckExecutor, createRunnerRegistry } from '@agent-team/runners';
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

export async function main(processEnv: NodeJS.ProcessEnv = process.env): Promise<Service> {
  const logger = createLogger({ write: (line) => void process.stderr.write(line) });
  const config = loadConfig({ env: processEnv });
  const env = createEnvReader({ file: envFilePath(config.projectRoot, processEnv), processEnv });

  const store = createSqliteStore({ path: join(config.dataDir, DATA_LAYOUT.database) });
  const fake = processEnv['AGENT_TEAM_FAKE_RUNNERS'] === '1';
  const runners = createRunnerRegistry({
    env: (name) => (isKnownEnvVar(name) ? env.get(name) : undefined),
    logger,
    fake,
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
    checks: createCheckExecutor(),
    clock: systemClock,
    ids: randomIdGen,
    config,
    env,
    logger,
    onClose: () => store.close(),
  });
  await service.start();

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      logger.warn('second signal: exiting now', { signal });
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
