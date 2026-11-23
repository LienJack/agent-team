import { isAbsolute, resolve } from 'node:path';
import { runGate, type GateJob } from '@agent-team/client';
import { EXIT_CODES } from '@agent-team/schema';
import type { Command } from 'commander';
import type { CommandContext } from '../program.js';
import { parsePaths, projectId } from './work.js';

/** Short text of a finished gate job: verdict, out-of-scope files, one line per check. */
export function formatGate(job: GateJob): string {
  const verdict = job.verdict ?? job.state;
  const head = job.head_sha === undefined ? '' : ` head ${job.head_sha.slice(0, 12)}`;
  const lines = [
    `${job.gate_id} ${verdict}${job.committed ? ' (committed)' : ''}${head} · ${job.files_changed.length} file(s) changed`,
  ];
  for (const reason of job.reasons) lines.push(`  ${reason}`);
  if (job.out_of_scope.length > 0) {
    lines.push('  out of scope:', ...job.out_of_scope.map((f) => `    ${f}`));
  }
  for (const check of job.checks) {
    lines.push(`  check ${check.name}: ${check.result}`);
    if (check.result === 'fail' && check.tail !== '') {
      lines.push(...check.tail.split('\n').map((l) => `    | ${l}`));
    }
  }
  return lines.join('\n');
}

/**
 * `team gate <project>` (spec §19): verify a worktree the service did not create (owned paths,
 * the project's machine checks, a service-side commit of the verified files) and wait for the
 * verdict. Exit 0 on pass, 1 otherwise. Humans only (the leader's token is refused).
 */
export function registerGateCommand(program: Command, ctx: CommandContext): void {
  program
    .command('gate <project>')
    .description('verify and commit an outside worktree (owned paths, checks); humans only')
    .requiredOption('--worktree <path>', 'the worktree to check')
    .requiredOption('--base <sha>', 'the commit the work started from')
    .requiredOption('--paths <globs>', 'owned paths, comma or space separated')
    .option('--message <text>', 'commit message (default "team(gate): <branch>")')
    .option('--no-commit', 'verify only; commit nothing')
    .action(
      async (
        project: string,
        options: {
          worktree: string;
          base: string;
          paths: string;
          message?: string;
          commit: boolean;
        },
      ) => {
        const owned = parsePaths(options.paths);
        const worktree = isAbsolute(options.worktree)
          ? options.worktree
          : resolve(ctx.io.cwd, options.worktree);
        const client = await ctx.client();
        const job = await runGate(
          client,
          {
            project_id: await projectId(client, project),
            worktree_path: worktree,
            base_sha: options.base.trim().toLowerCase(),
            owned_paths: owned,
            commit: options.commit,
            ...(options.message === undefined ? {} : { commit_message: options.message }),
          },
          {
            ...(ctx.io.gatePollMs === undefined ? {} : { pollMs: ctx.io.gatePollMs }),
            ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
          },
        );
        ctx.print(job, () => formatGate(job));
        ctx.exitCode = job.verdict === 'pass' ? EXIT_CODES.ok : EXIT_CODES.business;
      },
    );
}
