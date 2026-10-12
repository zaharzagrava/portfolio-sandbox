import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ShopListingService } from '../application/shop-listing.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'products.drop-shop-entries': { shopId: string; shopVersion: number };
    'products.purge-shop': { shopId: string };
  }
}

declareJobType({
  name: 'products.drop-shop-entries',
  contract: z
    .object({
      shopId: z.string().uuid(),
      shopVersion: z.number().int(),
    })
    .strict(),
});
declareJobType({
  name: 'products.purge-shop',
  contract: z.object({ shopId: z.string().uuid() }).strict(),
});

/** Shop-driven sweeps of the catalog (runs in apps/worker). Both are safe to run again after any interruption. */
@Injectable()
export class ShopLifecycleJobs {
  constructor(private readonly listing: ShopListingService) {}

  @JobHandler('products.drop-shop-entries', { concurrency: 2 })
  async dropEntries(payload: {
    shopId: string;
    shopVersion: number;
  }): Promise<{ visited: number }> {
    return { visited: await this.listing.dropEntries(payload.shopId) };
  }

  @JobHandler('products.purge-shop', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 120_000,
  })
  async purgeShop(payload: { shopId: string }): Promise<{ deleted: number }> {
    return { deleted: await this.listing.purgeShop(payload.shopId) };
  }
}
