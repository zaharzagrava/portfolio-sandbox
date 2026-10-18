import { flagAuditPageSchema, flagPageSchema, flagSchema, staleFlagsSchema, type Flag, type FlagAuditPage, type FlagInput, type FlagPage, type StaleFlags } from '@marketplace-sandbox/contracts';
import type { FlagFieldError, FlagProblem } from '@/lib/admin/flags/problem';
import { apiClient } from './client';
import { parseBody } from './parse';

export type { FlagProblem } from '@/lib/admin/flags/problem';

/**
 * Every network call of the admin flag console (W06 FR-005): relative same-origin `/api/admin/flags…` paths (the BFF attaches
 * the session server-side), responses parsed with the contracts schemas, the CSRF header added by the shared client on every
 * non-GET. No token, no bearer header, no storage.
 */
const BASE = '/api/admin/flags';
const flagPath = (key: string) => `${BASE}/${encodeURIComponent(key)}`;

export async function listFlags(params: { status?: string; cursor?: string } = {}): Promise<FlagPage> {
  const query: Record<string, string> = {};
  if (params.status && params.status !== 'all') query.status = params.status;
  // S38 FR-015 does not say whether `status=archived` implies `includeArchived`; the console always sends both.
  if (params.status === 'archived') query.includeArchived = 'true';
  if (params.cursor) query.cursor = params.cursor;
  return parseBody(flagPageSchema, (await apiClient.get<unknown>(BASE, { params: query })).data);
}

export async function getFlag(key: string): Promise<Flag> {
  return parseBody(flagSchema, (await apiClient.get<unknown>(flagPath(key))).data);
}

/** Create (`expectedVersion` 0, answers 201) and update (200, also the no-op answer to an equal definition). */
export async function saveFlag(key: string, input: FlagInput): Promise<Flag> {
  return parseBody(flagSchema, (await apiClient.put<unknown>(flagPath(key), input)).data);
}

export async function killFlag(key: string): Promise<void> {
  await apiClient.post(`${flagPath(key)}/kill`);
}
export async function restoreFlag(key: string): Promise<void> {
  await apiClient.post(`${flagPath(key)}/restore`);
}
export async function archiveFlag(key: string): Promise<void> {
  await apiClient.post(`${flagPath(key)}/archive`);
}

export async function getFlagHistory(key: string, params: { cursor?: string } = {}): Promise<FlagAuditPage> {
  return parseBody(flagAuditPageSchema, (await apiClient.get<unknown>(`${flagPath(key)}/history`, { params: params.cursor ? { cursor: params.cursor } : {} })).data);
}

export async function getStaleFlags(params: { days: number }): Promise<StaleFlags> {
  return parseBody(staleFlagsSchema, (await apiClient.get<unknown>(`${BASE}/stale`, { params: { days: params.days } })).data);
}

type Wire = { status?: number; data?: unknown; headers?: Record<string, unknown> };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * Reads a failed call into a `FlagProblem` (R-02, R-03). The machine code is `body.code`, else the last segment of
 * `body.type`; 422/400 entries are normalised to `{path, code, sum?}` from `path` or `field`. Never throws; `title` and `detail`
 * are not carried: copy comes from the code and the status (W06 FR-050).
 */
export function readFlagProblem(error: unknown): FlagProblem {
  const response = (error as { response?: Wire } | null)?.response;
  if (!response || typeof response.status !== 'number') return { status: 0, fieldErrors: [] };
  const body = response.data && typeof response.data === 'object' ? (response.data as Record<string, unknown>) : {};
  const type = text(body.type);
  const code = text(body.code) ?? (type && !type.startsWith('about:') ? text(type.split('/').pop()) : undefined);
  const retryHeader = response.headers?.['retry-after'];
  const retry = Number(Array.isArray(retryHeader) ? retryHeader[0] : retryHeader);
  const fieldErrors: FlagFieldError[] = Array.isArray(body.errors)
    ? body.errors.flatMap((entry): FlagFieldError[] => {
        const item = (entry ?? {}) as Record<string, unknown>;
        const path = text(item.path) ?? text(item.field);
        const itemCode = text(item.code);
        if (!path || !itemCode) return [];
        return [{ path, code: itemCode, ...(typeof item.sum === 'number' ? { sum: item.sum } : {}) }];
      })
    : [];
  return {
    status: response.status,
    ...(code ? { code } : {}),
    ...(text(body.requestId) ? { requestId: text(body.requestId) } : {}),
    ...(retryHeader !== undefined && Number.isFinite(retry) && retry >= 0 ? { retryAfterSeconds: retry } : {}),
    fieldErrors,
    ...(typeof body.currentVersion === 'number' ? { currentVersion: body.currentVersion } : {}),
    ...(text(body.currentStatus) ? { currentStatus: text(body.currentStatus) } : {}),
  };
}
