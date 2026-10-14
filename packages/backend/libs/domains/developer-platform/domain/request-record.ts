import { createHash } from 'node:crypto';

const BULK_CHUNK = 100;

/**
 * What a call costs (FR-051, FR-058): 1, a batch its operation count, bulk stock one unit per 100 items. A replay served
 * from the idempotency store counts as the one request it replays; the batch size is still reported.
 */
export function costOf(
  method: string,
  route: string,
  body: unknown,
  replay: boolean,
): { cost: number; batchOps?: number } {
  if (method !== 'POST') return { cost: 1 };
  if (route === '/v1/batch') {
    const ops = (body as { operations?: unknown } | undefined)?.operations;
    if (!Array.isArray(ops)) return { cost: 1 };
    return { cost: replay ? 1 : Math.max(1, ops.length), batchOps: ops.length };
  }
  if (route === '/v1/stock/bulk') {
    const items = (body as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items) || replay) return { cost: 1 };
    return { cost: Math.max(1, Math.ceil(items.length / BULK_CHUNK)) };
  }
  return { cost: 1 };
}

/**
 * UUID-shaped and derived from the request id, so the record has the same event id however often it is produced and
 * a redelivery is recognised by the consumers' inbox (FR-054).
 */
export function recordEventId(requestId: string): string {
  const h = createHash('sha256')
    .update(`api.request_logged|${requestId}`)
    .digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  // version 7 shape, as the event envelope requires; the 48 leading bits come from the hash, not from a clock
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
