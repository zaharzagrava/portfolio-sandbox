import { Inject, Injectable } from '@nestjs/common';
import type {
  Flag,
  FlagAuditPage,
  FlagPage,
  StaleFlags,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { decodeCursor, encodeCursor } from '../domain/flag-cursor';
import { flagNotFound } from '../domain/flag-errors';
import type { FlagStatus } from '../domain/flag-types';
import {
  EVAL_COUNTER_STORE,
  FLAG_REPOSITORY,
  type EvalCounterStore,
  type FlagRepository,
} from '../domain/ports';
import { toFlagView } from './flag-view';

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const STALE_DEFAULT_DAYS = 14;
export const STALE_MAX_DAYS = 30;
const DAY_MS = 86_400_000;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The admin's reads: list, one flag, history and the stale report (FR-015, FR-051, FR-053). */
@Injectable()
export class FlagQueryService {
  constructor(
    @Inject(FLAG_REPOSITORY) private readonly flags: FlagRepository,
    @Inject(EVAL_COUNTER_STORE) private readonly counters: EvalCounterStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string;
    status?: FlagStatus;
    includeArchived: boolean;
  }): Promise<FlagPage> {
    const secret = this.config.get('jwt_secret');
    const afterKey = query.cursor
      ? decodeCursor(secret, 'flags', query.cursor, ['k']).k
      : undefined;
    const rows = await this.flags.list({
      limit: query.limit + 1,
      afterKey,
      status: query.status,
      includeArchived: query.includeArchived,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toFlagView),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(secret, 'flags', { k: last.key })
          : null,
    };
  }

  async get(key: string): Promise<Flag> {
    const flag = await this.flags.find(key);
    if (!flag) throw flagNotFound();
    return toFlagView(flag);
  }

  async history(
    key: string,
    query: { limit: number; cursor?: string },
  ): Promise<FlagAuditPage> {
    const secret = this.config.get('jwt_secret');
    const scope = `history:${key}`;
    const after = query.cursor
      ? decodeCursor(secret, scope, query.cursor, ['at', 'id'])
      : undefined;
    if (!(await this.flags.find(key)) && !(await this.flags.hasHistory(key)))
      throw flagNotFound();
    const rows = await this.flags.history(
      key,
      query.limit + 1,
      after as { at: string; id: string } | undefined,
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(secret, scope, { at: last.at, id: last.id })
          : null,
    };
  }

  /**
   * Flags that are expired, or older than `days` days with no evaluation in the last `days` days (UTC days, the current
   * one included). One SQL read for the candidates and at most 30 cache reads for the counters; expiry here never
   * changes how a flag evaluates.
   */
  async stale(days = STALE_DEFAULT_DAYS): Promise<StaleFlags> {
    const now = this.clock.now();
    const window = Array.from({ length: days }, (_, i) =>
      dayOf(new Date(now.getTime() - i * DAY_MS)),
    );
    const [candidates, totals] = await Promise.all([
      this.flags.staleCandidates(),
      this.counters.totals(window),
    ]);
    const cutoff = now.getTime() - days * DAY_MS;
    const items = candidates
      .map((flag) => {
        const evaluations = totals[flag.key] ?? 0;
        const expired =
          flag.definition.expiresAt !== null &&
          Date.parse(flag.definition.expiresAt) < now.getTime();
        const unused = Date.parse(flag.createdAt) < cutoff && evaluations === 0;
        return { flag, evaluations, expired, unused };
      })
      .filter((c) => c.expired || c.unused)
      .map(({ flag, evaluations, expired }) => ({
        key: flag.key,
        owner: flag.definition.owner,
        status: flag.status,
        expiresAt: flag.definition.expiresAt,
        createdAt: flag.createdAt,
        evaluations,
        expired,
        reason: expired ? ('expired' as const) : ('unused' as const),
      }));
    return { days, items };
  }
}
