import { safeRequest, SafeRequestError } from '@app/infrastructure/net';
import type { SafeUrlOptions } from '@app/infrastructure/net/safe-url';

export interface SendResult {
  status: number;
  durationMs: number;
  snippet: string;
  error?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024;

/**
 * POST to a webhook endpoint through the SSRF-safe request (S54 FR-061): address checked and pinned, certificate
 * verified against the host, no redirect followed (a 3xx counts as a failed delivery), 10 s deadline, response capped.
 * Blocked and invalid targets are thrown (`SafeRequestError` kind `blocked_address` / `invalid_url`) so the caller can
 * park the endpoint; every other failure is reported as a result with `status: 0` and the failure kind.
 */
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  ssrf: SafeUrlOptions,
): Promise<SendResult> {
  try {
    const res = await safeRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Marketplace-Webhooks/1.0',
        ...headers,
      },
      body,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      allowedPorts: [443],
      followRedirects: false,
      ...ssrf,
    });
    return {
      status: res.status,
      durationMs: res.durationMs,
      snippet: res.snippet,
    };
  } catch (error) {
    if (
      error instanceof SafeRequestError &&
      error.kind !== 'blocked_address' &&
      error.kind !== 'invalid_url' &&
      error.kind !== 'unresolvable'
    ) {
      return { status: 0, durationMs: 0, snippet: '', error: error.kind };
    }
    throw error;
  }
}
