import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import type {
  ShopProductRow,
  ShopSearchRepository,
  ShopSearchRequest,
  ShopSearchRow,
} from '../../domain/ports';

const MAX_FALLBACK_WORDS = 8;
/** Average per-word trigram similarity a title must reach to be listed by the fallback. */
const TRIGRAM_THRESHOLD = 0.3;

type Upsert = ShopProductRow & {
  kind: 'created' | 'updated' | 'archived' | 'restored';
};

const COLUMNS = `"productId", "shopId", "title", "brand", "status", "priceMinor", "currency", "quantity", "isSandbox", "productVersion", "deletedAt", "updatedAt"`;

/**
 * `SearchShopProduct` write side (version guard in one statement, R-10 / data-model section 1). A tombstone is only
 * replaced by a `created` event of a higher version (a new product with a reused id); every other kind needs the row
 * to be alive.
 */
@Injectable()
export class SequelizeShopSearchRepository implements ShopSearchRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  async upsert(rows: Upsert[]): Promise<void> {
    if (rows.length === 0) return;
    const created = rows.filter((r) => r.kind === 'created');
    const rest = rows.filter((r) => r.kind !== 'created');
    await this.transactions.run(async (tx) => {
      if (created.length > 0)
        await this.write(
          created,
          `"SearchShopProduct"."productVersion" <= EXCLUDED."productVersion"
           AND ("SearchShopProduct"."deletedAt" IS NULL
                OR EXCLUDED."productVersion" > "SearchShopProduct"."productVersion")`,
          tx,
        );
      if (rest.length > 0)
        await this.write(
          rest,
          `"SearchShopProduct"."productVersion" <= EXCLUDED."productVersion"
           AND "SearchShopProduct"."deletedAt" IS NULL`,
          tx,
        );
    });
  }

  private async write(rows: Upsert[], guard: string, tx: unknown) {
    const at = new Date();
    await this.sequelize.query(
      `INSERT INTO "SearchShopProduct" (${COLUMNS})
       SELECT t."productId", t."shopId", t."title", t."brand", t."status", t."priceMinor", t."currency",
              t."quantity", t."isSandbox", t."productVersion", NULL, $11::timestamptz
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[],
                   $8::int[], $9::bool[], $10::bigint[])
            AS t("productId", "shopId", "title", "brand", "status", "priceMinor", "currency", "quantity", "isSandbox", "productVersion")
       ON CONFLICT ("productId") DO UPDATE SET
         "shopId" = EXCLUDED."shopId", "title" = EXCLUDED."title", "brand" = EXCLUDED."brand",
         "status" = EXCLUDED."status", "priceMinor" = EXCLUDED."priceMinor", "currency" = EXCLUDED."currency",
         "quantity" = EXCLUDED."quantity", "isSandbox" = EXCLUDED."isSandbox",
         "productVersion" = EXCLUDED."productVersion", "deletedAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"
       WHERE ${guard}`,
      {
        bind: [
          rows.map((r) => r.productId),
          rows.map((r) => r.shopId),
          rows.map((r) => r.title),
          rows.map((r) => r.brand),
          rows.map((r) => r.status),
          rows.map((r) => r.priceMinor),
          rows.map((r) => r.currency),
          rows.map((r) => r.quantity),
          rows.map((r) => r.isSandbox),
          rows.map((r) => r.productVersion),
          at,
        ],
        transaction: tx as never,
      },
    );
  }

  async markDeleted(
    rows: {
      productId: string;
      shopId: string;
      productVersion: number;
      at: Date;
    }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.sequelize.query(
      `INSERT INTO "SearchShopProduct" (${COLUMNS})
       SELECT t."productId", t."shopId", '', NULL, 'ARCHIVED', 0, 'XXX', 0, false, t."productVersion", t."at", t."at"
       FROM unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::timestamptz[])
            AS t("productId", "shopId", "productVersion", "at")
       ON CONFLICT ("productId") DO UPDATE SET
         "title" = '', "brand" = NULL, "productVersion" = EXCLUDED."productVersion",
         "deletedAt" = EXCLUDED."deletedAt", "updatedAt" = EXCLUDED."updatedAt"
       WHERE "SearchShopProduct"."productVersion" <= EXCLUDED."productVersion"
         AND "SearchShopProduct"."deletedAt" IS NULL`,
      {
        bind: [
          rows.map((r) => r.productId),
          rows.map((r) => r.shopId),
          rows.map((r) => r.productVersion),
          rows.map((r) => r.at),
        ],
      },
    );
  }

  async search(request: ShopSearchRequest): Promise<ShopSearchRow[]> {
    const { after } = request;
    if (after) return this.run(after.mode, request);
    const fts = await this.run('fts', request);
    return fts.length > 0 ? fts : this.run('trgm', request);
  }

  /**
   * One statement per mode, bind parameters only. The rank is cast to `float8` inside the inner query so the keyset
   * comparison of the next page sees exactly the value the previous page returned.
   */
  private async run(
    mode: 'fts' | 'trgm',
    r: ShopSearchRequest,
  ): Promise<ShopSearchRow[]> {
    // each query word is scored against its best-matching title word; eight words at most for the fallback
    const tokens = r.q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_FALLBACK_WORDS);
    if (mode === 'trgm' && tokens.length === 0) return [];
    const inner =
      mode === 'fts'
        ? `SELECT p."productId" AS id, p."title", p."priceMinor", p."currency", p."quantity", p."status",
                  ts_rank_cd(p."searchVector", query)::float8 AS rank
             FROM "SearchShopProduct" p, websearch_to_tsquery('simple', $2) query
            WHERE p."shopId" = $1 AND p."deletedAt" IS NULL AND p."searchVector" @@ query
              AND ($3::text IS NULL OR p."status" = $3)`
        : `SELECT p."productId" AS id, p."title", p."priceMinor", p."currency", p."quantity", p."status",
                  s.rank::float8 AS rank
             FROM "SearchShopProduct" p
             CROSS JOIN LATERAL (SELECT avg(word_similarity(t, p."title")) AS rank FROM unnest($2::text[]) t) s
            WHERE p."shopId" = $1 AND p."deletedAt" IS NULL AND s.rank >= ${TRIGRAM_THRESHOLD}
              AND ($3::text IS NULL OR p."status" = $3)`;
    const rows = await this.sequelize.query<{
      id: string;
      title: string;
      priceMinor: string | number;
      currency: string;
      quantity: number;
      status: 'ACTIVE' | 'ARCHIVED';
      rank: number;
    }>(
      `SELECT * FROM (${inner}) r
        WHERE $4::float8 IS NULL OR r.rank < $4::float8 OR (r.rank = $4::float8 AND r.id > $5::uuid)
        ORDER BY r.rank DESC, r.id ASC
        LIMIT $6`,
      {
        type: QueryTypes.SELECT,
        bind: [
          r.shopId,
          mode === 'fts' ? r.q : tokens,
          r.status ?? null,
          r.after?.rank ?? null,
          r.after?.id ?? null,
          r.limit,
        ],
      },
    );
    return rows.map((row) => ({
      ...row,
      priceMinor: Number(row.priceMinor),
      rank: Number(row.rank),
      mode,
    }));
  }

  async purgeShop(shopId: string): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "SearchShopProduct" WHERE "shopId" = $1`,
      { bind: [shopId] },
    );
  }

  async purgeTombstones(before: Date): Promise<number> {
    const rows = await this.sequelize.query<{ productId: string }>(
      `DELETE FROM "SearchShopProduct" WHERE "deletedAt" IS NOT NULL AND "deletedAt" < $1 RETURNING "productId"`,
      { type: QueryTypes.SELECT, bind: [before] },
    );
    return rows.length;
  }
}
