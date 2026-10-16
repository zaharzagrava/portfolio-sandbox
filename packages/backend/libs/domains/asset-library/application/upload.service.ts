import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  AssetCommitRequest,
  AssetCommitResponse,
  AssetPrepareRequest,
  AssetPrepareResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { validateAssetPath } from '../domain/asset-path';
import { occurrencesOf } from '../domain/chunk-plan';
import {
  conflictedCopyBase,
  conflictedCopyPath,
} from '../domain/conflict-name';
import {
  assetDeleted,
  assetNotFound,
  chunkNotUploaded,
  chunkSizeMismatch,
  chunksUnknown,
  invalidBaseVersion,
  quotaExceeded,
  sizeMismatch,
  validationFailed,
  versionLimitReached,
  versionNotFound,
  AssetError,
} from '../domain/errors';
import { LIMITS } from '../domain/limits';
import {
  ASSETS,
  CHUNKS,
  ChunkStore,
  JOURNAL,
  USAGE,
  VERSIONS,
  type AssetRecord,
  type AssetRepository,
  type ChunkRecord,
  type ChunkRepository,
  type JournalRepository,
  type UsageRepository,
  type VersionRepository,
} from '../domain/ports';
import type { AssetConfig } from '../domain/asset-config';
import { ASSET_CONFIG } from './asset-config.token';
import { AssetLimits } from './asset-limits';
import { assetMetrics } from './asset-metrics';
import { AssetNotifier } from './asset-notifier';
import { ChunkPresence, needsStorageCheck } from './chunk-presence';

export interface CommitResult {
  /** 201 for a new version, 200 for an unchanged save. */
  status: 200 | 201;
  body: AssetCommitResponse;
}

interface WriteInput {
  shopId: string;
  userId: string;
  deviceId: string;
  now: Date;
  /** The path asked for; for a restore, the asset's own path. */
  path: string;
  /** The live asset, locked; `null` when there is none at the path. */
  asset: AssetRecord | null;
  baseVersion: number;
  chunks: string[];
  sizeBytes: number;
  present: Set<string>;
}

const hours = (n: number) => n * 3_600_000;

/**
 * Prepare, commit and restore (S31 FR-001…FR-019). Bytes never pass the application. Storage is asked before a
 * transaction opens and the answer is re-validated inside it against rows that cleanup cannot take (research D2, D3);
 * lock order is asset → chunks (by hash) → journal counter, in every writer.
 */
