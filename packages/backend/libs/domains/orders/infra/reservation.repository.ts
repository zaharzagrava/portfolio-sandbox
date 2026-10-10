import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  ReservationRecord,
  ReservationRepository,
  ReservationStatus,
} from '../domain/ports';

const SELECT = `SELECT r."id", r."bisOrderId" AS "orderId", r."productId", i."shopId", r."quantity", r."status",
                       r."releaseAttempts"
                FROM "StockReservation" r
                JOIN "BisOrderItem" i ON i."bisOrderId" = r."bisOrderId" AND i."productId" = r."productId"`;

/** `StockReservation` rows of an order; the shop id comes from the order's own item (the stock call needs it). */
@Injectable()
export class SequelizeReservationRepository implements ReservationRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: object,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  forOrder(orderId: string): Promise<ReservationRecord[]> {
    return this.select<ReservationRecord>(
      `${SELECT} WHERE r."bisOrderId" = :orderId ORDER BY r."productId"`,
      { orderId },
    );
  }

  async transitionAll(
    orderId: string,
    from: ReservationStatus[],
    to: ReservationStatus,
    patch: { expiresAt?: Date; nextReleaseAt?: Date | null } = {},
  ): Promise<number> {
    const sets = ['"status" = :to'];
    if (patch.expiresAt !== undefined) sets.push('"expiresAt" = :expiresAt');
    if (patch.nextReleaseAt !== undefined)
      sets.push('"nextReleaseAt" = :nextReleaseAt');
    const rows = await this.select<{ id: string }>(
      `UPDATE "StockReservation" SET ${sets.join(', ')}
       WHERE "bisOrderId" = :orderId AND "status" IN (:from) RETURNING "id"`,
      {
        orderId,
        from,
        to,
        expiresAt: patch.expiresAt ?? null,
        nextReleaseAt: patch.nextReleaseAt ?? null,
      },
    );
    return rows.length;
  }

  releasePending(now: Date, limit: number): Promise<ReservationRecord[]> {
    return this.select<ReservationRecord>(
      `${SELECT}
       WHERE r."id" IN (
         SELECT "id" FROM "StockReservation"
         WHERE "status" = 'RELEASE_PENDING' AND ("nextReleaseAt" IS NULL OR "nextReleaseAt" <= :now)
         ORDER BY "nextReleaseAt" NULLS FIRST, "id" LIMIT :limit FOR UPDATE SKIP LOCKED)`,
      { now, limit },
    );
  }

  async markReleased(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "StockReservation" SET "status" = 'RELEASED', "nextReleaseAt" = NULL WHERE "id" = :id`,
      { replacements: { id } },
    );
  }

  async scheduleRetry(
    id: string,
    attempts: number,
    nextReleaseAt: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "StockReservation" SET "releaseAttempts" = :attempts, "nextReleaseAt" = :nextReleaseAt WHERE "id" = :id`,
      { replacements: { id, attempts, nextReleaseAt } },
    );
  }

  async countReleasePending(): Promise<number> {
    const [row] = await this.select<{ n: string }>(
      `SELECT count(*) AS n FROM "StockReservation" WHERE "status" = 'RELEASE_PENDING'`,
      {},
    );
    return Number(row.n);
  }
}
