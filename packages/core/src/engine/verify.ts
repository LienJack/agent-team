import { commitMessage, joinPosix, RUN_LOG_FILES, type Task } from '@agent-team/schema';
import type { GitPort } from '../ports/git.js';
import { filesOutside, isPathOwned } from '../util/paths.js';
import { lastLines } from '../util/time.js';
import type { EngineContext, Tx } from './context.js';
import { projectIgnoresCase } from './dispatch.js';
import { effectPayload, type EffectFinalizer, type EffectHandler } from './effect-queue.js';
import { blockTask, requestFix } from './outcomes.js';
import { saveRun, saveTask, saveWorkspace } from './records.js';

/** Lines of check output kept for the fix ticket (spec §6 step 4). */
export const CHECK_TAIL_LINES = 20;

type CheckSummary = { name: string; passed: boolean; tail: string };

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'check';
}

function list(files: readonly string[], max = 30): string {
  const shown = files.slice(0, max).map((f) => `\`${f}\``);
  return files.length > max ? `${shown.join('、')} …（共 ${files.length} 個）` : shown.join('、');
}

/**
 * Changed files that are out of bounds: outside `owned_paths`, or resolving (through a symlink,
 * the file itself or a parent directory) to a path outside them or outside the worktree (M7).
 * Each entry is printable: `file` or `file -> target`.
 */
async function outOfBounds(
  git: GitPort,
  worktreePath: string,
  files: readonly string[],
  task: Task,
  ignoreCase: boolean,
): Promise<string[]> {
  const opts = { ignoreCase };
  const out = filesOutside(files, task.owned_paths, opts);
  const owned = files.filter((f) => !out.includes(f));
  if (owned.length === 0) return out;
  const resolved = await git.resolvePaths({ worktreePath, files: owned });
  for (const file of owned) {
    if (!(file in resolved)) continue; // deleted
    const target = resolved[file];
    if (target === file) continue;
    if (target === null || target === undefined) out.push(`${file} -> (outside the worktree)`);
    else if (!isPathOwned(target, task.owned_paths, opts)) out.push(`${file} -> ${target}`);
  }
  return out;
}

/**
 * `run.verify` effect: spec §6 steps 3–5 for an accepted impl/fix receipt — the worktree has
 * changes, every changed file (per git, not the receipt; symlinks resolved) is inside
 * `owned_paths`, every project check passes, then the changed-file list is computed again: if the
 * checks added any file (or anything out of bounds appeared) nothing is committed (H3);
 * otherwise exactly the verified files are committed. Any failing step → `outcome = rejected` and
 * a fix run (or escalation). Git/check infrastructure errors throw so the effect retries; when
 * retries run out the task is blocked. A service shutdown aborts a running check (the effect
 * stays for the next start) and never starts the commit.
 */
