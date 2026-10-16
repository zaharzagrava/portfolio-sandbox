import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import type { AssetConfig } from '../domain/asset-config';
import { assetTransition } from '../domain/asset-status';
import { occurrencesOf } from '../domain/chunk-plan';
import {
  ASSETS,
  CHUNKS,
  ChunkStore,
  DIGITAL,
  GRANTS,
  JOURNAL,
  USAGE,
  VERSIONS,
  type AssetRecord,
  type AssetRepository,
  type ChunkRecord,
  type ChunkRepository,
  type DigitalRepository,
  type GrantRepository,
  type JournalRepository,
  type UsageRepository,
  type VersionRepository,
} from '../domain/ports';
import { ASSET_CONFIG } from './asset-config.token';
import { assetMetrics } from './asset-metrics';

const BATCH = 200;

/** The bytes a chunk row counts against the quota: reserved while it is a placeholder, stored once confirmed. */
export function countedBytes(
  row: Pick<ChunkRecord, 'reserved' | 'storedAt' | 'size'>,
) {
  if (row.reserved) return { storedBytes: 0, reservedBytes: row.size };
  if (row.storedAt !== null) return { storedBytes: row.size, reservedBytes: 0 };
  return { storedBytes: 0, reservedBytes: 0 };
}

/**
 * Cleanup of chunks nobody references (S31 FR-031, research D2). A run claims candidates in a short transaction
 * (`deleting = true`, rows other runs hold are skipped), then deletes the object outside any transaction, then the row.
 * A failed object delete releases the claim, keeps the row and is counted; the next run retries. Commit and prepare
 * lock the same rows and treat a claimed chunk as not uploaded, so no committed version can point at a missing object.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    @Inject(ASSETS) private readonly assets: AssetRepository,
    @Inject(VERSIONS) private readonly versions: VersionRepository,
    @Inject(CHUNKS) private readonly chunks: ChunkRepository,
    @Inject(DIGITAL) private readonly digital: DigitalRepository,
    @Inject(GRANTS) private readonly grants: GrantRepository,
    @Inject(JOURNAL) private readonly journal: JournalRepository,
    @Inject(USAGE) private readonly usage: UsageRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ASSET_CONFIG) private readonly config: AssetConfig,
    private readonly transactions: TransactionRunner,
    private readonly store: ChunkStore,
  ) {}

  /** Removes chunks unreferenced for more than the grace period; returns what this run did. */
  async collectChunks(): Promise<{ deleted: number; failed: number }> {
    const result = { deleted: 0, failed: 0 };
    for (;;) {
      const now = this.clock.now();
      const claimed = await this.transactions.run(() =>
        this.chunks.claimForCleanup({
          unreferencedBefore: new Date(
            now.getTime() - this.config.gcGraceHours * 3_600_000,
          ),
          protectedBefore: now,
          limit: BATCH,
        }),
      );
      for (const row of claimed) await this.remove(row, result);
      if (claimed.length < BATCH) return result;
    }
  }

  /**
   * Purges deleted assets whose undelete window passed (FR-029): their versions go, each version's chunk references are
   * released exactly once, their share links go, and the asset becomes `PURGED`. Claimed with `SKIP LOCKED` and
   * released in the same transaction, so two runs at once never release twice.
   */
  async purgeDeletedAssets(): Promise<number> {
    let purged = 0;
    for (;;) {
      const now = this.clock.now();
      const cutoff = new Date(
        now.getTime() - this.config.undeleteDays * 86_400_000,
      );
      const done = await this.transactions.run(async () => {
        const due = await this.assets.lockDeletedBefore(cutoff, 20);
        for (const asset of due) await this.purgeOne(asset, now);
        return due.length;
      });
      purged += done;
      if (done === 0) return purged;
    }
  }

  /** The asset is locked by the caller; chunks are locked by hash after it (the commit path's order). */
  async purgeOne(asset: AssetRecord, now: Date): Promise<void> {
    const move = assetTransition(asset.status, 'purge');
    if (move.kind === 'refused') return;
    const removed = await this.versions.removeAll(asset.id);
    const totals = new Map<string, number>();
    for (const version of removed)
      for (const { hash, occurrences } of occurrencesOf(version.chunks))
        totals.set(hash, (totals.get(hash) ?? 0) + occurrences);
    const hashes = [...totals.keys()].sort();
    if (hashes.length > 0) {
      await this.chunks.lockMany(asset.shopId, hashes);
      await this.chunks.adjust({
        shopId: asset.shopId,
        deltas: hashes.map((hash) => ({ hash, delta: -totals.get(hash)! })),
        now,
        protectedUntil: now,
      });
    }
    await this.assets.removeShareArtifacts(asset.id);
    await this.assets.transition({
      shopId: asset.shopId,
      assetId: asset.id,
      from: asset.status,
      to: move.to,
      deletedAt: asset.deletedAt,
      now,
    });
  }

  /**
   * `tenancy.shop_deleted` (FR-044, AS-71): the whole library of the shop goes. Rows first, in one transaction (links,
   * assets, versions, share links, grants, journal); then every chunk is claimed and its object deleted, outside any
   * transaction. A chunk whose object cannot be deleted stays claimable by the regular cleanup, and the failure is
   * raised so the event is redelivered. Running it again changes nothing.
   */
  async purgeShop(shopId: string): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      await this.digital.removeOfShop(shopId);
      for (;;) {
        const batch = await this.assets.lockUnpurgedOfShop(shopId, 50);
        if (batch.length === 0) break;
        for (const asset of batch) {
          await this.versions.removeAll(asset.id);
          await this.assets.transition({
            shopId,
            assetId: asset.id,
            from: asset.status,
            to: 'PURGED',
            deletedAt: asset.deletedAt,
            now,
          });
        }
      }
      await this.assets.removeAllOfShop(shopId);
      await this.journal.removeShop(shopId);
    });
    const result = { deleted: 0, failed: 0 };
    for (;;) {
      const claimed = await this.transactions.run(() =>
        this.chunks.claimAllOfShop(shopId, BATCH),
      );
      if (claimed.length === 0) break;
      for (const row of claimed) await this.remove(row, result);
      if (result.failed > 0) break;
    }
    if (result.failed > 0)
      throw new Error(
        'some chunk objects of the deleted shop were not removed',
      );
    await this.transactions.run(() => this.usage.remove(shopId));
  }

  /** Expired download grants go (`assets.purge-download-grants`); an expired URL answers the same `410` with or without its row. */
  async purgeDownloadGrants(): Promise<number> {
    return this.transactions.run(() =>
      this.grants.purgeExpired(this.clock.now()),
    );
  }

  /** Journal entries older than the retention go and the floor is recorded (`assets.purge-changes`, FR-021). */
  async purgeChanges(): Promise<number> {
    const cutoff = new Date(
      this.clock.now().getTime() - this.config.journalDays * 86_400_000,
    );
    return this.transactions.run(() => this.journal.purgeOlderThan(cutoff));
  }

  /** The storage gauge per shop size tier (bounded labels). */
  async reportStorage(): Promise<void> {
    for (const tier of ['small', 'medium', 'large'] as const)
      for (const state of ['stored', 'reserved'] as const)
        assetMetrics.storageBytes.set(0, { tier, state });
    for (const row of await this.usage.tiers()) {
      assetMetrics.storageBytes.set(row.storedBytes, {
        tier: row.tier,
        state: 'stored',
      });
      assetMetrics.storageBytes.set(row.reservedBytes, {
        tier: row.tier,
        state: 'reserved',
      });
    }
  }

  /** Deletes the object, then the row; a failure keeps the row for the next run. */
  async remove(
    row: ChunkRecord & { shopId: string },
    result: { deleted: number; failed: number },
  ): Promise<void> {
    try {
      await this.store.remove(row.shopId, row.hash);
    } catch (error) {
      assetMetrics.gcFailures.add(1);
      assetMetrics.storageFailures.add(1, { operation: 'delete' });
      this.logger.warn(`chunk delete failed: ${(error as Error).message}`);
      await this.transactions.run(() =>
        this.chunks.releaseClaim(row.shopId, row.hash),
      );
      result.failed += 1;
      return;
    }
    await this.transactions.run(async () => {
      const gone = await this.chunks.deleteClaimed(row.shopId, row.hash);
      if (!gone) return;
      const counted = countedBytes(gone);
      await this.usage.adjust(row.shopId, {
        storedBytes: -counted.storedBytes,
        reservedBytes: -counted.reservedBytes,
      });
    });
    assetMetrics.gcDeleted.add(1);
    result.deleted += 1;
  }
}
