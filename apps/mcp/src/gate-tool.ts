import { runGate, TeamApiError, type GateJob, type TeamClient } from '@agent-team/client';
import { z } from 'zod';
import type { ToolDef } from './tools.js';

// spec §19: a thin MCP wrapper over POST /api/gate + GET /api/gate/{id}. Waits for the verdict.

async function projectId(client: TeamClient, value: string): Promise<string> {
  if (/^p_[0-9a-z]+$/.test(value)) return value;
  const found = (await client.listProjects()).find((p) => p.name === value);
  if (!found) {
    throw new TeamApiError({ code: 'not_found', message: `no project named ${value}` }, 404);
  }
  return found.id;
}

function gateText(job: GateJob): string {
  const lines = [
    `${job.gate_id} ${job.verdict ?? job.state}${job.committed ? ' (committed)' : ''}${job.head_sha ? ` head ${job.head_sha.slice(0, 12)}` : ''}; ${job.files_changed.length} file(s) changed`,
    ...job.reasons.map((r) => `- ${r}`),
  ];
  if (job.out_of_scope.length > 0) lines.push(`out of scope: ${job.out_of_scope.join(', ')}`);
  for (const c of job.checks) {
    lines.push(`check ${c.name}: ${c.result}`);
    if (c.result === 'fail' && c.tail !== '') lines.push('```', c.tail, '```');
  }
  return lines.join('\n');
}

function tool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

const gateWorktree = tool({
  name: 'gate_worktree',
  title: 'Gate a worktree',
  description:
    "Have the agent-team service verify a worker's worktree instead of trusting its report: the worktree must be a linked worktree of the project's repository on its own branch, every changed file (per git: commits since base_sha, uncommitted and untracked files) must be inside owned_paths, and the project's machine checks must pass in the service's sandbox. On pass the service commits exactly the verified files (no hooks). Waits for the verdict (pass, rejected or checks_failed). Only when the user runs the work; the leader may not.",
  shape: {
    project: z.string().min(1).describe('Project id (p_…) or name'),
    worktree_path: z.string().min(1).describe('Absolute path of the worktree'),
    base_sha: z.string().min(4).describe('The commit the work started from'),
    owned_paths: z.array(z.string().min(1)).min(1).describe('Paths or globs the work may change'),
    commit_message: z.string().min(1).optional().describe('Default "team(gate): <branch>"'),
    commit: z.boolean().optional().describe('false = verify only (default true)'),
  },
  readOnly: false,
  async run(client, args, context) {
    const job = await runGate(
      client,
      {
        project_id: await projectId(client, args.project),
        worktree_path: args.worktree_path,
        base_sha: args.base_sha.trim().toLowerCase(),
        owned_paths: args.owned_paths,
        commit: args.commit ?? true,
        ...(args.commit_message === undefined ? {} : { commit_message: args.commit_message }),
      },
      {
        ...(context.signal ? { signal: context.signal } : {}),
        onStarted: (id) => context.progress?.(`gate ${id} running`),
      },
    );
    return {
      text: gateText(job),
      data: {
        gate_id: job.gate_id,
        verdict: job.verdict ?? null,
        committed: job.committed,
        head_sha: job.head_sha ?? null,
        out_of_scope: job.out_of_scope,
      },
    };
  },
});

export const GATE_TOOLS: readonly ToolDef[] = [gateWorktree];
