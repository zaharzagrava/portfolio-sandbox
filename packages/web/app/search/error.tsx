'use client';

import { RouteError } from '@/components/layout/route-error';

export default function SearchError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} />;
}
