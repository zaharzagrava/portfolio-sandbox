import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { CourierVehicle } from '@marketplace-sandbox/contracts';
import type {
  AvailabilityOutcome,
  CourierRecord,
  CourierRepository,
  CourierSelfRecord,
  RegisterOutcome,
} from '../domain/delivery-ports';

const COLUMNS = `"id", "city", "vehicle", "status", "createdAt"`;

/**
 * `Courier` behind its port (S20 A18, A8): raw SQL with named replacements, no Sequelize model. A profile is its
 * user's: the id is in every predicate. Every write is one conditional statement, so the status rules hold without a
 * check-then-write: city and vehicle change only `WHERE status <> 'BUSY'` and no live offer; `OFFLINE <-> AVAILABLE`
 * only `WHERE status IN ('OFFLINE', 'AVAILABLE')`; `BUSY` is set and cleared by the delivery moves only. Joins the
 * caller's transaction through CLS.
 */
@Injectable()
export class CourierSqlRepository implements CourierRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object = CourierRecord>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async register(
    id: string,
    city: string,
    vehicle: CourierVehicle,
    now: Date,
  ): Promise<{
    outcome: RegisterOutcome;
    courier: CourierRecord;
    previousCity: string | null;
  }> {
    // `old` is the row as it was before this statement: the city to move the cache entries away from.
    const [written] = await this.select<
      CourierRecord & { inserted: boolean; previousCity: string | null }
    >(
      `WITH old AS (SELECT "city" FROM "Courier" WHERE "id" = :id)
       INSERT INTO "Courier" AS c ("id", "city", "vehicle", "createdAt")
       VALUES (:id, :city, :vehicle, :now)
       ON CONFLICT ("id") DO UPDATE SET "city" = EXCLUDED."city", "vehicle" = EXCLUDED."vehicle"
        WHERE (c."city" = EXCLUDED."city" AND c."vehicle" = EXCLUDED."vehicle")
           OR (c."status" <> 'BUSY'
               AND NOT EXISTS (SELECT 1 FROM "DeliveryOffer" o WHERE o."courierId" = c."id" AND o."status" = 'OFFERED'))
       RETURNING c."id", c."city", c."vehicle", c."status", c."createdAt", (xmax = 0) AS "inserted",
                 (SELECT "city" FROM old) AS "previousCity"`,
      { id, city, vehicle, now },
    );
    if (!written) {
      // The conflict clause refused the change: the courier is busy or holds a live offer.
      const current = await this.find(id);
      return { outcome: 'busy', courier: current!, previousCity: null };
    }
    const { inserted, previousCity, ...courier } = written;
    return {
      outcome: inserted ? 'created' : 'updated',
      courier,
      previousCity:
        previousCity && previousCity !== courier.city ? previousCity : null,
    };
  }

  async find(id: string): Promise<CourierRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "Courier" WHERE "id" = :id`,
      { id },
    );
    return row ?? null;
  }

  async findMany(ids: readonly string[]): Promise<CourierRecord[]> {
    if (ids.length === 0) return [];
    return this.select(
      `SELECT ${COLUMNS} FROM "Courier" WHERE "id" IN (:ids)`,
      { ids: [...ids] },
    );
  }

  async selfView(id: string, now: Date): Promise<CourierSelfRecord | null> {
    const courier = await this.find(id);
    if (!courier) return null;
    const [offer] = await this.select<{
      deliveryId: string;
      pickupLat: number;
      pickupLng: number;
      dropoffLat: number;
      dropoffLng: number;
      feeMinor: string | number;
      currency: string;
      expiresAt: Date;
    }>(
      `SELECT o."deliveryId", d."pickupLat", d."pickupLng", d."dropoffLat", d."dropoffLng", d."feeMinor", d."currency",
              o."expiresAt"
         FROM "DeliveryOffer" o JOIN "Delivery" d ON d."id" = o."deliveryId"
        WHERE o."courierId" = :id AND o."status" = 'OFFERED' AND o."expiresAt" > :now
        LIMIT 1`,
      { id, now },
    );
    const [active] = await this.select<{
      deliveryId: string;
      status: 'ASSIGNED' | 'PICKED_UP';
    }>(
      `SELECT "id" AS "deliveryId", "status" FROM "Delivery"
        WHERE "courierId" = :id AND "status" IN ('ASSIGNED', 'PICKED_UP') LIMIT 1`,
      { id },
    );
    return {
      courier,
      liveOffer: offer
        ? {
            deliveryId: offer.deliveryId,
            pickup: { lat: offer.pickupLat, lng: offer.pickupLng },
            dropoff: { lat: offer.dropoffLat, lng: offer.dropoffLng },
            feeMinor: Number(offer.feeMinor),
            currency: offer.currency,
            expiresAt: new Date(offer.expiresAt),
          }
        : null,
      activeDelivery: active ?? null,
    };
  }

  async setAvailability(
    id: string,
    available: boolean,
  ): Promise<{ outcome: AvailabilityOutcome; courier: CourierRecord } | null> {
    const to = available ? 'AVAILABLE' : 'OFFLINE';
    const [changed] = await this.select<CourierRecord>(
      `UPDATE "Courier" SET "status" = :to
        WHERE "id" = :id AND "status" IN ('OFFLINE', 'AVAILABLE') AND "status" <> :to
        RETURNING ${COLUMNS}`,
      { id, to },
    );
    if (changed) return { outcome: 'changed', courier: changed };
    const current = await this.find(id);
    if (!current) return null;
    return {
      outcome: current.status === to ? 'unchanged' : 'busy',
      courier: current,
    };
  }

  async markBusy(id: string): Promise<boolean> {
    return this.move(id, 'AVAILABLE', 'BUSY');
  }

  async markAvailable(id: string): Promise<boolean> {
    return this.move(id, 'BUSY', 'AVAILABLE');
  }

  private async move(
    id: string,
    from: 'AVAILABLE' | 'BUSY',
    to: 'AVAILABLE' | 'BUSY',
  ): Promise<boolean> {
    const rows = await this.select<{ id: string }>(
      `UPDATE "Courier" SET "status" = :to WHERE "id" = :id AND "status" = :from RETURNING "id"`,
      { id, from, to },
    );
    return rows.length === 1;
  }

  async isCityServed(city: string): Promise<boolean> {
    const rows = await this.select<{ one: number }>(
      `SELECT 1 AS "one" FROM "Courier" WHERE "city" = :city LIMIT 1`,
      { city },
    );
    return rows.length > 0;
  }

  async listCities(): Promise<string[]> {
    const rows = await this.select<{ city: string }>(
      `SELECT DISTINCT "city" FROM "Courier" ORDER BY "city"`,
      {},
    );
    return rows.map((r) => r.city);
  }
}