export const verifyHandler: EffectHandler = {
  async run(ctx, effect) {
    const { run_id: runId } = effectPayload(effect, 'run.verify');
    const run = ctx.store.runs.get(runId);
    const task = run ? ctx.store.tasks.get(run.task_id) : undefined;
    if (!run || !task || run.state !== 'succeeded' || run.outcome !== null) return undefined;
    if (task.status !== 'verifying' || task.current_run_id !== run.id) return undefined;
    const project = ctx.store.projects.get(task.project_id);
    const ws = ctx.store.workspaces.get(run.workspace_id);
    if (!project || !ws) {
      return (tx) => rejectRun(ctx, tx, runId, 'workspace_missing', '找不到任務的 worktree 紀錄。');
    }
    const { git, checks } = ctx.deps;
    const signal = ctx.shutdownController.signal;
    const ignoreCase = await projectIgnoresCase(ctx, project);

    // step 3: there are changes, and all of them are owned
    const all = await git.changedFiles({ worktreePath: ws.path, sinceSha: ws.base_sha });
    const fresh =
      ws.head_sha === null
        ? all
        : await git.changedFiles({ worktreePath: ws.path, sinceSha: ws.head_sha });
    if (fresh.length === 0) {
      return (tx) =>
        rejectRun(ctx, tx, runId, 'no_changes', 'worktree 沒有任何變更；請實際完成派工單的修改。');
    }
    const outside = await outOfBounds(git, ws.path, all, task, ignoreCase);
    if (outside.length > 0) {
      return (tx) =>
        rejectRun(
          ctx,
          tx,
          runId,
          `out_of_bounds: ${outside.slice(0, 10).join(', ')}`,
          `下列檔案不在 owned_paths 內，請還原它們的變更：${list(outside)}`,
        );
    }

    // step 4: machine checks, one by one (full output goes to the run's log dir)
    const results: CheckSummary[] = [];
    for (const [i, check] of project.checks.entries()) {
      const outcome = await checks.run({
        cwd: ws.path,
        name: check.name,
        cmd: check.cmd,
        logPath: joinPosix(
          run.log_dir,
          RUN_LOG_FILES.checksDir,
          `${i + 1}-${slug(check.name)}.log`,
        ),
        timeoutMs: ctx.config.engine.check_timeout_ms,
        signal,
        repoPath: project.repo_path,
      });
      if (signal.aborted) throw new Error('verification aborted: service shutdown');
      results.push({
        name: check.name,
        passed: outcome.passed,
        tail: lastLines(outcome.tail, CHECK_TAIL_LINES),
      });
    }
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const notes = [
        '機器檢查未通過：',
        ...failed.map((r) => `### ${r.name}：fail\n\n\`\`\`\n${r.tail}\n\`\`\``),
      ].join('\n\n');
      return (tx) =>
        rejectRun(
          ctx,
          tx,
          runId,
          `checks_failed: ${failed.map((r) => r.name).join(', ')}`,
          notes,
          results,
        );
    }

    // step 5: the list again, right before committing (checks run worker-authored code)
    if (signal.aborted) throw new Error('verification aborted: service shutdown');
    const after = await git.changedFiles({ worktreePath: ws.path, sinceSha: ws.base_sha });
    const added = after.filter((f) => !all.includes(f));
    const nowOutside = await outOfBounds(git, ws.path, after, task, ignoreCase);
    const unexpected = [...new Set([...added, ...nowOutside])];
    if (unexpected.length > 0) {
      return (tx) =>
        rejectRun(
          ctx,
          tx,
          runId,
          `changed_during_checks: ${unexpected.slice(0, 10).join(', ')}`,
          `機器檢查執行後多出（或越界）的檔案，未提交任何東西：${list(unexpected)}。檢查不得寫入受版控的檔案；請找出是哪個檢查或測試產生它們並修正。`,
          results,
        );
    }
    // service-side commit of exactly the verified files
    const message = commitMessage(task.id, task.title);
    const commit = await git.commitFiles({ worktreePath: ws.path, message, files: all });
    return acceptRun(runId, ws.id, { ...commit, message }, results);
  },

  onDead(ctx, tx, effect, error) {
    const { run_id: runId } = effectPayload(effect, 'run.verify');
    const run = tx.r.runs.get(runId);
    const task = run ? tx.r.tasks.get(run.task_id) : undefined;
    if (!run || run.outcome !== null) return;
    saveRun(tx, run, { outcome: 'rejected', reject_reason: `verify_error: ${error}` });
    if (task && task.status === 'verifying' && task.current_run_id === run.id) {
      blockTask(ctx, tx, task, `核對無法完成：${error}`);
    }
  },
};

function checksOf(results: CheckSummary[]) {
  return results.map(({ name, passed }) => ({ name, passed }));
}

function acceptRun(
  runId: string,
  workspaceId: string,
  commit: { sha: string; created: boolean; message: string },
  results: CheckSummary[],
): EffectFinalizer {
  return (tx) => {
    const run = tx.r.runs.get(runId);
    if (!run || run.outcome !== null) return;
    saveRun(tx, run, { outcome: 'ok' });
    const ws = tx.r.workspaces.get(workspaceId);
    if (ws) saveWorkspace(tx, ws, { head_sha: commit.sha });
    if (commit.created) {
      tx.emit(
        'commit.created',
        { workspace_id: workspaceId, sha: commit.sha, message: commit.message },
        { task_id: run.task_id, run_id: run.id },
      );
    }
    tx.emit(
      'run.verified',
      { outcome: 'ok', reject_reason: null, checks: checksOf(results) },
      { task_id: run.task_id, run_id: run.id },
    );
    const task = tx.r.tasks.get(run.task_id);
    if (!task || task.status !== 'verifying' || task.current_run_id !== run.id) return;
    saveTask(
      tx,
      task,
      { status: 'review', current_run_id: null, fix_notes: null, recovery_note: null },
      `verified and committed ${commit.sha}`,
    );
  };
}

function rejectRun(
  ctx: EngineContext,
  tx: Tx,
  runId: string,
  reason: string,
  notes: string,
  results: CheckSummary[] = [],
): void {
  const run = tx.r.runs.get(runId);
  if (!run || run.outcome !== null) return;
  saveRun(tx, run, { outcome: 'rejected', reject_reason: reason });
  tx.emit(
    'run.verified',
    { outcome: 'rejected', reject_reason: reason, checks: checksOf(results) },
    { task_id: run.task_id, run_id: run.id },
  );
  const task = tx.r.tasks.get(run.task_id);
  if (!task || task.status !== 'verifying' || task.current_run_id !== run.id) return;
  requestFix(ctx, tx, task, notes, reason.split(':')[0] ?? reason);
}
