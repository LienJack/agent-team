import { TeamApiError } from '@agent-team/client';
import type { ErrorCode } from '@agent-team/schema';

/** What the UI shows for a failed call: a short Chinese title plus the server's own message. */
export interface ErrorView {
  title: string;
  /** Server message (untrusted text, rendered as plain text). */
  detail: string | undefined;
  hint: string | undefined;
}

const TITLES: Record<ErrorCode, string> = {
  bad_request: '請求格式錯誤',
  validation_failed: '輸入有誤',
  unauthorized: '未授權',
  forbidden: '拒絕存取',
  not_found: '找不到資料',
  conflict: '目前狀態不允許此操作',
  version_conflict: '資料已被更新，請重新整理後再試',
  invalid_transition: '目前狀態不允許此操作',
  idempotency_conflict: '重複的請求內容不一致',
  request_in_progress: '相同請求仍在處理中',
  too_many_requests: '同時進行的工作已達上限，請稍後再試',
  unavailable: '服務暫時無法使用',
  not_implemented: '此功能尚未實作',
  internal: '伺服器內部錯誤',
};

/** HTTP status 0 = no response at all (network down, server stopped). */
export function isConnectionError(err: unknown): boolean {
  return err instanceof TeamApiError && err.status === 0;
}

export function describeError(err: unknown): ErrorView {
  if (err instanceof TeamApiError) {
    if (err.status === 0) {
      return { title: '無法連線到服務', detail: undefined, hint: '確認服務仍在執行、網路正常' };
    }
    return { title: TITLES[err.code], detail: err.message, hint: err.hint };
  }
  return {
    title: '發生未預期的錯誤',
    detail: err instanceof Error ? err.message : String(err),
    hint: undefined,
  };
}

/**
 * A failed create in the new-task dialog. The only 409 of POST /research (and of POST /tasks
 * with `research_refs`) is the research stage being off (spec §17), so say that first; the
 * server's message and hint stay.
 */
export function describeCreateError(err: unknown, research: boolean): ErrorView {
  const view = describeError(err);
  if (research && err instanceof TeamApiError && err.code === 'conflict') {
    return { ...view, title: '調研階段已關閉（service.json 的 research.mode 為 off）' };
  }
  return view;
}

/** One line for toasts: title plus the server message. */
export function errorLine(err: unknown): string {
  const view = describeError(err);
  return view.detail ? `${view.title}：${view.detail}` : view.title;
}

/**
 * The phase-2 leader is a stub: the message is stored first, then the route answers 501
 * `not_implemented` (earlier builds: 503 `unavailable`). Both mean "stored, no reply yet"; a
 * connection failure (status 0) does not.
 */
export function isLeaderUnavailable(err: unknown): boolean {
  return (
    err instanceof TeamApiError &&
    err.status !== 0 &&
    (err.code === 'not_implemented' || err.code === 'unavailable')
  );
}
