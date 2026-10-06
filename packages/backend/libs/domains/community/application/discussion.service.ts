import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { FeedPublisher } from './feed-publisher.service';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { renderUserMarkdown } from '../domain/content';
import { childPath, COMMENTS_PER_BUCKET, subtreeRange } from '../domain/paths';
import { hotScore } from '../domain/ranking';

export type BoardSort = 'hot' | 'new' | 'top';

export interface PostView {
  postId: string;
  boardId: string;
  authorId: string;
  title: string;
  bodyHtml: string;
  createdAt: Date;
  ups: number;
  downs: number;
  comments: number;
}

export interface CommentView {
  commentId: string;
  parentId: string | null;
  path: string;
  depth: number;
  authorId: string;
  bodyHtml: string;
  createdAt: Date;
  ups: number;
  downs: number;
  deleted: boolean;
}

const BOARD_ZSET_CAP = 1_000;
export const boardKey = (boardId: string, sort: 'hot' | 'top') => `board:{${boardId}}:${sort}`;
export const scoreKey = (targetId: string) => `score:${targetId}`;
const bucketOf = (date: Date) => date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;

/**
 * Product discussions (SD-11) on ScyllaDB + Redis:
 *  - writes: one Scylla insert per post/comment (no Postgres), sanitized HTML stored,
 *  - hot/top boards: capped Redis ZSETs of post ids (scores recomputed on votes),
 *  - new: Scylla `posts_by_board` month buckets, newest first, paging-state cursor,
 *  - threads: ONE ordered partition read per bucket thanks to materialized paths,
 *  - live scores from Redis hashes (votes are write-behind to Scylla counters).
 */
