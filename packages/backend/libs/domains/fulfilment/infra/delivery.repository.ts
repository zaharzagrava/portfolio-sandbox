import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import {
  DELIVERY_MILESTONES,
  type DeliveryStatusValue,
} from '@marketplace-sandbox/contracts';
import { getActiveTransaction } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  type DeliveryHistoryRecord,
  type DeliveryRecord,
  type DeliveryRepository,
  type InsertDeliveryResult,
  type NewDelivery,
  type OfferRecord,
  type ShopListQuery,
  type TransitionRequest,
  type TransitionedDelivery,
} from '../domain/delivery-ports';
import { CourierBusyError } from '../domain/delivery-errors';
import { transition as transitionTable } from '../domain/delivery-state';
import type { ActorKind } from '../domain/delivery-state';
import { DeliveryStatusChanged } from '../application/events/delivery-events';

const COLUMNS = `d."id", d."shopId", d."orderId", d."buyerId", d."city", d."pickupLat", d."pickupLng", d."dropoffLat",
  d."dropoffLng", d."status", d."courierId", d."attempt", d."feeMinor", d."currency", d."surge", d."nextActionAt",
  d."cancelReason", d."orderSyncedStatus", d."version", d."createdAt", d."updatedAt"`;
const RETURNING = COLUMNS.replace(/d\./g, '');

