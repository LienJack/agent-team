import type { TaskCreateBody } from '@agent-team/client';
import { TaskCreateRequestSchema } from '@agent-team/schema';

export interface NewTaskInput {
  project_id: string;
  title: string;
  tier: 'A' | 'B' | 'C';
  owned_paths: string;
  ticket_md: string;
  queue: boolean;
}

export type NewTaskErrors = Partial<Record<keyof NewTaskInput, string>>;

/** One path per line (commas also split); blanks and duplicates dropped. */
export function parseOwnedPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,，]/)) {
    const path = raw.trim();
    if (path !== '' && !out.includes(path)) out.push(path);
  }
  return out;
}

const FIELD_MESSAGES: Partial<Record<keyof NewTaskInput, string>> = {
  project_id: '請選擇專案',
  title: '標題必填，最多 200 字',
  ticket_md: '派工單必填',
  owned_paths: '至少一個 repo 相對路徑，不可用 / 開頭或含 ..',
  tier: '請選擇 tier',
};

/** Validate with the same Zod schema as the server (spec §6 合約先行). */
export function buildTaskRequest(
  input: NewTaskInput,
): { ok: true; body: TaskCreateBody } | { ok: false; errors: NewTaskErrors } {
  const candidate = {
    project_id: input.project_id,
    title: input.title.trim(),
    tier: input.tier,
    ticket_md: input.ticket_md,
    owned_paths: parseOwnedPaths(input.owned_paths),
    queue: input.queue,
  };
  const parsed = TaskCreateRequestSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: candidate };
  const errors: NewTaskErrors = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '') as keyof NewTaskInput;
    const message = FIELD_MESSAGES[field];
    if (message !== undefined && errors[field] === undefined) errors[field] = message;
  }
  if (input.ticket_md.trim() === '') errors.ticket_md = '派工單必填';
  return { ok: false, errors };
}
