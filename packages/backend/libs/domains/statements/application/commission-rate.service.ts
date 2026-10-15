import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  CommissionRateAsOf,
  CommissionRateChangeResult,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import {
  defaultRateGap,
  knownAtInFuture,
  rateRangeInvalid,
  shopNotFound,
} from '../domain/errors';
import { rateChangesCounter } from '../domain/metrics';
import { monthBounds } from '../domain/period';
import {
  DEFAULT_SHOP_KEY,
  PERIOD_REPOSITORY,
  RATE_REPOSITORY,
  SHOP_DIRECTORY,
  type PeriodRepository,
  type RateBeliefRow,
  type RateRepository,
  type ShopDirectory,
} from '../domain/ports';
import {
  microsToIso,
  nextRecordedMicros,
  trimMicros,
} from '../domain/recorded-instant';
import './statements.job-types';

export interface SetRateInput {
  shopId?: string;
  category: string;
  rateBps: number;
  validFrom: Date;
  validTo?: Date;
  reason: string;
  actorId: string;
}

export interface HistoryQuery {
  shopId?: string;
  category?: string;
  limit: number;
  cursor?: string;
}

const normaliseCategory = (category: string): string =>
  category.trim().toLowerCase();

/**
 * Bitemporal commission rates (S16 FR-001..FR-010). Nothing is edited in place: a change closes the recorded period
 * of every current belief it overlaps, re-records what it does not cover and records the new belief, in one
 * transaction serialised per (shop, category). Record instants come from the injected clock and strictly increase.
 */
@Injectable()
export class CommissionRateService {
  constructor(
    private readonly runner: TransactionRunner,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async setRate(input: SetRateInput): Promise<CommissionRateChangeResult> {
    const category = normaliseCategory(input.category);
    const shopKey = input.shopId ?? DEFAULT_SHOP_KEY;
    if (
      input.validTo !== undefined &&
      input.validTo.getTime() <= input.validFrom.getTime()
    ) {
      rateChangesCounter.add(1, { outcome: 'refused' });
      throw rateRangeInvalid();
    }
    // The default rate for every category covers all time at all times (FR-005): a bounded window would end it.
    if (
      shopKey === DEFAULT_SHOP_KEY &&
      category === '*' &&
      input.validTo !== undefined
    ) {
      rateChangesCounter.add(1, { outcome: 'refused' });
      throw defaultRateGap();
    }
    if (input.shopId && !(await this.shops.existing([input.shopId])).has(input.shopId)) {
      rateChangesCounter.add(1, { outcome: 'refused' });
      throw shopNotFound();
    }

    const from = input.validFrom.toISOString();
    const to = input.validTo?.toISOString() ?? null;

    try {
      return await this.runner.run(async () => {
        await this.rates.lockWriters(shopKey, category);
        const overlapping = await this.rates.findOverlapping(
          shopKey,
          category,
          from,
          to,
          input.rateBps,
        );

        const same = overlapping.length === 1 && overlapping[0].coversRange;
        if (same) {
          rateChangesCounter.add(1, { outcome: 'noop' });
          return {
            changeId: overlapping[0].changeId,
            shopId: input.shopId ?? null,
            category,
            rateBps: input.rateBps,
            validFrom: from,
            validTo: to,
            recordedAt:
              trimMicros(overlapping[0].recordedFrom) ??
              this.clock.now().toISOString(),
            changed: false,
            affectedClosedMonths: [],
          };
        }

        const last = await this.rates.lastRecordedMicros(shopKey, category);
        const recordedMicros = nextRecordedMicros(this.clock.now(), last);
        const recordedIso = microsToIso(recordedMicros);
        const changeId = uuidv7();

        for (const belief of overlapping) {
          await this.rates.closeRecordedPeriod(belief.id, recordedIso);
          const keep = {
            changeId: belief.changeId,
            shopKey,
            category,
            rateBps: belief.rateBps,
            recordedFromIso: recordedIso,
            reason: belief.reason ?? input.reason,
            recordedBy: belief.recordedBy,
          };
          if (belief.hasLeft)
            await this.rates.insertBelief({
              ...keep,
              validFrom: belief.validLower,
              validTo: from,
            });
          if (belief.hasRight)
            await this.rates.insertBelief({
              ...keep,
              validFrom: to!,
              validTo: belief.validUpper,
            });
        }
        await this.rates.insertBelief({
          changeId,
          shopKey,
          category,
          rateBps: input.rateBps,
          validFrom: from,
          validTo: to,
          recordedFromIso: recordedIso,
          reason: input.reason,
          recordedBy: input.actorId,
        });

        if (
          shopKey === DEFAULT_SHOP_KEY &&
          category === '*' &&
          !(await this.rates.defaultCoversAllTime())
        )
          throw defaultRateGap();

        const affected = await this.affectedClosedMonths(
          input.validFrom,
          input.validTo,
        );
        for (const month of affected) {
          const cause = `rate_change:${changeId}`;
          await this.jobs.enqueue(
            'statements.reconcile-month',
            {
              month,
              cause,
              ...(input.shopId ? { shopId: input.shopId } : {}),
            },
            {
              idempotencyKey: `${cause}:${month}${input.shopId ? `:${input.shopId}` : ''}`,
              ...(input.shopId ? { shopId: input.shopId } : {}),
            },
          );
        }

        rateChangesCounter.add(1, { outcome: 'recorded' });
        return {
          changeId,
          shopId: input.shopId ?? null,
          category,
          rateBps: input.rateBps,
          validFrom: from,
          validTo: to,
          recordedAt: trimMicros(recordedIso)!,
          changed: true,
          affectedClosedMonths: affected,
        };
      });
    } catch (error) {
      rateChangesCounter.add(1, { outcome: 'refused' });
      throw error;
    }
  }

  async history(query: HistoryQuery): Promise<{
    items: RateBeliefRow[];
    nextCursor: string | null;
  }> {
    const shopKey = query.shopId ?? DEFAULT_SHOP_KEY;
    const category =
      query.category === undefined ? undefined : normaliseCategory(query.category);
    const scope = `${shopKey}:${category ?? ''}`;
    const secret = this.cursorSecret();
    const after = query.cursor
      ? decodeCursor(query.cursor, 'rates', scope, secret)
      : null;
    const rows = await this.rates.history(
      { shopKey, category },
      after ? { recordedFrom: after.k, id: after.id! } : null,
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(
              {
                r: 'rates',
                s: scope,
                k: last.recordedFrom ?? '-infinity',
                id: last.id,
              },
              secret,
            )
          : null,
    };
  }

  async asOf(input: {
    shopId?: string;
    category: string;
    validAt: Date;
    knownAt?: Date;
  }): Promise<CommissionRateAsOf | null> {
    const now = this.clock.now();
    const knownAt = input.knownAt ?? now;
    if (knownAt.getTime() > now.getTime()) throw knownAtInFuture();
    return this.rates.asOf(
      input.shopId ?? null,
      normaliseCategory(input.category),
      input.validAt,
      knownAt,
    );
  }

  private async affectedClosedMonths(
    from: Date,
    to: Date | undefined,
  ): Promise<string[]> {
    const months = await this.periods.closingOrClosedMonths();
    return months
      .filter((month) => {
        const bounds = monthBounds(month);
        return (
          bounds.end.getTime() > from.getTime() &&
          (to === undefined || bounds.start.getTime() < to.getTime())
        );
      })
      .sort();
  }

  private cursorSecret(): string {
    return `${this.config.get('jwt_secret')}`;
  }
}
