import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_MUTES,
  MUTE_CACHE,
  type LiveMuteRepository,
  type MuteCache,
} from '../domain/live-ports';

/**
 * The comment path's mute question and the cache rebuild (FR-024): the durable `LiveMute` record is the authority, the
 * Redis set a cache that is refilled from it on a miss and by the reconcile job - a wipe never lifts a mute.
 */
@Injectable()
export class LiveMutes {
  constructor(
    @Inject(LIVE_MUTES) private readonly mutes: LiveMuteRepository,
    @Inject(MUTE_CACHE) private readonly cache: MuteCache,
  ) {}

  async isMuted(streamId: string, userId: string): Promise<boolean> {
    const cached = await this.cache.isMuted(streamId, userId);
    if (cached !== null) return cached;
    const ids = await this.rebuild(streamId);
    return ids.includes(userId);
  }

  /** Refills the cached set of a stream from the durable record. */
  async rebuild(streamId: string): Promise<string[]> {
    const ids = await this.mutes.listByStream(streamId);
    await this.cache.fill(streamId, ids);
    return ids;
  }
}
