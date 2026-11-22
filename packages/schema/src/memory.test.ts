import { describe, expect, it } from 'vitest';
import { defaultServiceConfig, ServiceConfigSchema } from './config/service.js';
import { isProjectMemoryCube, memoryCubeId, MemoryIdSchema } from './memory.js';

// spec §18 settings and the cube naming rule (the only guard against other data on MemOS).

describe('§18 memory settings', () => {
  it('defaults: off, the NAS, prefix agent-team-, top_k 6, relativity 0.45, 3 s, caps', () => {
    expect(defaultServiceConfig().memory).toEqual({
      enabled: false,
      base_url: 'http://greennas.local:8000',
      user_id: 'agent-team',
      cube_prefix: 'agent-team-',
      top_k: 6,
      relativity: 0.45,
      timeout_ms: 6000,
      max_item_chars: 1200,
      max_prompt_chars: 1500,
      add_mode: 'sync_fast',
      write_sources: { task: true, decision: true, human: true, research: true },
    });
  });

  it('refuses prefixes that would not keep cubes apart, and base URLs with paths or credentials', () => {
    for (const cube_prefix of ['', '-', 'ab-', 'agent-team', 'Agent-', 'a_b-', 'agent team-']) {
      expect(ServiceConfigSchema.safeParse({ memory: { cube_prefix } }).success).toBe(false);
    }
    expect(
      ServiceConfigSchema.safeParse({ memory: { cube_prefix: 'agent-team-verify-' } }).success,
    ).toBe(true);
    // a port is required: the sandboxes refuse it on every host, so 80/443 must never be implied
    for (const base_url of [
      'http://u:p@nas:8000',
      'http://nas:8000/product',
      'ftp://nas',
      'nas:8000',
      'http://nas',
      'https://nas/',
    ]) {
      expect(ServiceConfigSchema.safeParse({ memory: { base_url } }).success).toBe(false);
    }
    expect(ServiceConfigSchema.safeParse({ memory: { top_k: 0 } }).success).toBe(false);
    expect(ServiceConfigSchema.safeParse({ memory: { unknown: 1 } }).success).toBe(false);
  });
});

describe('§18 cube ids', () => {
  it('a project cube is <prefix><project id>; nothing else counts', () => {
    expect(memoryCubeId('agent-team-', 'p_0123456789ab')).toBe('agent-team-p_0123456789ab');
    expect(() => memoryCubeId('', 'p_1')).toThrow('invalid memory cube prefix');
    expect(() => memoryCubeId('agent-team-', 'x')).toThrow('invalid project id');
    expect(isProjectMemoryCube('agent-team-', 'agent-team-p_0123456789ab')).toBe(true);
    for (const cube of ['agent-team-', 'agent-team-x', 'other-p_1', 'agent-team-p_1/x', 'root']) {
      expect(isProjectMemoryCube('agent-team-', cube)).toBe(false);
    }
    expect(MemoryIdSchema.safeParse('00000000-0000-4000-8000-000000000001').success).toBe(true);
    expect(MemoryIdSchema.safeParse('../x').success).toBe(false);
  });
});
