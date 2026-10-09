import { v7 as uuidv7 } from 'uuid';
import {
  bands,
  hamming,
  ProcessedImage,
  processImage,
  RejectedImageError,
} from './image-pipeline';

/** Positional-parameter SQL runner ($1, $2…): backed by `pg.Pool` in the Lambda, by Sequelize `bind` in specs. */
export type Sql = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;
export interface Blobs {
  get(key: string): Promise<Buffer>;
  put(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
  ): Promise<void>;
}

const NEAR_DUPLICATE_BITS = 3;

/**
 * The media Lambda's core, framework-free (it is a "small" handler: sharp +
 * pg + S3, no Nest container to boot on cold start):
 *   originalKey → claim (PENDING_UPLOAD|PROCESSING → PROCESSING) → process →
 *   write content-addressed variants → READY + near-duplicate check +
 *   MediaReady outbox row in ONE transaction. Rejected uploads become REJECTED.
 * Re-running for the same key is harmless: variant keys are content hashes
 * and the final UPDATE only fires from PROCESSING.
 */
export class MediaProcessor {
  constructor(
    private readonly sql: Sql,
    private readonly tx: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
    private readonly blobs: Blobs,
  ) {}

  async process(
    originalKey: string,
  ): Promise<'READY' | 'REJECTED' | 'SKIPPED'> {
    const [media] = await this.sql<{
      id: string;
      shopId: string | null;
      status: string;
      purpose: string;
    }>(
      `UPDATE "Media" SET status = 'PROCESSING', "updatedAt" = now() WHERE "originalKey" = $1 AND status IN ('PENDING_UPLOAD', 'PROCESSING') RETURNING id, "shopId", status, purpose`,
      [originalKey],
    );
    if (!media) return 'SKIPPED'; // unknown key, or already READY/REJECTED (duplicate S3 event)

    let processed: ProcessedImage;
    try {
      processed = await processImage(await this.blobs.get(originalKey));
    } catch (error) {
      if (!(error instanceof RejectedImageError)) throw error; // transient (S3 down…) → retry via SQS
      await this.sql(
        `UPDATE "Media" SET status = 'REJECTED', "rejectReason" = $2, "updatedAt" = now() WHERE id = $1 AND status = 'PROCESSING'`,
        [media.id, error.message],
      );
      return 'REJECTED';
    }

    const variants: Record<
      string,
      { key: string; width: number; height: number }
    > = {};
    for (const [name, v] of Object.entries(processed.variants)) {
      const key = `media/derived/${v.hash}.webp`;
      await this.blobs.put(
        key,
        v.buffer,
        v.contentType,
        'public, max-age=31536000, immutable',
      );
      variants[name] = { key, width: v.width, height: v.height };
    }

    const [b0, b1, b2, b3] = bands(processed.dhash);
    const candidates = await this.sql<{ id: string; dhash: string }>(
      `SELECT id, dhash FROM "Media" WHERE status = 'READY' AND id <> $1 AND "shopId" IS DISTINCT FROM $2
         AND ("dhashB0" = $3 OR "dhashB1" = $4 OR "dhashB2" = $5 OR "dhashB3" = $6) LIMIT 200`,
      [media.id, media.shopId, b0, b1, b2, b3],
    );
    const duplicate = candidates.find(
      (c) => hamming(c.dhash, processed.dhash) <= NEAR_DUPLICATE_BITS,
    );

    await this.tx(async (sql) => {
      const updated = await sql(
        `UPDATE "Media" SET status = 'READY', variants = $2::jsonb, width = $3, height = $4, dhash = $5,
                "dhashB0" = $6, "dhashB1" = $7, "dhashB2" = $8, "dhashB3" = $9, "possibleDuplicateOf" = $10, "updatedAt" = now()
         WHERE id = $1 AND status = 'PROCESSING' RETURNING id`,
        [
          media.id,
          JSON.stringify(variants),
          processed.width,
          processed.height,
          processed.dhash,
          b0,
          b1,
          b2,
          b3,
          duplicate?.id ?? null,
        ],
      );
      if (updated.length === 0) return;
      const eventId = uuidv7(); // the envelope contract requires a UUIDv7
      await sql(
        `INSERT INTO "Outbox" (id, topic, "aggregateId", "aggregateType", "type", "eventName", payload, attempts, "nextAttemptAt", "createdAt")
         VALUES ($1, 'media.events', $2, 'media', 'media.ready', 'media.ready', $3::jsonb, 0, now(), now())`,
        [
          eventId,
          media.id,
          JSON.stringify({
            eventId,
            type: 'media.ready',
            version: 1,
            aggregateType: 'media',
            aggregateId: media.id,
            aggregateVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              mediaId: media.id,
              shopId: media.shopId,
              purpose: media.purpose,
              variants,
              possibleDuplicateOf: duplicate?.id ?? null,
            },
          }),
        ],
      );
    });
    return 'READY';
  }
}
