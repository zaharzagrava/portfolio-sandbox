import { Inject, Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { attachmentHeader } from '../domain/content-disposition';
import { downloadUnavailable, storageUnavailable } from '../domain/errors';
import { LIMITS } from '../domain/limits';
import {
  ChunkStore,
  GRANTS,
  StorageUnavailableError,
  VERSIONS,
  type GrantRepository,
  type ResolvedGrant,
  type VersionRepository,
} from '../domain/ports';
import { AssetLimits } from './asset-limits';
import { assetMetrics } from './asset-metrics';
import { digestOf, looksLikeToken } from './tokens';

/** The replaceable licensing step of a buyer download (FR-038): the default adds nothing; real watermarking is out of scope. */
export abstract class LicensingHook {
  abstract headers(buyerId: string): Record<string, string>;
  abstract transform(body: Readable, buyerId: string): Readable;
}

@Injectable()
export class NoWatermark extends LicensingHook {
  headers(): Record<string, string> {
    return {};
  }
  transform(body: Readable): Readable {
    return body;
  }
}

export interface Delivery {
  headers: Record<string, string>;
  body: Readable;
}

const fileNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * `GET /downloads/:token` (S31 FR-036, FR-037): re-checks the grant, the link or entitlement and the asset on every
 * fetch, opens the first chunk before any header is chosen (a clean `503` when storage fails), then streams the chunks
 * in order with constant memory and backpressure. A later failure aborts the connection. Every unavailable reason is
 * the same `410 download_unavailable`.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(VERSIONS) private readonly versions: VersionRepository,
    @Inject(GRANTS) private readonly grants: GrantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly store: ChunkStore,
    private readonly limits: AssetLimits,
    private readonly licensing: LicensingHook,
  ) {}

  async open(token: string, address: string): Promise<Delivery> {
    await this.limits.take('assets.redeem.ip', `ip:${address}`);
    const grant = looksLikeToken(token)
      ? await this.grants.resolve(digestOf(token))
      : null;
    if (!grant || !this.usable(grant, this.clock.now())) {
      assetMetrics.downloads.add(1, {
        kind: grant?.kind ?? 'share',
        outcome: 'unavailable',
      });
      throw downloadUnavailable();
    }
    const version = await this.versions.find(grant.assetId, grant.version);
    if (!version) throw downloadUnavailable();

    let first: Readable | null = null;
    try {
      if (version.chunks.length > 0)
        first = await this.store.open(grant.shopId, version.chunks[0]);
    } catch (error) {
      assetMetrics.storageFailures.add(1, { operation: 'open' });
      assetMetrics.downloads.add(1, { kind: grant.kind, outcome: 'aborted' });
      if (error instanceof StorageUnavailableError) throw storageUnavailable();
      throw error;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(version.sizeBytes),
      'Content-Disposition': attachmentHeader(fileNameOf(grant.path)),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    };
    let body = Readable.from(this.stream(grant, version.chunks, first), {
      objectMode: false,
    });
    if (grant.kind === 'purchase' && grant.buyerId) {
      headers['X-Licensed-To'] = grant.buyerId;
      Object.assign(headers, this.licensing.headers(grant.buyerId));
      body = this.licensing.transform(body, grant.buyerId);
    }
    return { headers, body };
  }

  private usable(grant: ResolvedGrant, now: Date): boolean {
    if (grant.expiresAt.getTime() <= now.getTime()) return false;
    if (grant.assetStatus === 'PURGED') return false;
    if (grant.kind === 'share')
      return grant.linkFound && grant.linkRevokedAt === null;
    return grant.entitlementStatus === 'ACTIVE';
  }

  private async *stream(
    grant: ResolvedGrant,
    hashes: string[],
    first: Readable | null,
  ): AsyncGenerator<Buffer> {
    let finished = false;
    try {
      for (const [index, hash] of hashes.entries()) {
        const source =
          index === 0 && first
            ? first
            : await this.store.open(grant.shopId, hash);
        yield* this.read(source);
      }
      finished = true;
    } catch (error) {
      assetMetrics.storageFailures.add(1, { operation: 'stream' });
      this.logger.warn(`download aborted: ${(error as Error).message}`);
      throw error;
    } finally {
      assetMetrics.downloads.add(1, {
        kind: grant.kind,
        outcome: finished ? 'ok' : 'aborted',
      });
    }
  }

  /** One chunk's bytes; a source that sends nothing for the idle limit is destroyed (the timer rests while the client is slow). */
  private async *read(source: Readable): AsyncGenerator<Buffer> {
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => source.destroy(new Error('storage stream idle')),
        LIMITS.idleStreamMs,
      );
    };
    try {
      arm();
      for await (const piece of source) {
        clearTimeout(timer);
        yield piece as Buffer;
        arm();
      }
    } finally {
      clearTimeout(timer);
      source.destroy();
    }
  }
}
