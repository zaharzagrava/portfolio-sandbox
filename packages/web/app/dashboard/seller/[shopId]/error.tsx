'use client';

import { RouteError } from '@/components/layout/route-error';

/** A failure inside a shop page stays inside the content area: the generic text, the server digest, "Try again". */
export default function ShopError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} />;
}
