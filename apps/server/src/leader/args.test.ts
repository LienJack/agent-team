import { describe, expect, it } from 'vitest';
import {
  LEADER_ALLOW_RULES,
  LEADER_DENIED_COMMANDS,
  LEADER_DENY_RULES,
  LEADER_OPTIONAL_FLAGS,
  LEADER_REQUIRED_FLAGS,
  leaderArgs,
} from './args.js';

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

  it('passes the deny list only when the CLI supports it, never a permission bypass', () => {
    const base = { model: 'm', sessionId: 's', resume: false, systemPrompt: 'p' };
    const full = leaderArgs({ ...base, flags: ALL_FLAGS });
    const allowAt = full.indexOf('--allowedTools');
    const denyAt = full.indexOf('--disallowedTools');
    expect(full.slice(allowAt + 1, denyAt)).toEqual([...LEADER_ALLOW_RULES]);
    expect(full.slice(denyAt + 1, full.indexOf('--permission-mode'))).toEqual([
      ...LEADER_DENY_RULES,
    ]);
    expect(full.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
    const minimal = leaderArgs({ ...base, flags: new Set(LEADER_REQUIRED_FLAGS) });
    expect(minimal).not.toContain('--disallowedTools');
    expect(minimal).toContain('dontAsk');
  });
});
