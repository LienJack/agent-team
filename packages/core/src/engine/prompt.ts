import type {
  ImplReceipt,
  JsonSchema,
  Project,
  RunKind,
  Task,
  Workspace,
} from '@agent-team/schema';

// Dispatch prompt (spec §7): fixed worker rules + ticket + receipt schema + dispatch_id
// (+ recovery note after a restart, + fix notes for fix runs).

export interface PromptInput {
  kind: RunKind;
  task: Task;
  project: Project;
  workspace: Workspace;
  dispatchId: string;
  receiptSchema: JsonSchema;
  /** Receipt of the impl/fix run under review (review runs only). */
  implReceipt?: ImplReceipt | null;
}

function implRules(task: Task, dispatchId: string): string[] {
  return [
    `只修改下列 owned_paths 內的檔案：${task.owned_paths.map((p) => `\`${p}\``).join('、')}。`,
    '不要 git commit、不要 git push；服務端會在核對通過後代為提交。',
    '不要提問；解決不了就回報 status = "blocked"（或 "failed"）並結束，需要決定的事寫在 needs_leader。',
    '不要印出環境變數或 .env 的內容。',
    `最後只輸出一個符合下方 schema 的 JSON 回執，dispatch_id 必須是 \`${dispatchId}\`。`,
  ];
}

function reviewRules(dispatchId: string): string[] {
  return [
    '這是唯讀審查：不要修改任何檔案，不要 commit、不要 push。',
    '對照派工單檢查 base..head 之間的變更是否正確、完整、只落在 owned_paths 內。',
    'must_fix 只用於必須修正才能接受的問題；建議用 should_fix，說明用 note。',
    '沒有 must_fix 時 verdict 用 "pass"；有 must_fix 用 "needs_changes"；無法審查用 "blocked"。',
    '不要提問；不要印出環境變數或 .env 的內容。',
    `最後只輸出一個符合下方 schema 的 JSON 回執，dispatch_id 必須是 \`${dispatchId}\`。`,
  ];
}

function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

/** Build the full prompt text handed to the runner. Pure. */
export function buildPrompt(input: PromptInput): string {
  const { kind, task, project, workspace, dispatchId } = input;
  const sections: string[] = [
    `# 派工單 ${dispatchId}`,
    `任務 ${task.id}：${task.title}（tier ${task.tier}，專案 ${project.name}，類型 ${kind}）`,
    `## 工作規則\n${bullet(kind === 'review' ? reviewRules(dispatchId) : implRules(task, dispatchId))}`,
  ];
  if (task.recovery_note) {
    sections.push(`## 復原說明\n${task.recovery_note}`);
  }
  if (kind === 'fix' && task.fix_notes) {
    sections.push(`## 修正要求（上一輪未通過）\n${task.fix_notes}`);
  }
  if (kind === 'review') {
    const files = input.implReceipt?.files_changed ?? [];
    sections.push(
      [
        '## 審查範圍',
        `- base：\`${workspace.base_sha}\``,
        `- head：\`${workspace.head_sha ?? '(未提交)'}\``,
        `- owned_paths：${task.owned_paths.map((p) => `\`${p}\``).join('、')}`,
        files.length > 0
          ? `- 實作者回報的變更檔案：${files.map((f) => `\`${f}\``).join('、')}`
          : '',
        input.implReceipt ? `- 實作者摘要：${input.implReceipt.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  sections.push(`## 派工單原文\n\n${task.ticket_md.trim()}`);
  sections.push(
    `## 回執 schema\n\n\`\`\`json\n${JSON.stringify(input.receiptSchema, null, 2)}\n\`\`\``,
  );
  return `${sections.join('\n\n')}\n`;
}

/** Note attached to the next prompt after a restart interrupted run `runId` (spec §8). */
export function recoveryNoteFor(runId: string, dispatchId: string, kind: RunKind): string {
  const what = kind === 'review' ? '審查' : '實作';
  return [
    `上一次${what}派工（run ${runId}，dispatch ${dispatchId}）因服務重啟而中斷，結果未知。`,
    kind === 'review'
      ? '請重新完整審查。'
      : 'worktree 可能留有上一次的部分修改：先檢查現況（git status / git diff），保留正確的部分再繼續。',
  ].join('\n');
}
