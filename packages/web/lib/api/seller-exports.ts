'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  orderExportDownloadSchema,
  orderExportPageSchema,
  orderExportProgressEventSchema,
  orderExportSchema,
  type ExportFailureCode,
  type OrderExport,
  type OrderExportPage,
  type OrderExportProgressEvent,
  type OrderExportStatus,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

export type { ExportFailureCode, OrderExport, OrderExportPage, OrderExportProgressEvent, OrderExportStatus };

export const EXPORT_TERMINAL: readonly OrderExportStatus[] = ['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'];
export const isExportTerminal = (status: OrderExportStatus): boolean => EXPORT_TERMINAL.includes(status);

export const EXPORT_LIST_SIZE = 20;
const POLL_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const exportsPath = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/order-exports`;
const exportPath = (shopId: string, exportId: string) => `${exportsPath(shopId)}/${encodeURIComponent(exportId)}`;

/** `POST …/order-exports` (202): the `Idempotency-Key` makes a retry of the same attempt return the same export (S12). */
export async function startExport(shopId: string, idempotencyKey: string): Promise<OrderExport> {
  const { data } = await apiClient.post<unknown>(exportsPath(shopId), {}, { headers: { 'Idempotency-Key': idempotencyKey } });
  return parseBody(orderExportSchema, data);
}

export async function fetchExport(shopId: string, exportId: string): Promise<OrderExport> {
  const { data } = await apiClient.get<unknown>(exportPath(shopId, exportId));
  return parseBody(orderExportSchema, data);
}

export async function fetchExports(shopId: string): Promise<OrderExportPage> {
  const { data } = await apiClient.get<unknown>(exportsPath(shopId), { params: { limit: EXPORT_LIST_SIZE } });
  return parseBody(orderExportPageSchema, data);
}

export async function cancelExport(shopId: string, exportId: string): Promise<OrderExport> {
  const { data } = await apiClient.post<unknown>(`${exportPath(shopId, exportId)}/cancel`);
  return parseBody(orderExportSchema, data);
}

/** `GET …/download`: a short-lived link to the CSV. The file address is never part of an export record. */
export async function fetchExportDownload(shopId: string, exportId: string) {
  const { data } = await apiClient.get<unknown>(`${exportPath(shopId, exportId)}/download`);
  return parseBody(orderExportDownloadSchema, data);
}

/** The export a `409 export_already_active` points at, or `undefined` when the answer carries no valid id. */
export function activeExportIdOf(error: unknown): string | undefined {
  const value = (error as { response?: { data?: { activeExportId?: unknown } } } | null)?.response?.data?.activeExportId;
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

export function useExportRecord(shopId: string, exportId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.exports(shopId, 'record', exportId),
    enabled: !!exportId,
    queryFn: () => fetchExport(shopId, exportId as string),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (query.state.data && isExportTerminal(query.state.data.status) ? false : POLL_MS),
  });
}

export function useExports(shopId: string) {
  return useQuery({
    queryKey: queryKeys.seller.exports(shopId, 'list'),
    queryFn: () => fetchExports(shopId),
    retry: retryUnlessClientError,
  });
}

/** What a frame of `order-export:<exportId>` carries; `null` for anything this app does not know. */
export function parseExportEvent(type: string, data: unknown): OrderExportProgressEvent | null {
  const inner = typeof data === 'object' && data !== null && 'topic' in data && 'data' in data ? (data as { data: unknown }).data : data;
  const payload = typeof inner === 'object' && inner !== null ? inner : {};
  const parsed = orderExportProgressEventSchema.safeParse({ ...payload, type });
  return parsed.success ? parsed.data : null;
}

/** A progress frame moves the counts of the cached export; a terminal frame is followed by a read of the whole record. */
export function applyExportEvent(client: QueryClient, shopId: string, exportId: string, event: OrderExportProgressEvent): void {
  const key = queryKeys.seller.exports(shopId, 'record', exportId);
  if (event.type === 'progress') {
    client.setQueryData<OrderExport>(key, (record) =>
      record ? { ...record, status: 'RUNNING', rowsWritten: event.rowsWritten, totalRows: event.totalRows, bytesWritten: event.bytesWritten } : record,
    );
    return;
  }
  void client.invalidateQueries({ queryKey: key });
  void client.invalidateQueries({ queryKey: queryKeys.seller.exports(shopId, 'list') });
}
