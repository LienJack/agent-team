import { AskAbortedError, askLeader, randomId } from '@agent-team/client';
import type { Command } from 'commander';
import { attentionLine } from '../format.js';
import { UsageError } from '../io.js';
import type { CommandContext } from '../program.js';

/** Exit code after Ctrl-C stopped `team ask` waiting (the message stays queued). */
export const ASK_INTERRUPTED = 130;

const collect = (value: string, previous: string[]) => [...previous, value];
const STATUSES = ['open', 'answered', 'superseded'] as const;

/** `team ask "<text>"`, `team leader reset`, `team attention list | open … | answer <id> "<answer>"` */
export function registerTalkCommands(program: Command, ctx: CommandContext): void {
  program
    .command('ask <text>')
    .description('send a message to the leader and wait for its reply (Ctrl-C stops waiting)')
    .action(async (text: string) => {
      const client = await ctx.client();
      try {
        const reply = await askLeader(client, {
          text,
          source: 'cli',
          clientMsgId: ctx.io.newMessageId?.() ?? randomId(),
          ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
          ...(ctx.io.askPollMs === undefined ? {} : { pollMs: ctx.io.askPollMs }),
          onPending: ({ messageId }) =>
            ctx.io.stderr(`(leader 還在處理 ${messageId}，繼續等待；Ctrl-C 停止等待)\n`),
        });
        ctx.print(reply, reply.reply);
      } catch (err) {
        if (!(err instanceof AskAbortedError)) throw err;
        ctx.io.stderr(
          `stopped waiting${err.messageId ? ` for ${err.messageId}` : ''}: the message is stored and the leader still answers it (board chat, GET /api/leader/messages)\n`,
        );
        ctx.exitCode = ASK_INTERRUPTED;
      }
    });

  const leader = program.command('leader').description('the leader conversation');
  leader
    .command('reset')
    .description('start a new leader conversation (e.g. after logging in with another account)')
    .action(async () => {
      const result = await (await ctx.client()).resetLeader();
      ctx.print(result, () => `new leader session ${result.session_id} (${result.leader.state})`);
    });

  const attention = program.command('attention').description('decisions waiting for a human');
  attention
    .command('list')
    .description('attention items (open by default)')
    .option('--status <status>', 'open, answered or superseded', 'open')
    .action(async (options: { status: string }) => {
      if (!(STATUSES as readonly string[]).includes(options.status)) {
        throw new UsageError(`--status must be one of ${STATUSES.join(', ')}`);
      }
      const items = await (
        await ctx.client()
      ).listAttention({ status: options.status as (typeof STATUSES)[number] });
      ctx.print(items, () =>
        items.length === 0 ? `no ${options.status} items` : items.map(attentionLine).join('\n'),
      );
    });

  attention
    .command('open')
    .description('ask a human (question and options are passed verbatim)')
    .requiredOption('--question <q>', 'the question')
    .option('--option <a>', 'an answer option, repeatable', collect, [] as string[])
    .option('--task <id>', 'related task')
    .action(async (options: { question: string; option: string[]; task?: string }) => {
      const item = await (
        await ctx.client()
      ).openAttention({
        question: options.question,
        options: options.option,
        ...(options.task === undefined ? {} : { task_id: options.task }),
      });
      ctx.print(item, () => attentionLine(item));
    });

  attention
    .command('answer <id> <answer>')
    .description('answer an open item')
    .action(async (id: string, answer: string) => {
      const item = await (await ctx.client()).answerAttention(id, { answer, via: 'cli' });
      ctx.print(item, () => attentionLine(item));
    });
}
