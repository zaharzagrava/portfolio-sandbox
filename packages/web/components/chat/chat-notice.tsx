import type { ReactNode } from 'react';

/**
 * One plain message of the chat with its way out (W05 AS-05, AS-08, AS-12). The words come from `lib/chat/errors-copy.ts`,
 * chosen by the problem's `code`; the server's title and detail are never passed in. `role="alert"` for something that went
 * wrong, `role="status"` for a quiet state.
 */
export function ChatNotice({
  text,
  reference,
  role = 'alert',
  children,
  className = '',
}: {
  text: string;
  reference?: string;
  role?: 'alert' | 'status';
  children?: ReactNode;
  className?: string;
}) {
  const tone =
    role === 'alert'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100'
      : 'border-border bg-muted text-foreground';
  return (
    <div role={role} className={`rounded-lg border px-3 py-2 text-sm ${tone} ${className}`}>
      <p>{text}</p>
      {reference && <p className="mt-1 text-xs">{reference}</p>}
      {children && <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
