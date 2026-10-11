import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/lib/providers';

/**
 * Reads this response's CSP nonce (set by `proxy.ts`) and hands it to the client providers, whose theme bootstrap
 * script needs it. Reading request headers makes the document dynamic, so the root layout wraps this in `Suspense`.
 */
export async function NonceProviders({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <Providers nonce={nonce}>{children}</Providers>;
}
