import { TeamApiError } from '@agent-team/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useClient } from '../api/context.js';
import { describeError } from '../api/errors.js';
import { formatTime } from '../lib/format.js';
import { useUi } from '../store/ui.js';
import { Button } from './ui/button.js';

/** Login failure in words, decided by the error code (spec §11 lockout, origin check). */
export function loginErrorMessage(err: unknown): string {
  if (!(err instanceof TeamApiError)) return describeError(err).title;
  if (err.status === 0) return '無法連線到服務，請確認服務仍在執行。';
  switch (err.code) {
    case 'unauthorized':
      return '密碼錯誤。連續錯誤 5 次會暫時鎖定。';
    case 'locked': {
      // best effort: the server message carries the unlock time ("…try again after <ISO>")
      const until = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(err.message)?.[0];
      return until
        ? `連續錯誤次數過多，已鎖定到 ${formatTime(until)}，請稍後再試。`
        : '連續錯誤次數過多，已暫時鎖定，請約 15 分鐘後再試。';
    }
    case 'forbidden':
      return '來源不被允許：請直接用看板本身的網址開啟。';
    case 'not_found':
      return '這個位址不提供密碼登入（本機監聽埠只接受權杖），請改用區網看板的位址。';
    case 'validation_failed':
    case 'bad_request':
      return '請輸入密碼。';
    default:
      return describeError(err).title;
  }
}

export function LoginPage() {
  const client = useClient();
  const qc = useQueryClient();
  const loggedIn = useUi((s) => s.loggedIn);
  const [password, setPassword] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const login = useMutation({
    mutationFn: (pw: string) => client.login(pw),
    onSuccess: async () => {
      setPassword('');
      loggedIn();
      await qc.invalidateQueries();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== '' && !login.isPending) login.mutate(password);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm"
        aria-describedby={login.isError ? errorId : undefined}
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">agent-team 看板</h1>
          <p className="text-xs text-muted">輸入服務啟動時設定（或終端機顯示）的區網密碼。</p>
        </div>
        <div className="space-y-1">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            區網密碼
          </label>
          <input
            id={fieldId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={login.isError || undefined}
            className="h-10 w-full rounded-md border border-line bg-bg px-3 text-base"
          />
        </div>
        {login.isError ? (
          <p id={errorId} role="alert" className="rounded-md bg-bad-soft p-2 text-sm text-bad">
            {loginErrorMessage(login.error)}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          pending={login.isPending}
          disabled={password === ''}
          className="w-full"
        >
          登入
        </Button>
      </form>
    </main>
  );
}
