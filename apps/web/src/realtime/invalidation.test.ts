import { EVENT_TYPES, type EventRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createInvalidationBatcher, queriesForEvent, type Invalidator } from './invalidation.js';

function event(type: string, over: Partial<EventRecord> = {}, data: unknown = {}): EventRecord {
  return {
    seq: 10,
    ts: '2026-11-20T08:00:00.000Z',
    task_id: null,
    run_id: null,
    type,
    data,
    ...over,
  } as EventRecord;
}

describe('queriesForEvent — event → query invalidation', () => {
  it('refreshes the board and only the affected task on a status change', () => {
    expect(queriesForEvent(event('task.status_changed', { task_id: 't_1' }))).toEqual([
      ['state'],
      ['task', 't_1'],
    ]);
  });

  it('refreshes the run log tail on run changes', () => {
    expect(queriesForEvent(event('run.finished', { task_id: 't_1', run_id: 'r_9' }))).toEqual([
      ['state'],
      ['task', 't_1'],
      ['runLog', 'r_9'],
    ]);
  });

  it('refreshes the board for commits and workspace changes (cards show the head sha)', () => {
    for (const type of ['commit.created', 'workspace.updated', 'workspace.created']) {
      expect(queriesForEvent(event(type, { task_id: 't_2' }))).toEqual([
        ['state'],
        ['task', 't_2'],
      ]);
    }
    expect(queriesForEvent(event('review.completed', { task_id: 't_2' }))).toEqual([
      ['task', 't_2'],
    ]);
    expect(queriesForEvent(event('workspace.kept'))).toEqual([]);
  });

  it('a finished research task refreshes its drawer and the board (citable research)', () => {
    const data = { recommendation: 'reference_only', summary: '', candidates: [] };
    expect(
      queriesForEvent(event('research.completed', { task_id: 't_r1', run_id: 'r_r1' }, data)),
    ).toEqual([['state'], ['task', 't_r1']]);
  });

  it('a run log event refreshes only that run’s log tail', () => {
    expect(queriesForEvent(event('run.log_advanced', { run_id: 'r_7' }, { offset: 1024 }))).toEqual(
      [['runLog', 'r_7']],
    );
  });

  it('leader events refresh the chat and the top bar', () => {
    expect(
      queriesForEvent(
        event('leader.reply', {}, { message_id: 'm_2', in_reply_to: 'm_1', channel: 'leader' }),
      ),
    ).toEqual([['leaderMessages'], ['state']]);
    expect(
      queriesForEvent(
        event('leader.reply', {}, { message_id: 'm_2', in_reply_to: 'm_1', channel: 'grok' }),
      ),
    ).toEqual([['state']]);
    expect(
      queriesForEvent(
        event(
          'leader.status_changed',
          {},
          { state: 'busy', available: true, reason: null, until: null },
        ),
      ),
    ).toEqual([['state']]);
  });

  it('maps attention to the snapshot and messages to the chat history', () => {
    expect(queriesForEvent(event('attention.opened'))).toEqual([['state']]);
    expect(
      queriesForEvent(event('message.created', {}, { channel: 'leader', direction: 'in' })),
    ).toEqual([['leaderMessages'], ['state']]);
    expect(
      queriesForEvent(event('message.created', {}, { channel: 'grok', direction: 'in' })),
    ).toEqual([]);
  });

  it('ignores bookkeeping events and refreshes everything after a recovery', () => {
    expect(queriesForEvent(event('effect.failed'))).toEqual([]);
    expect(queriesForEvent(event('outbox.sent'))).toEqual([]);
    expect(queriesForEvent(event('recovery.completed'))).toEqual([
      ['state'],
      ['task'],
      ['runLog'],
      ['roles'],
    ]);
  });

  it('maps every known event type without throwing, and unknown ones to the snapshot', () => {
    for (const type of EVENT_TYPES) {
      expect(Array.isArray(queriesForEvent(event(type, { task_id: 't', run_id: 'r' })))).toBe(true);
    }
    expect(queriesForEvent(event('something.new'))).toEqual([['state']]);
  });
});

describe('createInvalidationBatcher', () => {
  function setup() {
    const calls: string[] = [];
    const target: Invalidator = {
      invalidateQueries: async ({ queryKey }) => {
        calls.push(queryKey.join('/'));
      },
    };
    let scheduled: (() => void) | undefined;
    const batcher = createInvalidationBatcher(target, 100, (fn) => {
      scheduled = fn;
      return () => {
        scheduled = undefined;
      };
    });
    return { calls, batcher, run: () => scheduled?.() };
  }

  it('coalesces a burst into one invalidation per key', () => {
    const { calls, batcher, run } = setup();
    batcher.add([['state'], ['task', 't_1']]);
    batcher.add([['state'], ['task', 't_1'], ['task', 't_2']]);
    expect(calls).toEqual([]);
    run();
    expect(calls).toEqual(['state', 'task/t_1', 'task/t_2']);
  });

  it('skips keys covered by a prefix in the same batch', () => {
    const { calls, batcher, run } = setup();
    batcher.add([['task', 't_1'], ['task'], ['runLog', 'r_1']]);
    run();
    expect(calls).toEqual(['task', 'runLog/r_1']);
  });

  it('drops pending work on dispose', () => {
    const { calls, batcher, run } = setup();
    batcher.add([['state']]);
    batcher.dispose();
    run();
    batcher.flush();
    expect(calls).toEqual([]);
  });
});
