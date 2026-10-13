import { createVerify, randomUUID } from 'node:crypto';
import {
  productVideosSchema,
  videoPlaybackSchema,
} from '@marketplace-sandbox/contracts';
import { ProductQueryService } from '@app/domains/catalog';
import { DeliveryEdgeNotConfiguredError } from '@app/infrastructure/delivery-edge';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { setTimeout as sleep } from 'node:timers/promises';
import { VideoStore, type VideoOutputs } from './domain/video-ports';
import { fakeVideo } from './testing/test-videos';
import {
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

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

const OUTPUTS: VideoOutputs = {
  master: 'master.m3u8',
  poster: 'poster/a1/poster.jpg',
  sprite: 'sprite/a1/sprite.jpg',
  renditions: [
    {
      name: '240p',
      width: 426,
      height: 240,
      bandwidth: 500_000,
      averageBandwidth: 400_000,
      frameRate: 30,
      codecs: 'avc1.4d4015,mp4a.40.2',
    },
    {
      name: '720p',
      width: 1280,
      height: 720,
      bandwidth: 3_000_000,
      averageBandwidth: 2_600_000,
      frameRate: 30,
      codecs: 'avc1.4d401f,mp4a.40.2',
    },
  ],
};
const ORIGIN = 'https://stream.localhost';
const STATUSES = [
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'FAILED',
  'EXPIRED',
  'DELETED',
] as const;

describe('Video playback and delivery API', () => {
  let t: VideoTestApp;
  let w: VideoWorld;

  beforeAll(async () => {
    t = await createVideoApp({ worker: true, structuredLogger: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });
  afterEach(() => {
    t.encoder?.uninstall();
    jest.restoreAllMocks();
  });

  const ready = (over: Record<string, unknown> = {}) =>
    t.video({
      shopId: w.shop.id,
      uploaderId: w.staff.id,
      status: 'READY',
      outputs: OUTPUTS,
      durationSec: 6,
      width: 1280,
      height: 720,
      ...over,
    });
  const playback = (id: string, token?: string) =>
    t
      .http()
      .get(
        `/api/videos/${id}/playback${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`,
      );
  const cookies = (res: { headers: Record<string, unknown> }): string[] =>
    (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const row = async (id: string) => (await t.row(id))!;
  const unknown = async () => (await playback(randomUUID()).expect(404)).body;

  describe('S30 US3: playback', () => {
    it('S30 AS-31: a public READY video answers anyone with a body on the video host, no cookie, a 60 s cache, and no source or storage address', async () => {
      const v = await ready();
      const res = await playback(v.id).expect(200);
      const body = videoPlaybackSchema.parse(res.body);
      expect(body).toMatchObject({
        videoId: v.id,
        masterUrl: `${ORIGIN}/p/${v.id}/master.m3u8`,
        posterUrl: `${ORIGIN}/p/${v.id}/poster/a1/poster.jpg`,
        spriteUrl: `${ORIGIN}/p/${v.id}/sprite/a1/sprite.jpg`,
        durationSec: 6,
        width: 1280,
        height: 720,
        expiresAt: null,
      });
      expect(body.renditions).toEqual([
        { name: '240p', width: 426, height: 240 },
        { name: '720p', width: 1280, height: 720 },
      ]);
      expect(cookies(res)).toEqual([]);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const everything = JSON.stringify([res.body, res.headers]);
      expect(everything).not.toContain('vsrc/');
      expect(everything).not.toMatch(/9210|marketplace-media/);
    });

    it('S30 AS-31: a video without a sprite answers spriteUrl null', async () => {
      const v = await ready({ outputs: { ...OUTPUTS, sprite: null } });
      expect((await playback(v.id).expect(200)).body.spriteUrl).toBeNull();
    });

    it('S30 AS-32: an unlisted video with its token gets a 4 h credential for its own path: three cookies with the right attributes and a signature that verifies', async () => {
      const v = await ready({ visibility: 'unlisted' });
      const token = (await row(v.id)).shareToken as string;
      const T = t.clock.now();
      const res = await playback(v.id, token).expect(200);
      const expires = new Date(T.getTime() + 4 * 3_600_000);
      expect(videoPlaybackSchema.parse(res.body)).toMatchObject({
        masterUrl: `${ORIGIN}/u/${v.id}/master.m3u8`,
        expiresAt: expires.toISOString(),
      });
      expect(res.headers['cache-control']).toBe('private, no-store');
      const set = cookies(res);
      expect(set).toHaveLength(3);
      for (const line of set) {
        expect(line).toContain('Secure');
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=None');
        expect(line).toContain(`Path=/u/${v.id}/`);
        expect(line).toContain('Domain=localhost');
        expect(line).toContain(`Expires=${expires.toUTCString()}`);
      }
      const value = (name: string) =>
        set
          .find((l) => l.startsWith(`${name}=`))!
          .split(';')[0]
          .slice(name.length + 1);
      const unmap = (s: string) =>
        s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
      const policy = Buffer.from(
        unmap(value('CloudFront-Policy')),
        'base64',
      ).toString();
      const parsed = JSON.parse(policy);
      expect(parsed.Statement).toHaveLength(1);
      expect(parsed.Statement[0].Resource).toBe(`${ORIGIN}/u/${v.id}/*`);
      expect(parsed.Statement[0].Condition.DateLessThan['AWS:EpochTime']).toBe(
        Math.floor(expires.getTime() / 1000),
      );
      const verifier = createVerify('RSA-SHA1').update(policy);
      expect(
        verifier.verify(
          t.publicKey,
          Buffer.from(unmap(value('CloudFront-Signature')), 'base64'),
        ),
      ).toBe(true);
      expect(value('CloudFront-Key-Pair-Id')).toBe('KTESTKEYPAIR');
    });

    it("S30 AS-33: no token, a wrong token, another video's token and an empty token answer the body of an unknown id, with no cookie", async () => {
      const v = await ready({ visibility: 'unlisted' });
      const other = await ready({ visibility: 'unlisted' });
      const otherToken = (await row(other.id)).shareToken as string;
      const baseline = stable(await unknown());
      for (const res of [
        await playback(v.id).expect(404),
        await playback(v.id, 'wrong').expect(404),
        await playback(v.id, otherToken).expect(404),
        await playback(v.id, '').expect(404),
        await t
          .http()
          .get(`/api/videos/${v.id}/playback?token=a&token=b`)
          .expect(404),
      ]) {
        expect(stable(res.body)).toEqual(baseline);
        expect(cookies(res)).toEqual([]);
      }
      expect(
        t.edge && 'signed' in t.edge
          ? (t.edge as { signed: unknown[] }).signed
          : [],
      ).toHaveLength(0);
      await playback(v.id, (await row(v.id)).shareToken).expect(200);
    });

    it('S30 AS-34: every status but READY, a suspended shop and a deleted video are the same 404; the shop resumes with a higher version', async () => {
      const baseline = stable(await unknown());
      for (const status of STATUSES) {
        const pub = await ready({ status, outputs: undefined });
        const unl = await ready({
          status,
          visibility: 'unlisted',
          outputs: undefined,
        });
        expect(stable((await playback(pub.id).expect(404)).body)).toEqual(
          baseline,
        );
        const token = (await row(unl.id)).shareToken as string;
        expect(
          stable((await playback(unl.id, token).expect(404)).body),
        ).toEqual(baseline);
      }
      const v = await ready();
      await playback(v.id).expect(200);
      await t.sql(
        `INSERT INTO "VideoShopState" ("shopId","suspended","shopVersion") VALUES (:shopId, true, 5)`,
        { shopId: w.shop.id },
      );
      expect(stable((await playback(v.id).expect(404)).body)).toEqual(baseline);
      await t.sql(
        `UPDATE "VideoShopState" SET "suspended" = false, "shopVersion" = 6 WHERE "shopId" = :shopId RETURNING 1`,
        { shopId: w.shop.id },
      );
      await playback(v.id).expect(200);
      await t.app.get(VideoStore).tx(({ video }) =>
        video.softDelete({
          id: v.id,
          shopId: w.shop.id,
          actor: { type: 'user', id: w.owner.id },
          now: t.clock.now(),
        }),
      );
      expect(stable((await playback(v.id).expect(404)).body)).toEqual(baseline);
    });

    it('S30 AS-35: with no signing key an unlisted video answers 503 with no URL and no cookie, never an unsigned address', async () => {
      const v = await ready({ visibility: 'unlisted' });
      const token = (await row(v.id)).shareToken as string;
      // the edge raises the typed error a missing key pair raises in production, and the service maps it
      (t.edge as { failSigning(e: Error): void }).failSigning(
        new DeliveryEdgeNotConfiguredError(),
      );
      const res = await playback(v.id, token);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('service_unavailable');
      expect(cookies(res)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(
        /stream\.localhost|master\.m3u8|key/i,
      );
      // public playback is unaffected
      await playback((await ready()).id).expect(200);
    });

    it('S30 AS-36: no route answers with the source location, an upload id or a storage address, for anyone', async () => {
      const mine: { id: string; sourceKey: string; uploadId: string | null }[] =
        [];
      for (const status of [...STATUSES, 'READY'] as const) {
        const v = await ready({
          status,
          outputs: status === 'READY' ? OUTPUTS : undefined,
        });
        const r = await row(v.id);
        mine.push({ id: v.id, sourceKey: r.sourceKey, uploadId: r.uploadId });
      }
      const product = await t.product(w.shop.id);
      await t.sql(
        `UPDATE "Video" SET "productId" = :p WHERE "status" = 'READY'`,
        { p: product.id },
      );
      const leaks = (res: {
        body: unknown;
        headers: Record<string, unknown>;
      }) => {
        const text = JSON.stringify([res.body, res.headers]);
        for (const m of mine) {
          expect(text).not.toContain(m.sourceKey);
          if (m.uploadId) expect(text).not.toContain(m.uploadId);
        }
        expect(text).not.toMatch(/vsrc\//);
        expect(text).not.toMatch(/:9210|marketplace-media-test/);
      };
      for (const m of mine) {
        leaks(await playback(m.id));
        leaks(
          await t
            .as(w.staff)
            .get(`/api/shops/${w.shop.id}/videos/${m.id}/upload`),
        );
        leaks(await t.as(w.owner).get(`/api/videos/${m.id}/playback`));
      }
      leaks(await t.http().get(`/api/products/${product.id}/videos`));
    });

    it('S30 AS-37: every stored output has its content type, the immutable cache header and a key made only of ids and constants', async () => {
      t.encoder!.install();
      const v = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
        title: '../../etc/passwd; rm -rf',
      });
      await t.runWaves();
      expect((await row(v.id)).status).toBe('READY');
      const keys = (await t.storage.list(`p/${v.id}/`)).map((o) => o.key);
      expect(keys.length).toBeGreaterThan(10);
      const shape = new RegExp(
        `^p/${v.id}/(master\\.m3u8|r/(240|480|720)/a\\d+/(index\\.m3u8|seg_\\d{5}\\.ts)|poster/a\\d+/poster\\.jpg|sprite/a\\d+/sprite\\.(jpg|vtt))$`,
      );
      const types: Record<string, string> = {
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t',
        '.jpg': 'image/jpeg',
        '.vtt': 'text/vtt',
      };
      for (const key of keys) {
        expect(key).toMatch(shape);
        expect(key).not.toMatch(/passwd|\.\./);
        const headers = (await t.objectHeaders(key))!;
        expect(headers.contentType).toBe(
          types[key.slice(key.lastIndexOf('.'))],
        );
        expect(headers.cacheControl).toBe(
          'public, max-age=31536000, immutable',
        );
      }
    });
  });

  describe('S30 US3: the product page list', () => {
    it("S30 AS-38: only READY public videos of a visible product, newest first, at most 10, one batch read, parsed by the BFF's schema", async () => {
      const product = await t.product(w.shop.id);
      const other = await t.product(w.shop.id);
      const base = t.clock.now().getTime();
      const made: string[] = [];
      for (let i = 0; i < 12; i++) {
        const v = await ready({
          productId: product.id,
          createdAt: new Date(base + i * 1000),
          title: `v${i}`,
        });
        made.push(v.id);
      }
      await ready({ productId: product.id, visibility: 'unlisted' });
      await ready({
        productId: product.id,
        status: 'PROCESSING',
        outputs: undefined,
      });
      await ready({ productId: product.id, status: 'DELETED' });
      await ready({ productId: other.id });
      const read = jest.spyOn(
        t.app.get(ProductQueryService),
        'getProductsByIds',
      );
      const res = await t
        .http()
        .get(`/api/products/${product.id}/videos`)
        .expect(200);
      expect(read).toHaveBeenCalledTimes(1);
      const body = productVideosSchema.parse(res.body);
      expect(body.items.map((i) => i.videoId)).toEqual(made.slice(2).reverse());
      expect(body.items[0]).toEqual({
        videoId: made[11],
        title: 'v11',
        posterUrl: `${ORIGIN}/p/${made[11]}/poster/a1/poster.jpg`,
        durationSec: 6,
      });
      expect(res.headers['cache-control']).toBe('public, max-age=15');
    });

    it('S30 AS-38: an archived, sandbox or unknown product, or one of a suspended shop, is the same 404', async () => {
      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      const sandbox = await t.product(w.shop.id, { isSandbox: true });
      const suspendedShop = await t.product(w.otherShop.id);
      await t.sql(
        `INSERT INTO "VideoShopState" ("shopId","suspended","shopVersion") VALUES (:shopId, true, 1)`,
        { shopId: w.otherShop.id },
      );
      const answers = [
        await t.http().get(`/api/products/${archived.id}/videos`).expect(404),
        await t.http().get(`/api/products/${sandbox.id}/videos`).expect(404),
        await t.http().get(`/api/products/${randomUUID()}/videos`).expect(404),
        await t
          .http()
          .get(`/api/products/${suspendedShop.id}/videos`)
          .expect(404),
      ];
      for (const a of answers) {
        expect(a.body.code).toBe('product_not_found');
        expect(stable(a.body)).toEqual(stable(answers[0].body));
      }
    });
  });

  describe('S30 US3: reads cost nothing', () => {
    it('S30 AS-40: 1,000 playbacks change no row of Video, VideoTask, VideoStatusHistory or the outbox, and the counter reads 1,000', async () => {
      const v = await ready();
      const snapshot = async () =>
        JSON.stringify(
          await t.sql(
            `SELECT (SELECT count(*) FROM "Video") AS videos, (SELECT max("updatedAt") FROM "Video") AS updated,
                    (SELECT sum("version") FROM "Video") AS versions, (SELECT count(*) FROM "VideoTask") AS tasks,
                    (SELECT count(*) FROM "VideoStatusHistory") AS history, (SELECT count(*) FROM "Outbox") AS outbox`,
          ),
        );
      const before = await snapshot();
      for (let i = 0; i < 1000; i++) {
        if (i % 500 === 0) t.clock.advance(61_000); // the limiter reads the frozen clock: a fresh minute
        await playback(v.id).expect(200);
      }
      expect(await snapshot()).toBe(before);
      expect(t.metrics.count('video_playback_total{public,ok}')).toBe(1000);
    }, 120_000);

    it('S30 AS-41: the share token, the cookie values and the private key appear in no log line, error body or metric; the token is never logged', async () => {
      const v = await ready({ visibility: 'unlisted' });
      const token = (await row(v.id)).shareToken as string;
      const res = await playback(v.id, token).expect(200);
      const secrets = [
        token,
        ...cookies(res)
          .filter((l) => !l.startsWith('CloudFront-Key-Pair-Id')) // an identifier, not a secret
          .map((l) => l.split(';')[0].split('=').slice(1).join('=')),
      ];
      const wrong = await playback(v.id, 'not-the-token').expect(404);
      await sleep(50);
      const haystack = [
        t.rawLogs(),
        JSON.stringify(t.logger.lines),
        JSON.stringify(wrong.body),
        JSON.stringify([...t.metrics.counts.keys()]),
        JSON.stringify(t.metrics.observed),
      ].join('\n');
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(20);
        expect(haystack).not.toContain(secret);
      }
      expect(haystack).not.toContain('not-the-token');
      expect(haystack).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(haystack).not.toContain(t.privateKey.split('\n')[1]);
      expect(haystack).not.toMatch(/X-Amz-Signature/);
      // the access line names the route template, never the query string
      expect(t.rawLogs()).not.toMatch(/token=/);
    });

    it('S30 AS-39: the 601st playback or list request of an address within a minute is 429 with Retry-After', async () => {
      const v = await ready();
      for (let i = 0; i < 600; i++) await playback(v.id).expect(200);
      const limited = await playback(v.id).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(
        (await t.http().get(`/api/products/${randomUUID()}/videos`)).status,
      ).toBe(429);
    }, 120_000);
  });

  // Last on purpose: a second application in the same process rebinds the model classes to its own connection, which
  // is closed with it; every describe above must have finished with the first one.
  describe('S30 US3: rate limiter outage', () => {
    let down: VideoTestApp;
    beforeAll(async () => {
      down = await createVideoApp({ redisProxy: true });
    });
    afterAll(() => down.close());

    it('S30 AS-39: when the limiter store is down playback is still served (fail open)', async () => {
      await down.reset();
      const world = await down.world();
      const v = await down.video({
        shopId: world.shop.id,
        uploaderId: world.staff.id,
        status: 'READY',
        outputs: OUTPUTS,
        durationSec: 6,
        width: 1280,
        height: 720,
      });
      await down.http().get(`/api/videos/${v.id}/playback`).expect(200);
      down.redisProxy!.mode = 'refuse';
      down.redisProxy!.sever();
      const redis = down.app.get(RedisService);
      for (let i = 0; i < 500 && redis.client.status === 'ready'; i++)
        await sleep(10);
      try {
        const res = await down.http().get(`/api/videos/${v.id}/playback`);
        expect(res.status).toBe(200);
        expect(videoPlaybackSchema.parse(res.body).videoId).toBe(v.id);
      } finally {
        down.redisProxy!.mode = 'pass';
      }
    }, 60_000);
  });
});
