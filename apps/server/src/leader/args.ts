import { assertNoPermissionBypass } from '@agent-team/runners';

// `claude -p` argv of one leader turn (spec §9). Lean start (no CLAUDE.md, skills, plugins,
// hooks or MCP servers), the Bash tool only, and an allow-list that lets Bash run nothing but the
// `team` CLI. `--permission-mode dontAsk` refuses everything else without asking. Verified
// against Claude Code 2.1.326: `team …` runs; `ls /`, `env`, `cat <outside cwd>`,
// `team … && cat …` and `$(…)` are refused. Its built-in read-only commands confined to the
// working directory (`echo`, `pwd`, `ls`) still run; the leader's cwd is an empty directory.

export const LEADER_TOOLS = 'Bash';
/** Prefix rule: `team` followed by anything (heredoc input included). */
export const LEADER_ALLOW_RULE = 'Bash(team:*)';
const EMPTY_MCP = '{"mcpServers":{}}';

/** Without these the leader does not start (`not_installed`). */
export const LEADER_REQUIRED_FLAGS = [
  '--print',
  '--model',
  '--output-format',
  '--verbose',
  '--session-id',
  '--resume',
  '--append-system-prompt',
  '--tools',
  '--allowedTools',
  '--permission-mode',
] as const;

/** Passed only when `claude --help` lists them. */
export const LEADER_OPTIONAL_FLAGS = [
  '--safe-mode',
  '--strict-mcp-config',
  '--mcp-config',
  /** Ignores user/project settings files, so their allow rules cannot widen the allow-list. */
  '--restricted',
  '--permission-prompts',
  '--effort',
] as const;

export interface LeaderArgsInput {
  model: string;
  effort?: string | undefined;
  sessionId: string;
  /** false = first turn (`--session-id`), true = continue (`--resume`). */
  resume: boolean;
  systemPrompt: string;
  /** Supported flags found by the probe. */
  flags: ReadonlySet<string>;
}

export function leaderArgs(input: LeaderArgsInput): string[] {
  const has = (flag: string) => input.flags.has(flag);
  const args = ['-p', '--model', input.model, '--output-format', 'stream-json', '--verbose'];
  args.push(input.resume ? '--resume' : '--session-id', input.sessionId);
  if (has('--safe-mode')) args.push('--safe-mode');
  if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
  if (has('--mcp-config')) args.push('--mcp-config', EMPTY_MCP);
  if (has('--restricted')) args.push('--restricted');
  args.push('--tools', LEADER_TOOLS, '--allowedTools', LEADER_ALLOW_RULE);
  args.push('--permission-mode', 'dontAsk');
  if (has('--permission-prompts')) args.push('--permission-prompts', 'none');
  if (input.effort !== undefined && has('--effort')) args.push('--effort', input.effort);
  args.push('--append-system-prompt', input.systemPrompt);
  assertNoPermissionBypass(args);
  return args;
}
