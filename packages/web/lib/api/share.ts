import { shortLinkSchema, type ShortLink } from '@marketplace-sandbox/contracts';
import { endSession } from '@/lib/auth/session-ended';
import { safeHttpsUrl } from '@/lib/safe-url';
import { apiClient } from './client';
import { problemFromError } from './errors';
import { ApiParseError, parseBody } from './parse';
import { believesSignedIn } from './session-presence';

export type { ShortLink };

/** `409 idempotency_in_flight`: the same request is repeated with the same key after one second, at most three times. */
export const IN_FLIGHT_DELAY_MS = 1000;
export const IN_FLIGHT_RETRIES = 3;

/** A write made while the browser is offline fails at once, shaped like an axios error without an answer (status 0). */
class OfflineError extends Error {
  constructor() {
    super('offline');
    this.name = 'OfflineError';
  }
}

/**
 * `POST /api/links {destination}` with the attempt's `Idempotency-Key` (S37; W02 FR-120). The `201` body is parsed with
 * `shortLinkSchema`; a `shortUrl` that is not an absolute `https` address is unusable and counts as an invalid response
 * (AS-72). Offline fails before any request; a `401` while a member is signed in runs W01's session-ended flow, once.
 */
export async function createShortLink(destination: string, key: string, { signal }: { signal?: AbortSignal } = {}): Promise<ShortLink> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
  try {
    const { data } = await apiClient.post<unknown>('/api/links', { destination }, { headers: { 'Idempotency-Key': key }, signal });
    const link = parseBody(shortLinkSchema, data);
    if (safeHttpsUrl(link.shortUrl) === undefined) throw new ApiParseError();
    return link;
  } catch (error) {
    if (problemFromError(error).status === 401 && believesSignedIn()) endSession();
    throw error;
  }
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** `createShortLink`, repeated with the same key while the server still processes the first request (AS-62). */
export async function createShortLinkPatiently(destination: string, key: string, options: { signal?: AbortSignal } = {}): Promise<ShortLink> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await createShortLink(destination, key, options);
    } catch (error) {
      const problem = problemFromError(error);
      if (problem.status !== 409 || problem.code !== 'idempotency_in_flight' || attempt >= IN_FLIGHT_RETRIES) throw error;
      await wait(IN_FLIGHT_DELAY_MS, options.signal);
    }
  }
}
