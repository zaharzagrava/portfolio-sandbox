import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { z } from 'zod';
import { TransactionRunner } from '@app/infrastructure/context';
import { AuctionExistsForProductError } from '../domain/auction-errors';
import { decodeCursor, encodeCursor } from '../domain/auction-cursor';
import type {
  AuctionRecord,
  AuctionRepository,
  BidPatch,
  NewAuction,
  Page,
  TransitionPatch,
  TransitionRequest,
} from '../domain/auction-ports';
import {
  AUCTION_STATUSES,
  LIVE_STATUSES,
  STATUS_REASONS,
  type AuctionStatus,
} from '../domain/auction-state';
import { safeNumber } from './safe-number';

const UNIQUE_VIOLATION = '23505';

const COLUMNS = `"id", "shopId", "productId", "title", "currency", "startingPriceMinor", "minIncrementMinor",
  "reservePriceMinor", "startsAt", "endsAt", "originalEndsAt", "status", "statusReason", "priceMinor", "leaderId",
  "leaderMaxMinor", "bidCount", "version", "unitHeld", "holdRequestedAt", "returnPending", "winnerId",
  "finalPriceMinor", "firstOrderId", "winnerOrderId", "settlementOrderVersion", "offerExpiresAt", "closedAt",
  "createdAt", "updatedAt"`;

/** BIGINT arrives as a string; a value outside the safe range is a data error, never rounded (III.8). */
const minor = z.union([z.string(), z.number()]).transform(safeNumber);
const nullableMinor = minor.nullable();

