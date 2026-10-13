import { Injectable } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import type {
  CommentLocator,
  CommentRow,
  CommentStore,
  DeletedBy,
  RecordedEvent,
  ThreadRoot,
} from '../domain/ports';
import { isTimeUuid } from '../domain/ids';
import { assignRootSlot } from '../domain/paths';
import { eventStatements } from './event-rows';
import { ScyllaStore, type Statement } from './scylla-store';

export function toCommentRow(row: types.Row): CommentRow {
  return {
    commentId: row.comment_id.toString(),
    postId: row.post_id.toString(),
    bucket: row.bucket,
    path: row.path,
    parentId: row.parent_id?.toString() ?? null,
    depth: row.depth ?? String(row.path).split('.').length - 1,
    authorId: row.author_id?.toString() ?? null,
    bodyMd: row.body_md ?? null,
    bodyHtml: row.body_html ?? null,
    htmlVersion: row.html_version ?? null,
    createdAt: row.created_at,
    deleted: row.deleted === true,
    deletedBy: (row.deleted_by as DeletedBy | null) ?? null,
    shadow: row.shadow === true,
    moreReplies: row.more_replies === true,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_SLOT_ATTEMPTS = 300;

/** `comments_by_post`, `top_comments_by_post`, `comment_locator` and the slot allocator (S25 B1, B2, FR-014). */
@Injectable()
export class ScyllaCommentStore implements CommentStore {
  constructor(private readonly store: ScyllaStore) {}

  async allocateRootBucket(
    postId: string,
    partitionSize: number,
  ): Promise<number> {
    let current: { bucket: number; filled: number } | undefined;
    const first = await this.store.read(
      'SELECT bucket, filled FROM post_buckets WHERE post_id = ?',
      [postId],
    );
    if (first.first())
      current = { bucket: first.first().bucket, filled: first.first().filled };

    for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt++) {
      const next = assignRootSlot(current, partitionSize);
      if (!current) {
        const { applied, row } = await this.store.lwt(
          'INSERT INTO post_buckets (post_id, bucket, filled) VALUES (?, ?, ?) IF NOT EXISTS',
          [postId, next.bucket, next.filled],
        );
        if (applied) return next.bucket;
        current = { bucket: row.get('bucket'), filled: row.get('filled') };
      } else {
        const { applied, row } = await this.store.lwt(
          'UPDATE post_buckets SET bucket = ?, filled = ? WHERE post_id = ? IF bucket = ? AND filled = ?',
          [next.bucket, next.filled, postId, current.bucket, current.filled],
        );
        if (applied) return next.bucket;
        current = { bucket: row.get('bucket'), filled: row.get('filled') };
      }
      await sleep(Math.floor(Math.random() * 12));
    }
    throw new Error('slot allocation did not settle');
  }

  async insert(
    row: CommentRow,
    authorId: string,
    event: RecordedEvent | null,
    day: number,
  ): Promise<void> {
    const statements: Statement[] = [
      {
        query:
          'INSERT INTO comments_by_post (post_id, bucket, path, comment_id, parent_id, author_id, body_md, body_html, html_version, created_at, deleted, shadow, depth, more_replies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, false)',
        params: [
          row.postId,
          row.bucket,
          row.path,
          row.commentId,
          row.parentId,
          authorId,
          row.bodyMd,
          row.bodyHtml,
          row.htmlVersion,
          row.createdAt,
          row.shadow,
          row.depth,
        ],
      },
      {
        query:
          'INSERT INTO comment_locator (comment_id, post_id, bucket, path, depth, author_id, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          row.commentId,
          row.postId,
          row.bucket,
          row.path,
          row.depth,
          authorId,
          row.parentId,
        ],
      },
      {
        query: 'INSERT INTO recent_posts (day, post_id) VALUES (?, ?)',
        params: [day, row.postId],
      },
    ];
    if (row.depth === 0)
      statements.push({
        query:
          'INSERT INTO top_comments_by_post (post_id, bucket, path, comment_id, shadow, deleted, author_id) VALUES (?, ?, ?, ?, ?, false, ?)',
        params: [
          row.postId,
          row.bucket,
          row.path,
          row.commentId,
          row.shadow,
          authorId,
        ],
      });
    if (event) statements.push(...eventStatements(event));
    await this.store.batch(statements);
  }

  async getLocator(commentId: string): Promise<CommentLocator | null> {
    if (!isTimeUuid(commentId)) return null; // ids are time-based: any other uuid names no comment
    const row = (
      await this.store.read(
        'SELECT * FROM comment_locator WHERE comment_id = ?',
        [commentId],
      )
    ).first();
    return row
      ? {
          commentId: row.comment_id.toString(),
          postId: row.post_id.toString(),
          bucket: row.bucket,
          path: row.path,
          depth: row.depth ?? String(row.path).split('.').length - 1,
          authorId: row.author_id?.toString() ?? null,
          parentId: row.parent_id?.toString() ?? null,
        }
      : null;
  }

  async getRow(
    postId: string,
    bucket: number,
    path: string,
  ): Promise<CommentRow | null> {
    const row = (
      await this.store.read(
        'SELECT * FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path = ?',
        [postId, bucket, path],
      )
    ).first();
    return row ? toCommentRow(row) : null;
  }

  async roots(
    postId: string,
    direction: 'asc' | 'desc',
    after: { bucket: number; path: string } | null,
    limit: number,
  ): Promise<ThreadRoot[]> {
    const top = (
      await this.store.read(
        'SELECT bucket FROM post_buckets WHERE post_id = ?',
        [postId],
      )
    ).first();
    if (!top) return [];
    const maxBucket: number = top.bucket;
    const out: ThreadRoot[] = [];
    const columns = 'bucket, path, comment_id, shadow, deleted, author_id';
    const buckets: number[] = [];
    if (direction === 'asc')
      for (let b = after?.bucket ?? 0; b <= maxBucket; b++) buckets.push(b);
    else
      for (let b = Math.min(after?.bucket ?? maxBucket, maxBucket); b >= 0; b--)
        buckets.push(b);

    for (const bucket of buckets) {
      if (out.length >= limit) break;
      const remaining = limit - out.length;
      const resume = after && after.bucket === bucket ? after.path : null;
      const cmp = direction === 'asc' ? '>' : '<';
      const order = direction === 'asc' ? 'ASC' : 'DESC';
      const result = resume
        ? await this.store.read(
            `SELECT ${columns} FROM top_comments_by_post WHERE post_id = ? AND bucket = ? AND path ${cmp} ? ORDER BY path ${order} LIMIT ?`,
            [postId, bucket, resume, remaining],
          )
        : await this.store.read(
            `SELECT ${columns} FROM top_comments_by_post WHERE post_id = ? AND bucket = ? ORDER BY path ${order} LIMIT ?`,
            [postId, bucket, remaining],
          );
      for (const r of result.rows)
        out.push({
          bucket: r.bucket,
          path: r.path,
          commentId: r.comment_id.toString(),
          shadow: r.shadow === true,
          deleted: r.deleted === true,
          authorId: r.author_id?.toString() ?? null,
        });
    }
    return out;
  }

  async subtree(
    postId: string,
    bucket: number,
    rootPath: string,
    from: string,
    inclusiveFrom: boolean,
    limit: number,
  ): Promise<CommentRow[]> {
    const op = inclusiveFrom ? '>=' : '>';
    const result = await this.store.read(
      `SELECT * FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path ${op} ? AND path < ? LIMIT ?`,
      [postId, bucket, from, `${rootPath}/`, limit],
    );
    return result.rows.map(toCommentRow);
  }

  async tombstone(
    row: CommentRow,
    by: DeletedBy,
    event: RecordedEvent | null,
  ): Promise<boolean> {
    const { applied } = await this.store.lwt(
      'UPDATE comments_by_post SET deleted = true, deleted_by = ?, body_md = null, body_html = null, author_id = null WHERE post_id = ? AND bucket = ? AND path = ? IF deleted = false',
      [by, row.postId, row.bucket, row.path],
    );
    if (!applied) return false;
    const statements: Statement[] = [
      {
        query:
          'UPDATE comment_locator SET author_id = null WHERE comment_id = ?',
        params: [row.commentId],
      },
    ];
    if (row.depth === 0)
      statements.push({
        query:
          'UPDATE top_comments_by_post SET deleted = true, author_id = null WHERE post_id = ? AND bucket = ? AND path = ?',
        params: [row.postId, row.bucket, row.path],
      });
    if (event) statements.push(...eventStatements(event));
    await this.store.batch(statements);
    return true;
  }

  async scanCounts(
    postId: string,
  ): Promise<{ visible: number; replies: Map<string, number> }> {
    const top = (
      await this.store.read(
        'SELECT bucket FROM post_buckets WHERE post_id = ?',
        [postId],
      )
    ).first();
    const replies = new Map<string, number>();
    let visible = 0;
    if (!top) return { visible, replies };
    for (let bucket = 0; bucket <= top.bucket; bucket++) {
      let pageState: string | undefined;
      do {
        const page = await this.store.read(
          'SELECT parent_id, deleted, shadow FROM comments_by_post WHERE post_id = ? AND bucket = ?',
          [postId, bucket],
          { fetchSize: 2_000, pageState },
        );
        for (const r of page.rows) {
          if (r.deleted === true || r.shadow === true) continue;
          visible++;
          const parent = r.parent_id?.toString();
          if (parent) replies.set(parent, (replies.get(parent) ?? 0) + 1);
        }
        pageState = page.pageState ?? undefined;
      } while (pageState);
    }
    return { visible, replies };
  }

  async markMoreReplies(
    postId: string,
    bucket: number,
    rootPath: string,
  ): Promise<void> {
    await this.store.write(
      'UPDATE comments_by_post SET more_replies = true WHERE post_id = ? AND bucket = ? AND path = ?',
      [postId, bucket, rootPath],
    );
  }

  async setRendition(
    row: Pick<CommentRow, 'postId' | 'bucket' | 'path'>,
    html: string,
    version: number,
  ): Promise<void> {
    await this.store.lwt(
      'UPDATE comments_by_post SET body_html = ?, html_version = ? WHERE post_id = ? AND bucket = ? AND path = ? IF deleted = false',
      [html, version, row.postId, row.bucket, row.path],
    );
  }
}
