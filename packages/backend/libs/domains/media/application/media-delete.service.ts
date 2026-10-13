import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ShopAccessService } from '@app/domains/tenancy';
import { mediaBusy, mediaInUse, mediaNotFound } from '../domain/media-errors';
import { MediaStore } from '../domain/ports';

/**
 * `DELETE /media/:id` (S29 FR-061): the uploader or, for a shop photo, a member with `products.write`, unless the photo
 * is in a gallery (`media_in_use`) or being processed (`media_busy`). Soft: the row becomes `DELETED` with its history
 * row and `media.deleted` in one transaction; the objects are reclaimed later by the purge job, never by the request.
 */
@Injectable()
export class MediaDeleteService {
  constructor(
    private readonly store: MediaStore,
    private readonly access: ShopAccessService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async delete(userId: string, mediaId: string): Promise<void> {
    const known = await this.store.media.findById(mediaId);
    if (!known) throw mediaNotFound();
    if (known.shopId) {
      // A viewer is told 403, a stranger the same 404 as for an unknown photo.
      try {
        await this.access.assertMember(known.shopId, userId, 'products.write');
      } catch (error) {
        if ((error as { code?: string }).code === 'shop_not_found')
          throw mediaNotFound();
        throw error;
      }
    } else if (known.uploaderId !== userId) {
      throw mediaNotFound();
    }

    await this.store.tx(async ({ media }) => {
      // Locking the row first makes a concurrent gallery write wait for us (it reads the photo FOR SHARE).
      const locked = await media.lockById(mediaId);
      if (!locked) throw mediaNotFound();
      if (locked.status === 'UPLOADED' || locked.status === 'PROCESSING')
        throw mediaBusy();
      const products = await media.productsUsing(mediaId, locked.shopId);
      if (products.length > 0) throw mediaInUse(products);
      const deleted = await media.markDeleted({
        id: mediaId,
        from: ['PENDING_UPLOAD', 'READY', 'REJECTED', 'EXPIRED'],
        actor: { type: 'user', id: userId },
        now: this.clock.now(),
      });
      if (!deleted) throw mediaBusy();
    });
  }
}