@Injectable()
export class UploadService {
  constructor(
    @Inject(ASSETS) private readonly assets: AssetRepository,
    @Inject(VERSIONS) private readonly versions: VersionRepository,
    @Inject(CHUNKS) private readonly chunks: ChunkRepository,
    @Inject(USAGE) private readonly usage: UsageRepository,
    @Inject(JOURNAL) private readonly journal: JournalRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ASSET_CONFIG) private readonly config: AssetConfig,
    private readonly transactions: TransactionRunner,
    private readonly store: ChunkStore,
    private readonly presence: ChunkPresence,
    private readonly limits: AssetLimits,
    private readonly notifier: AssetNotifier,
  ) {}

  private protectedUntil(now: Date): Date {
    return new Date(now.getTime() + hours(this.config.gcGraceHours));
  }

  async prepare(
    shopId: string,
    request: AssetPrepareRequest,
  ): Promise<AssetPrepareResponse> {
    await this.limits.take('assets.upload.shop', `shop:${shopId}`);
    const now = this.clock.now();
    const protectedUntil = this.protectedUntil(now);

    const wanted = new Map<string, number>();
    for (const { hash, size } of request.chunks) {
      if (wanted.has(hash) && wanted.get(hash) !== size)
        throw chunkSizeMismatch(hash);
      wanted.set(hash, size);
    }
    const hashes = [...wanted.keys()];

    const known = await this.chunks.findMany(shopId, hashes);
    for (const row of known)
      if (row.size !== wanted.get(row.hash)) throw chunkSizeMismatch(row.hash);
    const checked = await this.presence.present(
      shopId,
      known.filter((r) => needsStorageCheck(r, now)).map((r) => r.hash),
    );
    const asked = new Set(
      known.filter((r) => needsStorageCheck(r, now)).map((r) => r.hash),
    );

    const missing = await this.transactions.run(async () => {
      const locked = new Map(
        (await this.chunks.lockMany(shopId, hashes)).map((r) => [r.hash, r]),
      );
      const toInsert: { hash: string; size: number }[] = [];
      const stored: string[] = [];
      const absent: string[] = [];
      const confirm: string[] = [];
      const unstore: string[] = [];
      const touched: string[] = [];
      for (const [hash, size] of wanted) {
        const row = locked.get(hash);
        if (!row) {
          toInsert.push({ hash, size });
          absent.push(hash);
          continue;
        }
        touched.push(hash);
        if (row.deleting) {
          absent.push(hash);
          continue;
        }
        if (!needsStorageCheck(row, now)) {
          stored.push(hash);
          continue;
        }
        if (!asked.has(hash)) {
          // appeared or changed since the read: not confirmed, so not stored
          absent.push(hash);
          continue;
        }
        if (checked.has(hash)) {
          stored.push(hash);
          if (row.storedAt === null) confirm.push(hash);
        } else {
          absent.push(hash);
          if (row.storedAt !== null) unstore.push(hash);
        }
      }

      await this.usage.ensure(shopId);
      const inserted = await this.chunks.insertPlaceholders({
        shopId,
        chunks: toInsert,
        now,
        protectedUntil,
      });
      const newBytes = inserted.reduce((sum, c) => sum + c.size, 0);
      if (
        newBytes > 0 &&
        !(await this.usage.reserve(shopId, newBytes, this.config.quotaBytes))
      ) {
        const used = await this.usage.used(shopId);
        throw quotaExceeded(
          this.config.quotaBytes,
          used.storedBytes + used.reservedBytes,
        );
      }
      if (confirm.length > 0) {
        const moved = await this.chunks.confirmStored(
          shopId,
          confirm,
          now,
          protectedUntil,
        );
        await this.usage.adjust(shopId, {
          storedBytes: moved.storedBytes,
          reservedBytes: -moved.fromReservedBytes,
        });
      }
      if (unstore.length > 0) {
        const bytes = await this.chunks.markNotStored(
          shopId,
          unstore,
          protectedUntil,
        );
        await this.usage.adjust(shopId, {
          storedBytes: -bytes,
          reservedBytes: bytes,
        });
      }
      await this.chunks.protect(shopId, touched, protectedUntil);
      return { absent, storedCount: stored.length };
    });

    // signing is CPU work: in slices, so 5,000 permissions never stall the event loop (load shedding watches it)
    const expiresAt = new Date(
      now.getTime() + LIMITS.uploadPermissionSec * 1000,
    ).toISOString();
    const grants: AssetPrepareResponse['missing'] = [];
    for (let i = 0; i < missing.absent.length; i += 100) {
      grants.push(
        ...(await Promise.all(
          missing.absent.slice(i, i + 100).map(async (hash) => ({
            hash,
            ...(await this.store.presignPut(
              shopId,
              hash,
              wanted.get(hash)!,
              LIMITS.uploadPermissionSec,
            )),
            expiresAt,
          })),
        )),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    assetMetrics.prepareChunks.add(grants.length, { result: 'missing' });
    assetMetrics.prepareChunks.add(missing.storedCount, { result: 'stored' });
    return { missing: grants, alreadyStored: missing.storedCount };
  }

  async commit(
    shopId: string,
    userId: string,
    request: AssetCommitRequest,
  ): Promise<CommitResult> {
    try {
      return await this.doCommit(shopId, userId, request);
    } catch (error) {
      if (error instanceof AssetError)
        assetMetrics.commits.add(1, { outcome: 'rejected' });
      throw error;
    }
  }

  private async doCommit(
    shopId: string,
    userId: string,
    request: AssetCommitRequest,
  ): Promise<CommitResult> {
    await this.limits.take('assets.upload.shop', `shop:${shopId}`);
    const now = this.clock.now();
    const path = validateAssetPath(request.path);
    if (!path.ok)
      throw validationFailed([{ field: 'path', code: path.reason }]);

    const present = await this.verifyChunks(
      shopId,
      request.chunks,
      request.sizeBytes,
      now,
    );

    const result = await this.transactions.run(async () => {
      const asset = await this.assets.lockActiveByPath(shopId, path.path);
      return this.write({
        shopId,
        userId,
        deviceId: request.deviceId,
        now,
        path: path.path,
        asset,
        baseVersion: request.baseVersion,
        chunks: request.chunks,
        sizeBytes: request.sizeBytes,
        present,
      });
    });
    return this.finish(shopId, result);
  }

  /** Restores a version as a new one (FR-027): same base check and conflict outcome as a commit, no upload. */
  async restore(
    shopId: string,
    userId: string,
    assetId: string,
    version: number,
    baseVersion: number,
  ): Promise<CommitResult> {
    await this.limits.take('assets.upload.shop', `shop:${shopId}`);
    const now = this.clock.now();
    const source = await this.assets.find(shopId, assetId);
    if (!source || source.status === 'PURGED') throw assetNotFound();
    if (source.status !== 'ACTIVE') throw assetDeleted();
    const wanted = await this.versions.find(assetId, version);
    if (!wanted) throw versionNotFound();
    const present = await this.verifyChunks(
      shopId,
      wanted.chunks,
      wanted.sizeBytes,
      now,
    );
    const result = await this.transactions.run(async () => {
      const asset = await this.assets.lock(shopId, assetId);
      if (!asset || asset.status === 'PURGED') throw assetNotFound();
      if (asset.status !== 'ACTIVE') throw assetDeleted();
      return this.write({
        shopId,
        userId,
        deviceId: 'restore',
        now,
        path: asset.path,
        asset,
        baseVersion,
        chunks: wanted.chunks,
        sizeBytes: wanted.sizeBytes,
        present,
      });
    });
    return this.finish(shopId, result);
  }

  private async finish(
    shopId: string,
    result: CommitResult & { seq: number | null },
  ): Promise<CommitResult> {
    assetMetrics.commits.add(1, { outcome: result.body.outcome });
    if (result.seq !== null) await this.notifier.changed(shopId, result.seq);
    return { status: result.status, body: result.body };
  }

  /**
   * Everything about the chunks that can be decided before a transaction (FR-009, FR-013): known to the shop, sizes add
   * up, bytes present in storage. Returns the hashes storage confirmed.
   */
  private async verifyChunks(
    shopId: string,
    list: string[],
    sizeBytes: number,
    now: Date,
  ): Promise<Set<string>> {
    const distinct = [...new Set(list)];
    const rows = await this.chunks.findMany(shopId, distinct);
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    const unknown = distinct.filter((h) => !byHash.has(h));
    if (unknown.length > 0) throw chunksUnknown(unknown);
    const toCheck = rows.filter((r) => needsStorageCheck(r, now));
    const present = await this.presence.present(
      shopId,
      toCheck.map((r) => r.hash),
    );
    const notUploaded = rows
      .filter(
        (r) =>
          r.deleting || (needsStorageCheck(r, now) && !present.has(r.hash)),
      )
      .map((r) => r.hash);
    if (notUploaded.length > 0) throw chunkNotUploaded(notUploaded);
    const actual = list.reduce((sum, h) => sum + byHash.get(h)!.size, 0);
    if (actual !== sizeBytes) throw sizeMismatch(sizeBytes, actual);
    return present;
  }

  /** Inside the transaction, asset already locked: decide the outcome and write it. */
  private async write(
    input: WriteInput,
  ): Promise<CommitResult & { seq: number | null }> {
    const { shopId, now, chunks, sizeBytes } = input;
    const distinct = [...new Set(chunks)];

    // re-validate the chunks against rows cleanup cannot take any more once they are locked
    const locked = await this.chunks.lockMany(shopId, distinct);
    const byHash = new Map<string, ChunkRecord>(locked.map((r) => [r.hash, r]));
    const unknown = distinct.filter((h) => !byHash.has(h));
    if (unknown.length > 0) throw chunksUnknown(unknown);
    const unusable = locked
      .filter(
        (r) =>
          r.deleting ||
          (needsStorageCheck(r, now) && !input.present.has(r.hash)),
      )
      .map((r) => r.hash);
    if (unusable.length > 0) throw chunkNotUploaded(unusable);

    // decide
    let asset = input.asset;
    let outcome: AssetCommitResponse['outcome'] | undefined;
    let path = input.path;
    let target: { id: string; current: number } | null = null;
    if (!asset) {
      const id = uuidv7();
      if (await this.assets.insertActive({ id, shopId, path, now })) {
        target = { id, current: 0 };
        outcome = 'created';
      } else {
        // another commit created the path first: we are a stale writer of an asset we did not know
        asset = await this.assets.lockActiveByPath(shopId, path);
      }
    }
    if (asset) {
      if (input.baseVersion > asset.currentVersion)
        throw invalidBaseVersion(asset.currentVersion);
      if (input.baseVersion === asset.currentVersion) {
        const current = await this.versions.find(
          asset.id,
          asset.currentVersion,
        );
        if (
          current &&
          current.chunks.length === chunks.length &&
          current.chunks.every((h, i) => h === chunks[i])
        )
          return {
            status: 200,
            seq: null,
            body: {
              assetId: asset.id,
              path: asset.path,
              version: asset.currentVersion,
              outcome: 'unchanged',
              conflicted: false,
              sizeBytes,
            },
          };
        if ((await this.versions.count(asset.id)) >= this.config.versionCap)
          throw versionLimitReached(this.config.versionCap);
        target = { id: asset.id, current: asset.currentVersion };
        outcome = 'updated';
        path = asset.path;
      } else {
        // stale base, or a device that did not know the file: a conflicted copy, never written into an existing asset
        path = await this.copyPath(shopId, asset.path, input.deviceId, now);
        const id = uuidv7();
        if (!(await this.assets.insertActive({ id, shopId, path, now })))
          throw invalidBaseVersion(asset.currentVersion);
        target = { id, current: 0 };
        outcome = 'conflicted_copy';
      }
    }
    if (!target) throw new Error('commit decided no target');

    // confirm chunks that storage holds but the row did not know yet
    const confirm = locked
      .filter((r) => r.storedAt === null && input.present.has(r.hash))
      .map((r) => r.hash);
    const protectedUntil = this.protectedUntil(now);
    if (confirm.length > 0) {
      const moved = await this.chunks.confirmStored(
        shopId,
        confirm,
        now,
        protectedUntil,
      );
      await this.usage.adjust(shopId, {
        storedBytes: moved.storedBytes,
        reservedBytes: -moved.fromReservedBytes,
      });
    }

    const version = target.current + 1;
    const occurrences = occurrencesOf(chunks);
    await this.versions.insert({
      assetId: target.id,
      shopId,
      version,
      sizeBytes,
      chunks,
      occurrences,
      createdBy: input.userId,
      deviceId: input.deviceId,
      now,
    });
    await this.chunks.adjust({
      shopId,
      deltas: occurrences.map((o) => ({ hash: o.hash, delta: o.occurrences })),
      now,
      protectedUntil,
    });
    await this.assets.setCurrentVersion(target.id, version, now);
    const seq = await this.journal.nextSeq(shopId);
    await this.journal.append({
      shopId,
      seq,
      assetId: target.id,
      path,
      version,
      kind: 'upsert',
      now,
    });
    return {
      status: 201,
      seq,
      body: {
        assetId: target.id,
        path,
        version,
        outcome: outcome!,
        conflicted: outcome === 'conflicted_copy',
        sizeBytes,
      },
    };
  }

  private async copyPath(
    shopId: string,
    original: string,
    deviceId: string,
    now: Date,
  ): Promise<string> {
    const prefix = conflictedCopyBase(original, deviceId, now);
    const taken = await this.assets.activePathsStartingWith(shopId, prefix);
    const path = conflictedCopyPath({
      path: original,
      deviceId,
      at: now,
      isTaken: (candidate) => taken.has(candidate),
    });
    if (path.length > LIMITS.pathMaxLength)
      throw validationFailed([{ field: 'path', code: 'too_long' }]);
    return path;
  }
}
