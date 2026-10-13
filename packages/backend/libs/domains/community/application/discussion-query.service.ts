import { Inject, Injectable } from '@nestjs/common';
import { POST_STORE, type PostStore } from '../domain/ports';
import { CountsService } from './counts.service';

/** What the feed (S26) needs to show a post: no body, no markup. */
export interface PostSummaryDto {
  postId: string;
  boardId: string;
  authorId: string;
  title: string;
  createdAt: Date;
  score: number;
  commentCount: number;
}

export const POST_SUMMARY_MAX_IDS = 100;

/**
 * Exported batch query of discussions (R1, S25 FR-061): deleted and shadow posts are absent, so a feed hides them at
 * hydration time. At most 100 ids, one `IN` read.
 */
@Injectable()
export class DiscussionQueryService {
  constructor(
    @Inject(POST_STORE) private readonly posts: PostStore,
    private readonly counts: CountsService,
  ) {}

  async getPostsByIds(ids: string[]): Promise<Map<string, PostSummaryDto>> {
    const unique = [...new Set(ids)];
    if (unique.length > POST_SUMMARY_MAX_IDS)
      throw new RangeError(
        `getPostsByIds takes at most ${POST_SUMMARY_MAX_IDS} ids`,
      );
    if (unique.length === 0) return new Map();
    const rows = (await this.posts.getMany(unique)).filter(
      (r) => !r.deleted && !r.shadow,
    );
    const [votes, comments] = await Promise.all([
      this.counts.voteCountsMany(rows.map((r) => r.postId)),
      this.counts.commentCounts(rows.map((r) => r.postId)),
    ]);
    return new Map(
      rows.map((r) => {
        const v = votes.get(r.postId)!;
        return [
          r.postId,
          {
            postId: r.postId,
            boardId: r.boardId,
            authorId: r.authorId,
            title: r.title,
            createdAt: r.createdAt,
            score: v.ups - v.downs,
            commentCount: comments.get(r.postId) ?? 0,
          },
        ];
      }),
    );
  }
}
