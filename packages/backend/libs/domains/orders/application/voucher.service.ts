import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import {
  type bookingVoucherRequestedSchema,
  type Voucher,
  type VoucherPage,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { decodeOrderCursor, encodeOrderCursor } from '../domain/order-cursor';

/** The command the booking confirmation sends to orders (S22 emits, S10 consumes). */
export type BookingVoucherCommand = z.infer<
  typeof bookingVoucherRequestedSchema
>;

interface VoucherRow {
  id: string;
  holdId: string;
  launchEventId: string;
  shopId: string;
  seatCount: number;
  status: 'ISSUED';
  createdAt: Date;
}

/**
 * Vouchers of confirmed bookings (J03 G-04, G-44). `issue` is idempotent on the hold: `holdId` is UNIQUE and the insert is
 * `ON CONFLICT DO NOTHING`, so a redelivered command (queues deliver at least once) leaves one row (IV.5).
 */
@Injectable()
export class VoucherService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Returns whether this call created the voucher (false: it already existed). */
  async issue(command: BookingVoucherCommand): Promise<boolean> {
    return this.runner.run(async (transaction) => {
      const [created] = await this.sequelize.query<{ id: string }>(
        `INSERT INTO "Voucher" ("holdId", "launchEventId", "shopId", "userId", "seatCount", "status", "createdAt")
         VALUES (:holdId, :launchEventId, :shopId, :userId, :seatCount, 'ISSUED', :now)
         ON CONFLICT ("holdId") DO NOTHING
         RETURNING "id"`,
        {
          replacements: {
            holdId: command.holdId,
            launchEventId: command.launchEventId,
            shopId: command.shopId,
            userId: command.userId,
            seatCount: command.seatCount,
            now: this.clock.now(),
          },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      return created !== undefined;
    });
  }

  /** The caller's own vouchers, newest first, keyset-paged like `GET /orders` (the cursor is bound to the caller). */
  async listForUser(
    userId: string,
    query: { launchEventId?: string; limit: number; cursor?: string },
  ): Promise<VoucherPage> {
    const scope = `voucher:${userId}`;
    const after = query.cursor ? decodeOrderCursor(scope, query.cursor) : null;
    const rows = await this.sequelize.query<VoucherRow>(
      `SELECT "id", "holdId", "launchEventId", "shopId", "seatCount", "status", "createdAt"
         FROM "Voucher"
        WHERE "userId" = :userId
          AND (:launchEventId::uuid IS NULL OR "launchEventId" = :launchEventId::uuid)
          AND (:afterAt::timestamptz IS NULL OR ("createdAt", "id") < (:afterAt::timestamptz, :afterId::uuid))
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT :take`,
      {
        replacements: {
          userId,
          launchEventId: query.launchEventId ?? null,
          afterAt: after?.createdAt ?? null,
          afterId: after?.id ?? null,
          take: query.limit + 1,
        },
        type: QueryTypes.SELECT,
      },
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row): Voucher => ({
        voucherId: row.id,
        holdId: row.holdId,
        launchEventId: row.launchEventId,
        shopId: row.shopId,
        seatCount: row.seatCount,
        status: row.status,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeOrderCursor(scope, {
              createdAt: new Date(last.createdAt).toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}
