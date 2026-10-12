import { videoPlaybackSchema } from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

const playback = {
  videoId: '0b5f6f0e-1111-4222-8333-444455556666',
  title: 'Unboxing',
  masterUrl: 'https://stream.marketplace.dev/videos/v1/master.m3u8',
  posterUrl: 'https://stream.marketplace.dev/videos/v1/poster.jpg',
  spriteUrl: 'https://stream.marketplace.dev/videos/v1/sprite.jpg',
  durationSec: 42.5,
  width: 1920,
  height: 1080,
  renditions: [{ name: '720p', width: 1280, height: 720 }],
  expiresAt: null,
};

describe('W02 B-7: video playback contract', () => {
  it('W02 B-7: public and unlisted playback bodies parse', () => {
    expect(ok(videoPlaybackSchema, playback)).toBe(true);
    expect(
      ok(videoPlaybackSchema, {
        ...playback,
        expiresAt: '2026-10-10T16:00:00.000Z',
      }),
    ).toBe(true);
    const { spriteUrl: _s, ...noSprite } = playback;
    expect(ok(videoPlaybackSchema, noSprite)).toBe(true);
  });

  it('W02 B-7: playback rejects a non-URL master, a missing expiresAt and a negative duration', () => {
    expect(
      ok(videoPlaybackSchema, {
        ...playback,
        masterUrl: 'videos/v1/master.m3u8',
      }),
    ).toBe(false);
    expect(ok(videoPlaybackSchema, { ...playback, expiresAt: undefined })).toBe(
      false,
    );
    expect(ok(videoPlaybackSchema, { ...playback, durationSec: -1 })).toBe(
      false,
    );
    expect(
      ok(videoPlaybackSchema, { ...playback, renditions: [{ name: '720p' }] }),
    ).toBe(false);
  });
});
