import 'server-only';
import { cookies } from 'next/headers';
import type { ZodType } from 'zod';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { bffUrl } from '@/lib/server/endpoints.server';
import type { ReadResult } from '@/lib/server/read.server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Order and payment ids are UUIDs; anything else is never sent to the API. */
export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * One server-side read made as the signed-in member (W03 FR-050): forwards only the BFF session cookie, never stores or
 * returns it, never sets `Authorization`. The BFF forwarder turns the cookie into the identity. Failures are values.
 * Never call this inside a `"use cache"` function: the answer belongs to one member.
 */
export async function readAsMember<T>(path: string, schema: ZodType<T>, options: { timeoutMs?: number } = {}): Promise<ReadResult<T>> {
  const session = (await cookies()).get(BFF_COOKIES.session)?.value;
  if (!session) return { ok: false, status: 401, code: 'unauthenticated' };

  let response: Response;
  try {
    response = await fetch(`${bffUrl()}${path}`, {
      headers: { accept: 'application/json', cookie: `${BFF_COOKIES.session}=${session}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch {
    return { ok: false, status: 0 };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const problem = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; requestId?: unknown };
    const retry = Number(response.headers.get('retry-after'));
    return {
      ok: false,
      status: response.status,
      ...(typeof problem.code === 'string' ? { code: problem.code } : {}),
      ...(typeof problem.requestId === 'string' ? { requestId: problem.requestId } : {}),
      ...(response.headers.get('retry-after') && Number.isFinite(retry) ? { retryAfter: retry } : {}),
    };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502, code: 'invalid_response' };
}
