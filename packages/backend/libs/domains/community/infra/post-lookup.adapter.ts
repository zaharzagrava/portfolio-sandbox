import { Injectable } from '@nestjs/common';
import {
  DiscussionQueryService,
  POST_SUMMARY_MAX_IDS,
} from '../application/discussion-query.service';
import type { FeedPostLookup, PostSummary } from '../domain/ports';

/**
 * Anti-corruption adapter over S25's exported batch query (R1, IV.8): the only importer of `DiscussionQueryService` in the
 * feed. Deleted and shadow posts are absent from the answer, so the feed hides them at read time. At most 100 ids per
 * call to S25; a failure is thrown to the caller, which omits the posts and marks the page degraded (fail closed).
 */
@Injectable()
export class PostLookupAdapter implements FeedPostLookup {
  constructor(private readonly posts: DiscussionQueryService) {}

  async lookup(postIds: string[]): Promise<Map<string, PostSummary>> {
    const unique = [...new Set(postIds)];
    const out = new Map<string, PostSummary>();
    for (let i = 0; i < unique.length; i += POST_SUMMARY_MAX_IDS) {
      const found = await this.posts.getPostsByIds(
        unique.slice(i, i + POST_SUMMARY_MAX_IDS),
      );
      for (const [id, post] of found)
        out.set(id, {
          postId: post.postId,
          boardId: post.boardId,
          authorId: post.authorId,
          title: post.title,
          createdAt: post.createdAt,
        });
    }
    return out;
  }
}
