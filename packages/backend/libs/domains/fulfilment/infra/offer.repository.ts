import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  AcceptOfferResult,
  OfferRecord,
  OfferRepository,
} from '../domain/delivery-ports';

const COLUMNS = `"id", "deliveryId", "courierId", "attempt", "status", "offeredAt", "expiresAt", "respondedAt"`;

const toRecord = (r: OfferRecord): OfferRecord => ({
  ...r,
  offeredAt: new Date(r.offeredAt),
  expiresAt: new Date(r.expiresAt),
  respondedAt: r.respondedAt ? new Date(r.respondedAt) : null,
});

/**
 * `DeliveryOffer` behind the port (S20 R-1, R-3, R-4, A6, A7): the durable record of who was offered what. The partial
 * unique index on `(courierId) WHERE status = 'OFFERED'` is what makes a second live offer impossible, and the unique
 * `(deliveryId, courierId)` is the permanent exclusion; `ON CONFLICT DO NOTHING` turns a lost race on either into
 * "no row" without aborting the surrounding transaction. Expiry is judged against the `now` the caller passes (the
 * injected clock), never SQL `now()`.
 */
@Injectable()
export class OfferSqlRepository implements OfferRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private async select(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<OfferRecord[]> {
    const rows = await this.sequelize.query<OfferRecord>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
    return rows.map(toRecord);
  }

  private requireTransaction(what: string): void {
    if (!getActiveTransaction())
      throw new Error(`${what} must run inside TransactionRunner.run`);
  }

  async insertOffer(input: {
    deliveryId: string;
    courierId: string;
    attempt: number;
    offeredAt: Date;
    expiresAt: Date;
  }): Promise<OfferRecord | null> {
    this.requireTransaction('insertOffer');
    const [row] = await this.select(
      `INSERT INTO "DeliveryOffer" ("deliveryId", "courierId", "attempt", "status", "offeredAt", "expiresAt")
       VALUES (:deliveryId, :courierId, :attempt, 'OFFERED', :offeredAt, :expiresAt)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      input,
    );
    return row ?? null;
  }

  async findLive(deliveryId: string): Promise<OfferRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "DeliveryOffer" WHERE "deliveryId" = :deliveryId AND "status" = 'OFFERED' LIMIT 1`,
      { deliveryId },
    );
    return row ?? null;
  }

  async findLiveForCourier(
    courierId: string,
    now: Date,
  ): Promise<OfferRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "DeliveryOffer"
        WHERE "courierId" = :courierId AND "status" = 'OFFERED' AND "expiresAt" > :now LIMIT 1`,
      { courierId, now },
    );
    return row ?? null;
  }

  async findForCourier(
    deliveryId: string,
    courierId: string,
  ): Promise<OfferRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "DeliveryOffer"
        WHERE "deliveryId" = :deliveryId AND "courierId" = :courierId LIMIT 1`,
      { deliveryId, courierId },
    );
    return row ?? null;
  }

  async offeredCourierIds(deliveryId: string): Promise<ReadonlySet<string>> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "DeliveryOffer" WHERE "deliveryId" = :deliveryId`,
      { deliveryId },
    );
    return new Set(rows.map((r) => r.courierId));
  }

  async withLiveOffer(
    courierIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (courierIds.length === 0) return new Set();
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "DeliveryOffer" WHERE "courierId" IN (:courierIds) AND "status" = 'OFFERED'`,
      { courierIds: [...courierIds] },
    );
    return new Set(rows.map((r) => r.courierId));
  }

  async accept(
    deliveryId: string,
    courierId: string,
    now: Date,
  ): Promise<AcceptOfferResult> {
    this.requireTransaction('accept');
    const [accepted] = await this.select(
      `UPDATE "DeliveryOffer" SET "status" = 'ACCEPTED', "respondedAt" = :now
        WHERE "deliveryId" = :deliveryId AND "courierId" = :courierId AND "status" = 'OFFERED' AND "expiresAt" > :now
        RETURNING ${COLUMNS}`,
      { deliveryId, courierId, now },
    );
    if (accepted) return { outcome: 'accepted', offer: accepted };
    const previous = await this.findForCourier(deliveryId, courierId);
    // Still `OFFERED` although the conditional update refused: it is past its expiry by the injected clock.
    if (previous?.status === 'OFFERED') return { outcome: 'expired' };
    return { outcome: 'not_active', previous };
  }

  async close(
    deliveryId: string,
    courierId: string,
    to: 'DECLINED' | 'EXPIRED' | 'WITHDRAWN',
    now: Date,
  ): Promise<OfferRecord | null> {
    this.requireTransaction('close');
    const [row] = await this.select(
      `UPDATE "DeliveryOffer" SET "status" = :to, "respondedAt" = :now
        WHERE "deliveryId" = :deliveryId AND "courierId" = :courierId AND "status" = 'OFFERED'
        RETURNING ${COLUMNS}`,
      { deliveryId, courierId, to, now },
    );
    return row ?? null;
  }
}