/** A row read back: validated once so a drifted value fails here, not in the lifecycle. */
const rowSchema = z.object({
  id: z.string().uuid(),
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
  title: z.string(),
  currency: z.string().length(3),
  startingPriceMinor: minor,
  minIncrementMinor: minor,
  reservePriceMinor: nullableMinor,
  startsAt: z.date(),
  endsAt: z.date(),
  originalEndsAt: z.date(),
  status: z.enum(AUCTION_STATUSES),
  statusReason: z.enum(STATUS_REASONS).nullable(),
  priceMinor: minor,
  leaderId: z.string().uuid().nullable(),
  leaderMaxMinor: nullableMinor,
  bidCount: z.number().int(),
  version: z.number().int(),
  unitHeld: z.boolean(),
  holdRequestedAt: z.date(),
  returnPending: z.boolean(),
  winnerId: z.string().uuid().nullable(),
  finalPriceMinor: nullableMinor,
  firstOrderId: z.string().uuid().nullable(),
  winnerOrderId: z.string().uuid().nullable(),
  settlementOrderVersion: z.number().int(),
  offerExpiresAt: z.date().nullable(),
  closedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const toRecord = (row: unknown): AuctionRecord => rowSchema.parse(row);

const pgCode = (error: unknown): string | undefined => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return e?.parent?.code ?? e?.original?.code;
};

/** The columns a transition may set, with their SQL names. */
const PATCH_COLUMNS: Record<keyof TransitionPatch, string> = {
  winnerId: 'winnerId',
  finalPriceMinor: 'finalPriceMinor',
  closedAt: 'closedAt',
  returnPending: 'returnPending',
  offerExpiresAt: 'offerExpiresAt',
  winnerOrderId: 'winnerOrderId',
};

/** `Auction` and `AuctionHistory` (S21 data-model §1, §3). Statements join the active transaction (CLS). */
@Injectable()
export class SequelizeAuctionRepository implements AuctionRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
  ) {}

  private select<T extends object>(
    sql: string,
    replacements: object = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  private async history(
    auction: AuctionRecord,
    from: AuctionStatus | null,
    reason: string | null,
    actor: string,
    at: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "AuctionHistory" ("auctionId", "fromStatus", "toStatus", "reason", "auctionVersion", "at", "actor")
       VALUES (:id, :from, :to, :reason, :version, :at, :actor)`,
      {
        replacements: {
          id: auction.id,
          from,
          to: auction.status,
          reason,
          version: auction.version,
          at,
          actor,
        },
      },
    );
  }

  async create(input: NewAuction): Promise<AuctionRecord> {
    try {
      return await this.runner.run(async () => {
        const [row] = await this.select(
          `INSERT INTO "Auction" ("id", "shopId", "productId", "title", "currency", "startingPriceMinor",
             "minIncrementMinor", "reservePriceMinor", "startsAt", "endsAt", "originalEndsAt", "status", "priceMinor",
             "version", "unitHeld", "holdRequestedAt", "createdAt", "updatedAt")
           VALUES (:id, :shopId, :productId, :title, :currency, :startingPriceMinor, :minIncrementMinor,
             :reservePriceMinor, :startsAt, :endsAt, :endsAt, 'SCHEDULED', :startingPriceMinor, 1, false, :createdAt,
             :createdAt, :createdAt)
           RETURNING ${COLUMNS}`,
          input,
        );
        const record = toRecord(row);
        await this.history(record, null, null, input.actor, input.createdAt);
        return record;
      });
    } catch (error) {
      if (pgCode(error) === UNIQUE_VIOLATION)
        throw new AuctionExistsForProductError();
      throw error;
    }
  }

  async lockById(id: string): Promise<AuctionRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Auction" WHERE "id" = :id FOR UPDATE`,
      { id },
    );
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<AuctionRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Auction" WHERE "id" = :id`,
      { id },
    );
    return row ? toRecord(row) : null;
  }

  async findForShop(shopId: string, id: string): Promise<AuctionRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Auction" WHERE "shopId" = :shopId AND "id" = :id`,
      { shopId, id },
    );
    return row ? toRecord(row) : null;
  }

  async listForShop(
    shopId: string,
    query: { status?: AuctionStatus; limit: number; cursor?: string },
  ): Promise<Page<AuctionRecord>> {
    const scope = `shop:${shopId}`;
    const where = ['"shopId" = :shopId'];
    const replacements: Record<string, unknown> = {
      shopId,
      limit: query.limit + 1,
    };
    if (query.status) {
      where.push('"status" = :status');
      replacements.status = query.status;
    }
    if (query.cursor) {
      const [startsAt, id] = decodeCursor(scope, query.cursor, 2);
      if (Number.isNaN(Date.parse(startsAt)) || !/^[0-9a-f-]{36}$/i.test(id))
        decodeCursor('', '', 0); // throws InvalidCursorError
      where.push(
        '("startsAt", "id") < (:afterStartsAt::timestamptz, :afterId::uuid)',
      );
      replacements.afterStartsAt = startsAt;
      replacements.afterId = id;
    }
    const rows = (
      await this.select(
        `SELECT ${COLUMNS} FROM "Auction" WHERE ${where.join(' AND ')}
         ORDER BY "startsAt" DESC, "id" DESC LIMIT :limit`,
        replacements,
      )
    ).map(toRecord);
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(scope, [last.startsAt.toISOString(), last.id])
          : null,
    };
  }

  async listPublicByProducts(
    productIds: string[],
    now: Date,
    closedWithinMs: number,
  ): Promise<AuctionRecord[]> {
    if (productIds.length === 0) return [];
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Auction"
       WHERE "productId" IN (:productIds) AND (
         "status" IN (:live) OR ("status" IN ('SOLD','UNSOLD') AND "closedAt" >= :since)
       )
       ORDER BY ("status" IN (:live)) DESC, "startsAt" DESC, "id" DESC`,
      {
        productIds,
        live: [...LIVE_STATUSES],
        since: new Date(now.getTime() - closedWithinMs),
      },
    );
    return rows.map(toRecord);
  }

  async applyBid(id: string, patch: BidPatch): Promise<AuctionRecord> {
    const rows = await this.select(
      `UPDATE "Auction" SET "priceMinor" = :priceMinor, "leaderId" = :leaderId, "leaderMaxMinor" = :leaderMaxMinor,
         "endsAt" = :endsAt, "bidCount" = "bidCount" + 1, "version" = "version" + 1, "updatedAt" = :now
       WHERE "id" = :id AND "version" = :expectedVersion
       RETURNING ${COLUMNS}`,
      { id, ...patch },
    );
    if (rows.length !== 1)
      throw new Error(`auction ${id}: bid update lost the version race`);
    return toRecord(rows[0]);
  }

  async transition(request: TransitionRequest): Promise<AuctionRecord | null> {
    const sets: string[] = [
      '"status" = :to',
      '"statusReason" = :reason',
      '"version" = "version" + 1',
      '"updatedAt" = :at',
    ];
    const replacements: Record<string, unknown> = {
      id: request.id,
      from: request.from,
      to: request.to,
      reason: request.reason,
      at: request.at,
    };
    for (const [key, value] of Object.entries(request.patch ?? {})) {
      const column = PATCH_COLUMNS[key as keyof TransitionPatch];
      if (!column) throw new Error(`unknown transition column ${key}`);
      sets.push(`"${column}" = :p_${key}`);
      replacements[`p_${key}`] = value;
    }
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "Auction" SET ${sets.join(', ')} WHERE "id" = :id AND "status" = :from RETURNING ${COLUMNS}`,
        replacements,
      );
      if (!row) return null;
      const record = toRecord(row);
      await this.history(
        record,
        request.from,
        request.reason,
        request.actor,
        request.at,
      );
      return record;
    });
  }

  async markUnitHeld(id: string): Promise<boolean> {
    // only while the auction still lives: a hold that lands after a cancel must be returned, not recorded
    const rows = await this.select(
      `UPDATE "Auction" SET "unitHeld" = true
       WHERE "id" = :id AND "unitHeld" = false AND "status" IN ('SCHEDULED','OPEN','CLOSED','SECOND_CHANCE')
       RETURNING "id"`,
      { id },
    );
    return rows.length === 1;
  }

  async countOverdue(before: Date): Promise<number> {
    const [row] = await this.select<{ count: string }>(
      `SELECT count(*)::text AS "count" FROM "Auction" WHERE "status" = 'OPEN' AND "endsAt" < :before`,
      { before },
    );
    return Number(row?.count ?? 0);
  }

  async findDueToOpen(now: Date, limit: number): Promise<string[]> {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "Auction"
       WHERE "status" = 'SCHEDULED' AND "unitHeld" = true AND "startsAt" <= :now AND "endsAt" > :now
       ORDER BY "startsAt" LIMIT :limit`,
      { now, limit },
    );
    return rows.map((r) => r.id);
  }

  async markUnitReturned(id: string): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "Auction" SET "unitHeld" = false, "returnPending" = false
       WHERE "id" = :id AND "returnPending" = true RETURNING "id"`,
      { id },
    );
    return rows.length === 1;
  }

  async storeOrder(
    id: string,
    step: 'winner' | 'second-chance',
    orderId: string,
  ): Promise<boolean> {
    // the winner step also fixes `firstOrderId`; a new order starts its own version line
    const rows = await this.select(
      `UPDATE "Auction" SET "winnerOrderId" = :orderId,
         "firstOrderId" = CASE WHEN :step = 'winner' THEN :orderId::uuid ELSE "firstOrderId" END,
         "settlementOrderVersion" = 0
       WHERE "id" = :id AND "winnerOrderId" IS NULL AND "status" IN ('CLOSED','SECOND_CHANCE') RETURNING "id"`,
      { id, step, orderId },
    );
    return rows.length === 1;
  }

  async advanceSettlementVersion(
    id: string,
    orderVersion: number,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "Auction" SET "settlementOrderVersion" = :orderVersion
       WHERE "id" = :id AND "settlementOrderVersion" < :orderVersion RETURNING "id"`,
      { id, orderVersion },
    );
    return rows.length === 1;
  }

  async findBySettlementOrder(
    orderId: string,
  ): Promise<{ auction: AuctionRecord; role: 'first' | 'current' } | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Auction" WHERE "winnerOrderId" = :orderId OR "firstOrderId" = :orderId LIMIT 1`,
      { orderId },
    );
    if (!row) return null;
    const auction = toRecord(row);
    return {
      auction,
      role: auction.winnerOrderId === orderId ? 'current' : 'first',
    };
  }

  async findAwaitingOrder(
    buyerId: string,
    priceMinor: number,
  ): Promise<AuctionRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Auction"
       WHERE "winnerId" = :buyerId AND "finalPriceMinor" = :priceMinor AND "winnerOrderId" IS NULL
         AND "status" IN ('CLOSED','SECOND_CHANCE')
       ORDER BY "updatedAt" DESC LIMIT 1`,
      { buyerId, priceMinor },
    );
    return row ? toRecord(row) : null;
  }

  async findDue(now: Date, limit: number): Promise<string[]> {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "Auction" WHERE "status" = 'OPEN' AND "endsAt" <= :now ORDER BY "endsAt" LIMIT :limit`,
      { now, limit },
    );
    return rows.map((r) => r.id);
  }

  async findHoldPending(
    olderThan: Date,
    limit: number,
  ): Promise<AuctionRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Auction"
       WHERE "unitHeld" = false AND "status" = 'SCHEDULED' AND "holdRequestedAt" <= :olderThan
       ORDER BY "holdRequestedAt" LIMIT :limit`,
      { olderThan, limit },
    );
    return rows.map(toRecord);
  }

  async findReturnPending(limit: number): Promise<string[]> {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "Auction" WHERE "returnPending" ORDER BY "updatedAt" LIMIT :limit`,
      { limit },
    );
    return rows.map((r) => r.id);
  }

  async findClosedWithoutOrder(
    olderThan: Date,
    limit: number,
  ): Promise<AuctionRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Auction"
       WHERE "status" IN ('CLOSED','SECOND_CHANCE') AND "winnerOrderId" IS NULL AND "updatedAt" <= :olderThan
       ORDER BY "updatedAt" LIMIT :limit`,
      { olderThan, limit },
    );
    return rows.map(toRecord);
  }
}
