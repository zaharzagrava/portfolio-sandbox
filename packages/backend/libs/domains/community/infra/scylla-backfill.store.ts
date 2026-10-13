import { Injectable } from '@nestjs/common';
import type { BackfillStore } from '../domain/ports';
import { monthBucketOf } from '../domain/months';
import { ScyllaStore, type Statement } from './scylla-store';

/**
 * Expand step for rows written before S25 (data-model "Migration order"): `board_months` for every old post and
 * `top_comments_by_post` / `post_buckets` for every old top-level comment. Pure upserts, so a re-run is harmless.
 */
@Injectable()
export class ScyllaBackfillStore implements BackfillStore {
  constructor(private readonly store: ScyllaStore) {}

  async boardMonths(pageState: string | null, size: number) {
    const page = await this.store.read(
      'SELECT post_id, board_id, created_at FROM posts',
      [],
      { fetchSize: size, pageState: pageState ?? undefined },
    );
    const statements: Statement[] = page.rows.map((r) => ({
      query: 'INSERT INTO board_months (board_id, bucket) VALUES (?, ?)',
      params: [r.board_id, monthBucketOf(r.created_at)],
    }));
    for (let i = 0; i < statements.length; i += 50)
      await this.store.batch(statements.slice(i, i + 50));
    return { rows: page.rows.length, next: page.pageState ?? null };
  }

  async threadRoots(
    pageState: string | null,
    size: number,
    partitionSize: number,
  ) {
    const page = await this.store.read(
      'SELECT post_id, bucket, path, comment_id, author_id, deleted, shadow FROM comments_by_post',
      [],
      { fetchSize: size, pageState: pageState ?? undefined },
    );
    const topBucket = new Map<string, number>();
    const statements: Statement[] = [];
    for (const r of page.rows) {
      if (String(r.path).includes('.')) continue;
      const postId = r.post_id.toString();
      topBucket.set(postId, Math.max(topBucket.get(postId) ?? 0, r.bucket));
      statements.push({
        query:
          'INSERT INTO top_comments_by_post (post_id, bucket, path, comment_id, shadow, deleted, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          postId,
          r.bucket,
          r.path,
          r.comment_id.toString(),
          r.shadow === true,
          r.deleted === true,
          r.author_id?.toString() ?? null,
        ],
      });
    }
    for (let i = 0; i < statements.length; i += 50)
      await this.store.batch(statements.slice(i, i + 50));
    for (const [postId, bucket] of topBucket) {
      // a full old bucket, so the next top-level comment starts a new one; never lowers an existing allocator
      const inserted = await this.store.lwt(
        'INSERT INTO post_buckets (post_id, bucket, filled) VALUES (?, ?, ?) IF NOT EXISTS',
        [postId, bucket, partitionSize],
      );
      if (!inserted.applied)
        await this.store.lwt(
          'UPDATE post_buckets SET bucket = ?, filled = ? WHERE post_id = ? IF bucket < ?',
          [bucket, partitionSize, postId, bucket],
        );
    }
    return { rows: page.rows.length, next: page.pageState ?? null };
  }
}
