import { askLeader as askTheLeader, randomId, type TeamClient } from '@agent-team/client';
import { z } from 'zod';
import { attentionList, formatStatus, taskLine } from './format.js';

/** What a tool produces: the text the model reads, plus a small structured copy. */
export interface ToolOutput {
  text: string;
  data?: Record<string, unknown>;
}

/** Per-call context from the MCP request (cancellation, progress). */
export interface ToolContext {
  /** Aborted when the MCP client cancels the call. */
  signal?: AbortSignal;
  /** Report that the call is still working (keeps clients that reset on progress waiting). */
  progress?: (message: string) => void;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  shape: Shape;
  readOnly: boolean;
  run(
    client: TeamClient,
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolContext,
  ): Promise<ToolOutput>;
}

function tool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

export const TASK_ACTIONS = ['queue', 'cancel', 'retry', 'approve', 'reject', 'reassign'] as const;

const askLeader = tool({
  name: 'ask_leader',
  title: 'Ask the leader',
  description:
    'Send a message to the agent-team leader (the planning model that manages the task board) and return its reply text. Use for requests, questions or instructions about the work; the reply may take several minutes (the tool keeps waiting until it arrives or the call is cancelled; a cancelled message is still answered later in the board chat).',
  shape: { text: z.string().min(1).max(20000).describe('Message for the leader') },
  readOnly: false,
  async run(client, { text }, context) {
    const reply = await askTheLeader(client, {
      text,
      source: 'mcp',
      clientMsgId: `mcp-${randomId()}`,
      ...(context.signal ? { signal: context.signal } : {}),
      onPending: ({ messageId }) =>
        context.progress?.(`the leader is still working on ${messageId}`),
    });
    return {
      text: reply.reply === '' ? '(empty reply)' : reply.reply,
      data: { message_id: reply.message_id },
    };
  },
});

const status = tool({
  name: 'status',
  title: 'Board status',
  description:
    'Compact summary of the task board: task counts per column, running tasks and who executes them, number of open attention items, runner availability and quota, leader state. Does not include logs or transcripts.',
  shape: {},
  readOnly: true,
  async run(client) {
    const s = await client.state();
    return {
      text: formatStatus(s),
      data: {
        open_attention: s.open_attention.length,
        leader: s.leader.state,
        runners: s.runners.map((r) => ({ runner: r.runner, available: r.available })),
      },
    };
  },
});

const listAttention = tool({
  name: 'list_attention',
  title: 'List open attention items',
  description:
    'List open questions/decisions waiting for the user, with their ids and answer options. Answer them with answer_attention.',
  shape: {},
  readOnly: true,
  async run(client) {
    const items = await client.listAttention({ status: 'open' });
    return {
      text: attentionList(items),
      data: { items: items.map((a) => ({ id: a.id, question: a.question, options: a.options })) },
    };
  },
});

const answerAttention = tool({
  name: 'answer_attention',
  title: 'Answer an attention item',
  description:
    'Answer one open attention item by id (from list_attention). Pick one of its options verbatim when it has options, otherwise write a short free-text answer. Only answer on the user’s behalf when they told you the answer.',
  shape: {
    id: z.string().min(1).describe('Attention id, e.g. a_xxxxxxxxxxxx'),
    answer: z.string().min(1).max(4000).describe('The answer text'),
  },
  readOnly: false,
  async run(client, { id, answer }) {
    const item = await client.answerAttention(id, { answer, via: 'mcp' });
    return {
      text: `${item.id} ${item.status}: ${item.answer ?? answer}`,
      data: { id: item.id, status: item.status },
    };
  },
});

const taskAction = tool({
  name: 'task_action',
  title: 'Task action',
  description:
    'Act on one task by id. queue: start a draft; cancel: stop it; retry: re-run a failed/blocked task; approve: accept a task awaiting review; reject: send it back (requires note); reassign: give it to another role (requires role, e.g. impl_B). Returns the task’s new one-line state.',
  shape: {
    id: z.string().min(1).describe('Task id, e.g. t_xxxxxxxxxxxx'),
    action: z.enum(TASK_ACTIONS),
    role: z.string().min(1).optional().describe('Target role; required for reassign'),
    note: z.string().min(1).max(4000).optional().describe('Reason; required for reject'),
  },
  readOnly: false,
  async run(client, { id, action, role, note }) {
    let task;
    if (action === 'reassign') {
      if (role === undefined) throw new InputError('reassign needs `role`');
      task = await client.reassignTask(id, role);
    } else if (action === 'reject') {
      if (note === undefined) throw new InputError('reject needs `note` (why it is sent back)');
      task = await client.rejectTask(id, note);
    } else {
      task = await client.taskAction(id, action);
    }
    return { text: taskLine(task), data: { id: task.id, status: task.status } };
  },
});

/** A caller mistake that Zod cannot express (cross-field rules). */
export class InputError extends Error {}

export const TOOLS: readonly ToolDef[] = [
  askLeader,
  status,
  listAttention,
  answerAttention,
  taskAction,
];
