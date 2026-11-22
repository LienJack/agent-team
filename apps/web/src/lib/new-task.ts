import type { BoardTask, ResearchCreateBody, TaskCreateBody } from '@agent-team/client';
import {
  MAX_RESEARCH_REFS,
  ResearchCreateRequestSchema,
  TaskCreateRequestSchema,
} from '@agent-team/schema';

/** What the dialog creates: an implementation task or a research task (spec §17). */
export type NewTaskKind = 'impl' | 'research';

export interface NewTaskInput {
  kind: NewTaskKind;
  project_id: string;
  title: string;
  // --- impl only
  tier: 'A' | 'B' | 'C';
  owned_paths: string;
  ticket_md: string;
  /** Done research tasks of the same project to cite (at most `MAX_RESEARCH_REFS`). */
  research_refs: string[];
  // --- research only
  question: string;
  queue: boolean;
}

export type NewTaskErrors = Partial<Record<keyof NewTaskInput, string>>;

export type NewTaskRequest =
  | { kind: 'impl'; body: TaskCreateBody }
  | { kind: 'research'; body: ResearchCreateBody };

/** One path per line (commas also split); blanks and duplicates dropped. */
export function parseOwnedPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,，]/)) {
    const path = raw.trim();
    if (path !== '' && !out.includes(path)) out.push(path);
  }
  return out;
}

export const QUESTION_MAX = 8000;

const FIELD_MESSAGES: Partial<Record<keyof NewTaskInput, string>> = {
  project_id: '請選擇專案',
  title: '標題必填，最多 200 字',
  ticket_md: '派工單必填',
  owned_paths: '至少一個 repo 相對路徑，不可用 / 開頭或含 ..',
  tier: '請選擇 tier',
  research_refs: `參考調研最多 ${MAX_RESEARCH_REFS} 個`,
  question: `調研問題必填，最多 ${QUESTION_MAX} 字`,
};

type Built<B> = { ok: true; body: B } | { ok: false; errors: NewTaskErrors };

function fieldErrors(issues: ReadonlyArray<{ path: PropertyKey[] }>): NewTaskErrors {
  const errors: NewTaskErrors = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '') as keyof NewTaskInput;
    const message = FIELD_MESSAGES[field];
    if (message !== undefined && errors[field] === undefined) errors[field] = message;
  }
  return errors;
}

/** Validate with the same Zod schema as the server (spec §6 合約先行). */
export function buildTaskRequest(input: NewTaskInput): Built<TaskCreateBody> {
  const candidate: TaskCreateBody = {
    project_id: input.project_id,
    title: input.title.trim(),
    tier: input.tier,
    ticket_md: input.ticket_md,
    owned_paths: parseOwnedPaths(input.owned_paths),
    queue: input.queue,
    // only when citing: the server defaults to none
    ...(input.research_refs.length > 0 ? { research_refs: [...input.research_refs] } : {}),
  };
  const parsed = TaskCreateRequestSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: candidate };
  const errors = fieldErrors(parsed.error.issues);
  if (input.ticket_md.trim() === '') errors.ticket_md = '派工單必填';
  return { ok: false, errors };
}

/** POST /research body (spec §17): the question is the whole ticket; no tier or paths. */
export function buildResearchRequest(input: NewTaskInput): Built<ResearchCreateBody> {
  const candidate: ResearchCreateBody = {
    project_id: input.project_id,
    title: input.title.trim(),
    question: input.question.trim(),
    queue: input.queue,
  };
  const parsed = ResearchCreateRequestSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: candidate };
  return { ok: false, errors: fieldErrors(parsed.error.issues) };
}

export function buildNewTaskRequest(
  input: NewTaskInput,
): { ok: true; request: NewTaskRequest } | { ok: false; errors: NewTaskErrors } {
  if (input.kind === 'research') {
    const built = buildResearchRequest(input);
    return built.ok ? { ok: true, request: { kind: 'research', body: built.body } } : built;
  }
  const built = buildTaskRequest(input);
  return built.ok ? { ok: true, request: { kind: 'impl', body: built.body } } : built;
}

/** Research tasks an impl task of `projectId` may cite: same project, done; newest first. */
export function citableResearch(tasks: readonly BoardTask[], projectId: string): BoardTask[] {
  return tasks
    .filter((t) => t.kind === 'research' && t.status === 'done' && t.project_id === projectId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** `refs` with `id` checked or unchecked; never more than `MAX_RESEARCH_REFS`. */
export function toggleRef(refs: readonly string[], id: string, checked: boolean): string[] {
  if (!checked) return refs.filter((r) => r !== id);
  if (refs.includes(id) || refs.length >= MAX_RESEARCH_REFS) return [...refs];
  return [...refs, id];
}
