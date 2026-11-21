import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { RunHooks } from '@agent-team/core';
import type { RunnerCapabilities, RunnerName, RunResult, RunSpec } from '@agent-team/schema';
import type { FakeRunStep, ScriptableFakeRunner } from '../types.js';

// In-process fake Runner for the server's end-to-end tests (`createRunnerRegistry({ fake: true })`).
// Like core's FakeRunner, but it really writes files into the worktree, so the service-side
// verification (git changes within owned_paths) and commit work end to end.

interface Held {
  release: (override?: RunResult) => void;
}

/**
 * Default target for an impl/fix run: derived from the first owned path in the dispatch prompt
 * (`只修改下列 owned_paths 內的檔案：\`src/a.ts\`、…`). A directory or glob gets a new file inside
 * its literal prefix; a file path is (re)written.
 */
export function defaultFakeFile(spec: RunSpec): string {
  const line = /owned_paths[^\n`]*((?:`[^`\n]+`[、,，\s]*)+)/.exec(spec.prompt)?.[1] ?? '';
  const first = /`([^`\n]+)`/.exec(line)?.[1]?.trim();
  const name = `fake-${spec.dispatchId}.txt`;
  if (!first) return `agent-team-fake/${name}`;
  const literal = first.split(/[*?[]/)[0]!;
  if (literal !== first) return `${literal.slice(0, literal.lastIndexOf('/') + 1)}${name}`;
  // no extension on the last segment = a directory ("itself and everything below")
  if (first.endsWith('/') || !/\.[^/]+$/.test(first)) return `${first.replace(/\/+$/, '')}/${name}`;
  return first;
}

function safeRelative(path: string): string {
  const n = normalize(path).replace(/^\/+/, '');
  if (n.startsWith('..')) throw new Error(`fake runner refuses to write outside cwd: ${path}`);
  return n;
}

export class InProcessFakeRunner implements ScriptableFakeRunner {
  readonly calls: RunSpec[] = [];
  private readonly queue: FakeRunStep[] = [];
  private readonly heldRuns = new Map<string, Held>();
  defaultStep: FakeRunStep = {};
  probeResult: RunnerCapabilities;

  constructor(readonly name: RunnerName = 'fake') {
    this.probeResult = {
      runner: name,
      available: true,
      version: 'in-process-fake',
      credentials: 'not_required',
      supports: { jsonSchema: true, resume: false, quota: false, effort: true, readOnly: true },
      flags: [],
      problems: [],
    };
  }

  script(...steps: FakeRunStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  held(): string[] {
    return [...this.heldRuns.keys()];
  }

  release(dispatchId?: string, override?: RunResult): void {
    const id = dispatchId ?? this.held()[0];
    const held = id === undefined ? undefined : this.heldRuns.get(id);
    if (!held || id === undefined) throw new Error(`no held run ${dispatchId ?? ''}`);
    this.heldRuns.delete(id);
    held.release(override);
  }

  async probe(): Promise<RunnerCapabilities> {
    return this.probeResult;
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    this.calls.push(spec);
    const step = this.queue.shift() ?? this.defaultStep;
    const start = step.start ?? 'accepted';
    if (start === 'unknown') {
      return { error: { kind: 'start_unknown', message: 'fake: spawn did not report' } };
    }
    if (start === 'rejected') {
      const r = typeof step.result === 'function' ? step.result(spec) : step.result;
      return r?.error ? r : { error: { kind: 'crash', message: 'fake: spawn failed' } };
    }
    // no pid: there is no child process (a pid here would point at the test/server process)
    hooks?.onStarted?.({});

    let override: RunResult | undefined;
    if (step.hold || (step.delayMs ?? 0) > 0) {
      override = await new Promise<RunResult | undefined>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          this.heldRuns.delete(spec.dispatchId);
          resolve({ error: { kind: 'cancelled', message: 'aborted' } });
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        const done = (r?: RunResult) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        };
        if (step.hold) this.heldRuns.set(spec.dispatchId, { release: done });
        else timer = setTimeout(() => done(), step.delayMs);
      });
      if (override?.error?.kind === 'cancelled') return override;
    }
    if (signal.aborted) return { error: { kind: 'cancelled', message: 'aborted' } };

    let written: string[] = [];
    try {
      const files =
        step.files ??
        (spec.writable && step.result === undefined && !override
          ? { [defaultFakeFile(spec)]: `fake change for ${spec.dispatchId}\n` }
          : {});
      written = await this.writeFiles(spec.cwd, files);
      await step.onRun?.(spec);
    } catch (err) {
      return { error: { kind: 'crash', message: `fake: ${(err as Error).message}` } };
    }
    if (override) return override;
    if (step.result !== undefined) {
      return typeof step.result === 'function' ? step.result(spec) : step.result;
    }
    return this.defaultResult(spec, written);
  }

  private async writeFiles(cwd: string, files: Record<string, string>): Promise<string[]> {
    const out: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const path = join(cwd, safeRelative(rel));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      out.push(safeRelative(rel));
    }
    return out.sort();
  }

  private defaultResult(spec: RunSpec, files: string[]): RunResult {
    const final = spec.writable
      ? {
          dispatch_id: spec.dispatchId,
          status: 'done',
          summary: 'fake 完成',
          files_changed: files,
          checks: [],
          needs_leader: '',
        }
      : { dispatch_id: spec.dispatchId, verdict: 'pass', summary: 'fake 審查通過', findings: [] };
    return { final, usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0 };
  }
}
