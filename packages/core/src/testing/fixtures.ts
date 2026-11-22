import {
  defaultServiceConfig,
  parseModelsConfig,
  type Attention,
  type ModelsConfig,
  type ModelsConfigInput,
  type OutboxItem,
  type Project,
  type Run,
  type Task,
  type Workspace,
} from '@agent-team/schema';
import type { EngineConfig } from '../engine/context.js';

const T0 = '2026-11-21T00:00:00.000Z';

/**
 * Models config with the same aliases and roles as config/models.json, but small slot counts
 * so limits are easy to hit in tests.
 */
export function testModelsInput(): ModelsConfigInput {
  const m = (
    runner: 'claude' | 'codex' | 'dsh',
    model: string,
    effort?: 'low' | 'medium' | 'high',
  ) => (effort ? { runner, model, effort } : { runner, model });
  return {
    models: {
      fable: m('claude', 'claude-fable', 'high'),
      opus: m('claude', 'claude-opus', 'high'),
      sonnet: m('claude', 'claude-sonnet', 'medium'),
      haiku: m('claude', 'claude-haiku', 'low'),
      'gpt-astra': m('codex', 'gpt-astra', 'high'),
      'gpt-sol': m('codex', 'gpt-sol', 'medium'),
      'kimi-pro': m('dsh', 'kimi-pro'),
      'deepseek-flash': m('dsh', 'deepseek-flash'),
      'glm-flash': m('dsh', 'glm-flash'),
      jev: { runner: 'jev', model: 'jev', price: null },
    },
    roles: {
      leader: { use: 'sonnet', fallback: ['opus'], slots: 1 },
      impl_A: { use: 'opus', fallback: ['gpt-astra'], slots: 1, escalate_to: null },
      impl_B: { use: 'gpt-sol', fallback: ['kimi-pro', 'sonnet'], slots: 2, escalate_to: 'impl_A' },
      impl_C: {
        use: 'deepseek-flash',
        fallback: ['glm-flash'],
        slots: 3,
        escalate_to: 'impl_B',
      },
      review_A: { use: 'gpt-astra', fallback: ['fable'], slots: 1 },
      review_B: { use: 'sonnet', fallback: ['gpt-astra', 'kimi-pro'], slots: 2 },
      review_C: { use: 'gpt-sol', fallback: ['kimi-pro', 'sonnet'], slots: 2 },
      gate: { use: 'jev', enabled: false, fallback: ['deepseek-flash'], slots: 1 },
      oss_researcher: { use: 'sonnet', fallback: ['deepseek-flash', 'gpt-sol'], slots: 2 },
    },
    rules: {
      max_fix_rounds_before_escalate: 2,
      reviewer_must_differ_from_implementer: true,
      machine_checks_before_model_review: true,
      quota: {
        claude_high_utilization: 0.7,
        when_claude_high: { review_B: 'gpt-astra', impl_A: 'gpt-astra' },
        codex_low_quota: { impl_B: 'kimi-pro', review_C: 'kimi-pro' },
      },
    },
  };
}

export function testModelsConfig(mutate?: (input: ModelsConfigInput) => void): ModelsConfig {
  const input = testModelsInput();
  mutate?.(input);
  return parseModelsConfig(input);
}

export function testEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    models: testModelsConfig(),
    engine: defaultServiceConfig().engine,
    research: defaultServiceConfig().research,
    memory: defaultServiceConfig().memory,
    dataDir: '/data',
    worktreeRoot: '/worktrees',
    notifications: true,
    ...overrides,
  };
}

// ------------------------------------------------------------- row builders

export function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p_000001',
    name: 'demo',
    repo_path: '/repos/demo',
    base_branch: 'main',
    checks: [{ name: 'test', cmd: 'pnpm test' }],
    allow_network: false,
    created_at: T0,
    ...overrides,
  };
}

export function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_000001',
    project_id: 'p_000001',
    parent_id: null,
    kind: 'impl',
    title: '加一個功能',
    tier: 'C',
    ticket_md: '# 派工單\n做一件事',
    owned_paths: ['src/feature/'],
    research_refs: [],
    priority: 0,
    status: 'queued',
    impl_role: 'impl_C',
    fix_rounds: 0,
    leader_retries: 0,
    attempts: 0,
    blocked_reason: null,
    version: 1,
    current_run_id: null,
    retry_at: null,
    fix_notes: null,
    recovery_note: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function sampleWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w_000001',
    task_id: 't_000001',
    path: '/worktrees/demo/t_000001',
    branch: 'team/t_000001',
    base_sha: 'aaaaaaa1',
    head_sha: null,
    accepted_base_sha: null,
    state: 'active',
    created_at: T0,
    removed_at: null,
    ...overrides,
  };
}

export function sampleRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r_000001',
    task_id: 't_000001',
    workspace_id: 'w_000001',
    dispatch_id: 'd_000001',
    kind: 'impl',
    role: 'impl_C',
    model_alias: 'deepseek-flash',
    runner: 'dsh',
    model: 'deepseek-flash',
    state: 'starting',
    outcome: null,
    reject_reason: null,
    error: null,
    session_ref: null,
    receipt: null,
    usage: null,
    cost_usd: null,
    cost_estimated: false,
    log_dir: '/data/runs/r_000001',
    pid: null,
    pid_started_at: null,
    launched_at: null,
    started_at: T0,
    ended_at: null,
    memory_ids: [],
    ...overrides,
  };
}

export function sampleAttention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: 'a_000001',
    task_id: null,
    kind: 'decision',
    topic: 'general',
    question: '要選哪個？',
    options: ['A', 'B'],
    status: 'open',
    answer: null,
    answered_via: null,
    created_at: T0,
    answered_at: null,
    ...overrides,
  };
}

export function sampleOutbox(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'o_000001',
    target: 'grok',
    kind: 'task_done',
    body: '任務完成',
    signature: 'task_done:t_000001',
    status: 'pending',
    task_id: null,
    attempts: 0,
    error: null,
    created_at: T0,
    sent_at: null,
    ...overrides,
  };
}
