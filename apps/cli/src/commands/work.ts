import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { TeamApiError, type TeamClient } from '@agent-team/client';
import { Option, type Command } from 'commander';
import { printCommandResult, reportingRefusals } from '../delivery.js';
import { formatReceipt, formatTaskDetail, projectLine, roleLine, taskLine } from '../format.js';
import { UsageError } from '../io.js';
import type { CommandContext } from '../program.js';

const collect = (value: string, previous: string[]) => [...previous, value];

/**
 * `Idempotency-Key` of a create under a seed (AGENT_TEAM_IDEMPOTENCY_SEED; the leader's shim sets
 * it to its current turn): the same request in a replayed turn gets the same key, so the server
 * returns the first result instead of creating a duplicate; any other request gets another key.
 */
export function idempotencyKeyFor(seed: string | undefined, body: unknown): string | undefined {
  if (seed === undefined || seed.trim() === '') return undefined;
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
  return `${seed.trim().slice(0, 120)}:${hash}`;
}

/** `--check "name=cmd"` → `{ name, cmd }`. */
export function parseCheck(spec: string): { name: string; cmd: string } {
  const eq = spec.indexOf('=');
  const name = eq < 0 ? '' : spec.slice(0, eq).trim();
  const cmd = eq < 0 ? '' : spec.slice(eq + 1).trim();
  if (name === '' || cmd === '') throw new UsageError(`--check expects "name=cmd", got "${spec}"`);
  return { name, cmd };
}

/** `--paths "src/a, src/b"` → `['src/a', 'src/b']` (comma or whitespace separated). */
export function parsePaths(value: string): string[] {
  const paths = value.split(/[,\s]+/).filter((p) => p !== '');
  if (paths.length === 0) throw new UsageError('--paths needs at least one path');
  return paths;
}

/** A project id (`p_…`) or name. */
export async function projectId(client: TeamClient, value: string): Promise<string> {
  if (/^p_[0-9a-z]+$/.test(value)) return value;
  const found = (await client.listProjects()).find((p) => p.name === value);
  if (!found) {
    throw new TeamApiError(
      { code: 'not_found', message: `no project named ${value}`, hint: 'see `team status`' },
      404,
    );
  }
  return found.id;
}

