import { resolve } from 'node:path';
import type { Command } from 'commander';
import { formatResearch, taskLine } from '../format.js';
import { UsageError } from '../io.js';
import type { CommandContext } from '../program.js';
import { idempotencyKeyFor, projectId } from './work.js';

/**
 * `team research add|show` (spec §17): research tasks look for open-source projects worth
 * borrowing from before planning. Their runs read the web only — never the project — and the
 * links in their results are not checked by the service.
 */
export function registerResearchCommands(program: Command, ctx: CommandContext): void {
  const research = program.command('research').description('research tasks (spec §17)');
  research
    .command('add <project>')
    .description('create a research task (question with --question, --question-file or -)')
    .argument('[stdin]', '"-" to read the question from stdin')
    .requiredOption('--title <title>', 'task title')
    .option('--question <text>', 'the question')
    .option('--question-file <file>', 'file holding the question')
    .option('--queue', 'queue immediately instead of creating a draft')
    .action(
      async (
        project: string,
        stdin: string | undefined,
        options: { title: string; question?: string; questionFile?: string; queue?: boolean },
      ) => {
        if (stdin !== undefined && stdin !== '-') {
          throw new UsageError(`unexpected argument "${stdin}" (use - for stdin)`);
        }
        const sources = [options.question !== undefined, options.questionFile !== undefined];
        sources.push(stdin === '-');
        if (sources.filter(Boolean).length !== 1) {
          throw new UsageError(
            'give the question with exactly one of --question, --question-file or -',
          );
        }
        const question =
          options.question ??
          (stdin === '-'
            ? await ctx.io.readStdin()
            : await ctx.io.readFile(resolve(ctx.io.cwd, options.questionFile!)));
        if (question.trim() === '') throw new UsageError('the question is empty');
        const client = await ctx.client();
        const body = {
          project_id: await projectId(client, project),
          title: options.title,
          question,
          queue: options.queue === true,
        };
        // the leader's replayed turn gets the first result back (see `team task add`)
        const key = idempotencyKeyFor(ctx.io.env['AGENT_TEAM_IDEMPOTENCY_SEED'], body);
        const created = await client.createResearch(
          body,
          key ? { idempotencyKey: key } : undefined,
        );
        ctx.print(created, () => taskLine(created));
      },
    );

  research
    .command('show <task_id>')
    .description('the result of a research task (links not verified by the service)')
    .action(async (taskId: string) => {
      const detail = await (await ctx.client()).getResearch(taskId);
      ctx.print(detail, () => formatResearch(detail));
    });
}
