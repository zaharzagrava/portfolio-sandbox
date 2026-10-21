import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import { Client } from 'pg';
import sharp from 'sharp';
import type { SqsEvent, SqsRecord } from '@app/infrastructure/serverless';

/**
 * The real Lambda handler of the media pipeline (S29 L-015, L-004, B11), imported as the bundle imports it: it builds its
 * own adapters (pg pool, S3 client, scanner) and calls `createMediaProcessor`. A missing import, a changed barrel export
 * or a handler that no longer starts fails here. Self-contained on purpose: an app spec may not borrow a domain's
 * testing helpers (boundary x4), so it talks to Postgres and MinIO directly.
 */
describe('Media-processing Lambda handler', () => {
  const env = process.env;
  // MEDIA_BUCKET from the shell (a test shard has its own bucket); the plain stack bucket otherwise
  const bucket = process.env.MEDIA_BUCKET ?? 'marketplace-media-test';
  let db: Client;
  let s3: S3Client;
  let handler: (
    event: SqsEvent,
  ) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;

  beforeAll(async () => {
    // the stack addresses of the test environment, as the app specs get them from `ApiConfigService`
    config({ path: '.env.test', quiet: true });
    process.env.DATABASE_URL = `postgres://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
    process.env.MEDIA_SCANNER_DISABLED = 'true';
    process.env.MEDIA_BUCKET = bucket;
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    s3 = new S3Client({
      region: 'eu-central-1',
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    // loaded only now: the handler reads its environment when the module is evaluated
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ handler } = require('./media-processing') as {
      handler: typeof handler;
    });
  });
  afterAll(() => db.end());

  const record = (key: string): SqsRecord & { messageAttributes: unknown } => ({
    messageId: randomUUID(),
    receiptHandle: 'r',
    body: JSON.stringify({
      Records: [
        {
          eventName: 'ObjectCreated:Post',
          s3: { object: { key: encodeURIComponent(key) } },
        },
      ],
    }),
    attributes: { ApproximateReceiveCount: '1' },
    eventSourceARN: 'arn:aws:sqs:eu-central-1:000000000000:media-processing',
    messageAttributes: {
      requestId: { stringValue: 'req-lambda-1', dataType: 'String' },
      traceId: { stringValue: 'trace-1', dataType: 'String' },
    },
  });

  async function waiting(status = 'PENDING_UPLOAD') {
    const user = randomUUID();
    const key = `media/originals/users/${user}/${randomUUID()}`;
    const picture = await sharp({
      create: {
        width: 500,
        height: 400,
        channels: 3,
        background: { r: 30, g: Math.floor(Math.random() * 255), b: 120 },
      },
    })
      .jpeg()
      .toBuffer();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: picture,
        ContentType: 'image/jpeg',
      }),
    );
    const { rows } = await db.query(
      `INSERT INTO "Media" ("uploaderId","purpose","status","originalKey") VALUES ($1, 'review', $2, $3) RETURNING "id"`,
      [user, status, key],
    );
    return { id: rows[0].id as string, key, user };
  }
  const statusOf = async (id: string) =>
    (
      await db.query(
        `SELECT "status", "attempts" FROM "Media" WHERE "id" = $1`,
        [id],
      )
    ).rows[0] as { status: string; attempts: number };
  const cleanup = async (id: string) => {
    await db.query(`DELETE FROM "MediaStatusHistory" WHERE "mediaId" = $1`, [
      id,
    ]);
    await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" = $1`, [id]);
    await db.query(`DELETE FROM "Media" WHERE "id" = $1`, [id]);
  };

  it('S29 AS-11: a native storage notification becomes READY; a key outside the originals prefix is ignored', async () => {
    const photoRow = await waiting();
    const response = await handler({
      Records: [record(photoRow.key), record('uploads/somebody-else/file.jpg')],
    } as SqsEvent);
    expect(response.batchItemFailures).toEqual([]);
    expect(await statusOf(photoRow.id)).toEqual({
      status: 'READY',
      attempts: 1,
    });
    const events = await db.query(
      `SELECT "type" FROM "Outbox" WHERE "aggregateId" = $1`,
      [photoRow.id],
    );
    expect(events.rows).toEqual([{ type: 'media.ready' }]);
    await cleanup(photoRow.id);
  });

  it('S29 AS-21: a photo another worker holds is reported as a failed record so the queue delivers it again', async () => {
    const photoRow = await waiting('PROCESSING');
    await db.query(
      `UPDATE "Media" SET "attempts" = 1, "leaseUntil" = now() + interval '4 minutes' WHERE "id" = $1`,
      [photoRow.id],
    );
    const message = record(photoRow.key);
    const response = await handler({ Records: [message] } as SqsEvent);
    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: message.messageId },
    ]);
    expect(await statusOf(photoRow.id)).toEqual({
      status: 'PROCESSING',
      attempts: 1,
    });
    await cleanup(photoRow.id);
  });

  it('S29 AS-20: a duplicate delivery of a finished photo is acknowledged and changes nothing', async () => {
    const photoRow = await waiting();
    await handler({ Records: [record(photoRow.key)] } as SqsEvent);
    const again = await handler({
      Records: [record(photoRow.key)],
    } as SqsEvent);
    expect(again.batchItemFailures).toEqual([]);
    expect(await statusOf(photoRow.id)).toEqual({
      status: 'READY',
      attempts: 1,
    });
    const events = await db.query(
      `SELECT 1 FROM "Outbox" WHERE "aggregateId" = $1`,
      [photoRow.id],
    );
    expect(events.rows).toHaveLength(1);
    await cleanup(photoRow.id);
  });
});
