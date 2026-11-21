import { assertNoPermissionBypass } from '@agent-team/runners';

// `claude -p` argv of one leader turn (spec §9). Lean start (no CLAUDE.md, skills, plugins,
// hooks or MCP servers), the Bash tool only, an allow-list of the `team` subcommands the leader
// uses, and a deny-list of the commands Claude Code would otherwise run without asking (its
// built-in read-only set: `ls`, `cat`, `echo`, `pwd`, …). `--permission-mode dontAsk` refuses
// everything else without asking. Deny rules win over allow rules and over the read-only
// auto-approval; none of them can match a `team …` command (checked by a test). The remaining
// surface is documented in docs/adr/0012-leader-shell-surface.md.

export const LEADER_TOOLS = 'Bash';

/**
 * `team` subcommands the leader may run: exact rules for the bare commands plus prefix rules
 * (`:*`, heredoc input included) for the ones that take arguments. Not here: `serve`, `watch`,
 * `ask` (never end; the shim refuses them too), `leader`, `project` (owner actions; the server
 * also answers 403 to the leader actor).
 */
export const LEADER_ALLOW_RULES = [
  'Bash(team status)',
  'Bash(team status:*)',
  'Bash(team doctor)',
  'Bash(team doctor:*)',
  'Bash(team resume)',
  'Bash(team resume:*)',
  'Bash(team roles)',
  'Bash(team roles:*)',
  'Bash(team task:*)',
  'Bash(team receipt:*)',
  'Bash(team attention:*)',
  'Bash(team --json:*)',
  'Bash(team --help)',
  'Bash(team help:*)',
] as const;

/**
 * Commands refused outright, bare and with arguments. Claude Code auto-approves its read-only
 * commands even in `dontAsk` mode; an explicit deny is the only way to switch that off.
 */
export const LEADER_DENIED_COMMANDS = [
  // listing, reading and searching files
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'fd',
  'tree',
  'file',
  'stat',
  'wc',
  'du',
  'df',
  'nl',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'jq',
  'sed',
  'awk',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  // printing and the environment
  'echo',
  'printf',
  'pwd',
  'env',
  'printenv',
  'set',
  'export',
  'whoami',
  'id',
  'hostname',
  'uname',
  'date',
  'which',
  'type',
  'command',
  'ps',
  'lsof',
  // shells, interpreters and tools that run other programs
  'cd',
  'sh',
  'bash',
  'zsh',
  'node',
  'python',
  'python3',
  'git',
  'xargs',
  'sleep',
  'true',
  'false',
  'test',
  'seq',
  'yes',
] as const;

export const LEADER_DENY_RULES: readonly string[] = LEADER_DENIED_COMMANDS.flatMap((cmd) => [
  `Bash(${cmd})`,
  `Bash(${cmd}:*)`,
]);

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
  '--disallowedTools',
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
  args.push('--tools', LEADER_TOOLS, '--allowedTools', ...LEADER_ALLOW_RULES);
  if (has('--disallowedTools')) args.push('--disallowedTools', ...LEADER_DENY_RULES);
  args.push('--permission-mode', 'dontAsk');
  if (has('--permission-prompts')) args.push('--permission-prompts', 'none');
  if (input.effort !== undefined && has('--effort')) args.push('--effort', input.effort);
  args.push('--append-system-prompt', input.systemPrompt);
  assertNoPermissionBypass(args);
  return args;
}
