import type { ReactNode } from 'react';

/**
 * The card of every auth page (W01 FR-050): the page's single `h1`, its description, then the banner/form (children) and
 * the secondary links (footer). Static markup, so pages render it on the server around their client leaf.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 sm:rounded-xl sm:border sm:bg-card sm:p-6 sm:shadow-sm">
      <div className="space-y-1">
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
          {title}
        </h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
      {footer && <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}

export const authLinkClass =
  'inline-flex min-h-11 items-center font-medium text-indigo-600 underline-offset-4 hover:underline dark:text-indigo-400 sm:min-h-0';
