import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ShopAccessService } from '@app/domains/tenancy';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import { cannotMuteStaff, streamNotFound } from '../domain/live-errors';
import { logLiveWarn } from './live-log';
import {
  LIVE_MUTES,
  LIVE_STREAMS,
  MUTE_CACHE,
  type LiveMuteRepository,
  type LiveStreamRepository,
  type MuteCache,
} from '../domain/live-ports';

/**
 * Staff muting and the staff lookup (FR-011, FR-024). A mute is a durable (stream, user) record; the cache follows it
 * best-effort (a miss is rebuilt from the record, so a failed cache write never loses a mute). Staff are the members
 * whose role holds `products.write`, decided by tenancy's exported check.
 */
const STAFF_TTL_MS = 15_000;

@Injectable()
export class LiveModerationService {
  private readonly logger = new Logger(LiveModerationService.name);

  constructor(
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
    @Inject(LIVE_MUTES) private readonly mutes: LiveMuteRepository,
    @Inject(MUTE_CACHE) private readonly cache: MuteCache,
    private readonly access: ShopAccessService,
    private readonly toolkit: CacheService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async mute(
    shopId: string,
    streamId: string,
    userId: string,
    actorId: string,
  ): Promise<void> {
    const stream = await this.streams.findById(streamId);
    if (!stream || stream.shopId !== shopId) throw streamNotFound();
    if (await this.holdsWriteRole(shopId, userId)) throw cannotMuteStaff();
    await this.mutes.mute(streamId, userId, actorId, this.clock.now());
    await this.cache
      .add(streamId, userId)
      .catch((error: Error) =>
        logLiveWarn(this.logger, 'mute_cache_not_updated', { streamId }, error),
      );
  }

  async unmute(
    shopId: string,
    streamId: string,
    userId: string,
  ): Promise<void> {
    const stream = await this.streams.findById(streamId);
    if (!stream || stream.shopId !== shopId) throw streamNotFound();
    await this.mutes.unmute(streamId, userId);
    await this.cache
      .remove(streamId, userId)
      .catch((error: Error) =>
        logLiveWarn(this.logger, 'mute_cache_not_updated', { streamId }, error),
      );
  }

  /**
   * Whether the poster's comments carry `priority` (FR-011): a member whose role holds `products.write`. Asked on every
   * comment, so the answer (for ordinary viewers too, who are not members) is cached for 15 seconds, like tenancy's own
   * role cache: a warm comment path makes no relational query (FR-026).
   */
  async isStaff(shopId: string, userId: string): Promise<boolean> {
    const answer = await this.toolkit.getOrLoad<{ staff: boolean }>(
      cacheKey('live', 1, 'staff', shopId, userId),
      async () => ({ staff: await this.holdsWriteRole(shopId, userId) }),
      { ttlMs: STAFF_TTL_MS, l1: 'never' },
    );
    return answer?.staff ?? false;
  }

  /** The authoritative answer: a refusal of any kind (not a member, read-only, closed shop) is "no". */
  async holdsWriteRole(shopId: string, userId: string): Promise<boolean> {
    try {
      await this.access.assertMember(shopId, userId, 'products.write');
      return true;
    } catch {
      return false;
    }
  }
}
