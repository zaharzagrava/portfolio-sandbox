import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiKeyRepository, KeyCache } from '../domain/ports';

/**
 * What the capability does when a shop's lifecycle changes (FR-013): a deleted shop's keys are revoked once (the
 * conditional revoke is idempotent, so a second delivery changes nothing and emits nothing), and every instance stops
 * trusting a cached verification at once.
 */
@Injectable()
export class ShopLifecycleHandler {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly cache: KeyCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async shopDeleted(shopId: string): Promise<number> {
    const revoked = await this.keys.revokeAllForShop(
      shopId,
      this.clock.now(),
      'shop_deleted',
    );
    for (const key of revoked) await this.cache.tombstone(key.prefix);
    return revoked.length;
  }
}
