import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_LAYOUT } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { bootLeader, type FakeClaude, turnSteps } from '../testing/fake-claude.js';
import { local, TEST_LEADER_TOKEN, type TestService } from '../testing/harness.js';
import type { LeaderImpl } from './leader.js';
import { REPLAY_NOTICE } from './replay.js';

// docs/adr/0012 (turn replay): a turn that started may have acted before a crash; the next run
// of the same input says so, and its `team task add` calls carry an idempotency seed.

let h: TestService;
let fake: FakeClaude;
const leader = () => h.service.leader as LeaderImpl;
const marker = (id: string) => `leader:turn_started:msg:${id}`;

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  await h.cleanup();
});

/** A turn that runs `team status`, then waits (so it can be observed or stopped mid-turn). */
function slowTurn(delayMs: number) {
  const steps = turnSteps({ text: '好', commands: ['team status'] });
  const lastToolResult = steps.findLastIndex(
    (s) => (s.out as { type?: string } | undefined)?.type === 'user',
  );
  steps.splice(lastToolResult + 1, 0, { delayMs });
  return steps;
}

describe('leader turn replay', () => {
  it('marks the turn before spawning, hands the shim the seed, clears both with the reply', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(slowTurn(600));
    await h.service.start();
    const pending = h
      .localApp()
      .request(
        '/api/leader/messages',
        local({ text: '建一張單', source: 'cli', client_msg_id: 'r-1' }),
      );
    await until(() => fake.turns().length === 1);
    const message = h.store.messages.findByClientMsgId('leader', 'r-1')!;
    expect(h.store.kv.get(marker(message.id))).toBeDefined();
    const keyFile = join(h.dataDir, DATA_LAYOUT.leaderTurnKey);
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(`leader:msg:${message.id}`);
    expect((await pending).status).toBe(200);
    await leader().settled();
    expect(h.store.kv.get(marker(message.id))).toBeUndefined();
    // the first run of an input has no notice
    expect(fake.turns()[0]!.stdin).not.toContain(REPLAY_NOTICE);
  });

  it('a stop after the turn ran a command keeps the mark; the replay says it may have acted', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(slowTurn(5000));
    await h.service.start();
    void Promise.resolve(
      h
        .localApp()
        .request(
          '/api/leader/messages',
          local({ text: '建一張單', source: 'cli', client_msg_id: 'r-2' }),
        ),
    ).catch(() => {});
    await until(() => fake.turns().length === 1);
    await new Promise((r) => setTimeout(r, 300)); // the command step has been played
    await h.service.stop();
    const message = h.store.messages.findByClientMsgId('leader', 'r-2')!;
    expect(message.status).toBe('new');
    expect(h.store.kv.get(marker(message.id))).toBeDefined();
  });

  it('after a crash the stored, marked message is replayed with the notice, then unmarked', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps({ text: '已確認，沒有重複建立' }));
    const { message } = h.service.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: 'cli',
      body: '把 README 拆成兩張單',
      client_msg_id: 'crashed-1',
    });
    h.store.kv.set(marker(message.id), '2026-11-21T00:00:00.000Z'); // what the crash left
    await h.service.start();
    await until(() => fake.turns().length === 1);
    await leader().settled();
    expect(fake.turns()[0]!.stdin.startsWith(REPLAY_NOTICE)).toBe(true);
    expect(h.store.kv.get(marker(message.id))).toBeUndefined();
    expect(existsSync(join(h.dataDir, DATA_LAYOUT.leaderTurnKey))).toBe(true);
  });

  it("the server de-duplicates the leader's exact repeat of a create (same seed-derived key)", async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps());
    await h.service.start();
    const project = h.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    const body = {
      project_id: project.id,
      title: '拆出的單',
      tier: 'C',
      ticket_md: '# 做這個',
      owned_paths: ['src/a.ts'],
    };
    const post = (b: unknown) =>
      h
        .localApp()
        .request(
          '/api/tasks',
          local(b, { 'idempotency-key': 'leader:msg:m_1:0123456789abcdef' }, TEST_LEADER_TOKEN),
        );
    const first = (await (await post(body)).json()) as { task: { id: string } };
    const again = await post(body);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(((await again.json()) as { task: { id: string } }).task.id).toBe(first.task.id);
    expect(h.store.tasks.list().filter((t) => t.title === '拆出的單')).toHaveLength(1);
  });
});
