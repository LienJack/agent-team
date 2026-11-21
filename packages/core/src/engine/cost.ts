import type { ModelsConfig, Usage } from '@agent-team/schema';

// Estimated cost of a run whose runner reports none (codex, dsh): token usage × the model's
// `price` in models.json (USD per million tokens, [input, output]). Rule (docs/validation notes):
// - uncached input and cache writes at the input price;
// - cache reads at 10% of the input price (the usual provider discount; the real one varies);
// - output at the output price; reasoning tokens are not added again (providers count them
//   inside the output tokens).
// It is labelled `cost_estimated` wherever it is shown; it is not a bill.

export const CACHE_READ_FACTOR = 0.1;

export function estimateCostUsd(
  models: Pick<ModelsConfig, 'models'>,
  alias: string,
  usage: Usage | null | undefined,
): number | undefined {
  const price = models.models[alias]?.price;
  if (!usage || !price) return undefined;
  const [inPrice, outPrice] = price;
  const input = (usage.input_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  const cached = usage.cache_read_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (input + cached + output === 0) return undefined;
  const usd = (input * inPrice + cached * inPrice * CACHE_READ_FACTOR + output * outPrice) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
