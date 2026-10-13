import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  mediaOwnerSchema,
  mediaPublicSchema,
} from '@marketplace-sandbox/contracts';
import { TransientProcessingError } from './domain/reject-code';
import { StorageBlobs } from './infra/media-blobs';
import {
  MINIO,
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import {
  animatedWebp,
  heavyMetadataJpeg,
  phpScript,
  photo,
} from './testing/test-images';

const uniqueSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;

/** Counts writes and runs a hook before one of them (to break the network at a known point). */
class HookedBlobs extends StorageBlobs {
  writes = 0;
  before?: (n: number) => void;
  override write(...args: Parameters<StorageBlobs['write']>) {
    this.writes += 1;
    this.before?.(this.writes);
    return super.write(...args);
  }
}

describe('Media processing pipeline', () => {
  let t: MediaTestApp;
  let w: MediaWorld;

  beforeAll(async () => {
    t = await createMediaApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  /** A product photo at `status` whose original object is `bytes`. */
  const upload = async (
    bytes: Buffer,
    options: {
      status?: 'PENDING_UPLOAD' | 'UPLOADED';
      contentType?: string;
      purpose?: 'product' | 'review';
    } = {},
  ) => {
    const review = options.purpose === 'review';
    const created = await t.photo({
      shopId: review ? null : w.shop.id,
      uploaderId: review ? w.buyer.id : w.staff.id,
      status: options.status ?? 'UPLOADED',
      uploadedAt: t.clock.now(),
    });
    await t.putOriginal(
      created.originalKey,
      bytes,
      options.contentType ?? 'image/jpeg',
    );
    return created;
  };
  const owned = (id: string, user = w.staff) =>
    t.as(user).get(`/api/media/${id}`);

  describe('S29 US1/US2: from bytes to READY', () => {
    it('S29 AS-11: the storage notification alone is enough; a later complete answers 200 and sends nothing', async () => {
      const { id, originalKey } = await upload(
        await photo({ width: 640, height: 480 }),
        { status: 'PENDING_UPLOAD' },
      );
      expect(await t.processor().process(originalKey)).toBe('READY');
      expect((await t.row(id))!.status).toBe('READY');
      const res = await t
        .as(w.staff)
        .post(`/api/media/${id}/complete`)
        .expect(200);
      expect(res.body.status).toBe('READY');
      expect(t.queue.sent).toHaveLength(0);
    });

    it('S29 AS-12: a GPS-tagged, rotated JPEG becomes READY with three clean WebP variants and one event', async () => {
      // a fresh picture every run: variant keys are content hashes, so a repeated input would add no new object
      const original = await photo({
        width: 2400,
        height: 1600,
        withMetadata: true,
        orientation: 6,
        seed: uniqueSeed(),
      });
      const { id, originalKey } = await upload(original);
      const before = await t.derivedKeys();

      expect(await t.processor().process(originalKey)).toBe('READY');

      const row = (await t.row(id))!;
      expect(row).toMatchObject({
        status: 'READY',
        width: 1600,
        height: 2400,
        attempts: 1,
      });
      expect(row.leaseUntil).toBeNull();
      const variants = row.variants as Record<
        'thumb' | 'feed' | 'full',
        { key: string; width: number; height: number }
      >;
      expect(
        Object.fromEntries(
          Object.entries(variants).map(([k, v]) => [k, v.width]),
        ),
      ).toEqual({
        thumb: 200,
        feed: 640,
        full: 1600,
      });
      for (const v of Object.values(variants)) {
        expect(v.key).toMatch(/^media\/derived\/[0-9a-f]{64}\.webp$/);
        expect(
          Math.abs(v.height - (v.width * 2400) / 1600),
        ).toBeLessThanOrEqual(1);
        expect(await t.objectHeaders(v.key)).toEqual({
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
        });
        const meta = await sharp(await t.objectBytes(v.key)).metadata();
        expect(meta).toMatchObject({ format: 'webp' });
        expect(meta.exif).toBeUndefined();
        expect(meta.icc).toBeUndefined();
      }
      expect(
        (await t.derivedKeys()).filter((k) => !before.includes(k)),
      ).toHaveLength(3);
      expect((await t.objectBytes(originalKey)).equals(original)).toBe(true); // the original is untouched

      expect(
        (await t.history(id)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toEqual(['null>UPLOADED', 'UPLOADED>PROCESSING', 'PROCESSING>READY']);
      const events = await t.outbox();
      expect(events.map((e) => e.type)).toEqual(['media.ready']);
      expect(events[0].payload).toMatchObject({
        mediaId: id,
        mediaVersion: row.version,
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        purpose: 'product',
        width: 1600,
        height: 2400,
        duplicateSuspected: false,
      });

      const view = mediaPublicSchema.parse((await owned(id).expect(200)).body);
      expect(view.urls).toEqual({
        thumb: `https://media.marketplace-test.example/${variants.thumb.key}`,
        feed: `https://media.marketplace-test.example/${variants.feed.key}`,
        full: `https://media.marketplace-test.example/${variants.full.key}`,
      });
    });

    it('S29 AS-17: a PHP script declared image/jpeg is REJECTED not_an_image with no variant and one media.rejected', async () => {
      const { id, originalKey } = await upload(phpScript(), {
        contentType: 'image/jpeg',
      });
      const before = await t.derivedKeys();
      expect(await t.processor().process(originalKey)).toBe('REJECTED');
      expect(await t.row(id)).toMatchObject({
        status: 'REJECTED',
        rejectCode: 'not_an_image',
        variants: null,
      });
      expect(await t.derivedKeys()).toEqual(before);
      expect((await t.outbox()).map((e) => e.type)).toEqual(['media.rejected']);
      expect((await t.outbox('media.rejected'))[0].payload).toMatchObject({
        mediaId: id,
        code: 'not_an_image',
      });
      expect((await t.history(id)).at(-1)).toMatchObject({
        fromStatus: 'PROCESSING',
        toStatus: 'REJECTED',
        rejectCode: 'not_an_image',
      });
      const view = mediaOwnerSchema.parse((await owned(id).expect(200)).body);
      expect(view).toMatchObject({
        status: 'REJECTED',
        rejectCode: 'not_an_image',
        urls: null,
      });
    });

    it('S29 AS-17: a genuine PNG declared image/jpeg is READY (the bytes decide, not the label)', async () => {
      const { id, originalKey } = await upload(
        await photo({ format: 'png', width: 500, height: 400 }),
        { contentType: 'image/jpeg' },
      );
      expect(await t.processor().process(originalKey)).toBe('READY');
      expect((await t.row(id))!.status).toBe('READY');
    });

    it.each([['an animated WebP', animatedWebp, 'multi_frame']])(
      'S29 AS-16: %s is REJECTED as %s end to end',
      async (_name, build, code) => {
        const { id, originalKey } = await upload(await build());
        expect(await t.processor().process(originalKey)).toBe('REJECTED');
        expect((await t.row(id))!.rejectCode).toBe(code);
      },
    );

    it('S29 AS-13: a wide-gamut, tagged photo is stored without its profile', async () => {
      const { originalKey, id } = await upload(await heavyMetadataJpeg());
      expect(await t.processor().process(originalKey)).toBe('READY');
      const variants = (await t.row(id))!.variants as Record<
        string,
        { key: string }
      >;
      const meta = await sharp(
        await t.objectBytes(variants.feed.key),
      ).metadata();
      expect(meta.icc).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
    });
  });

  describe('S29 US2: malware and scanner outage', () => {
    it('S29 AS-18: an infected file is REJECTED malware_detected, its original is deleted and nothing is written', async () => {
      const { id, originalKey } = await upload(
        await photo({ width: 400, height: 300 }),
      );
      const before = await t.derivedKeys();
      t.scanner.mode = 'infected';
      expect(await t.processor().process(originalKey)).toBe('REJECTED');
      expect(await t.row(id)).toMatchObject({
        status: 'REJECTED',
        rejectCode: 'malware_detected',
      });
      expect(await t.objectExists(originalKey)).toBe(false);
      expect(await t.derivedKeys()).toEqual(before);
      expect((await t.outbox('media.rejected'))[0].payload.code).toBe(
        'malware_detected',
      );
      expect(await t.outbox('media.ready')).toHaveLength(0);
    });

    it.each(['down', 'slow'] as const)(
      'S29 AS-19: a scanner that is %s ends the run transiently; the photo is never READY; a clean retry completes it',
      async (mode) => {
        const { id, originalKey } = await upload(
          await photo({ width: 400, height: 300 }),
        );
        const before = await t.derivedKeys();
        t.scanner.mode = mode;
        await expect(t.processor().process(originalKey)).rejects.toBeInstanceOf(
          TransientProcessingError,
        );
        expect(await t.row(id)).toMatchObject({
          status: 'PROCESSING',
          attempts: 1,
        });
        expect(await t.derivedKeys()).toEqual(before);
        expect(await t.outbox()).toHaveLength(0);
        expect(t.metrics.count('media_scan_unavailable_total')).toBe(1);

        t.scanner.mode = 'clean';
        expect(await t.processor().process(originalKey)).toBe('READY');
        expect(await t.row(id)).toMatchObject({ status: 'READY', attempts: 2 });
      },
    );
  });

  describe('S29 US2: idempotency, leases and the attempt cap', () => {
    it.each(['READY', 'REJECTED', 'EXPIRED', 'DELETED'] as const)(
      'S29 AS-20: %s photos answer SKIPPED on every delivery and change nothing',
      async (status) => {
        const seed =
          status === 'READY'
            ? await t.readyPhoto(w.shop.id, w.staff.id)
            : await t.photo({
                shopId: w.shop.id,
                uploaderId: w.staff.id,
                status,
                rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
              });
        const rowBefore = await t.row(seed.id);
        const eventsBefore = await t.outbox();
        const keysBefore = await t.derivedKeys();
        const processor = t.processor();
        for (let i = 0; i < 3; i++)
          expect(await processor.process(seed.originalKey)).toBe('SKIPPED');
        expect(await t.row(seed.id)).toEqual(rowBefore);
        expect(await t.outbox()).toEqual(eventsBefore);
        expect(await t.derivedKeys()).toEqual(keysBefore);
      },
    );

    it('S29 AS-20: an unknown key answers SKIPPED and is counted', async () => {
      expect(
        await t
          .processor()
          .process(`media/originals/shops/${w.shop.id}/${randomUUID()}`),
      ).toBe('SKIPPED');
      expect(t.metrics.count('media_unknown_key_total')).toBe(1);
    });

    it('S29 AS-21: two workers at once: one processes, the other is BUSY, one media.ready exists', async () => {
      const { originalKey, id } = await upload(
        await photo({ width: 800, height: 600 }),
      );
      const results = await Promise.all([
        t.processor().process(originalKey),
        t.processor().process(originalKey),
      ]);
      expect([...results].sort()).toEqual(['BUSY', 'READY']);
      expect(await t.outbox('media.ready')).toHaveLength(1);
      expect((await t.row(id))!.status).toBe('READY');
    });

    it('S29 AS-21: a valid lease answers BUSY; after the lease a worker takes over as attempt 2 and completes', async () => {
      const bytes = await photo({ width: 800, height: 600 });
      const { originalKey, id } = await upload(bytes);
      await t.sql(
        `UPDATE "Media" SET "status" = 'PROCESSING', "attempts" = 1, "leaseUntil" = :lease WHERE "id" = :id`,
        { id, lease: new Date(t.clock.now().getTime() + 5 * 60_000) },
      );
      expect(await t.processor().process(originalKey)).toBe('BUSY');
      expect(await t.row(id)).toMatchObject({
        status: 'PROCESSING',
        attempts: 1,
      });

      t.clock.advance(5 * 60_000 + 1_000);
      expect(await t.processor().process(originalKey)).toBe('READY');
      expect(await t.row(id)).toMatchObject({ status: 'READY', attempts: 2 });
      expect(
        (await t.history(id)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toContain('PROCESSING>PROCESSING');
    });

    it('S29 AS-22: a poison file costs four attempts; the fifth claim REJECTS it as processing_failed and acknowledges', async () => {
      const { originalKey, id } = await upload(
        await photo({ width: 400, height: 300 }),
      );
      const failing = t.processor({
        blobs: new (class extends StorageBlobs {
          override async head(): Promise<never> {
            throw new Error('storage is down');
          }
        })(t.storage),
      });
      for (let delivery = 1; delivery <= 4; delivery++) {
        await expect(failing.process(originalKey)).rejects.toBeInstanceOf(
          TransientProcessingError,
        );
        expect(await t.row(id)).toMatchObject({
          status: 'PROCESSING',
          attempts: delivery,
        });
      }
      expect(await failing.process(originalKey)).toBe('REJECTED');
      expect(await t.row(id)).toMatchObject({
        status: 'REJECTED',
        rejectCode: 'processing_failed',
        attempts: 5,
      });
      expect((await t.outbox('media.rejected'))[0].payload.code).toBe(
        'processing_failed',
      );
      expect(t.metrics.count('media_processing_attempts_exhausted_total')).toBe(
        1,
      );
      expect(
        t.logger.lines.some(
          (l) => l.level === 'error' && l.fields.mediaId === id,
        ),
      ).toBe(true);
    });
  });

  describe('S29 US2: timeouts and partial writes (real network faults)', () => {
    it('S29 AS-23: a storage that hangs on the original is cut at the read limit; the lease is released and the attempt counted', async () => {
      const { originalKey, id } = await upload(
        await photo({ width: 400, height: 300 }),
      );
      const proxy = await t.faultProxy(MINIO);
      const via = new StorageBlobs(
        t.storageVia(`http://127.0.0.1:${proxy.port}`),
      );
      proxy.mode = 'hang';
      const started = Date.now();
      await expect(
        t
          .processor({ blobs: via, limits: { readMs: 400, runMs: 5_000 } })
          .process(originalKey),
      ).rejects.toBeInstanceOf(TransientProcessingError);
      expect(Date.now() - started).toBeLessThan(5_000);
      const row = (await t.row(id))!;
      expect(row).toMatchObject({ status: 'PROCESSING', attempts: 1 });
      expect(new Date(row.leaseUntil).getTime()).toBeLessThanOrEqual(
        t.clock.now().getTime(),
      );
      expect(await t.outbox()).toHaveLength(0);
      proxy.mode = 'pass';
    });

    it('S29 AS-24: when the third variant cannot be written nothing is READY; the retry writes all three under the same keys', async () => {
      const { originalKey, id } = await upload(
        await photo({ width: 2000, height: 1500, seed: uniqueSeed() }),
      );
      const before = await t.derivedKeys();
      const proxy = await t.faultProxy(MINIO);
      const blobs = new HookedBlobs(
        t.storageVia(`http://127.0.0.1:${proxy.port}`),
      );
      blobs.before = (n) => {
        if (n === 3) proxy.mode = 'refuse';
      };
      await expect(
        t
          .processor({ blobs, limits: { readMs: 3_000, writeMs: 3_000 } })
          .process(originalKey),
      ).rejects.toBeInstanceOf(TransientProcessingError);
      expect((await t.row(id))!.status).toBe('PROCESSING');
      expect(await t.outbox()).toHaveLength(0);
      const partial = (await t.derivedKeys()).filter(
        (k) => !before.includes(k),
      );
      expect(partial).toHaveLength(2);

      proxy.mode = 'pass';
      expect(await t.processor().process(originalKey)).toBe('READY');
      const variants = (await t.row(id))!.variants as Record<
        string,
        { key: string }
      >;
      const keys = Object.values(variants)
        .map((v) => v.key)
        .sort();
      expect(keys).toHaveLength(3);
      expect(partial.every((k) => keys.includes(k))).toBe(true);
      expect(
        (await t.derivedKeys()).filter((k) => !before.includes(k)).sort(),
      ).toEqual(keys);
      expect(await t.outbox('media.ready')).toHaveLength(1);
    });
  });

  // The Lambda handler itself (module wiring, S3 notification, foreign prefix) is proven in
  // `apps/lambdas/src/handlers/media-processing.e2e-spec.ts`: a library may not import an app (boundary x1).
});
