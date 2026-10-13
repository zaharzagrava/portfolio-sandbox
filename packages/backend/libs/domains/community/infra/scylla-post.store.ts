import { Injectable } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import type {
  BoardListEntry,
  DeletedBy,
  PostRow,
  PostStore,
  RecordedEvent,
} from '../domain/ports';
import { isTimeUuid } from '../domain/ids';
import { monthBucketOf } from '../domain/months';
import { eventStatements } from './event-rows';
import { ScyllaStore, type Statement } from './scylla-store';

export function toPostRow(row: types.Row): PostRow {
  return {
    postId: row.post_id.toString(),
    boardId: row.board_id,
    authorId: row.author_id.toString(),
    title: row.title,
    bodyMd: row.body_md ?? null,
    bodyHtml: row.body_html ?? null,
    htmlVersion: row.html_version ?? null,
    createdAt: row.created_at,
    deleted: row.deleted === true,
    deletedBy: (row.deleted_by as DeletedBy | null) ?? null,
    shadow: row.shadow === true,
  };
}

/** `posts`, `posts_by_board` and `board_months`: the durable side of boards and posts (S25 A3, A4, D5). */
@Injectable()
export class ScyllaPostStore implements PostStore {
  constructor(private readonly store: ScyllaStore) {}

  async insert(row: PostRow, event: RecordedEvent | null): Promise<void> {
    const statements: Statement[] = [
      {
        query:
          'INSERT INTO posts (post_id, board_id, author_id, title, body_md, body_html, html_version, created_at, deleted, shadow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, false, ?)',
        params: [
          row.postId,
          row.boardId,
          row.authorId,
          row.title,
          row.bodyMd,
          row.bodyHtml,
          row.htmlVersion,
          row.createdAt,
          row.shadow,
        ],
      },
      {
        query:
          'INSERT INTO posts_by_board (board_id, bucket, post_id, author_id, title, shadow, deleted) VALUES (?, ?, ?, ?, ?, ?, false)',
        params: [
          row.boardId,
          monthBucketOf(row.createdAt),
          row.postId,
          row.authorId,
          row.title,
          row.shadow,
        ],
      },
      {
        query: 'INSERT INTO board_months (board_id, bucket) VALUES (?, ?)',
        params: [row.boardId, monthBucketOf(row.createdAt)],
      },
      ...(event ? eventStatements(event) : []),
    ];
    await this.store.batch(statements);
  }

  async get(postId: string): Promise<PostRow | null> {
    if (!isTimeUuid(postId)) return null; // ids are time-based: any other uuid names no post
    const result = await this.store.read(
      'SELECT * FROM posts WHERE post_id = ?',
      [postId],
    );
    const row = result.first();
    return row ? toPostRow(row) : null;
  }

  async getMany(postIds: string[]): Promise<PostRow[]> {
    const valid = postIds.filter(isTimeUuid);
    if (valid.length === 0) return [];
    const result = await this.store.read(
      'SELECT * FROM posts WHERE post_id IN ?',
      [valid],
    );
    return result.rows.map(toPostRow);
  }

  async tombstone(
    row: PostRow,
    by: DeletedBy,
    event: RecordedEvent | null,
  ): Promise<boolean> {
    const { applied } = await this.store.lwt(
      'UPDATE posts SET deleted = true, deleted_by = ?, body_md = null, body_html = null WHERE post_id = ? IF deleted = false',
      [by, row.postId],
    );
    if (!applied) return false;
    await this.store.batch([
      {
        query:
          'UPDATE posts_by_board SET deleted = true WHERE board_id = ? AND bucket = ? AND post_id = ?',
        params: [row.boardId, monthBucketOf(row.createdAt), row.postId],
      },
      ...(event ? eventStatements(event) : []),
    ]);
    return true;
  }

  async setRendition(
    postId: string,
    html: string,
    version: number,
  ): Promise<void> {
    await this.store.lwt(
      'UPDATE posts SET body_html = ?, html_version = ? WHERE post_id = ? IF deleted = false',
      [html, version, postId],
    );
  }

  async months(
    boardId: string,
    fromBucket: number | null,
    limit: number,
  ): Promise<number[]> {
    const result =
      fromBucket === null
        ? await this.store.read(
            'SELECT bucket FROM board_months WHERE board_id = ? LIMIT ?',
            [boardId, limit],
          )
        : await this.store.read(
            'SELECT bucket FROM board_months WHERE board_id = ? AND bucket <= ? LIMIT ?',
            [boardId, fromBucket, limit],
          );
    return result.rows.map((r) => r.bucket as number);
  }

  async monthPage(
    boardId: string,
    bucket: number,
    beforePostId: string | null,
    limit: number,
  ): Promise<BoardListEntry[]> {
    const columns = 'post_id, author_id, shadow, deleted';
    const result =
      beforePostId === null
        ? await this.store.read(
            `SELECT ${columns} FROM posts_by_board WHERE board_id = ? AND bucket = ? LIMIT ?`,
            [boardId, bucket, limit],
          )
        : await this.store.read(
            `SELECT ${columns} FROM posts_by_board WHERE board_id = ? AND bucket = ? AND post_id < ? LIMIT ?`,
            [boardId, bucket, beforePostId, limit],
          );
    return result.rows.map((r) => ({
      postId: r.post_id.toString(),
      authorId: r.author_id?.toString() ?? null,
      shadow: r.shadow === true,
      deleted: r.deleted === true,
    }));
  }
}
