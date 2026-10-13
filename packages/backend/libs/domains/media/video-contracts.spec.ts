import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  productVideosSchema,
  videoCompleteRequestSchema,
  videoCompleteResponseSchema,
  videoEventSchemas,
  videoListSchema,
  videoOwnerSchema,
  videoPatchRequestSchema,
  videoPlaybackSchema,
  videoProblemCodes,
  videoStartRequestSchema,
  videoStartResponseSchema,
  videoUploadStateSchema,
} from '@marketplace-sandbox/contracts';
import {
  VideoDeleted,
  VideoFailed,
  VideoReady,
  videoEventDefinitions,
} from './domain/video-events';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

const id = '0b5f6f0e-1111-4222-8333-444455556666';
const shopId = '1c6a7a1f-2222-4333-8444-555566667777';
const userId = '2d7b8b20-3333-4444-8555-666677778888';
const productId = '3e8c9c31-4444-4555-8666-777788889999';
const at = '2026-10-10T16:00:00.000Z';

const playback = {
  videoId: id,
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

const part = {
  partNumber: 1,
  url: 'https://storage.marketplace.dev/p1?sig=abc',
  contentLength: 67108864,
};
const startRequest = {
  title: 'Launch demo',
  sizeBytes: 200000000,
  contentType: 'video/mp4',
  visibility: 'public',
};
const startResponse = {
  videoId: id,
  partSize: 67108864,
  partCount: 3,
  expiresAt: at,
  visibility: 'public',
  shareToken: null,
  parts: [
    part,
    { ...part, partNumber: 2 },
    { ...part, partNumber: 3, contentLength: 65782272 },
  ],
};
const uploadState = {
  status: 'UPLOADING',
  partSize: 67108864,
  partCount: 12,
  uploadedParts: [{ partNumber: 1, size: 67108864 }],
  missingParts: [2, 3],
  parts: [
    { ...part, partNumber: 2 },
    { ...part, partNumber: 3 },
  ],
  expiresAt: at,
};
const owner = {
  id,
  title: 'Launch demo',
  visibility: 'unlisted',
  status: 'PROCESSING',
  failureCode: null,
  retryable: false,
  productId,
  durationSec: null,
  width: null,
  height: null,
  renditions: [],
  progress: { stage: 'transcode', tasksDone: 1, tasksTotal: 5 },
  posterUrl: null,
  spriteUrl: null,
  shareToken: 'tok_abcdefghijklmnopqrstuvwxyz',
  version: 3,
  createdAt: at,
  updatedAt: at,
};
const readyOwner = {
  ...owner,
  status: 'READY',
  visibility: 'public',
  shareToken: null,
  durationSec: 42.5,
  width: 1920,
  height: 1080,
  renditions: playback.renditions,
  progress: { stage: 'publish', tasksDone: 5, tasksTotal: 5 },
  posterUrl: playback.posterUrl,
  spriteUrl: playback.spriteUrl,
};

describe('S30 AS-31: video playback contract (W02 B-7)', () => {
  it('S30 AS-31: public and unlisted playback bodies parse; spriteUrl may be null or absent', () => {
    expect(ok(videoPlaybackSchema, playback)).toBe(true);
    expect(
      ok(videoPlaybackSchema, {
        ...playback,
        expiresAt: '2026-10-10T16:00:00.000Z',
      }),
    ).toBe(true);
    expect(ok(videoPlaybackSchema, { ...playback, spriteUrl: null })).toBe(
      true,
    );
    const { spriteUrl: _s, ...noSprite } = playback;
    expect(ok(videoPlaybackSchema, noSprite)).toBe(true);
  });

  it('S30 AS-31: playback rejects a non-URL master, a missing expiresAt and a negative duration', () => {
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

describe('S30 AS-01: start contract', () => {
  it('S30 AS-01: the start request accepts the contract example and an optional product', () => {
    expect(ok(videoStartRequestSchema, startRequest)).toBe(true);
    expect(
      ok(videoStartRequestSchema, {
        ...startRequest,
        contentType: 'video/webm',
        visibility: 'unlisted',
        productId,
      }),
    ).toBe(true);
    expect(
      videoStartRequestSchema.parse({ ...startRequest, title: '  Demo  ' })
        .title,
    ).toBe('Demo');
  });

  it('S30 AS-01: the start request rejects unknown fields and out-of-range values', () => {
    expect(ok(videoStartRequestSchema, { ...startRequest, key: 'x' })).toBe(
      false,
    );
    expect(
      ok(videoStartRequestSchema, { ...startRequest, uploadId: 'x' }),
    ).toBe(false);
    expect(ok(videoStartRequestSchema, { ...startRequest, title: '   ' })).toBe(
      false,
    );
    expect(
      ok(videoStartRequestSchema, { ...startRequest, title: 'a'.repeat(201) }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, { ...startRequest, sizeBytes: 1023 }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, { ...startRequest, sizeBytes: 21474836481 }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, { ...startRequest, sizeBytes: 2048.5 }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, {
        ...startRequest,
        contentType: 'video/avi',
      }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, { ...startRequest, visibility: 'private' }),
    ).toBe(false);
    expect(
      ok(videoStartRequestSchema, { ...startRequest, productId: 'p1' }),
    ).toBe(false);
  });

  it('S30 AS-01: the start response parses and carries no upload id, key or part URL list under another name', () => {
    expect(ok(videoStartResponseSchema, startResponse)).toBe(true);
    expect(
      ok(videoStartResponseSchema, {
        ...startResponse,
        visibility: 'unlisted',
        shareToken: 'tok_abcdefghijklmnopqrstuvwxyz',
      }),
    ).toBe(true);
    expect(
      ok(videoStartResponseSchema, { ...startResponse, partCount: undefined }),
    ).toBe(false);
    expect(
      ok(videoStartResponseSchema, {
        ...startResponse,
        parts: [{ partNumber: 1, url: part.url }],
      }),
    ).toBe(false);
    expect(
      Object.keys(
        videoStartResponseSchema.parse({ ...startResponse, key: 'k' }),
      ),
    ).not.toContain('key');
  });
});

describe('S30 AS-09: resume contract', () => {
  it('S30 AS-09: the upload state parses and requires UPLOADING', () => {
    expect(ok(videoUploadStateSchema, uploadState)).toBe(true);
    expect(
      ok(videoUploadStateSchema, { ...uploadState, status: 'READY' }),
    ).toBe(false);
    expect(
      ok(videoUploadStateSchema, { ...uploadState, missingParts: ['a'] }),
    ).toBe(false);
    expect(
      ok(videoUploadStateSchema, { ...uploadState, expiresAt: undefined }),
    ).toBe(false);
  });
});

describe('S30 AS-10: complete contract', () => {
  const body = {
    parts: [
      { partNumber: 1, etag: '"a1"' },
      { partNumber: 2, etag: '"b2"' },
    ],
  };

  it('S30 AS-10: the complete request accepts ascending parts', () => {
    expect(ok(videoCompleteRequestSchema, body)).toBe(true);
  });

  it('S30 AS-10: the complete request rejects empty, unordered, duplicate, malformed and unknown-field bodies', () => {
    expect(ok(videoCompleteRequestSchema, { parts: [] })).toBe(false);
    expect(
      ok(videoCompleteRequestSchema, {
        parts: [body.parts[1], body.parts[0]],
      }),
    ).toBe(false);
    expect(
      ok(videoCompleteRequestSchema, {
        parts: [body.parts[0], body.parts[0]],
      }),
    ).toBe(false);
    expect(
      ok(videoCompleteRequestSchema, { parts: [{ partNumber: 0, etag: 'a' }] }),
    ).toBe(false);
    expect(ok(videoCompleteRequestSchema, { parts: [{ partNumber: 1 }] })).toBe(
      false,
    );
    expect(ok(videoCompleteRequestSchema, { ...body, extra: 1 })).toBe(false);
  });

  it('S30 AS-10: the complete response carries a status, and failureCode on a FAILED replay', () => {
    expect(ok(videoCompleteResponseSchema, { status: 'PROCESSING' })).toBe(
      true,
    );
    expect(ok(videoCompleteResponseSchema, { status: 'READY' })).toBe(true);
    expect(
      ok(videoCompleteResponseSchema, {
        status: 'FAILED',
        failureCode: 'not_a_video',
      }),
    ).toBe(true);
    expect(ok(videoCompleteResponseSchema, { status: 'UPLOADING' })).toBe(
      false,
    );
    expect(ok(videoCompleteResponseSchema, {})).toBe(false);
  });
});

describe('S30 AS-42: owner view and list contract', () => {
  it('S30 AS-42: the owner view parses in progress and ready shapes', () => {
    expect(ok(videoOwnerSchema, owner)).toBe(true);
    expect(ok(videoOwnerSchema, readyOwner)).toBe(true);
    expect(
      ok(videoOwnerSchema, {
        ...owner,
        status: 'FAILED',
        failureCode: 'transcode_failed',
        retryable: true,
      }),
    ).toBe(true);
  });

  it('S30 AS-42: the owner view rejects an unknown status and a missing version', () => {
    expect(ok(videoOwnerSchema, { ...owner, status: 'PAUSED' })).toBe(false);
    expect(ok(videoOwnerSchema, { ...owner, version: undefined })).toBe(false);
    expect(ok(videoOwnerSchema, { ...owner, progress: { stage: 'x' } })).toBe(
      false,
    );
  });

  it('S30 AS-43: the list parses with and without a next cursor', () => {
    expect(
      ok(videoListSchema, { items: [owner, readyOwner], nextCursor: 'abc' }),
    ).toBe(true);
    expect(ok(videoListSchema, { items: [], nextCursor: null })).toBe(true);
    expect(ok(videoListSchema, { items: [] })).toBe(false);
  });
});

describe('S30 AS-44: patch contract', () => {
  it('S30 AS-44: the patch accepts a rename, a product link and an unlink', () => {
    expect(
      ok(videoPatchRequestSchema, { title: 'New', expectedVersion: 3 }),
    ).toBe(true);
    expect(ok(videoPatchRequestSchema, { productId, expectedVersion: 3 })).toBe(
      true,
    );
    expect(
      ok(videoPatchRequestSchema, { productId: null, expectedVersion: 3 }),
    ).toBe(true);
  });

  it('S30 AS-44: the patch rejects visibility, unknown fields, a missing version and a bad product', () => {
    expect(
      ok(videoPatchRequestSchema, { visibility: 'public', expectedVersion: 3 }),
    ).toBe(false);
    expect(
      ok(videoPatchRequestSchema, { title: 'x', foo: 1, expectedVersion: 3 }),
    ).toBe(false);
    expect(ok(videoPatchRequestSchema, { title: 'New' })).toBe(false);
    expect(
      ok(videoPatchRequestSchema, { productId: 'p1', expectedVersion: 3 }),
    ).toBe(false);
    expect(ok(videoPatchRequestSchema, { title: '', expectedVersion: 3 })).toBe(
      false,
    );
  });
});

describe('S30 AS-38: product video list contract', () => {
  it('S30 AS-38: the product list parses the contract example with the real item shape', () => {
    expect(
      ok(productVideosSchema, {
        items: [
          {
            videoId: id,
            title: 'Unboxing',
            posterUrl: playback.posterUrl,
            durationSec: 42.5,
          },
        ],
      }),
    ).toBe(true);
    expect(ok(productVideosSchema, { items: [] })).toBe(true);
    expect(ok(productVideosSchema, { items: [{ videoId: id }] })).toBe(false);
    expect(ok(productVideosSchema, {})).toBe(false);
  });
});

describe('S30 AS-56: event contract', () => {
  const ready = {
    videoId: id,
    videoVersion: 7,
    shopId,
    uploaderId: userId,
    productId: null,
    visibility: 'public',
    durationSec: 42.5,
    width: 1920,
    height: 1080,
    renditions: playback.renditions,
    hasSprite: true,
  };
  const failed = {
    videoId: id,
    videoVersion: 4,
    shopId,
    uploaderId: userId,
    failureCode: 'not_a_video',
  };
  const deleted = { videoId: id, videoVersion: 9, shopId, productId };

  it('S30 AS-56: the three schemas accept the contract payloads and nothing else is registered', () => {
    expect(Object.keys(videoEventSchemas).sort()).toEqual([
      'video.deleted',
      'video.failed',
      'video.ready',
    ]);
    expect(ok(videoEventSchemas['video.ready'], ready)).toBe(true);
    expect(ok(videoEventSchemas['video.failed'], failed)).toBe(true);
    expect(ok(videoEventSchemas['video.deleted'], deleted)).toBe(true);
  });

  it('S30 AS-56: payloads require videoVersion and refuse a missing id or an unknown failure code', () => {
    expect(
      ok(videoEventSchemas['video.ready'], {
        ...ready,
        videoVersion: undefined,
      }),
    ).toBe(false);
    expect(
      ok(videoEventSchemas['video.failed'], { ...failed, failureCode: 'boom' }),
    ).toBe(false);
    expect(
      ok(videoEventSchemas['video.deleted'], { ...deleted, videoId: 'v1' }),
    ).toBe(false);
  });

  it('S30 AS-56: payloads carry no URL, key, token or upload id', () => {
    for (const [name, example] of [
      ['video.ready', ready],
      ['video.failed', failed],
      ['video.deleted', deleted],
    ] as const) {
      const parsed = videoEventSchemas[name].parse({
        ...example,
        key: 'k',
        shareToken: 't',
        uploadId: 'u',
        masterUrl: 'https://x.test/m.m3u8',
      });
      const keys = Object.keys(parsed).join(' ').toLowerCase();
      expect(keys).not.toMatch(/url|key|token|uploadid/);
    }
  });

  it('S30 AS-56: defineEvent definitions mirror the contract schemas on topic media.events', () => {
    expect(Object.keys(videoEventDefinitions).sort()).toEqual(
      Object.keys(videoEventSchemas).sort(),
    );
    for (const def of [VideoReady, VideoFailed, VideoDeleted]) {
      expect(def.topic).toBe('media.events');
      expect(def.carries).toBe('state');
      expect(def.version).toBe(1);
      expect(def.schema).toBe(
        videoEventSchemas[def.type as keyof typeof videoEventSchemas],
      );
    }
    expect(VideoReady.type).toBe('video.ready');
    expect(VideoFailed.type).toBe('video.failed');
    expect(VideoDeleted.type).toBe('video.deleted');
  });
});

describe('S30 AS-48: problem code vocabulary', () => {
  it('S30 AS-48: the exported codes equal the table of contracts/video-api.md', () => {
    const doc = readFileSync(
      join(
        __dirname,
        '../../../../../specs/domains/S30-video/contracts/video-api.md',
      ),
      'utf8',
    );
    const section = doc.split('## Problem codes')[1] ?? '';
    const fromDoc = [...section.matchAll(/`([a-z][a-z_]+)`\s+\d{3}/g)].map(
      (m) => m[1],
    );
    expect(fromDoc.length).toBeGreaterThan(15);
    expect([...videoProblemCodes].sort()).toEqual([...fromDoc].sort());
  });
});
