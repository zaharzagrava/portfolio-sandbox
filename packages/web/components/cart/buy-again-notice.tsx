'use client';

import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBuyAgainFailures } from '@/lib/api/cart';
import { queryKeys } from '@/lib/query-keys';

/**
 * Lines that Buy these items again could not put back (W03 AS-59): "Couldn't add: {titles}." on the cart page, until
 * dismissed or the next full page load. The titles travel in the query cache (plain text, rendered as text).
 */
export function BuyAgainNotice() {
  const client = useQueryClient();
  const titles = useBuyAgainFailures();
  if (!titles || titles.length === 0) return null;
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
      <p>{`Couldn't add: ${titles.join(', ')}.`}</p>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0 lg:min-h-7" onClick={() => client.setQueryData(queryKeys.cart.buyAgainFailures(), [])}>
        <X aria-hidden="true" className="size-4" />
        Dismiss
      </Button>
    </div>
  );
}
