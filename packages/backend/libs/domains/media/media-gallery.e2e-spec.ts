import { randomUUID } from 'node:crypto';
import {
  galleryMemberSchema,
  galleryPublicSchema,
} from '@marketplace-sandbox/contracts';
import { createShop } from '@app/test/utils/tenancy-fixtures';
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

describe('Product gallery API', () => {
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

  const put = (
    user: { id: string; bearer: string },
    shopId: string,
    productId: string,
    body: unknown,
  ) =>
    t
      .as(user as never)
      .put(`/api/shops/${shopId}/products/${productId}/gallery`)
      .send(body as object);
  const memberGet = (
    user: { id: string; bearer: string },
    shopId: string,
    productId: string,
  ) =>
    t
      .as(user as never)
      .get(`/api/shops/${shopId}/products/${productId}/gallery`);
  const publicGet = (productId: string) =>
    t.http().get(`/api/products/${productId}/gallery`);
  const ready = async (n: number, shopId = w.shop.id, uploader = w.staff.id) =>
    Promise.all(
      Array.from({ length: n }, () => t.readyPhoto(shopId, uploader)),
    );
  const links = (productId: string) =>
    t.sql<{ mediaId: string; position: number }>(
      `SELECT "mediaId", "position"::int AS position FROM "ProductMedia" WHERE "productId" = :productId ORDER BY "position"`,
      { productId },
    );
  const versionRow = async (productId: string) =>
    (
      await t.sql<{ version: number }>(
        `SELECT "version" FROM "ProductGallery" WHERE "productId" = :productId`,
        { productId },
      )
    )[0];
  const nothingChanged = async (productId: string) => {
    expect(await links(productId)).toEqual([]);
    expect(await versionRow(productId)).toBeUndefined();
    expect(await t.outbox('media.gallery_changed')).toHaveLength(0);
  };

  describe('S29 US4: write', () => {
    it('S29 AS-30: a member sets the gallery in the order given and one event records it', async () => {
      const product = await t.product(w.shop.id);
      const [m1, m2, m3] = await ready(3);
      const res = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m2.id, m1.id, m3.id],
        expectedVersion: 0,
      }).expect(200);
      const body = galleryMemberSchema.parse(res.body);
      expect(body.items.map((i) => [i.mediaId, i.position])).toEqual([
        [m2.id, 0],
        [m1.id, 1],
        [m3.id, 2],
      ]);
      expect(body.version).toBe(1);
      expect(body.items[0].urls.thumb).toMatch(
        /^https:\/\/media\.marketplace-test\.example\/media\/derived\//,
      );
      expect((await links(product.id)).map((l) => l.mediaId)).toEqual([
        m2.id,
        m1.id,
        m3.id,
      ]);
      expect(await versionRow(product.id)).toEqual({ version: 1 });
      const events = await t.outbox('media.gallery_changed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateId: product.id,
        payload: {
          productId: product.id,
          shopId: w.shop.id,
          mediaIds: [m2.id, m1.id, m3.id],
          galleryVersion: 1,
        },
      });
    });

    it('S29 AS-31: replace, clear and an identical write (which changes nothing and publishes nothing)', async () => {
      const product = await t.product(w.shop.id);
      const [m1, m2] = await ready(2);
      await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id, m2.id],
        expectedVersion: 0,
      }).expect(200);

      const replaced = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id],
        expectedVersion: 1,
      }).expect(200);
      expect(replaced.body.version).toBe(2);
      expect(await links(product.id)).toHaveLength(1);
      expect(await t.outbox('media.gallery_changed')).toHaveLength(2);

      const same = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id],
        expectedVersion: 2,
      }).expect(200);
      expect(same.body.version).toBe(2);
      expect(await t.outbox('media.gallery_changed')).toHaveLength(2);

      const cleared = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [],
        expectedVersion: 2,
      }).expect(200);
      expect(cleared.body).toEqual({ items: [], version: 3 });
      const events = await t.outbox('media.gallery_changed');
      expect(events).toHaveLength(3);
      expect(events.at(-1)!.payload).toMatchObject({
        mediaIds: [],
        galleryVersion: 3,
      });
      expect(await links(product.id)).toEqual([]);
    });

    it.each([
      [
        'more than 20 photos',
        () => ({
          mediaIds: Array.from({ length: 21 }, () => randomUUID()),
          expectedVersion: 0,
        }),
      ],
      [
        'a duplicate id',
        () => {
          const id = randomUUID();
          return { mediaIds: [id, id], expectedVersion: 0 };
        },
      ],
      ['a non-UUID id', () => ({ mediaIds: ['nope'], expectedVersion: 0 })],
      [
        'mediaIds that is not an array',
        () => ({ mediaIds: randomUUID(), expectedVersion: 0 }),
      ],
      ['no mediaIds', () => ({ expectedVersion: 0 })],
      ['no expectedVersion', () => ({ mediaIds: [] })],
      [
        'a negative expectedVersion',
        () => ({ mediaIds: [], expectedVersion: -1 }),
      ],
      [
        'a fractional expectedVersion',
        () => ({ mediaIds: [], expectedVersion: 0.5 }),
      ],
      [
        'a string expectedVersion',
        () => ({ mediaIds: [], expectedVersion: '0' }),
      ],
      [
        'an extra field',
        () => ({ mediaIds: [], expectedVersion: 0, shopId: randomUUID() }),
      ],
    ])(
      'S29 AS-32: %s is 400 validation_failed and changes nothing',
      async (_name, body) => {
        const product = await t.product(w.shop.id);
        const res = await put(w.staff, w.shop.id, product.id, body()).expect(
          400,
        );
        expect(res.body.code).toBe('validation_failed');
        await nothingChanged(product.id);
      },
    );

    it('S29 AS-32: a malformed shop or product id in the path is 400', async () => {
      const product = await t.product(w.shop.id);
      const body = { mediaIds: [], expectedVersion: 0 };
      expect(
        (await put(w.staff, 'not-a-uuid', product.id, body).expect(400)).body
          .code,
      ).toBe('validation_failed');
      expect(
        (await put(w.staff, w.shop.id, 'not-a-uuid', body).expect(400)).body
          .code,
      ).toBe('validation_failed');
      await nothingChanged(product.id);
    });

    it('S29 AS-33: photos that cannot be attached fail per photo, and the three "not found" kinds look the same', async () => {
      const product = await t.product(w.shop.id);
      const own = await t.readyPhoto(w.shop.id, w.staff.id);
      const foreign = await t.readyPhoto(w.otherShop.id, w.otherOwner.id);
      const review = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'READY',
        purpose: 'review',
      });
      const unfinished = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
      });
      const unknown = randomUUID();
      const res = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [own.id, unknown, foreign.id, review.id, unfinished.id],
        expectedVersion: 0,
      }).expect(422);
      expect(res.body.code).toBe('media_not_attachable');
      expect(res.body.failures).toEqual([
        { mediaId: unknown, code: 'not_found' },
        { mediaId: foreign.id, code: 'not_found' },
        { mediaId: review.id, code: 'not_found' },
        { mediaId: unfinished.id, code: 'not_ready' },
      ]);
      await nothingChanged(product.id);
    });

    it('S29 AS-34: an unknown product and a product of another shop are the same 404; an archived one is 409; a stale version is 409 with the current one', async () => {
      const [m1] = await ready(1);
      const unknown = await put(w.staff, w.shop.id, randomUUID(), {
        mediaIds: [m1.id],
        expectedVersion: 0,
      }).expect(404);
      const foreignProduct = await t.product(w.otherShop.id);
      const foreign = await put(w.staff, w.shop.id, foreignProduct.id, {
        mediaIds: [m1.id],
        expectedVersion: 0,
      }).expect(404);
      expect(unknown.body.code).toBe('product_not_found');
      expect(stable(foreign.body)).toEqual(stable(unknown.body));

      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      expect(
        (
          await put(w.staff, w.shop.id, archived.id, {
            mediaIds: [m1.id],
            expectedVersion: 0,
          }).expect(409)
        ).body.code,
      ).toBe('product_archived');

      const product = await t.product(w.shop.id);
      await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id],
        expectedVersion: 0,
      }).expect(200);
      const stale = await put(w.staff, w.shop.id, product.id, {
        mediaIds: [],
        expectedVersion: 0,
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'version_conflict',
        currentVersion: 1,
      });
      expect(await links(product.id)).toHaveLength(1);
      for (const id of [archived.id, foreignProduct.id])
        expect(await links(id)).toEqual([]);
    });

    it('S29 AS-35: two simultaneous edits of the same version: one wins, the other is told to refresh', async () => {
      const product = await t.product(w.shop.id);
      const [m1, m2, m3] = await ready(3);
      await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id],
        expectedVersion: 0,
      }).expect(200);
      const [a, b] = await Promise.all([
        put(w.staff, w.shop.id, product.id, {
          mediaIds: [m1.id, m2.id],
          expectedVersion: 1,
        }),
        put(w.owner, w.shop.id, product.id, {
          mediaIds: [m1.id, m3.id],
          expectedVersion: 1,
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? a : b;
      const stored = (await links(product.id)).map((l) => l.mediaId);
      expect(stored).toEqual(
        winner.body.items.map((i: { mediaId: string }) => i.mediaId),
      );
      expect(await versionRow(product.id)).toEqual({ version: 2 });
      expect(await t.outbox('media.gallery_changed')).toHaveLength(2); // the first write and the winner
    });

    it('S29 AS-36: 401 without credentials, 403 for a viewer, one 404 for a stranger and an unknown shop, closed shops are refused', async () => {
      const product = await t.product(w.shop.id);
      const body = { mediaIds: [], expectedVersion: 0 };
      await t
        .http()
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send(body)
        .expect(401);
      expect(
        (await put(w.viewer, w.shop.id, product.id, body).expect(403)).body
          .code,
      ).toBe('permission_denied');
      const stranger = await put(w.buyer, w.shop.id, product.id, body).expect(
        404,
      );
      const unknown = await put(w.buyer, randomUUID(), product.id, body).expect(
        404,
      );
      expect(stable(stranger.body)).toEqual(stable(unknown.body));
      const suspended = await createShop(t.app, w.owner, {
        status: 'SUSPENDED',
      });
      const closing = await createShop(t.app, w.owner, {
        status: 'DELETING',
        purgeAt: new Date(Date.now() + 86_400_000),
      });
      expect(
        (await put(w.owner, suspended.id, product.id, body).expect(403)).body
          .code,
      ).toBe('shop_suspended');
      expect(
        (await put(w.owner, closing.id, product.id, body).expect(409)).body
          .code,
      ).toBe('shop_offboarding');
      await nothingChanged(product.id);
    });
  });

  describe('S29 US4: reads', () => {
    it('S29 AS-37: every member role reads the gallery, also of an archived product; a foreign product is the 404 of AS-34', async () => {
      const product = await t.product(w.shop.id);
      const [m1] = await ready(1);
      await put(w.staff, w.shop.id, product.id, {
        mediaIds: [m1.id],
        expectedVersion: 0,
      }).expect(200);
      for (const user of [w.owner, w.staff, w.viewer]) {
        const res = await memberGet(user, w.shop.id, product.id).expect(200);
        const body = galleryMemberSchema.parse(res.body);
        expect(body.items.map((i) => i.mediaId)).toEqual([m1.id]);
        expect(body.version).toBe(1);
      }
      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      expect(
        (await memberGet(w.viewer, w.shop.id, archived.id).expect(200)).body,
      ).toEqual({ items: [], version: 0 });
      const foreignProduct = await t.product(w.otherShop.id);
      expect(
        (await memberGet(w.viewer, w.shop.id, foreignProduct.id).expect(404))
          .body.code,
      ).toBe('product_not_found');
      await memberGet(w.buyer, w.shop.id, product.id).expect(404);
    });

    it('S29 AS-38 (W02 B-1): anyone reads a visible product gallery ordered by position, parsed by the contract', async () => {
      const product = await t.product(w.shop.id);
      const [first, second] = await ready(2);
      await put(w.staff, w.shop.id, product.id, {
        mediaIds: [second.id, first.id],
        expectedVersion: 0,
      }).expect(200);
      const res = await publicGet(product.id).expect(200);
      const body = galleryPublicSchema.parse(res.body);
      expect(body.items.map((i) => i.mediaId)).toEqual([second.id, first.id]);
      expect(body.items.map((i) => i.position)).toEqual([0, 1]);
      expect(body.items[0]).toMatchObject({ width: 1600, height: 1200 });
      expect(body.items[0].urls.thumb).toContain('/media/derived/');
      expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=15/);
    });

    it('S29 AS-38 (W02 B-1): only READY photos are listed, and a product without photos answers an empty list', async () => {
      const product = await t.product(w.shop.id);
      const readyPhoto = await t.readyPhoto(w.shop.id, w.staff.id);
      const processing = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
      });
      const rejected = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'REJECTED',
        rejectCode: 'not_an_image',
      });
      // a photo that left READY after it was attached (the link stays until the gallery changes)
      await t.sql(
        `INSERT INTO "ProductMedia" ("productId","mediaId","position") VALUES (:p,:a,0),(:p,:b,1),(:p,:c,2)`,
        {
          p: product.id,
          a: readyPhoto.id,
          b: processing.id,
          c: rejected.id,
        },
      );
      const res = await publicGet(product.id).expect(200);
      expect(res.body.items.map((i: { mediaId: string }) => i.mediaId)).toEqual(
        [readyPhoto.id],
      );
      const bare = await t.product(w.shop.id);
      expect((await publicGet(bare.id).expect(200)).body).toEqual({
        items: [],
      });
    });

    it('S29 AS-38 (W02 B-1): unknown, archived, sandbox, suspended-shop and closing-shop products answer the identical 404; a malformed id is 400', async () => {
      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      const sandbox = await t.product(w.shop.id, { isSandbox: true });
      const suspendedShop = await createShop(t.app, w.owner, {
        status: 'SUSPENDED',
      });
      const closingShop = await createShop(t.app, w.owner, {
        status: 'DELETING',
        purgeAt: new Date(Date.now() + 86_400_000),
      });
      const sandboxShop = await createShop(t.app, w.owner, {
        sandboxOf: w.shop.id,
      });
      const inSuspended = await t.product(suspendedShop.id);
      const inClosing = await t.product(closingShop.id);
      const inSandbox = await t.product(sandboxShop.id);
      const photoId = (await t.readyPhoto(w.shop.id, w.staff.id)).id;
      for (const p of [archived, sandbox, inSuspended, inClosing, inSandbox])
        await t.sql(
          `INSERT INTO "ProductMedia" ("productId","mediaId","position") VALUES (:p,:m,0)`,
          { p: p.id, m: photoId },
        );

      const baseline = await publicGet(randomUUID()).expect(404);
      expect(baseline.body.code).toBe('product_not_found');
      for (const hidden of [
        archived,
        sandbox,
        inSuspended,
        inClosing,
        inSandbox,
      ]) {
        const res = await publicGet(hidden.id).expect(404);
        expect(stable(res.body)).toEqual(stable(baseline.body));
      }
      expect((await publicGet('not-a-uuid').expect(400)).body.code).toBe(
        'validation_failed',
      );
    });
  });
});
