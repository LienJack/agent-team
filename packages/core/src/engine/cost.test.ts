import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';
import { testModelsConfig } from '../testing/fixtures.js';
import { estimateCostUsd } from './cost.js';

// Validation 2026-11-21: codex and dsh report no cost. The engine stores an estimate from token
// usage × models.json `price`, flagged `cost_estimated`, so every view can label it.

function pricedModels() {
  const models = testModelsConfig();
  models.models['deepseek-flash'] = { ...models.models['deepseek-flash']!, price: [0.05, 0.2] };
  models.models['gpt-sol'] = { ...models.models['gpt-sol']!, price: [2, 10] };
  return models;
}

describe('estimated cost', () => {
  it('prices input + cache writes in full, cache reads at 10%, output at the output price', () => {
    const usage = {
      input_tokens: 9_800,
      cache_write_tokens: 200,
      cache_read_tokens: 37_600,
      output_tokens: 1_000,
      reasoning_tokens: 400,
    };
    // (10_000 × 0.05 + 37_600 × 0.005 + 1_000 × 0.2) / 1e6
    expect(estimateCostUsd(pricedModels(), 'deepseek-flash', usage)).toBeCloseTo(0.000888, 9);
    expect(estimateCostUsd(pricedModels(), 'jev', usage)).toBeUndefined(); // no price
    expect(estimateCostUsd(pricedModels(), 'deepseek-flash', {})).toBeUndefined(); // no tokens
    expect(estimateCostUsd(pricedModels(), 'deepseek-flash', null)).toBeUndefined();
  });

  it('a run without a reported cost stores the estimate, flagged; a reported cost is kept as is', async () => {
    const h = createTestEngine({ config: { models: pricedModels() } });
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    // the impl run (dsh): usage only, like the real runner
    h.runners.dsh.script(
      editing(h.git, ['src/feature/b.ts'], {
        result: (spec) => ({
          final: {
            dispatch_id: spec.dispatchId,
            status: 'done',
            summary: 'ok',
            files_changed: ['src/feature/b.ts'],
            checks: [],
            needs_leader: '',
          },
          usage,
        }),
      }),
    );
    const task = h.task();
    await h.engine.runUntilIdle();
    const runs = h.store.runs.list({ task_id: task.id });
    const impl = runs.find((r) => r.kind === 'impl')!;
    expect(impl.cost_estimated).toBe(true);
    expect(impl.cost_usd).toBeCloseTo(0.25, 9); // 1M × 0.05 + 1M × 0.2
    const finished = h.store.events
      .listAfter(0)
      .find((e) => e.type === 'run.finished' && e.run_id === impl.id);
    expect(finished?.data).toMatchObject({ cost_estimated: true });
    // the review run (default fake result) reported its cost: kept, not an estimate
    const review = runs.find((r) => r.kind === 'review')!;
    expect(review).toMatchObject({ cost_usd: 0.01, cost_estimated: false });
  });
});
