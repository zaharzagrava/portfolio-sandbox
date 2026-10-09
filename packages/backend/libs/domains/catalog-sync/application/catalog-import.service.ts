import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { PassThrough, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { ApiConfigService } from '@app/common/config';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { RateLimiterService } from '@app/infrastructure/rate-limit/rate-limiter.service';
import { ProductChanged } from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import { scanStream } from '../infra/clamav';
import { CatalogRow, sniff } from '../domain/rows';

export const IMPORT_QUEUE = 'catalog-imports';
const PART_SIZE = 64 * 1024 * 1024;
const MAX_SIZE = 5 * 1024 * 1024 * 1024;
const BATCH = 1_000;

interface Job {
  id: string;
  shopId: string;
  createdBy: string;
  status: string;
  objectKey: string;
  uploadId: string | null;
  checkpointRow: number;
  rowsProcessed: number;
  rowsFailed: number;
}

export class ShopBusyError extends Error {}

@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly realtime: RealtimePublisher,
    private readonly limiter: RateLimiterService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Multipart upload (10/08 #27): the browser PUTs 64 MB parts straight to S3
   * in parallel (resumable part by part); the API only signs. An S3 lifecycle
   * rule aborts uploads never completed (orphaned parts cost money).
   */
  async start(
    shopId: string,
    userId: string,
    fileName: string,
    sizeBytes: number,
  ) {
    if (sizeBytes <= 0 || sizeBytes > MAX_SIZE)
      throw new BadRequestException('1 byte - 5 GB');
    const parts = Math.max(1, Math.ceil(sizeBytes / PART_SIZE));
    const [job] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "ImportJob" ("shopId", "createdBy", "fileName", "objectKey", "sizeBytes") VALUES (:shopId, :userId, :fileName, 'pending/' || gen_random_uuid(), :sizeBytes) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          userId,
          fileName: fileName.slice(0, 200),
          sizeBytes,
        },
      },
    );
    const objectKey = `imports/${shopId}/${job.id}/source`;
    const upload = await this.storage.createMultipartUpload(
      objectKey,
      'application/octet-stream',
      parts,
      3_600,
    );
    await this.sequelize.query(
      `UPDATE "ImportJob" SET "objectKey" = :objectKey, "uploadId" = :uploadId WHERE id = :id`,
      { replacements: { objectKey, uploadId: upload.uploadId, id: job.id } },
    );
    return { jobId: job.id, partSize: PART_SIZE, ...upload };
  }

  async complete(
    shopId: string,
    jobId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const job = await this.job(jobId, shopId);
    if (job.status !== 'PENDING_UPLOAD') return { status: job.status };
    await this.storage.completeMultipartUpload(
      job.objectKey,
      job.uploadId!,
      parts,
    );
    await this.sequelize.query(
      `UPDATE "ImportJob" SET status = 'UPLOADED', "updatedAt" = now() WHERE id = :jobId`,
      { replacements: { jobId } },
    );
    await this.queue.enqueue(IMPORT_QUEUE, { kind: 'import', jobId });
    return { status: 'UPLOADED' };
  }

  async status(shopId: string, jobId: string) {
    const job = await this.job(jobId, shopId);
    const [row] = await this.sequelize.query<{
      errorReportKey: string | null;
      fileName: string;
    }>(
      `SELECT "errorReportKey", "fileName" FROM "ImportJob" WHERE id = :jobId`,
      {
        type: QueryTypes.SELECT,
        replacements: { jobId },
      },
    );
    return {
      ...job,
      // User files are served from the storage domain as attachments (never rendered inline on our origin).
      errorReportUrl: row.errorReportKey
        ? await this.storage.presignGet(row.errorReportKey, {
            expiresInSec: 600,
            downloadName: `errors-${row.fileName}.csv`,
          })
        : null,
    };
  }

  /**
   * Worker side (apps/worker, not Lambda: a 5 GB file can run longer than
   * Lambda's 15 minutes). Memory stays flat regardless of file size:
   *   S3 stream → parser (async iteration = backpressure: the parser pauses
   *   while a batch is being written) → 1,000-row batches → one upsert each.
   * Checkpoint after every batch: a crash resumes from the last committed row
   * (re-parsing skipped rows is cheap; re-writing them is idempotent anyway).
   */
  async process(jobId: string, signal?: AbortSignal): Promise<string> {
    const [job] = await this.sequelize.query<Job>(
      `SELECT * FROM "ImportJob" WHERE id = :jobId`,
      { type: QueryTypes.SELECT, replacements: { jobId } },
    );
    if (!job || ['DONE', 'FAILED', 'PENDING_UPLOAD'].includes(job.status))
      return job?.status ?? 'MISSING';
    const release = await this.limiter.acquire(
      'imports.concurrent',
      job.shopId,
    );
    if (!release)
      throw new ShopBusyError(
        `shop ${job.shopId} already has an import running`,
      );
    try {
      return await this.run(job, signal);
    } catch (error) {
      if (signal?.aborted) throw error; // shutdown: leave PROCESSING + checkpoint, the message will be redelivered
      await this.setStatus(
        job.id,
        'FAILED',
        (error as Error).message.slice(0, 500),
      );
      throw error;
    } finally {
      await release();
    }
  }

  private async run(job: Job, signal?: AbortSignal): Promise<string> {
    if (job.status === 'UPLOADED' || job.status === 'SCANNING') {
      await this.setStatus(job.id, 'SCANNING');
      const clamav = this.config.get('clamav_host');
      if (clamav) {
        const [host, port] = clamav.split(':');
        const verdict = await scanStream(
          host,
          Number(port ?? 3310),
          await this.storage.getStream(job.objectKey),
        );
        if (!verdict.clean)
          return this.fail(job, `malware detected: ${verdict.signature}`);
      }
    }

    const head = await this.firstBytes(job.objectKey, 4096);
    const format = sniff(head);
    if (format === 'binary')
      return this.fail(job, 'not a CSV or JSONL text file');
    await this.setStatus(job.id, 'PROCESSING');

    const errors = stringify({
      header: true,
      columns: ['row', 'sku', 'error'],
    });
    const errorsKey = `imports/${job.shopId}/${job.id}/errors.csv`;
    const errorsUpload = this.storage.put(
      errorsKey,
      errors.pipe(new PassThrough()),
      'text/csv',
    );

    let row = 0;
    let processed = job.rowsProcessed;
    let failed = job.rowsFailed;
    let batch: { row: number; data: unknown }[] = [];
    const flush = async () => {
      const valid: (CatalogRow & { row: number })[] = [];
      for (const item of batch) {
        const parsed = CatalogRow.safeParse(item.data);
        if (parsed.success) valid.push({ ...parsed.data, row: item.row });
        else {
          failed++;
          errors.write([
            item.row,
            (item.data as { sku?: string })?.sku ?? '',
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          ]);
        }
      }
      if (valid.length) await this.upsert(job, valid);
      processed += batch.length;
      const checkpoint = batch[batch.length - 1].row;
      batch = [];
      await this.sequelize.query(
        `UPDATE "ImportJob" SET "checkpointRow" = :checkpoint, "rowsProcessed" = :processed, "rowsFailed" = :failed, "updatedAt" = now() WHERE id = :id`,
        {
          replacements: { checkpoint, processed, failed, id: job.id },
        },
      );
      await this.realtime.publish(
        `job:${job.id}`,
        'progress',
        { processed, failed },
        { replay: false },
      );
    };

    for await (const record of this.records(
      await this.storage.getStream(job.objectKey),
      format,
    )) {
      if (signal?.aborted) throw new Error('aborted');
      row++;
      if (row <= job.checkpointRow) continue; // resume after a crash
      batch.push({ row, data: record });
      if (batch.length === BATCH) await flush();
    }
    if (batch.length) await flush();
    errors.end();
    await errorsUpload;

    await this.sequelize.query(
      `UPDATE "ImportJob" SET status = 'DONE', "errorReportKey" = :key, "updatedAt" = now() WHERE id = :id`,
      { replacements: { key: failed > 0 ? errorsKey : null, id: job.id } },
    );
    await this.realtime.publish(`job:${job.id}`, 'done', { processed, failed });
    return 'DONE';
  }

  private records(
    source: Readable,
    format: 'csv' | 'jsonl',
  ): AsyncIterable<unknown> {
    if (format === 'csv')
      return source.pipe(
        parse({
          columns: true,
          bom: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        }),
      );
    return (async function* () {
      for await (const line of createInterface({
        input: source,
        crlfDelay: Infinity,
      })) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          yield { __invalid: line.slice(0, 100) }; // becomes a validation error row
        }
      }
    })();
  }

  /** Idempotent by (shopId, externalSku): one statement per 1,000 rows, plus their outbox rows (search reindex). */
  private async upsert(job: Job, rows: (CatalogRow & { row: number })[]) {
    await this.transactions.run(async (transaction) => {
      const arr = (values: (string | number)[]) =>
        `{${values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
      const ids = await this.sequelize.query<{ id: string }>(
        `INSERT INTO "Product" (id, "shopId", "sellerId", "externalSku", title, description, price, quantity, category, brand, rating, tags, version, "createdAt", "updatedAt")
         SELECT uuidv7(), :shopId, :sellerId, r.sku, r.title, r.description, r.price, r.stock, r.category, r.brand, 0, '{}', 1, now(), now()
         FROM unnest(CAST(:skus AS text[]), CAST(:titles AS text[]), CAST(:descriptions AS text[]), CAST(:prices AS bigint[]), CAST(:stocks AS int[]), CAST(:categories AS text[]), CAST(:brands AS text[]))
              AS r(sku, title, description, price, stock, category, brand)
         ON CONFLICT ("shopId", "externalSku") WHERE "externalSku" IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description, price = EXCLUDED.price, quantity = EXCLUDED.quantity,
           category = EXCLUDED.category, brand = EXCLUDED.brand, version = "Product".version + 1, "updatedAt" = now()
         RETURNING id`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            shopId: job.shopId,
            sellerId: job.createdBy,
            skus: arr(rows.map((r) => r.sku)),
            titles: arr(rows.map((r) => r.title)),
            descriptions: arr(rows.map((r) => r.description)),
            prices: `{${rows.map((r) => r.price).join(',')}}`,
            stocks: `{${rows.map((r) => r.stock).join(',')}}`,
            categories: arr(rows.map((r) => r.category)),
            brands: arr(rows.map((r) => r.brand)),
          },
        },
      );
      await this.sequelize.query(
        `INSERT INTO "Outbox" (id, topic, "aggregateId", "aggregateType", "type", "eventName", payload, attempts, "nextAttemptAt", "createdAt")
         SELECT uuidv7(), :topic, id::text, 'products', 'catalog.product_changed', 'catalog.product_changed',
           jsonb_build_object(
             'eventId', uuidv7(), 'type', 'catalog.product_changed', 'version', 1, 'aggregateType', 'products',
             'aggregateId', id::text, 'aggregateVersion', (extract(epoch FROM now()) * 1000)::bigint,
             'occurredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'payload', jsonb_build_object('productId', id)),
           0, now(), now() FROM unnest(CAST(:ids AS uuid[])) AS id`,
        {
          replacements: {
            topic: ProductChanged.topic,
            ids: `{${ids.map((r) => r.id).join(',')}}`,
          },
          transaction,
        },
      );
    });
  }

  private async firstBytes(key: string, n: number): Promise<Buffer> {
    const stream = await this.storage.getStream(key);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= n) break;
    }
    stream.destroy();
    return Buffer.concat(chunks).subarray(0, n);
  }

  private async fail(job: Job, reason: string) {
    await this.setStatus(job.id, 'FAILED', reason);
    await this.realtime.publish(`job:${job.id}`, 'failed', { reason });
    return 'FAILED';
  }

  private setStatus(id: string, status: string, error?: string) {
    return this.sequelize.query(
      `UPDATE "ImportJob" SET status = :status, error = :error, "updatedAt" = now() WHERE id = :id`,
      { replacements: { id, status, error: error ?? null } },
    );
  }

  private async job(jobId: string, shopId: string): Promise<Job> {
    const [job] = await this.sequelize.query<Job>(
      `SELECT id, "shopId", "createdBy", status, "objectKey", "uploadId", "checkpointRow", "rowsProcessed", "rowsFailed" FROM "ImportJob" WHERE id = :jobId AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { jobId, shopId } },
    );
    if (!job) throw new NotFoundException('Import not found');
    return job;
  }
}
