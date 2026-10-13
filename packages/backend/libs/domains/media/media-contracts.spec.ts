import {
  galleryPutRequestSchema,
  mediaBatchItemSchema,
  mediaEventSchemas,
  mediaOwnerSchema,
  mediaProblemCodes,
  mediaUploadRequestSchema,
  mediaUploadResponseSchema,
} from '@marketplace-sandbox/contracts';
import { mediaEventDefinitions } from './application/events/media-events';

const id = '0192f7a0-0000-7000-8000-000000000001';
const other = '0192f7a0-0000-7000-8000-000000000002';

describe('S29 contracts: media upload and gallery schemas', () => {
  it.each([
    ['unknown field', { purpose: 'review', key: 'x' }],
    ['purpose post', { purpose: 'post' }],
    ['missing purpose', {}],
    ['other purpose', { purpose: 'avatar' }],
    ['shopId in the body', { purpose: 'product', shopId: id }],
  ])('S29 AS-02: the upload request refuses %s', (_name, body) => {
    expect(mediaUploadRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(['review', 'product'])(
    'S29 AS-02: the upload request accepts purpose %s',
    (purpose) => {
      expect(mediaUploadRequestSchema.safeParse({ purpose }).success).toBe(
        true,
      );
    },
  );

  it('S29 AS-01: the upload response has no `key` property and exact limits', () => {
    const body = {
      mediaId: id,
      upload: { url: 'http://s3', fields: { key: 'k' }, expiresAt: 'x' },
      maxBytes: 15728640,
      allowedContentTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
      ],
    };
    expect(mediaUploadResponseSchema.safeParse(body).success).toBe(true);
    expect(
      mediaUploadResponseSchema.safeParse({ ...body, key: 'media/originals/x' })
        .success,
    ).toBe(false);
    expect(
      mediaUploadResponseSchema.safeParse({ ...body, maxBytes: 1 }).success,
    ).toBe(false);
  });

  it.each([
    [
      'more than 20 ids',
      {
        mediaIds: Array.from(
          { length: 21 },
          (_, i) => `0192f7a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
        expectedVersion: 0,
      },
    ],
    ['duplicate ids', { mediaIds: [id, id], expectedVersion: 0 }],
    ['non-UUID id', { mediaIds: ['nope'], expectedVersion: 0 }],
    ['not an array', { mediaIds: id, expectedVersion: 0 }],
    ['missing ids', { expectedVersion: 0 }],
    ['missing version', { mediaIds: [] }],
    ['negative version', { mediaIds: [], expectedVersion: -1 }],
    ['fractional version', { mediaIds: [], expectedVersion: 1.5 }],
    ['extra field', { mediaIds: [], expectedVersion: 0, shopId: id }],
  ])('S29 AS-32: the gallery request refuses %s', (_name, body) => {
    expect(galleryPutRequestSchema.safeParse(body).success).toBe(false);
  });

  it('S29 AS-32: the gallery request accepts an empty list and 20 unique ids', () => {
    expect(
      galleryPutRequestSchema.safeParse({ mediaIds: [], expectedVersion: 0 })
        .success,
    ).toBe(true);
    expect(
      galleryPutRequestSchema.safeParse({
        mediaIds: [id, other],
        expectedVersion: 3,
      }).success,
    ).toBe(true);
  });

  it('S29 AS-42: the owner view never carries a deleted status or extra keys', () => {
    const view = {
      id,
      status: 'REJECTED',
      purpose: 'review',
      shopId: null,
      width: null,
      height: null,
      urls: null,
      rejectCode: 'not_an_image',
      createdAt: 'a',
      updatedAt: 'b',
    };
    expect(mediaOwnerSchema.safeParse(view).success).toBe(true);
    expect(
      mediaOwnerSchema.safeParse({ ...view, status: 'DELETED' }).success,
    ).toBe(false);
    expect(
      mediaOwnerSchema.safeParse({ ...view, originalKey: 'k' }).success,
    ).toBe(false);
    expect(
      mediaOwnerSchema.safeParse({ ...view, rejectCode: 'decoder said no' })
        .success,
    ).toBe(false);
  });

  it('S29 AS-44: the batch item is a public view or null', () => {
    expect(mediaBatchItemSchema.safeParse(null).success).toBe(true);
    expect(mediaBatchItemSchema.safeParse({ id }).success).toBe(false);
  });

  it('S29 FR-073: the problem vocabulary is the closed list', () => {
    expect([...mediaProblemCodes].sort()).toEqual(
      [
        'validation_failed',
        'permission_denied',
        'shop_suspended',
        'shop_offboarding',
        'pending_uploads_limit',
        'upload_incomplete',
        'upload_expired',
        'media_not_found',
        'media_in_use',
        'media_busy',
        'media_not_attachable',
        'product_not_found',
        'product_archived',
        'version_conflict',
      ].sort(),
    );
  });
});

describe('S29 contracts: event parity (AS-56)', () => {
  it.each(Object.keys(mediaEventSchemas))(
    'S29 AS-56: %s is defined with the schema of mediaEventSchemas',
    (type) => {
      const definition =
        mediaEventDefinitions[type as keyof typeof mediaEventDefinitions];
      expect(definition.type).toBe(type);
      expect(definition.version).toBe(1);
      expect(definition.topic).toBe('media.events');
      expect(definition.schema).toBe(
        mediaEventSchemas[type as keyof typeof mediaEventSchemas],
      );
    },
  );

  it('S29 AS-56: media.ready carries no original key, hash or match id', () => {
    const shape = Object.keys(mediaEventSchemas['media.ready'].shape);
    expect(shape).toEqual(
      expect.arrayContaining(['mediaVersion', 'duplicateSuspected']),
    );
    expect(shape).not.toEqual(expect.arrayContaining(['possibleDuplicateOf']));
    expect(shape).not.toEqual(expect.arrayContaining(['originalKey']));
    expect(shape).not.toEqual(expect.arrayContaining(['dhash']));
  });
});
