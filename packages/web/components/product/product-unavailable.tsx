import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { StateMessage } from '@/components/layout/system-states';
import { RetryButton } from '@/components/product/retry-button';
import { problemCopy } from '@/lib/api/problem-copy';
import type { Problem } from '@/lib/api/errors';
import { searchHref } from '@/lib/routes';

export type ProductUnavailableState = 'not-found' | 'unavailable' | 'rate-limited' | 'offline';

const PROBLEMS: Record<ProductUnavailableState, number> = { 'not-found': 404, unavailable: 503, 'rate-limited': 429, offline: 0 };

/**
 * The one full-page state that replaces the product area when the product cannot be shown (W02 AS-33). The text comes from
 * the catalogue by status; nothing the server said is shown. A page that does not exist is marked `noindex`.
 */
export function ProductUnavailable({
  state,
  requestId,
  retryAfterSeconds,
}: {
  state: ProductUnavailableState;
  requestId?: string;
  retryAfterSeconds?: number;
}) {
  const problem: Problem = {
    status: PROBLEMS[state],
    errors: [],
    ...(requestId ? { requestId } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
  const copy = problemCopy('product', problem);
  return (
    <>
      {state === 'not-found' ? <meta name="robots" content="noindex" /> : null}
      <StateMessage
        title={state === 'not-found' ? 'Product not found' : 'Product unavailable'}
        description={copy.text}
        reference={copy.reference ? requestId : undefined}
        actions={
          state === 'not-found' ? (
            <Button asChild size="lg">
              <Link href={searchHref()}>Search products</Link>
            </Button>
          ) : state === 'rate-limited' ? null : (
            <RetryButton />
          )
        }
      />
    </>
  );
}
