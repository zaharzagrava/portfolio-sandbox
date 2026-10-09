import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'assets.gc-chunks': Record<string, never>;
  }
}

declareJobType({
  name: 'assets.gc-chunks',
  contract: z.object({}),
});

const chunkKey = (shopId: string, hash: string) =>
  `assets/${shopId}/chunks/${hash}`;
const HASH = /^[0-9a-f]{64}$/;
const MAX_CHUNK = 16 << 20;
const GC_GRACE = '24 hours';

export interface CommitInput {
  path: string;
  /** The version the device edited; a mismatch means someone else changed the file meanwhile. */
  baseVersion: number;
  chunks: string[];
  size: number;
  deviceId: string;
}

@Injectable()
export class AssetsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Delta sync step 1 (10/08 #25): the client sends the chunk hashes of the
   * file; we answer with upload URLs ONLY for chunks this shop doesn't have.
   * Editing 1 byte of a 2 GB file → ~1 chunk uploaded. Placeholder rows
   * (refCount 0) start the GC grace clock for chunks never committed.
   */
  async prepareUpload(
    shopId: string,
    chunks: { hash: string; size: number }[],
  ) {
    if (
      chunks.some(
        (c) => !HASH.test(c.hash) || c.size <= 0 || c.size > MAX_CHUNK,
      )
    )
      throw new BadRequestException('chunks: sha256 hex + size ≤ 16 MB');
    const unique = [...new Map(chunks.map((c) => [c.hash, c])).values()];
    const existing = new Set(
      (
        await this.sequelize.query<{ hash: string }>(
          `SELECT hash FROM "AssetChunk" WHERE "shopId" = :shopId AND hash IN (:hashes) AND ("refCount" > 0 OR "unreferencedSince" > now() - interval '1 hour')`,
          {
            type: QueryTypes.SELECT,
            replacements: { shopId, hashes: unique.map((c) => c.hash) },
          },
        )
      ).map((r) => r.hash),
    );
    const missing = unique.filter((c) => !existing.has(c.hash));
    for (const c of missing) {
      await this.sequelize.query(
        `INSERT INTO "AssetChunk" ("shopId", hash, size) VALUES (:shopId, :hash, :size) ON CONFLICT ("shopId", hash) DO UPDATE SET "unreferencedSince" = CASE WHEN "AssetChunk"."refCount" = 0 THEN now() ELSE NULL END`,
        { replacements: { shopId, hash: c.hash, size: c.size } },
      );
    }
    return {
      missing: await Promise.all(
        missing.map(async (c) => ({
          hash: c.hash,
          ...(await this.storage.presignPutChecked(
            chunkKey(shopId, c.hash),
            c.hash,
            c.size,
          )),
        })),
      ),
      alreadyStored: unique.length - missing.length,
    };
  }

  /**
   * Step 2: commit a version = ordered chunk list, in ONE transaction: every
   * chunk must exist (HEAD for newly uploaded ones), refCounts increment, the
   * change journal advances. If the asset moved past `baseVersion` (another
   * device saved first), nothing is overwritten: the upload becomes a
   * "conflicted copy" next to it - a human merges, like Dropbox.
   */
  async commit(shopId: string, userId: string, input: CommitInput) {
    if (!/^\/[^\0]{1,1000}$/.test(input.path) || input.path.includes('/../'))
      throw new BadRequestException('invalid path');
    if (input.chunks.length === 0 || input.chunks.some((h) => !HASH.test(h)))
      throw new BadRequestException('chunks must be sha256 hex');
    const distinct = [...new Set(input.chunks)];
    // Storage HEAD is network I/O: it runs before the transaction opens so no connection is held while waiting on S3
    // (constitution III.3, S54 T037). Chunks that are already referenced were verified when first committed.
    const unreferenced = await this.sequelize.query<{ hash: string }>(
      `SELECT hash FROM "AssetChunk" WHERE "shopId" = :shopId AND hash IN (:hashes) AND "refCount" = 0`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, hashes: distinct },
      },
    );
    for (const c of unreferenced) {
      if (!(await this.storage.head(chunkKey(shopId, c.hash))))
        throw new BadRequestException(`chunk ${c.hash} was not uploaded`);
    }
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    return this.sequelize.transaction(async (transaction) => {
      const known = await this.sequelize.query<{
        hash: string;
        refCount: number;
        size: number;
      }>(
        `SELECT hash, "refCount", size FROM "AssetChunk" WHERE "shopId" = :shopId AND hash IN (:hashes) FOR UPDATE`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId, hashes: distinct },
          transaction,
        },
      );
      if (known.length !== distinct.length)
        throw new BadRequestException('unknown chunks: call prepare first');
      const sizes = new Map(known.map((k) => [k.hash, Number(k.size)]));
      if (input.chunks.reduce((s, h) => s + sizes.get(h)!, 0) !== input.size)
        throw new BadRequestException('size does not match the chunks');

      let [asset] = await this.sequelize.query<{
        id: string;
        currentVersion: number;
      }>(
        `SELECT id, "currentVersion" FROM "Asset" WHERE "shopId" = :shopId AND path = :path AND NOT deleted FOR UPDATE`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId, path: input.path },
          transaction,
        },
      );
      let path = input.path;
      let conflicted = false;
      if (asset && asset.currentVersion !== input.baseVersion) {
        conflicted = true;
        const dot = path.lastIndexOf('.');
        const suffix = ` (conflicted copy ${input.deviceId} ${new Date().toISOString().slice(0, 10)})`;
        path =
          dot > path.lastIndexOf('/')
            ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}`
            : `${path}${suffix}`;
        asset = undefined as never;
      }
      if (!asset) {
        [asset] = await this.sequelize.query<{
          id: string;
          currentVersion: number;
        }>(
          `INSERT INTO "Asset" ("shopId", path) VALUES (:shopId, :path) ON CONFLICT ("shopId", path) WHERE NOT deleted DO UPDATE SET "updatedAt" = now() RETURNING id, "currentVersion"`,
          {
            type: QueryTypes.SELECT,
            replacements: { shopId, path },
            transaction,
          },
        );
      }
      const version = asset.currentVersion + 1;
      await this.sequelize.query(
        `INSERT INTO "AssetVersion" ("assetId", version, size, chunks, "createdBy", "deviceId") VALUES (:assetId, :version, :size, CAST(:chunks AS text[]), :userId, :deviceId)`,
        {
          replacements: {
            assetId: asset.id,
            version,
            size: input.size,
            chunks: `{${input.chunks.join(',')}}`,
            userId,
            deviceId: input.deviceId,
          },
          transaction,
        },
      );
      await this.sequelize.query(
        `UPDATE "Asset" SET "currentVersion" = :version, "updatedAt" = now() WHERE id = :id`,
        { replacements: { version, id: asset.id }, transaction },
      );
      await this.adjustRefs(shopId, input.chunks, +1, transaction);
      await this.journal(
        shopId,
        asset.id,
        path,
        version,
        'upsert',
        transaction,
      );
      return { assetId: asset.id, path, version, conflicted };
    });
  }

  /** Deleting a version releases its chunks; chunks still used by other versions/files stay (refCount > 0). */
  async deleteVersion(shopId: string, assetId: string, version: number) {
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    await this.sequelize.transaction(async (transaction) => {
      const [v] = await this.sequelize.query<{
        chunks: string[];
        path: string;
        currentVersion: number;
      }>(
        `DELETE FROM "AssetVersion" v USING "Asset" a WHERE v."assetId" = a.id AND a.id = :assetId AND a."shopId" = :shopId AND v.version = :version RETURNING v.chunks, a.path, a."currentVersion"`,
        {
          type: QueryTypes.SELECT,
          replacements: { assetId, shopId, version },
          transaction,
        },
      );
      if (!v) throw new NotFoundException('Version not found');
      await this.adjustRefs(shopId, v.chunks, -1, transaction);
      if (v.currentVersion === version) {
        await this.sequelize.query(
          `UPDATE "Asset" SET deleted = true WHERE id = :assetId`,
          { replacements: { assetId }, transaction },
        );
        await this.journal(
          shopId,
          assetId,
          v.path,
          version,
          'delete',
          transaction,
        );
      }
    });
  }

  /** Devices pull everything after their cursor (same model as SD-06 / SD-14). */
  async changes(shopId: string, cursor: number) {
    const rows = await this.sequelize.query<{
      seq: string;
      assetId: string;
      path: string;
      version: number;
      kind: string;
    }>(
      `SELECT seq, "assetId", path, version, kind FROM "AssetChange" WHERE "shopId" = :shopId AND seq > :cursor ORDER BY seq LIMIT 1001`,
      { type: QueryTypes.SELECT, replacements: { shopId, cursor } },
    );
    const page = rows.slice(0, 1000);
    return {
      changes: page.map((r) => ({ ...r, seq: Number(r.seq) })),
      cursor: page.length ? Number(page[page.length - 1].seq) : cursor,
      hasMore: rows.length > 1000,
    };
  }

  /** Download plan for sync clients: chunk list + short-lived URLs (client fetches in parallel, skips chunks it has). */
  async manifest(shopId: string, assetId: string, version?: number) {
    const v = await this.version(assetId, version, shopId);
    const unique = [...new Set(v.chunks)];
    return {
      assetId,
      version: v.version,
      size: Number(v.size),
      chunks: v.chunks,
      urls: Object.fromEntries(
        await Promise.all(
          unique.map(async (h) => [
            h,
            await this.storage.presignGet(chunkKey(shopId, h), {
              expiresInSec: 600,
            }),
          ]),
        ),
      ),
    };
  }

  /** Browser download: chunks streamed in order through one response, constant memory, backpressure respected. */
  async stream(
    assetId: string,
    version?: number,
  ): Promise<{ body: Readable; size: number; name: string }> {
    const v = await this.version(assetId, version);
    const body = new PassThrough();
    void (async () => {
      try {
        for (const hash of v.chunks) {
          for await (const piece of await this.storage.getStream(
            chunkKey(v.shopId, hash),
          ))
            if (!body.write(piece))
              await new Promise((r) => body.once('drain', r));
        }
        body.end();
      } catch (error) {
        body.destroy(error as Error);
      }
    })();
    return { body, size: Number(v.size), name: v.path.split('/').pop()! };
  }

  /** Share link: random token, only its hash stored; expiry + optional download cap. */
  async share(
    shopId: string,
    assetId: string,
    expiresInHours: number,
    maxDownloads?: number,
  ) {
    await this.version(assetId, undefined, shopId);
    const token = randomBytes(24).toString('base64url');
    await this.sequelize.query(
      `INSERT INTO "AssetShareLink" ("tokenHash", "assetId", "expiresAt", "maxDownloads") VALUES (:hash, :assetId, now() + make_interval(hours => :hours), :maxDownloads)`,
      {
        replacements: {
          hash: createHash('sha256').update(token).digest('hex'),
          assetId,
          hours: Math.min(expiresInHours, 24 * 30),
          maxDownloads: maxDownloads ?? null,
        },
      },
    );
    return {
      token,
      url: `${this.config.get('backend_host')}/api/assets/shared/${token}`,
    };
  }

  /** Atomic redeem: expiry and download cap enforced in the UPDATE itself (two clicks can't exceed the cap). */
  async redeemShare(token: string) {
    const [link] = await this.sequelize.query<{ assetId: string }>(
      `UPDATE "AssetShareLink" SET downloads = downloads + 1 WHERE "tokenHash" = :hash AND "expiresAt" > now() AND ("maxDownloads" IS NULL OR downloads < "maxDownloads") RETURNING "assetId"`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          hash: createHash('sha256').update(token).digest('hex'),
        },
      },
    );
    if (!link) throw new GoneException('Link expired or used up');
    return this.stream(link.assetId);
  }

  /**
   * Digital products: a PAID order line for this buyer is the entitlement;
   * the download is a 10-minute token bound to buyer + asset version (a leaked
   * URL dies quickly and is attributable to one buyer).
   */
  async digitalDownloadToken(buyerId: string, productId: string) {
    const [entitled] = await this.sequelize.query<{
      assetId: string;
      currentVersion: number;
    }>(
      `SELECT d."assetId", a."currentVersion" FROM "DigitalProduct" d JOIN "Asset" a ON a.id = d."assetId" AND NOT a.deleted
       WHERE d."productId" = :productId AND EXISTS (
         SELECT 1 FROM "BisOrderItem" i JOIN "BisOrder" o ON o.id = i."bisOrderId"
         WHERE i."productId" = :productId AND o."userId" = :buyerId AND o.status IN ('PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'))`,
      { type: QueryTypes.SELECT, replacements: { productId, buyerId } },
    );
    if (!entitled) throw new ForbiddenException('Not purchased');
    const token = jwt.sign(
      {
        typ: 'digital',
        b: buyerId,
        a: entitled.assetId,
        v: entitled.currentVersion,
      },
      this.config.get('jwt_secret'),
      { expiresIn: 600 },
    );
    return {
      url: `${this.config.get('backend_host')}/api/downloads/${token}`,
      expiresInSec: 600,
    };
  }

  async redeemDownload(token: string) {
    let claims: { typ: string; b: string; a: string; v: number };
    try {
      claims = jwt.verify(
        token,
        this.config.get('jwt_secret'),
      ) as typeof claims;
    } catch {
      throw new GoneException('Download link expired');
    }
    if (claims.typ !== 'digital')
      throw new GoneException('Download link expired');
    return { ...(await this.stream(claims.a, claims.v)), licensedTo: claims.b };
  }

  /** GC: chunks unreferenced for 24 h. The row lock in the DELETE races safely with a concurrent commit (FOR UPDATE above). */
  @JobHandler('assets.gc-chunks', { concurrency: 1 })
  async gc(): Promise<number> {
    let freed = 0;
    for (;;) {
      const doomed = await this.sequelize.query<{
        shopId: string;
        hash: string;
      }>(
        `DELETE FROM "AssetChunk" WHERE ("shopId", hash) IN (SELECT "shopId", hash FROM "AssetChunk" WHERE "refCount" = 0 AND "unreferencedSince" < now() - interval '${GC_GRACE}' LIMIT 500 FOR UPDATE SKIP LOCKED) RETURNING "shopId", hash`,
        { type: QueryTypes.SELECT },
      );
      for (const c of doomed)
        await this.storage
          .delete(chunkKey(c.shopId, c.hash))
          .catch(() => undefined);
      freed += doomed.length;
      if (doomed.length < 500) return freed;
    }
  }

  async linkDigitalProduct(shopId: string, productId: string, assetId: string) {
    const [ok] = await this.sequelize.query(
      `SELECT 1 FROM "Product" p JOIN "Asset" a ON a.id = :assetId AND a."shopId" = :shopId WHERE p.id = :productId AND p."shopId" = :shopId`,
      {
        type: QueryTypes.SELECT,
        replacements: { productId, assetId, shopId },
      },
    );
    if (!ok) throw new NotFoundException();
    await this.sequelize.query(
      `INSERT INTO "DigitalProduct" ("productId", "assetId") VALUES (:productId, :assetId) ON CONFLICT ("productId") DO UPDATE SET "assetId" = EXCLUDED."assetId"`,
      { replacements: { productId, assetId } },
    );
  }

  private async version(assetId: string, version?: number, shopId?: string) {
    const [v] = await this.sequelize.query<{
      version: number;
      size: string;
      chunks: string[];
      path: string;
      shopId: string;
    }>(
      `SELECT v.version, v.size, v.chunks, a.path, a."shopId" FROM "Asset" a JOIN "AssetVersion" v ON v."assetId" = a.id AND v.version = coalesce(:version, a."currentVersion")
       WHERE a.id = :assetId ${shopId ? 'AND a."shopId" = :shopId' : ''}`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          assetId,
          version: version ?? null,
          shopId: shopId ?? null,
        },
      },
    );
    if (!v) throw new NotFoundException('Asset not found');
    return v;
  }

  private async adjustRefs(
    shopId: string,
    chunks: string[],
    delta: 1 | -1,
    transaction: Transaction,
  ) {
    const counts = new Map<string, number>();
    for (const h of chunks) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [hash, n] of counts) {
      await this.sequelize.query(
        `UPDATE "AssetChunk" SET "refCount" = "refCount" + :d, "unreferencedSince" = CASE WHEN "refCount" + :d = 0 THEN now() ELSE NULL END WHERE "shopId" = :shopId AND hash = :hash`,
        { replacements: { d: delta * n, shopId, hash }, transaction },
      );
    }
  }

  private async journal(
    shopId: string,
    assetId: string,
    path: string,
    version: number,
    kind: 'upsert' | 'delete',
    transaction: Transaction,
  ) {
    const [{ lastSeq }] = await this.sequelize.query<{ lastSeq: string }>(
      `INSERT INTO "AssetSyncState" ("shopId", "lastSeq") VALUES (:shopId, 1) ON CONFLICT ("shopId") DO UPDATE SET "lastSeq" = "AssetSyncState"."lastSeq" + 1 RETURNING "lastSeq"`,
      { type: QueryTypes.SELECT, replacements: { shopId }, transaction },
    );
    await this.sequelize.query(
      `INSERT INTO "AssetChange" ("shopId", seq, "assetId", path, version, kind) VALUES (:shopId, :seq, :assetId, :path, :version, :kind)`,
      {
        replacements: { shopId, seq: lastSeq, assetId, path, version, kind },
        transaction,
      },
    );
  }
}
