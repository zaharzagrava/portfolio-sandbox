import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { TransactionRunner } from '@app/infrastructure/context';
import { FlashSaleOverlapError } from '../domain/flash-errors';
import type {
  FlashSaleRecord,
  FlashSaleRepository,
  NewFlashSale,
  ReservationSums,
} from '../domain/flash-ports';
import {
  FLASH_SALE_STATUSES,
  STATUS_REASONS,
  type FlashSaleStatus,
  type StatusReason,
} from '../domain/flash-sale-state';
import type { ReservationStatus } from '../domain/ports';

const EXCLUSION_VIOLATION = '23P01';

const COLUMNS = `"id", "shopId", "productId", "priceMinor", "currency", "units", "buckets", "perUserLimit",
  "admissionRatePerSecond", "startsAt", "endsAt", "status", "statusReason", "version", "endedAt", "reconciledAt", "createdAt"`;

/** A row read back from the table: validated once so a drifted value fails here, not in the lifecycle (A9). */
const rowSchema = z.object({
  id: z.string().uuid(),
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
  priceMinor: z.coerce.number().int().positive(),
  currency: z.string().length(3),
  units: z.number().int().positive(),
  buckets: z.number().int().positive(),
  perUserLimit: z.number().int().positive(),
  admissionRatePerSecond: z.number().int().positive(),
  startsAt: z.date(),
  endsAt: z.date(),
  status: z.enum(FLASH_SALE_STATUSES),
  statusReason: z.enum(STATUS_REASONS).nullable(),
  version: z.number().int(),
  endedAt: z.date().nullable(),
  reconciledAt: z.date().nullable(),
  createdAt: z.date(),
});

const toRecord = (row: unknown): FlashSaleRecord =>
  rowSchema.parse(row) as FlashSaleRecord;

const pgCode = (error: unknown): string | undefined => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return e?.parent?.code ?? e?.original?.code;
};

/** `FlashSale` and `FlashSaleHistory` (S11 data-model §1). Statements join the active transaction (CLS). */
@Injectable()
export class SequelizeFlashSaleRepository implements FlashSaleRepository {
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

  async create(sale: NewFlashSale): Promise<FlashSaleRecord> {
    const id = sale.id ?? uuidv7();
    try {
      const rows = await this.runner.run(async () => {
        const inserted = await this.select(
          `INSERT INTO "FlashSale" ("id", "shopId", "productId", "priceMinor", "currency", "units", "buckets", "perUserLimit",
             "admissionRatePerSecond", "startsAt", "endsAt", "status", "version", "createdAt", "updatedAt")
           VALUES (:id, :shopId, :productId, :priceMinor, :currency, :units, :buckets, :perUserLimit,
             :admissionRatePerSecond, :startsAt, :endsAt, 'SCHEDULED', 0, now(), now())
           RETURNING ${COLUMNS}`,
          { ...sale, id },
        );
        await this.sequelize.query(
          `INSERT INTO "FlashSaleHistory" ("saleId", "fromStatus", "toStatus", "reason", "actor", "at")
           VALUES (:id, NULL, 'SCHEDULED', NULL, :actor, COALESCE(:at::timestamptz, now()))`,
          {
            replacements: {
              id,
              actor: `shop:${sale.shopId}`,
              at: sale.at ?? null,
            },
          },
        );
        return inserted;
      });
      return toRecord(rows[0]);
    } catch (error) {
      if (pgCode(error) === EXCLUSION_VIOLATION)
        throw new FlashSaleOverlapError();
      throw error;
    }
  }

