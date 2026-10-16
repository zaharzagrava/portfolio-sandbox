import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import type {
  shareLinkCreateRequestSchema,
  shareLinkListSchema,
  shareLinkPreviewSchema,
  shareLinkSchema,
  shareRedeemSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  assetNotFound,
  invalidTransition,
  linkUnavailable,
  shareLinkNotFound,
} from '../domain/errors';
import { LIMITS } from '../domain/limits';
import {
  ASSETS,
  GRANTS,
  SHARES,
  VERSIONS,
  type AssetRepository,
  type GrantRepository,
  type ShareLinkRecord,
  type ShareRepository,
  type ShareTarget,
  type VersionRepository,
} from '../domain/ports';
import { AssetLimits } from './asset-limits';
import { assetMetrics } from './asset-metrics';
import { digestOf, looksLikeToken, newToken } from './tokens';

type Created = z.infer<typeof shareLinkSchema>;
type Listed = z.infer<typeof shareLinkListSchema>;
type Preview = z.infer<typeof shareLinkPreviewSchema>;
type Redeemed = z.infer<typeof shareRedeemSchema>;

const fileNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function shareStatus(
  link: Pick<
    ShareLinkRecord,
    'revokedAt' | 'expiresAt' | 'maxDownloads' | 'downloads'
  >,
  now: Date,
): 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED' | 'REVOKED' {
  if (link.revokedAt) return 'REVOKED';
  if (link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (link.maxDownloads !== null && link.downloads >= link.maxDownloads)
    return 'EXHAUSTED';
  return 'ACTIVE';
}

/**
 * Share links (S31 FR-032…FR-036): the owner creates, lists and revokes; the world previews (no state change) and redeems
 * (one conditional update, so the cap holds under a crowd) and then fetches bytes with a short grant. Every reason a link
 * is unavailable answers the same `410 link_unavailable`.
 */
@Injectable()
export class ShareService {
  constructor(
    @Inject(ASSETS) private readonly assets: AssetRepository,
    @Inject(VERSIONS) private readonly versions: VersionRepository,
    @Inject(SHARES) private readonly shares: ShareRepository,
    @Inject(GRANTS) private readonly grants: GrantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
    private readonly transactions: TransactionRunner,
    private readonly limits: AssetLimits,
  ) {}

  /** The user-content origin: a separate origin so a hostile file can never run as part of the platform's site (FR-033). */
  origin(): string {
    return (
      this.config.get('usercontent_origin') || this.config.get('backend_host')
    ).replace(/\/+$/, '');
  }

  async create(
    shopId: string,
    userId: string,
    assetId: string,
    request: z.infer<typeof shareLinkCreateRequestSchema>,
  ): Promise<Created> {
    const asset = await this.assets.find(shopId, assetId);
    if (!asset || asset.status !== 'ACTIVE') throw assetNotFound();
    const now = this.clock.now();
    const token = newToken();
    const id = uuidv7();
    const expiresAt = new Date(
      now.getTime() + request.expiresInHours * 3_600_000,
    );
    await this.shares.insert({
      id,
      shopId,
      assetId,
      tokenHash: digestOf(token),
      createdBy: userId,
      expiresAt,
      maxDownloads: request.maxDownloads ?? null,
      now,
    });
    return {
      id,
      token,
      url: `${this.origin()}/assets/shared/${token}`,
      expiresAt: expiresAt.toISOString(),
      maxDownloads: request.maxDownloads ?? null,
      createdAt: now.toISOString(),
    };
  }

  async list(shopId: string, assetId: string): Promise<Listed> {
    const asset = await this.assets.find(shopId, assetId);
    if (!asset || asset.status !== 'ACTIVE') throw assetNotFound();
    const now = this.clock.now();
    const links = await this.shares.listOfAsset(shopId, assetId);
    return {
      items: links.map((l) => ({
        id: l.id,
        expiresAt: l.expiresAt.toISOString(),
        maxDownloads: l.maxDownloads,
        downloads: l.downloads,
        status: shareStatus(l, now),
        createdBy: l.createdBy,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  async revoke(shopId: string, assetId: string, linkId: string): Promise<void> {
    const asset = await this.assets.find(shopId, assetId);
    if (!asset || asset.status === 'PURGED') throw assetNotFound();
    const link = await this.shares.findOfAsset(shopId, assetId, linkId);
    if (!link) throw shareLinkNotFound();
    if (!(await this.shares.revoke(linkId, this.clock.now())))
      throw invalidTransition();
  }

  /** Stateless: never changes a counter (FR-034), so a link scanner cannot burn a capped link. */
  async preview(token: string, address: string): Promise<Preview> {
    await this.limited(address);
    const now = this.clock.now();
    const target = looksLikeToken(token)
      ? await this.shares.findByTokenHash(digestOf(token))
      : null;
    if (!target || !this.available(target, now)) throw linkUnavailable();
    const current = await this.versions.find(
      target.assetId,
      target.currentVersion,
    );
    return {
      fileName: fileNameOf(target.path),
      sizeBytes: current?.sizeBytes ?? 0,
      expiresAt: target.expiresAt.toISOString(),
      remainingDownloads:
        target.maxDownloads === null
          ? null
          : Math.max(target.maxDownloads - target.downloads, 0),
    };
  }

  async redeem(token: string, address: string): Promise<Redeemed> {
    await this.limited(address, true);
    const now = this.clock.now();
    const tokenHash = looksLikeToken(token) ? digestOf(token) : null;
    const result = tokenHash
      ? await this.transactions.run(async () => {
          const hit = await this.shares.redeem(tokenHash, now);
          if (!hit) return null;
          const grantToken = newToken();
          const expiresAt = new Date(
            now.getTime() + LIMITS.shareGrantSec * 1000,
          );
          await this.grants.insert({
            tokenHash: digestOf(grantToken),
            kind: 'share',
            shopId: hit.shopId,
            assetId: hit.assetId,
            version: hit.currentVersion,
            shareLinkId: hit.id,
            entitlementId: null,
            buyerId: null,
            expiresAt,
            createdAt: now,
          });
          const version = await this.versions.find(
            hit.assetId,
            hit.currentVersion,
          );
          return {
            hit,
            grantToken,
            expiresAt,
            sizeBytes: version?.sizeBytes ?? 0,
          };
        })
      : null;
    if (!result) {
      assetMetrics.shareRedeems.add(1, { outcome: 'unavailable' });
      throw linkUnavailable();
    }
    assetMetrics.shareRedeems.add(1, { outcome: 'ok' });
    return {
      url: `${this.origin()}/api/downloads/${result.grantToken}`,
      expiresAt: result.expiresAt.toISOString(),
      fileName: fileNameOf(result.hit.path),
      sizeBytes: result.sizeBytes,
    };
  }

  private available(target: ShareTarget, now: Date): boolean {
    return (
      target.assetStatus === 'ACTIVE' && shareStatus(target, now) === 'ACTIVE'
    );
  }

  private async limited(address: string, count = false): Promise<void> {
    try {
      await this.limits.take('assets.redeem.ip', `ip:${address}`);
    } catch (error) {
      if (count) assetMetrics.shareRedeems.add(1, { outcome: 'limited' });
      throw error;
    }
  }
}
