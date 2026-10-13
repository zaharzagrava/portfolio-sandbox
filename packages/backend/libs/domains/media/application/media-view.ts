import type { MediaOwner, MediaPublic } from '@marketplace-sandbox/contracts';
import { toUrls } from '../domain/media-urls';
import type { MediaRecord } from '../domain/ports';

/** What other capabilities get from `getReadyMediaByIds` (R1): a DTO, never a model (AS-45). */
export interface MediaDto {
  id: string;
  shopId: string | null;
  purpose: 'product' | 'review';
  width: number;
  height: number;
  urls: { thumb: string; feed: string; full: string };
  createdAt: Date;
}

/** Only `READY` rows have variants and sizes; callers filter before mapping. */
export const toPublicView = (
  media: MediaRecord,
  origin: string,
): MediaPublic => ({
  id: media.id,
  status: 'READY',
  purpose: media.purpose,
  shopId: media.shopId,
  width: media.width!,
  height: media.height!,
  urls: toUrls(media.variants!, origin),
});

/** The uploader's (and a shop member's) view of any non-deleted status. Never carries a key, a hash or a match. */
export const toOwnerView = (
  media: MediaRecord,
  origin: string,
): MediaOwner => ({
  id: media.id,
  status: media.status as MediaOwner['status'],
  purpose: media.purpose,
  shopId: media.shopId,
  width: media.status === 'READY' ? media.width : null,
  height: media.status === 'READY' ? media.height : null,
  urls:
    media.status === 'READY' && media.variants
      ? toUrls(media.variants, origin)
      : null,
  ...(media.status === 'REJECTED' && media.rejectCode
    ? { rejectCode: media.rejectCode }
    : {}),
  createdAt: media.createdAt.toISOString(),
  updatedAt: media.updatedAt.toISOString(),
});

export const toMediaDto = (media: MediaRecord, origin: string): MediaDto => ({
  id: media.id,
  shopId: media.shopId,
  purpose: media.purpose,
  width: media.width!,
  height: media.height!,
  urls: toUrls(media.variants!, origin),
  createdAt: media.createdAt,
});
