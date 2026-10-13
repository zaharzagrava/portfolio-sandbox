import { Inject, Injectable } from '@nestjs/common';
import type { MediaOwner, MediaPublic } from '@marketplace-sandbox/contracts';
import { ShopAccessService } from '@app/domains/tenancy';
import { mediaNotFound } from '../domain/media-errors';
import { MediaStore } from '../domain/ports';
import { MEDIA_ORIGIN } from '../media.constants';
import { toOwnerView, toPublicView } from './media-view';

export type MediaView =
  { kind: 'public'; body: MediaPublic } | { kind: 'owner'; body: MediaOwner };

/**
 * `GET /media/:id` and the batch read (S29 FR-050–FR-054). A `READY` photo is public; any other status is visible only
 * to its uploader and, for shop photos, to members with `products.read`. Everybody else gets the one `404`.
 */
@Injectable()
export class MediaReadService {
  constructor(
    private readonly store: MediaStore,
    private readonly access: ShopAccessService,
    @Inject(MEDIA_ORIGIN) private readonly origin: string,
  ) {}

  async get(mediaId: string, userId: string | null): Promise<MediaView> {
    const [ready] = await this.store.media.findReadyByIds([mediaId]);
    if (ready)
      return { kind: 'public', body: toPublicView(ready, this.origin) };
    if (!userId) throw mediaNotFound();

    // Uploader path: the principal is inside the predicate.
    const own = await this.store.media.findForUploader(mediaId, userId);
    if (own) return { kind: 'owner', body: toOwnerView(own, this.origin) };

    // Member path: prove membership of the photo's shop, then read it by that shop.
    const known = await this.store.media.findById(mediaId);
    if (!known?.shopId) throw mediaNotFound();
    try {
      await this.access.assertMember(known.shopId, userId, 'products.read');
    } catch {
      throw mediaNotFound();
    }
    const viaShop = await this.store.media.findForShop(mediaId, known.shopId);
    if (!viaShop) throw mediaNotFound();
    return { kind: 'owner', body: toOwnerView(viaShop, this.origin) };
  }

  /** One statement for the whole call; the answer is parallel to the request, `null` for anything not `READY`. */
  async batch(ids: string[]): Promise<(MediaPublic | null)[]> {
    const unique = [...new Set(ids)];
    const found = new Map(
      (await this.store.media.findReadyByIds(unique)).map((m) => [m.id, m]),
    );
    return ids.map((id) => {
      const media = found.get(id);
      return media ? toPublicView(media, this.origin) : null;
    });
  }
}
