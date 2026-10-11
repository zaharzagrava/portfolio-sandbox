import 'server-only';
import type { ZodType } from 'zod';

/**
 * One anonymous server-side read of a public endpoint (W02 FR-050, FR-153): no cookie, no `Authorization`, no
 * `X-Anonymous-Id`; the body is parsed with its contract schema and every failure becomes a value, never a throw, so the
 * caller can choose its cache lifetime for the failure (W02 FR-151: a failed read is kept at most five seconds).
 */
export type ReadFailure = {
  ok: false;
  /** HTTP status, or 0 for a network failure or a timeout, 502 for an unparsable body. */
  status: number;
  code?: string;
  requestId?: string;
  /** Seconds from `Retry-After`, when the answer had one. */
  retryAfter?: number;
  /** The refused parameter names of a `422 unsupported_combination`. */
  parameters?: string[];
};
export type ReadResult<T> = { ok: true; data: T } | ReadFailure;

/** The JSON body of a successful read, unparsed: for callers that parse sections one by one. */
export async function readPublicJson(url: string, options: { timeoutMs?: number } = {}): Promise<ReadResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
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
    const problem = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; requestId?: unknown; parameters?: unknown };
    const header = response.headers.get('retry-after');
    const retryAfter = Number(header);
    return {
      ok: false,
      status: response.status,
      ...(Array.isArray(problem.parameters) ? { parameters: problem.parameters.filter((p): p is string => typeof p === 'string') } : {}),
      ...(typeof problem.code === 'string' ? { code: problem.code } : {}),
      ...(typeof problem.requestId === 'string' ? { requestId: problem.requestId } : {}),
      ...(header && Number.isFinite(retryAfter) ? { retryAfter } : {}),
    };
  }
  return body === undefined ? { ok: false, status: 502, code: 'invalid_response' } : { ok: true, data: body };
}

export async function readPublic<T>(url: string, schema: ZodType<T>, options: { timeoutMs?: number } = {}): Promise<ReadResult<T>> {
  const result = await readPublicJson(url, options);
  if (!result.ok) return result;
  const parsed = schema.safeParse(result.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502, code: 'invalid_response' };
}
