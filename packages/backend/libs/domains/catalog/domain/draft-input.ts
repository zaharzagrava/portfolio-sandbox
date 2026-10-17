import type { z } from 'zod';
import { DRAFT_LIMITS } from '@marketplace-sandbox/contracts';
import { DRAFT_STATUSES, type DraftStatus } from './draft-status';

export type DraftParse<T> =
  { ok: true; value: T } | { ok: false; fields: string[] };

/** The names of the offending fields of a failed parse (`(body)` when the body itself is wrong), never their values. */
export function failedFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys')
      for (const key of issue.keys) fields.add(key);
    else fields.add(issue.path.length > 0 ? String(issue.path[0]) : '(body)');
  }
  return [...fields];
}

export function parseWith<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): DraftParse<z.output<S>> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, fields: failedFields(parsed.error) };
}

export interface PageQuery {
  limit: number;
  cursor: string | null;
}

export interface DraftListQuery extends PageQuery {
  status: DraftStatus | null;
}

const single = (raw: Record<string, unknown>, key: string, bad: string[]) => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    bad.push(key);
    return undefined;
  }
  return value;
};

function pageParts(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  bad: string[],
): PageQuery {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) bad.push(key);
  const limitRaw = single(raw, 'limit', bad);
  let limit: number = DRAFT_LIMITS.pageLimit.default;
  if (limitRaw !== undefined) {
    const n = /^\d{1,4}$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
    if (
      !Number.isInteger(n) ||
      n < DRAFT_LIMITS.pageLimit.min ||
      n > DRAFT_LIMITS.pageLimit.max
    )
      bad.push('limit');
    else limit = n;
  }
  const cursor = single(raw, 'cursor', bad);
  if (cursor !== undefined && (cursor === '' || cursor.length > 512))
    bad.push('cursor');
  return { limit, cursor: cursor ?? null };
}

/** `?status&limit&cursor` of the draft list: strict, every value a single string. */
export function parseDraftListQuery(
  raw: Record<string, unknown>,
): DraftParse<DraftListQuery> {
  const bad: string[] = [];
  const page = pageParts(raw, ['status', 'limit', 'cursor'], bad);
  const statusRaw = single(raw, 'status', bad);
  let status: DraftStatus | null = null;
  if (statusRaw !== undefined) {
    if ((DRAFT_STATUSES as readonly string[]).includes(statusRaw))
      status = statusRaw as DraftStatus;
    else bad.push('status');
  }
  return bad.length > 0
    ? { ok: false, fields: [...new Set(bad)] }
    : { ok: true, value: { ...page, status } };
}

/** `?limit&cursor` of the version list. */
export function parseVersionListQuery(
  raw: Record<string, unknown>,
): DraftParse<PageQuery> {
  const bad: string[] = [];
  const page = pageParts(raw, ['limit', 'cursor'], bad);
  return bad.length > 0
    ? { ok: false, fields: [...new Set(bad)] }
    : { ok: true, value: page };
}
