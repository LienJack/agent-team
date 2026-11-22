import { TeamApiError, type Delivery, type TaskCommandResult } from '@agent-team/client';
import { EXIT_CODES, exitCodeFor, refusedDelivery, refusedReport } from '@agent-team/schema';
import { taskLine } from './format.js';
import { UsageError } from './io.js';
import type { CommandContext } from './program.js';

// Output of the state-changing task commands (`task add|queue|cancel|retry`, `research add`;
// docs/adr/0022 §1): always an explicit `delivery` and the generated one-line `report`, in both
// `--json` and plain text — also when the request was refused, so the leader relays what the
// service says instead of describing the task itself.

/** `delivery: queued (waiting: no_slot — role impl_B)` */
export function deliveryLine(d: Delivery): string {
  switch (d.state) {
    case 'running':
      return `delivery: running (run ${d.run_id ?? '-'})`;
    case 'queued': {
      const w = d.waiting;
      if (!w) return 'delivery: queued (waiting: not known yet)';
      const detail = [
        w.detail,
        w.blocking_task_id ? `behind ${w.blocking_task_id}` : null,
        w.retry_at ? `until ${w.retry_at}` : null,
      ].filter((x): x is string => x !== null && x !== '');
      return `delivery: queued (waiting: ${w.reason}${detail.length ? ` — ${detail.join(', ')}` : ''})`;
    }
    case 'not_accepted':
      return `delivery: not_accepted (${d.reason ?? 'refused'})`;
    default:
      return `delivery: ${d.state}`;
  }
}

/** A successful task command: `--json` = the task with `delivery` and `report` added. */
export function printCommandResult(ctx: CommandContext, result: TaskCommandResult): void {
  ctx.print({ ...result.task, delivery: result.delivery, report: result.report }, () =>
    [taskLine(result.task), deliveryLine(result.delivery), `report: ${result.report}`].join('\n'),
  );
}

/**
 * Run a task command; a refusal (error envelope, connection failure, usage problem found by the
 * command) is printed with `delivery: not_accepted` and its report. The exit code stays the
 * error's (1 business, 2 usage/connection).
 */
export async function reportingRefusals(
  ctx: CommandContext,
  command: () => Promise<void>,
): Promise<void> {
  try {
    await command();
  } catch (err) {
    let code: string;
    let reached: boolean;
    let exit: number;
    let hint: string | undefined;
    if (err instanceof TeamApiError) {
      code = err.code;
      reached = err.status !== 0;
      exit = exitCodeFor(err.code);
      hint = err.hint;
    } else if (err instanceof UsageError) {
      code = 'usage';
      reached = true;
      exit = EXIT_CODES.usage;
    } else {
      throw err;
    }
    const message = (err as Error).message;
    const delivery = refusedDelivery(`${code}: ${message}`);
    const report = refusedReport(code, message, reached);
    if (ctx.json()) {
      const error = err instanceof TeamApiError ? err.toJSON() : { code, message };
      ctx.io.stdout(`${JSON.stringify({ error, delivery, report }, null, 2)}\n`);
    } else {
      ctx.io.stderr(`error: ${message}\n`);
      if (hint) ctx.io.stderr(`hint: ${hint}\n`);
      ctx.io.stdout(`${deliveryLine(delivery)}\nreport: ${report}\n`);
    }
    ctx.exitCode = exit;
  }
}
