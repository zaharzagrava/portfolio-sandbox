import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { ProductQueryService } from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';

export const MEDIA_QUEUE = 'media-processing';
const MAX_BYTES = 15 * 1024 * 1024;

export interface MediaView {
  id: string;
  status: string;
  purpose: string;
  urls: Record<string, string> | null;
  width: number | null;
  height: number | null;
  rejectReason: string | null;
}

/**
 * The API never touches image bytes (10/05 #10): it creates the record,
 * hands out a presigned POST whose POLICY enforces the key, an image/*
 * content type and the 15 MB limit at S3 itself, and reads results.
 */
@Injectable()
export class MediaService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly config: ApiConfigService,
    private readonly products: ProductQueryService,
    private readonly transactions: TransactionRunner,
  ) {}

  async createUpload(
    uploaderId: string,
    purpose: 'product' | 'review' | 'post',
    shopId: string | null,
  ) {
    if (purpose === 'product' && !shopId)
      throw new BadRequestException('product media belongs to a shop');
    // Server-generated key: the client can't choose (or overwrite) a path.
    const key = `media/originals/${shopId ? `shops/${shopId}` : `users/${uploaderId}`}/${v4()}`;
    const [media] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Media" ("shopId", "uploaderId", purpose, "originalKey") VALUES (:shopId, :uploaderId, :purpose, :key) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, uploaderId, purpose, key },
      },
    );
    const upload = await this.storage.presignPost({
      key,
      contentTypePrefix: 'image/',
      maxBytes: MAX_BYTES,
      expiresInSec: 600,
    });
    return { mediaId: media.id, upload, maxBytes: MAX_BYTES };
  }

  /**
   * In AWS the bucket notifies SQS on ObjectCreated (no client call needed).
   * Locally (MinIO) - and as a belt-and-braces path - the client confirms;
   * we verify the object really exists before enqueueing.
   */
  async complete(mediaId: string, uploaderId: string) {
    const [media] = await this.sequelize.query<{
      originalKey: string;
      status: string;
    }>(
      `SELECT "originalKey", status FROM "Media" WHERE id = :mediaId AND "uploaderId" = :uploaderId`,
      {
        type: QueryTypes.SELECT,
        replacements: { mediaId, uploaderId },
      },
    );
    if (!media) throw new NotFoundException('Media not found');
    if (media.status !== 'PENDING_UPLOAD') return { status: media.status };
    if (!(await this.storage.head(media.originalKey)))
      throw new BadRequestException('Upload not found in storage yet');
    await this.queue.enqueue(MEDIA_QUEUE, { originalKey: media.originalKey });
    return { status: 'PROCESSING' };
  }

  async get(mediaId: string): Promise<MediaView> {
    const [m] = await this.sequelize.query<{
      id: string;
      status: string;
      purpose: string;
      variants: Record<string, { key: string }> | null;
      width: number | null;
      height: number | null;
      rejectReason: string | null;
    }>(
      `SELECT id, status, purpose, variants, width, height, "rejectReason" FROM "Media" WHERE id = :mediaId`,
      { type: QueryTypes.SELECT, replacements: { mediaId } },
    );
    if (!m) throw new NotFoundException('Media not found');
    const cdn = this.cdnBase();
    return {
      ...m,
      urls: m.variants
        ? Object.fromEntries(
            Object.entries(m.variants).map(([name, v]) => [
              name,
              `${cdn}/${v.key}`,
            ]),
          )
        : null,
    };
  }

  /**
   * Public gallery (W02 B-1): READY media of a publicly visible product, by position. Hidden and unknown products
   * are the same `NotFoundException`; visibility comes from the catalog's R1 service, never its tables.
   */
  async publicGallery(productId: string): Promise<{
    items: Array<{
      mediaId: string;
      position: number;
      urls: { thumb: string; feed: string; full: string };
      width: number | null;
      height: number | null;
    }>;
  }> {
    if (!(await this.products.isPubliclyVisible(productId)))
      throw new NotFoundException('Product not found');
    const rows = await this.sequelize.query<{
      id: string;
      position: number;
      variants: Record<string, { key: string }>;
      width: number | null;
      height: number | null;
    }>(
      `SELECT m.id, pm.position, m.variants, m.width, m.height
         FROM "ProductMedia" pm JOIN "Media" m ON m.id = pm."mediaId"
        WHERE pm."productId" = :productId AND m.status = 'READY' AND m.variants IS NOT NULL
        ORDER BY pm.position, m.id`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    const cdn = this.cdnBase();
    const url = (v: { key: string } | undefined) => (v ? `${cdn}/${v.key}` : '');
    return {
      items: rows
        .filter((r) => r.variants.thumb && r.variants.feed && r.variants.full)
        .map((r) => ({
          mediaId: r.id,
          position: r.position,
          urls: {
            thumb: url(r.variants.thumb),
            feed: url(r.variants.feed),
            full: url(r.variants.full),
          },
          width: r.width,
          height: r.height,
        })),
    };
  }

  private cdnBase(): string {
    return (
      this.config.get('media_cdn_url') ??
      `${this.config.get('s3_endpoint') ?? ''}/${this.config.get('media_bucket') ?? 'marketplace-media'}`
    );
  }

  /** Gallery order for a product; only READY media of the same shop can be attached. */
  async attachToProduct(shopId: string, productId: string, mediaIds: string[]) {
    await this.transactions.run(async (transaction) => {
      const ok = await this.sequelize.query<{ id: string }>(
        `SELECT m.id FROM "Media" m JOIN "Product" p ON p.id = :productId AND p."shopId" = :shopId WHERE m.id IN (:mediaIds) AND m."shopId" = :shopId AND m.status = 'READY'`,
        {
          type: QueryTypes.SELECT,
          replacements: { productId, shopId, mediaIds },
          transaction,
        },
      );
      if (ok.length !== mediaIds.length)
        throw new BadRequestException(
          'Every media must be READY and belong to this shop',
        );
      await this.sequelize.query(
        `DELETE FROM "ProductMedia" WHERE "productId" = :productId`,
        { replacements: { productId }, transaction },
      );
      for (const [position, mediaId] of mediaIds.entries()) {
        await this.sequelize.query(
          `INSERT INTO "ProductMedia" ("productId", "mediaId", position) VALUES (:productId, :mediaId, :position)`,
          { replacements: { productId, mediaId, position }, transaction },
        );
      }
    });
  }
}
