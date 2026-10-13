#!/usr/bin/env node
// S29 SC-001, SC-002, SC-004, AS-61 - how fast the photo pipeline turns uploads into READY, and what it leaves behind.
//
//   node scripts/load-tests/media-throughput.mjs --images 1000 --workers 1,2,4 --verify-metadata
//
// For each worker count it seeds N upload slots with a generated corpus (JPEGs, a tenth of them carrying GPS), runs that
// many in-process workers (the same `createMediaProcessor` the Lambda runs) until the queue is drained, and prints
// photos/second and the p95 of `media_upload_to_ready_seconds`. With --verify-metadata it also reads every variant back
// and fails if one still carries EXIF/GPS (SC-002). Throughput should grow with workers (AS-61); SC-001 is "95% READY
// within 10 s of the upload being confirmed with 1,000 queued".
//
// Needs the test stack (Postgres, MinIO). Run from packages/backend with the TypeScript hooks that resolve `@app/*`:
//   node -r ./scripts/preload-contracts.cjs -r ts-node/register/transpile-only -r tsconfig-paths/register \
//     scripts/load-tests/media-throughput.mjs --images 1000 --workers 1,2,4 --verify-metadata
// (a 40-image run on the test stack gave 6.1, 11.7 and 20.6 photos/s for 1, 2 and 4 workers, no variant with metadata)
// This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves correctness on a small corpus, not the rate.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((all, token, i, list) => {
    if (token.startsWith('--')) all.push([token.slice(2), list[i + 1] && !list[i + 1].startsWith('--') ? list[i + 1] : true]);
    return all;
  }, []),
);
const images = Number(args.images ?? 200);
const workerCounts = String(args.workers ?? '1,2,4').split(',').map(Number);
const verify = Boolean(args['verify-metadata']);
const bucket = process.env.MEDIA_BUCKET ?? 'marketplace-media-test';

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5400/marketplace_test',
  max: 8,
});
const s3 = new S3Client({
  region: 'eu-central-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9210',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin' },
});

let media;
try {
  media = require('@app/domains/media');
} catch (error) {
  console.error(`Cannot load @app/domains/media (run with the ts-node and tsconfig-paths hooks, see the header): ${error.message}`);
  process.exit(2);
}
const { createMediaProcessor: processorFactory, createTx } = media;

const corpus = await Promise.all(
  Array.from({ length: Math.min(images, 50) }, (_, i) =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: (i * 5) % 255, g: (i * 11) % 255, b: (i * 17) % 255 } } })
      .composite([{ input: Buffer.from(`<svg width="1600" height="1200"><circle cx="${300 + i * 20}" cy="600" r="${150 + i}" fill="white"/></svg>`) }])
      .withExif(i % 10 === 0 ? { IFD0: { Make: 'LoadTest' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1' } } : {})
      .jpeg()
      .toBuffer(),
  ),
);

const user = randomUUID();
const shop = randomUUID();

async function seed() {
  const keys = [];
  for (let i = 0; i < images; i++) {
    const key = `media/originals/shops/${shop}/${randomUUID()}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: corpus[i % corpus.length], ContentType: 'image/jpeg' }));
    await db.query(
      `INSERT INTO "Media" ("shopId","uploaderId","purpose","status","originalKey","uploadedAt") VALUES ($1,$2,'product','UPLOADED',$3, now())`,
      [shop, user, key],
    );
    keys.push(key);
  }
  return keys;
}

const tx = async (fn) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params).then((r) => r.rows));
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const read = async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToByteArray());

async function run(workers) {
  const keys = await seed();
  const samples = [];
  const processor = processorFactory({
    tx: createTx(tx),
    blobs: {
      read: async (key) => read(key),
      stream: async (key) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body,
      write: async (key, body, contentType, { cacheControl }) => void (await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }))),
      head: async (key) => {
        try {
          return { size: Number((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? 0) };
        } catch {
          return null;
        }
      },
      delete: async () => undefined,
    },
    scanner: { scan: async (stream) => (stream.resume(), { clean: true }) },
    clock: { now: () => new Date() },
    metrics: { inc() {}, observe: (name, value) => name === 'media_upload_to_ready_seconds' && samples.push(value) },
  });
  const queue = [...keys];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let key = queue.pop(); key; key = queue.pop()) await processor.process(key).catch(() => undefined);
    }),
  );
  const seconds = (Date.now() - started) / 1000;
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? NaN;
  let leaked = 0;
  if (verify) {
    const { rows } = await db.query(`SELECT variants FROM "Media" WHERE "originalKey" = ANY($1) AND status = 'READY'`, [keys]);
    for (const row of rows)
      for (const v of Object.values(row.variants)) {
        const meta = await sharp(await read(v.key)).metadata();
        if (meta.exif || meta.xmp || meta.iptc || meta.icc) leaked += 1;
      }
  }
  const ready = (await db.query(`SELECT count(*)::int AS n FROM "Media" WHERE "originalKey" = ANY($1) AND status = 'READY'`, [keys])).rows[0].n;
  console.log(JSON.stringify({ workers, images, ready, seconds: Number(seconds.toFixed(1)), perSecond: Number((ready / seconds).toFixed(1)), uploadToReadyP95Seconds: Number(p95.toFixed(2)), variantsWithMetadata: verify ? leaked : 'not checked' }));
  return { leaked, ready };
}

let failed = false;
for (const workers of workerCounts) {
  const { leaked, ready } = await run(workers);
  if (verify && leaked > 0) failed = true;
  if (ready < images) failed = true;
}
await db.end();
process.exit(failed ? 1 : 0);
