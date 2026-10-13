import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  eventEnvelopeSchema,
  mediaEventSchemas,
  mediaUploadResponseSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigModule } from '@app/common/config';
import { ConfigRules } from '@app/common/config/config-rules';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { AntivirusModule } from '@app/infrastructure/antivirus';
import { DisabledMalwareScanner } from '@app/infrastructure/antivirus/disabled-scanner';
import { MalwareScanner } from '@app/infrastructure/antivirus/malware-scanner';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { MediaModule } from './media.module';
import { TransientProcessingError } from './domain/reject-code';
import { registryMediaMetrics } from './infra/media-observability';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { duplicatePair, phpScript, photo } from './testing/test-images';

const ORIGIN = 'https://media.marketplace-test.example';
const uniqueSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;

describe('Media events, observability and configuration', () => {
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

  const slot = async (
    bytes: Buffer,
    owner: 'a' | 'b' = 'a',
    purpose: 'product' | 'review' = 'product',
  ) => {
    const review = purpose === 'review';
    const created = await t.photo({
      shopId: review ? null : owner === 'a' ? w.shop.id : w.otherShop.id,
      uploaderId: review
        ? w.buyer.id
        : owner === 'a'
          ? w.staff.id
          : w.otherOwner.id,
      status: 'UPLOADED',
      uploadedAt: t.clock.now(),
    });
    await t.putOriginal(created.originalKey, bytes);
    return created;
  };

  /** A trigger that makes every media outbox insert fail: the event and its state change must live or die together. */
  const withOutboxFailure = async (fn: () => Promise<void>) => {
    await t.sql(`
      CREATE OR REPLACE FUNCTION s29_fail_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW."type" LIKE 'media.%' THEN RAISE EXCEPTION 's29 forced outbox failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER s29_fail_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION s29_fail_outbox();
    `);
    try {
      await fn();
    } finally {
      await t.sql(
        `DROP TRIGGER IF EXISTS s29_fail_outbox ON "Outbox"; DROP FUNCTION IF EXISTS s29_fail_outbox();`,
      );
    }
  };

  describe('S29 AS-56: events are written atomically with the state change', () => {
    it('S29 AS-56: a rolled-back READY transition leaves the row in PROCESSING and writes no event', async () => {
      const { id, originalKey } = await slot(
        await photo({ width: 600, height: 400, seed: uniqueSeed() }),
      );
      await withOutboxFailure(async () => {
        await expect(t.processor().process(originalKey)).rejects.toBeInstanceOf(
          TransientProcessingError,
        );
      });
      expect(await t.row(id)).toMatchObject({
        status: 'PROCESSING',
        variants: null,
      });
      expect((await t.history(id)).map((h) => h.toStatus)).not.toContain(
        'READY',
      );
      expect(await t.outbox()).toHaveLength(0);
      // the damage is gone, so the next delivery completes it
      expect(await t.processor().process(originalKey)).toBe('READY');
      expect(await t.outbox('media.ready')).toHaveLength(1);
    });

    it('S29 AS-56: a rolled-back delete and a rolled-back gallery write change nothing', async () => {
      const product = await t.product(w.shop.id);
      const photoRow = await t.readyPhoto(w.shop.id, w.staff.id);
      await withOutboxFailure(async () => {
        expect(
          (await t.as(w.staff).delete(`/api/media/${photoRow.id}`)).status,
        ).toBe(500);
        expect(
          (
            await t
              .as(w.staff)
              .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
              .send({ mediaIds: [photoRow.id], expectedVersion: 0 })
          ).status,
        ).toBe(500);
      });
      expect((await t.row(photoRow.id))!.status).toBe('READY');
      expect(await t.history(photoRow.id)).toHaveLength(1);
      expect(await t.sql(`SELECT 1 FROM "ProductMedia"`)).toHaveLength(0);
      expect(await t.sql(`SELECT 1 FROM "ProductGallery"`)).toHaveLength(0);
      expect(await t.outbox()).toHaveLength(0);
    });

    it('S29 AS-56: all five events are written, each with the envelope and a payload its schema accepts; mediaVersion only grows', async () => {
      // rejected
      const refused = await slot(phpScript());
      await t.processor().process(refused.originalKey);
      // ready + duplicate_suspected (a re-saved copy from the other shop) + gallery_changed + deleted
      const pair = await duplicatePair();
      const first = await slot(pair.original, 'a');
      await t.processor().process(first.originalKey);
      const copy = await slot(pair.copy, 'b');
      await t.processor().process(copy.originalKey);
      const product = await t.product(w.shop.id);
      await t
        .as(w.staff)
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send({ mediaIds: [first.id], expectedVersion: 0 })
        .expect(200);
      await t
        .as(w.staff)
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send({ mediaIds: [], expectedVersion: 1 })
        .expect(200);
      await t.as(w.staff).delete(`/api/media/${first.id}`).expect(204);

      const events = await t.outbox();
      expect([...new Set(events.map((e) => e.type))].sort()).toEqual([
        'media.deleted',
        'media.duplicate_suspected',
        'media.gallery_changed',
        'media.ready',
        'media.rejected',
      ]);
      for (const event of events) {
        const envelope = eventEnvelopeSchema.parse(event.envelope);
        expect(envelope).toMatchObject({ version: 1, aggregateType: 'media' });
        expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Date.parse(envelope.occurredAt)).not.toBeNaN();
        expect(() =>
          mediaEventSchemas[event.type as keyof typeof mediaEventSchemas].parse(
            event.payload,
          ),
        ).not.toThrow();
        const text = JSON.stringify(event.payload);
        expect(text).not.toMatch(
          /media\/originals|dhash|decoder|not a decodable/i,
        );
        if (event.type !== 'media.ready' && event.type !== 'media.rejected')
          expect(text).not.toContain('uploaderId');
      }
      const gallery = events.filter((e) => e.type === 'media.gallery_changed');
      expect(gallery.map((e) => e.aggregateId)).toEqual([
        product.id,
        product.id,
      ]);
      expect(gallery.map((e) => e.aggregateVersion)).toEqual([1, 2]);

      const ofFirst = events.filter((e) => e.payload.mediaId === first.id);
      expect(ofFirst.map((e) => e.type)).toEqual([
        'media.ready',
        'media.deleted',
      ]);
      const versions = ofFirst.map((e) => e.payload.mediaVersion as number);
      expect(versions[1]).toBeGreaterThan(versions[0]);
      expect(versions).toEqual(ofFirst.map((e) => e.aggregateVersion));
    });
  });

  describe('S29 AS-55: nothing but derived images is ever served', () => {
    it('S29 AS-55: no route, in any status, for any caller, shows an original key or a storage address', async () => {
      const ready = await slot(
        await photo({ width: 800, height: 600, seed: uniqueSeed() }),
      );
      await t.processor().process(ready.originalKey);
      const rejected = await slot(phpScript());
      await t.processor().process(rejected.originalKey);
      const waiting = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
      });
      const product = await t.product(w.shop.id);
      await t
        .as(w.staff)
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send({ mediaIds: [ready.id], expectedVersion: 0 })
        .expect(200);
      const created = mediaUploadResponseSchema.parse(
        (
          await t
            .as(w.staff)
            .post(`/api/shops/${w.shop.id}/media/uploads`)
            .send({ purpose: 'product' })
            .expect(201)
        ).body,
      );

      const responses = [
        await t.as(w.staff).get(`/api/media/${ready.id}`),
        await t.as(w.staff).get(`/api/media/${rejected.id}`),
        await t.as(w.staff).get(`/api/media/${waiting.id}`),
        await t.http().get(`/api/media/${ready.id}`),
        await t.http().get(`/api/batch/media?ids=${ready.id},${rejected.id}`),
        await t.http().get(`/api/products/${product.id}/gallery`),
        await t
          .as(w.viewer)
          .get(`/api/shops/${w.shop.id}/products/${product.id}/gallery`),
        await t.as(w.staff).post(`/api/media/${created.mediaId}/complete`),
      ];
      const keys = [ready, rejected, waiting].map((p) => p.originalKey);
      for (const res of responses) {
        const text = JSON.stringify({ body: res.body, headers: res.headers });
        for (const key of keys) expect(text).not.toContain(key);
        expect(text).not.toContain('media/originals/');
        expect(text).not.toMatch(/X-Amz|presigned|:9210/i);
      }
      // the only place a key appears is the upload permission the browser needs, and only its own
      expect(JSON.stringify(created)).toContain(created.upload.fields.key);
      for (const res of responses.slice(0, 7)) {
        const urls = JSON.stringify(res.body).match(/https?:\/\/[^"]+/g) ?? [];
        for (const url of urls)
          expect(url.startsWith(`${ORIGIN}/media/derived/`)).toBe(true);
      }
    });

    it('S29 AS-55: stored variants are image/webp whatever came in, under keys without a client name', async () => {
      const png = await slot(
        await photo({
          format: 'png',
          width: 500,
          height: 400,
          seed: uniqueSeed(),
        }),
      );
      await t.processor().process(png.originalKey);
      const variants = (await t.row(png.id))!.variants as Record<
        string,
        { key: string }
      >;
      for (const v of Object.values(variants)) {
        expect(v.key).toMatch(/^media\/derived\/[0-9a-f]{64}\.webp$/);
        expect((await t.objectHeaders(v.key))!.contentType).toBe('image/webp');
      }
      expect(png.originalKey).toMatch(
        /^media\/originals\/shops\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/,
      );
    });
  });

  describe('S29 AS-57: metrics and logs', () => {
    it('S29 AS-57: counts a processed, a rejected, a flagged and a failed run and logs structured lines with the queue message trace', async () => {
      const pair = await duplicatePair({ width: 1200, height: 900 });
      const a = await slot(pair.original, 'a');
      const b = await slot(pair.copy, 'b');
      const bad = await slot(phpScript());
      const flaky = await slot(
        await photo({ width: 400, height: 300, seed: uniqueSeed() }),
      );
      const context = { requestId: 'req-57', traceId: 'trace-57' };
      const processor = t.processor();
      await processor.process(a.originalKey, context);
      await processor.process(b.originalKey, context);
      await processor.process(bad.originalKey, context);
      t.scanner.mode = 'down';
      await expect(
        processor.process(flaky.originalKey, context),
      ).rejects.toBeInstanceOf(TransientProcessingError);

      expect(t.metrics.count('media_processing_total{ready}')).toBe(2);
      expect(t.metrics.count('media_processing_total{rejected}')).toBe(1);
      expect(t.metrics.count('media_processing_total{failed}')).toBe(1);
      expect(t.metrics.count('media_duplicate_suspected_total')).toBe(1);
      expect(t.metrics.count('media_scan_unavailable_total')).toBe(1);
      expect(
        t.metrics.observed.filter((o) => o.name === 'media_processing_seconds')
          .length,
      ).toBe(3);
      expect(
        t.metrics.observed.filter(
          (o) => o.name === 'media_upload_to_ready_seconds',
        ).length,
      ).toBe(2);

      expect(t.logger.lines.length).toBeGreaterThan(0);
      for (const line of t.logger.lines) {
        expect(line.fields).toMatchObject({
          requestId: 'req-57',
          traceId: 'trace-57',
        });
        const text = JSON.stringify(line);
        expect(text).not.toMatch(/media\/originals|PhoneCo|Secret-9|<\?php/);
      }
      const done = t.logger.lines.filter(
        (l) => l.message === 'media processed',
      );
      expect(done).toHaveLength(3);
      for (const line of done)
        expect(Object.keys(line.fields)).toEqual(
          expect.arrayContaining([
            'mediaId',
            'result',
            'attempt',
            'durationMs',
          ]),
        );
    });

    it('S29 AS-57: the registry adapter exposes the same instruments under their documented names', async () => {
      const one = await slot(
        await photo({ width: 500, height: 400, seed: uniqueSeed() }),
      );
      const before =
        MetricsRegistry.value('media_processing_total', { result: 'ready' }) ??
        0;
      await t
        .processor({ metrics: registryMediaMetrics })
        .process(one.originalKey);
      expect(
        MetricsRegistry.value('media_processing_total', { result: 'ready' }),
      ).toBe(before + 1);
      expect(
        MetricsRegistry.histogramValue('media_processing_seconds', {
          result: 'ready',
        })?.count,
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.histogramValue('media_upload_to_ready_seconds')?.count,
      ).toBeGreaterThan(0);
      for (const name of [
        'media_duplicate_suspected_total',
        'media_duplicate_scan_truncated_total',
        'media_unknown_key_total',
        'media_scan_unavailable_total',
        'media_processing_attempts_exhausted_total',
      ])
        registryMediaMetrics.inc(name as never);
      for (const name of [
        'media_duplicate_suspected_total',
        'media_unknown_key_total',
        'media_scan_unavailable_total',
      ])
        expect(MetricsRegistry.value(name)).toBeGreaterThanOrEqual(1);
    });

    it('S29 AS-57: the request id of complete reaches the queue message attributes', async () => {
      const created = mediaUploadResponseSchema.parse(
        (
          await t
            .as(w.staff)
            .post(`/api/shops/${w.shop.id}/media/uploads`)
            .send({ purpose: 'product' })
            .expect(201)
        ).body,
      );
      await t.putOriginal(
        created.upload.fields.key,
        await photo({ width: 300, height: 200, seed: uniqueSeed() }),
      );
      const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
      const res = await t
        .as(w.staff)
        .post(`/api/media/${created.mediaId}/complete`)
        .set('traceparent', `00-${trace}-00f067aa0ba902b7-01`)
        .expect(202);
      const attributes = t.queue.sent[0].options?.attributes ?? {};
      expect(attributes.requestId).toBe(res.headers['x-request-id']);
      expect(attributes.traceId).toBe(trace);
    });
  });

  describe('S29 AS-58: configuration', () => {
    const production = {
      media_cdn_url: 'https://cdn.photos-example.net',
      media_bucket: 'marketplace-media',
      clamav_host: 'clamav:3310',
      front_host: 'https://shop.example.com',
      backend_host: 'https://api.example.com',
    };
    const startup = (values: Record<string, unknown>) =>
      ConfigRules.validate(
        { ...production, ...values },
        { production: true },
      ).filter((line) => line.startsWith('[media]'));

    it('starts with a complete production configuration and refuses each bad setting by name', () => {
      expect(startup({})).toEqual([]);
      expect(startup({ media_cdn_url: undefined }).join()).toContain(
        'media_cdn_url',
      );
      expect(
        startup({ media_cdn_url: 'https://media.example.com' }).join(),
      ).toContain('media_cdn_url must be a different site');
      expect(startup({ media_bucket: undefined }).join()).toContain(
        'media_bucket',
      );
      expect(startup({ clamav_host: undefined }).join()).toContain(
        'clamav_host',
      );
      expect(startup({ media_scanner_disabled: true }).join()).toContain(
        'media_scanner_disabled',
      );
    });

    it('the app refuses to start without a media origin', async () => {
      const original = process.env.MEDIA_CDN_URL;
      delete process.env.MEDIA_CDN_URL;
      try {
        await expect(
          (async () => {
            const moduleRef = await generateTestingModule([MediaModule]);
            await moduleRef.createNestApplication().init();
          })(),
        ).rejects.toThrow(/media_cdn_url/);
      } finally {
        process.env.MEDIA_CDN_URL = original;
      }
    });

    it('outside production the scanner may be switched off explicitly, with a warning at start', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [ApiConfigModule, AntivirusModule],
        }).compile();
        expect(moduleRef.get(MalwareScanner)).toBeInstanceOf(
          DisabledMalwareScanner,
        );
        expect(warn.mock.calls.flat().join(' ')).toMatch(
          /malware scanner is DISABLED/i,
        );
        await moduleRef.close();
      } finally {
        warn.mockRestore();
      }
      void randomUUID;
    });
  });
});
