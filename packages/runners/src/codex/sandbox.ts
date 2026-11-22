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

/**
 * Codex features that give the model tools other than web search (codex-cli 0.171.0
 * `codex features list`); a research run disables every one of them (spec §17). An unknown name
 * makes codex refuse to start — fail closed if a later version renames one. The real run of
 * 2026-11-21 (docs/validation-2026-11-21.md, round 4) showed what stays: code mode's `exec`
 * (a JS isolate with no fs/network) wrapping `web__run`, `apply_patch`, MCP-resource and clock
 * helpers, and the model catalog's collaboration tools — no shell. `apply_patch` cannot write
 * anything under the deny-all profile below; `goals` (added after that run) removes the goal
 * tools.
 */
export const CODEX_WEB_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'image_generation',
  'multi_agent',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'goals',
] as const;

/**
 * Research runs (spec §17; docs/adr/0021): live web search (run by the model provider, not by a
 * local command), every other tool feature disabled, and a profile that denies the whole
 * filesystem (`:root` = deny: a command that still ran could not even read `/bin`) with the
 * network off for local commands. The empty cwd is not opened either: there is nothing in it.
 */
function codexResearchArgs(): string[] {
  return [
    ...CODEX_WEB_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '--config',
    `default_permissions=${toml(CODEX_PROFILE)}`,
    '--config',
    `permissions.${CODEX_PROFILE}.filesystem={${toml(':root')}=${toml('deny')}}`,
    '--config',
    `permissions.${CODEX_PROFILE}.network={enabled=false}`,
    '--config',
    'web_search="live"',
  ];
}

/** `--config` arguments selecting and defining the run's permission profile. */
export function codexSandboxArgs(spec: RunSpec, policy: SandboxPolicy): string[] {
  if (spec.web === true) return codexResearchArgs();
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
