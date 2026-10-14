import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../domain/auction-cursor';
import { InvalidCursorError } from '../domain/auction-errors';
import type {
  BidRecord,
  BidRepository,
  NewBid,
  Page,
} from '../domain/auction-ports';
import type { RunnerUpCandidate } from '../domain/runner-up';
import { safeNumber } from './safe-number';

const minor = z.union([z.string(), z.number()]).transform(safeNumber);

const rowSchema = z.object({
  id: z.string().uuid(),
  auctionId: z.string().uuid(),
  bidderId: z.string().uuid(),
  maxAmountMinor: minor,
  outcome: z.enum(['leading', 'outbid', 'raised']),
  priceAfterMinor: minor,
  sequence: z.number().int(),
  createdAt: z.date(),
});

const COLUMNS = `"id", "auctionId", "bidderId", "maxAmountMinor", "outcome", "priceAfterMinor", "sequence", "createdAt"`;

/** The append-only bid log (S21 data-model §2). Statements join the active transaction (CLS). */
@Injectable()
export class SequelizeBidRepository implements BidRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: object = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  async append(bid: NewBid): Promise<BidRecord> {
    const [row] = await this.select(
      `INSERT INTO "Bid" ("auctionId", "bidderId", "maxAmountMinor", "outcome", "priceAfterMinor", "sequence", "createdAt")
       VALUES (:auctionId, :bidderId, :maxAmountMinor, :outcome, :priceAfterMinor, :sequence, :createdAt)
       RETURNING ${COLUMNS}`,
      bid,
    );
    return rowSchema.parse(row);
  }

  async historyPage(
    auctionId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<BidRecord>> {
    const scope = `bids:${auctionId}`;
    const replacements: Record<string, unknown> = {
      auctionId,
      limit: query.limit + 1,
    };
    let after = '';
    if (query.cursor) {
      const [sequence] = decodeCursor(scope, query.cursor, 1);
      if (!/^\d{1,9}$/.test(sequence)) throw new InvalidCursorError();
      after = 'AND "sequence" < :afterSequence';
      replacements.afterSequence = Number(sequence);
    }
    const rows = (
      await this.select(
        `SELECT ${COLUMNS} FROM "Bid"
         WHERE "auctionId" = :auctionId AND "outcome" <> 'raised' ${after}
         ORDER BY "sequence" DESC LIMIT :limit`,
        replacements,
      )
    ).map((r) => rowSchema.parse(r));
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(scope, [String(last.sequence)])
          : null,
    };
  }

  async myBid(
    auctionId: string,
    bidderId: string,
  ): Promise<{ maxAmountMinor: number } | null> {
    const [row] = await this.select<{ max: string | null }>(
      `SELECT max("maxAmountMinor") AS "max" FROM "Bid" WHERE "auctionId" = :auctionId AND "bidderId" = :bidderId`,
      { auctionId, bidderId },
    );
    return row?.max == null ? null : { maxAmountMinor: safeNumber(row.max) };
  }

  async runnerUpCandidates(auctionId: string): Promise<RunnerUpCandidate[]> {
    const rows = await this.select<{
      bidderId: string;
      maxAmountMinor: string;
      sequence: number;
    }>(
      `SELECT DISTINCT ON ("bidderId") "bidderId", "maxAmountMinor", "sequence" FROM "Bid"
       WHERE "auctionId" = :auctionId
       ORDER BY "bidderId", "maxAmountMinor" DESC, "sequence" ASC`,
      { auctionId },
    );
    return rows.map((r) => ({
      bidderId: r.bidderId,
      maxAmountMinor: safeNumber(r.maxAmountMinor),
      sequence: r.sequence,
    }));
  }
}
