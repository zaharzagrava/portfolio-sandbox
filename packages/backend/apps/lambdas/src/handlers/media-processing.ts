import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import type { Readable } from 'node:stream';
import {
  createMediaProcessor,
  createTx,
  type Blobs,
  type MediaLogger,
  type MediaMetrics,
  type SqlRunner,
} from '@app/domains/media';
import { ClamdMalwareScanner } from '@app/infrastructure/antivirus/clamd-scanner';
import { DisabledMalwareScanner } from '@app/infrastructure/antivirus/disabled-scanner';
import {
  defineSqsHandler,
  functionInfo,
  log,
  manifestEntry,
  metric,
  TransientError,
} from '@app/infrastructure/serverless';

/**
 * SD-10 media processing - a SMALL handler (no Nest): sharp + pg + S3 SDK, created at module scope so warm invocations
 * reuse connections. Pool max=2: Lambda concurrency × 2 is the DB connection budget (RDS Proxy in AWS). All the logic
 * is `createMediaProcessor` (S29): the claim and its lease are the idempotency mechanism, so there is no second one here.
 * Accepts the native S3 event notification (ObjectCreated) and our own `{ mediaId, originalKey }` message (the local
 * MinIO path, the re-drive job, a manual re-run).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const bucket = requiredEnv('MEDIA_BUCKET');
const databaseUrl = requiredEnv('DATABASE_URL');
const scannerDisabled = process.env.MEDIA_SCANNER_DISABLED === 'true';
if (scannerDisabled && process.env.NODE_ENV === 'production')
  throw new Error('MEDIA_SCANNER_DISABLED is not allowed in production');
const scanner = scannerDisabled
  ? new DisabledMalwareScanner()
  : ClamdMalwareScanner.fromAddress(requiredEnv('CLAMAV_HOST'));

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'eu-central-1',
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
});
const pool = new Pool({
  connectionString: databaseUrl,
  max: manifestEntry('media-processing').dbPoolMax,
  idleTimeoutMillis: 30_000,
});

/** One `pg` connection inside its own BEGIN/COMMIT: not a `sequelize.transaction` site, and no Nest container. */
const transaction = async <T>(
  fn: (sql: SqlRunner) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(
      (async (text: string, params?: unknown[]) =>
        (await client.query(text, params)).rows) as SqlRunner,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const send = <T>(
  command: Parameters<S3Client['send']>[0],
  timeoutMs?: number,
): Promise<T> =>
  s3.send(
    command,
    timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : {},
  ) as Promise<T>;

const blobs: Blobs = {
  read: async (key, timeoutMs) => {
    const out = await send<{
      Body: { transformToByteArray(): Promise<Uint8Array> };
    }>(new GetObjectCommand({ Bucket: bucket, Key: key }), timeoutMs);
    return Buffer.from(await out.Body.transformToByteArray());
  },
  stream: async (key, timeoutMs) =>
    (
      await send<{ Body: Readable }>(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        timeoutMs,
      )
    ).Body,
  write: async (key, body, contentType, { cacheControl, timeoutMs }) => {
    await send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
      timeoutMs,
    );
  },
  head: async (key, timeoutMs) => {
    try {
      const out = await send<{ ContentLength?: number }>(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        timeoutMs,
      );
      return { size: Number(out.ContentLength ?? 0) };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  },
  delete: async (key) => {
    await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};

const NAMESPACE = 'Marketplace/Media';
const metrics: MediaMetrics = {
  inc: (name, labels = {}, by = 1) =>
    metric(NAMESPACE, name, by, 'Count', labels),
  observe: (name, value, labels = {}) =>
    metric(
      NAMESPACE,
      name,
      name.endsWith('_seconds') ? value * 1000 : value,
      name.endsWith('_seconds') ? 'Milliseconds' : 'Count',
      labels,
    ),
};
const logger: MediaLogger = {
  info: (message, fields) => log('info', message, fields),
  warn: (message, fields) => log('warn', message, fields),
  error: (message, fields) => log('error', message, fields),
};

const processor = createMediaProcessor({
  tx: createTx(transaction),
  blobs,
  scanner,
  clock: { now: () => new Date() },
  metrics,
  logger,
});

const ORIGINALS_PREFIX = 'media/originals/';

interface QueueMessage {
  originalKey?: string;
  Records?: { eventName?: string; s3?: { object?: { key?: string } } }[];
}

/** A body is ours when it names one original key or carries S3 notification records; anything else never reaches the processor. */
const messageBody = {
  safeParse(
    input: unknown,
  ): { success: true; data: string[] } | { success: false } {
    if (typeof input !== 'object' || input === null) return { success: false };
    const parsed = input as QueueMessage;
    if (typeof parsed.originalKey === 'string' && parsed.originalKey)
      return { success: true, data: [parsed.originalKey] };
    if (!Array.isArray(parsed.Records)) return { success: false };
    return {
      success: true,
      data: parsed.Records.filter((r) =>
        r.eventName?.startsWith('ObjectCreated'),
      ).map((r) =>
        decodeURIComponent((r.s3?.object?.key ?? '').replace(/\+/g, ' ')),
      ),
    };
  },
};

export const handler = defineSqsHandler({
  function: functionInfo('media-processing'),
  bodySchema: messageBody,
  concurrency: 2, // sharp is CPU-bound; parallelism comes from many containers, not one
  handle: async (message) => {
    // `requestId` / `traceId` written at `complete` travel as SQS message attributes.
    const context = {
      requestId: message.attributes.requestId,
      traceId: message.attributes.traceId,
    };
    for (const key of message.body) {
      // A key outside the originals prefix is not ours: no row is read, nothing happens (AS-11).
      if (!key.startsWith(ORIGINALS_PREFIX)) {
        log('info', 'media notification ignored (foreign prefix)', context);
        continue;
      }
      const result = await processor.process(key, context);
      // A held lease means another worker has it: let the queue deliver again later.
      if (result === 'BUSY')
        throw new TransientError('media is being processed by another worker');
    }
  },
});
