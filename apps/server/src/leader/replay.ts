import type { KvRepository } from '@agent-team/core';
import type { Input } from './inputs.js';

// Turn replay after a crash (docs/adr/0012): every human message and digest whose turn started
// is marked in kv before `claude` is spawned, and the mark is removed only when the input is
// consumed (reply stored, or failed for good). An input that runs again while still marked —
// after a crash, a stop or a reset aborted its turn — may already have acted, so its prompt says
// so, and the `team task add` calls of the turn carry an Idempotency-Key derived from the input
// (DATA/leader/turn-key → the shim → AGENT_TEAM_IDEMPOTENCY_SEED), so an exact repeat of a
// create is answered from the server's idempotency table instead of creating a duplicate.

const PREFIX = 'leader:turn_started:';

/** Stable identity of an input across restarts (a digest by its first event). */
export function inputKey(input: Input): string | undefined {
  if (input.kind === 'human') return `msg:${input.pending.message.id}`;
  if (input.kind === 'events') return `events:${input.events[0]?.seq ?? 0}`;
  return undefined;
}

export const turnSeed = (key: string) => `leader:${key}`;

export function wasStarted(kv: KvRepository, key: string): boolean {
  return kv.get(PREFIX + key) !== undefined;
}

export function markStarted(kv: KvRepository, key: string, at: string): void {
  kv.set(PREFIX + key, at);
}

export function clearStarted(kv: KvRepository, key: string | undefined): void {
  if (key !== undefined) kv.delete(PREFIX + key);
}

export const REPLAY_NOTICE =
  '[服務端注意｜這則輸入先前已開始處理過一次，但那個 turn 中斷了（服務重啟、當機或被中止），你可能已經執行過部分動作。建立或修改任何東西之前，先用 `team task list`（必要時 `team task show <id>`）確認是否已經存在；已存在就不要再建立，直接回報現況。]';
