import * as media from './index';
import { ownerOf } from '../../../db/ownership';

describe('S29 AS-59: what the media domain exports and owns', () => {
  it('S29 AS-59: the entry point exports the Provides list and nothing else (no model, repository, Sql, queue constant)', () => {
    expect(Object.keys(media).sort()).toEqual(
      [
        'MediaDeleted',
        'MediaDuplicateSuspected',
        'MediaGalleryChanged',
        'MediaModule',
        'MediaProjectorModule',
        'MediaQueryService',
        'MediaReady',
        'MediaRejected',
        'MediaWorkerModule',
        'TransientProcessingError',
        'VideoDeleted',
        'VideoFailed',
        'VideoModule',
        'VideoProjectorModule',
        'VideoReady',
        'VideoWorkerModule',
        'videoEventSchemas',
        'createMediaProcessor',
        'createTx',
        'isOriginalKey',
        'mediaEventSchemas',
      ].sort(),
    );
    for (const forbidden of [
      'MediaProcessor',
      'Sql',
      'MEDIA_QUEUE',
      'MediaService',
      'VideoService',
      'VIDEO_QUEUE',
    ])
      expect(media).not.toHaveProperty(forbidden);
  });

  it('S30 AS-59: the four video tables belong to the media domain in the ownership registry', () => {
    for (const table of [
      'Video',
      'VideoTask',
      'VideoStatusHistory',
      'VideoShopState',
    ])
      expect(ownerOf(table)).toBe('domain:media');
  });

  it('S29 AS-59: the four photo tables belong to the media domain in the ownership registry', () => {
    for (const table of [
      'Media',
      'MediaStatusHistory',
      'ProductMedia',
      'ProductGallery',
    ])
      expect(ownerOf(table)).toBe('domain:media');
  });
});
