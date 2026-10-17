'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  importErrorReportSchema,
  importJobSchema,
  importPageSchema,
  importProgressEventSchema,
  importStartResponseSchema,
  importUploadStateSchema,
  type ImportJob,
  type ImportPage,
  type ImportProgressEvent,
  type ImportStartResponse,
  type ImportStatus,
  type ImportUploadState,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

export type { ImportJob, ImportPage, ImportProgressEvent, ImportStartResponse, ImportStatus, ImportUploadState };

/** Statuses after which the import no longer changes. */
export const IMPORT_TERMINAL: readonly ImportStatus[] = ['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'];
export const isImportTerminal = (status: ImportStatus): boolean => IMPORT_TERMINAL.includes(status);

export const IMPORT_LIST_SIZE = 20;
const POLL_MS = 10_000;

const importsPath = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/imports`;
const importPath = (shopId: string, importId: string) => `${importsPath(shopId)}/${encodeURIComponent(importId)}`;

/** `POST …/imports`: the `Idempotency-Key` makes a retry of the same attempt return the same import (S07). */
export async function startImport(shopId: string, input: { fileName: string; sizeBytes: number }, idempotencyKey: string): Promise<ImportStartResponse> {
  const { data } = await apiClient.post<unknown>(importsPath(shopId), input, { headers: { 'Idempotency-Key': idempotencyKey } });
  return parseBody(importStartResponseSchema, data);
}

/** `GET …/upload`: what storage holds and the fresh addresses of the parts still missing. */
export async function fetchUploadState(shopId: string, importId: string): Promise<ImportUploadState> {
  const { data } = await apiClient.get<unknown>(`${importPath(shopId, importId)}/upload`);
  return parseBody(importUploadStateSchema, data);
}

export async function completeImport(shopId: string, importId: string, parts: { partNumber: number; etag: string }[]): Promise<ImportJob> {
  const { data } = await apiClient.post<unknown>(`${importPath(shopId, importId)}/complete`, { parts });
  return parseBody(importJobSchema, data);
}

export async function cancelImport(shopId: string, importId: string): Promise<ImportJob> {
  const { data } = await apiClient.post<unknown>(`${importPath(shopId, importId)}/cancel`);
  return parseBody(importJobSchema, data);
}

export async function fetchImport(shopId: string, importId: string): Promise<ImportJob> {
  const { data } = await apiClient.get<unknown>(importPath(shopId, importId));
  return parseBody(importJobSchema, data);
}

export async function fetchImports(shopId: string): Promise<ImportPage> {
  const { data } = await apiClient.get<unknown>(importsPath(shopId), { params: { limit: IMPORT_LIST_SIZE } });
  return parseBody(importPageSchema, data);
}

/** `GET …/error-report`: a short-lived link to the CSV of the refused rows. */
export async function fetchErrorReport(shopId: string, importId: string) {
  const { data } = await apiClient.get<unknown>(`${importPath(shopId, importId)}/error-report`);
  return parseBody(importErrorReportSchema, data);
}

/**
 * Sends one part to its storage address (the address is the credential; no cookie, no CSRF header) and returns the ETag
 * storage answers. A refusal or a missing ETag throws, and the part is sent again on "Resume upload".
 */
export async function putPart(url: string, body: Blob, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body, signal, credentials: 'omit' });
  const etag = response.headers.get('ETag');
  if (!response.ok || !etag) throw new Error(`part_upload_failed:${response.status}`);
  return etag;
}

export type PartTodo = { partNumber: number; url: string };

/**
 * Uploads `todo` (at most `concurrency` at a time) cutting each part from `file` by `partSize`, and calls `onPart` after each
 * stored part. Stops at the first failure; the parts already stored are kept by the caller.
 */
export async function uploadParts(
  file: Blob,
  partSize: number,
  todo: readonly PartTodo[],
  onPart: (partNumber: number, etag: string) => void,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const queue = [...todo];
  let failure: unknown;
  const worker = async () => {
    for (let next = queue.shift(); next && failure === undefined; next = queue.shift()) {
      try {
        const etag = await putPart(next.url, file.slice((next.partNumber - 1) * partSize, next.partNumber * partSize), options.signal);
        onPart(next.partNumber, etag);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, queue.length) }, worker));
  if (failure !== undefined) throw failure;
}

/** The import and the list of imports; the list is what the live events and a cancel invalidate. */
export function useImportJob(shopId: string, importId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.imports(shopId, 'job', importId),
    enabled: !!importId,
    queryFn: () => fetchImport(shopId, importId as string),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (query.state.data && isImportTerminal(query.state.data.status) ? false : POLL_MS),
  });
}

export function useImports(shopId: string) {
  return useQuery({
    queryKey: queryKeys.seller.imports(shopId, 'list'),
    queryFn: () => fetchImports(shopId),
    retry: retryUnlessClientError,
  });
}

/** What a frame of `import:<importId>` carries; `null` for anything this app does not know. */
export function parseImportEvent(type: string, data: unknown): ImportProgressEvent | null {
  const inner = typeof data === 'object' && data !== null && 'topic' in data && 'data' in data ? (data as { data: unknown }).data : data;
  const payload = typeof inner === 'object' && inner !== null ? inner : {};
  const parsed = importProgressEventSchema.safeParse({ ...payload, type });
  return parsed.success ? parsed.data : null;
}

/** A progress frame moves the counts of the cached import; a terminal frame is followed by a read of the whole import. */
export function applyImportEvent(client: QueryClient, shopId: string, importId: string, event: ImportProgressEvent): void {
  const key = queryKeys.seller.imports(shopId, 'job', importId);
  if (event.type === 'progress') {
    client.setQueryData<ImportJob>(key, (job) =>
      job ? { ...job, rowsProcessed: event.processed, rowsFailed: event.failed, bytesProcessed: event.bytesProcessed, sizeBytes: event.sizeBytes } : job,
    );
    return;
  }
  void client.invalidateQueries({ queryKey: key });
  void client.invalidateQueries({ queryKey: queryKeys.seller.imports(shopId, 'list') });
}
