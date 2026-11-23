import { describe, expect, it } from 'vitest';
import {
  LEADER_ALLOW_RULES,
  LEADER_DENIED_COMMANDS,
  LEADER_DENY_RULES,
  LEADER_OPTIONAL_FLAGS,
  LEADER_REQUIRED_FLAGS,
  leaderArgs,
} from './args.js';
import { DELIVERY_RULE, leaderPromptVersion, leaderSystemPrompt } from './prompt/system-v7.js';

// The leader's shell surface (spec §9, docs/adr/0012): Bash only, allowed for `team …`, with
// Claude Code's auto-approved read-only commands denied explicitly.

const ALL_FLAGS = new Set<string>([...LEADER_REQUIRED_FLAGS, ...LEADER_OPTIONAL_FLAGS]);

/** The command prefix a rule matches (`Bash(ls:*)` → `ls`, `Bash(team status)` → exact). */
function ruleOf(rule: string): { prefix: string; exact: boolean } {
  const inner = /^Bash\((.*)\)$/.exec(rule)![1]!;
  return inner.endsWith(':*')
    ? { prefix: inner.slice(0, -2), exact: false }
    : { prefix: inner, exact: true };
}

function matches(rule: string, command: string): boolean {
  const { prefix, exact } = ruleOf(rule);
  if (exact) return command === prefix;
  return command === prefix || command.startsWith(`${prefix} `) || command.startsWith(prefix);
}

describe('leader shell surface', () => {
  it('allows only `team …` and no rule of the deny list can match a `team …` command', () => {
    for (const rule of LEADER_ALLOW_RULES) expect(ruleOf(rule).prefix).toMatch(/^team( |$)/);
    const teamCommands = [
      'team status',
      'team --json status',
      'team task list --status queued',
      "team task add --project demo --title t --tier C --paths x - <<'EOF'\n# t\nEOF",
      'team attention open --question Q --option A',
      'team receipt t_1',
    ];
    for (const rule of LEADER_DENY_RULES) {
      for (const command of teamCommands)
        expect({ rule, hit: matches(rule, command) }).toEqual({ rule, hit: false });
    }
    for (const command of teamCommands) {
      expect(LEADER_ALLOW_RULES.some((r) => matches(r, command))).toBe(true);
    }
  });

  it('denies the read-only commands Claude Code would otherwise auto-approve, bare and with arguments', () => {
    for (const command of ['ls', 'ls -la', 'echo hi', 'pwd', 'cat /etc/hosts', 'printenv', 'env']) {
      expect(LEADER_DENY_RULES.some((r) => matches(r, command))).toBe(true);
    }
    expect(new Set(LEADER_DENIED_COMMANDS).size).toBe(LEADER_DENIED_COMMANDS.length);
  });

  it('tells the leader to run one `team` command per Bash call (a denied part refuses the whole call)', () => {
    // real haiku turns chained `team status && echo "---" && team research show …` and lost the
    // whole call to the `echo` deny rule (docs/validation-2026-11-21.md round 2, and again in
    // the claude research re-validation)
    expect(LEADER_DENY_RULES.some((r) => matches(r, 'echo "---"'))).toBe(true);
    for (const mode of ['off', 'on_request', 'auto'] as const) {
      const prompt = leaderSystemPrompt(mode);
      expect(prompt).toContain('每次 Bash 只放一個 `team` 指令');
      for (const s of ['`&&`', '`;`', '`|`', '`echo`']) expect(prompt).toContain(s);
      // a new rule is a new prompt version: the next start opens a new conversation
      expect(leaderPromptVersion(mode)).toBe(`v7-${mode}`);
    }
  });

  it('tells the leader to relay the generated report and never call a task running unless delivery says so (v5)', () => {
    for (const mode of ['off', 'on_request', 'auto'] as const) {
      const prompt = leaderSystemPrompt(mode);
      expect(prompt).toContain(DELIVERY_RULE);
      expect(prompt).not.toContain('{{');
      for (const s of ['`report:`', '`delivery` 不是 `running`', '`queued`', '`not_accepted`']) {
        expect(DELIVERY_RULE).toContain(s);
      }
      expect(DELIVERY_RULE).toContain('`team status` 的 `report:`');
      expect(leaderPromptVersion(mode)).toBe(`v7-${mode}`);
      // the prompt reaches the CLI verbatim through --append-system-prompt
      const argv = leaderArgs({
        model: 'm',
        sessionId: 's',
        resume: true,
        systemPrompt: prompt,
        settings: {},
        flags: ALL_FLAGS,
      });
      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(prompt);
    }
  });

  it('always passes the isolation flags and the deny list; a CLI without them is refused', () => {
    const base = {
      model: 'm',
      sessionId: 's',
      resume: false,
      systemPrompt: 'p',
      settings: { sandbox: { enabled: true } },
    };
    const full = leaderArgs({ ...base, flags: ALL_FLAGS });
    const allowAt = full.indexOf('--allowedTools');
    const denyAt = full.indexOf('--disallowedTools');
    expect(full.slice(allowAt + 1, denyAt)).toEqual([...LEADER_ALLOW_RULES]);
    expect(full.slice(denyAt + 1, full.indexOf('--permission-mode'))).toEqual([
      ...LEADER_DENY_RULES,
    ]);
    expect(full.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
    const minimal = leaderArgs({ ...base, flags: new Set(LEADER_REQUIRED_FLAGS) });
    for (const flag of ['--restricted', '--safe-mode', '--disallowedTools', '--settings']) {
      expect(minimal).toContain(flag);
    }
    expect(minimal[minimal.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(JSON.parse(minimal[minimal.indexOf('--settings') + 1]!)).toEqual(base.settings);
    for (const flag of [
      '--restricted',
      '--safe-mode',
      '--disallowedTools',
      '--permission-prompts',
    ]) {
      const without = new Set([...LEADER_REQUIRED_FLAGS].filter((f) => f !== flag));
      expect(() => leaderArgs({ ...base, flags: without })).toThrow(flag);
    }
  });
});
