import { Injectable, Logger } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import { feedUnavailable } from '../domain/feed-errors';
import type {
  FollowEdge,
  FollowGraphStore,
  FollowOutcome,
  FollowStatusEntry,
  ScanPage,
  UnfollowOutcome,
} from '../domain/ports';
import { FeedScylla, long } from './feed-scylla';

/** Compare-and-set attempts for a contended row (each attempt that loses means another request made progress). */
const MAX_ATTEMPTS = 40;
/** Rows per `IN` lookup. */
const IN_CHUNK = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = () => sleep(2 + Math.floor(Math.random() * 14));
const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
const num = (v: types.Long | number | null | undefined): number | null =>
  v === null || v === undefined
    ? null
    : typeof v === 'number'
      ? v
      : v.toNumber();

interface Relation {
  active: boolean;
  /** `null` for a legacy row written before sequences existed. */
  relTs: number | null;
  followedAt: Date;
}

/**
 * The follow graph on ScyllaDB (S26 R-1, R-2, A2-A4). `following_by_user` is the truth of a relation: one conditional
 * write (LWT) on that row decides every transition and carries a per-relation sequence `rel_ts` that rises by at least
 * one per transition. The other side (`followers_by_account`), the newest-first list (`following_by_time`) and the
 * counters are written only by the request whose conditional write applied; the two rows are written
 * `USING TIMESTAMP rel_ts`, so last-write-wins converges both directions to the transition with the highest sequence in
 * whatever order the writes land. The following limit is a reservation on `following_counts` (compare-and-set), taken
 * before the relation write and released when that write loses. This is the only class that writes
 * `followers_by_account` and `following_by_time`.
 */
@Injectable()
export class ScyllaFollowStore implements FollowGraphStore {
  private readonly logger = new Logger(ScyllaFollowStore.name);

  constructor(private readonly db: FeedScylla) {}

  // ---- transitions ----------------------------------------------------------------------------------------------

