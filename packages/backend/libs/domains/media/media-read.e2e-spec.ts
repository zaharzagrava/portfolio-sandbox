import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import {
  mediaBatchItemSchema,
  mediaOwnerSchema,
  mediaPublicSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { MediaQueryService } from '@app/domains/media';
import type { MediaStatus } from './domain/media-status';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';

const stable = ({
  requestId,
  instance,
  traceId,
  ...rest
}: Record<string, unknown>) => {
  void requestId;
  void instance;
  void traceId;
  return rest;
};
const ORIGIN = 'https://media.marketplace-test.example';

describe('Media read API', () => {
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

  const statements = () => {
    const spy = jest.spyOn(t.app.get(Sequelize), 'query');
    return {
      count: () => spy.mock.calls.length,
      text: () => spy.mock.calls.map((call) => String(call[0])),
      restore: () => spy.mockRestore(),
    };
  };

  describe('S29 US5: one photo', () => {
    it('S29 AS-41: anyone reads a READY photo; the view is public, cacheable and shows no internals', async () => {
      const { id, originalKey } = await t.readyPhoto(w.shop.id, w.staff.id);
      await t.sql(
        `UPDATE "Media" SET "dhash" = 'ffeeddccbbaa9988', "possibleDuplicateOf" = :other WHERE "id" = :id`,
        { id, other: randomUUID() },
      );
      const res = await t.http().get(`/api/media/${id}`).expect(200);
      const view = mediaPublicSchema.parse(res.body);
      expect(view).toMatchObject({
        id,
        status: 'READY',
        purpose: 'product',
        shopId: w.shop.id,
        width: 1600,
        height: 1200,
      });
      expect(res.headers['cache-control']).toBe('public, max-age=15');
      for (const url of Object.values(view.urls)) {
        expect(url.startsWith(`${ORIGIN}/media/derived/`)).toBe(true);
        expect(url.endsWith('.webp')).toBe(true);
      }
      const text = JSON.stringify(res.body);
      for (const forbidden of [
        originalKey,
        'uploaderId',
        w.staff.id,
        'possibleDuplicateOf',
        'rejectCode',
        'dhash',
        'history',
        'originalKey',
      ])
        expect(text).not.toContain(forbidden);
      const review = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'READY',
        purpose: 'review',
        variants: (await t
          .readyPhoto(w.shop.id, w.staff.id)
          .then(async (p) => (await t.row(p.id))!.variants)) as never,
        width: 10,
        height: 10,
      });
      expect(
        (await t.http().get(`/api/media/${review.id}`).expect(200)).body.shopId,
      ).toBeNull();
    });

    const states: MediaStatus[] = [
      'PENDING_UPLOAD',
      'UPLOADED',
      'PROCESSING',
      'REJECTED',
      'EXPIRED',
      'DELETED',
    ];
    it.each(states)(
      'S29 AS-42: a %s shop photo is private to its uploader and members; everybody else gets the one 404',
      async (status) => {
        const photo = await t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
          rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
        });
        const unknown = await t
          .http()
          .get(`/api/media/${randomUUID()}`)
          .expect(404);
        expect(unknown.body.code).toBe('media_not_found');
        const hidden = [
          await t.http().get(`/api/media/${photo.id}`).expect(404),
          await t.as(w.buyer).get(`/api/media/${photo.id}`).expect(404),
          await t.as(w.otherOwner).get(`/api/media/${photo.id}`).expect(404),
        ];
        for (const res of hidden)
          expect(stable(res.body)).toEqual(stable(unknown.body));

        for (const member of [w.staff, w.owner, w.viewer]) {
          const res = await t.as(member).get(`/api/media/${photo.id}`);
          if (status === 'DELETED') {
            expect(res.status).toBe(404);
            continue;
          }
          expect(res.status).toBe(200);
          const view = mediaOwnerSchema.parse(res.body);
          expect(view.status).toBe(status);
          expect(view.urls).toBeNull();
          expect(view.rejectCode).toBe(
            status === 'REJECTED' ? 'not_an_image' : undefined,
          );
          expect(res.headers['cache-control']).toBe('private, no-store');
          expect(JSON.stringify(res.body)).not.toContain(photo.originalKey);
        }
      },
    );

    it('S29 AS-42: a review photo is private to its uploader alone, even a shop member cannot see it', async () => {
      const photo = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'PROCESSING',
        purpose: 'review',
      });
      expect(
        (await t.as(w.buyer).get(`/api/media/${photo.id}`).expect(200)).body
          .status,
      ).toBe('PROCESSING');
      await t.as(w.owner).get(`/api/media/${photo.id}`).expect(404);
      await t.http().get(`/api/media/${photo.id}`).expect(404);
    });

    it('S29 AS-43: a malformed id is 400 without touching the database', async () => {
      const spy = statements();
      try {
        const res = await t.http().get('/api/media/not-a-uuid').expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(spy.count()).toBe(0);
      } finally {
        spy.restore();
      }
    });
  });

  describe('S29 US5: batch and the exported lookup', () => {
    it('S29 AS-44: the batch answers in request order, null for anything not READY, from one statement', async () => {
      const a = await t.readyPhoto(w.shop.id, w.staff.id);
      const b = await t.readyPhoto(w.shop.id, w.staff.id);
      const pending = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
      });
      const ids = [a.id, randomUUID(), b.id, a.id, pending.id];
      const spy = statements();
      try {
        const res = await t
          .http()
          .get(`/api/batch/media?ids=${ids.join(',')}`)
          .expect(200);
        expect(spy.count()).toBe(1);
        expect(res.body).toHaveLength(5);
        const items = res.body.map((item: unknown) =>
          mediaBatchItemSchema.parse(item),
        );
        expect(items.map((i: { id: string } | null) => i?.id ?? null)).toEqual([
          a.id,
          null,
          b.id,
          a.id,
          null,
        ]);
        expect(res.headers['cache-control']).toBe('public, max-age=15');
      } finally {
        spy.restore();
      }
    });

    it('S29 AS-44: more than 100 ids, a non-UUID, or none is 400', async () => {
      const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
      expect(
        (await t.http().get(`/api/batch/media?ids=${many}`).expect(400)).body
          .code,
      ).toBe('validation_failed');
      await t
        .http()
        .get(`/api/batch/media?ids=${randomUUID()},nope`)
        .expect(400);
      await t.http().get('/api/batch/media').expect(400);
      await t
        .http()
        .get(
          `/api/batch/media?ids=${Array.from({ length: 100 }, () => randomUUID()).join(',')}`,
        )
        .expect(200);
    });

    it('S29 AS-45: getReadyMediaByIds pushes its predicates into one query and returns DTOs only', async () => {
      const service = t.app.get(MediaQueryService);
      const mine = await t.readyPhoto(w.shop.id, w.staff.id);
      const theirs = await t.readyPhoto(w.otherShop.id, w.otherOwner.id);
      const review = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'READY',
        purpose: 'review',
        variants: (await t.row(mine.id))!.variants,
        width: 5,
        height: 5,
      });
      const deleted = await t.readyPhoto(w.shop.id, w.staff.id, {
        status: 'DELETED',
      });
      const unfinished = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
      });
      const ids = [
        mine.id,
        theirs.id,
        review.id,
        deleted.id,
        unfinished.id,
        randomUUID(),
        mine.id,
      ];

      const spy = statements();
      try {
        const all = await service.getReadyMediaByIds(ids);
        expect(spy.count()).toBe(1);
        expect([...all.keys()].sort()).toEqual(
          [mine.id, theirs.id, review.id].sort(),
        );
        expect(Object.keys(all.get(mine.id)!).sort()).toEqual([
          'createdAt',
          'height',
          'id',
          'purpose',
          'shopId',
          'urls',
          'width',
        ]);
        expect(all.get(mine.id)!.urls.thumb.startsWith(ORIGIN)).toBe(true);
        expect(all.get(mine.id)!.createdAt).toBeInstanceOf(Date);
      } finally {
        spy.restore();
      }

      const ofBuyer = await service.getReadyMediaByIds(ids, {
        uploaderId: w.buyer.id,
        purpose: 'review',
      });
      expect([...ofBuyer.keys()]).toEqual([review.id]);
      expect([
        ...(
          await service.getReadyMediaByIds(ids, { shopId: w.shop.id })
        ).keys(),
      ]).toEqual([mine.id]);
      expect(
        (
          await service.getReadyMediaByIds(ids, {
            uploaderId: w.staff.id,
            purpose: 'review',
          })
        ).size,
      ).toBe(0);
      expect((await service.getReadyMediaByIds([])).size).toBe(0);
      await expect(
        service.getReadyMediaByIds(
          Array.from({ length: 501 }, () => randomUUID()),
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(
        (
          await service.getReadyMediaByIds(
            Array.from({ length: 500 }, () => randomUUID()),
          )
        ).size,
      ).toBe(0);
    });
  });

  describe('S29 US5: read limits', () => {
    it('S29 AS-46: the 601st read of an address in a minute is 429 with Retry-After', async () => {
      const id = randomUUID();
      for (let i = 0; i < 600; i++) {
        const res = await t.http().get(`/api/media/${id}`);
        if (res.status !== 404)
          throw new Error(`read ${i} answered ${res.status}`);
      }
      const limited = await t.http().get(`/api/media/${id}`).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
    }, 120_000);
  });

  describe('S29 US5: read limiter outage', () => {
    let down: MediaTestApp;
    beforeAll(async () => {
      down = await createMediaApp({ redisProxy: true });
    });
    afterAll(() => down.close());

    it('S29 AS-46: reads fail open when the limiter store is down, and the failure is counted', async () => {
      await down.reset();
      const world = await down.world();
      const photo = await down.readyPhoto(world.shop.id, world.staff.id);
      await down.http().get(`/api/media/${photo.id}`).expect(200);
      const before =
        MetricsRegistry.value('rate_limit_store_unavailable_total', {
          policy: 'media.read.ip',
          fail_mode: 'open',
        }) ?? 0;
      down.proxies[0].mode = 'refuse';
      try {
        await down.http().get(`/api/media/${photo.id}`).expect(200);
        const after =
          MetricsRegistry.value('rate_limit_store_unavailable_total', {
            policy: 'media.read.ip',
            fail_mode: 'open',
          }) ?? 0;
        expect(after).toBeGreaterThan(before);
      } finally {
        down.proxies[0].mode = 'pass';
      }
    });
  });
});
