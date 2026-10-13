import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { PickupPointNear } from '@marketplace-sandbox/contracts';
import { TransactionRunner } from '@app/infrastructure/context';
import type { BrowseParams, PickupBrowseReader } from '../domain/pickup-ports';
import { ServiceUnavailableError } from '../domain/pickup-errors';

/** Statement limit of the exact browse in milliseconds (S19 FR-025); a spec lowers it to prove the cancel. */
export const PICKUP_BROWSE_TIMEOUT_MS = Symbol('PICKUP_BROWSE_TIMEOUT_MS');
export const DEFAULT_BROWSE_TIMEOUT_MS = 2_000;

interface Row {
  id: string;
  shopId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  openingHours: PickupPointNear['openingHours'];
  sortDistance: number;
  quantity: number | null;
}

/**
 * The exact browse (S19 FR-025, R-2): `ST_DWithin` on geography (index-assisted, boundary included), ordered by the
 * spheroid distance then `id`, keyset-paged. Visibility mirrors `isOfferVisible` against this domain's copy tables:
 * an `ACTIVE` shop copy and an active point always; with a product, stock above zero and a product copy that is
 * neither archived nor sandbox. One read-only statement under `SET LOCAL statement_timeout`; a cancelled or failed
 * statement is the generic `503`.
 */
@Injectable()
export class PickupBrowseSqlReader implements PickupBrowseReader {
  private readonly logger = new Logger(PickupBrowseSqlReader.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
    @Inject(PICKUP_BROWSE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async browse(params: BrowseParams) {
    try {
      const rows = await this.tx.run(
        () =>
          this.sequelize.query<Row>(
            `SELECT p."id", p."shopId", p."name", p."address",
                    ST_Y(p."location"::geometry) AS "lat", ST_X(p."location"::geometry) AS "lng",
                    p."openingHours",
                    ST_Distance(p."location", me.point) AS "sortDistance",
                    s."quantity"
               FROM "PickupPoint" p
               JOIN "PickupShopCopy" sc ON sc."shopId" = p."shopId" AND sc."status" = 'ACTIVE'
              CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography AS point) me
               LEFT JOIN "PickupStock" s ON s."pickupPointId" = p."id" AND s."productId" = CAST(:productId AS uuid)
              WHERE p."active"
                AND ST_DWithin(p."location", me.point, :radiusM)
                AND (CAST(:productId AS uuid) IS NULL OR (
                      s."quantity" > 0 AND EXISTS (
                        SELECT 1 FROM "PickupProductCopy" pc
                         WHERE pc."productId" = s."productId" AND pc."status" <> 'ARCHIVED' AND NOT pc."isSandbox")))
                AND (CAST(:afterDistance AS float8) IS NULL
                     OR (ST_Distance(p."location", me.point), p."id") > (CAST(:afterDistance AS float8), CAST(:afterId AS uuid)))
              ORDER BY ST_Distance(p."location", me.point) ASC, p."id" ASC
              LIMIT :limit`,
            {
              type: QueryTypes.SELECT,
              replacements: {
                lat: params.lat,
                lng: params.lng,
                radiusM: params.radiusKm * 1000,
                productId: params.productId ?? null,
                limit: params.limit,
                afterDistance: params.after?.[0] ?? null,
                afterId: params.after?.[1] ?? null,
              },
            },
          ),
        { statementTimeoutMs: this.timeoutMs, propagation: 'requires_new' },
      );
      return rows.map((r) => ({
        id: r.id,
        shopId: r.shopId,
        name: r.name,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        distanceM: Math.round(r.sortDistance),
        openingHours: r.openingHours,
        ...(params.productId ? { quantity: r.quantity ?? 0 } : {}),
        sortDistance: r.sortDistance,
      }));
    } catch (error) {
      // 57014 = statement timeout: the store has cancelled the statement, nothing keeps running
      this.logger.warn(`pickup browse failed: ${(error as Error).message}`);
      throw new ServiceUnavailableError();
    }
  }
}
