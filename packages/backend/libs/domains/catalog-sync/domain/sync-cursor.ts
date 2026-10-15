import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque pull cursor, bound to the shop and to the feed's generation: base64url of
 * `v1.<shopId>.<generation>.<seq>.<8-byte HMAC as hex>` (R-06). A forged, foreign or malformed cursor decodes to
 * `{ok: false}` (`400 invalid_cursor`); whether its generation is still current is the service's decision (`410`).
 */
export interface SyncCursor {
  shopId: string;
  generation: number;
  seq: number;
}

const SHOP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mac = (body: string, key: string) =>
  createHmac('sha256', key).update(body).digest('hex').slice(0, 16);

export function encodeSyncCursor(cursor: SyncCursor, key: string): string {
  const body = `v1.${cursor.shopId}.${cursor.generation}.${cursor.seq}`;
  return Buffer.from(`${body}.${mac(body, key)}`, 'utf8').toString('base64url');
}

export type DecodedSyncCursor =
  { ok: true; generation: number; seq: number } | { ok: false };

export function decodeSyncCursor(
  value: string,
  shopId: string,
  key: string,
): DecodedSyncCursor {
  const bad = { ok: false } as const;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return bad;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const parts = text.split('.');
  if (parts.length !== 5) return bad;
  const [version, cursorShop, generation, seq, signature] = parts;
  if (version !== 'v1' || !SHOP.test(cursorShop)) return bad;
  if (!/^\d{1,9}$/.test(generation) || !/^\d{1,15}$/.test(seq)) return bad;
  const expected = Buffer.from(
    mac(`${version}.${cursorShop}.${generation}.${seq}`, key),
  );
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return bad;
  if (cursorShop.toLowerCase() !== shopId.toLowerCase()) return bad;
  return { ok: true, generation: Number(generation), seq: Number(seq) };
}
