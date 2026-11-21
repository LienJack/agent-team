import { z } from 'zod';

/** Default data directory (spec §4); `AGENT_TEAM_HOME` overrides it. */
export const DEFAULT_DATA_DIR = '~/.agent-team';

/** Layout under the data directory (relative POSIX paths). */
export const DATA_LAYOUT = {
  database: 'team.db',
  /** Mode 0600; `{ addr, token }` for CLI/MCP auto-connect. */
  listener: 'run/listener.json',
  runs: 'runs',
} as const;

/** Files inside `DATA/runs/<run_id>/`. */
export const RUN_LOG_FILES = {
  events: 'events.jsonl',
  stderr: 'stderr.log',
  prompt: 'prompt.md',
  /** Full output of machine checks during verification. */
  checksDir: 'checks',
} as const;

/** Content of `DATA/run/listener.json`. */
export const ListenerFileSchema = z.object({
  /** Base URL of the local listener, e.g. `http://127.0.0.1:4517`. */
  addr: z.url(),
  token: z.string().min(16),
});
export type ListenerFile = z.infer<typeof ListenerFileSchema>;

/** Join POSIX path segments without touching the filesystem. */
export function joinPosix(...parts: string[]): string {
  const joined = parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** `DATA/runs/<run_id>` */
export function runLogDir(dataDir: string, runId: string): string {
  return joinPosix(dataDir, DATA_LAYOUT.runs, runId);
}

/** Task branch name (spec §4): `team/<task_id>`. */
export function taskBranch(taskId: string): string {
  return `team/${taskId}`;
}

/** Task worktree path (spec §4): `<worktree_root>/<project>/<task_id>`. */
export function taskWorktreePath(
  worktreeRoot: string,
  projectName: string,
  taskId: string,
): string {
  return joinPosix(worktreeRoot, projectName, taskId);
}

/** Service-side commit message (spec §6 step 5). */
export function commitMessage(taskId: string, title: string): string {
  return `team(${taskId}): ${title}`;
}
