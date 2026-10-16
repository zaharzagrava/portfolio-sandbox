import { Inject, Injectable } from '@nestjs/common';
import {
  SHOP_COPY_REPOSITORY,
  SHOP_LOOKUP,
  type ShopCopy,
  type ShopCopyRepository,
  type ShopLookup,
} from '../domain/ports';
import { storyNotFound } from '../domain/errors';

/**
 * The shop's slug and status on the write path (S27 FR-062): the copy when it exists, otherwise one lookup through
 * S03's exported batch query (R1). The lookup is used for this call only; the copy is written by its consumer.
 */
@Injectable()
export class ShopIdentity {
  constructor(
    @Inject(SHOP_COPY_REPOSITORY) private readonly copies: ShopCopyRepository,
    @Inject(SHOP_LOOKUP) private readonly lookup: ShopLookup,
  ) {}

  async resolve(shopId: string): Promise<ShopCopy & { slug: string }> {
    const copy = await this.copies.find(shopId);
    const known = copy?.slug ? copy : await this.lookup.get(shopId);
    if (!known?.slug) throw storyNotFound();
    return known as ShopCopy & { slug: string };
  }
}
