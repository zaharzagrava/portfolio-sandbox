// Stand-in for the W01 contract: the owner replaces the body, never the name or props.

/** What the UI needs from a failed call (RFC 9457 body + `Retry-After`). `title`/`detail` are deliberately not carried. */
export type Problem = {
  /** HTTP status; `0` when the request never got an answer (network failure). */
  status: number;
  /** Stable machine code from the problem body. */
  code?: string;
  /** Field messages of `validation_failed`. */
  errors: { field?: string; message: string }[];
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
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  return {
    status: response.status,
    code: typeof body.code === 'string' ? body.code : undefined,
    errors: Array.isArray(body.errors)
      ? body.errors.flatMap((entry) => {
          const item = entry as { field?: unknown; message?: unknown };
          return typeof item?.message === 'string' ? [{ field: typeof item.field === 'string' ? item.field : undefined, message: item.message }] : [];
        })
      : [],
    retryAfterSeconds: Number.isFinite(retry) && retry >= 0 ? retry : undefined,
    requestId,
  };
}
