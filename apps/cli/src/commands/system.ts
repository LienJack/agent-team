import { EXIT_CODES } from '@agent-team/schema';
import type { Command } from 'commander';
import { eventLine, formatDoctor, formatStatus } from '../format.js';
import { UsageError } from '../io.js';
import type { CommandContext } from '../program.js';

export function parseSeq(value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`--after expects a seq number, got "${value}"`);
  return Number(value);
}

/** `team serve | status | doctor | resume | watch [--after seq]` */
export function registerSystemCommands(program: Command, ctx: CommandContext): void {
  program
    .command('serve')
    .description('run the agent-team service in the foreground')
    .action(async () => {
      ctx.exitCode = await ctx.io.serve();
    });

  program
    .command('status')
    .description('board summary: columns, running tasks, attention, runners, leader')
    .action(async () => {
      const state = await (await ctx.client()).state();
      ctx.print(state, () => formatStatus(state));
    });

  program
    .command('doctor')
    .description('runner probes and environment readiness')
    .action(async () => {
      const report = await (await ctx.client()).doctor();
      ctx.print(report, () => formatDoctor(report));
      if (!report.ok) ctx.exitCode = EXIT_CODES.business;
    });

  program
    .command('resume')
    .description('model-free status summary (for a new leader conversation)')
    .action(async () => {
      const resume = await (await ctx.client()).resume();
      ctx.print(resume, () => resume.summary_md.trimEnd());
    });

  program
    .command('watch')
    .description('print one line per event; reconnects and resumes with the last seq')
    .option('--after <seq>', 'replay events after this seq first', parseSeq)
    .action(async (options: { after?: number }) => {
      const client = await ctx.client();
      const subscription = client.events({
        ...(options.after === undefined ? {} : { after: options.after }),
        ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
        onEvent: (event) => {
          ctx.io.stdout(`${ctx.json() ? JSON.stringify(event) : eventLine(event)}\n`);
        },
        onError: (err) => {
          if (err.code !== 'unauthorized') {
            ctx.io.stderr(
              `watch: ${err.message} (reconnecting from seq ${subscription.lastSeq() ?? '-'})\n`,
            );
          }
        },
      });
      await subscription.done;
    });
}
