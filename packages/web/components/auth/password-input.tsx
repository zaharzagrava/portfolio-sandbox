'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type ComponentProps, type Ref } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = Omit<ComponentProps<'input'>, 'type' | 'ref' | 'aria-invalid' | 'aria-describedby'> & {
  label: string;
  /** Required: `current-password` for sign in, `new-password` everywhere a password is chosen. */
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  error?: string;
  ref?: Ref<HTMLInputElement>;
};

/** Labelled password field with a Show/hide toggle; hint and error are tied with `aria-describedby` (W01 FR-020, FR-052). */
export function PasswordInput({ label, hint, error, id, className, ref, ...rest }: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const [shown, setShown] = useState(false);
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="grid gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Input
          {...rest}
          ref={ref}
          id={inputId}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={described || undefined}
          className={`h-11 pr-12 sm:h-9 ${className ?? ''}`}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown((value) => !value)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {shown ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
