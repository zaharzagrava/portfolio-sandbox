import { Injectable } from '@nestjs/common';
import type { TargetType, VoteState, VoteStore } from '../domain/ports';
import type { VoteCounts, VoteRecord } from '../domain/vote-transition';
import { ScyllaStore } from './scylla-store';

const PAGE = 5_000;

/**
 * `votes_by_target`: the vote truth (S25 C3, R-1). One row per (target, user); every change is a compare-and-set on
 * `(version, cast_at)`, so uniqueness and "previous value" come from the store, never from a lock.
 */
@Injectable()
export class ScyllaVoteStore implements VoteStore {
  constructor(private readonly store: ScyllaStore) {}

  async get(targetId: string, userId: string): Promise<VoteState | null> {
    const row = (
      await this.store.read(
        'SELECT value, weight, version, cast_at FROM votes_by_target WHERE target_id = ? AND user_id = ?',
        [targetId, userId],
      )
    ).first();
    if (!row) return null;
    return {
      value: row.value === 1 ? 1 : -1,
      weight: row.weight === 0 ? 0 : 1, // legacy rows (null) counted as 1
      version: row.version ?? null,
      castAt: row.cast_at ?? null,
    };
  }

  async cas(
    targetId: string,
    userId: string,
    targetType: TargetType,
    expected: VoteState | null,
    next: VoteRecord | null,
    castAt: Date,
  ): Promise<boolean> {
    if (expected === null) {
      if (next === null) return true;
      const { applied } = await this.store.lwt(
        'INSERT INTO votes_by_target (target_id, user_id, value, weight, cast_at, version, target_type) VALUES (?, ?, ?, ?, ?, 0, ?) IF NOT EXISTS',
        [targetId, userId, next.value, next.weight, castAt, targetType],
      );
      return applied;
    }
    if (next === null) {
      const { applied } = await this.store.lwt(
        'DELETE FROM votes_by_target WHERE target_id = ? AND user_id = ? IF version = ? AND cast_at = ?',
        [targetId, userId, expected.version, expected.castAt],
      );
      return applied;
    }
    const { applied } = await this.store.lwt(
      'UPDATE votes_by_target SET value = ?, weight = ?, cast_at = ?, version = ?, target_type = ? WHERE target_id = ? AND user_id = ? IF version = ? AND cast_at = ?',
      [
        next.value,
        next.weight,
        castAt,
        (expected.version ?? 0) + 1,
        targetType,
        targetId,
        userId,
        expected.version,
        expected.castAt,
      ],
    );
    return applied;
  }

  async recount(targetId: string): Promise<VoteCounts> {
    const counts: VoteCounts = { ups: 0, downs: 0, wups: 0, wdowns: 0 };
    let pageState: string | undefined;
    do {
      const page = await this.store.read(
        'SELECT value, weight FROM votes_by_target WHERE target_id = ?',
        [targetId],
        { fetchSize: PAGE, pageState },
      );
      for (const row of page.rows) {
        const weight = row.weight === 0 ? 0 : 1;
        if (row.value === 1) {
          counts.ups++;
          counts.wups += weight;
        } else {
          counts.downs++;
          counts.wdowns += weight;
        }
      }
      pageState = page.pageState ?? undefined;
    } while (pageState);
    return counts;
  }

  async viewerVotes(
    targetIds: string[],
    userId: string,
  ): Promise<Map<string, 1 | -1>> {
    const out = new Map<string, 1 | -1>();
    if (targetIds.length === 0) return out;
    const result = await this.store.read(
      'SELECT target_id, value FROM votes_by_target WHERE target_id IN ? AND user_id = ?',
      [targetIds, userId],
    );
    for (const row of result.rows)
      out.set(row.target_id.toString(), row.value === 1 ? 1 : -1);
    return out;
  }
}
