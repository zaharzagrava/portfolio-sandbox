import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import QueryStream from 'pg-query-stream';
import { stringify } from 'csv-stringify';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Transform } from 'node:stream';
import type { PoolClient } from 'pg';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';

/**
 * Exports still ride catalog-sync's import queue: its worker consumes `{ kind: 'export' }` messages
 * (debt D-10). A literal, not an import, so orders never depends on catalog-sync; D-10 gives
 * exports an orders-owned queue.
 */
const EXPORT_QUEUE = 'catalog-imports';

/**
 * Order export in constant memory (02/02 §4): a server-side Postgres CURSOR
 * (pg-query-stream fetches 1,000 rows at a time) → CSV stringify → S3
 * multipart upload, all one `pipeline()`: if S3 slows down, backpressure
 * propagates up to the cursor and Postgres simply waits. 10 rows or 10M,
 * the worker holds about one batch.
 */
@Injectable()
export class OrderExportService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly realtime: RealtimePublisher,
  ) {}

  async request(shopId: string, userId: string) {
    const [job] = await this.sequelize.query<{ id: string }>(`INSERT INTO "ExportJob" ("shopId", "createdBy", kind) VALUES (:shopId, :userId, 'orders') RETURNING id`, {
      type: QueryTypes.SELECT,
      replacements: { shopId, userId },
    });
    await this.queue.enqueue(EXPORT_QUEUE, { kind: 'export', jobId: job.id });
    return { jobId: job.id, status: 'QUEUED' };
  }

  async status(shopId: string, jobId: string) {
    const [job] = await this.sequelize.query<{ status: string; rows: number; objectKey: string | null }>(`SELECT status, rows, "objectKey" FROM "ExportJob" WHERE id = :jobId AND "shopId" = :shopId`, {
      type: QueryTypes.SELECT,
      replacements: { jobId, shopId },
    });
    if (!job) throw new NotFoundException('Export not found');
    return { ...job, downloadUrl: job.status === 'DONE' && job.objectKey ? await this.storage.presignGet(job.objectKey, { expiresInSec: 600, downloadName: `orders-${jobId}.csv` }) : null };
  }

  async run(jobId: string): Promise<number> {
    const [job] = await this.sequelize.query<{ shopId: string; status: string }>(`UPDATE "ExportJob" SET status = 'RUNNING', "updatedAt" = now() WHERE id = :jobId AND status IN ('QUEUED', 'RUNNING') RETURNING "shopId", status`, {
      type: QueryTypes.SELECT,
      replacements: { jobId },
    });
    if (!job) return 0;
    const key = `exports/${job.shopId}/${jobId}/orders.csv`;
    const client = (await (this.sequelize.connectionManager as unknown as { getConnection(o: object): Promise<PoolClient> }).getConnection({ type: 'read' })) as PoolClient;
    let rows = 0;
    try {
      const cursor = client.query(
        new QueryStream(
          `SELECT so.id, so."createdAt", so.status, so.subtotal, o.currency, i."productId", p."externalSku", p.title, i.quantity, i."priceAtPurchase"
           FROM "ShopOrder" so JOIN "BisOrder" o ON o.id = so."bisOrderId"
           JOIN "BisOrderItem" i ON i."bisOrderId" = so."bisOrderId" AND i."shopId" = so."shopId"
           LEFT JOIN "Product" p ON p.id = i."productId"
           WHERE so."shopId" = $1 ORDER BY so."createdAt"`,
          [job.shopId],
          { batchSize: 1_000 },
        ),
      );
      const body = new PassThrough();
      const upload = this.storage.put(key, body, 'text/csv');
      await pipeline(
        cursor,
        new Transform({
          objectMode: true,
          transform(row: Record<string, unknown>, _enc, done) {
            rows++;
            done(null, [row.id, new Date(row.createdAt as string).toISOString(), row.status, row.currency, row.productId, row.externalSku ?? '', row.title ?? '', row.quantity, row.priceAtPurchase]);
          },
        }),
        stringify({ header: true, columns: ['order_id', 'created_at', 'status', 'currency', 'product_id', 'sku', 'title', 'quantity', 'unit_price_minor'] }),
        body,
      );
      await upload;
    } catch (error) {
      await this.sequelize.query(`UPDATE "ExportJob" SET status = 'FAILED', error = :error WHERE id = :jobId`, { replacements: { error: (error as Error).message.slice(0, 500), jobId } });
      throw error;
    } finally {
      await (this.sequelize.connectionManager as unknown as { releaseConnection(c: PoolClient): Promise<void> }).releaseConnection(client);
    }
    await this.sequelize.query(`UPDATE "ExportJob" SET status = 'DONE', "objectKey" = :key, rows = :rows, "updatedAt" = now() WHERE id = :jobId`, { replacements: { key, rows, jobId } });
    await this.realtime.publish(`job:${jobId}`, 'done', { rows });
    return rows;
  }
}
