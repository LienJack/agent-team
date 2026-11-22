import { describe, expect, it } from 'vitest';
import { defaultServiceConfig, ServiceConfigSchema } from './config/service.js';
import { TaskCreateRequestSchema } from './api/dto.js';
import {
  isImplReceipt,
  isResearchReceipt,
  isReviewReceipt,
  parseReceipt,
  receiptJsonSchema,
  ReceiptSchema,
} from './receipts.js';
import {
  clipText,
  isPermissiveLicense,
  RESEARCH_LIMITS,
  researchUrlProblem,
} from './research-receipt.js';
import { canTransition, RESEARCH_TASK_TRANSITIONS, TASK_STATUSES } from './status.js';

const candidate = {
  name: 'bullmq-lite',
  url: 'https://github.com/example/queue',
  license: 'MIT',
  fit: 'high',
  borrow: '重試與退避的設計',
  caveats: '只支援 Redis',
};
const research = {
  dispatch_id: 'd_1',
  status: 'done',
  summary: '找到兩個候選',
  candidates: [candidate],
  recommendation: 'adapt_pattern',
  needs_leader: '',
};

describe('§17 research receipt', () => {
  it('parses a valid receipt and tells the receipt kinds apart', () => {
    const parsed = parseReceipt('research', research);
    expect(parsed).toEqual({ ok: true, receipt: research });
    const receipt = ReceiptSchema.parse(research);
    expect(isResearchReceipt(receipt)).toBe(true);
    expect(isImplReceipt(receipt)).toBe(false);
    expect(isReviewReceipt(receipt)).toBe(false);
    // an impl receipt also has `status`, but no candidates
    const impl = ReceiptSchema.parse({
      dispatch_id: 'd_2',
      status: 'done',
      summary: 'ok',
      files_changed: [],
      checks: [],
      needs_leader: '',
    });
    expect(isResearchReceipt(impl)).toBe(false);
    expect(isImplReceipt(impl)).toBe(true);
  });

  it.each([
    ['http://github.com/x', 'must be https'],
    ['https://user:pw@github.com/x', 'must not contain credentials'],
    ['https://token@github.com/x', 'must not contain credentials'],
    ['javascript:alert(1)', 'must be https'],
    ['github.com/x', 'not a URL'],
    ['file:///etc/passwd', 'must be https'],
  ])('rejects the url %s (%s)', (url, problem) => {
    expect(researchUrlProblem(url)).toBe(problem);
    const parsed = parseReceipt('research', { ...research, candidates: [{ ...candidate, url }] });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('url') });
  });

  it('clips over-long text and extra candidates instead of rejecting (ADR 0017)', () => {
    const long = (n: number) => 'x'.repeat(n);
    const parsed = parseReceipt('research', {
      ...research,
      summary: long(900),
      candidates: Array.from({ length: 12 }, () => ({
        ...candidate,
        name: long(200),
        license: long(80),
        borrow: long(1000),
        caveats: long(1000),
      })),
      needs_leader: undefined,
    });
    const asks = parseReceipt('research', { ...research, needs_leader: 'q'.repeat(2000) });
    expect(asks.ok && [...asks.receipt.needs_leader].length).toBe(RESEARCH_LIMITS.needs_leader);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = parsed.receipt;
    expect([...r.summary]).toHaveLength(RESEARCH_LIMITS.summary);
    expect(r.candidates).toHaveLength(RESEARCH_LIMITS.candidates);
    expect([...r.candidates[0]!.name]).toHaveLength(RESEARCH_LIMITS.name);
    expect([...r.candidates[0]!.license]).toHaveLength(RESEARCH_LIMITS.license);
    expect([...r.candidates[0]!.borrow]).toHaveLength(RESEARCH_LIMITS.borrow);
    expect([...r.candidates[0]!.caveats]).toHaveLength(RESEARCH_LIMITS.caveats);
    expect(r.needs_leader).toBe('');
  });

  it('still rejects what decides the outcome: status, recommendation, dispatch id', () => {
    expect(parseReceipt('research', { ...research, status: 'maybe' }).ok).toBe(false);
    expect(parseReceipt('research', { ...research, recommendation: 'copy_it' }).ok).toBe(false);
    expect(parseReceipt('research', { ...research, dispatch_id: '' }).ok).toBe(false);
    expect(
      parseReceipt('research', { ...research, candidates: [{ ...candidate, fit: 'x' }] }).ok,
    ).toBe(false);
  });

  it('hands runners a plain strict JSON schema (no format/pattern keywords)', () => {
    const schema = receiptJsonSchema('research');
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"format"|"pattern"/);
    expect(schema['required']).toEqual([
      'dispatch_id',
      'status',
      'summary',
      'candidates',
      'recommendation',
      'needs_leader',
    ]);
    expect(text).toContain('"maxItems":8');
    expect(schema['additionalProperties']).toBe(false);
  });

  it('knows the permissive licences', () => {
    for (const l of ['MIT', 'apache-2.0', 'BSD-3-Clause', 'ISC', 'BSD']) {
      expect(isPermissiveLicense(l)).toBe(true);
    }
    for (const l of ['GPL-3.0', 'AGPL-3.0', 'unknown', 'MPL-2.0']) {
      expect(isPermissiveLicense(l)).toBe(false);
    }
    expect(clipText('abc', 2)).toBe('a…');
  });
});

describe('§17 research task lifecycle and settings', () => {
  it('research tasks go draft → queued → running → done, never verifying or review', () => {
    expect(Object.keys(RESEARCH_TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const [from, to] of [
      ['draft', 'queued'],
      ['queued', 'running'],
      ['running', 'done'],
      ['running', 'queued'],
      ['running', 'blocked'],
      ['blocked', 'queued'],
      ['failed', 'queued'],
    ] as const) {
      expect(canTransition(from, to, 'research')).toBe(true);
    }
    expect(canTransition('running', 'verifying', 'research')).toBe(false);
    expect(canTransition('running', 'done')).toBe(false); // impl tasks need review
    expect(canTransition('blocked', 'review', 'research')).toBe(false);
  });

  it('service.json research defaults to on_request with a 10 minute timeout', () => {
    expect(defaultServiceConfig().research).toEqual({ mode: 'on_request', timeout_ms: 600000 });
    expect(ServiceConfigSchema.safeParse({ research: { mode: 'sometimes' } }).success).toBe(false);
  });

  it('a task cites at most 3 research tasks', () => {
    const base = {
      project_id: 'p_1',
      title: 't',
      tier: 'C',
      ticket_md: 'x',
      owned_paths: ['src/'],
    };
    expect(TaskCreateRequestSchema.parse(base).research_refs).toEqual([]);
    const refs = ['t_1', 't_2', 't_3', 't_4'];
    expect(TaskCreateRequestSchema.safeParse({ ...base, research_refs: refs }).success).toBe(false);
    expect(TaskCreateRequestSchema.safeParse({ ...base, research_refs: ['x_1'] }).success).toBe(
      false,
    );
  });
});
