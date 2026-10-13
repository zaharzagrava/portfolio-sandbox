import { appendWithExecutor } from '@app/infrastructure/outbox/append-with-executor';
import { MediaGalleryChanged } from '../domain/media-events';
import type {
  AttachFailure,
  GalleryRepository,
  GalleryRow,
  SqlRunner,
} from '../domain/ports';

/**
 * `ProductGallery` (version row) and `ProductMedia` (ordered links), both owned by media since S29. The version row is
 * locked `FOR UPDATE` by each replace, so two writers with the same `expectedVersion` cannot both win (III.6, AS-35).
 */
export class PgGalleryRepository implements GalleryRepository {
  constructor(private readonly sql: SqlRunner) {}

  async lockVersion(
    productId: string,
    shopId: string,
    now: Date,
  ): Promise<number> {
    await this.sql(
      `INSERT INTO "ProductGallery" ("productId", "shopId", "version", "updatedAt")
       VALUES ($1, $2, 0, $3) ON CONFLICT ("productId") DO NOTHING`,
      [productId, shopId, now],
    );
    const [row] = await this.sql<{ version: number }>(
      `SELECT "version" FROM "ProductGallery" WHERE "productId" = $1 FOR UPDATE`,
      [productId],
    );
    return row.version;
  }

  async classify(mediaIds: string[], shopId: string): Promise<AttachFailure[]> {
    if (mediaIds.length === 0) return [];
    // Unknown, other-shop, review and deleted photos are all "not found": nobody can probe another shop's ids.
    const rows = await this.sql<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "Media"
        WHERE "id" = ANY($1::uuid[]) AND "shopId" = $2 AND "purpose" = 'product' AND "status" <> 'DELETED'
        FOR SHARE`,
      [mediaIds, shopId],
    );
    const status = new Map(rows.map((r) => [r.id, r.status]));
    const failures: AttachFailure[] = [];
    for (const mediaId of mediaIds) {
      const found = status.get(mediaId);
      if (found === undefined) failures.push({ mediaId, code: 'not_found' });
      else if (found !== 'READY') failures.push({ mediaId, code: 'not_ready' });
    }
    return failures;
  }

  async currentIds(productId: string): Promise<string[]> {
    const rows = await this.sql<{ mediaId: string }>(
      `SELECT "mediaId" FROM "ProductMedia" WHERE "productId" = $1 ORDER BY "position"`,
      [productId],
    );
    return rows.map((r) => r.mediaId);
  }

  async replace(input: {
    productId: string;
    shopId: string;
    mediaIds: string[];
    version: number;
    now: Date;
  }): Promise<number> {
    await this.sql(`DELETE FROM "ProductMedia" WHERE "productId" = $1`, [
      input.productId,
    ]);
    if (input.mediaIds.length > 0)
      await this.sql(
        `INSERT INTO "ProductMedia" ("productId", "mediaId", "position")
         SELECT $1, t.media, (t.ord - 1)::smallint FROM unnest($2::uuid[]) WITH ORDINALITY AS t(media, ord)`,
        [input.productId, input.mediaIds],
      );
    const [row] = await this.sql<{ version: number }>(
      `UPDATE "ProductGallery" SET "version" = "version" + 1, "updatedAt" = $2
        WHERE "productId" = $1 RETURNING "version"`,
      [input.productId, input.now],
    );
    await appendWithExecutor(
      { query: (text, params) => this.sql(text, params) },
      MediaGalleryChanged.create(
        input.productId,
        row.version,
        {
          productId: input.productId,
          shopId: input.shopId,
          mediaIds: input.mediaIds,
          galleryVersion: row.version,
        },
        input.now,
      ),
      { now: input.now },
    );
    return row.version;
  }

  async readItems(productId: string): Promise<GalleryRow[]> {
    return this.sql<GalleryRow>(
      `SELECT m."id" AS "mediaId", pm."position"::int AS "position", m."variants", m."width", m."height"
         FROM "ProductMedia" pm JOIN "Media" m ON m."id" = pm."mediaId"
        WHERE pm."productId" = $1 AND m."status" = 'READY' AND m."variants" IS NOT NULL
        ORDER BY pm."position", m."id"`,
      [productId],
    );
  }

  async version(productId: string): Promise<number> {
    const [row] = await this.sql<{ version: number }>(
      `SELECT "version" FROM "ProductGallery" WHERE "productId" = $1`,
      [productId],
    );
    return row?.version ?? 0;
  }

  async deleteForProduct(productId: string): Promise<number> {
    const links = await this.sql(
      `DELETE FROM "ProductMedia" WHERE "productId" = $1 RETURNING "mediaId"`,
      [productId],
    );
    const rows = await this.sql(
      `DELETE FROM "ProductGallery" WHERE "productId" = $1 RETURNING "productId"`,
      [productId],
    );
    return links.length + rows.length;
  }

  async deleteForShop(shopId: string): Promise<number> {
    const links = await this.sql(
      `DELETE FROM "ProductMedia" WHERE "productId" IN (SELECT "productId" FROM "ProductGallery" WHERE "shopId" = $1) RETURNING "mediaId"`,
      [shopId],
    );
    const rows = await this.sql(
      `DELETE FROM "ProductGallery" WHERE "shopId" = $1 RETURNING "productId"`,
      [shopId],
    );
    return links.length + rows.length;
  }
}
