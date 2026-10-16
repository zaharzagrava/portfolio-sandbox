import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  DIGITAL,
  ENTITLEMENTS,
  type DigitalRepository,
  type EntitlementRecord,
  type EntitlementRepository,
  type NewEntitlement,
} from '../domain/ports';
import { assetMetrics } from './asset-metrics';
import {
  DigitalProductUnlinked,
  EntitlementGranted,
  EntitlementRevoked,
} from './events/asset-events';

type OrderPaid = z.infer<(typeof orderEventSchemas)['order.paid']>;
type OrderRefunded = z.infer<(typeof orderEventSchemas)['order.refunded']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entitlements from order events (S31 FR-040, FR-041, D8). The order's own data is never read: the paid and refunded
 * events fill this domain's store, so a download never waits for the order service. Everything here is idempotent: the
 * entitlement is unique per `(order, product)`, a refund is recorded per order, and both handlers of one order take the
 * same lock so a refund and a late paid event can never leave an active entitlement behind.
 */
@Injectable()
export class EntitlementService {
  constructor(
    @Inject(DIGITAL) private readonly digital: DigitalRepository,
    @Inject(ENTITLEMENTS) private readonly entitlements: EntitlementRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /** `order.paid`: one entitlement per product of the order whose link belongs to the line's own shop. */
  async onPaid(order: OrderPaid): Promise<void> {
    const now = this.clock.now();
    const lines = order.lines.filter(
      (line) =>
        line.shopId !== null &&
        UUID.test(line.productId) &&
        UUID.test(order.orderId),
    );
    const links = new Map(
      (
        await this.digital.linksFor([...new Set(lines.map((l) => l.productId))])
      ).map((link) => [link.productId, link]),
    );
    const wanted = new Map<string, NewEntitlement>();
    for (const line of lines) {
      const link = links.get(line.productId);
      // a line never grants a file of another shop (FR-040)
      if (!link || link.shopId !== line.shopId) continue;
      if (!wanted.has(line.productId))
        wanted.set(line.productId, {
          id: uuidv7(),
          productId: line.productId,
          shopId: link.shopId,
          assetId: link.assetId,
          title: line.title,
        });
    }
    if (wanted.size === 0) {
      assetMetrics.entitlements.add(1, { event: 'ignored' });
      return;
    }
    const created = await this.transactions.run(async () => {
      await this.entitlements.lockOrder(order.orderId);
      if (await this.entitlements.hasRevocation(order.orderId)) return [];
      const rows = await this.entitlements.insertMany({
        orderId: order.orderId,
        buyerId: order.userId,
        entitlements: [...wanted.values()],
        now,
      });
      await this.outbox.append(
        rows.map((e) =>
          EntitlementGranted.create(e.id, 1, {
            entitlementId: e.id,
            orderId: e.orderId,
            productId: e.productId,
            shopId: e.shopId,
            buyerId: e.buyerId,
            title: e.title,
            grantedAt: e.grantedAt.toISOString(),
          }),
        ),
      );
      return rows;
    });
    if (created.length === 0) {
      assetMetrics.entitlements.add(1, { event: 'ignored' });
      return;
    }
    assetMetrics.entitlements.add(created.length, { event: 'granted' });
    this.lag('granted', order.paidAt, now);
  }

  /** `order.refunded`: every entitlement of the order ends; the refund is remembered for a late paid event. */
  async onRefunded(order: OrderRefunded, occurredAt: Date): Promise<void> {
    if (!UUID.test(order.orderId)) return;
    const now = this.clock.now();
    const revoked = await this.transactions.run(async () => {
      await this.entitlements.lockOrder(order.orderId);
      await this.entitlements.recordRevocation({
        orderId: order.orderId,
        orderVersion: order.orderVersion,
        now,
      });
      const rows = await this.entitlements.revokeOfOrder(
        order.orderId,
        'refunded',
        now,
      );
      await this.announceRevoked(rows, 'refunded', now);
      return rows;
    });
    assetMetrics.entitlements.add(revoked.length || 1, {
      event: revoked.length > 0 ? 'revoked' : 'ignored',
    });
    if (revoked.length > 0) this.lag('revoked', occurredAt.toISOString(), now);
  }

  /** `catalog.product_deleted`: the link goes, entitlements stay and keep working. */
  async onProductDeleted(productId: string, shopId: string): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const link = await this.digital.lockLink(productId);
      if (!link || link.shopId !== shopId) return;
      await this.digital.deleteLink(productId);
      await this.outbox.append(
        DigitalProductUnlinked.create(productId, now.getTime(), {
          productId,
          shopId,
          assetId: link.assetId,
          unlinkedAt: now.toISOString(),
        }),
      );
    });
  }

  /** Entitlements of a deleted shop end with reason `shop_deleted`; one event each. */
  async revokeShop(shopId: string): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const rows = await this.entitlements.revokeOfShop(
        shopId,
        'shop_deleted',
        now,
      );
      await this.announceRevoked(rows, 'shop_deleted', now);
      if (rows.length > 0)
        assetMetrics.entitlements.add(rows.length, { event: 'revoked' });
    });
  }

  private async announceRevoked(
    rows: EntitlementRecord[],
    reason: 'refunded' | 'shop_deleted',
    now: Date,
  ): Promise<void> {
    await this.outbox.append(
      rows.map((e) =>
        EntitlementRevoked.create(e.id, 2, {
          entitlementId: e.id,
          orderId: e.orderId,
          productId: e.productId,
          shopId: e.shopId,
          buyerId: e.buyerId,
          reason,
          revokedAt: now.toISOString(),
        }),
      ),
    );
  }

  /** Event-to-effect lag (FR-052); a time that does not parse records nothing. */
  private lag(event: 'granted' | 'revoked', since: string, now: Date): void {
    const start = Date.parse(since);
    if (Number.isFinite(start))
      assetMetrics.entitlementLag.record(
        Math.max(now.getTime() - start, 0) / 1000,
        { event },
      );
  }
}
