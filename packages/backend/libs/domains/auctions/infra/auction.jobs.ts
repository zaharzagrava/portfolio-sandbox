import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import Auction from './models/auction.model';
import { BisOrderModel as BisOrder, OrderService } from '@app/domains/orders';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { CLOSE_AUCTION } from './place-bid.lua';
import { ACTIVE_AUCTIONS_KEY, stateKey } from '../application/auction.service';
import { AuctionClosed } from '../application/events/auction-events';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auctions.second-chance': { auctionId: string };
  }
}

declareJobType({
  name: 'auctions.second-chance',
  contract: z.object({ auctionId: z.string() }),
});

/** Winners get 48 h to pay before the runner-up gets a second-chance offer. */
export const WINNER_PAYMENT_WINDOW_MS = 48 * 3_600_000;

@Injectable()
export class AuctionJobs {
  private readonly logger = new Logger(AuctionJobs.name);

  constructor(
    @InjectModel(Auction) private readonly auctionModel: typeof Auction,
    @InjectModel(BisOrder) private readonly orderModel: typeof BisOrder,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    private readonly jobs: JobsService,
    private readonly events: OutboxService,
    private readonly orders: OrderService,
  ) {}

  /**
   * Exactly-once close (lesson 10/09 #29): Redis freezes bidding atomically;
   * the Postgres transition is guarded by `status = 'OPEN'`, so a duplicated
   * or retried job can't close twice. If anti-sniping moved the end, the job
   * re-schedules itself at the new end (new idempotency key per end time).
   */
  @JobHandler('auctions.close', { concurrency: 20 })
  async close({ auctionId }: { auctionId: string }): Promise<void> {
    const result = (await this.redis.client.eval(
      CLOSE_AUCTION,
      1,
      stateKey(auctionId),
      Date.now(),
    )) as string[];
    if (result[0] === 'not_yet') {
      const endsAt = Number(result[1]);
      await this.jobs.enqueue(
        'auctions.close',
        { auctionId },
        {
          runAt: new Date(endsAt),
          idempotencyKey: `auction-close:${auctionId}:${endsAt}`,
        },
      );
      return;
    }
    if (result[0] === 'unknown') return;

    const [price, leader] = [Number(result[1]), result[2] || null];
    const auction = await this.auctionModel.findByPk(auctionId);
    if (!auction || auction.status !== 'OPEN') return;
    const reserveMet =
      !!leader &&
      (auction.reservePrice === null || price >= Number(auction.reservePrice));

    await this.transactions.run(async (transaction) => {
      const [updated] = await this.auctionModel.update(
        {
          status: reserveMet ? 'CLOSED' : 'UNSOLD',
          winnerId: reserveMet ? leader : null,
          finalPrice: reserveMet ? price : null,
          currentPrice: price,
        },
        { where: { id: auctionId, status: 'OPEN' }, transaction },
      );
      if (updated === 0) return;

      if (reserveMet) {
        await this.createWinnerOrder(auction, leader, price, transaction);
      } else {
        await this.sequelize.query(
          `UPDATE "Product" SET quantity = quantity + 1, version = version + 1 WHERE id = :id`,
          { replacements: { id: auction.productId }, transaction },
        );
      }
      await this.events.append(
        AuctionClosed.create(auctionId, auction.version + 1, {
          shopId: auction.shopId,
          productId: auction.productId,
          winnerId: reserveMet ? leader : null,
          finalPrice: reserveMet ? price : null,
          reserveMet,
        }),
        transaction,
      );
    });

    await this.redis.client.expire(stateKey(auctionId), 86_400);
    await this.realtime.publish(`auction:${auctionId}`, 'closed', {
      winnerId: reserveMet ? leader : null,
      finalPrice: reserveMet ? price : null,
    });
    // Keep relaying any tail of the bid log for a while, then stop scanning this auction.
    setTimeout(
      () => void this.redis.client.srem(ACTIVE_AUCTIONS_KEY, auctionId),
      60_000,
    ).unref();
  }

  /** Winner didn't pay → offer the item to the runner-up at their own maximum bid (eBay "second chance offer"). */
  @JobHandler('auctions.second-chance', { concurrency: 5 })
  async secondChance({ auctionId }: { auctionId: string }): Promise<void> {
    const auction = await this.auctionModel.findByPk(auctionId);
    if (!auction || auction.status !== 'CLOSED') return;
    const winnerOrder = await this.orderModel.findOne({
      where: { idempotencyKey: `auction:${auctionId}` },
    });
    if (winnerOrder?.status !== 'CANCELLED') return;

    const [runnerUp] = await this.sequelize.query<{
      userId: string;
      max: string;
    }>(
      `SELECT "userId", max("maxAmount") AS max FROM "Bid" WHERE "auctionId" = :auctionId AND "userId" <> :winner
       GROUP BY "userId" ORDER BY max DESC LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { auctionId, winner: auction.winnerId },
      },
    );
    await this.transactions.run(async (transaction) => {
      if (!runnerUp) {
        await this.sequelize.query(
          `UPDATE "Product" SET quantity = quantity + 1, version = version + 1 WHERE id = :id`,
          { replacements: { id: auction.productId }, transaction },
        );
        return;
      }
      await this.createWinnerOrder(
        auction,
        runnerUp.userId,
        Number(runnerUp.max),
        transaction,
        'second-chance',
      );
    });
  }

  private async createWinnerOrder(
    auction: Auction,
    userId: string,
    price: number,
    transaction: import('sequelize').Transaction,
    tag = 'winner',
  ) {
    const reservedUntil = new Date(Date.now() + WINNER_PAYMENT_WINDOW_MS);
    const key =
      tag === 'winner'
        ? `auction:${auction.id}`
        : `auction:${auction.id}:${tag}`;
    const order = await this.orderModel.create(
      {
        userId,
        idempotencyKey: key,
        total: price,
        reservedUntil,
        status: 'PENDING',
      },
      { transaction },
    );
    await this.sequelize.query(
      `INSERT INTO "BisOrderItem" (id, "bisOrderId", "productId", quantity, "priceAtPurchase", "shopId", "createdAt", "updatedAt")
       VALUES (uuidv7(), :orderId, :productId, 1, :price, :shopId, now(), now());
       INSERT INTO "ShopOrder" ("bisOrderId", "shopId", subtotal) VALUES (:orderId, :shopId, :price);`,
      {
        replacements: {
          orderId: order.id,
          productId: auction.productId,
          price,
          shopId: auction.shopId,
        },
        transaction,
      },
    );
    await this.orders.transition(
      order.id,
      { type: 'reserve' },
      `auction ${tag}`,
      transaction,
    );
    await this.jobs.enqueue(
      'orders.expire-reservation',
      { orderId: order.id },
      { runAt: reservedUntil, idempotencyKey: `order-expire:${order.id}` },
    );
    if (tag === 'winner') {
      await this.jobs.enqueue(
        'auctions.second-chance',
        { auctionId: auction.id },
        {
          runAt: new Date(reservedUntil.getTime() + 60_000),
          idempotencyKey: `auction-second-chance:${auction.id}`,
        },
      );
    }
  }
}
