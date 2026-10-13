import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import type { CountStore } from '../domain/ports';
import type { VoteCounts } from '../domain/vote-transition';
import { ScyllaStore } from './scylla-store';

const long = (n: number) => types.Long.fromNumber(n);

/** Durable derived counters and reconciliation worklists (S25 B6, C4, FR-016, FR-024). */
@Injectable()
export class ScyllaCountStore implements CountStore {
  constructor(private readonly store: ScyllaStore) {}

  async postComments(postId: string): Promise<number> {
    const row = (
      await this.store.read(
        'SELECT visible FROM post_comment_counts WHERE post_id = ?',
        [postId],
      )
    ).first();
    return Math.max(0, row ? Number(row.visible) : 0);
  }

  async replyCounts(commentIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (commentIds.length === 0) return out;
    const result = await this.store.read(
      'SELECT comment_id, visible FROM comment_reply_counts WHERE comment_id IN ?',
      [commentIds],
    );
    for (const row of result.rows)
      out.set(row.comment_id.toString(), Math.max(0, Number(row.visible)));
    return out;
  }

  async adjustPostComments(postId: string, by: number): Promise<void> {
    await this.store.counter(
      'UPDATE post_comment_counts SET visible = visible + ? WHERE post_id = ?',
      [long(by), postId],
    );
  }

  async adjustReplies(commentId: string, by: number): Promise<void> {
    await this.store.counter(
      'UPDATE comment_reply_counts SET visible = visible + ? WHERE comment_id = ?',
      [long(by), commentId],
    );
  }

  async voteTotals(targetId: string): Promise<VoteCounts> {
    const row = (
      await this.store.read(
        'SELECT ups, downs, wups, wdowns FROM vote_counts WHERE target_id = ?',
        [targetId],
      )
    ).first();
    const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    return {
      ups: n(row?.ups),
      downs: n(row?.downs),
      wups: n(row?.wups),
      wdowns: n(row?.wdowns),
    };
  }

  async addVoteDeltas(
    targetId: string,
    d: { ups: number; downs: number; wups: number; wdowns: number },
  ): Promise<void> {
    await this.store.counter(
      'UPDATE vote_counts SET ups = ups + ?, downs = downs + ?, wups = wups + ?, wdowns = wdowns + ? WHERE target_id = ?',
      [long(d.ups), long(d.downs), long(d.wups), long(d.wdowns), targetId],
    );
  }

  async markVoted(targetId: string, day: number): Promise<void> {
    await this.store.write(
      'INSERT INTO recent_targets (day, target_id) VALUES (?, ?)',
      [day, targetId],
    );
  }

  async votedTargets(day: number, limit: number): Promise<string[]> {
    const result = await this.store.read(
      'SELECT target_id FROM recent_targets WHERE day = ? LIMIT ?',
      [day, limit],
    );
    return result.rows.map((r) => r.target_id.toString());
  }

  async commentedPosts(day: number, limit: number): Promise<string[]> {
    const result = await this.store.read(
      'SELECT post_id FROM recent_posts WHERE day = ? LIMIT ?',
      [day, limit],
    );
    return result.rows.map((r) => r.post_id.toString());
  }
}
