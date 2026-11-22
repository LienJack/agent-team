import type { RunSpec } from '@agent-team/schema';
import {
  CLAUDE_WEB_DENIED_TOOLS,
  CLAUDE_WEB_TOOLS,
  claudeResearchSettings,
  claudeWorkerSettings,
  type SandboxPolicy,
} from './sandbox.js';

export { claudeResearchSettings, claudeWorkerSettings, type SandboxPolicy } from './sandbox.js';

// `claude -p` argv (spec §7). The prompt goes to stdin; nothing here can skip permission checks.
// Every run is sandboxed (docs/adr/0014): `--restricted` plus `--settings` with the worker
// policy. Both are required flags — a CLI without them is unavailable, never run unsandboxed.

/** Writable runs: edit the worktree and run commands. Review runs: read only. */
export const CLAUDE_WRITE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;
export const CLAUDE_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Flags a research run (`spec.web`) cannot do without: `--tools` is what removes Bash and the
 * file tools (`--restricted` alone keeps Read/Edit; spec §17). Without it the probe reports
 * `webSearch: false` and research runs are refused.
 */
export const CLAUDE_WEB_REQUIRED_FLAGS = ['--tools', '--restricted', '--settings'] as const;

/** Flags the runner cannot work without (probe marks the runner unavailable otherwise). */
export const CLAUDE_REQUIRED_FLAGS = [
  '--print',
  '--model',
  '--output-format',
  '--verbose',
  '--json-schema',
  '--permission-mode',
  '--allowedTools',
  '--settings',
  '--restricted',
] as const;

/** Flags passed only when `claude --help` lists them. */
export const CLAUDE_OPTIONAL_FLAGS = [
  '--safe-mode',
  '--strict-mcp-config',
  '--mcp-config',
  '--permission-prompts',
  '--tools',
  '--effort',
  '--resume',
  '--disallowedTools',
] as const;

/** Never passed, whatever the CLI supports. */
export const PERMISSION_BYPASS_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
] as const;

const EMPTY_MCP = '{"mcpServers":{}}';

export function assertNoPermissionBypass(args: readonly string[]): void {
  for (const [i, a] of args.entries()) {
    if ((PERMISSION_BYPASS_FLAGS as readonly string[]).includes(a)) {
      throw new Error(`refusing to pass ${a}`);
    }
    if (a === '--permission-mode' && args[i + 1] === 'bypassPermissions') {
      throw new Error('refusing to pass --permission-mode bypassPermissions');
    }
  }
}

/** Assemble the argv after the executable; `flags` = what the probe found supported. */
export function claudeArgs(
  spec: RunSpec,
  flags: ReadonlySet<string>,
  policy: SandboxPolicy,
): string[] {
  const has = (f: string) => flags.has(f);
  for (const f of ['--settings', '--restricted']) {
    if (!has(f)) throw new Error(`claude does not support ${f}; refusing to run unsandboxed`);
  }
  const web = spec.web === true;
  if (web) {
    for (const f of CLAUDE_WEB_REQUIRED_FLAGS) {
      if (!has(f)) throw new Error(`claude does not support ${f}; refusing a research run`);
    }
  }
  const tools = (
    web ? CLAUDE_WEB_TOOLS : spec.writable ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS
  ).join(',');
  const settings = web ? claudeResearchSettings(spec, policy) : claudeWorkerSettings(spec, policy);
  const args = ['-p', '--model', spec.model, '--output-format', 'stream-json', '--verbose'];
  args.push('--json-schema', JSON.stringify(spec.schema));
  if (has('--safe-mode')) args.push('--safe-mode');
  args.push('--restricted');
  args.push('--settings', JSON.stringify(settings));
  if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
  if (has('--mcp-config')) args.push('--mcp-config', EMPTY_MCP);
  args.push('--permission-mode', 'dontAsk');
  if (has('--permission-prompts')) args.push('--permission-prompts', 'none');
  if (has('--tools')) args.push('--tools', tools);
  args.push('--allowedTools', tools);
  // research runs: the file/shell tools are refused a third time, by name
  if (web && has('--disallowedTools')) {
    args.push('--disallowedTools', CLAUDE_WEB_DENIED_TOOLS.join(','));
  }
  if (spec.effort !== undefined && has('--effort')) args.push('--effort', spec.effort);
  if (spec.resumeRef !== undefined && has('--resume')) args.push('--resume', spec.resumeRef);
  assertNoPermissionBypass(args);
  return args;
}
