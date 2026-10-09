import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import Auction from '../infra/models/auction.model';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { MembershipService } from '@app/domains/tenancy';
import { TransactionRunner } from '@app/infrastructure/context';
import { PLACE_BID } from '../infra/place-bid.lua';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auctions.close': { auctionId: string };
  }
}

export const ANTI_SNIPE_MS = 2 * 60_000;
export const EXTEND_MS = 2 * 60_000;
export const MAX_EXTENSION_MS = 60 * 60_000;
/** Per-auction bid log with the SAME hash tag as the state hash → both keys in one cluster slot, so the Lua script may touch both. */
export const bidStreamKey = (auctionId: string) =>
  `auction:{${auctionId}}:bids`;
export const ACTIVE_AUCTIONS_KEY = 'auction:active';
export const BID_RELAY_GROUP = 'bid-relay';

export const stateKey = (auctionId: string) => `auction:{${auctionId}}`;

export type BidOutcome =
  | 'leading'
  | 'outbid'
  | 'raised'
  | 'ignored'
  | 'too_low'
  | 'closed'
  | 'unknown';

export interface AuctionView {
  id: string;
  status: string;
  price: number;
  leaderId: string | null;
  endsAt: number;
  version: number;
  /** Clients sync their countdown to the server clock, never their own (lesson 06/02 §6). */
  serverTime: number;
}

@Injectable()
export class AuctionService {
  constructor(
    @InjectModel(Auction) private readonly auctionModel: typeof Auction,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    private readonly jobs: JobsService,
    private readonly memberships: MembershipService,
    private readonly tx: TransactionRunner,
  ) {}

  async create(
    shopId: string,
    input: {
      productId: string;
      title: string;
      startingPrice: number;
      minIncrement: number;
      reservePrice?: number;
      startsAt: Date;
      endsAt: Date;
    },
  ) {
    return this.tx.run(async (transaction) => {
      // The auctioned unit leaves regular stock for the duration (returned if unsold).
      const [rows] = await this.auctionModel.sequelize!.query(
        `UPDATE "Product" SET quantity = quantity - 1, version = version + 1 WHERE id = :id AND "shopId" = :shopId AND quantity >= 1 RETURNING id`,
        { replacements: { id: input.productId, shopId }, transaction },
      );
      if (rows.length === 0)
        throw new UnprocessableEntityException(
          'Product not in stock in this shop',
        );

      const auction = await this.auctionModel.create({
        ...input,
        shopId,
        originalEndsAt: input.endsAt,
        currentPrice: input.startingPrice,
      });
      await this.redis.client.hset(stateKey(auction.id), {
        status: 'OPEN',
        price: input.startingPrice,
        leader: '',
        leaderMax: 0,
        inc: input.minIncrement,
        endsAt: input.endsAt.getTime(),
        maxEndsAt: input.endsAt.getTime() + MAX_EXTENSION_MS,
        shopId,
        version: 0,
      });
      await this.redis.client
        .xgroup(
          'CREATE',
          bidStreamKey(auction.id),
          BID_RELAY_GROUP,
          '0',
          'MKSTREAM',
        )
        .catch(() => undefined);
      await this.redis.client.sadd(ACTIVE_AUCTIONS_KEY, auction.id);
      // Transactional enqueue: the close job exists iff the auction does (SD-29).
      await this.jobs.enqueue(
        'auctions.close',
        { auctionId: auction.id },
        {
          runAt: input.endsAt,
          idempotencyKey: `auction-close:${auction.id}:${input.endsAt.getTime()}`,
        },
      );
      return auction;
    });
  }

  async placeBid(
    auctionId: string,
    userId: string,
    maxAmount: number,
  ): Promise<{ outcome: BidOutcome } & AuctionView> {
    const shopId = await this.redis.client.hget(stateKey(auctionId), 'shopId');
    if (!shopId) throw new NotFoundException('Auction not found');
    // Shill-bidding guard: the seller's own team can't bid the price up.
    if (await this.memberships.role(userId, shopId))
      throw new ForbiddenException("Members of the selling shop can't bid");

    const now = Date.now();
    const maxEndsAt = Number(
      await this.redis.client.hget(stateKey(auctionId), 'maxEndsAt'),
    );
    const [outcome, price, leader, endsAt, version] =
      (await this.redis.client.eval(
        PLACE_BID,
        2,
        stateKey(auctionId),
        bidStreamKey(auctionId),
        userId,
        maxAmount,
        now,
        ANTI_SNIPE_MS,
        EXTEND_MS,
        maxEndsAt,
        auctionId,
      )) as [BidOutcome, number, string, number, number];

    if (outcome === 'unknown') throw new NotFoundException('Auction not found');
    if (outcome === 'closed')
      throw new UnprocessableEntityException('Auction is closed');

    const view: AuctionView = {
      id: auctionId,
      status: 'OPEN',
      price: Number(price),
      leaderId: leader || null,
      endsAt: Number(endsAt),
      version: Number(version),
      serverTime: now,
    };
    if (outcome === 'leading' || outcome === 'outbid') {
      await this.realtime.publish(`auction:${auctionId}`, 'price', {
        price: view.price,
        leaderId: view.leaderId,
        endsAt: view.endsAt,
        version: view.version,
      });
    }
    return { outcome, ...view };
  }

  async view(auctionId: string): Promise<AuctionView> {
    const s = await this.redis.client.hmget(
      stateKey(auctionId),
      'status',
      'price',
      'leader',
      'endsAt',
      'version',
    );
    if (!s[0]) {
      const a = await this.auctionModel.findByPk(auctionId, { raw: true });
      if (!a) throw new NotFoundException('Auction not found');
      return {
        id: a.id,
        status: a.status,
        price: Number(a.finalPrice ?? a.currentPrice),
        leaderId: a.winnerId ?? a.leaderId,
        endsAt: new Date(a.endsAt).getTime(),
        version: a.version,
        serverTime: Date.now(),
      };
    }
    return {
      id: auctionId,
      status: s[0],
      price: Number(s[1]),
      leaderId: s[2] || null,
      endsAt: Number(s[3]),
      version: Number(s[4]),
      serverTime: Date.now(),
    };
  }
}
