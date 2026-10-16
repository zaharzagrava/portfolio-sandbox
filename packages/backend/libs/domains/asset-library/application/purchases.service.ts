import { Inject, Injectable } from '@nestjs/common';
import type {
  DownloadGrant,
  PurchasePage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import { entitlementNotFound, invalidCursor } from '../domain/errors';
import { LIMITS } from '../domain/limits';
import {
  ENTITLEMENTS,
  GRANTS,
  type EntitlementRepository,
  type GrantRepository,
} from '../domain/ports';
import { AssetLimits } from './asset-limits';
import { digestOf, newToken } from './tokens';
import { ShareService } from './share.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** "My purchases" and the buyer's download link (S31 FR-042, FR-043). */
@Injectable()
export class PurchasesService {
  constructor(
    @Inject(ENTITLEMENTS) private readonly entitlements: EntitlementRepository,
    @Inject(GRANTS) private readonly grants: GrantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly limits: AssetLimits,
    private readonly shares: ShareService,
  ) {}

  async list(
    buyerId: string,
    query: { limit: number; cursor?: string },
  ): Promise<PurchasePage> {
    let after: { at: Date; id: string } | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor('purchases', query.cursor) as {
        t?: unknown;
        i?: unknown;
      } | null;
      const at = typeof decoded?.t === 'string' ? new Date(decoded.t) : null;
      if (
        !decoded ||
        !at ||
        Number.isNaN(at.getTime()) ||
        typeof decoded.i !== 'string' ||
        !UUID.test(decoded.i)
      )
        throw invalidCursor();
      after = { at, id: decoded.i };
    }
    const rows = await this.entitlements.purchases({
      buyerId,
      limit: query.limit + 1,
      after,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        entitlementId: r.entitlementId,
        productId: r.productId,
        shopId: r.shopId,
        orderId: r.orderId,
        title: r.title,
        fileName: fileNameOf(r.path),
        sizeBytes: r.sizeBytes,
        grantedAt: r.grantedAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor('purchases', {
              t: last.grantedAt.toISOString(),
              i: last.entitlementId,
            })
          : null,
    };
  }

  /**
   * A link only this buyer was given, valid 10 minutes, pinned to the version of now. Not bought, revoked, someone
   * else's and unknown all answer the same `404` (FR-042). The counter and the grant commit together.
   */
  async download(buyerId: string, productId: string): Promise<DownloadGrant> {
    await this.limits.take('assets.grant.user', `user:${buyerId}`);
    if (!UUID.test(productId)) throw entitlementNotFound();
    const now = this.clock.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + LIMITS.buyerGrantSec * 1000);
    await this.transactions.run(async () => {
      const entitlement = await this.entitlements.findActive(
        buyerId,
        productId,
      );
      if (!entitlement || entitlement.assetStatus === 'PURGED')
        throw entitlementNotFound();
      if (!(await this.entitlements.recordDownload(entitlement.id, now)))
        throw entitlementNotFound();
      await this.grants.insert({
        tokenHash: digestOf(token),
        kind: 'purchase',
        shopId: entitlement.shopId,
        assetId: entitlement.assetId,
        version: entitlement.currentVersion,
        shareLinkId: null,
        entitlementId: entitlement.id,
        buyerId,
        expiresAt,
        createdAt: now,
      });
    });
    return {
      url: `${this.shares.origin()}/api/downloads/${token}`,
      expiresAt: expiresAt.toISOString(),
      expiresInSec: 600,
    };
  }
}
