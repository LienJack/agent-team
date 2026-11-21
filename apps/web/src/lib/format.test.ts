import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDuration,
  formatPercent,
  formatTime,
  formatTokens,
  shortSha,
  usageTokens,
} from './format.js';

describe('formatDuration', () => {
  it.each([
    [0, '0 秒'],
    [45_400, '45 秒'],
    [60_000, '1 分'],
    [192_000, '3 分 12 秒'],
    [3_900_000, '1 小時 5 分'],
    [7_200_000, '2 小時'],
    [183_600_000, '2 天 3 小時'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('rejects negative and non-finite values', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatCost', () => {
  it.each([
    [null, '—'],
    [0, '$0'],
    [0.004, '<$0.01'],
    [0.125, '$0.13'],
    [12, '$12.00'],
  ])('%s → %s', (usd, text) => {
    expect(formatCost(usd)).toBe(text);
  });
});

describe('formatTokens', () => {
  it.each([
    [undefined, '—'],
    [950, '950'],
    [1000, '1k'],
    [12_340, '12.3k'],
    [1_250_000, '1.3M'],
  ])('%s → %s', (n, text) => {
    expect(formatTokens(n)).toBe(text);
  });
});

describe('small formatters', () => {
  it('formats shares, shas and usage', () => {
    expect(formatPercent(0.456)).toBe('46%');
    expect(formatPercent(1.4)).toBe('100%');
    expect(formatPercent(null)).toBe('—');
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha(null)).toBe('—');
    expect(usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 99 })).toBe(15);
    expect(usageTokens(null)).toBe(0);
  });

  it('adds the date only for other days', () => {
    const now = new Date('2026-11-20T10:00:00');
    expect(formatTime('2026-11-20T08:05:00', now)).toMatch(/08:05/);
    expect(formatTime('2026-11-18T08:05:00', now)).toMatch(/11.18/);
    expect(formatTime(null, now)).toBe('—');
    expect(formatTime('nope', now)).toBe('—');
  });
});