@Injectable()
export class DiscussionService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly redis: RedisService,
    @Optional() private readonly feed?: FeedPublisher,
  ) {}

  async createPost(boardId: string, authorId: string, title: string, bodyMd: string): Promise<PostView> {
    const postId = types.TimeUuid.now();
    const createdAt = postId.getDate();
    const bodyHtml = renderUserMarkdown(bodyMd);

    await Promise.all([
      this.cassandra.execute(
        `INSERT INTO posts (post_id, board_id, author_id, title, body_md, body_html, created_at, deleted, comment_buckets) VALUES (?, ?, ?, ?, ?, ?, ?, false, 1)`,
        [postId, boardId, authorId, title, bodyMd, bodyHtml, createdAt],
      ),
      this.cassandra.execute(`INSERT INTO posts_by_board (board_id, bucket, post_id, author_id, title) VALUES (?, ?, ?, ?, ?)`, [
        boardId,
        bucketOf(createdAt),
        postId,
        authorId,
        title,
      ]),
    ]);

    await this.redis.client
      .multi()
      .zadd(boardKey(boardId, 'hot'), hotScore(0, 0, createdAt), postId.toString())
      .zadd(boardKey(boardId, 'top'), 0, postId.toString())
      .zremrangebyrank(boardKey(boardId, 'hot'), 0, -BOARD_ZSET_CAP - 1)
      .hset(`post-meta:${postId}`, 'boardId', boardId, 'createdAt', createdAt.getTime())
      .exec();

    // SD-09: followers of the author see the post in their home feed (async fan-out).
    await this.feed?.publish(`user:${authorId}`, 'post', title, { postId: postId.toString(), boardId }).catch(() => undefined);

    return { postId: postId.toString(), boardId, authorId, title, bodyHtml, createdAt, ups: 0, downs: 0, comments: 0 };
  }

  async listBoard(boardId: string, sort: BoardSort, cursor?: string, limit = 25): Promise<{ posts: PostView[]; next?: string }> {
    if (sort !== 'new') {
      const offset = cursor ? Number(cursor) : 0;
      const ids = await this.redis.client.zrevrange(boardKey(boardId, sort), offset, offset + limit - 1);
      return { posts: await this.hydratePosts(ids), next: ids.length === limit ? String(offset + limit) : undefined };
    }

    // Cursor = "<bucket>:<pagingState>" - walk month buckets backwards (the board's history lives in Scylla, not Redis).
    let [bucket, pageState] = cursor ? (cursor.split(':') as [string, string | undefined]) : [String(bucketOf(new Date())), undefined];
    const collected: PostView[] = [];
    for (let hops = 0; hops < 24 && collected.length < limit; hops++) {
      const page = await this.cassandra.execute('SELECT post_id FROM posts_by_board WHERE board_id = ? AND bucket = ?', [boardId, Number(bucket)], {
        fetchSize: limit - collected.length,
        pageState: pageState || undefined,
      });
      collected.push(...(await this.hydratePosts(page.rows.map((r) => r.post_id.toString()))));
      if (page.pageState) return { posts: collected, next: `${bucket}:${page.pageState}` };
      bucket = String(previousBucket(Number(bucket)));
      pageState = undefined;
    }
    return { posts: collected, next: collected.length >= limit ? `${bucket}:` : undefined };
  }

  async getPost(postId: string): Promise<PostView> {
    const [post] = await this.hydratePosts([postId]);
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  async addComment(postId: string, authorId: string, bodyMd: string, parentId?: string): Promise<CommentView> {
    const post = await this.cassandra.execute('SELECT comment_buckets, deleted FROM posts WHERE post_id = ?', [postId]);
    if (!post.rows[0] || post.rows[0].deleted) throw new NotFoundException('Post not found');

    let path: string;
    let bucket: number;
    if (parentId) {
      const parent = (await this.cassandra.execute('SELECT post_id, bucket, path FROM comment_locator WHERE comment_id = ?', [parentId])).rows[0];
      if (!parent || parent.post_id.toString() !== postId) throw new NotFoundException('Parent comment not found');
      path = childPath(parent.path);
      bucket = parent.bucket; // a reply lives in its root's bucket → whole subtree in one partition
    } else {
      const topLevel = await this.redis.client.incr(`post:${postId}:top-level`);
      bucket = Math.floor((topLevel - 1) / COMMENTS_PER_BUCKET);
      path = childPath(null);
      if (bucket + 1 > (post.rows[0].comment_buckets ?? 1)) {
        await this.cassandra.execute('UPDATE posts SET comment_buckets = ? WHERE post_id = ?', [bucket + 1, postId]);
      }
    }

    const commentId = types.TimeUuid.now();
    const createdAt = commentId.getDate();
    const bodyHtml = renderUserMarkdown(bodyMd);
    await this.cassandra.batchSamePartition([
      {
        query: `INSERT INTO comments_by_post (post_id, bucket, path, comment_id, parent_id, author_id, body_md, body_html, created_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false)`,
        params: [postId, bucket, path, commentId, parentId ?? null, authorId, bodyMd, bodyHtml, createdAt],
      },
    ]);
    await this.cassandra.execute('INSERT INTO comment_locator (comment_id, post_id, bucket, path) VALUES (?, ?, ?, ?)', [commentId, postId, bucket, path]);
    await this.redis.client.hincrby(`post-meta:${postId}`, 'comments', 1);
    if (!parentId) await this.redis.client.zadd(`post:{${postId}}:best`, 0, commentId.toString());

    return { commentId: commentId.toString(), parentId: parentId ?? null, path, depth: path.split('.').length - 1, authorId, bodyHtml, createdAt, ups: 0, downs: 0, deleted: false };
  }

  /** Chronological thread: buckets in order, each one sequential, path-ordered partition read. */
  async thread(postId: string, limit = 200): Promise<CommentView[]> {
    const post = (await this.cassandra.execute('SELECT comment_buckets FROM posts WHERE post_id = ?', [postId])).rows[0];
    if (!post) throw new NotFoundException('Post not found');
    const out: CommentView[] = [];
    for (let b = 0; b < (post.comment_buckets ?? 1) && out.length < limit; b++) {
      const rows = await this.cassandra.execute('SELECT * FROM comments_by_post WHERE post_id = ? AND bucket = ? LIMIT ?', [postId, b, limit - out.length]);
      out.push(...(await this.withScores(rows.rows)));
    }
    return out;
  }

  /** "Best": top-level comments by Wilson score, each with its first replies (load more per branch). */
  async bestThread(postId: string, topLevel = 20, repliesPer = 5): Promise<CommentView[]> {
    const ids = await this.redis.client.zrevrange(`post:{${postId}}:best`, 0, topLevel - 1);
    const out: CommentView[] = [];
    for (const id of ids) {
      const loc = (await this.cassandra.execute('SELECT bucket, path FROM comment_locator WHERE comment_id = ?', [id])).rows[0];
      if (!loc) continue;
      const { from, to } = subtreeRange(loc.path);
      const [root, replies] = await Promise.all([
        this.cassandra.execute('SELECT * FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path = ?', [postId, loc.bucket, loc.path]),
        this.cassandra.execute('SELECT * FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path >= ? AND path < ? LIMIT ?', [postId, loc.bucket, from, to, repliesPer]),
      ]);
      out.push(...(await this.withScores([...root.rows, ...replies.rows])));
    }
    return out;
  }

  async deleteComment(commentId: string, userId: string): Promise<void> {
    const loc = (await this.cassandra.execute('SELECT post_id, bucket, path FROM comment_locator WHERE comment_id = ?', [commentId])).rows[0];
    if (!loc) throw new NotFoundException('Comment not found');
    const row = (await this.cassandra.execute('SELECT author_id FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path = ?', [loc.post_id, loc.bucket, loc.path])).rows[0];
    if (row?.author_id.toString() !== userId) throw new ForbiddenException();
    // Tombstoned, not removed: replies keep their place in the tree.
    await this.cassandra.execute(`UPDATE comments_by_post SET deleted = true, body_md = '', body_html = '' WHERE post_id = ? AND bucket = ? AND path = ?`, [
      loc.post_id,
      loc.bucket,
      loc.path,
    ]);
  }

  private async hydratePosts(ids: string[]): Promise<PostView[]> {
    if (ids.length === 0) return [];
    const rows = await Promise.all(ids.map((id) => this.cassandra.execute('SELECT * FROM posts WHERE post_id = ?', [id])));
    const scores = await Promise.all(ids.map((id) => this.redis.client.hmget(scoreKey(id), 'ups', 'downs')));
    const comments = await Promise.all(ids.map((id) => this.redis.client.hget(`post-meta:${id}`, 'comments')));
    return rows
      .map((r, i) => ({ row: r.rows[0], i }))
      .filter(({ row }) => row && !row.deleted)
      .map(({ row, i }) => ({
        postId: row.post_id.toString(),
        boardId: row.board_id,
        authorId: row.author_id.toString(),
        title: row.title,
        bodyHtml: row.body_html,
        createdAt: row.created_at,
        ups: Number(scores[i][0] ?? 0),
        downs: Number(scores[i][1] ?? 0),
        comments: Number(comments[i] ?? 0),
      }));
  }

  private async withScores(rows: types.Row[]): Promise<CommentView[]> {
    const scores = await Promise.all(rows.map((r) => this.redis.client.hmget(scoreKey(r.comment_id.toString()), 'ups', 'downs')));
    return rows.map((r, i) => ({
      commentId: r.comment_id.toString(),
      parentId: r.parent_id?.toString() ?? null,
      path: r.path,
      depth: r.path.split('.').length - 1,
      authorId: r.author_id.toString(),
      bodyHtml: r.deleted ? '' : r.body_html,
      createdAt: r.created_at,
      ups: Number(scores[i][0] ?? 0),
      downs: Number(scores[i][1] ?? 0),
      deleted: !!r.deleted,
    }));
  }
}

function previousBucket(bucket: number): number {
  const year = Math.floor(bucket / 100);
  const month = bucket % 100;
  return month === 1 ? (year - 1) * 100 + 12 : bucket - 1;
}
