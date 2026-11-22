import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { commandMentions, provenOrphans, usableMarkers, withinMarker } from './orphans.js';
import { ancestryOf, descendantsOf, parsePsLine, type ProcessInfo } from './tree.js';

// docs/adr/0022 §4: the proof of ownership for processes a run left behind, on synthetic process
// tables (the real-process cases are in escape.test.ts).

const WT = '/Users/someone/RanoLabs/worktrees/demo/t_abc123';
const LOG = '/Users/someone/.agent-team/runs/r_abc123';
const T = (s: number) => `Sun Nov 22 10:00:${String(s).padStart(2, '0')} 2026`;
const SINCE = Date.parse(T(10));
const NOW = Date.parse(T(50));

function proc(over: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 9000,
    ppid: 1,
    pgid: 9000,
    uid: 501,
    tty: null,
    startedAt: T(20),
    command: 'node -e idle',
    ...over,
  };
}
const opts = { markers: [WT, LOG], sinceMs: SINCE, nowMs: NOW, uid: 501, self: 100 };
const pick = (procs: ProcessInfo[], cwds: Record<number, string>) =>
  provenOrphans(procs, new Map(Object.entries(cwds).map(([k, v]) => [Number(k), v])), opts).map(
    (p) => p.pid,
  );

describe('ps parsing and process trees', () => {
  it('reads pid, parents, uid, tty, the start time and the full command', () => {
    expect(
      parsePsLine(' 4242   1  4242   501 ??       Sun Nov 22 06:17:56 2026     node -e x y'),
    ).toEqual({
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      uid: 501,
      tty: null,
      startedAt: 'Sun Nov 22 06:17:56 2026',
      command: 'node -e x y',
    });
    expect(parsePsLine('  12  11  12  501 ttys003  Sun Nov  2 06:17:56 2026  -zsh')?.tty).toBe(
      'ttys003',
    );
    expect(parsePsLine('garbage')).toBeUndefined();
  });

  it('descendants come deepest first; ancestry walks up to init', () => {
    const procs = [
      proc({ pid: 10, ppid: 1 }),
      proc({ pid: 11, ppid: 10 }),
      proc({ pid: 12, ppid: 11 }),
      proc({ pid: 13, ppid: 10 }),
    ];
    expect(descendantsOf(10, procs).map((p) => p.pid)).toEqual([12, 11, 13]);
    expect([...ancestryOf(12, procs)].sort()).toEqual([10, 11, 12]);
  });
});

describe('usable paths', () => {
  it('refuses empty, relative, short and broad paths (root, home, temp and their parents)', () => {
    const broad = [
      '',
      'relative/a/b',
      '/',
      '/Users',
      '/tmp',
      homedir(),
      tmpdir(),
      tmpdir().split('/').slice(0, 3).join('/'),
      null,
      undefined,
    ];
    expect(usableMarkers(broad)).toEqual([]);
    expect(usableMarkers([`${WT}/`, LOG])).toEqual([WT, LOG]);
  });

  it('matches on path segments only', () => {
    expect(withinMarker(WT, [WT])).toBe(true);
    expect(withinMarker(`${WT}/src`, [WT])).toBe(true);
    expect(withinMarker(`${WT}x`, [WT])).toBe(false); // t_abc123x is another task
    expect(withinMarker(undefined, [WT])).toBe(false);
    expect(commandMentions(`sh -c cd ${WT} && run`, [WT])).toBe(true);
    expect(commandMentions(`dsh --patch=${LOG}/dsh.patch.yml`, [LOG])).toBe(true);
    expect(commandMentions(`vim ${WT}x/a.ts`, [WT])).toBe(false);
  });
});

describe('proof of ownership', () => {
  it('an orphan of the run (init parent, no tty, started since launch, cwd in the worktree) and its children', () => {
    const procs = [
      proc({ pid: 9000 }),
      proc({ pid: 9001, ppid: 9000, startedAt: T(21) }),
      proc({ pid: 9100, command: `node ${LOG}/helper.js` }), // mentions the log dir
    ];
    expect(pick(procs, { 9000: `${WT}/src`, 9001: '/' })).toEqual([9001, 9000, 9100]);
  });

  it('never a weaker match', () => {
    const base = { 9000: WT };
    expect(pick([proc({ ppid: 77 })], base)).toEqual([]); // a live parent (a shell, the service)
    expect(pick([proc({ tty: 'ttys001' })], base)).toEqual([]); // a terminal: a person's
    expect(pick([proc({ uid: 0 })], base)).toEqual([]); // another user
    expect(pick([proc({ startedAt: T(9) })], base)).toEqual([]); // older than the run
    expect(pick([proc({})], { 9000: '/Users/someone/RanoLabs/worktrees/demo/t_other' })).toEqual(
      [],
    ); // another task (or another instance's tree)
    expect(pick([proc({})], {})).toEqual([]); // cwd unknown, nothing in the command line
    // a GUI app (a person's editor opened on the worktree): never a worker's
    const editor = proc({ command: '/Applications/Editor.app/Contents/MacOS/Editor' });
    expect(pick([editor], base)).toEqual([]);
    // this service and its ancestors are never candidates, even if they match
    const self = [proc({ pid: 100, ppid: 1, command: `node ${WT}` })];
    expect(pick(self, { 100: WT })).toEqual([]);
  });

  it('the same second as the launch counts (start times have second resolution)', () => {
    const at = { ...opts, sinceMs: SINCE + 900 };
    const found = provenOrphans([proc({ startedAt: T(10) })], new Map([[9000, WT]]), at);
    expect(found.map((p) => p.pid)).toEqual([9000]);
  });
});
