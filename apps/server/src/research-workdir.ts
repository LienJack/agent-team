import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { errorMessage, type Logger, type Runner, type RunnerRegistry } from '@agent-team/core';
import { DATA_LAYOUT, type RunnerName, type RunResult } from '@agent-team/schema';

// The empty working directory of a research run (spec §17; docs/adr/0021): core computes the path
// (`DATA/research/<run_id>`) but does no IO, so the server creates it (0700, empty) right before
// the runner starts and removes it when the runner resolves. A crash leaves directories behind:
// startup removes every one whose run is not live.

export function researchRoot(dataDir: string): string {
  return join(dataDir, DATA_LAYOUT.research);
}

/** `cwd` when it is exactly `DATA/research/<one name>`, else undefined (never touched). */
function researchDir(dataDir: string, cwd: string): string | undefined {
  const root = resolve(researchRoot(dataDir));
  const dir = resolve(cwd);
  const name = dir.slice(root.length + 1);
  return dirname(dir) === root && /^[a-z0-9_]+$/.test(name) ? dir : undefined;
}

async function prepare(dir: string): Promise<void> {
  const root = dirname(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  // a leftover of an earlier attempt starts empty again
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * `runner` with research runs (`spec.web`) wrapped in their directory's lifecycle. Everything
 * else (probe, optional capabilities such as `resumable`) is the runner's own.
 */
function wrap(runner: Runner, dataDir: string, logger: Logger): Runner {
  const run: Runner['run'] = async (spec, signal, hooks): Promise<RunResult> => {
    if (spec.web !== true) return runner.run(spec, signal, hooks);
    const dir = researchDir(dataDir, spec.cwd);
    if (dir === undefined) {
      return {
        error: {
          kind: 'crash',
          message: `research run cwd ${spec.cwd} is not under DATA/research`,
        },
      };
    }
    try {
      await prepare(dir);
    } catch (err) {
      return {
        error: {
          kind: 'crash',
          message: `cannot create the research directory: ${errorMessage(err)}`,
        },
      };
    }
    try {
      return await runner.run(spec, signal, hooks);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn('cannot remove a research directory', { dir, error: errorMessage(err) }),
      );
    }
  };
  return new Proxy(runner, {
    get(target, prop) {
      if (prop === 'run') return run;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** The registry with every runner wrapped (see `wrap`); capabilities are the registry's own. */
export function withResearchWorkdirs(
  registry: RunnerRegistry,
  dataDir: string,
  logger: Logger,
): RunnerRegistry {
  const wrapped = new WeakMap<Runner, Runner>();
  return {
    get(name: RunnerName) {
      const runner = registry.get(name);
      if (!runner) return undefined;
      let w = wrapped.get(runner);
      if (!w) {
        w = wrap(runner, dataDir, logger);
        wrapped.set(runner, w);
      }
      return w;
    },
    names: () => registry.names(),
    capabilities: (name) => registry.capabilities(name),
  };
}

/** Remove the research directories of runs that are not live (after startup recovery). */
export async function sweepResearchDirs(
  dataDir: string,
  isLive: (runId: string) => boolean,
  logger: Logger,
): Promise<string[]> {
  const root = researchRoot(dataDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (isLive(name)) continue;
    try {
      await rm(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      logger.warn('cannot remove a research directory', { name, error: errorMessage(err) });
    }
  }
  return removed;
}
