import type { ReactNode } from 'react';
import { describeError } from '../../api/errors.js';
import { Button } from './button.js';

export function Loading({ label = '載入中…' }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-muted">
      <span
        aria-hidden="true"
        className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent"
      />
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-3 text-center text-xs text-muted">{children}</p>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const view = describeError(error);
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-bad/40 bg-bad-soft p-3 text-bad"
    >
      <p className="font-medium">{view.title}</p>
      {view.detail ? <p className="break-words text-xs">{view.detail}</p> : null}
      {view.hint ? <p className="text-xs opacity-80">{view.hint}</p> : null}
      {onRetry ? (
        <Button size="sm" onClick={onRetry} className="mt-1">
          重試
        </Button>
      ) : null}
    </div>
  );
}
