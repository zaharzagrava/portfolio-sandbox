import { Inject, Injectable } from '@nestjs/common';
import type {
  AssetChangePage,
  AssetDto,
  AssetManifest,
  AssetPage,
  AssetVersionPage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { assetTransition } from '../domain/asset-status';
import { occurrencesOf } from '../domain/chunk-plan';
import { decodeCursor, decodeSeq, encodeCursor } from '../domain/cursor';
import {
  assetInUse,
  assetNotFound,
  cannotDeleteCurrentVersion,
  cursorExpired,
  invalidCursor,
  invalidTransition,
  pathTaken,
  versionNotFound,
} from '../domain/errors';
import { LIMITS } from '../domain/limits';
import type { AssetConfig } from '../domain/asset-config';
import {
  ASSETS,
  CHUNKS,
  ChunkStore,
  JOURNAL,
  VERSIONS,
  type AssetRecord,
  type AssetRepository,
  type ChunkRepository,
  type JournalRepository,
  type VersionRepository,
} from '../domain/ports';
import { ASSET_CONFIG } from './asset-config.token';
import { AssetNotifier } from './asset-notifier';

const dto = (a: AssetRecord, sizeBytes: number): AssetDto => ({
  id: a.id,
  path: a.path,
  status: a.status,
  currentVersion: a.currentVersion,
  sizeBytes,
  updatedAt: a.updatedAt.toISOString(),
  deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
});

/**
 * Reads of the library and the lifecycle of an asset (S31 FR-020…FR-029): listing, journal, manifest, version history,
 * delete / undelete, delete of an old version. Every lookup by ID carries the shop (FR-045); every write that changes
 * a count locks asset → chunks → journal counter, like the commit path.
 */
@Injectable()
export class LibraryService {
  constructor(
    @Inject(ASSETS) private readonly assets: AssetRepository,
    @Inject(VERSIONS) private readonly versions: VersionRepository,
    @Inject(CHUNKS) private readonly chunks: ChunkRepository,
    @Inject(JOURNAL) private readonly journal: JournalRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ASSET_CONFIG) private readonly config: AssetConfig,
    private readonly transactions: TransactionRunner,
    private readonly store: ChunkStore,
    private readonly notifier: AssetNotifier,
  ) {}

  async list(
    shopId: string,
    query: {
      prefix?: string;
      deleted: boolean;
      limit: number;
      cursor?: string;
    },
  ): Promise<AssetPage> {
    let after: { path: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor('assets', query.cursor) as {
        p?: unknown;
        i?: unknown;
      } | null;
      if (
        !decoded ||
        typeof decoded.p !== 'string' ||
        typeof decoded.i !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(decoded.i)
      )
        throw invalidCursor();
      after = { path: decoded.p, id: decoded.i };
    }
    // the newest change number is read before the listing, so a device that follows it misses nothing (FR-022)
    const syncCursor =
      query.cursor === undefined
        ? encodeCursor('journal', await this.journal.lastSeq(shopId))
        : null;
    const now = this.clock.now();
    const rows = await this.assets.listPage({
      shopId,
      prefix: query.prefix ?? null,
      deleted: query.deleted,
      deletedSince: new Date(
        now.getTime() - this.config.undeleteDays * 86_400_000,
      ),
      limit: query.limit + 1,
      after,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((a) => dto(a, a.sizeBytes)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor('assets', { p: last.path, i: last.id })
          : null,
      syncCursor,
    };
  }

  async changes(
    shopId: string,
    cursor: string,
    limit: number,
  ): Promise<AssetChangePage> {
    const seq = decodeSeq(cursor);
    if (seq === null) throw invalidCursor();
    const [last, floor] = await Promise.all([
      this.journal.lastSeq(shopId),
      this.journal.minSeq(shopId),
    ]);
    if (seq > last) throw invalidCursor();
    if (seq < floor) throw cursorExpired();
    const rows = await this.journal.after(shopId, seq, limit + 1);
    const page = rows.slice(0, limit);
    const tail = page[page.length - 1];
    return {
      items: page,
      nextCursor: tail ? encodeCursor('journal', tail.seq) : cursor,
      hasMore: rows.length > limit,
    };
  }

  async manifest(
    shopId: string,
    assetId: string,
    query: { version?: number; from: number; limit: number },
  ): Promise<AssetManifest> {
    const asset = await this.assets.find(shopId, assetId);
    if (!asset || asset.status !== 'ACTIVE') throw assetNotFound();
    const wanted = query.version ?? asset.currentVersion;
    const version = await this.versions.find(assetId, wanted);
    if (!version) throw versionNotFound();
    const slice = version.chunks.slice(query.from, query.from + query.limit);
    const sizes = new Map(
      (await this.chunks.findMany(shopId, [...new Set(slice)])).map((r) => [
        r.hash,
        r.size,
      ]),
    );
    const out: AssetManifest['chunks'] = [];
    // signing is CPU work: in slices, so a page of 2,000 URLs never stalls the event loop
    for (let i = 0; i < slice.length; i += 100) {
      out.push(
        ...(await Promise.all(
          slice.slice(i, i + 100).map(async (hash, offset) => ({
            index: query.from + i + offset,
            hash,
            sizeBytes: sizes.get(hash) ?? 0,
            url: await this.store.presignGet(
              shopId,
              hash,
              LIMITS.manifestUrlSec,
            ),
          })),
        )),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    const end = query.from + slice.length;
    return {
      assetId,
      version: version.version,
      sizeBytes: version.sizeBytes,
      chunks: out,
      totalChunks: version.chunks.length,
      nextFrom: end < version.chunks.length ? end : null,
    };
  }

  async versionHistory(
    shopId: string,
    assetId: string,
    query: { limit: number; cursor?: string },
  ): Promise<AssetVersionPage> {
    const asset = await this.assets.find(shopId, assetId);
    if (!asset || asset.status === 'PURGED') throw assetNotFound();
    let before: number | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor('versions', query.cursor);
      if (typeof decoded !== 'number' || !Number.isSafeInteger(decoded))
        throw invalidCursor();
      before = decoded;
    }
    const rows = await this.versions.page(assetId, query.limit + 1, before);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((v) => ({
        ...v,
        createdAt: v.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor('versions', last.version)
          : null,
    };
  }

  /** Deletes an old version and releases its chunk references; the current and the only version stay (FR-026). */
  async deleteVersion(
    shopId: string,
    assetId: string,
    version: number,
  ): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const asset = await this.assets.lock(shopId, assetId);
      if (!asset || asset.status === 'PURGED') throw assetNotFound();
      const wanted = await this.versions.find(assetId, version);
      if (!wanted) throw versionNotFound();
      if (version === asset.currentVersion) throw cannotDeleteCurrentVersion();
      if ((await this.versions.count(assetId)) <= 1)
        throw cannotDeleteCurrentVersion();
      const occurrences = occurrencesOf(wanted.chunks);
      await this.chunks.lockMany(
        shopId,
        occurrences.map((o) => o.hash),
      );
      await this.versions.remove(assetId, version);
      await this.chunks.adjust({
        shopId,
        deltas: occurrences.map((o) => ({
          hash: o.hash,
          delta: -o.occurrences,
        })),
        now,
        protectedUntil: now,
      });
    });
  }

  /** `ACTIVE → DELETED`: the path is free, versions and chunks stay for the undelete window (FR-028). */
  async deleteAsset(shopId: string, assetId: string): Promise<void> {
    const now = this.clock.now();
    const seq = await this.transactions.run(async () => {
      const asset = await this.assets.lock(shopId, assetId);
      if (!asset || asset.status === 'PURGED') throw assetNotFound();
      const move = assetTransition(asset.status, 'delete');
      if (move.kind === 'refused') throw invalidTransition();
      if (await this.assets.inUse(assetId)) throw assetInUse();
      const moved = await this.assets.transition({
        shopId,
        assetId,
        from: asset.status,
        to: move.to,
        deletedAt: now,
        now,
      });
      if (!moved) throw invalidTransition();
      const next = await this.journal.nextSeq(shopId);
      await this.journal.append({
        shopId,
        seq: next,
        assetId,
        path: asset.path,
        version: asset.currentVersion,
        kind: 'delete',
        now,
      });
      return next;
    });
    await this.notifier.changed(shopId, seq);
  }

  /** `DELETED → ACTIVE` within the undelete window, unless another live asset holds the path. */
  async undelete(shopId: string, assetId: string): Promise<AssetDto> {
    const now = this.clock.now();
    const window = this.config.undeleteDays * 86_400_000;
    const result = await this.transactions.run(async () => {
      const asset = await this.assets.lock(shopId, assetId);
      if (!asset || asset.status === 'PURGED') throw assetNotFound();
      const move = assetTransition(asset.status, 'undelete');
      if (move.kind === 'refused') throw invalidTransition();
      if (
        !asset.deletedAt ||
        now.getTime() - asset.deletedAt.getTime() > window
      )
        throw assetNotFound();
      if (await this.assets.lockActiveByPath(shopId, asset.path))
        throw pathTaken();
      let moved: boolean;
      try {
        moved = await this.assets.transition({
          shopId,
          assetId,
          from: asset.status,
          to: move.to,
          deletedAt: null,
          now,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw pathTaken();
        throw error;
      }
      if (!moved) throw invalidTransition();
      const next = await this.journal.nextSeq(shopId);
      await this.journal.append({
        shopId,
        seq: next,
        assetId,
        path: asset.path,
        version: asset.currentVersion,
        kind: 'upsert',
        now,
      });
      const current = await this.versions.find(assetId, asset.currentVersion);
      return {
        seq: next,
        body: dto(
          { ...asset, status: 'ACTIVE', deletedAt: null, updatedAt: now },
          current?.sizeBytes ?? 0,
        ),
      };
    });
    await this.notifier.changed(shopId, result.seq);
    return result.body;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return (e?.parent?.code ?? e?.original?.code) === '23505';
}