interface DeliveryRow {
  id: string;
  shopId: string;
  orderId: string;
  buyerId: string;
  city: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  status: DeliveryStatusValue;
  courierId: string | null;
  attempt: number;
  feeMinor: string | number;
  currency: string;
  surge: string | number;
  nextActionAt: Date | null;
  cancelReason: string | null;
  orderSyncedStatus: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const toRecord = (r: DeliveryRow): DeliveryRecord => ({
  id: r.id,
  shopId: r.shopId,
  orderId: r.orderId,
  buyerId: r.buyerId,
  city: r.city,
  pickup: { lat: r.pickupLat, lng: r.pickupLng },
  dropoff: { lat: r.dropoffLat, lng: r.dropoffLng },
  status: r.status,
  courierId: r.courierId,
  attempt: r.attempt,
  feeMinor: Number(r.feeMinor),
  currency: r.currency,
  surge: Number(r.surge),
  nextActionAt: r.nextActionAt ? new Date(r.nextActionAt) : null,
  cancelReason: r.cancelReason,
  orderSyncedStatus: r.orderSyncedStatus,
  version: r.version,
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});

const OPEN = `('REQUESTED', 'OFFERED', 'ASSIGNED', 'PICKED_UP')`;
/** Position of a status in the write-back chain: a row is behind when its `orderSyncedStatus` ranks lower. */
const SYNC_RANK = (column: string) =>
  `(CASE ${column} WHEN 'ASSIGNED' THEN 1 WHEN 'PICKED_UP' THEN 2 WHEN 'DELIVERED' THEN 3 ELSE 0 END)`;
const ACTIVE_ASSIGNMENT_INDEX = 'Delivery_courier_active_key';

const isActiveAssignmentViolation = (error: unknown): boolean => {
  const e = error as {
    parent?: { code?: string; constraint?: string };
    original?: { code?: string; constraint?: string };
  };
  const cause = e.parent ?? e.original;
  return (
    cause?.code === '23505' && cause.constraint === ACTIVE_ASSIGNMENT_INDEX
  );
};

/**
 * `Delivery` and its history behind the port (S20 A6, A13, A16, FR-023, FR-028): raw SQL with named replacements, every
 * write one conditional statement joining the caller's `TransactionRunner.run` scope through CLS. The status machine
 * itself is `delivery-state.ts`; here it becomes `WHERE status IN (...)`.
 */
@Injectable()
export class DeliverySqlRepository implements DeliveryRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly outbox: OutboxService,
  ) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  /** A write that must be atomic with its siblings refuses to run outside a transaction. */
  private requireTransaction(what: string): void {
    if (!getActiveTransaction())
      throw new Error(`${what} must run inside TransactionRunner.run`);
  }

  // ------------------------------------------------------------ creation

  async insertRequested(
    input: NewDelivery,
    now: Date,
  ): Promise<InsertDeliveryResult> {
    this.requireTransaction('insertRequested');
    const [row] = await this.select<DeliveryRow>(
      `INSERT INTO "Delivery" ("shopId", "orderId", "buyerId", "city", "pickupLat", "pickupLng", "dropoffLat",
         "dropoffLng", "status", "attempt", "feeMinor", "currency", "surge", "nextActionAt", "version",
         "createdAt", "updatedAt")
       VALUES (:shopId, :orderId, :buyerId, :city, :plat, :plng, :dlat, :dlng, 'REQUESTED', 0, :fee, :currency,
         :surge, :now, 1, :now, :now)
       ON CONFLICT DO NOTHING
       RETURNING ${RETURNING}`,
      {
        shopId: input.shopId,
        orderId: input.orderId,
        buyerId: input.buyerId,
        city: input.city,
        plat: input.pickup.lat,
        plng: input.pickup.lng,
        dlat: input.dropoff.lat,
        dlng: input.dropoff.lng,
        fee: input.feeMinor,
        currency: input.currency,
        surge: input.surge,
        now,
      },
    );
    if (!row) {
      const [existing] = await this.select<{ status: DeliveryStatusValue }>(
        `SELECT "status" FROM "Delivery"
          WHERE "orderId" = :orderId AND "shopId" = :shopId AND "status" <> 'CANCELLED' LIMIT 1`,
        { orderId: input.orderId, shopId: input.shopId },
      );
      return existing?.status === 'DELIVERED'
        ? { outcome: 'already_completed' }
        : { outcome: 'already_open' };
    }
    const delivery = toRecord(row);
    await this.writeHistory({
      deliveryId: delivery.id,
      from: null,
      to: 'REQUESTED',
      actorKind: 'shop',
      actorId: null,
      detail: null,
      version: delivery.version,
      now,
    });
    await this.appendMilestone(delivery, null);
    return { outcome: 'created', delivery };
  }

  async lockShopAndCountOpen(shopId: string): Promise<number> {
    this.requireTransaction('lockShopAndCountOpen');
    await this.select(`SELECT pg_advisory_xact_lock(hashtext(:shopId))`, {
      shopId,
    });
    const [row] = await this.select<{ n: number }>(
      `SELECT count(*)::int AS "n" FROM "Delivery" WHERE "shopId" = :shopId AND "status" IN ${OPEN}`,
      { shopId },
    );
    return row.n;
  }

  // --------------------------------------------------------------- reads

  async findById(
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<DeliveryRecord | null> {
    if (options.forUpdate) this.requireTransaction('findById forUpdate');
    const [row] = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."id" = :id ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      { id },
    );
    return row ? toRecord(row) : null;
  }

  async findForBuyer(
    id: string,
    buyerId: string,
  ): Promise<DeliveryRecord | null> {
    const [row] = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."id" = :id AND d."buyerId" = :buyerId`,
      { id, buyerId },
    );
    return row ? toRecord(row) : null;
  }

  async listForBuyerByOrder(
    orderId: string,
    buyerId: string,
  ): Promise<DeliveryRecord[]> {
    const rows = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."orderId" = :orderId AND d."buyerId" = :buyerId
        ORDER BY d."createdAt" DESC, d."id" DESC`,
      { orderId, buyerId },
    );
    return rows.map(toRecord);
  }

  async findForCourier(
    id: string,
    courierId: string,
    now: Date,
  ): Promise<{ delivery: DeliveryRecord; offer: OfferRecord | null } | null> {
    const [row] = await this.select<
      DeliveryRow & {
        offerId: string | null;
        offerAttempt: number | null;
        offerStatus: OfferRecord['status'] | null;
        offeredAt: Date | null;
        offerExpiresAt: Date | null;
        respondedAt: Date | null;
      }
    >(
      `SELECT ${COLUMNS}, o."id" AS "offerId", o."attempt" AS "offerAttempt", o."status" AS "offerStatus",
              o."offeredAt", o."expiresAt" AS "offerExpiresAt", o."respondedAt"
         FROM "Delivery" d
         LEFT JOIN "DeliveryOffer" o ON o."deliveryId" = d."id" AND o."courierId" = :courierId
              AND o."status" = 'OFFERED' AND o."expiresAt" > :now
        WHERE d."id" = :id AND (d."courierId" = :courierId OR o."id" IS NOT NULL)`,
      { id, courierId, now },
    );
    if (!row) return null;
    return {
      delivery: toRecord(row),
      offer: row.offerId
        ? {
            id: row.offerId,
            deliveryId: id,
            courierId,
            attempt: row.offerAttempt!,
            status: row.offerStatus!,
            offeredAt: new Date(row.offeredAt!),
            expiresAt: new Date(row.offerExpiresAt!),
            respondedAt: row.respondedAt ? new Date(row.respondedAt) : null,
          }
        : null,
    };
  }

  async findForShop(
    shopId: string,
    id: string,
  ): Promise<DeliveryRecord | null> {
    const [row] = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."id" = :id AND d."shopId" = :shopId`,
      { id, shopId },
    );
    return row ? toRecord(row) : null;
  }

  async listForShop(
    shopId: string,
    query: ShopListQuery,
  ): Promise<DeliveryRecord[]> {
    const rows = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d
        WHERE d."shopId" = :shopId
          ${query.status ? 'AND d."status" = :status' : ''}
          ${query.after ? 'AND (d."createdAt", d."id") < (:afterAt, :afterId)' : ''}
        ORDER BY d."createdAt" DESC, d."id" DESC
        LIMIT :limit`,
      {
        shopId,
        status: query.status ?? null,
        afterAt: query.after?.createdAt ?? null,
        afterId: query.after?.id ?? null,
        limit: query.limit,
      },
    );
    return rows.map(toRecord);
  }

  async history(deliveryId: string): Promise<DeliveryHistoryRecord[]> {
    return (
      await this.select<DeliveryHistoryRecord>(
        `SELECT "id", "deliveryId", "from", "to", "actorKind", "actorId", "detail", "version", "at"
           FROM "DeliveryEvent" WHERE "deliveryId" = :deliveryId ORDER BY "version", "at", "id"`,
        { deliveryId },
      )
    ).map((r) => ({ ...r, at: new Date(r.at) }));
  }

  // -------------------------------------------------------------- writes

  async transition(
    request: TransitionRequest,
  ): Promise<TransitionedDelivery | null> {
    this.requireTransaction('transition');
    const { command } = request;
    const { from, to } = transitionTable(command);
    const sets: string[] = [];
    const replacements: Record<string, unknown> = {
      id: request.deliveryId,
      from,
      to,
      now: request.now,
    };
    const guards: string[] = [];

    if (request.expectedVersion !== undefined) {
      guards.push(`AND "version" = :expectedVersion`);
      replacements.expectedVersion = request.expectedVersion;
    }
    // The caller is in the predicate (no load-then-check): only the assigned courier moves it along.
    if (command.type === 'pickUp' || command.type === 'deliver') {
      guards.push(`AND "courierId" = :commandCourier`);
      replacements.commandCourier = command.courierId;
    }

    const set = request.set ?? {};
    const courierId =
      set.courierId !== undefined
        ? set.courierId
        : command.type === 'accept'
          ? command.courierId
          : undefined;
    if (courierId !== undefined) {
      sets.push(`"courierId" = :courierId`);
      replacements.courierId = courierId;
    }
    if (set.attempt !== undefined) {
      sets.push(`"attempt" = :attempt`);
      replacements.attempt = set.attempt;
    }
    const leavesOpen = to !== 'REQUESTED' && to !== 'OFFERED';
    if (set.nextActionAt !== undefined || leavesOpen) {
      sets.push(`"nextActionAt" = :nextActionAt`);
      replacements.nextActionAt = set.nextActionAt ?? null;
    }
    const cancelReason =
      set.cancelReason !== undefined
        ? set.cancelReason
        : command.type === 'cancel'
          ? command.reason
          : undefined;
    if (cancelReason !== undefined) {
      sets.push(`"cancelReason" = :cancelReason`);
      replacements.cancelReason = cancelReason;
    }

    let row:
      (DeliveryRow & { previousStatus: DeliveryStatusValue }) | undefined;
    try {
      [row] = await this.select<
        DeliveryRow & { previousStatus: DeliveryStatusValue }
      >(
        `WITH prev AS (
           SELECT "id", "status" FROM "Delivery"
            WHERE "id" = :id AND "status" IN (:from) ${guards.join(' ')} FOR UPDATE
         )
         UPDATE "Delivery" d
            SET "status" = :to, "version" = d."version" + 1, "updatedAt" = :now
                ${sets.map((s) => `, ${s}`).join(' ')}
           FROM prev
          WHERE d."id" = prev."id"
          RETURNING ${COLUMNS}, prev."status" AS "previousStatus"`,
        replacements,
      );
    } catch (error) {
      if (isActiveAssignmentViolation(error)) throw new CourierBusyError();
      throw error;
    }
    if (!row) return null;

    const delivery = toRecord(row);
    const detail =
      request.detail ?? (command.type === 'cancel' ? command.reason : null);
    await this.writeHistory({
      deliveryId: delivery.id,
      from: row.previousStatus,
      to,
      actorKind: command.actor,
      actorId: request.actorId,
      detail,
      version: delivery.version,
      now: request.now,
    });
    await this.appendMilestone(delivery, row.previousStatus);
    return { ...delivery, previousStatus: row.previousStatus };
  }

  async deferAction(deliveryId: string, nextActionAt: Date): Promise<void> {
    this.requireTransaction('deferAction');
    await this.select(
      `UPDATE "Delivery" SET "nextActionAt" = :nextActionAt
        WHERE "id" = :deliveryId AND "status" IN ('REQUESTED', 'OFFERED') RETURNING "id"`,
      { deliveryId, nextActionAt },
    );
  }

  async consumeEmptySearch(
    deliveryId: string,
    expectedAttempt: number,
    nextActionAt: Date,
    now: Date,
  ): Promise<DeliveryRecord | null> {
    const [row] = await this.select<DeliveryRow>(
      `UPDATE "Delivery" SET "attempt" = "attempt" + 1, "nextActionAt" = :nextActionAt, "updatedAt" = :now
        WHERE "id" = :deliveryId AND "status" = 'REQUESTED' AND "attempt" = :expectedAttempt
        RETURNING ${RETURNING}`,
      { deliveryId, expectedAttempt, nextActionAt, now },
    );
    return row ? toRecord(row) : null;
  }

  async addNote(
    deliveryId: string,
    actorKind: ActorKind,
    detail: string,
    now: Date,
  ): Promise<void> {
    await this.select(
      `INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "actorKind", "actorId", "detail", "version", "at")
       SELECT d."id", d."status", d."status", :actorKind, NULL, :detail, d."version", :now
         FROM "Delivery" d
        WHERE d."id" = :deliveryId
          AND NOT EXISTS (SELECT 1 FROM "DeliveryEvent" e
                           WHERE e."deliveryId" = d."id" AND e."detail" = :detail AND e."from" = e."to")
       RETURNING "id"`,
      { deliveryId, actorKind, detail, now },
    );
  }

  // ------------------------------------------------------ recovery reads

  async lockNextOverdue(
    now: Date,
    ownedCities: readonly string[] | null,
  ): Promise<DeliveryRecord | null> {
    this.requireTransaction('lockNextOverdue');
    if (ownedCities !== null && ownedCities.length === 0) return null;
    const [row] = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d
        WHERE d."status" IN ('REQUESTED', 'OFFERED') AND d."nextActionAt" <= :now
          ${ownedCities ? 'AND d."city" IN (:cities)' : ''}
        ORDER BY d."nextActionAt", d."id"
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      { now, cities: ownedCities ? [...ownedCities] : [] },
    );
    return row ? toRecord(row) : null;
  }

  async listOpenByOrder(orderId: string): Promise<DeliveryRecord[]> {
    const rows = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."orderId" = :orderId AND d."status" IN ${OPEN} ORDER BY d."id"`,
      { orderId },
    );
    return rows.map(toRecord);
  }

  async listOpenByShop(
    shopId: string,
    limit: number,
    afterId?: string,
  ): Promise<DeliveryRecord[]> {
    const rows = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d WHERE d."shopId" = :shopId AND d."status" IN ${OPEN}
          ${afterId ? 'AND d."id" > :afterId' : ''}
        ORDER BY d."id" LIMIT :limit`,
      { shopId, limit, afterId: afterId ?? null },
    );
    return rows.map(toRecord);
  }

  async listNeedingOrderSync(limit: number): Promise<DeliveryRecord[]> {
    const rows = await this.select<DeliveryRow>(
      `SELECT ${COLUMNS} FROM "Delivery" d
        WHERE d."status" IN ('ASSIGNED', 'PICKED_UP', 'DELIVERED')
          AND ${SYNC_RANK('d."orderSyncedStatus"')} < ${SYNC_RANK('d."status"')}
        ORDER BY d."updatedAt", d."id" LIMIT :limit`,
      { limit },
    );
    return rows.map(toRecord);
  }

  async markOrderSynced(
    deliveryId: string,
    status: string,
    now: Date,
  ): Promise<void> {
    await this.select(
      `UPDATE "Delivery" SET "orderSyncedStatus" = :status, "updatedAt" = :now
        WHERE "id" = :deliveryId AND ${SYNC_RANK('"orderSyncedStatus"')} < ${SYNC_RANK(':status')}
        RETURNING "id"`,
      { deliveryId, status, now },
    );
  }

  async countDoubleAssignments(): Promise<number> {
    const [row] = await this.select<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM (SELECT 1 FROM "DeliveryOffer" WHERE "status" = 'OFFERED'
                                 GROUP BY "courierId" HAVING count(*) > 1) a)
         + (SELECT count(*) FROM (SELECT 1 FROM "Delivery" WHERE "status" IN ('ASSIGNED', 'PICKED_UP')
                                   AND "courierId" IS NOT NULL GROUP BY "courierId" HAVING count(*) > 1) b)
       )::int AS "n"`,
      {},
    );
    return row.n;
  }

  // ------------------------------------------------------------ helpers

  private async writeHistory(entry: {
    deliveryId: string;
    from: string | null;
    to: DeliveryStatusValue;
    actorKind: ActorKind;
    actorId: string | null;
    detail: string | null;
    version: number;
    now: Date;
  }): Promise<void> {
    await this.select(
      `INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "actorKind", "actorId", "detail", "version", "at")
       VALUES (:deliveryId, :from, :to, :actorKind, :actorId, :detail, :version, :now) RETURNING "id"`,
      entry,
    );
  }

  /** Milestones only (never offer churn), in the same transaction as the move. */
  private async appendMilestone(
    delivery: DeliveryRecord,
    previous: DeliveryStatusValue | null,
  ): Promise<void> {
    const status = delivery.status;
    if (!(DELIVERY_MILESTONES as readonly string[]).includes(status)) return;
    await this.outbox.append(
      DeliveryStatusChanged.create(delivery.id, delivery.version, {
        deliveryId: delivery.id,
        orderId: delivery.orderId,
        shopId: delivery.shopId,
        buyerId: delivery.buyerId,
        status: status as (typeof DELIVERY_MILESTONES)[number],
        previousStatus: previous,
        courierId: delivery.courierId,
        reason: status === 'CANCELLED' ? delivery.cancelReason : null,
        feeMinor: delivery.feeMinor,
        currency: delivery.currency,
        deliveryVersion: delivery.version,
      }),
    );
  }
}
