import { Inject, Injectable } from '@nestjs/common';
import { feedValidationFailed, invalidFeedCursor } from '../domain/feed-errors';
import { FOLLOW_GRAPH_STORE, type FollowGraphStore } from '../domain/ports';

export const FOLLOWER_PAGE_MAX = 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The way other capabilities read followers (R1, S28 follow-up): active followers of an account, paged. The cursor is
 * opaque to callers; this export never takes a user id from a request.
 */
@Injectable()
export class FollowQueryService {
  constructor(
    @Inject(FOLLOW_GRAPH_STORE) private readonly graph: FollowGraphStore,
  ) {}

  async getFollowerIds(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const { limit } = opts;
    if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWER_PAGE_MAX)
      throw feedValidationFailed(['limit']);
    let after: string | null = null;
    if (opts.cursor !== undefined) {
      after = Buffer.from(opts.cursor, 'base64url').toString('utf8');
      if (!UUID.test(after)) throw invalidFeedCursor();
    }

    const ids = await this.graph.followerIds(accountId, after, limit + 1);
    const page = ids.slice(0, limit);
    return {
      ids: page,
      nextCursor:
        ids.length > limit
          ? Buffer.from(page[page.length - 1], 'utf8').toString('base64url')
          : null,
    };
  }
}
