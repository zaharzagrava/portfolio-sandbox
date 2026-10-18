import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export type ControlProps = { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string };

/**
 * A labelled control with an optional hint and server/syntax message, wired by `aria-describedby` and `aria-invalid`
 * (W06 AS-14, AS-58). The control is rendered by the caller with the props this passes.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (props: ControlProps) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, ...(error ? { 'aria-invalid': true as const } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
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

export const SELECT_CLASS =
  'h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:h-9';

/** A native select (keyboard and screen-reader behaviour for free) styled like the inputs. */
export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(SELECT_CLASS, className)} />;
}

/** The select of a variant choice: exactly the current variants in order; an unset choice shows "Choose a variant." (W06 AS-19, AS-20). */
export function VariantSelect({
  variants,
  value,
  onChange,
  disabled,
  ...aria
}: {
  variants: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
} & ControlProps) {
  const unset = value === '' || !variants.includes(value);
  return (
    <NativeSelect value={unset ? '' : value} onChange={(event) => onChange(event.target.value)} disabled={disabled} {...aria} aria-invalid={aria['aria-invalid'] ?? (unset ? true : undefined)}>
      {unset && (
        <option value="" disabled>
          Choose a variant.
        </option>
      )}
      {variants.map((key) => (
        <option key={key} value={key}>
          {key}
        </option>
      ))}
    </NativeSelect>
  );
}
