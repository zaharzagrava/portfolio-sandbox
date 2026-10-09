import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import { DomainEventsService } from '@app/infrastructure/events/domain-events.service';
import { PickupStockChanged } from './events/pickup-events';

export interface PickupPointNear {
  id: string;
  shopId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceM: number;
}

/**
 * Source of truth for pickup points and per-point stock (PostGIS). Radius
 * queries use `ST_DWithin` on geography (meters, index-assisted), ordered by
 * exact distance - correct across cell/geohash boundaries without the
 * "query the 8 neighbouring cells" trick a KV store would need.
 */
@Injectable()
export class PickupService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
    private readonly events: DomainEventsService,
  ) {}

  async createPoint(
    shopId: string,
    input: {
      name: string;
      address: string;
      lat: number;
      lng: number;
      openingHours?: object;
    },
  ) {
    const [row] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "PickupPoint" ("shopId", name, address, location, "openingHours")
       VALUES (:shopId, :name, :address, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, CAST(:hours AS JSONB)) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          ...input,
          hours: JSON.stringify(input.openingHours ?? {}),
        },
      },
    );
    return { id: row.id, ...input, shopId };
  }

  /** Upsert stock + outbox event in one transaction (version bump → idempotent, ordered indexing). */
  async setStock(
    shopId: string,
    pickupPointId: string,
    productId: string,
    quantity: number,
  ) {
    return this.tx.run(async (transaction) => {
      const [point] = await this.sequelize.query<{ lat: number; lng: number }>(
        `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM "PickupPoint" WHERE id = :id AND "shopId" = :shopId AND active`,
        {
          type: QueryTypes.SELECT,
          replacements: { id: pickupPointId, shopId },
          transaction,
        },
      );
      if (!point) throw new NotFoundException('Pickup point not found');

      const [stock] = await this.sequelize.query<{ version: number }>(
        `INSERT INTO "PickupStock" ("pickupPointId", "productId", quantity) VALUES (:pickupPointId, :productId, :quantity)
         ON CONFLICT ("pickupPointId", "productId") DO UPDATE SET quantity = EXCLUDED.quantity, version = "PickupStock".version + 1, "updatedAt" = now()
         RETURNING version`,
        {
          type: QueryTypes.SELECT,
          replacements: { pickupPointId, productId, quantity },
          transaction,
        },
      );
      await this.events.record(
        PickupStockChanged.create(
          `${pickupPointId}:${productId}`,
          stock.version,
          {
            pickupPointId,
            productId,
            shopId,
            quantity,
            lat: point.lat,
            lng: point.lng,
          },
        ),
        transaction,
      );
      return { pickupPointId, productId, quantity, version: stock.version };
    });
  }

  async near(
    lat: number,
    lng: number,
    radiusKm: number,
    productId?: string,
    limit = 50,
  ): Promise<PickupPointNear[]> {
    return this.sequelize.query<PickupPointNear>(
      `SELECT p.id, p."shopId", p.name, p.address, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
              round(ST_Distance(p.location, me.point))::int AS "distanceM"
       FROM "PickupPoint" p
       CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography AS point) me
       WHERE p.active AND ST_DWithin(p.location, me.point, :radiusM)
         AND (CAST(:productId AS uuid) IS NULL OR EXISTS (
               SELECT 1 FROM "PickupStock" s WHERE s."pickupPointId" = p.id AND s."productId" = CAST(:productId AS uuid) AND s.quantity > 0))
       ORDER BY p.location <-> me.point
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          lat,
          lng,
          radiusM: radiusKm * 1000,
          productId: productId ?? null,
          limit,
        },
      },
    );
  }

  /** Exact check at reservation time - search results are eventually consistent (lesson 10/09 #37). */
  async availableAt(
    pickupPointId: string,
    productId: string,
    quantity: number,
  ): Promise<boolean> {
    const [row] = await this.sequelize.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "PickupStock" WHERE "pickupPointId" = :p AND "productId" = :pr AND quantity >= :q) AS ok`,
      {
        type: QueryTypes.SELECT,
        replacements: { p: pickupPointId, pr: productId, q: quantity },
      },
    );
    return row.ok;
  }
}