  async follow(
    userId: string,
    accountId: string,
    limit: number,
    at: Date,
  ): Promise<FollowOutcome> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt) await jitter();
      const current = await this.relation(userId, accountId);
      if (current?.active) return 'already_following';

      const reserved = await this.reserve(userId, limit);
      if (reserved === 'full') return 'limit_reached';
      if (reserved === 'contended') continue;

      const relTs = Math.max(at.getTime() * 1000, (current?.relTs ?? 0) + 1);
      const { applied } = current
        ? await this.db.lwt(
            'UPDATE following_by_user SET active = true, followed_at = ?, rel_ts = ? WHERE user_id = ? AND account_id = ? IF rel_ts = ?',
            [at, long(relTs), userId, accountId, long(current.relTs ?? 0)],
          )
        : await this.db.lwt(
            'INSERT INTO following_by_user (user_id, account_id, followed_at, active, rel_ts) VALUES (?, ?, ?, true, ?) IF NOT EXISTS',
            [userId, accountId, at, long(relTs)],
          );
      if (!applied) {
        await this.release(userId);
        continue;
      }
      await Promise.all([
        this.db.write(
          'INSERT INTO followers_by_account (account_id, follower_id, followed_at) VALUES (?, ?, ?) USING TIMESTAMP ?',
          [accountId, userId, at, long(relTs)],
        ),
        this.db.write(
          'INSERT INTO following_by_time (user_id, followed_at, account_id) VALUES (?, ?, ?) USING TIMESTAMP ?',
          [userId, at, accountId, long(relTs)],
        ),
        this.db.counter(
          'UPDATE follower_counts SET followers = followers + ? WHERE account_id = ?',
          [long(1), accountId],
        ),
      ]);
      return 'followed';
    }
    throw feedUnavailable();
  }

  async unfollow(
    userId: string,
    accountId: string,
    at: Date,
  ): Promise<UnfollowOutcome> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt) await jitter();
      const current = await this.relation(userId, accountId);
      if (!current?.active) return 'not_following';

      const relTs = Math.max(at.getTime() * 1000, (current.relTs ?? 0) + 1);
      const { applied } =
        current.relTs === null
          ? await this.db.lwt(
              'UPDATE following_by_user SET active = false, rel_ts = ? WHERE user_id = ? AND account_id = ? IF rel_ts = null',
              [long(relTs), userId, accountId],
            )
          : await this.db.lwt(
              'UPDATE following_by_user SET active = false, rel_ts = ? WHERE user_id = ? AND account_id = ? IF rel_ts = ? AND active = true',
              [long(relTs), userId, accountId, long(current.relTs)],
            );
      if (!applied) continue;

      await Promise.all([
        this.db.write(
          'DELETE FROM followers_by_account USING TIMESTAMP ? WHERE account_id = ? AND follower_id = ?',
          [long(relTs), accountId, userId],
        ),
        this.db.write(
          'DELETE FROM following_by_time USING TIMESTAMP ? WHERE user_id = ? AND followed_at = ? AND account_id = ?',
          [long(relTs), userId, current.followedAt, accountId],
        ),
        this.db.counter(
          'UPDATE follower_counts SET followers = followers - ? WHERE account_id = ?',
          [long(1), accountId],
        ),
      ]);
      await this.release(userId);
      return 'unfollowed';
    }
    throw feedUnavailable();
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  async list(
    userId: string,
    after: { followedAtMs: number; accountId: string } | null,
    limit: number,
  ): Promise<FollowEdge[]> {
    const edges: FollowEdge[] = [];
    const take = (rows: types.Row[]) =>
      rows.forEach((r) =>
        edges.push({ accountId: r.account_id, followedAt: r.followed_at }),
      );
    if (after) {
      // same timestamp: the clustering order of account_id is ascending
      const same = await this.db.read(
        'SELECT account_id, followed_at FROM following_by_time WHERE user_id = ? AND followed_at = ? AND account_id > ? LIMIT ?',
        [userId, new Date(after.followedAtMs), after.accountId, limit],
      );
      take(same.rows);
      if (edges.length < limit) {
        const older = await this.db.read(
          'SELECT account_id, followed_at FROM following_by_time WHERE user_id = ? AND followed_at < ? LIMIT ?',
          [userId, new Date(after.followedAtMs), limit - edges.length],
        );
        take(older.rows);
      }
    } else {
      take(
        (
          await this.db.read(
            'SELECT account_id, followed_at FROM following_by_time WHERE user_id = ? LIMIT ?',
            [userId, limit],
          )
        ).rows,
      );
    }
    return edges;
  }

  async allFollowing(userId: string): Promise<string[]> {
    const rows = await this.db.readAll(
      'SELECT account_id, active FROM following_by_user WHERE user_id = ?',
      [userId],
      5_000,
    );
    return rows.filter((r) => r.active !== false).map((r) => r.account_id);
  }

  async status(
    userId: string,
    accountIds: string[],
  ): Promise<FollowStatusEntry[]> {
    if (!accountIds.length) return [];
    const following = new Set<string>();
    const counts = new Map<string, number>();
    for (const part of chunks(accountIds, IN_CHUNK)) {
      const [relations, counters] = await Promise.all([
        this.db.read(
          'SELECT account_id, active FROM following_by_user WHERE user_id = ? AND account_id IN ?',
          [userId, part],
        ),
        this.db.read(
          'SELECT account_id, followers FROM follower_counts WHERE account_id IN ?',
          [part],
        ),
      ]);
      for (const r of relations.rows)
        if (r.active !== false) following.add(r.account_id);
      for (const r of counters.rows)
        counts.set(r.account_id, Math.max(0, num(r.followers) ?? 0));
    }
    return accountIds.map((accountId) => ({
      accountId,
      following: following.has(accountId),
      followerCount: counts.get(accountId) ?? 0,
    }));
  }

  async followerCount(accountId: string): Promise<number> {
    return Math.max(0, (await this.storedCount(accountId)) ?? 0);
  }

  async followerIds(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const result = after
      ? await this.db.read(
          'SELECT follower_id FROM followers_by_account WHERE account_id = ? AND follower_id > ? LIMIT ?',
          [accountId, after, limit],
        )
      : await this.db.read(
          'SELECT follower_id FROM followers_by_account WHERE account_id = ? LIMIT ?',
          [accountId, limit],
        );
    return result.rows.map((r) => r.follower_id.toString());
  }

  // ---- reconciliation -------------------------------------------------------------------------------------------

  async scanUsers(after: string | null, size: number): Promise<ScanPage> {
    const page = await this.db.page(
      'SELECT DISTINCT user_id FROM following_by_user',
      [],
      size,
      after,
    );
    return { ids: page.rows.map((r) => r.user_id.toString()), next: page.next };
  }

  async scanOrphanedIndexUsers(
    after: string | null,
    size: number,
  ): Promise<ScanPage> {
    const page = await this.db.page(
      'SELECT DISTINCT user_id FROM following_by_time',
      [],
      size,
      after,
    );
    const orphaned: string[] = [];
    for (const row of page.rows) {
      const hasRelation = await this.db.read(
        'SELECT account_id FROM following_by_user WHERE user_id = ? LIMIT 1',
        [row.user_id],
      );
      if (!hasRelation.rows.length) orphaned.push(row.user_id.toString());
    }
    return { ids: orphaned, next: page.next };
  }

  async scanFollowedAccounts(
    after: string | null,
    size: number,
  ): Promise<ScanPage> {
    const page = await this.db.page(
      'SELECT DISTINCT account_id FROM followers_by_account',
      [],
      size,
      after,
    );
    return { ids: page.rows.map((r) => r.account_id), next: page.next };
  }

  async scanCounters(after: string | null, size: number): Promise<ScanPage> {
    const page = await this.db.page(
      'SELECT account_id, followers FROM follower_counts',
      [],
      size,
      after,
    );
    return {
      ids: page.rows
        .filter((r) => (num(r.followers) ?? 0) !== 0)
        .map((r) => r.account_id),
      next: page.next,
    };
  }

  async hasFollowerRecords(accountId: string): Promise<boolean> {
    const result = await this.db.read(
      'SELECT follower_id FROM followers_by_account WHERE account_id = ? LIMIT 1',
      [accountId],
    );
    return result.rows.length > 0;
  }

  async repairUser(
    userId: string,
    now: Date,
    graceMs: number,
  ): Promise<number> {
    const [buyer, index] = await Promise.all([
      this.db.readAll(
        'SELECT account_id, active, followed_at, rel_ts, WRITETIME(followed_at) AS wt FROM following_by_user WHERE user_id = ?',
        [userId],
      ),
      this.db.readAll(
        'SELECT followed_at, account_id FROM following_by_time WHERE user_id = ?',
        [userId],
      ),
    ]);
    const haveFollowerRow = new Set<string>();
    for (const part of chunks(
      buyer.map((b) => b.account_id as string),
      IN_CHUNK,
    )) {
      const rows = await this.db.read(
        'SELECT account_id FROM followers_by_account WHERE account_id IN ? AND follower_id = ?',
        [part, userId],
      );
      rows.rows.forEach((r) => haveFollowerRow.add(r.account_id));
    }

    const indexed = new Set(
      index.map((r) => `${r.account_id}|${(r.followed_at as Date).getTime()}`),
    );
    const handled = new Set<string>();
    const writes: Array<Promise<unknown>> = [];
    let repaired = 0;
    let activeCount = 0;

    for (const b of buyer) {
      const accountId: string = b.account_id;
      const followedAt: Date = b.followed_at;
      const key = `${accountId}|${followedAt.getTime()}`;
      const ts = long(num(b.rel_ts) ?? num(b.wt) ?? now.getTime() * 1000);
      if (b.active !== false) {
        activeCount++;
        handled.add(key);
        if (!haveFollowerRow.has(accountId)) {
          repaired++;
          writes.push(
            this.db.write(
              'INSERT INTO followers_by_account (account_id, follower_id, followed_at) VALUES (?, ?, ?) USING TIMESTAMP ?',
              [accountId, userId, followedAt, ts],
            ),
          );
        }
        if (!indexed.has(key)) {
          repaired++;
          writes.push(
            this.db.write(
              'INSERT INTO following_by_time (user_id, followed_at, account_id) VALUES (?, ?, ?) USING TIMESTAMP ?',
              [userId, followedAt, accountId, ts],
            ),
          );
        }
      } else {
        if (haveFollowerRow.has(accountId)) {
          repaired++;
          writes.push(
            this.db.write(
              'DELETE FROM followers_by_account USING TIMESTAMP ? WHERE account_id = ? AND follower_id = ?',
              [ts, accountId, userId],
            ),
          );
        }
        if (indexed.has(key)) {
          handled.add(key);
          repaired++;
          writes.push(
            this.db.write(
              'DELETE FROM following_by_time USING TIMESTAMP ? WHERE user_id = ? AND followed_at = ? AND account_id = ?',
              [ts, userId, followedAt, accountId],
            ),
          );
        }
      }
    }

    // index entries no relation row accounts for (a crashed unfollow, a stale re-follow position)
    const cutoff = now.getTime() - graceMs;
    for (const r of index) {
      const followedAt: Date = r.followed_at;
      const key = `${r.account_id}|${followedAt.getTime()}`;
      if (handled.has(key) || followedAt.getTime() > cutoff) continue;
      repaired++;
      writes.push(
        this.db.write(
          'DELETE FROM following_by_time WHERE user_id = ? AND followed_at = ? AND account_id = ?',
          [userId, followedAt, r.account_id],
        ),
      );
    }
    await Promise.all(writes);

    if (await this.settleReservation(userId, activeCount)) repaired++;
    return repaired;
  }

  async repairAccount(
    accountId: string,
    now: Date,
    graceMs: number,
  ): Promise<number> {
    const cutoff = now.getTime() - graceMs;
    let kept = 0;
    let repaired = 0;
    let after: string | null = null;
    do {
      const page = await this.db.page(
        'SELECT follower_id, followed_at FROM followers_by_account WHERE account_id = ?',
        [accountId],
        1_000,
        after,
      );
      after = page.next;
      const buyers = new Map<
        string,
        { active: boolean; relTs: number | null }
      >();
      for (const part of chunks(
        page.rows.map((r) => r.follower_id.toString() as string),
        IN_CHUNK,
      )) {
        const rows = await this.db.read(
          'SELECT user_id, active, rel_ts FROM following_by_user WHERE user_id IN ? AND account_id = ?',
          [part, accountId],
        );
        rows.rows.forEach((r) =>
          buyers.set(r.user_id.toString(), {
            active: r.active !== false,
            relTs: num(r.rel_ts),
          }),
        );
      }
      const deletes: Array<Promise<unknown>> = [];
      for (const row of page.rows) {
        const followerId: string = row.follower_id.toString();
        const buyer = buyers.get(followerId);
        if (buyer?.active || (row.followed_at as Date).getTime() > cutoff) {
          kept++;
          continue;
        }
        repaired++;
        deletes.push(
          buyer?.relTs
            ? this.db.write(
                'DELETE FROM followers_by_account USING TIMESTAMP ? WHERE account_id = ? AND follower_id = ?',
                [long(buyer.relTs), accountId, followerId],
              )
            : this.db.write(
                'DELETE FROM followers_by_account WHERE account_id = ? AND follower_id = ?',
                [accountId, followerId],
              ),
        );
      }
      await Promise.all(deletes);
    } while (after);

    const stored = (await this.storedCount(accountId)) ?? 0;
    if (stored !== kept) {
      repaired++;
      await this.db.counter(
        'UPDATE follower_counts SET followers = followers + ? WHERE account_id = ?',
        [long(kept - stored), accountId],
      );
    }
    return repaired;
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  private async relation(
    userId: string,
    accountId: string,
  ): Promise<Relation | null> {
    const row = (
      await this.db.read(
        'SELECT active, rel_ts, followed_at FROM following_by_user WHERE user_id = ? AND account_id = ?',
        [userId, accountId],
      )
    ).first();
    return row
      ? {
          active: row.active !== false,
          relTs: num(row.rel_ts),
          followedAt: row.followed_at,
        }
      : null;
  }

  private async storedCount(accountId: string): Promise<number | null> {
    const row = (
      await this.db.read(
        'SELECT followers FROM follower_counts WHERE account_id = ?',
        [accountId],
      )
    ).first();
    return row ? num(row.followers) : null;
  }

  private async reservation(userId: string): Promise<number | null> {
    const row = (
      await this.db.read('SELECT n FROM following_counts WHERE user_id = ?', [
        userId,
      ])
    ).first();
    return row && row.n !== null ? Number(row.n) : null;
  }

  /** Reserves one slot of the following limit (compare-and-set on the counter). */
  private async reserve(
    userId: string,
    limit: number,
  ): Promise<'reserved' | 'full' | 'contended'> {
    const n = await this.reservation(userId);
    if ((n ?? 0) >= limit) return 'full';
    const { applied } =
      n === null
        ? await this.db.lwt(
            'INSERT INTO following_counts (user_id, n) VALUES (?, 1) IF NOT EXISTS',
            [userId],
          )
        : await this.db.lwt(
            'UPDATE following_counts SET n = ? WHERE user_id = ? IF n = ?',
            [n + 1, userId, n],
          );
    return applied ? 'reserved' : 'contended';
  }

  /** Gives a slot back; a failure leaves the counter one too high, the safe direction (reconciliation fixes it). */
  private async release(userId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt) await jitter();
      const n = await this.reservation(userId);
      if (n === null || n <= 0) return;
      const { applied } = await this.db.lwt(
        'UPDATE following_counts SET n = ? WHERE user_id = ? IF n = ?',
        [n - 1, userId, n],
      );
      if (applied) return;
    }
    this.logger.warn('following reservation not released; reconciliation will');
  }

  /** Sets the reservation counter to the number of active relations; one attempt, the next run retries. */
  private async settleReservation(
    userId: string,
    active: number,
  ): Promise<boolean> {
    const n = await this.reservation(userId);
    if ((n ?? 0) === active) return false;
    const { applied } =
      n === null
        ? await this.db.lwt(
            'INSERT INTO following_counts (user_id, n) VALUES (?, ?) IF NOT EXISTS',
            [userId, active],
          )
        : await this.db.lwt(
            'UPDATE following_counts SET n = ? WHERE user_id = ? IF n = ?',
            [active, userId, n],
          );
    return applied;
  }
}
