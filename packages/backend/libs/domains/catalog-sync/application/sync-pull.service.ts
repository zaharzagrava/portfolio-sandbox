import { Inject, Injectable } from '@nestjs/common';
import type { SyncPullResponse } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { invalidCursor, syncProblem } from '../domain/catalog-sync-errors';
import { SYNC_FEED_REPOSITORY, type SyncFeedRepository } from '../domain/ports';
import { decodeSyncCursor, encodeSyncCursor } from '../domain/sync-cursor';
import { SyncClockService } from './sync-clock.service';
import { SyncLifecycleService } from './sync-lifecycle.service';

/**
 * Pull (FR-023…FR-027): everything in the shop's feed after the device's cursor, in increasing `seq`. No cursor is a
 * bootstrap: the newest entry of every product, then a cursor from which ordinary pulls continue. A cursor of an older
 * generation, ahead of the head or below the compaction horizon is `410 resync_required`; a malformed or foreign one is
 * `400 invalid_cursor` (never a silent start from zero).
 */
@Injectable()
export class SyncPullService {
  private readonly key: string;

  constructor(
    @Inject(SYNC_FEED_REPOSITORY) private readonly feed: SyncFeedRepository,
    private readonly lifecycle: SyncLifecycleService,
    private readonly serverClock: SyncClockService,
    config: ApiConfigService,
  ) {
    this.key = config.get('integration_cursor_key');
  }

  async pull(
    shopId: string,
    query: { cursor?: string; limit: number },
  ): Promise<SyncPullResponse> {
    // Reject a bad cursor before any work, whatever the feed's state.
    const decoded =
      query.cursor === undefined
        ? null
        : decodeSyncCursor(query.cursor, shopId, this.key);
    if (decoded && !decoded.ok) throw invalidCursor();

    await this.lifecycle.ensureFeedBuilt(shopId);
    const state = await this.feed.state(shopId);
    if (!state) throw syncProblem('sync_unavailable');

    let afterSeq = 0;
    if (decoded?.ok) {
      if (
        decoded.generation !== state.generation ||
        decoded.seq > state.lastSeq ||
        decoded.seq < state.horizonSeq
      )
        throw syncProblem('resync_required');
      afterSeq = decoded.seq;
    }

    const found = await this.feed.page(shopId, afterSeq, query.limit + 1, {
      latestOnly: decoded === null,
    });
    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      changes: page.map((entry) => ({
        seq: entry.seq,
        entity: 'product' as const,
        id: entry.productId,
        version: entry.version,
        deleted: entry.deleted,
        data: entry.data,
      })),
      cursor: encodeSyncCursor(
        { shopId, generation: state.generation, seq: last?.seq ?? afterSeq },
        this.key,
      ),
      hasMore: found.length > query.limit,
      serverHlc: this.serverClock.stamp(),
    };
  }
}
