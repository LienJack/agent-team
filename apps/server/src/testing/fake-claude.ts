// Test support: the scripted fake CLI from @agent-team/runners/testing standing in for the
// leader's `claude` (never the real one). Every invocation reads the scenario file afresh, so a
// test rewrites it between turns; probe calls (--version, --help, auth status) are answered from
// `responses` and every invocation is recorded (argv, env names, stdin, stdin closed).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceConfig } from '@agent-team/schema';
import {
  fakeCliCommand,
  readRecords,
  writeScenario,
  type FakeCliRecord,
  type FakeCliResponse,
  type FakeCliStep,
  type FakeScenario,
} from '@agent-team/runners/testing';
import { createTestService, type TestService } from './harness.js';

/** `claude --help` listing every flag the leader probes for. */
export const FAKE_CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  -p, --print                 Print response and exit',
  '  --model <model>             Model',
  '  --output-format <format>    Output format',
  '  --verbose                   Verbose',
  '  --session-id <uuid>         Use a specific session ID',
  '  -r, --resume [value]        Resume a conversation',
  '  --append-system-prompt <p>  Append to the system prompt',
  '  --tools <tools...>          Built-in tools',
  '  --allowedTools, --allowed-tools <tools...>  Allowed tools',
  '  --disallowedTools, --disallowed-tools <tools...>  Denied tools',
  '  --permission-mode <mode>    Permission mode',
  '  --permission-prompts <t>    Who answers permission prompts',
  '  --safe-mode                 No customizations',
  '  --strict-mcp-config         Only --mcp-config servers',
  '  --mcp-config <configs...>   MCP servers',
  '  --restricted                Restricted mode',
  '  --effort <level>            Effort',
  '  --dangerously-skip-permissions  Bypass all permission checks',
].join('\n');

const SESSION = '00000000-0000-4000-8000-00000000c1a0';

export interface TurnOptions {
  text?: string;
  /** Bash commands the fake model "runs" (tool_use + tool_result). */
  commands?: string[];
  /** Commands refused (listed in `permission_denials`). */
  denied?: string[];
  /** Context size of the last model call (put into the assistant usage). */
  contextTokens?: number;
  delayMs?: number;
  utilization?: number;
}

/** stdout of one successful turn. */
export function turnSteps(o: TurnOptions = {}): FakeCliStep[] {
  const ctx = o.contextTokens ?? 1200;
  const usage = {
    input_tokens: 3,
    cache_read_input_tokens: ctx - 103,
    cache_creation_input_tokens: 50,
    output_tokens: 50,
  };
  const steps: FakeCliStep[] = [
    { out: { type: 'system', subtype: 'init', session_id: SESSION, tools: ['Bash'] } },
    {
      out: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: {
            seven_day: { utilization: o.utilization ?? 0.25, resetsAt: 1795716000 },
          },
        },
      },
    },
  ];
  if (o.delayMs) steps.push({ delayMs: o.delayMs });
  for (const [i, command] of (o.commands ?? []).entries()) {
    steps.push({
      out: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: { command } }],
          usage,
        },
      },
    });
    steps.push({
      out: {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok' }] },
      },
    });
  }
  steps.push({
    out: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: o.text ?? '好的' }], usage },
    },
  });
  steps.push({
    out: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: SESSION,
      result: o.text ?? '好的',
      total_cost_usd: 0.001,
      usage: { input_tokens: 9, output_tokens: 120, cache_read_input_tokens: 4000 },
      permission_denials: (o.denied ?? []).map((command) => ({
        tool_name: 'Bash',
        tool_input: { command },
      })),
    },
  });
  return steps;
}

/** A `/compact` turn: compact_boundary with the sizes, empty result. */
export function compactSteps(pre: number, post: number): FakeCliStep[] {
  return [
    { out: { type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION } },
    { out: { type: 'system', subtype: 'init', session_id: SESSION } },
    {
      out: {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: SESSION,
        compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: post },
      },
    },
    {
      out: { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, result: '' },
    },
  ];
}

/** Subscription limit: rejected rate_limit_event + an error result naming the reset epoch. */
export function rateLimitedSteps(resetsAtEpochSeconds: number): FakeCliStep[] {
  return [
    { out: { type: 'system', subtype: 'init', session_id: SESSION } },
    {
      out: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          unifiedWindows: { five_hour: { utilization: 1, resetsAt: resetsAtEpochSeconds } },
        },
      },
    },
    {
      out: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: SESSION,
        result: `Claude AI usage limit reached|${resetsAtEpochSeconds}`,
      },
    },
  ];
}

export function notLoggedInSteps(): FakeCliStep[] {
  return [
    { out: { type: 'system', subtype: 'init', session_id: SESSION } },
    {
      out: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: SESSION,
        result: 'Not logged in · Please run /login',
      },
    },
  ];
}

export class FakeClaude {
  readonly scenarioPath: string;
  readonly recordPath: string;

  /** Paths are fixed, so `command()` works before the first `set()`. */
  constructor(readonly dir: string) {
    this.scenarioPath = join(dir, 'claude.json');
    this.recordPath = join(dir, 'claude-record.jsonl');
  }

  /** (Re)write the scenario every later invocation plays. */
  async set(
    steps: FakeCliStep[],
    opts: { loggedIn?: boolean; help?: string; responses?: FakeCliResponse[] } = {},
  ): Promise<void> {
    const scenario: FakeScenario = {
      stdinWaitMs: 3000,
      recordPath: this.recordPath,
      responses: [
        { argv: ['--version'], stdout: '2.1.326 (Claude Code)' },
        { argv: ['--help'], stdout: opts.help ?? FAKE_CLAUDE_HELP },
        {
          argv: ['auth', 'status', '--json'],
          stdout: JSON.stringify({ loggedIn: opts.loggedIn ?? true }),
        },
        ...(opts.responses ?? []),
      ],
      steps,
    };
    await writeScenario(this.dir, scenario, 'claude');
  }

  command(): string[] {
    return fakeCliCommand(this.scenarioPath);
  }

  /** Recorded turns (probe calls left out), in invocation order. */
  turns(): FakeCliRecord[] {
    const probes = new Set(['--version', '--help', 'auth']);
    const seen = new Map<number, FakeCliRecord>();
    for (const r of readRecords(this.recordPath)) {
      if (!probes.has(r.argv[0] ?? '')) seen.set(r.pid, r);
    }
    return [...seen.values()];
  }
}

/** A stand-in for the built `team` CLI entry (the leader only checks that it exists). */
export function fakeTeamEntry(root: string): string {
  const path = join(root, 'team-bin.js');
  writeFileSync(path, '// test stand-in for apps/cli/dist/bin.js\n');
  return path;
}

/** A test service whose leader runs the fake claude (scenario written by the caller). */
export function bootLeader(configure?: (c: ServiceConfig) => void): {
  h: TestService;
  fake: FakeClaude;
} {
  let claude: FakeClaude | undefined;
  const h = createTestService({
    ...(configure ? { configure } : {}),
    leader: (root) => {
      claude = new FakeClaude(join(root, 'fake-claude'));
      return {
        enabled: true,
        command: claude.command(),
        teamEntry: fakeTeamEntry(root),
        sourceEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root },
      };
    },
  });
  return { h, fake: claude! };
}
