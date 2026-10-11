import { clientEventBatchSchema, type ClientEventInput } from '@marketplace-sandbox/contracts';
import { csrfHeaders } from './csrf';

const ENDPOINT = '/api/events';

export type SendResult = { ok: true } | { ok: false; retryable: boolean };

/**
 * Sends one batch of visitor events to the same-origin ingestion endpoint (W02 FR-142). Never throws.
 * `beacon: true` (page hidden or unloaded) uses `navigator.sendBeacon` with the JSON as `text/plain`, and falls back to a
 * keep-alive request when the browser refuses it. A beacon cannot carry the CSRF header, so only the keep-alive path
 * does (see gaps.md, H9). Partial rejections (`202` with `rejected`) are ignored.
 */
export async function sendEvents(events: ClientEventInput[], options: { beacon?: boolean } = {}): Promise<SendResult> {
  const batch = clientEventBatchSchema.safeParse({ events });
  if (!batch.success) return { ok: false, retryable: false };
  const body = JSON.stringify(batch.data);

  if (options.beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return { ok: true };
    } catch {
      // fall through to the keep-alive request
    }
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body,
      keepalive: true,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.ok) return { ok: true };
    return { ok: false, retryable: response.status === 408 || response.status === 429 || response.status >= 500 };
  } catch {
    return { ok: false, retryable: true };
  }
}
