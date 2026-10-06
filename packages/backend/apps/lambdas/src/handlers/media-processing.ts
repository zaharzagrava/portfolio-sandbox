import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Pool } from 'pg';
import { MediaProcessor, Sql } from '@app/domains/media';
import { AlreadyInProgressError, Idempotency } from '../shared/idempotency';
import { processBatch, SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import { log, metric } from '../shared/telemetry';

/**
 * SD-10 media processing - a SMALL handler (no Nest): sharp + pg + S3 SDK,
 * created at module scope so warm invocations reuse connections. Pool max=2:
 * Lambda concurrency × 2 is the DB connection budget (RDS Proxy in AWS).
 * Accepts both the native S3 event notification (ObjectCreated) and our own
 * `{ originalKey }` message (local MinIO path / manual reprocessing).
 */
const bucket = process.env.MEDIA_BUCKET ?? 'marketplace-media';
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-central-1', ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }) });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30_000 });
const sql: Sql = async (text, params) => (await pool.query(text, params)).rows;
const tx = async <T>(fn: (q: Sql) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(async (text, params) => (await client.query(text, params)).rows);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
const processor = new MediaProcessor(sql, tx, {
  get: async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray()),
  put: async (key, body, contentType, cacheControl) => void (await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }))),
});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-central-1', ...(process.env.DYNAMO_ENDPOINT && { endpoint: process.env.DYNAMO_ENDPOINT }) }));
const idempotency = new Idempotency(dynamo, `${process.env.DYNAMO_TABLE_PREFIX ?? ''}Idempotency`, 'media-processing');

function keysOf(body: string): string[] {
  const parsed = JSON.parse(body) as { originalKey?: string; Records?: { eventName?: string; s3?: { object?: { key?: string } } }[] };
  if (parsed.originalKey) return [parsed.originalKey];
  return (parsed.Records ?? []).filter((r) => r.eventName?.startsWith('ObjectCreated')).map((r) => decodeURIComponent((r.s3?.object?.key ?? '').replace(/\+/g, ' ')));
}

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  return processBatch(
    event,
    async (record) => {
      for (const key of keysOf(record.body).filter((k) => k.startsWith('media/originals/'))) {
        const started = Date.now();
        try {
          const { result, replayed } = await idempotency.run(key, 120_000, () => processor.process(key));
          metric('Marketplace/Media', 'ProcessMs', Date.now() - started, 'Milliseconds', { result: String(result) });
          log('info', 'media processed', { key, result, replayed });
        } catch (error) {
          if (error instanceof AlreadyInProgressError) throw error; // another container has it; SQS retries this record later
          log('error', 'media processing failed', { key, error: (error as Error).message });
          throw error;
        }
      }
    },
    { concurrency: 2 }, // sharp is CPU-bound; parallelism comes from many containers, not one
  );
}
