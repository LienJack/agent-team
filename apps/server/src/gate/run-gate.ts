import { mkdir } from 'node:fs/promises';
import {
  CHECK_TAIL_LINES,
  errorMessage,
  filesOutside,
  isPathOwned,
  lastLines,
  type CheckExecutor,
} from '@agent-team/core';
import type { GateGit, GateWorktree } from '@agent-team/git';
import {
  joinPosix,
  redactSecrets,
  type GateCheck,
  type GateVerdict,
  type Project,
} from '@agent-team/schema';

// One gate job (spec §19 steps 1–5; docs/adr/0026): spec §6 steps 3–5 for a worktree the
// service did not create. Git is the truth, never the worker's report. The result is plain data;
// the job table (jobs.ts) stores it and writes the event.

export interface GateInput {
  project: Project | undefined;
  projectId: string;
  worktreePath: string;
  baseSha: string;
  ownedPaths: readonly string[];
  commitMessage: string | undefined;
  commit: boolean;
}

export interface GateDeps {
  git: GateGit;
  checks: CheckExecutor;
  /** DATA/gate/<gate_id> */
  logDir: string;
  checkTimeoutMs: number;
  /** Service shutdown: a running check is killed and the job ends rejected. */
  signal: AbortSignal;
}

export interface GateOutcome {
  verdict: GateVerdict;
  reasons: string[];
  files_changed: string[];
  out_of_scope: string[];
  checks: GateCheck[];
  head_sha?: string;
  committed: boolean;
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'check';
}

/**
 * Changed files out of bounds: outside `owned`, or resolving (through a symlink, the file itself
 * or a parent directory) outside them or outside the worktree. Same rule as core's verify.
 */
function outOfBounds(
  git: GateGit,
  wt: GateWorktree,
  files: readonly string[],
  owned: readonly string[],
  ignoreCase: boolean,
): string[] {
  const opts = { ignoreCase };
  const out = filesOutside(files, owned, opts);
  const inside = files.filter((f) => !out.includes(f));
  const resolved = git.resolvePaths(wt, inside);
  for (const file of inside) {
    if (!(file in resolved)) continue; // deleted
    const target = resolved[file];
    if (target === file) continue;
    if (target === null || target === undefined) out.push(`${file} -> (outside the worktree)`);
    else if (!isPathOwned(target, owned, opts)) out.push(`${file} -> ${target}`);
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

export async function runGate(input: GateInput, deps: GateDeps): Promise<GateOutcome> {
  const result: GateOutcome = {
    verdict: 'rejected',
    reasons: [],
    files_changed: [],
    out_of_scope: [],
    checks: [],
    committed: false,
  };
  const reject = (reason: string): GateOutcome => {
    result.verdict = 'rejected';
    result.reasons.push(reason);
    return result;
  };
  const { git, signal } = deps;
  const project = input.project;
  if (!project) return reject(`project ${input.projectId} not found`);

  // step 1: the worktree is a linked worktree of the project's repository, off the base branch
  const inspected = await git.inspect({
    repoPath: project.repo_path,
    worktreePath: input.worktreePath,
    baseBranch: project.base_branch,
    baseSha: input.baseSha,
  });
  if (!inspected.ok) return reject(inspected.reason);
  const wt = inspected.worktree;
  result.head_sha = wt.headSha;

  // step 2: what git says changed, all of it owned
  const ignoreCase = await git.ignoresCase(project.repo_path);
  const changed = await git.changedFiles(wt);
  result.files_changed = changed;
  if (changed.length === 0) return reject(`no changes since ${wt.baseSha.slice(0, 12)}`);
  result.out_of_scope = outOfBounds(git, wt, changed, input.ownedPaths, ignoreCase);
  if (result.out_of_scope.length > 0) {
    return reject(`${result.out_of_scope.length} changed file(s) outside owned_paths`);
  }

  // step 3: the project's machine checks, sandboxed like spec §6 step 4
  if (project.checks.length === 0) result.reasons.push('no machine checks');
  let stopped: string | undefined;
  for (const [i, check] of project.checks.entries()) {
    const entry: GateCheck = { name: check.name, cmd: check.cmd, result: 'not_run', tail: '' };
    result.checks.push(entry);
    if (stopped !== undefined) continue;
    if (signal.aborted) {
      stopped = 'service stopped';
      continue;
    }
    await mkdir(deps.logDir, { recursive: true, mode: 0o700 });
    try {
      const outcome = await deps.checks.run({
        cwd: wt.worktreePath,
        name: check.name,
        cmd: check.cmd,
        logPath: joinPosix(deps.logDir, `${i + 1}-${slug(check.name)}.log`),
        timeoutMs: deps.checkTimeoutMs,
        signal,
        repoPath: project.repo_path,
      });
      entry.tail = redactSecrets(lastLines(outcome.tail, CHECK_TAIL_LINES));
      if (outcome.refused !== undefined) {
        stopped = `check ${check.name} not run: ${outcome.refused}`;
      } else {
        entry.result = outcome.passed ? 'pass' : 'fail';
      }
    } catch (err) {
      entry.tail = redactSecrets(errorMessage(err));
      stopped = signal.aborted
        ? 'service stopped'
        : `check ${check.name} could not run: ${errorMessage(err)}`;
    }
  }
  if (signal.aborted) return reject('service stopped during the checks; nothing committed');
  if (stopped !== undefined) result.reasons.push(stopped);
  const failed = result.checks.filter((c) => c.result !== 'pass');
  if (failed.length > 0) {
    result.verdict = 'checks_failed';
    result.reasons.push(`checks not passed: ${failed.map((c) => c.name).join(', ')}`);
    return result;
  }

  // step 4: the same files after the checks (they run worker-authored code), same HEAD
  const again = await git.inspect({
    repoPath: project.repo_path,
    worktreePath: input.worktreePath,
    baseBranch: project.base_branch,
    baseSha: input.baseSha,
  });
  if (!again.ok) return reject(`after the checks: ${again.reason}`);
  if (again.worktree.headSha !== wt.headSha) return reject('HEAD moved during the checks');
  const after = await git.changedFiles(wt);
  if (!sameList(after, changed)) {
    const added = after.filter((f) => !changed.includes(f));
    const gone = changed.filter((f) => !after.includes(f));
    const what = [...added.map((f) => `+${f}`), ...gone.map((f) => `-${f}`)];
    return reject(`files changed during the checks: ${what.slice(0, 20).join(', ')}`);
  }
  const nowOutside = outOfBounds(git, wt, after, input.ownedPaths, ignoreCase);
  if (nowOutside.length > 0) {
    result.out_of_scope = nowOutside;
    return reject(`${nowOutside.length} changed file(s) outside owned_paths after the checks`);
  }

  // step 5: commit exactly the verified files (nothing new to commit → committed=false)
  if (input.commit) {
    try {
      const commit = await git.commit({
        worktree: wt,
        baseBranch: project.base_branch,
        files: changed,
        message: input.commitMessage ?? `team(gate): ${wt.branch}`,
      });
      result.head_sha = commit.sha;
      result.committed = commit.created;
    } catch (err) {
      return reject(`commit failed: ${errorMessage(err)}`);
    }
  }
  result.verdict = 'pass';
  return result;
}
