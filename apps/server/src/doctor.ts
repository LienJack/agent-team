import { access, constants } from 'node:fs/promises';
import { errorMessage, type RunnerRegistry, type Store } from '@agent-team/core';
import {
  ENV_VARS,
  type DoctorResponse,
  type RunnerCapabilities,
  type RunnerName,
} from '@agent-team/schema';
import type { EnvReader } from './env.js';

const PROBE_TIMEOUT_MS = 15_000;

function unavailable(runner: RunnerName, problem: string): RunnerCapabilities {
  return {
    runner,
    available: false,
    credentials: 'unknown',
    supports: {
      jsonSchema: false,
      resume: false,
      quota: false,
      effort: false,
      readOnly: false,
      webSearch: false,
    },
    flags: [],
    problems: [problem],
  };
}

async function probe(registry: RunnerRegistry, name: RunnerName): Promise<RunnerCapabilities> {
  const runner = registry.get(name);
  if (!runner) return unavailable(name, 'not registered');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runner.probe(),
      new Promise<RunnerCapabilities>((resolve) => {
        timer = setTimeout(
          () => resolve(unavailable(name, `probe timed out after ${PROBE_TIMEOUT_MS} ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    return unavailable(name, `probe failed: ${errorMessage(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DoctorDeps {
  runners: RunnerRegistry;
  env: EnvReader;
  store: Store;
  dataDir: string;
}

/**
 * GET /api/doctor (spec §7, §11): fresh runner probes, which known environment variables are
 * present (names and booleans only, never values), data directory and database health.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorResponse> {
  const checks: DoctorResponse['checks'] = [];
  for (const spec of ENV_VARS) {
    const present = deps.env.has(spec.name);
    checks.push({
      name: `env.${spec.name}`,
      ok: present || !spec.required,
      detail: `${present ? 'present' : 'absent'}${spec.required ? ' (required)' : ' (optional)'}`,
    });
  }
  try {
    await access(deps.dataDir, constants.W_OK);
    checks.push({ name: 'data_dir', ok: true, detail: 'writable' });
  } catch (err) {
    checks.push({ name: 'data_dir', ok: false, detail: errorMessage(err) });
  }
  try {
    checks.push({ name: 'database', ok: true, detail: `event seq ${deps.store.events.lastSeq()}` });
  } catch (err) {
    checks.push({ name: 'database', ok: false, detail: errorMessage(err) });
  }
  const runners = await Promise.all(deps.runners.names().map((name) => probe(deps.runners, name)));
  return {
    ok: checks.every((c) => c.ok) && runners.every((r) => r.available),
    checks,
    runners,
  };
}
