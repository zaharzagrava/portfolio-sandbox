import { Inject, Injectable } from '@nestjs/common';
import type { MediaPurpose } from '@marketplace-sandbox/contracts';
import { MediaStore } from '../domain/ports';
import { MEDIA_ORIGIN } from '../media.constants';
import { MediaDto, toMediaDto } from './media-view';

export const MEDIA_QUERY_MAX_IDS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R1 of media (S29 AS-45): finished photos by id for other capabilities. One statement; the optional predicates are
 * part of the `WHERE`, not checked afterwards, so a consumer can prove ownership (`{uploaderId, purpose: 'review'}`).
 * Unknown, unfinished, deleted and non-matching ids are absent; duplicates collapse; more than 500 ids is refused.
 */
@Injectable()
export class MediaQueryService {
  constructor(
    private readonly store: MediaStore,
    @Inject(MEDIA_ORIGIN) private readonly origin: string,
  ) {}

  async getReadyMediaByIds(
    ids: string[],
    options: {
      uploaderId?: string;
      shopId?: string;
      purpose?: MediaPurpose;
    } = {},
  ): Promise<Map<string, MediaDto>> {
    if (ids.length > MEDIA_QUERY_MAX_IDS)
      throw new RangeError(
        `getReadyMediaByIds takes at most ${MEDIA_QUERY_MAX_IDS} ids`,
      );
    const unique = [
      ...new Set(
        ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()),
      ),
    ];
    if (unique.length === 0) return new Map();
    const found = await this.store.media.findReadyByIds(unique, options);
    return new Map(found.map((m) => [m.id, toMediaDto(m, this.origin)]));
  }
}
