import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid } from '@app/domains/orders';
import { APPLY_SALE } from './leaderboard.lua';
import {
  ALL,
  boardKey,
  boardsKey,
  categoryBoard,
  revenueKey,
  seenKey,
} from './leaderboard-keys';
import { Period, periodOf, PeriodKind, TIE_BITS } from '../domain/periods';

const KEEP_AFTER_PERIOD_SEC = 35 * 86_400;

/**
 * orders.events → weekly + monthly boards (overall and per category).
 * Idempotent per (period, order) inside the script; the event's occurredAt
 * decides the period, so a late event counts towards the week it happened in.
 */
@Injectable()
export class LeaderboardProjector implements Projector {
  readonly name = 'leaderboards';
  readonly topics = [OrderPaid.topic];
  // The Lua script applies a sale once per (period, order).
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];

  constructor(
    private readonly redis: RedisService,
    @InjectModel(Product) private readonly products: typeof Product,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const paid = events
      .map((e) => OrderPaid.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    if (paid.length === 0) return;
    const productIds = [
      ...new Set(paid.flatMap((e) => e.payload.lines.map((l) => l.productId))),
    ];
    const categories = new Map(
      (
        await this.products.findAll({
          where: { id: { [Op.in]: productIds } },
          attributes: ['id', 'category'],
          raw: true,
        })
      ).map((p) => [p.id, p.category]),
    );

    for (const event of paid) {
      const at = new Date(event.occurredAt);
      for (const kind of ['week', 'month'] as PeriodKind[]) {
        await this.apply(
          event.aggregateId,
          at,
          periodOf(kind, at),
          event.payload.lines,
          categories,
        );
      }
    }
  }

  private async apply(
    orderId: string,
    at: Date,
    period: Period,
    lines: {
      productId: string;
      shopId: string | null;
      quantity: number;
      unitPriceMinor: number;
    }[],
    categories: Map<string, string>,
  ) {
    // Aggregate per (board, shop) first: a 3-line order from one shop is one update per board.
    const updates = new Map<
      string,
      { board: string; shopId: string; amount: number }
    >();
    for (const line of lines) {
      if (!line.shopId) continue;
      const amount = line.unitPriceMinor * line.quantity;
      const category = categories.get(line.productId);
      for (const board of [
        ALL,
        ...(category ? [categoryBoard(category)] : []),
      ]) {
        const key = `${board}|${line.shopId}`;
        const current = updates.get(key) ?? {
          board,
          shopId: line.shopId,
          amount: 0,
        };
        current.amount += amount;
        updates.set(key, current);
      }
    }
    if (updates.size === 0) return;

    const tie = Math.min(
      Math.max(
        0,
        Math.floor((period.end.getTime() - at.getTime()) / period.unitMs),
      ),
      TIE_BITS - 1,
    );
    const ttl =
      Math.ceil((period.end.getTime() - Date.now()) / 1000) +
      KEEP_AFTER_PERIOD_SEC;
    const keys = [seenKey(period.id), boardsKey(period.id)];
    const args: (string | number)[] = [orderId, Math.max(ttl, 60), TIE_BITS];
    for (const u of updates.values()) {
      keys.push(boardKey(period.id, u.board), revenueKey(period.id, u.board));
      args.push(u.board, u.shopId, u.amount, tie);
    }
    await this.redis.client.eval(APPLY_SALE, keys.length, ...keys, ...args);
  }
}
