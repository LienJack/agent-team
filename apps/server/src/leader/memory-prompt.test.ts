import { describe, expect, it } from 'vitest';
import {
  LEADER_ALLOW_RULES,
  LEADER_DENY_RULES,
  LEADER_MEMORY_ALLOW_RULE,
  LEADER_OPTIONAL_FLAGS,
  LEADER_REQUIRED_FLAGS,
  leaderArgs,
} from './args.js';
import { leaderPromptVersion, leaderSystemPrompt, MEMORY_SENTENCE } from './prompt/system-v6.js';

// spec §18: with project memory on, the leader's prompt gets one sentence and its allow-list
// `team memory search` — nothing else of the memory (adding, listing, deleting are a person's).
// memory.enabled is part of the prompt version, like research.mode.

const base = {
  model: 'm',
  sessionId: 's',
  resume: true,
  systemPrompt: 'p',
  settings: {},
  flags: new Set<string>([...LEADER_REQUIRED_FLAGS, ...LEADER_OPTIONAL_FLAGS]),
};
const allowed = (argv: string[]) =>
  argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));

describe('§18 the leader and project memory', () => {
  it('memory on: one sentence, `team memory search` allowed, a new prompt version', () => {
    for (const mode of ['off', 'on_request', 'auto'] as const) {
      expect(leaderSystemPrompt(mode, true)).toContain(MEMORY_SENTENCE.trim());
      expect(leaderSystemPrompt(mode, false)).not.toContain('專案記憶');
      expect(leaderSystemPrompt(mode)).toBe(leaderSystemPrompt(mode, false));
      expect(leaderSystemPrompt(mode, true)).not.toContain('{{');
      expect(leaderPromptVersion(mode, true)).toBe(`v6-${mode}-memory`);
      expect(leaderPromptVersion(mode, true)).not.toBe(leaderPromptVersion(mode, false));
    }
    expect(MEMORY_SENTENCE).toContain('`team memory search');
    expect(allowed(leaderArgs({ ...base, memory: true }))).toEqual([
      ...LEADER_ALLOW_RULES,
      LEADER_MEMORY_ALLOW_RULE,
    ]);
    expect(allowed(leaderArgs(base))).toEqual([...LEADER_ALLOW_RULES]);
  });

  it('the rule allows search only, and no deny rule blocks it', () => {
    expect(LEADER_MEMORY_ALLOW_RULE).toBe('Bash(team memory search:*)');
    const prefix = 'team memory search';
    for (const cmd of [
      'team memory add demo x',
      'team memory rm demo id',
      'team memory list demo',
    ]) {
      expect(cmd.startsWith(prefix)).toBe(false);
    }
    for (const rule of LEADER_DENY_RULES) {
      const inner = /^Bash\((.*?)(?::\*)?\)$/.exec(rule)![1]!;
      expect(`${prefix} demo "資料庫"`.startsWith(`${inner} `)).toBe(false);
    }
  });
});
