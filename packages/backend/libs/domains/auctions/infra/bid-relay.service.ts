import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { hostname } from 'node:os';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { AuctionLeaderChanged } from '../application/events/auction-events';
import {
  ACTIVE_AUCTIONS_KEY,
  BID_RELAY_GROUP,
  bidStreamKey,
} from '../application/auction.service';

const BATCH = 500;

/**
 * Drains the bid stream into Postgres (CQRS write-behind, D26): XREADGROUP a
 * batch → one multi-row INSERT of bids (ON CONFLICT DO NOTHING: retries after
 * a crash re-deliver pending entries, the unique (auction, version, createdAt)
 * index makes that harmless) → version-guarded UPDATE of each touched auction
 * row with its latest state → XACK. At 2k bids/s on a hot auction Postgres sees
 * ~4 batched statements per second instead of 2k row-locking updates.
 */
@Injectable()
export class BidRelay implements OnApplicationBootstrap {
  private readonly logger = new Logger(BidRelay.name);
  private running = false;
  private loopDone?: Promise<void>;
  private readonly consumer = `${hostname()}-${process.pid}`;

  constructor(
    private readonly redis: RedisService,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly events: OutboxService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'auctions.bid-relay.stop',
      order: 10,
      run: () => this.stop(),
    });
  }

  onApplicationBootstrap() {
    this.running = true;
    this.loopDone = this.loop();
  }

  /**
   * One stream per auction (cluster-safe, see bidStreamKey). Each pass reads
   * every active auction's stream without blocking; a stream's own pending
   * entries (delivered but not acked before a crash) are drained first.
   */
  private async loop() {
    const drainedPending = new Set<string>();
    while (this.running) {
      let moved = 0;
      try {
        for (const auctionId of await this.redis.client.smembers(
          ACTIVE_AUCTIONS_KEY,
        )) {
          const stream = bidStreamKey(auctionId);
          const cursor = drainedPending.has(stream) ? '>' : '0';
          const res = (await this.redis.client.xreadgroup(
            'GROUP',
            BID_RELAY_GROUP,
            this.consumer,
            'COUNT',
            BATCH,
            'STREAMS',
            stream,
            cursor,
          )) as [string, [string, string[]][]][] | null;
          const entries = (res?.[0]?.[1] ?? []).filter(
            ([, fields]) => fields !== null,
          );
          if (cursor === '0' && entries.length === 0)
            drainedPending.add(stream);
          if (entries.length) {
            await this.flush(stream, entries);
            moved += entries.length;
          }
        }
      } catch (error) {
        this.logger.error(`bid relay: ${(error as Error).message}`);
      }
      if (moved === 0) await new Promise((r) => setTimeout(r, 100));
    }
  }

  async flush(stream: string, entries: [string, string[]][]): Promise<void> {
    const bids = entries.map(([id, fields]) => {
      const f: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
      return { streamId: id, ...f };
    }) as ({ streamId: string } & Record<
      | 'auctionId'
      | 'userId'
      | 'maxAmount'
      | 'outcome'
      | 'price'
      | 'leader'
      | 'endsAt'
      | 'version'
      | 'at',
      string
    >)[];

    await this.transactions.run(async (transaction) => {
      await this.sequelize.query(
        `INSERT INTO "Bid" ("auctionId", "userId", "maxAmount", outcome, "priceAfter", version, "createdAt")
         SELECT * FROM unnest(CAST(:auctionIds AS uuid[]), CAST(:userIds AS uuid[]), CAST(:maxes AS bigint[]), CAST(:outcomes AS text[]),
                              CAST(:prices AS bigint[]), CAST(:versions AS int[]), CAST(:ats AS timestamptz[]))
         ON CONFLICT DO NOTHING`,
        {
          replacements: {
            auctionIds: pgArray(bids.map((b) => b.auctionId)),
            userIds: pgArray(bids.map((b) => b.userId)),
            maxes: pgArray(bids.map((b) => b.maxAmount)),
            outcomes: pgArray(bids.map((b) => b.outcome)),
            prices: pgArray(bids.map((b) => b.price)),
            versions: pgArray(bids.map((b) => b.version)),
            ats: pgArray(bids.map((b) => new Date(Number(b.at)).toISOString())),
          },
          transaction,
        },
      );

      const latest = new Map<string, (typeof bids)[number]>();
      for (const b of bids)
        if (
          !latest.has(b.auctionId) ||
          Number(b.version) > Number(latest.get(b.auctionId)!.version)
        )
          latest.set(b.auctionId, b);
      for (const b of latest.values()) {
        // `prev` CTE: the row is locked and its OLD leader read in the same statement.
        const [changed] = (await this.sequelize.query(
          `WITH prev AS (SELECT id, "leaderId" FROM "Auction" WHERE id = :auctionId FOR UPDATE)
           UPDATE "Auction" a SET "currentPrice" = :price, "leaderId" = NULLIF(:leader, '')::uuid, "endsAt" = to_timestamp(:endsAt / 1000.0),
                  version = :version, "bidCount" = a."bidCount" + :count, "updatedAt" = now()
           FROM prev
           WHERE a.id = prev.id AND a.version < :version
           RETURNING prev."leaderId" AS "previousLeaderId", a."leaderId" AS "leaderId", a.version`,
          {
            replacements: {
              price: b.price,
              leader: b.leader,
              endsAt: Number(b.endsAt),
              version: Number(b.version),
              count: bids.filter((x) => x.auctionId === b.auctionId).length,
              auctionId: b.auctionId,
            },
            transaction,
            type: QueryTypes.SELECT,
          },
        )) as {
          previousLeaderId: string | null;
          leaderId: string | null;
          version: number;
        }[];

        // One "outbid" per relay batch per auction: leaders who led for only a few ms inside the
        // same batch aren't notified - they were outbid before any notification could matter.
        if (
          changed?.previousLeaderId &&
          changed.leaderId &&
          changed.previousLeaderId !== changed.leaderId
        ) {
          await this.events.append(
            AuctionLeaderChanged.create(b.auctionId, changed.version, {
              previousLeaderId: changed.previousLeaderId,
              leaderId: changed.leaderId,
              price: Number(b.price),
            }),
            transaction,
          );
        }
      }
    });

    await this.redis.client.xack(
      stream,
      BID_RELAY_GROUP,
      ...entries.map(([id]) => id),
    );
  }

  async stop() {
    this.running = false;
    await this.loopDone;
  }
}

const pgArray = (values: string[]) =>
  `{${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')}}`;