  async find(saleId: string): Promise<FlashSaleRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "FlashSale" WHERE "id" = :saleId`,
      { saleId },
    );
    return row ? toRecord(row) : null;
  }

  async findForShop(
    shopId: string,
    saleId: string,
  ): Promise<FlashSaleRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "FlashSale" WHERE "shopId" = :shopId AND "id" = :saleId`,
      { shopId, saleId },
    );
    return row ? toRecord(row) : null;
  }

  async pageForShop(
    shopId: string,
    query: {
      status?: FlashSaleStatus;
      limit: number;
      after: { startsAt: Date; id: string } | null;
    },
  ): Promise<FlashSaleRecord[]> {
    const where = ['"shopId" = :shopId'];
    if (query.status) where.push('"status" = :status');
    if (query.after)
      where.push(
        '("startsAt", "id") < (:afterStartsAt::timestamptz, :afterId::uuid)',
      );
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "FlashSale" WHERE ${where.join(' AND ')}
       ORDER BY "startsAt" DESC, "id" DESC LIMIT :limit`,
      {
        shopId,
        status: query.status ?? null,
        afterStartsAt: query.after?.startsAt ?? null,
        afterId: query.after?.id ?? null,
        limit: Math.min(100, query.limit),
      },
    );
    return rows.map(toRecord);
  }

  /** Every loaded sale: a few rows, the directory evaluates the window itself. */
  async loadedAndLive(_now: Date): Promise<FlashSaleRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "FlashSale" WHERE "status" = 'LOADED' ORDER BY "endsAt", "id" LIMIT 1000`,
    );
    return rows.map(toRecord);
  }

  /** Per product the sale not yet over: the one running or loaded, else the next one starting within 24 h. */
  async currentOrNextForProducts(
    productIds: string[],
    now: Date,
  ): Promise<FlashSaleRecord[]> {
    if (productIds.length === 0) return [];
    const rows = await this.select(
      `SELECT DISTINCT ON ("productId") ${COLUMNS} FROM "FlashSale"
       WHERE "productId" IN (:productIds) AND "status" IN ('SCHEDULED','LOADED')
         AND "endsAt" > :now AND "startsAt" <= :horizon
       ORDER BY "productId", "startsAt", "id"`,
      {
        productIds,
        now,
        horizon: new Date(now.getTime() + 24 * 3_600_000),
      },
    );
    return rows.map(toRecord);
  }

  async move(
    saleId: string,
    from: FlashSaleStatus,
    to: FlashSaleStatus,
    patch: { reason?: StatusReason },
    actor: string,
    now: Date,
  ): Promise<FlashSaleRecord | null> {
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "FlashSale" SET "status" = :to, "statusReason" = :reason, "version" = "version" + 1, "updatedAt" = :now,
           "endedAt" = CASE WHEN :to = 'ENDED' THEN :now ELSE "endedAt" END,
           "reconciledAt" = CASE WHEN :to = 'RECONCILED' THEN :now ELSE "reconciledAt" END
         WHERE "id" = :saleId AND "status" = :from
         RETURNING ${COLUMNS}`,
        { saleId, from, to, reason: patch.reason ?? null, now },
      );
      if (!row) return null;
      await this.sequelize.query(
        `INSERT INTO "FlashSaleHistory" ("saleId", "fromStatus", "toStatus", "reason", "actor", "at")
         VALUES (:saleId, :from, :to, :reason, :actor, :now)`,
        {
          replacements: {
            saleId,
            from,
            to,
            reason: patch.reason ?? null,
            actor,
            now,
          },
        },
      );
      return toRecord(row);
    });
  }

  async reservationSums(saleId: string): Promise<ReservationSums> {
    const [row] = await this.select<{
      held: string;
      converted: string;
      heldRows: string;
      releasePendingRows: string;
    }>(
      `SELECT COALESCE(SUM("quantity") FILTER (WHERE "status" = 'HELD'), 0) AS "held",
              COALESCE(SUM("quantity") FILTER (WHERE "status" = 'CONVERTED'), 0) AS "converted",
              COUNT(*) FILTER (WHERE "status" = 'HELD') AS "heldRows",
              COUNT(*) FILTER (WHERE "status" = 'RELEASE_PENDING') AS "releasePendingRows"
       FROM "StockReservation" WHERE "source" = 'FLASH' AND "flashSaleId" = :saleId`,
      { saleId },
    );
    return {
      held: Number(row.held),
      converted: Number(row.converted),
      heldRows: Number(row.heldRows),
      releasePendingRows: Number(row.releasePendingRows),
    };
  }

  /** Newest `HELD` orders (unpaid) whose units, taken off newest first, bring the sale back to `keepUnits`. */
  async newestUnpaidOrdersBeyond(
    saleId: string,
    keepUnits: number,
  ): Promise<Array<{ orderId: string; units: number; claimId: string }>> {
    const sums = await this.reservationSums(saleId);
    let excess = sums.held + sums.converted - keepUnits;
    if (excess <= 0) return [];
    const held = await this.select<{
      orderId: string;
      units: number;
      claimId: string;
    }>(
      `SELECT "bisOrderId" AS "orderId", "quantity" AS "units", "sourceRef" AS "claimId" FROM "StockReservation"
       WHERE "source" = 'FLASH' AND "flashSaleId" = :saleId AND "status" = 'HELD'
       ORDER BY "createdAt" DESC, "id" DESC`,
      { saleId },
    );
    const out: Array<{ orderId: string; units: number; claimId: string }> = [];
    for (const r of held) {
      if (excess <= 0) break;
      out.push(r);
      excess -= r.units;
    }
    return out;
  }

  async everLoaded(saleId: string): Promise<boolean> {
    const rows = await this.select(
      `SELECT 1 FROM "FlashSaleHistory" WHERE "saleId" = :saleId AND "toStatus" = 'LOADED' LIMIT 1`,
      { saleId },
    );
    return rows.length > 0;
  }

  async reservationByClaim(
    claimId: string,
  ): Promise<{ orderId: string; status: ReservationStatus } | null> {
    const [row] = await this.select<{
      orderId: string;
      status: ReservationStatus;
    }>(
      `SELECT "bisOrderId" AS "orderId", "status" FROM "StockReservation" WHERE "source" = 'FLASH' AND "sourceRef" = :claimId`,
      { claimId },
    );
    return row ?? null;
  }
}
