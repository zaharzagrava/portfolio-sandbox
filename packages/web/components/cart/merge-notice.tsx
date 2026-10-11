'use client';

import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLastMerge } from '@/lib/api/cart';
import { queryKeys } from '@/lib/query-keys';

/**
 * After sign-in the guest cart is merged; lines a full cart could not take are counted in `droppedLines` (W03 AS-11).
 * The notice stays until dismissed or the next full page load (the result lives only in the query cache) and is absent
 * when nothing was dropped.
 */
export function MergeNotice() {
  const client = useQueryClient();
  const merge = useLastMerge();
  if (!merge || merge.droppedLines <= 0) return null;
  const count = merge.droppedLines;

  return (
    <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-lg border bg-muted px-4 py-3 text-sm">
      <p>{`${count} ${count === 1 ? 'item' : 'items'} from your guest cart couldn't be added because a cart holds at most 50 different items.`}</p>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0 lg:min-h-7" onClick={() => client.setQueryData(queryKeys.cart.lastMerge(), { droppedLines: 0 })}>
        <X aria-hidden="true" className="size-4" />
        Dismiss
      </Button>
    </div>
  );
}
