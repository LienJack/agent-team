import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg border-accent hover:opacity-90',
  secondary: 'bg-surface text-fg border-line hover:bg-raised',
  danger: 'bg-surface text-bad border-bad/60 hover:bg-bad-soft',
  ghost: 'bg-transparent text-fg border-transparent hover:bg-raised',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Request in flight: disabled and marked busy. */
  pending?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const sizing = size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm';
  return (
    <button
      type={type ?? 'button'}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 ${sizing} ${VARIANTS[variant]} ${className ?? ''}`}
      {...rest}
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
