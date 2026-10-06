import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config/api-config.service';
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
  ) {}

  async createUpload(uploaderId: string, purpose: 'product' | 'review' | 'post', shopId: string | null) {
    if (purpose === 'product' && !shopId) throw new BadRequestException('product media belongs to a shop');
    // Server-generated key: the client can't choose (or overwrite) a path.
    const key = `media/originals/${shopId ? `shops/${shopId}` : `users/${uploaderId}`}/${v4()}`;
    const [media] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Media" ("shopId", "uploaderId", purpose, "originalKey") VALUES (:shopId, :uploaderId, :purpose, :key) RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { shopId, uploaderId, purpose, key } },
    );
    const upload = await this.storage.presignPost({ key, contentTypePrefix: 'image/', maxBytes: MAX_BYTES, expiresInSec: 600 });
    return { mediaId: media.id, upload, maxBytes: MAX_BYTES };
  }

  /**
   * In AWS the bucket notifies SQS on ObjectCreated (no client call needed).
   * Locally (MinIO) - and as a belt-and-braces path - the client confirms;
   * we verify the object really exists before enqueueing.
   */
  async complete(mediaId: string, uploaderId: string) {
    const [media] = await this.sequelize.query<{ originalKey: string; status: string }>(`SELECT "originalKey", status FROM "Media" WHERE id = :mediaId AND "uploaderId" = :uploaderId`, {
      type: QueryTypes.SELECT,
      replacements: { mediaId, uploaderId },
    });
    if (!media) throw new NotFoundException('Media not found');
    if (media.status !== 'PENDING_UPLOAD') return { status: media.status };
    if (!(await this.storage.head(media.originalKey))) throw new BadRequestException('Upload not found in storage yet');
    await this.queue.enqueue(MEDIA_QUEUE, { originalKey: media.originalKey });
    return { status: 'PROCESSING' };
  }

  async get(mediaId: string): Promise<MediaView> {
    const [m] = await this.sequelize.query<{ id: string; status: string; purpose: string; variants: Record<string, { key: string }> | null; width: number | null; height: number | null; rejectReason: string | null }>(
      `SELECT id, status, purpose, variants, width, height, "rejectReason" FROM "Media" WHERE id = :mediaId`,
      { type: QueryTypes.SELECT, replacements: { mediaId } },
    );
    if (!m) throw new NotFoundException('Media not found');
    const cdn = this.config.get('media_cdn_url') ?? `${this.config.get('s3_endpoint') ?? ''}/${this.config.get('media_bucket') ?? 'marketplace-media'}`;
    return { ...m, urls: m.variants ? Object.fromEntries(Object.entries(m.variants).map(([name, v]) => [name, `${cdn}/${v.key}`])) : null };
  }

  /** Gallery order for a product; only READY media of the same shop can be attached. */
  async attachToProduct(shopId: string, productId: string, mediaIds: string[]) {
    await this.sequelize.transaction(async (transaction) => {
      const ok = await this.sequelize.query<{ id: string }>(
        `SELECT m.id FROM "Media" m JOIN "Product" p ON p.id = :productId AND p."shopId" = :shopId WHERE m.id IN (:mediaIds) AND m."shopId" = :shopId AND m.status = 'READY'`,
        { type: QueryTypes.SELECT, replacements: { productId, shopId, mediaIds }, transaction },
      );
      if (ok.length !== mediaIds.length) throw new BadRequestException('Every media must be READY and belong to this shop');
      await this.sequelize.query(`DELETE FROM "ProductMedia" WHERE "productId" = :productId`, { replacements: { productId }, transaction });
      for (const [position, mediaId] of mediaIds.entries()) {
        await this.sequelize.query(`INSERT INTO "ProductMedia" ("productId", "mediaId", position) VALUES (:productId, :mediaId, :position)`, { replacements: { productId, mediaId, position }, transaction });
      }
    });
  }
}
