import { Injectable, Logger } from '@nestjs/common';
import type { FollowerAudience, FollowerPage } from '../domain/ports';

/**
 * `FOLLOWER_AUDIENCE` stand-in (research R-5, contract CT-2): community does not export a following-graph query yet
 * (S26 follow-up in gaps.md: `FollowQueryService.getFollowerIds`). Until it does this fails closed: no followers, so no
 * marketing notice is sent to an audience nobody can resolve. Replace the body, not the port, when S26 ships.
 */
@Injectable()
export class FollowerAudienceAdapter implements FollowerAudience {
  private readonly logger = new Logger(FollowerAudienceAdapter.name);

  followers(
    accountId: string,
    ..._unused: [limit: number, cursor: string | null]
  ): Promise<FollowerPage> {
    this.logger.warn(
      `follower audience unavailable (S26 not shipped); no recipients for a ${accountId.split(':')[0]} account`,
    );
    return Promise.resolve({ userIds: [], nextCursor: null });
  }
}
