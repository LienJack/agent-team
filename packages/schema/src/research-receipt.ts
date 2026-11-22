import { z } from 'zod';

// Final answer of a research worker (spec §17). The text comes from a model that read untrusted
// web pages, so everything is bounded: at most 8 candidates, every string capped. The URLs are
// never fetched by the service (the board and the CLI say so); they are only checked to be
// `https:` without credentials. The runner-facing JSON schema is the plain shape below; the
// URL rule is a refinement checked by the service (strict structured-output dialects may refuse
// `format`/`pattern` keywords).

/** Caps of a research receipt (spec §17). */
export const RESEARCH_LIMITS = {
  summary: 600,
  candidates: 8,
  name: 80,
  url: 400,
  license: 40,
  borrow: 300,
  caveats: 200,
  /** Becomes an attention question verbatim, so it is bounded too. */
  needs_leader: 600,
} as const;

export const ResearchFitSchema = z.enum(['high', 'medium', 'low']);
export type ResearchFit = z.infer<typeof ResearchFitSchema>;

export const ResearchRecommendationSchema = z.enum([
  'adopt_dependency',
  'adapt_pattern',
  'reference_only',
  'build_from_scratch',
]);
export type ResearchRecommendation = z.infer<typeof ResearchRecommendationSchema>;

/** Why `url` is not acceptable in a research receipt, or null (https only, no user:pass@). */
export function researchUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'must be https';
  if (parsed.username !== '' || parsed.password !== '') return 'must not contain credentials';
  if (parsed.hostname === '') return 'has no host';
  return null;
}

const candidateShape = {
  name: z.string().min(1).max(RESEARCH_LIMITS.name),
  url: z.string().min(1).max(RESEARCH_LIMITS.url),
  /** SPDX identifier (`MIT`, `Apache-2.0`, …) or `unknown`. */
  license: z.string().min(1).max(RESEARCH_LIMITS.license),
  fit: ResearchFitSchema,
  /** What is worth borrowing (a dependency, a pattern, an API design, …). */
  borrow: z.string().max(RESEARCH_LIMITS.borrow),
  caveats: z.string().max(RESEARCH_LIMITS.caveats),
};

const receiptShape = <C extends z.ZodType>(candidate: C) => ({
  dispatch_id: z.string().min(1),
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().max(RESEARCH_LIMITS.summary),
  candidates: z.array(candidate).max(RESEARCH_LIMITS.candidates),
  recommendation: ResearchRecommendationSchema,
  /** `""` when nothing is needed from the leader or a person. */
  needs_leader: z.string().max(RESEARCH_LIMITS.needs_leader),
});

/** The shape handed to runners as structured output (no refinements). */
export const ResearchReceiptOutputSchema = z.object(receiptShape(z.object(candidateShape)));

export const ResearchCandidateSchema = z.object(candidateShape).superRefine((c, ctx) => {
  const problem = researchUrlProblem(c.url);
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
});
export type ResearchCandidate = z.infer<typeof ResearchCandidateSchema>;

/** A research receipt as the service accepts and stores it (URLs checked). */
export const ResearchReceiptSchema = z.object(receiptShape(ResearchCandidateSchema));
export type ResearchReceipt = z.infer<typeof ResearchReceiptSchema>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `text` cut to `max` characters (code points), ending in `…` when cut. */
export function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * Forgive format slips (ADR 0017) without loosening the bounds: over-long strings are clipped to
 * their caps, extra candidates dropped, a missing `needs_leader`/`candidates` filled in. The
 * fields that decide the outcome (`dispatch_id`, `status`, `recommendation`, every URL) are still
 * validated strictly.
 */
export function normalizeResearchReceipt(value: unknown): unknown {
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (typeof out['summary'] === 'string') {
    out['summary'] = clipText(out['summary'], RESEARCH_LIMITS.summary);
  }
  if (out['needs_leader'] === undefined || out['needs_leader'] === null) out['needs_leader'] = '';
  if (typeof out['needs_leader'] === 'string') {
    out['needs_leader'] = clipText(out['needs_leader'], RESEARCH_LIMITS.needs_leader);
  }
  const list = out['candidates'];
  if (list === undefined || list === null) out['candidates'] = [];
  else if (Array.isArray(list)) {
    out['candidates'] = list.slice(0, RESEARCH_LIMITS.candidates).map((c: unknown) => {
      if (!isObject(c)) return c;
      const next: Record<string, unknown> = { ...c };
      for (const key of ['name', 'license', 'borrow', 'caveats'] as const) {
        const v = next[key];
        if (typeof v === 'string') next[key] = clipText(v, RESEARCH_LIMITS[key]);
      }
      return next;
    });
  }
  return out;
}

/** Licences under which code may be copied (spec §17); everything else is "reference only". */
export const PERMISSIVE_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

/** Whether an SPDX id is one of the permissive licences (case-insensitive; `BSD` counts). */
export function isPermissiveLicense(license: string): boolean {
  const id = license.trim().toLowerCase();
  return id === 'bsd' || PERMISSIVE_LICENSES.some((l) => l.toLowerCase() === id);
}
