/**
 * Human-readable message from a failed API call. The backend answers with RFC 7807 Problem Details
 * (`detail`, `title`); validation errors join field messages into `detail`. Falls back when the
 * request never reached the server (network error) or the body is not Problem Details.
 *
 * Other capabilities still use this for their toasts; W01 screens use `problemFromError` + the copy catalogue instead.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const body = data as { detail?: unknown; message?: unknown; title?: unknown };
    for (const value of [body.detail, body.message]) {
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.length) return value.join(', ');
    }
  }
  return fallback;
}

/**
 * What the UI needs from a failed call (RFC 9457 body + `Retry-After`). `title` and `detail` are deliberately not
 * carried: copy comes from the stable `code` and `status` (W01 FR-040). `errors` mirrors the wire shape (`field`, `code`).
 */
export type Problem = {
  /** HTTP status; `0` when the request never got an answer (network failure). */
  status: number;
  code?: string;
  errors: { field: string; code: string }[];
  retryAfterSeconds?: number;
  requestId?: string;
};

type AxiosLikeError = {
  response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
};

/** Converts any thrown value from an API call into a `Problem`; never throws. */
export function problemFromError(error: unknown): Problem {
  const response = (error as AxiosLikeError | null)?.response;
  if (!response || typeof response.status !== 'number') return { status: 0, errors: [] };
  const body = response.data && typeof response.data === 'object' ? (response.data as Record<string, unknown>) : {};
  const retryHeader = response.headers?.['retry-after'];
  const retry = Number(Array.isArray(retryHeader) ? retryHeader[0] : retryHeader);
  return {
    status: response.status,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    errors: Array.isArray(body.errors)
      ? body.errors.flatMap((entry) => {
          const item = entry as { field?: unknown; code?: unknown };
          return typeof item?.field === 'string' && typeof item?.code === 'string' ? [{ field: item.field, code: item.code }] : [];
        })
      : [],
    ...(retryHeader !== undefined && Number.isFinite(retry) && retry >= 0 ? { retryAfterSeconds: retry } : {}),
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
  };
}
