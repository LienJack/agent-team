import type { RunSpec } from '@agent-team/schema';
import { strip, workerDenyPaths, type SandboxPolicy } from '../sandbox-policy.js';

// Codex worker sandbox (docs/adr/0014): a permission profile instead of `--sandbox`, so the
// shared deny list applies. Checked with codex-cli 0.171.0 without a model: `codex sandbox` with
// this profile refuses reads of denied paths, writes outside the worktree and temp dirs, writes
// to the worktree's `.git` file and loopback connections; `codex exec` (against a local fake
// model endpoint) renders exactly this profile into its prompt when `--sandbox` is omitted —
// with `--sandbox` the built-in profile wins and the deny entries are dropped. The SDK passes
// `--sandbox` only when `sandboxMode` is set, so the runner leaves it unset.
// The profile is passed as `--config` arguments after `exec` by the group wrapper: the SDK's own
// `config` option cannot express table keys such as `":root"` or absolute paths.

export const CODEX_PROFILE = 'agent-team';

const toml = (v: string) => JSON.stringify(v);

/** `--config` arguments selecting and defining the run's permission profile. */
export function codexSandboxArgs(spec: RunSpec, policy: SandboxPolicy): string[] {
  const entries: Array<[string, string]> = [[':root', 'read']];
  if (spec.writable) {
    const cwd = strip(spec.cwd);
    entries.push(
      [cwd, 'write'],
      [`${cwd}/.git`, 'read'],
      [':tmpdir', 'write'],
      [':slash_tmp', 'write'],
    );
  }
  for (const p of workerDenyPaths(spec, policy)) entries.push([p, 'deny']);
  const table = `{${entries.map(([k, v]) => `${toml(k)}=${toml(v)}`).join(', ')}}`;
  const network = spec.sandbox?.allowNetwork === true;
  return [
    '--config',
    `default_permissions=${toml(CODEX_PROFILE)}`,
    '--config',
    `permissions.${CODEX_PROFILE}.filesystem=${table}`,
    '--config',
    `permissions.${CODEX_PROFILE}.network={enabled=${network}}`,
    '--config',
    'web_search="disabled"',
  ];
}