/** `team project …`, `team task …`, `team receipt <task_id>` */
export function registerWorkCommands(program: Command, ctx: CommandContext): void {
  const project = program.command('project').description('projects');
  project
    .command('add <name> <repo>')
    .description('register a repository (local listener only)')
    .option('--base <branch>', 'base branch', 'main')
    .option('--check <name=cmd>', 'machine check, repeatable', collect, [] as string[])
    .option(
      '--allow-network',
      "let the project's sandboxed workers use the network (never this machine's ports)",
      false,
    )
    .action(
      async (
        name: string,
        repo: string,
        options: { base: string; check: string[]; allowNetwork: boolean },
      ) => {
        const checks = options.check.map(parseCheck);
        const repoPath = isAbsolute(repo) ? repo : resolve(ctx.io.cwd, repo);
        const created = await (
          await ctx.client()
        ).createProject({
          name,
          repo_path: repoPath,
          base_branch: options.base,
          checks,
          allow_network: options.allowNetwork,
        });
        ctx.print(created, () => projectLine(created));
      },
    );

  project
    .command('update <project>')
    .description("replace a project's machine checks (humans only; next verification on)")
    .option(
      '--check <name=cmd>',
      'machine check, repeatable; replaces the whole list',
      collect,
      [] as string[],
    )
    .option('--clear-checks', 'remove every check', false)
    .action(async (value: string, options: { check: string[]; clearChecks: boolean }) => {
      if (options.clearChecks === options.check.length > 0) {
        throw new UsageError('give --check "name=cmd" (repeatable) or --clear-checks, not both');
      }
      const checks = options.check.map(parseCheck);
      const client = await ctx.client();
      const updated = await client.updateProject(await projectId(client, value), { checks });
      ctx.print(updated, () =>
        [
          projectLine(updated),
          ...(updated.checks.length === 0
            ? ['  checks: (none)']
            : updated.checks.map((c) => `  check ${c.name}: ${c.cmd}`)),
        ].join('\n'),
      );
    });

  const task = program.command('task').description('tasks');
  task
    .command('add')
    .description('create a task from a ticket file or stdin (-)')
    .argument('[stdin]', '"-" to read the ticket from stdin')
    .requiredOption('--project <project>', 'project id or name')
    .requiredOption('--title <title>', 'task title')
    .addOption(
      new Option('--tier <tier>', 'A, B or C').choices(['A', 'B', 'C']).makeOptionMandatory(),
    )
    .requiredOption('--paths <paths>', 'owned paths, comma or space separated')
    .option('--ticket-file <file>', 'ticket markdown file')
    .option('--queue', 'queue immediately instead of creating a draft')
    .option(
      '--research <task_id>',
      'cite a done research task of the same project (repeatable, at most 3)',
      collect,
      [] as string[],
    )
    .action(
      async (
        stdin: string | undefined,
        options: {
          project: string;
          title: string;
          tier: 'A' | 'B' | 'C';
          paths: string;
          ticketFile?: string;
          queue?: boolean;
          research: string[];
        },
      ) => {
        await reportingRefusals(ctx, async () => {
          if (stdin !== undefined && stdin !== '-') {
            throw new UsageError(`unexpected argument "${stdin}" (use - for stdin)`);
          }
          const fromStdin = stdin === '-';
          if (fromStdin === (options.ticketFile !== undefined)) {
            throw new UsageError('give the ticket with exactly one of --ticket-file F or -');
          }
          const owned = parsePaths(options.paths);
          const ticket = fromStdin
            ? await ctx.io.readStdin()
            : await ctx.io.readFile(resolve(ctx.io.cwd, options.ticketFile!));
          if (ticket.trim() === '') throw new UsageError('the ticket is empty');
          const client = await ctx.client();
          const body = {
            project_id: await projectId(client, options.project),
            title: options.title,
            tier: options.tier,
            ticket_md: ticket,
            owned_paths: owned,
            queue: options.queue === true,
            ...(options.research.length > 0 ? { research_refs: options.research } : {}),
          };
          const key = idempotencyKeyFor(ctx.io.env['AGENT_TEAM_IDEMPOTENCY_SEED'], body);
          const result = await client.createTaskResult(
            body,
            key ? { idempotencyKey: key } : undefined,
          );
          printCommandResult(ctx, result);
        });
      },
    );

  task
    .command('list')
    .description('list tasks')
    .option('--project <project>', 'only this project (id or name)')
    .option('--status <statuses>', 'comma-separated statuses, e.g. queued,running')
    .action(async (options: { project?: string; status?: string }) => {
      const client = await ctx.client();
      const query = {
        ...(options.project === undefined
          ? {}
          : { project_id: await projectId(client, options.project) }),
        ...(options.status === undefined ? {} : { status: options.status }),
      };
      const tasks = await client.listTasks(query);
      ctx.print(tasks, () => (tasks.length === 0 ? 'no tasks' : tasks.map(taskLine).join('\n')));
    });

  task
    .command('show <id>')
    .description('task detail with runs and attention')
    .action(async (id: string) => {
      const detail = await (await ctx.client()).getTask(id);
      ctx.print(detail, () => formatTaskDetail(detail));
    });

  for (const action of ['queue', 'cancel', 'retry'] as const) {
    task
      .command(`${action} <id>`)
      .description(`${action} a task (prints its delivery and a report line)`)
      .action(async (id: string) => {
        await reportingRefusals(ctx, async () => {
          printCommandResult(ctx, await (await ctx.client()).taskActionResult(id, action));
        });
      });
  }

  task
    .command('reassign <id> <role>')
    .description('use another role for the next impl/fix run (see `team roles`)')
    .action(async (id: string, role: string) => {
      const client = await ctx.client();
      const roles = await client.roles();
      const found = roles.find((r) => r.name === role);
      if (!found || !found.enabled) {
        const usable = roles.filter((r) => r.enabled).map((r) => r.name);
        throw new UsageError(
          `${found ? 'disabled' : 'unknown'} role "${role}"; one of: ${usable.join(', ')}`,
        );
      }
      const updated = await client.reassignTask(id, role);
      ctx.print(updated, () => taskLine(updated));
    });

  program
    .command('roles')
    .description('roles from config/models.json (model alias, runner, slots)')
    .action(async () => {
      const roles = await (await ctx.client()).roles();
      ctx.print(roles, () => roles.map(roleLine).join('\n'));
    });

  program
    .command('receipt <task_id>')
    .description("the task's latest receipt")
    .action(async (taskId: string) => {
      const detail = await (await ctx.client()).getTask(taskId);
      const text = formatReceipt(detail);
      if (text === undefined) {
        throw new TeamApiError(
          { code: 'not_found', message: `task ${taskId} has no receipt yet` },
          404,
        );
      }
      const latest = [...detail.runs].reverse().find((r) => r.receipt !== null)!;
      ctx.print({ run_id: latest.id, kind: latest.kind, receipt: latest.receipt }, text);
    });
}
