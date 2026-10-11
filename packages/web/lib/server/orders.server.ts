import 'server-only';
import { orderPageResponseSchema, orderPageSchema, type OrderPageDto, type OrderPageResponse } from '@marketplace-sandbox/contracts';
import { isUuid, readAsMember } from '@/lib/server/member-read.server';
import type { ReadResult } from '@/lib/server/read.server';

const PAGE_SIZE = 20;

/**
 * Server prefetch of the order aggregate (`GET /api/bff/orders/:id`, B-4) as the signed-in member. A malformed id never
 * reaches the API. `404 order_not_found` is the same value for a missing and a foreign order (W03 AS-35, AS-50).
 */
export async function getOrderAggregate(orderId: string): Promise<ReadResult<OrderPageResponse>> {
  if (!isUuid(orderId)) return { ok: false, status: 404, code: 'order_not_found' };
  return readAsMember(`/api/bff/orders/${orderId}`, orderPageResponseSchema);
}

/** Server prefetch of one history page through the BFF forwarder; `400 invalid_cursor` comes back as a value (AS-53). */
export async function getOrdersPage(cursor?: string): Promise<ReadResult<OrderPageDto>> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
  return readAsMember(`/api/bff/f/orders?${query.toString()}`, orderPageSchema);
}
