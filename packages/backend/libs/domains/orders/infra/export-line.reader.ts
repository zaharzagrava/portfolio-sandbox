import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { ExportLinesPort } from '../domain/export-ports';
import type { KeysetPosition, RawExportRow } from '../domain/export-row';

interface LineRecord {
  orderId: string;
  shopOrderId: string;
  lineId: string;
  /** Microsecond-precision instant of the shop order, the keyset key (a millisecond Date would repeat rows). */
  keyAt: string;
  createdAt: Date;
  shopOrderStatus: string;
  currency: string;
  productId: string;
  title: string | null;
  quantity: number;
  unitPriceMinor: string;
  discountMinor: string;
  lineTotalMinor: string | null;
}

const KEY_AT = `to_char(so."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Reads a shop's order lines for the export (S12 FR-014, FR-015). Each batch is one short statement through the pool
 * (no transaction, no cursor, no connection held between batches). Rows are ordered and resumed by the keyset
 * (shop order creation time, shop order id, line id), so a batch boundary never skips or repeats a line, and only the
 * shop's own lines are read (`so.shopId` and `i.shopId`, a legacy line without a shop is in no export).
 */
@Injectable()
export class ExportLineReader implements ExportLinesPort {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async count(shopId: string, until: Date): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM "ShopOrder" so
         JOIN "BisOrderItem" i ON i."bisOrderId" = so."bisOrderId" AND i."shopId" = so."shopId"
        WHERE so."shopId" = :shopId AND so."createdAt" <= :until`,
      { type: QueryTypes.SELECT, replacements: { shopId, until } },
    );
    return Number(row.n);
  }

  async *batches(
    shopId: string,
    until: Date,
    position: KeysetPosition | null,
    batchSize: number,
  ): AsyncIterable<RawExportRow[]> {
    let last: { keyAt: string; shopOrderId: string; lineId: string } | null =
      position
        ? {
            keyAt: position.createdAt,
            shopOrderId: position.shopOrderId,
            lineId: position.lineId,
          }
        : null;
    for (;;) {
      const rows = await this.sequelize.query<LineRecord>(
        `SELECT o.id AS "orderId", so.id AS "shopOrderId", i.id AS "lineId", ${KEY_AT} AS "keyAt",
                so."createdAt" AS "createdAt", so.status AS "shopOrderStatus", o.currency AS currency,
                i."productId" AS "productId", i.title AS title, i.quantity AS quantity,
                i."priceAtPurchase"::text AS "unitPriceMinor", i."discountMinor"::text AS "discountMinor",
                i."lineTotalMinor"::text AS "lineTotalMinor"
           FROM "ShopOrder" so
           JOIN "BisOrder" o ON o.id = so."bisOrderId"
           JOIN "BisOrderItem" i ON i."bisOrderId" = so."bisOrderId" AND i."shopId" = so."shopId"
          WHERE so."shopId" = :shopId AND i."shopId" = :shopId AND so."createdAt" <= :until
            ${last ? `AND (so."createdAt", so.id, i.id) > (:keyAt::timestamptz, :afterShopOrder::uuid, :afterLine::uuid)` : ''}
          ORDER BY so."createdAt", so.id, i.id
          LIMIT :batchSize`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            shopId,
            until,
            batchSize,
            ...(last
              ? {
                  keyAt: last.keyAt,
                  afterShopOrder: last.shopOrderId,
                  afterLine: last.lineId,
                }
              : {}),
          },
        },
      );
      if (rows.length === 0) return;
      const tail = rows[rows.length - 1];
      last = {
        keyAt: tail.keyAt,
        shopOrderId: tail.shopOrderId,
        lineId: tail.lineId,
      };
      yield rows.map((r) => ({
        orderId: r.orderId,
        shopOrderId: r.shopOrderId,
        createdAt: new Date(r.createdAt),
        shopOrderStatus: r.shopOrderStatus,
        currency: r.currency,
        productId: r.productId,
        title: r.title,
        quantity: r.quantity,
        unitPriceMinor: r.unitPriceMinor,
        discountMinor: r.discountMinor,
        lineTotalMinor: r.lineTotalMinor,
      }));
      if (rows.length < batchSize) return;
    }
  }
}
