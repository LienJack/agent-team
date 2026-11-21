import { describe, expect, it } from 'vitest';
import { parseReceipt, receiptJsonSchema, RECEIPT_SUMMARY_MAX } from './receipts.js';

const impl = {
  dispatch_id: 'd_1',
  status: 'done',
  summary: '完成',
  files_changed: ['src/a.ts'],
  checks: [{ cmd: 'pnpm test', result: 'pass', note: '' }],
  needs_leader: '',
};
const review = {
  dispatch_id: 'd_2',
  verdict: 'needs_changes',
  summary: '有問題',
  findings: [{ file: 'src/a.ts', line: 3, severity: 'must_fix', issue: 'x' }],
};

type Node = { [k: string]: unknown };
function objectNodes(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach((n) => objectNodes(n, out));
  else if (node && typeof node === 'object') {
    const n = node as Node;
    if (n['type'] === 'object') out.push(n);
    Object.values(n).forEach((v) => objectNodes(v, out));
  }
  return out;
}

describe('receipts', () => {
  it('parse valid impl and review receipts', () => {
    expect(parseReceipt('impl', impl)).toEqual({ ok: true, receipt: impl });
    expect(parseReceipt('review', review)).toEqual({ ok: true, receipt: review });
  });

  it('reject wrong shapes with a short message', () => {
    const bad = parseReceipt('impl', { ...impl, status: 'maybe' });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('status') });
    expect(parseReceipt('impl', review).ok).toBe(false);
    expect(parseReceipt('review', impl).ok).toBe(false);
    expect(parseReceipt('impl', undefined).ok).toBe(false);
  });

  it(`clip summary to ${RECEIPT_SUMMARY_MAX} characters instead of refusing the receipt`, () => {
    expect(parseReceipt('impl', { ...impl, summary: '字'.repeat(600) })).toMatchObject({
      ok: true,
      receipt: { summary: '字'.repeat(600) },
    });
    // a real dsh run (2026-11-21) lost a fix round to a 601+ character summary
    const long = parseReceipt('review', { ...review, summary: '字'.repeat(900) });
    expect(long).toMatchObject({ ok: true });
    const summary = long.ok ? long.receipt.summary : '';
    expect(summary).toHaveLength(RECEIPT_SUMMARY_MAX);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('treat a missing or null needs_leader and missing lists as empty (real dsh receipts)', () => {
    const { needs_leader: _omitted, ...withoutNeeds } = impl;
    expect(parseReceipt('impl', withoutNeeds)).toMatchObject({
      ok: true,
      receipt: { needs_leader: '' },
    });
    expect(
      parseReceipt('impl', { ...impl, needs_leader: null, files_changed: null, checks: null }),
    ).toMatchObject({ ok: true, receipt: { needs_leader: '', files_changed: [], checks: [] } });
    expect(parseReceipt('review', { ...review, findings: null })).toMatchObject({
      ok: true,
      receipt: { findings: [] },
    });
    // what decides the outcome is still strict
    expect(parseReceipt('impl', { ...impl, status: null }).ok).toBe(false);
    expect(parseReceipt('impl', { ...impl, dispatch_id: undefined }).ok).toBe(false);
    expect(parseReceipt('review', { ...review, verdict: undefined }).ok).toBe(false);
  });

  it.each(['impl', 'review'] as const)('%s JSON Schema is strict for structured output', (kind) => {
    const schema = receiptJsonSchema(kind);
    expect(schema['$schema']).toBeUndefined();
    const nodes = objectNodes(schema);
    expect(nodes.length).toBeGreaterThan(1);
    for (const n of nodes) {
      expect(n['additionalProperties']).toBe(false);
      expect([...(n['required'] as string[])].sort()).toEqual(
        Object.keys(n['properties'] as object).sort(),
      );
    }
    expect((schema['properties'] as Node)['summary']).toMatchObject({ maxLength: 600 });
  });
});
