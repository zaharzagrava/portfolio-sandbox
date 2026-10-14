import {
  productVideosSchema,
  videoCompleteResponseSchema,
  videoOwnerSchema,
  videoPlaybackSchema,
  videoStartResponseSchema,
} from '@marketplace-sandbox/contracts';
import { fakeVideo } from './testing/test-videos';
import {
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

/**
 * The whole life of one video through the real HTTP routes, the real queue consumer and the real storage, in one
 * story (the single journey the old `video.e2e-spec.ts` told by calling the service): a seller starts an upload, puts
 * the bytes with the permission, completes, the workers run wave by wave, the video is `READY`, a visitor plays it and
 * finds it on the product page. The scenarios are proved one by one in the six suites; this is the line that joins them.
 */
describe('Video journey, from upload to playback', () => {
  let t: VideoTestApp;
  let w: VideoWorld;

  beforeAll(async () => {
    t = await createVideoApp({ worker: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.encoder!.uninstall();
    await t.reset();
    w = await t.world();
    t.encoder!.install();
  });
  afterEach(() => t.encoder!.uninstall());

  it('S30 AS-15: upload, complete, probe → poster + renditions → package → publish → READY, played by anyone and listed on the product page, fan-in exactly once', async () => {
    const product = await t.product(w.shop.id);
    const started = videoStartResponseSchema.parse(
      (
        await t
          .as(w.staff)
          .post(`/api/shops/${w.shop.id}/videos`)
          .send({
            title: 'Unboxing',
            sizeBytes: 2048,
            contentType: 'video/mp4',
            visibility: 'public',
            productId: product.id,
          })
          .expect(201)
      ).body,
    );
    const etags = await t.uploadParts(started, { bodyOf: () => fakeVideo() });
    const completed = videoCompleteResponseSchema.parse(
      (
        await t
          .as(w.staff)
          .post(`/api/shops/${w.shop.id}/videos/${started.videoId}/complete`)
          .send({ parts: etags })
          .expect(202)
      ).body,
    );
    expect(completed.status).toBe('PROCESSING');

    // wave by wave, as several workers would: every message of a wave at the same moment
    const waves: string[][] = [];
    while (t.queue.pending().length > 0) {
      waves.push(
        t.queue
          .pending()
          .map((m) => (m.body as { task: string }).task)
          .sort(),
      );
      await t.queue.wave();
    }
    expect(waves).toEqual([
      ['probe'],
      [
        'poster',
        'thumbnails',
        'transcode:240',
        'transcode:480',
        'transcode:720',
      ],
      ['package'], // the four siblings finished together and queued it once
      ['publish'],
    ]);

    const owner = videoOwnerSchema.parse(
      (
        await t
          .as(w.viewer)
          .get(`/api/shops/${w.shop.id}/videos/${started.videoId}`)
          .expect(200)
      ).body,
    );
    expect(owner).toMatchObject({
      status: 'READY',
      productId: product.id,
      progress: { tasksDone: 8, tasksTotal: 8 },
    });
    const playback = videoPlaybackSchema.parse(
      (
        await t
          .http()
          .get(`/api/videos/${started.videoId}/playback`)
          .expect(200)
      ).body,
    );
    expect(playback.masterUrl).toBe(
      `${(process.env.VIDEO_CDN_URL || 'https://stream.localhost').replace(/\/+$/, '')}/p/${started.videoId}/master.m3u8`,
    );
    expect(playback.renditions.map((r) => r.name)).toEqual([
      '240p',
      '480p',
      '720p',
    ]);
    const listed = productVideosSchema.parse(
      (await t.http().get(`/api/products/${product.id}/videos`).expect(200))
        .body,
    );
    expect(listed.items.map((i) => i.videoId)).toEqual([started.videoId]);
    expect(await t.outbox('video.ready')).toHaveLength(1);
  });
});
