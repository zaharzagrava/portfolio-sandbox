'use client';

import { useMemo } from 'react';
import { sanitizeBodyHtml } from '@/lib/safe-html';
import { cn } from '@/lib/utils';

/**
 * The one place a discussion `bodyHtml` reaches the DOM (W02 AS-47, FR-084): it always goes through `sanitizeBodyHtml`
 * first. `clamp` shows the first four lines (the post's excerpt). The `{__html}` object is memoised with the sanitised
 * string: React sets `innerHTML` again whenever the object changes, which would replace the text a shopper may be
 * selecting or reading on every re-render of the list.
 */
export function SafeBody({ html, clamp = false, className }: { html: string; clamp?: boolean; className?: string }) {
  const inner = useMemo(() => ({ __html: sanitizeBodyHtml(html) }), [html]);
  if (inner.__html === '') return null;
  return (
    <div
      className={cn(
        'text-sm leading-6 break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5',
        clamp && 'line-clamp-4',
        className,
      )}
      dangerouslySetInnerHTML={inner}
    />
  );
}
