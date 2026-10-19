import { randomBytes } from 'node:crypto';
import {
  syncPullResponseSchema,
  syncPushResponseSchema,
  type SyncOp,
  type SyncPullResponse,
  type SyncPushResponse,
} from '@marketplace-sandbox/contracts';
import type { FixtureShop } from './catalog-fixture';

/** UUIDv7 (time-ordered, RFC 9562): 48 bits of milliseconds, version 7, variant 10. Unique per call. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * An offline store device (spec.md "Offline device"): its `X-Device-Id`, a hybrid logical clock
 * (`<physical ms, 15 digits>-<counter, 5 digits>-<node>`) that never goes backwards, UUIDv7 operation ids, and the `push` and
 * `pull` calls of S09. A replay sends the same `opId` again; the server answers `replayed` and does nothing twice.
 */
export class DeviceClient {
  private logical = 0;
  private lastPhysical = 0;
  /** Where this device's pull stands. */
  cursor: string | undefined;

  constructor(
    private readonly shop: FixtureShop,
    readonly deviceId: string,
  ) {}

  /** The next HLC of this device; `clockSkewMs` is how far the stack's clock is ahead of this machine's. */
  hlc(clockSkewMs = 0): string {
    const now = Date.now() + clockSkewMs;
    if (now > this.lastPhysical) {
      this.lastPhysical = now;
      this.logical = 0;
    } else this.logical += 1;
    return `${String(this.lastPhysical).padStart(15, '0')}-${String(this.logical).padStart(5, '0')}-${this.deviceId}`;
  }

  /** A sale of `quantity` units of a product (`stock.adjust` with a negative delta, reason `sold`). */
  sale(
    productId: string,
    quantity: number,
    opId = uuidv7(),
    clockSkewMs = 0,
  ): SyncOp {
    return {
      type: 'stock.adjust',
      opId,
      hlc: this.hlc(clockSkewMs),
      productId,
      delta: -quantity,
      reason: 'sold',
    };
  }

  /** `POST /shops/:id/sync/push`. */
  async push(ops: SyncOp[]) {
    return this.shop.owner.post<SyncPushResponse>(
      `/api/shops/${this.shop.shopId}/sync/push`,
      {
        body: { ops },
        headers: { 'x-device-id': this.deviceId },
        schema: syncPushResponseSchema,
      },
    );
  }

  /** `GET /shops/:id/sync/pull?cursor=`; advances this device's cursor when the call succeeds. */
  async pull(limit = 200) {
    const reply = await this.shop.owner.get<SyncPullResponse>(
      `/api/shops/${this.shop.shopId}/sync/pull`,
      {
        query: { cursor: this.cursor, limit },
        headers: { 'x-device-id': this.deviceId },
        schema: syncPullResponseSchema,
      },
    );
    if (reply.status === 200) this.cursor = reply.body.cursor;
    return reply;
  }
}
