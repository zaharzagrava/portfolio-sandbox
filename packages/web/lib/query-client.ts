import { QueryClient } from '@tanstack/react-query';
import { applyQueryDefaults } from '@/lib/query-defaults';

const MAX_RETRIES = 2;
const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 409, 422]);

/** AS-36: network errors and `5xx` retry at most twice; any answered `4xx` never does. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  // An answer that arrived but is wrong (e.g. an invalid body) will be wrong again.
  if ((error as { retryable?: unknown } | null)?.retryable === false) return false;
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status !== 'number') return true;
  if (NO_RETRY_STATUS.has(status)) return false;
  return status >= 500;
}

export function makeQueryClient(): QueryClient {
  return applyQueryDefaults(
    new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000,
          retry: shouldRetryQuery,
          retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
          // Off by default; the session query turns it on for itself (hooks/use-auth.tsx).
          refetchOnWindowFocus: false,
          // FR-065: queries that failed while offline are fetched again when the connection returns.
          refetchOnReconnect: true,
        },
        mutations: { retry: false },
      },
    }),
  );
}

let browserClient: QueryClient | undefined;

/** One client per browser tab; a new one for every server render, never shared between requests. */
export function getQueryClient(isServer: boolean = typeof window === 'undefined'): QueryClient {
  if (isServer) return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}
