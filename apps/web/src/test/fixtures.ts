import type {
  Attention,
  BoardTask,
  Message,
  Project,
  Run,
  RunnerStatus,
  StateSnapshot,
  Task,
} from '@agent-team/client';

// Test data builders (test-only module).

const T0 = '2026-11-20T08:00:00.000Z';

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p_demo',
    name: 'demo',
    repo_path: '/repos/demo',
    base_branch: 'main',
    checks: [],
    allow_network: false,
    created_at: T0,
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't_1',
    project_id: 'p_demo',
    parent_id: null,
    title: '加入 a 功能',
    tier: 'C',
    ticket_md: '# 派工單',
    owned_paths: ['src/a/'],
    priority: 0,
    status: 'draft',
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
    ...over,
  };
}

/** A task as the board snapshot carries it (no runs yet unless overridden). */
export function makeBoardTask(over: Partial<BoardTask> = {}): BoardTask {
  return {
    ...makeTask(over),
    latest_run: null,
    head_sha: null,
    run_totals: { runs: 0, cost_usd: null, usage: {}, finished_ms: 0 },
    ...over,
  };
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r_1',
    task_id: 't_1',
    workspace_id: 'w_1',
    dispatch_id: 'd_1',
    kind: 'impl',
    role: 'impl_C',
    model_alias: 'deepseek-flash',
    runner: 'dsh',
    model: 'deepseek/flash',
    state: 'succeeded',
    outcome: 'ok',
    reject_reason: null,
    error: null,
    session_ref: null,
    receipt: null,
    usage: null,
    cost_usd: null,
    log_dir: '/data/runs/r_1',
    pid: null,
    pid_started_at: null,
    launched_at: null,
    started_at: T0,
    ended_at: '2026-11-20T08:02:00.000Z',
    ...over,
  };
}

export function makeAttention(over: Partial<Attention> = {}): Attention {
  return {
    id: 'a_1',
    task_id: null,
    kind: 'decision',
    question: '要用哪個方案？',
    options: ['方案甲', '方案乙'],
    status: 'open',
    answer: null,
    answered_via: null,
    created_at: T0,
    answered_at: null,
    ...over,
  };
}

export function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm_1',
    channel: 'leader',
    direction: 'in',
    source: 'web',
    body: '你好',
    client_msg_id: 'c_1',
    ref: null,
    status: 'new',
    seq: 1,
    created_at: T0,
    ...over,
  };
}

export function makeRunner(over: Partial<RunnerStatus> = {}): RunnerStatus {
  return {
    runner: 'claude',
    cooldown_until: null,
    cooldown_reason: null,
    consecutive_failures: 0,
    circuit_open_until: null,
    quota: null,
    available: true,
    circuit: 'closed',
    ...over,
  };
}

export function makeState(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    last_seq: 0,
    generated_at: T0,
    projects: [makeProject()],
    tasks: [],
    active_runs: [],
    open_attention: [],
    runners: [makeRunner(), makeRunner({ runner: 'codex' }), makeRunner({ runner: 'dsh' })],
    leader: { state: 'offline', last_activity_at: null },
    ...over,
  };
}
