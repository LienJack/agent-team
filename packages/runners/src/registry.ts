import type { Runner } from '@agent-team/core';
import type { RunnerCapabilities, RunnerName } from '@agent-team/schema';
import { ClaudeRunner } from './claude/runner.js';
import { CodexRunner } from './codex/runner.js';
import { DshRunner } from './dsh/runner.js';
import { InProcessFakeRunner } from './fake/in-process.js';
import { redactSecrets } from './redact.js';
import type { ManagedRunnerRegistry, RunnerRegistryOptions } from './types.js';

const ALL_NAMES: RunnerName[] = ['claude', 'codex', 'dsh', 'fake'];

/**
 * Runner registry for the server (spec §7).
 * - default: real `claude`, `codex` (bundled SDK binary) and `dsh` runners. `fake` is not
 *   registered.
 * - `fake: true`: an `InProcessFakeRunner` under every name (`claude`, `codex`, `dsh`, `fake`),
 *   so models.json routing works unchanged in end-to-end tests; script them via `fake(name)`.
 *
 * Probing never happens implicitly at construction: call `probeAll()` at startup (results are
 * cached for `capabilities()`); a runner also probes lazily before its first run.
 */
export function createRunnerRegistry(opts: RunnerRegistryOptions): ManagedRunnerRegistry {
  const runners = new Map<RunnerName, Runner>();
  const fakes = new Map<RunnerName, InProcessFakeRunner>();
  const caps = new Map<RunnerName, RunnerCapabilities>();

  if (opts.fake) {
    for (const name of ALL_NAMES) {
      const fake = new InProcessFakeRunner(name);
      fakes.set(name, fake);
      runners.set(name, fake);
    }
  } else {
    const logger = opts.logger ? { logger: opts.logger } : {};
    const sandbox = opts.sandbox ? { sandbox: opts.sandbox } : {};
    runners.set(
      'claude',
      new ClaudeRunner({
        ...logger,
        ...sandbox,
        ...(opts.commands?.claude ? { command: opts.commands.claude } : {}),
      }),
    );
    runners.set(
      'codex',
      new CodexRunner({
        ...logger,
        ...sandbox,
        ...(opts.commands?.codex ? { command: opts.commands.codex } : {}),
      }),
    );
    runners.set(
      'dsh',
      new DshRunner({
        env: opts.env,
        ...logger,
        ...(opts.commands?.dsh ? { command: opts.commands.dsh } : {}),
      }),
    );
  }

  async function probeOne(name: RunnerName): Promise<RunnerCapabilities | undefined> {
    const runner = runners.get(name);
    if (!runner) return undefined;
    let result: RunnerCapabilities;
    try {
      result = await runner.probe();
    } catch (err) {
      result = {
        runner: name,
        available: false,
        credentials: 'unknown',
        supports: {
          jsonSchema: false,
          resume: false,
          quota: false,
          effort: false,
          readOnly: false,
        },
        flags: [],
        problems: [redactSecrets(`probe failed: ${(err as Error).message}`)],
      };
    }
    caps.set(name, result);
    opts.logger?.info('runner probed', {
      runner: name,
      available: result.available,
      version: result.version ?? null,
      credentials: result.credentials,
      problems: result.problems,
    });
    return result;
  }

  return {
    get: (name) => runners.get(name),
    names: () => [...runners.keys()],
    capabilities: (name) => caps.get(name),
    probe: probeOne,
    async probeAll() {
      const results = await Promise.all([...runners.keys()].map((n) => probeOne(n)));
      return results.filter((r): r is RunnerCapabilities => r !== undefined);
    },
    fake: (name) => fakes.get(name),
  };
}
