import { Injectable, Logger } from '@nestjs/common';
import { ApiError, serviceUnavailable } from '../domain/errors';
import { ShopDirectory, ShopFacts, ShopStatusCache } from '../domain/ports';

export const SHOP_STATUS_TTL_SEC = 60;

/**
 * Refuses the calls of a key whose shop is not open (FR-017): `403 shop_suspended`, `409 shop_offboarding`, for reads and
 * writes. The status comes from a 60 s entry; `tenancy.shop_status_changed` drops the entry at once. A shop that cannot be
 * found is treated as deleted; when neither the entry nor the tenancy service answers the call is `503`, never open.
 */
@Injectable()
export class ShopStatusGate {
  private readonly logger = new Logger(ShopStatusGate.name);

  constructor(
    private readonly cache: ShopStatusCache,
    private readonly directory: ShopDirectory,
  ) {}

  async assertOpen(shopId: string): Promise<void> {
    const status = await this.statusOf(shopId);
    if (status === 'ACTIVE') return;
    if (status === 'SUSPENDED')
      throw new ApiError('shop_suspended', 'This shop is suspended.');
    if (status === 'DELETING')
      throw new ApiError('shop_offboarding', 'This shop is being closed.');
    throw new ApiError('invalid_api_key', 'The API key is not valid.', {
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }

  invalidate(shopId: string): Promise<void> {
    return this.cache.invalidate(shopId);
  }

  private async statusOf(shopId: string): Promise<ShopFacts['status']> {
    try {
      const cached = await this.cache.get(shopId);
      if (cached) return cached;
    } catch (error) {
      this.logger.warn(
        `shop status cache unavailable: ${(error as Error).message}`,
      );
    }
    let shop: ShopFacts | undefined;
    try {
      shop = (await this.directory.getShops([shopId])).get(shopId);
    } catch (error) {
      this.logger.error(`shop status unavailable: ${(error as Error).message}`);
      throw serviceUnavailable();
    }
    const status = shop?.status ?? 'DELETED';
    await this.cache
      .put(shopId, status, SHOP_STATUS_TTL_SEC)
      .catch(() => undefined);
    return status;
  }
}
