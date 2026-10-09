import { AppError, problemTypeBaseUrl } from '@app/common/errors/error.types';

const RESERVED = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'requestId',
  'traceId',
  'errors',
  'area',
  'data',
  'causes',
  'stack',
]);

export interface ProblemBody extends Record<string, unknown> {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  traceId?: string;
}

export interface ProblemDocument {
  status: number;
  body: ProblemBody;
  headers: Record<string, string>;
}

export interface ProblemContext {
  requestId: string;
  /** Request path; any query string is dropped. */
  instance: string;
  traceId?: string;
  typeBaseUrl?: string;
  /** Catalogue text used as `detail` for every status >= 500 so internals never leak. */
  catalogDetail?: string;
  /** Field errors for validation failures. */
  errors?: { field: string; code: string }[];
}

const GENERIC_5XX_DETAIL =
  'The server could not complete the request. Please try again later.';

export const stripQuery = (url: string): string =>
  url.split('?')[0].split('#')[0];

/** Minimal always-serialisable 500 used when the full document cannot be built. */
export function fallbackProblem(ctx: ProblemContext): ProblemDocument {
  const base = ctx.typeBaseUrl ?? problemTypeBaseUrl();
  return {
    status: 500,
    headers: {},
    body: {
      type: `${base}/internal_error`,
      title: 'Internal Server Error',
      status: 500,
      detail: ctx.catalogDetail ?? GENERIC_5XX_DETAIL,
      instance: stripQuery(ctx.instance),
      code: 'internal_error',
      requestId: ctx.requestId,
      ...(ctx.traceId && { traceId: ctx.traceId }),
    },
  };
}

/**
 * Pure builder of the RFC 9457 document (S54 FR-001): only the contract members plus non-reserved extensions.
 * Never throws; a failure (e.g. a circular extension) yields the minimal 500 document.
 */
export function buildProblemDocument(
  error: AppError,
  ctx: ProblemContext,
): ProblemDocument {
  try {
    const extensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(error.extensions ?? {}))
      if (!RESERVED.has(k)) extensions[k] = v;

    const rawErrors = ctx.errors ?? error.extensions?.errors;
    const fieldErrors = Array.isArray(rawErrors)
      ? (rawErrors as { field: string; code: string }[])
      : undefined;

    const body: ProblemBody = {
      ...extensions,
      type: `${ctx.typeBaseUrl ?? problemTypeBaseUrl()}/${error.code}`,
      title: error.title,
      status: error.status,
      detail:
        Number(error.status) >= 500
          ? (ctx.catalogDetail ?? GENERIC_5XX_DETAIL)
          : error.message,
      instance: stripQuery(ctx.instance),
      code: error.code,
      requestId: ctx.requestId,
      ...(ctx.traceId && { traceId: ctx.traceId }),
      ...(fieldErrors?.length && { errors: fieldErrors }),
    };
    JSON.stringify(body); // throws on circular / BigInt values

    const headers: Record<string, string> = { ...error.headers };
    if (error.retryAfterSeconds !== undefined)
      headers['Retry-After'] = String(
        Math.max(0, Math.ceil(error.retryAfterSeconds)),
      );
    return { status: error.status, body, headers };
  } catch {
    return fallbackProblem(ctx);
  }
}
