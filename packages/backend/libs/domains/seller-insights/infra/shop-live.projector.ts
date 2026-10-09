import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid, OrderReserved } from '@app/domains/orders';

export const DASH_ACTIVE = 'dash:active';
export const dashBucketKey = (shopId: string, second: number) =>
  `dash:{${shopId}}:${second}`;
const BUCKET_TTL_SEC = 180;

/**
 * Rolling per-second counters for the live launch dashboard: checkouts
 * started, orders, units, revenue per shop per second (Redis hashes, 3-minute
 * TTL). `dash:active` remembers which shops had activity so the ticker only
 * looks at those. Replays are skipped via a short-lived per-event marker
 * (the counters are a live view; the exact numbers live in ClickHouse).
 */
@Injectable()
export class ShopLiveProjector implements Projector {
  readonly name = 'shop-live-dashboard';
  readonly topics = [OrderPaid.topic];
  // A short-lived per-event `SET NX` marker skips replays (the counters are a live view).
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }, { event: OrderReserved }];

  constructor(private readonly redis: RedisService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      if (
        !(await this.redis.client.set(
          `dash:seen:${event.eventId}`,
          '1',
          'EX',
          600,
          'NX',
        ))
      )
        continue;
      const second = Math.floor(Date.parse(event.occurredAt) / 1000);
      const increments = new Map<string, Record<string, number>>();
      const add = (shopId: string, field: string, n: number) => {
        const fields = increments.get(shopId) ?? {};
        fields[field] = (fields[field] ?? 0) + n;
        increments.set(shopId, fields);
      };

      const reserved = OrderReserved.match(event);
      if (reserved)
        for (const shopId of new Set(
          reserved.payload.shopIds.filter((s): s is string => !!s),
        ))
          add(shopId, 'checkouts', 1);
      const paid = OrderPaid.match(event);
      if (paid) {
        for (const line of paid.payload.lines) {
          if (!line.shopId) continue;
          add(line.shopId, 'units', line.quantity);
          add(line.shopId, 'revenue', line.price * line.quantity);
        }
        for (const shopId of new Set(
          paid.payload.lines
            .map((l) => l.shopId)
            .filter((s): s is string => !!s),
        ))
          add(shopId, 'orders', 1);
      }

      const pipeline = this.redis.client.pipeline();
      for (const [shopId, fields] of increments) {
        const key = dashBucketKey(shopId, second);
        for (const [field, n] of Object.entries(fields))
          pipeline.hincrby(key, field, n);
        pipeline.expire(key, BUCKET_TTL_SEC);
        pipeline.zadd(DASH_ACTIVE, second, shopId);
      }
      await pipeline.exec();
    }
  }
}
