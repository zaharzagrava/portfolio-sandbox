import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { mapWithConcurrency } from '@app/common/core/promise-pool';
import {
  FOLLOW_GRAPH_STORE,
  LEGACY_KEY_CLEANER,
  type FollowGraphStore,
  type LegacyKeyCleaner,
} from '../domain/ports';

export type ReconcilePhase = 'users' | 'indexed' | 'accounts' | 'counters';

/** Where a partial run stopped; pass it back to continue (the scans are token-ordered, so a resume skips nothing). */
export interface ReconcileCursor {
  phase: ReconcilePhase;
  after: string | null;
}

export interface ReconcileOptions {
  /** Records younger than this are left to the request that may still be writing them. Default 60 s. */
  graceMs?: number;
  /** Pause between pages so the scan never competes with traffic. Default 25 ms. */
  paceMs?: number;
  pageSize?: number;
  /** Stop after this many pages and hand back the cursor. */
  maxPages?: number;
  resume?: ReconcileCursor | null;
}

export interface ReconcileResult {
  finished: boolean;
  cursor: ReconcileCursor | null;
  /** Rows, counters and reservations that were wrong and are now right. */
  repaired: number;
  users: number;
  accounts: number;
  /** Subjects whose repair failed; they are retried by the next run. */
  failed: number;
}

const PHASES: ReconcilePhase[] = ['users', 'indexed', 'accounts', 'counters'];
const CONCURRENCY = 8;

const legacyUserKeys = (userId: string) => [
  `tl:{${userId}}`,
  `active:{${userId}}`,
  `following:{${userId}}`,
];
const legacyAccountKeys = (accountId: string) => [
  `followers:{${accountId}}`,
  `celeb:{${accountId}}:recent`,
];

/**
 * The daily reconciliation of the follow graph (A7, FR-009, AS-51): the buyer-side relation is the truth. Per buyer it
 * completes or removes the derived rows of each relation and recomputes the reservation counter; per account it removes
 * follower records no buyer-side relation backs and recomputes the follower counter. Paged, resumable and paced;
 * idempotent (a second run changes nothing). On the first complete run it also removes the previous implementation's
 * unprefixed Redis keys, by explicit name for each buyer and account it visits.
 */
@Injectable()
export class FeedReconcileService {
  private readonly logger = new Logger(FeedReconcileService.name);

  constructor(
    @Inject(FOLLOW_GRAPH_STORE) private readonly graph: FollowGraphStore,
    @Inject(LEGACY_KEY_CLEANER) private readonly legacy: LegacyKeyCleaner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const graceMs = options.graceMs ?? 60_000;
    const paceMs = options.paceMs ?? 25;
    const pageSize = options.pageSize ?? 500;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const result: ReconcileResult = {
      finished: false,
      cursor: null,
      repaired: 0,
      users: 0,
      accounts: 0,
      failed: 0,
    };
    const cleanLegacy = await this.legacyPending();

    let pages = 0;
    let position: ReconcileCursor = options.resume ?? {
      phase: 'users',
      after: null,
    };
    while (true) {
      if (pages >= maxPages) {
        result.cursor = position;
        return result;
      }
      pages++;
      const { phase, after } = position;
      const page =
        phase === 'users'
          ? await this.graph.scanUsers(after, pageSize)
          : phase === 'indexed'
            ? await this.graph.scanOrphanedIndexUsers(after, pageSize)
            : phase === 'accounts'
              ? await this.graph.scanFollowedAccounts(after, pageSize)
              : await this.graph.scanCounters(after, pageSize);
      const now = this.clock.now();
      const buyers = phase === 'users' || phase === 'indexed';

      await mapWithConcurrency(page.ids, CONCURRENCY, async (id) => {
        try {
          if (buyers) {
            result.users++;
            result.repaired += await this.graph.repairUser(id, now, graceMs);
          } else {
            // counters with no follower records left are the only ones the account scan did not visit
            if (
              phase === 'counters' &&
              (await this.graph.hasFollowerRecords(id))
            )
              return;
            result.accounts++;
            result.repaired += await this.graph.repairAccount(id, now, graceMs);
          }
        } catch (error) {
          result.failed++;
          this.logger.warn(
            `reconcile of one ${buyers ? 'buyer' : 'account'} failed cause=${(error as Error).name}`,
          );
        }
      });
      if (cleanLegacy && phase !== 'counters')
        await this.unlinkLegacy(
          buyers
            ? page.ids.flatMap(legacyUserKeys)
            : page.ids.flatMap(legacyAccountKeys),
        );

      if (page.next) position = { phase, after: page.next };
      else {
        const nextPhase = PHASES[PHASES.indexOf(phase) + 1];
        if (!nextPhase) break;
        position = { phase: nextPhase, after: null };
      }
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    }

    result.finished = true;
    if (cleanLegacy && result.failed === 0) await this.finishLegacy();
    return result;
  }

  private async legacyPending(): Promise<boolean> {
    try {
      return !(await this.legacy.isDone());
    } catch {
      return false; // Redis is a cache here: the cleanup waits for the next run
    }
  }

  private async unlinkLegacy(keys: string[]): Promise<void> {
    try {
      await this.legacy.unlink([...keys, 'feed:celebrities']);
    } catch (error) {
      this.logger.warn(
        `legacy key removal failed cause=${(error as Error).name}`,
      );
    }
  }

  private async finishLegacy(): Promise<void> {
    try {
      await this.legacy.markDone();
    } catch (error) {
      this.logger.warn(`legacy marker not set cause=${(error as Error).name}`);
    }
  }
}
